//! Backs up the phone's camera roll, and the other albums the user picked, to FileBrowser, sorted into year/month
//! folders. Port of `mobile/src/services/cameraBackup.ts` and `mobile/src/store/cameraBackupStore.ts`.
//!
//! It runs when the app opens or comes back, when asked, and in the background every 15 minutes or so (Android
//! decides exactly when). Each photo is sent once: a journal per source records how far the backup got. The newest
//! photos go first, photos before videos, so the gallery is up to date as early as possible even in the middle of a
//! big first backup. Everything the phone and the server do goes through [`BackupHost`] and [`BackupServer`].

use std::collections::{HashMap, HashSet};
use std::future::{Future, poll_fn};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::task::{Poll, Waker};

use indexmap::IndexMap;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::{Map, Value, json};

use crate::paths::free_name;
use crate::text::compare_names;
use crate::vault::{
    ClientError, DEFAULT_BACKUP_FOLDER, LEGACY_BACKUP_FOLDER, VaultError, VaultItem, album_folder_name, vault_root_for,
};

/// The name the background task is registered under.
pub const TASK_NAME: &str = "selfhost-camera-backup";
/// Where the camera's journal is kept; each album's is this followed by `.album.<id>`.
pub const JOURNAL_KEY: &str = "cameraBackup.journal";
pub const SETTINGS_KEY: &str = "cameraBackup.settings";
/// Photos saved late (a long video is dated from its start) are still caught this far back.
const LOOKBACK_MS: i64 = 24 * 60 * 60 * 1000;
/// A file failing this many times for its own reasons (not the network or the server) is left out for good.
const MAX_ATTEMPTS: u32 = 3;
/// Android stops background work after 10 minutes: the rest waits for the next run.
pub const BACKGROUND_BUDGET_MS: i64 = 8 * 60 * 1000;
pub const BACKGROUND_INTERVAL_MIN: u32 = 15;
/// Coming back to the app re-checks for new photos at most this often.
const RESUME_MIN_GAP_MS: i64 = 2 * 60 * 1000;
/// The journal is written at most this often during a run (and at its end): a big first backup sends thousands.
const JOURNAL_SAVE_GAP_MS: i64 = 5000;
/// Files sent ahead of older ones still waiting are remembered one by one. Past this many (a camera roll of tens of
/// thousands) the older files go first instead, so the journal stays small enough to store.
pub const RECENT_LIMIT: usize = 20_000;
/// Files given up on that are remembered, so the app can offer to send them again.
const MAX_GAVE_UP: usize = 200;
/// This many uploads in a row failing while the server still answers: it refuses everything, so the run stops.
const SUSPECT_LIMIT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    Image,
    Video,
    /// Audio and anything else an album may hold: never backed up.
    Other,
}

/// A photo or video of an album, as the phone lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaItem {
    pub id: String,
    pub filename: Option<String>,
    pub media_type: MediaType,
    /// When it was taken (ms); `None` when the phone doesn't know.
    pub creation_time: Option<i64>,
}

/// What the backup needs to know about one photo or video.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub filename: Option<String>,
    pub media_type: MediaType,
    pub creation_time: i64,
}

impl Item {
    fn from_media(media: MediaItem) -> Option<Self> {
        let creation_time = media.creation_time?;
        matches!(media.media_type, MediaType::Image | MediaType::Video).then_some(Self {
            id: media.id,
            filename: media.filename,
            media_type: media.media_type,
            creation_time,
        })
    }
}

/// The file behind an item, on the phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    pub uri: String,
    pub filename: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failure {
    pub attempts: u32,
    pub time: i64,
}

/// A file given up on because of the server (too big, refused): what to send again and why it failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GaveUp {
    pub name: String,
    pub time: i64,
    pub message: String,
}

/// How far one source's backup got.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Journal {
    /// Nothing taken before this moment (ms) is backed up: when backup was turned on, or 0 for the whole roll.
    pub floor: i64,
    /// Everything taken up to this moment (ms) is backed up, or has been given up on.
    pub cursor: i64,
    /// Backed-up files taken after `cursor - LOOKBACK_MS`, id to capture time, so the look-back skips them.
    pub recent: IndexMap<String, i64>,
    /// Files that failed for their own reasons.
    pub failures: IndexMap<String, Failure>,
    pub gave_up: IndexMap<String, GaveUp>,
    pub uploaded_total: u64,
    pub last_success_at: Option<i64>,
}

fn number(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value.as_i64().or_else(|| value.as_f64().map(|n| n as i64))
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

impl Journal {
    /// A saved journal (the phone app's JSON), over an empty one for whatever it lacks.
    pub fn from_json(saved: &Value) -> Self {
        let field = |key: &str| saved.get(key);
        let entries = |key: &str| field(key).and_then(Value::as_object).into_iter().flatten();
        Self {
            floor: number(field("floor")).unwrap_or(0),
            cursor: number(field("cursor")).unwrap_or(0),
            recent: entries("recent")
                .filter_map(|(id, time)| Some((id.clone(), number(Some(time))?)))
                .collect(),
            failures: entries("failures")
                .map(|(id, failure)| {
                    let failure = Failure {
                        attempts: number(failure.get("attempts")).unwrap_or(0).max(0) as u32,
                        time: number(failure.get("time")).unwrap_or(0),
                    };
                    (id.clone(), failure)
                })
                .collect(),
            gave_up: entries("gaveUp")
                .map(|(id, entry)| {
                    let entry = GaveUp {
                        name: text(entry.get("name")),
                        time: number(entry.get("time")).unwrap_or(0),
                        message: text(entry.get("message")),
                    };
                    (id.clone(), entry)
                })
                .collect(),
            uploaded_total: number(field("uploadedTotal")).unwrap_or(0).max(0) as u64,
            last_success_at: number(field("lastSuccessAt")),
        }
    }

    pub fn to_json(&self) -> Value {
        let recent: Map<String, Value> = self.recent.iter().map(|(id, time)| (id.clone(), json!(time))).collect();
        let failures: Map<String, Value> = self
            .failures
            .iter()
            .map(|(id, f)| (id.clone(), json!({ "attempts": f.attempts, "time": f.time })))
            .collect();
        let gave_up: Map<String, Value> = self
            .gave_up
            .iter()
            .map(|(id, g)| (id.clone(), json!({ "name": g.name, "time": g.time, "message": g.message })))
            .collect();
        json!({
            "floor": self.floor,
            "cursor": self.cursor,
            "recent": recent,
            "failures": failures,
            "gaveUp": gave_up,
            "uploadedTotal": self.uploaded_total,
            "lastSuccessAt": self.last_success_at,
        })
    }
}

/// A phone album (other than the camera's) that is backed up along with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupAlbum {
    /// The album's identifier on the phone; its title is only what it is called.
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraBackupSettings {
    pub enabled: bool,
    /// Where the photos go on the server, sorted into year/month sub-folders. `{user}` stands for the signed-in
    /// account's name, so each account gets its own folder inside one central folder.
    pub folder: String,
    pub wifi_only: bool,
    /// An older backup folder whose photos haven't been moved into the current layout yet, if there is one.
    pub legacy_folder: Option<String>,
    /// Backs up only while the phone is plugged in: a big backlog should not drain the battery.
    pub charging_only: bool,
    /// Other albums backed up along with the camera's, each into a folder of its own named after it.
    pub albums: Vec<BackupAlbum>,
}

impl Default for CameraBackupSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            folder: DEFAULT_BACKUP_FOLDER.into(),
            wifi_only: true,
            legacy_folder: None,
            charging_only: false,
            albums: Vec::new(),
        }
    }
}

impl CameraBackupSettings {
    /// The saved settings over the defaults, and whether they changed on the way. Backups used to go to one folder,
    /// "/Appareil photo": an install still on that default moves to the per-account layout, and remembers the old
    /// folder so the photos already there can be moved across.
    pub fn from_saved(saved: Option<&Value>) -> (Self, bool) {
        let mut settings = Self::default();
        let Some(saved) = saved.and_then(Value::as_object) else {
            return (settings, false);
        };
        let flag = |key: &str, default: bool| saved.get(key).and_then(Value::as_bool).unwrap_or(default);
        settings.enabled = flag("enabled", settings.enabled);
        settings.wifi_only = flag("wifiOnly", settings.wifi_only);
        settings.charging_only = flag("chargingOnly", settings.charging_only);
        if let Some(folder) = saved.get("folder").and_then(Value::as_str) {
            settings.folder = folder.to_owned();
        }
        settings.legacy_folder = saved.get("legacyFolder").and_then(Value::as_str).map(str::to_owned);
        if let Some(albums) = saved.get("albums").and_then(Value::as_array) {
            settings.albums = albums
                .iter()
                .map(|album| BackupAlbum {
                    id: text(album.get("id")),
                    title: text(album.get("title")),
                })
                .collect();
        }
        let migrate = settings.folder == LEGACY_BACKUP_FOLDER && !saved.contains_key("legacyFolder");
        if migrate {
            settings.folder = DEFAULT_BACKUP_FOLDER.into();
            settings.legacy_folder = Some(LEGACY_BACKUP_FOLDER.into());
        }
        (settings, migrate)
    }

    pub fn to_json(&self) -> Value {
        let albums: Vec<Value> = self
            .albums
            .iter()
            .map(|album| json!({ "id": album.id, "title": album.title }))
            .collect();
        json!({
            "enabled": self.enabled,
            "folder": self.folder,
            "wifiOnly": self.wifi_only,
            "legacyFolder": self.legacy_folder,
            "chargingOnly": self.charging_only,
            "albums": albums,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Idle,
    Running,
    WaitingWifi,
    WaitingCharger,
    NoPermission,
    NoServer,
    Error,
}

/// The file being sent and where it stands in the current run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub filename: String,
}

/// What the backup screen shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackupStatus {
    pub phase: Phase,
    pub progress: Option<Progress>,
    /// Photos and videos found but not backed up yet, as of the last check.
    pub pending: Option<usize>,
    pub uploaded_total: u64,
    /// Files the server wouldn't take, given up on; the app offers to try them again.
    pub gave_up: usize,
    pub last_success_at: Option<i64>,
    pub last_check_at: Option<i64>,
    /// Only the photos the user picked are visible (Android's "limited" access).
    pub limited_access: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Permission {
    pub granted: bool,
    pub limited: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Wifi,
    Ethernet,
    Cellular,
    None,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// Where a source's photos are read from on the phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlbumRef {
    /// The camera's own album ("Camera"), which the phone may not have yet.
    Camera,
    Album(String),
}

/// The FileBrowser account the photos go to.
pub trait BackupServer: Sync {
    /// The account's name as the server knows it, for the backup folder.
    fn account_name(&self) -> String;
    fn login(&self) -> impl Future<Output = Result<(), String>> + Send;
    fn is_reachable(&self) -> impl Future<Output = bool> + Send;
    fn create_folder(&self, path: &str) -> impl Future<Output = Result<(), ClientError>> + Send;
    fn list(&self, path: &str) -> impl Future<Output = Result<Vec<VaultItem>, ClientError>> + Send;
    /// Sends a phone file into `dir` as `name`, never replacing one already there (that is a 409).
    fn upload(&self, file: &LocalFile, dir: &str, name: &str) -> impl Future<Output = Result<(), ClientError>> + Send;
}

/// The phone the backup runs on, and the app around it.
pub trait BackupHost: Sync {
    type Server: BackupServer + Send;

    /// The time (ms since 1970).
    fn now(&self) -> i64;
    /// The phone's time zone, which the year/month folders follow.
    fn time_zone(&self) -> TimeZone;
    fn permission(&self) -> impl Future<Output = Permission> + Send;
    fn network(&self) -> impl Future<Output = Network> + Send;
    /// Whether the phone is plugged in; `None` when this build can't tell.
    fn is_charging(&self) -> Option<bool>;
    /// The photos, videos and anything else of an album taken at or after `from` (ms), oldest first. The camera's
    /// album not being there yet is an empty list; another album that can't be read is an error.
    fn album_items(&self, album: &AlbumRef, from: i64) -> impl Future<Output = Result<Vec<MediaItem>, String>> + Send;
    /// The file behind an item; an error when it is gone from the phone or can't be read.
    fn file_of(&self, item: &Item) -> impl Future<Output = Result<LocalFile, String>> + Send;
    fn load_pref(&self, key: &str) -> impl Future<Output = Option<Value>> + Send;
    /// Saves a preference; `Value::Null` forgets it.
    fn save_pref(&self, key: &str, value: &Value) -> impl Future<Output = Result<(), String>> + Send;
    /// The signed-in FileBrowser account, or one signed in from the saved credentials; `None` when there is none.
    fn server(&self) -> impl Future<Output = Result<Option<Self::Server>, String>> + Send;
    fn set_background_task(&self, enabled: bool) -> impl Future<Output = ()> + Send;
    /// Starts [`CameraBackup::run_camera_backup`] without waiting for it (on the app's runtime).
    fn schedule_run(&self);
    fn status_changed(&self, status: &BackupStatus);
    fn log(&self, message: &str, level: LogLevel);
}

/// The order to send in: photos before videos (the gallery shows photos, and one big video must not hold them
/// back), newest first within each. A camera roll so large that remembering every file sent ahead of the older ones
/// would swell the journal sends its newest `limit - already_sent` files that way and the rest oldest first, which
/// lets the journal's cursor catch up and forget them.
pub fn sending_order(items: &[Item], already_sent: usize, limit: usize) -> Vec<Item> {
    let mut newest_first = items.to_vec();
    newest_first.sort_by(|a, b| {
        let is_video = |item: &Item| item.media_type == MediaType::Video;
        is_video(a)
            .cmp(&is_video(b))
            .then(b.creation_time.cmp(&a.creation_time))
    });
    let room = limit.saturating_sub(already_sent);
    if newest_first.len() <= room {
        return newest_first;
    }
    let mut rest = newest_first.split_off(room);
    rest.sort_by_key(|item| item.creation_time);
    newest_first.extend(rest);
    newest_first
}

/// The year/month folder a file taken at `taken_at` (ms) goes into, in the phone's time zone.
pub fn month_folder(root: &str, taken_at: i64, tz: &TimeZone) -> String {
    let date = Timestamp::from_millisecond(taken_at)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned_datetime(tz.clone())
        .date();
    format!("{}/{}/{:02}", root.trim_end_matches('/'), date.year(), date.month())
}

/// The phone's albums the user can add, without the camera's: by name, untitled ones left out.
pub fn device_albums(albums: Vec<BackupAlbum>) -> Vec<BackupAlbum> {
    let mut named: Vec<BackupAlbum> = albums
        .into_iter()
        .map(|album| BackupAlbum {
            title: album.title.trim().to_owned(),
            ..album
        })
        .filter(|album| !album.title.is_empty() && album.title != "Camera")
        .collect();
    named.sort_by(|a, b| compare_names(&a.title, &b.title).then_with(|| a.title.cmp(&b.title)));
    named
}

/// How one upload went, and what it says about the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Sent,
    FileProblem,
    /// The session expired; signing in again and retrying is worth one try.
    SignedOut,
    /// The upload failed in a way that could be the file's doing or the network's (a timeout, a server error); the
    /// next file tells which.
    Stop,
    /// Every file would fail the same way, so there is no point going on.
    Abort,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SendResult {
    outcome: Outcome,
    message: String,
    /// The trouble is on the phone (the file is gone or unreadable), not at the server: nothing to offer to retry.
    local: bool,
    /// The server already had this very file (same name and size): nothing was sent, but it is backed up.
    already: bool,
}

impl SendResult {
    fn new(outcome: Outcome, message: impl Into<String>) -> Self {
        Self {
            outcome,
            message: message.into(),
            local: false,
            already: false,
        }
    }

    fn sent(already: bool) -> Self {
        Self {
            already,
            ..Self::new(Outcome::Sent, "")
        }
    }
}

/// What a failed call to the server says about the run: skip this file, or stop until the server or network is back.
fn classify(err: &ClientError) -> SendResult {
    match err.status {
        413 => SendResult::new(Outcome::FileProblem, "fichier trop volumineux pour le serveur"),
        401 | 403 => SendResult::new(Outcome::SignedOut, "FileBrowser a refusé la connexion"),
        status @ 400..=499 if status != 408 && status != 429 => {
            SendResult::new(Outcome::FileProblem, format!("refusé par le serveur ({status})"))
        }
        // No answer at all: the network failed under the upload.
        0 => SendResult::new(Outcome::Stop, err.message.clone()),
        status => SendResult::new(Outcome::Stop, format!("serveur indisponible ({status})")),
    }
}

/// One place photos are read from on the phone and backed up to: the camera, or one of the other albums.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub key: String,
    pub title: String,
    pub journal_key: String,
    pub album: AlbumRef,
}

impl Source {
    fn camera() -> Self {
        Self {
            key: "camera".into(),
            title: "Appareil photo".into(),
            journal_key: JOURNAL_KEY.into(),
            album: AlbumRef::Camera,
        }
    }

    fn of_album(album: &BackupAlbum) -> Self {
        Self {
            key: format!("album:{}", album.id),
            title: album.title.clone(),
            journal_key: format!("{JOURNAL_KEY}.album.{}", album.id),
            album: AlbumRef::Album(album.id.clone()),
        }
    }

    /// The server folder whose year/month folders this source's files go into.
    fn folder(&self, template: &str, account: &str) -> Result<String, VaultError> {
        let root = vault_root_for(template, account)?;
        match self.album {
            AlbumRef::Camera => Ok(root),
            AlbumRef::Album(_) => Ok(format!("{root}/{}", album_folder_name(&self.title)?)),
        }
    }
}

/// The camera, then the albums the user picked.
fn sources_of(albums: &[BackupAlbum]) -> Vec<Source> {
    std::iter::once(Source::camera()).chain(albums.iter().map(Source::of_album)).collect()
}

/// The files a server folder already holds (name to size), read once per run and kept up to date as files go in.
type Listings = HashMap<String, IndexMap<String, u64>>;

async fn files_in<'l, S: BackupServer>(
    server: &S,
    folder: &str,
    listings: &'l mut Listings,
) -> Result<&'l mut IndexMap<String, u64>, ClientError> {
    if !listings.contains_key(folder) {
        let names = match server.list(folder).await {
            Ok(items) => items
                .into_iter()
                .filter(|item| !item.is_dir)
                .map(|item| (item.name, item.size))
                .collect(),
            // A folder that isn't there yet holds nothing; any other failure is the upload's own.
            Err(err) if err.status == 404 => IndexMap::new(),
            Err(err) => return Err(err),
        };
        listings.insert(folder.to_owned(), names);
    }
    Ok(listings.entry(folder.to_owned()).or_default())
}

/// Creates the folder and its parents; "already exists" answers are expected and ignored.
async fn ensure_folder<S: BackupServer>(server: &S, path: &str, known: &mut HashSet<String>) {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    for i in 1..=parts.len() {
        let partial = format!("/{}", parts[..i].join("/"));
        if known.contains(&partial) {
            continue;
        }
        let _ = server.create_folder(&partial).await;
        known.insert(partial);
    }
}

/// Sends one photo or video into its year/month folder. Nothing already on the server is ever replaced: the very
/// same file (name and size) is left alone, as it is backed up already, and a different file with the same name goes
/// in under a numbered name.
async fn send_one<H: BackupHost>(
    host: &H,
    server: &H::Server,
    item: &Item,
    root: &Result<String, VaultError>,
    folders: &mut HashSet<String>,
    listings: &mut Listings,
) -> SendResult {
    let file = match host.file_of(item).await {
        Ok(file) => file,
        // Deleted meanwhile, or unreadable: a problem with this file only.
        Err(message) => {
            return SendResult {
                local: true,
                ..SendResult::new(Outcome::FileProblem, message)
            };
        }
    };
    let root = match root {
        Ok(root) => root,
        // A backup folder that can't be used (a setting that leaves the account's area, say) affects every file.
        Err(err) => {
            return SendResult::new(Outcome::Abort, format!("dossier de sauvegarde invalide : {}", err.message));
        }
    };
    let folder = month_folder(root, item.creation_time, &host.time_zone());
    ensure_folder(server, &folder, folders).await;
    for attempt in 0..2 {
        let names = match files_in(server, &folder, listings).await {
            Ok(names) => names,
            Err(err) => return classify(&err),
        };
        let mut name = file.filename.clone();
        if let Some(&existing) = names.get(&name) {
            if existing == file.size {
                return SendResult::sent(true);
            }
            let taken: HashSet<String> = names.keys().cloned().collect();
            name = free_name(&name, &taken);
        }
        match server.upload(&file, &folder, &name).await {
            Ok(()) => {
                names.insert(name, file.size);
                return SendResult::sent(false);
            }
            // The name was taken after we looked: look again, once.
            Err(err) if err.status == 409 && attempt == 0 => {
                listings.remove(&folder);
            }
            Err(err) => return classify(&err),
        }
    }
    SendResult::new(Outcome::FileProblem, "nom déjà pris sur le serveur")
}

fn is_done(journal: &Journal, id: &str) -> bool {
    journal.recent.contains_key(id) || journal.failures.get(id).is_some_and(|f| f.attempts >= MAX_ATTEMPTS)
}

/// What a source has to do in this run, worked out from its journal and what is on the phone.
struct Plan {
    source: Source,
    journal: Journal,
    /// Everything the phone listed, in capture order.
    all: Vec<Item>,
    /// How many of `all` the cursor has passed.
    prefix: usize,
    order: Vec<Item>,
    todo: usize,
    /// Files given up on that are tried again because the user asked.
    retried: HashSet<String>,
}

impl Plan {
    /// The cursor only moves past files that are backed up (or given up on), in capture order, so a file that
    /// failed is retried next time instead of being left behind.
    fn advance_cursor(&mut self) {
        let before = self.prefix;
        while self.prefix < self.all.len() && is_done(&self.journal, &self.all[self.prefix].id) {
            self.journal.cursor = self.journal.cursor.max(self.all[self.prefix].creation_time);
            self.prefix += 1;
        }
        if self.prefix == before {
            return;
        }
        let keep_after = self.journal.cursor - LOOKBACK_MS;
        self.journal.recent.retain(|_, time| *time >= keep_after);
        self.journal.failures.retain(|_, failure| failure.time >= keep_after);
    }
}

fn name_of(item: &Item) -> String {
    match &item.filename {
        Some(name) if !name.is_empty() => name.clone(),
        _ => match item.id.rsplit('/').next() {
            Some(last) if !last.is_empty() => last.to_owned(),
            _ => "photo".into(),
        },
    }
}

/// What one source counts for on the screen, which shows the sum over the sources.
#[derive(Debug, Clone, Copy)]
struct View {
    uploaded: u64,
    last_success_at: Option<i64>,
    gave_up: usize,
    pending: usize,
}

impl View {
    fn of(journal: &Journal, pending: usize) -> Self {
        Self {
            uploaded: journal.uploaded_total,
            last_success_at: journal.last_success_at,
            gave_up: journal.gave_up.len(),
            pending,
        }
    }
}

#[derive(Default)]
struct RunContext {
    views: IndexMap<String, View>,
    /// Files handled by the sources before this one, and all the files of the run, for the progress bar.
    done: usize,
    total: usize,
    sent: usize,
    already_there: usize,
}

struct SendSummary {
    stop_message: Option<String>,
    last_file_error: Option<String>,
}

/// What a run of one plan settles about its files.
struct Tally {
    retried: HashSet<String>,
    /// Files that are settled for good by now: sent, or given up on.
    finished: HashSet<String>,
    retry_later: usize,
    last_file_error: Option<String>,
}

impl Tally {
    /// The server won't take this file again: remembered, so the app can offer to try once more.
    fn give_up<H: BackupHost>(host: &H, journal: &mut Journal, item: &Item, message: &str) {
        journal.gave_up.insert(
            item.id.clone(),
            GaveUp {
                name: name_of(item),
                time: item.creation_time,
                message: message.to_owned(),
            },
        );
        host.log(&format!("Abandon de {} : {message}", name_of(item)), LogLevel::Warn);
        if journal.gave_up.len() > MAX_GAVE_UP {
            let mut ids: Vec<(String, i64)> = journal.gave_up.iter().map(|(id, g)| (id.clone(), g.time)).collect();
            ids.sort_by_key(|(_, time)| *time);
            let excess = ids.len() - MAX_GAVE_UP;
            for (id, _) in ids.into_iter().take(excess) {
                journal.gave_up.shift_remove(&id);
            }
        }
    }

    /// A file that could not be sent. Three strikes and it is given up on, unless it is gone from the phone.
    fn fail<H: BackupHost>(&mut self, host: &H, journal: &mut Journal, item: &Item, message: &str, local: bool) {
        self.last_file_error = Some(format!("{} : {message}", name_of(item)));
        if self.retried.contains(&item.id) {
            // Sent again on request: one try per request, and it stays on the list if it fails.
            if local {
                journal.gave_up.shift_remove(&item.id);
            } else {
                Self::give_up(host, journal, item, message);
            }
            return;
        }
        let attempts = journal.failures.get(&item.id).map_or(0, |f| f.attempts) + 1;
        journal.failures.insert(
            item.id.clone(),
            Failure {
                attempts,
                time: item.creation_time,
            },
        );
        if attempts < MAX_ATTEMPTS {
            self.retry_later += 1;
            return;
        }
        self.finished.insert(item.id.clone());
        if !local {
            Self::give_up(host, journal, item, message);
        }
    }

    fn sent(&mut self, journal: &mut Journal, item: &Item, already: bool, ctx: &mut RunContext, now: i64) {
        // A file older than the look-back is not in the cursor's range, so there is nothing to remember it by.
        if !self.retried.contains(&item.id) || item.creation_time >= journal.cursor - LOOKBACK_MS {
            journal.recent.insert(item.id.clone(), item.creation_time);
        }
        journal.failures.shift_remove(&item.id);
        journal.gave_up.shift_remove(&item.id);
        self.finished.insert(item.id.clone());
        // A file the server already had is backed up, but nothing was sent: it is not an upload to count.
        if already {
            ctx.already_there += 1;
            return;
        }
        ctx.sent += 1;
        journal.uploaded_total += 1;
        journal.last_success_at = Some(now);
    }
}

/// What the journal says, for the Diagnostic screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalSummary {
    pub cursor: i64,
    pub remembered_sent: usize,
    pub failing: usize,
    /// Name (prefixed with the album's title outside the camera) and why it was given up.
    pub gave_up: Vec<(String, String)>,
}

/// How a call to start a run went: it started one, which the caller must then drive with
/// [`CameraBackup::complete`], or joined the one already going.
#[must_use = "a started run only happens when it is completed"]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunTicket(Ticket);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ticket {
    Start,
    /// Joined the run under way; done once more than this many runs have finished.
    Join(u64),
}

struct Shared {
    settings: CameraBackupSettings,
    loaded: bool,
    status: BackupStatus,
    running: bool,
    finished_runs: u64,
    waiters: Vec<Waker>,
    /// When the current run must stop starting new uploads; a background run joining a foreground one lowers it.
    deadline: i64,
    cancel_requested: bool,
    /// Set by "send anyway" and "try again": the next run ignores "Wi-Fi only" and "charging only" / also tries
    /// the files given up on.
    anyway_next: bool,
    retry_failed_next: bool,
    /// The state last written to the diagnostic record, so a run that finds the same thing again says nothing.
    last_logged: Option<String>,
    started: bool,
}

/// The camera backup of one phone: its settings, what the screen shows, and the runs (one at a time; calls during a
/// run share it).
pub struct CameraBackup<H: BackupHost> {
    host: H,
    shared: Mutex<Shared>,
}

/// Marks the run over however it ends, and wakes whoever joined it.
struct RunGuard<'a>(&'a Mutex<Shared>);

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        let waiters = {
            let mut shared = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            shared.running = false;
            shared.finished_runs += 1;
            std::mem::take(&mut shared.waiters)
        };
        for waiter in waiters {
            waiter.wake();
        }
    }
}

impl<H: BackupHost> CameraBackup<H> {
    pub fn new(host: H) -> Self {
        Self {
            host,
            shared: Mutex::new(Shared {
                settings: CameraBackupSettings::default(),
                loaded: false,
                status: BackupStatus::default(),
                running: false,
                finished_runs: 0,
                waiters: Vec::new(),
                deadline: i64::MAX,
                cancel_requested: false,
                anyway_next: false,
                retry_failed_next: false,
                last_logged: None,
                started: false,
            }),
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status(&self) -> BackupStatus {
        self.lock().status.clone()
    }

    pub fn settings(&self) -> CameraBackupSettings {
        self.lock().settings.clone()
    }

    fn update(&self, change: impl FnOnce(&mut BackupStatus)) {
        let status = {
            let mut shared = self.lock();
            change(&mut shared.status);
            shared.status.clone()
        };
        self.host.status_changed(&status);
    }

    /// Writes a line when the situation changed since the last one (a run every 15 minutes mustn't fill the record).
    fn note_state(&self, state: &str, message: &str, level: LogLevel) {
        {
            let mut shared = self.lock();
            if shared.last_logged.as_deref() == Some(state) {
                return;
            }
            shared.last_logged = Some(state.to_owned());
        }
        self.host.log(message, level);
    }

    fn should_stop(&self) -> bool {
        let shared = self.lock();
        shared.cancel_requested || self.host.now() > shared.deadline
    }

    /// Reads the saved settings, once.
    pub async fn load(&self) {
        if self.lock().loaded {
            return;
        }
        let saved = self.host.load_pref(SETTINGS_KEY).await;
        let (settings, migrated) = CameraBackupSettings::from_saved(saved.as_ref());
        if migrated {
            let _ = self.host.save_pref(SETTINGS_KEY, &settings.to_json()).await;
        }
        let mut shared = self.lock();
        shared.settings = settings;
        shared.loaded = true;
    }

    pub async fn save_settings(&self, change: impl FnOnce(&mut CameraBackupSettings)) -> Result<(), String> {
        let settings = {
            let mut shared = self.lock();
            change(&mut shared.settings);
            shared.settings.clone()
        };
        self.host.save_pref(SETTINGS_KEY, &settings.to_json()).await
    }

    async fn load_journal(&self, key: &str) -> Journal {
        self.host
            .load_pref(key)
            .await
            .map(|saved| Journal::from_json(&saved))
            .unwrap_or_default()
    }

    async fn save_journal(&self, key: &str, journal: &Journal) -> Result<(), String> {
        self.host.save_pref(key, &journal.to_json()).await
    }

    /// Starts a run, or joins the one under way (lowering its deadline to this call's budget).
    pub fn request_run(&self, budget_ms: Option<i64>) -> RunTicket {
        let until = budget_ms.map_or(i64::MAX, |budget| self.host.now().saturating_add(budget));
        let mut shared = self.lock();
        if shared.running {
            shared.deadline = shared.deadline.min(until);
            RunTicket(Ticket::Join(shared.finished_runs))
        } else {
            shared.running = true;
            shared.deadline = until;
            RunTicket(Ticket::Start)
        }
    }

    /// Drives a run this ticket started, or waits for the one it joined.
    pub async fn complete(&self, ticket: RunTicket) {
        match ticket.0 {
            Ticket::Start => self.drive().await,
            Ticket::Join(seen) => self.finished_after(seen).await,
        }
    }

    /// Checks for new photos and backs them up, stopping new uploads once `budget_ms` has gone by.
    pub async fn run_camera_backup(&self, budget_ms: Option<i64>) {
        let ticket = self.request_run(budget_ms);
        self.complete(ticket).await;
    }

    /// The background task: a run within Android's time limit. Whether it went well.
    pub async fn run_in_background(&self) -> bool {
        self.run_camera_backup(Some(BACKGROUND_BUDGET_MS)).await;
        true
    }

    async fn finished_after(&self, seen: u64) {
        poll_fn(|cx| {
            let mut shared = self.lock();
            if shared.finished_runs > seen {
                Poll::Ready(())
            } else {
                shared.waiters.push(cx.waker().clone());
                Poll::Pending
            }
        })
        .await;
    }

    /// Waits for the run under way, if there is one.
    async fn wait_idle(&self) {
        let seen = {
            let shared = self.lock();
            if !shared.running {
                return;
            }
            shared.finished_runs
        };
        self.finished_after(seen).await;
    }

    async fn drive(&self) {
        let _guard = RunGuard(&self.shared);
        if let Err(err) = self.execute().await {
            self.update(|status| {
                status.phase = Phase::Error;
                status.progress = None;
                status.error = Some(err.clone());
            });
            self.host.log(&format!("Erreur inattendue : {err}"), LogLevel::Error);
        }
    }

    /// Sums the sources' views into what the screen shows, then applies `extra`.
    fn publish(&self, ctx: &RunContext, extra: impl FnOnce(&mut BackupStatus)) {
        self.update(|status| {
            status.uploaded_total = ctx.views.values().map(|view| view.uploaded).sum();
            status.gave_up = ctx.views.values().map(|view| view.gave_up).sum();
            status.pending = Some(ctx.views.values().map(|view| view.pending).sum());
            status.last_success_at = ctx.views.values().filter_map(|view| view.last_success_at).max();
            extra(status);
        });
    }

    /// Reads the source's journal and the phone, and says what is left to send.
    async fn plan_source(&self, source: Source, retry_failed: bool) -> Result<Plan, String> {
        let journal = self.load_journal(&source.journal_key).await;
        let from = journal.floor.max(journal.cursor - LOOKBACK_MS);
        let all: Vec<Item> = match self.host.album_items(&source.album, from).await {
            Ok(items) => items.into_iter().filter_map(Item::from_media).collect(),
            // An album that was deleted since, or can't be read, has nothing to send; the camera's failure is the
            // run's.
            Err(err) if source.album != AlbumRef::Camera => {
                self.host
                    .log(&format!("Album « {} » illisible : {err}", source.title), LogLevel::Warn);
                Vec::new()
            }
            Err(err) => return Err(err),
        };
        let mut plan = Plan {
            source,
            journal,
            all,
            prefix: 0,
            order: Vec::new(),
            todo: 0,
            retried: HashSet::new(),
        };
        plan.advance_cursor();

        let todo: Vec<Item> = plan
            .all
            .iter()
            .filter(|item| !is_done(&plan.journal, &item.id))
            .cloned()
            .collect();
        // Files given up on are older than the cursor, so they only come back when asked.
        let again: Vec<Item> = if retry_failed {
            let todo_ids: HashSet<&str> = todo.iter().map(|item| item.id.as_str()).collect();
            plan.journal
                .gave_up
                .iter()
                .filter(|(id, _)| !todo_ids.contains(id.as_str()))
                .map(|(id, entry)| Item {
                    id: id.clone(),
                    filename: Some(entry.name.clone()),
                    media_type: MediaType::Image,
                    creation_time: entry.time,
                })
                .collect()
        } else {
            Vec::new()
        };
        plan.retried = again.iter().map(|item| item.id.clone()).collect();
        plan.order = sending_order(&todo, plan.journal.recent.len(), RECENT_LIMIT);
        plan.order.extend(again);
        plan.todo = todo.len();
        Ok(plan)
    }

    fn report(&self, ctx: &mut RunContext, plan: &Plan, pending: usize) {
        ctx.views.insert(plan.source.key.clone(), View::of(&plan.journal, pending));
        self.publish(ctx, |_| {});
    }

    /// Sends a plan's files, one at a time, and keeps its journal. Stops early when the run must (see [`Outcome`]).
    async fn send_plan(&self, plan: &mut Plan, server: &H::Server, ctx: &mut RunContext) -> Result<SendSummary, String> {
        let mut folders = HashSet::new();
        let mut listings = Listings::new();
        let mut stop_message: Option<String> = None;
        let mut tally = Tally {
            retried: plan.retried.clone(),
            finished: HashSet::new(),
            retry_later: 0,
            last_file_error: None,
        };
        let mut saved_at = self.host.now();
        let mut signed_in_again = false;
        // Files whose upload failed the way a dead connection would too, though the server still answered.
        let mut suspects: Vec<(Item, String)> = Vec::new();
        let order = plan.order.clone();

        for (index, item) in order.iter().enumerate() {
            if self.should_stop() {
                break;
            }
            self.update(|status| {
                status.progress = Some(Progress {
                    done: ctx.done + index,
                    total: ctx.total,
                    filename: name_of(item),
                });
            });

            let root = plan.source.folder(&self.settings().folder, &server.account_name());
            let mut result = send_one(&self.host, server, item, &root, &mut folders, &mut listings).await;
            // FileBrowser sessions expire: sign in again once per run (as the file screen does) and retry.
            if result.outcome == Outcome::SignedOut && !signed_in_again {
                signed_in_again = true;
                result = match server.login().await {
                    Ok(()) => send_one(&self.host, server, item, &root, &mut folders, &mut listings).await,
                    Err(err) => SendResult::new(Outcome::Abort, err),
                };
            }

            match result.outcome {
                Outcome::Abort | Outcome::SignedOut => {
                    stop_message = Some(result.message);
                    break;
                }
                // The file or the connection? A server that no longer answers, or refuses file after file, is the
                // run's problem: stop and hold nothing against the files. One that answers is held against this
                // file once a later one goes through, so a single file that never uploads can't block the ones
                // behind it.
                Outcome::Stop => {
                    if suspects.len() + 1 >= SUSPECT_LIMIT || !server.is_reachable().await {
                        stop_message = Some(result.message);
                        break;
                    }
                    suspects.push((item.clone(), result.message));
                    continue;
                }
                Outcome::Sent | Outcome::FileProblem => {}
            }
            // The server took a later file: the files before were the problem.
            for (suspect, message) in suspects.drain(..) {
                tally.fail(&self.host, &mut plan.journal, &suspect, &message, false);
            }
            if result.outcome == Outcome::Sent {
                tally.sent(&mut plan.journal, item, result.already, ctx, self.host.now());
            } else {
                tally.fail(&self.host, &mut plan.journal, item, &result.message, result.local);
            }
            plan.advance_cursor();
            if self.host.now() - saved_at > JOURNAL_SAVE_GAP_MS {
                self.save_journal(&plan.source.journal_key, &plan.journal).await?;
                saved_at = self.host.now();
            }
            self.report(ctx, plan, order.len() - index - 1 + tally.retry_later + suspects.len());
        }
        // Nothing was sent after them, but the server answered each time: they were the files' own failures.
        if stop_message.is_none() {
            for (suspect, message) in suspects.drain(..) {
                tally.fail(&self.host, &mut plan.journal, &suspect, &message, false);
            }
            plan.advance_cursor();
        }
        self.save_journal(&plan.source.journal_key, &plan.journal).await?;
        ctx.done += order.len();
        let pending = order
            .iter()
            .filter(|item| !tally.retried.contains(&item.id) && !tally.finished.contains(&item.id))
            .count();
        self.report(ctx, plan, pending);
        Ok(SendSummary {
            stop_message,
            last_file_error: tally.last_file_error,
        })
    }

    async fn execute(&self) -> Result<(), String> {
        self.load().await;
        let settings = self.settings();
        if !settings.enabled {
            return Ok(());
        }
        // "Send anyway" and "try again" are for this run only.
        let (anyway, retry_failed) = {
            let mut shared = self.lock();
            shared.cancel_requested = false;
            (
                std::mem::take(&mut shared.anyway_next),
                std::mem::take(&mut shared.retry_failed_next),
            )
        };

        let permission = self.host.permission().await;
        if !permission.granted {
            self.update(|status| {
                status.phase = Phase::NoPermission;
                status.last_check_at = Some(self.host.now());
            });
            self.note_state(
                "no-permission",
                "Accès aux photos refusé : rien ne peut être sauvegardé",
                LogLevel::Warn,
            );
            return Ok(());
        }
        self.update(|status| status.limited_access = permission.limited);

        if settings.wifi_only && !anyway && !matches!(self.host.network().await, Network::Wifi | Network::Ethernet) {
            self.update(|status| {
                status.phase = Phase::WaitingWifi;
                status.last_check_at = Some(self.host.now());
            });
            self.note_state(
                "waiting-wifi",
                "En attente du Wi-Fi (réglage « Wi-Fi uniquement »)",
                LogLevel::Info,
            );
            return Ok(());
        }
        // A build that can't tell whether the phone is charging never blocks the backup.
        if settings.charging_only && !anyway && !self.host.is_charging().unwrap_or(true) {
            self.update(|status| {
                status.phase = Phase::WaitingCharger;
                status.last_check_at = Some(self.host.now());
            });
            self.note_state(
                "waiting-charger",
                "En attente du chargeur (réglage « Seulement en charge »)",
                LogLevel::Info,
            );
            return Ok(());
        }

        // Everything to send is worked out first, so the screen's totals are right from the start of the run.
        let mut plans = Vec::new();
        for source in sources_of(&settings.albums) {
            plans.push(self.plan_source(source, retry_failed).await?);
        }
        let mut ctx = RunContext::default();
        for plan in &plans {
            ctx.views
                .insert(plan.source.key.clone(), View::of(&plan.journal, plan.order.len()));
            ctx.total += plan.order.len();
        }
        self.publish(&ctx, |status| status.last_check_at = Some(self.host.now()));
        if ctx.total == 0 {
            for plan in &plans {
                self.save_journal(&plan.source.journal_key, &plan.journal).await?;
            }
            self.update(|status| {
                status.phase = Phase::Idle;
                status.error = None;
            });
            return Ok(());
        }

        let server = match self.host.server().await {
            Ok(Some(server)) => server,
            Ok(None) => {
                self.update(|status| {
                    status.phase = Phase::NoServer;
                    status.error = None;
                });
                self.note_state("no-server", "Pas de compte FileBrowser enregistré", LogLevel::Info);
                return Ok(());
            }
            Err(err) => {
                self.update(|status| {
                    status.phase = Phase::NoServer;
                    status.error = Some(err.clone());
                });
                self.note_state("no-server", &format!("FileBrowser injoignable : {err}"), LogLevel::Warn);
                return Ok(());
            }
        };

        self.update(|status| {
            status.phase = Phase::Running;
            status.error = None;
        });
        self.lock().last_logged = None;
        let todo: usize = plans.iter().map(|plan| plan.todo).sum();
        let again: usize = plans.iter().map(|plan| plan.retried.len()).sum();
        self.host.log(
            &format!(
                "Envoi de {} fichier{} ({todo} nouveau{}{}{})",
                ctx.total,
                plural(ctx.total, "s"),
                plural(todo, "x"),
                if again > 0 { format!(", {again} à renvoyer") } else { String::new() },
                if plans.len() > 1 { format!(", {} sources", plans.len()) } else { String::new() },
            ),
            LogLevel::Info,
        );

        let mut stop_message = None;
        let mut last_file_error = None;
        for plan in &mut plans {
            let summary = self.send_plan(plan, &server, &mut ctx).await?;
            last_file_error = summary.last_file_error.or(last_file_error);
            if summary.stop_message.is_some() {
                stop_message = summary.stop_message;
                break;
            }
            if self.should_stop() {
                break;
            }
        }

        let left: usize = ctx.views.values().map(|view| view.pending).sum();
        let tail = match (&stop_message, &last_file_error) {
            (Some(stop), _) => format!(" — interrompu : {stop}"),
            (None, Some(err)) => format!(" — {err}"),
            (None, None) => String::new(),
        };
        self.host.log(
            &format!(
                "Terminé : {} envoyé{}{}, {left} en attente{tail}",
                ctx.sent,
                plural(ctx.sent, "s"),
                if ctx.already_there > 0 {
                    format!(", {} déjà sur le serveur", ctx.already_there)
                } else {
                    String::new()
                },
            ),
            if stop_message.is_some() { LogLevel::Warn } else { LogLevel::Info },
        );
        let phase = if stop_message.is_some() { Phase::Error } else { Phase::Idle };
        let error = stop_message.or(last_file_error);
        self.publish(&ctx, |status| {
            status.phase = phase;
            status.progress = None;
            status.error = error;
        });
        Ok(())
    }

    /// Runs one backup with a one-off exception. A run already going finishes first, and the exception is gone once
    /// this one is over, so it can't be left waiting for some later run (hours on, perhaps on mobile data).
    async fn run_once_with(&self, anyway: bool) {
        self.wait_idle().await;
        {
            let mut shared = self.lock();
            if anyway {
                shared.anyway_next = true;
            } else {
                shared.retry_failed_next = true;
            }
        }
        self.run_camera_backup(None).await;
        let mut shared = self.lock();
        shared.anyway_next = false;
        shared.retry_failed_next = false;
    }

    /// Backs up once even though "Wi-Fi only" or "charging only" is on and the phone isn't meeting it; the settings
    /// themselves stay.
    pub async fn backup_over_mobile_data(&self) {
        self.run_once_with(true).await;
    }

    /// Tries again the files that were given up on (too big for the server, refused), along with anything new.
    pub async fn retry_failed_backups(&self) {
        self.run_once_with(false).await;
    }

    /// Runs a backup that starts from the settings as they are now: a run already going has made its plans from the
    /// old ones, so it finishes first.
    async fn run_after_current(&self) {
        self.wait_idle().await;
        self.run_camera_backup(None).await;
    }

    /// A source's journal starting afresh: from the beginning of the roll, or from `now`.
    async fn start_journal(&self, source: &Source, include_existing: bool, now: i64) -> Result<(), String> {
        let journal = self.load_journal(&source.journal_key).await;
        let start = if include_existing { 0 } else { now };
        let fresh = Journal {
            floor: start,
            cursor: start,
            recent: IndexMap::new(),
            failures: IndexMap::new(),
            gave_up: IndexMap::new(),
            ..journal
        };
        self.save_journal(&source.journal_key, &fresh).await
    }

    /// Turns backup on. `include_existing`: the photos already on the phone too, not only the next ones.
    pub async fn enable(&self, include_existing: bool) -> Result<(), String> {
        self.load().await;
        let now = self.host.now();
        for source in sources_of(&self.settings().albums) {
            self.start_journal(&source, include_existing, now).await?;
        }
        self.save_settings(|settings| settings.enabled = true).await?;
        self.update(|status| {
            status.phase = Phase::Idle;
            status.error = None;
            status.pending = None;
            status.gave_up = 0;
        });
        self.host.set_background_task(true).await;
        self.host.schedule_run();
        Ok(())
    }

    pub async fn disable(&self) -> Result<(), String> {
        self.lock().cancel_requested = true;
        self.save_settings(|settings| settings.enabled = false).await?;
        self.update(|status| {
            status.phase = Phase::Idle;
            status.progress = None;
            status.error = None;
            status.pending = None;
        });
        self.host.set_background_task(false).await;
        Ok(())
    }

    /// Adds an album to the backup. `include_existing`: what it already holds too, not only what comes next.
    pub async fn add_backup_album(&self, album: BackupAlbum, include_existing: bool) -> Result<(), String> {
        self.load().await;
        if self.settings().albums.iter().any(|known| known.id == album.id) {
            return Ok(());
        }
        self.start_journal(&Source::of_album(&album), include_existing, self.host.now())
            .await?;
        self.save_settings(|settings| settings.albums.push(album)).await?;
        self.run_after_current().await;
        Ok(())
    }

    /// Stops backing up an album. What was already sent stays on the server.
    pub async fn remove_backup_album(&self, id: &str) -> Result<(), String> {
        self.load().await;
        self.save_settings(|settings| settings.albums.retain(|album| album.id != id))
            .await?;
        let source = Source::of_album(&BackupAlbum {
            id: id.to_owned(),
            title: String::new(),
        });
        self.host.save_pref(&source.journal_key, &Value::Null).await?;
        self.run_after_current().await;
        Ok(())
    }

    pub async fn journal_summary(&self) -> JournalSummary {
        self.load().await;
        let sources = sources_of(&self.settings().albums);
        let mut journals = Vec::new();
        for source in &sources {
            journals.push(self.load_journal(&source.journal_key).await);
        }
        JournalSummary {
            cursor: journals.first().map_or(0, |journal| journal.cursor),
            remembered_sent: journals.iter().map(|journal| journal.recent.len()).sum(),
            failing: journals.iter().map(|journal| journal.failures.len()).sum(),
            gave_up: journals
                .iter()
                .zip(&sources)
                .enumerate()
                .flat_map(|(i, (journal, source))| {
                    journal.gave_up.values().map(move |entry| {
                        let name = if i == 0 {
                            entry.name.clone()
                        } else {
                            format!("{}/{}", source.title, entry.name)
                        };
                        (name, entry.message.clone())
                    })
                })
                .collect(),
        }
    }

    /// At app start: shows the saved state, keeps the background task in place, and catches up.
    pub async fn start(&self) {
        {
            let mut shared = self.lock();
            if shared.started {
                return;
            }
            shared.started = true;
        }
        self.load().await;
        let journal = self.load_journal(JOURNAL_KEY).await;
        self.update(|status| {
            status.uploaded_total = journal.uploaded_total;
            status.last_success_at = journal.last_success_at;
            status.gave_up = journal.gave_up.len();
        });
        let enabled = self.settings().enabled;
        self.host.set_background_task(enabled).await;
        if enabled {
            self.host.schedule_run();
        }
    }

    /// The app came back to the screen: looks for new photos, unless it did a moment ago.
    pub fn on_foreground(&self) {
        let due = {
            let shared = self.lock();
            let last_check = shared.status.last_check_at.unwrap_or(0);
            shared.settings.enabled && self.host.now() - last_check > RESUME_MIN_GAP_MS
        };
        if due {
            self.host.schedule_run();
        }
    }
}

fn plural(count: usize, ending: &str) -> &str {
    if count > 1 { ending } else { "" }
}

#[cfg(test)]
mod tests;
