//! Where an account's backed-up photos live on the server, and the only way the app reaches them. Port of
//! `mobile/src/services/photoVault.ts`.
//!
//! The app has no server of its own: FileBrowser is the file server and decides, account by account, what a login
//! may touch (its per-account "scope"). What the app can do, and does here, is make sure it never asks for anything
//! but the signed-in account's own backup folder: the folder name comes only from the account's name, and every path
//! goes through [`resolve_inside`] before it reaches the server.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::{self, Write as _};
use std::future::{Future, poll_fn};
use std::ops::ControlFlow;
use std::pin::Pin;
use std::task::Poll;

use jiff::civil::Date;
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::paths::free_name;

/// Stands for the account's name in the backup folder setting.
pub const USER_TOKEN: &str = "{user}";
/// One central folder, one sub-folder per account, then year/month.
pub const DEFAULT_BACKUP_FOLDER: &str = "/backups/photos/{user}";
/// Where backups went before they were organised by account.
pub const LEGACY_BACKUP_FOLDER: &str = "/Appareil photo";

/// Backups nest at most root / album / year / month (the camera's own photos skip the album level).
const MAX_DEPTH: usize = 4;
/// Photos deleted from the gallery wait here, inside the account's backup folder, for [`TRASH_DAYS`] days. It is a
/// visible folder, not a dot-folder: FileBrowser hides those from accounts that don't show hidden files.
pub const TRASH_FOLDER: &str = "Corbeille";
pub const TRASH_DAYS: i64 = 30;
/// FileBrowser is asked for at most this many folders at once.
const LIST_CONCURRENCY: usize = 4;
const MAX_NAME_LENGTH: usize = 255;
const MAX_SEGMENT_LENGTH: usize = 120;

const PHOTO_EXTENSIONS: [&str; 9] = [
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp",
];
const VIDEO_EXTENSIONS: [&str; 7] = ["mp4", "mov", "m4v", "3gp", "webm", "mkv", "avi"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultErrorCode {
    ForbiddenPath,
    Unauthorized,
    Denied,
    NotFound,
    Offline,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultError {
    pub code: VaultErrorCode,
    pub message: String,
}

impl VaultError {
    fn new(code: VaultErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Errors after which carrying on is pointless: the session is gone or the server can't be reached.
    fn is_fatal(&self) -> bool {
        matches!(
            self.code,
            VaultErrorCode::Unauthorized | VaultErrorCode::Offline | VaultErrorCode::Denied
        )
    }
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for VaultError {}

fn forbidden(message: &str) -> VaultError {
    VaultError::new(VaultErrorCode::ForbiddenPath, message)
}

/// How a call to the file server failed: the HTTP status (0 when the server did not answer at all) and what it said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientError {
    pub status: u16,
    pub message: String,
}

impl ClientError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

/// A file or folder as the server lists it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultItem {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    /// When the server last saw it change, as the server writes it (RFC 3339); empty for a folder.
    pub modified: String,
    /// The server can make a thumbnail of it; `None` when the server did not say.
    pub has_preview: Option<bool>,
}

/// What the vault needs from the FileBrowser client; the real client has all of it.
pub trait VaultClient: Sync {
    fn list(&self, path: &str) -> impl Future<Output = Result<Vec<VaultItem>, ClientError>> + Send;
    fn remove(&self, path: &str) -> impl Future<Output = Result<(), ClientError>> + Send;
    fn rename(
        &self,
        path: &str,
        new_path: &str,
    ) -> impl Future<Output = Result<(), ClientError>> + Send;
    fn create_folder(&self, path: &str) -> impl Future<Output = Result<(), ClientError>> + Send;
}

/// Anything listed in a folder, for [`hide_peer_folders`].
pub trait ListedItem {
    fn name(&self) -> &str;
    fn is_dir(&self) -> bool;
}

impl ListedItem for VaultItem {
    fn name(&self) -> &str {
        &self.name
    }

    fn is_dir(&self) -> bool {
        self.is_dir
    }
}

fn to_vault_error(err: ClientError, fallback: &str) -> VaultError {
    use VaultErrorCode::*;
    match err.status {
        401 => VaultError::new(Unauthorized, "Session expirée"),
        403 => VaultError::new(Denied, "Accès refusé à ce dossier"),
        404 => VaultError::new(NotFound, "Dossier introuvable"),
        0 => VaultError::new(Offline, "Serveur injoignable"),
        _ if err.message.is_empty() => VaultError::new(Failed, fallback),
        _ => VaultError::new(Failed, err.message),
    }
}

/// Why one step failed: a path the vault refused, or the server.
enum Fail {
    Vault(VaultError),
    Client(ClientError),
}

impl From<VaultError> for Fail {
    fn from(err: VaultError) -> Self {
        Self::Vault(err)
    }
}

impl From<ClientError> for Fail {
    fn from(err: ClientError) -> Self {
        Self::Client(err)
    }
}

impl Fail {
    fn into_vault(self, fallback: &str) -> VaultError {
        match self {
            Self::Vault(err) => err,
            Self::Client(err) => to_vault_error(err, fallback),
        }
    }
}

/// The length JavaScript gives a string (UTF-16 code units), which the limits were set in.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript's `<` on strings: by UTF-16 code units.
fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// What JavaScript's `trim()` takes off.
fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

fn has_control_character(text: &str) -> bool {
    text.chars().any(|c| c.is_ascii_control())
}

fn is_safe_char(c: char) -> bool {
    matches!(c, '_' | '@' | '+' | '-')
        || matches!(
            c.general_category_group(),
            GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
        )
}

/// `decodeURIComponent`: `None` when the text is not valid percent-encoding.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The account's name as a folder name. Letters and digits (any script) and `_ @ + -` pass through, dots and
/// spaces only inside the name; everything else (a slash, a leading dot, even "~" itself) becomes `~hex~`. Nothing
/// can turn into "." or "..", and two different accounts can never end up with the same folder.
pub fn sanitize_username(username: &str) -> Result<String, VaultError> {
    sanitize_segment(
        username,
        "Nom de compte vide",
        "Nom de compte trop long pour un dossier",
    )
}

fn sanitize_segment(
    raw: &str,
    empty_message: &str,
    too_long_message: &str,
) -> Result<String, VaultError> {
    let normalized: String = raw.nfc().collect();
    let chars: Vec<char> = normalized.trim_matches(is_js_space).chars().collect();
    if chars.is_empty() {
        return Err(forbidden(empty_message));
    }
    let last = chars.len() - 1;
    let mut name = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if is_safe_char(c) || ((c == '.' || c == ' ') && i > 0 && i < last) {
            name.push(c);
        } else {
            let _ = write!(name, "~{:x}~", c as u32);
        }
    }
    if js_length(&name) > MAX_SEGMENT_LENGTH {
        return Err(forbidden(too_long_message));
    }
    Ok(name)
}

fn is_year_folder(segment: &str) -> bool {
    segment.len() == 4 && segment.bytes().all(|b| b.is_ascii_digit())
}

/// The folder a phone album ("Screenshots", "WhatsApp Images") is backed up into, inside the account's folder.
/// Named like accounts are, so nothing in an album's name can lead out of it; a name that would be taken for a year
/// folder or for the bin gets a suffix.
pub fn album_folder_name(title: &str) -> Result<String, VaultError> {
    let name = sanitize_segment(
        title,
        "Nom d'album vide",
        "Nom d'album trop long pour un dossier",
    )?;
    Ok(
        if is_year_folder(&name) || name.to_lowercase() == TRASH_FOLDER.to_lowercase() {
            format!("{name} (album)")
        } else {
            name
        },
    )
}

/// The clean segments of a path. Anything that could be part of an escape is refused rather than "fixed": "..",
/// backslashes, control characters, and a segment that only becomes ".." or contains a slash once percent-decoded
/// (something further along might decode it).
fn segments_of(path: &str) -> Result<Vec<&str>, VaultError> {
    if has_control_character(path) || path.contains('\\') {
        return Err(forbidden("Caractère interdit dans le chemin"));
    }
    let mut segments = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(forbidden("Chemin hors du dossier"));
        }
        if js_length(part) > MAX_NAME_LENGTH {
            return Err(forbidden("Nom trop long"));
        }
        if let Some(decoded) = decode_uri_component(part)
            && decoded != part
            && (decoded == ".."
                || decoded == "."
                || decoded.contains('/')
                || decoded.contains('\\'))
        {
            return Err(forbidden("Chemin encodé hors du dossier"));
        }
        segments.push(part);
    }
    Ok(segments)
}

fn join_segments<S: AsRef<str>>(segments: &[S]) -> String {
    let mut path = String::new();
    for segment in segments {
        path.push('/');
        path.push_str(segment.as_ref());
    }
    if path.is_empty() {
        path.push('/');
    }
    path
}

/// The clean segments of a path, owned.
fn owned_segments(path: &str) -> Result<Vec<String>, VaultError> {
    Ok(segments_of(path)?.into_iter().map(str::to_owned).collect())
}

/// The backup folder for one account: the setting with the account's name in place of `{user}`.
pub fn vault_root_for(template: &str, username: &str) -> Result<String, VaultError> {
    let filled = template.replace(USER_TOKEN, &sanitize_username(username)?);
    Ok(join_segments(&segments_of(&filled)?))
}

/// The central folder that holds one sub-folder per account, or `None` when the setting isn't organised by account.
pub fn central_folder_of(template: &str) -> Result<Option<String>, VaultError> {
    let segments = segments_of(template)?;
    if segments.len() < 2 || segments.last() != Some(&USER_TOKEN) {
        return Ok(None);
    }
    Ok(Some(join_segments(&segments[..segments.len() - 1])))
}

/// `path` made absolute and clean, provided it is `root` or lies inside it.
pub fn resolve_inside(root: &str, path: &str) -> Result<String, VaultError> {
    let root_segments = segments_of(root)?;
    let segments = segments_of(path)?;
    if root_segments.len() > segments.len()
        || root_segments.iter().zip(&segments).any(|(a, b)| a != b)
    {
        return Err(forbidden("Chemin hors du dossier de sauvegarde"));
    }
    Ok(join_segments(&segments))
}

pub fn is_inside(root: &str, path: &str) -> bool {
    resolve_inside(root, path).is_ok()
}

/// A file or folder name as the server reports it: never a way out of the folder it was listed in.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && js_length(name) <= MAX_NAME_LENGTH
        && !name.contains('/')
        && !name.contains('\\')
        && !has_control_character(name)
}

fn child_path(dir: &str, name: &str) -> Result<String, VaultError> {
    if !valid_name(name) {
        return Err(forbidden("Nom de fichier invalide"));
    }
    let mut segments = segments_of(dir)?;
    segments.push(name);
    Ok(join_segments(&segments))
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn is_photo_name(name: &str) -> bool {
    PHOTO_EXTENSIONS.contains(&extension_of(name).as_str())
}

pub fn is_video_name(name: &str) -> bool {
    VIDEO_EXTENSIONS.contains(&extension_of(name).as_str())
}

fn is_media_name(name: &str) -> bool {
    is_photo_name(name) || is_video_name(name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Photo,
    Video,
}

impl MediaKind {
    fn of(name: &str) -> Self {
        if is_video_name(name) {
            Self::Video
        } else {
            Self::Photo
        }
    }
}

/// `Date.parse(text) || 0`: milliseconds since 1970, 0 when the text is not a date.
fn parse_time(text: &str) -> i64 {
    use jiff::tz::TimeZone;
    if let Ok(timestamp) = text.parse::<jiff::Timestamp>() {
        return timestamp.as_millisecond();
    }
    // A date alone is midnight UTC; a date and time without an offset is local time.
    let zoned = if text.len() == 10 {
        text.parse::<Date>()
            .ok()
            .and_then(|date| date.to_zoned_datetime(TimeZone::UTC).ok())
    } else {
        text.parse::<jiff::civil::DateTime>()
            .ok()
            .and_then(|time| time.to_zoned_datetime(TimeZone::system()).ok())
    };
    zoned.map_or(0, |zoned| zoned.timestamp().as_millisecond())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Photo {
    pub path: String,
    pub name: String,
    /// Photos and videos are backed up side by side; the gallery shows both.
    pub kind: MediaKind,
    pub size: u64,
    /// When the server last saw the file change (ms); 0 when unknown.
    pub modified: i64,
    /// From the year/month folders the backup files it under.
    pub year: Option<i32>,
    pub month: Option<u32>,
    /// The phone album it was backed up from ("Screenshots"); `None` for the camera's own, which sit directly in
    /// year/month folders.
    pub album: Option<String>,
    /// Where it sits inside the backup folder it was found in (`[album/]year/month/name`).
    pub relative: String,
    pub has_preview: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultListing {
    pub photos: Vec<Photo>,
    /// Some folder couldn't be read, so the list may be missing photos.
    pub incomplete: bool,
}

struct Place {
    album: Option<String>,
    year: Option<i32>,
    month: Option<u32>,
}

/// The album, year and month a file's folders say, from its path below the backup folder (file name last).
fn place_of(relative: &[&str]) -> Place {
    let folders = &relative[..relative.len().saturating_sub(1)];
    let album = folders
        .first()
        .filter(|first| !is_year_folder(first))
        .map(|first| (*first).to_owned());
    let dated = if album.is_none() {
        folders
    } else {
        &folders[1..]
    };
    let year: Option<i32> = dated
        .first()
        .filter(|first| is_year_folder(first))
        .and_then(|first| first.parse().ok());
    let month_number: u32 = dated
        .get(1)
        .filter(|month| month.len() == 2 && month.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|month| month.parse().ok())
        .unwrap_or(0);
    let month = (year.is_some() && (1..=12).contains(&month_number)).then_some(month_number);
    Place { album, year, month }
}

fn to_photo(path: String, item: VaultItem, top_length: usize) -> Photo {
    let segments = segments_of(&path).unwrap_or_default();
    let relative = &segments[top_length.min(segments.len())..];
    let place = place_of(relative);
    let relative = relative.join("/");
    Photo {
        kind: MediaKind::of(&item.name),
        modified: parse_time(&item.modified),
        size: item.size,
        name: item.name,
        year: place.year,
        month: place.month,
        album: place.album,
        relative,
        has_preview: item.has_preview,
        path,
    }
}

/// One folder waiting to be listed.
struct FolderJob {
    /// Which of the folders being read it belongs to.
    root: usize,
    dir: String,
    depth: usize,
    /// The folder names from the root down to it.
    below: Vec<String>,
}

type Listing<'a> =
    Pin<Box<dyn Future<Output = (FolderJob, Result<Vec<VaultItem>, ClientError>)> + Send + 'a>>;

/// Lists folders a few at a time, never more than [`LIST_CONCURRENCY`] at once, in the order they are queued: a
/// folder that finishes hands its place straight to the next one waiting. `visit` hears each answer and queues the
/// sub-folders worth reading, or stops the walk. Nothing more is started once `is_cancelled` says so.
async fn walk_folders<'a, C: VaultClient>(
    client: &'a C,
    start: Vec<FolderJob>,
    is_cancelled: &impl Fn() -> bool,
    mut visit: impl FnMut(
        FolderJob,
        Result<Vec<VaultItem>, ClientError>,
        &mut VecDeque<FolderJob>,
    ) -> ControlFlow<()>,
) {
    let mut queue = VecDeque::from(start);
    let mut running: Vec<Listing<'a>> = Vec::new();
    loop {
        while running.len() < LIST_CONCURRENCY
            && let Some(job) = queue.pop_front()
        {
            if is_cancelled() {
                queue.clear();
                break;
            }
            running.push(Box::pin(async move {
                let result = client.list(&job.dir).await;
                (job, result)
            }));
        }
        if running.is_empty() {
            return;
        }
        let (job, result) =
            poll_fn(|cx| {
                let done = running.iter_mut().enumerate().find_map(|(i, task)| {
                    match task.as_mut().poll(cx) {
                        Poll::Ready(out) => Some((i, out)),
                        Poll::Pending => None,
                    }
                });
                match done {
                    Some((i, out)) => {
                        drop(running.remove(i));
                        Poll::Ready(out)
                    }
                    None => Poll::Pending,
                }
            })
            .await;
        if visit(job, result, &mut queue).is_break() {
            return;
        }
    }
}

#[derive(Default)]
struct Scan {
    photos: Vec<Photo>,
    incomplete: bool,
    /// Why the top folder itself couldn't be listed, if it couldn't.
    failure: Option<ClientError>,
}

/// The same photo in two backup folders (same year/month/name, same size) is one photo, not two.
fn photo_key(photo: &Photo) -> String {
    format!("{}|{}", photo.relative, photo.size)
}

/// The first scan's photos, then those of the others that it doesn't already have.
fn merge_scans(scans: &[Scan]) -> Vec<Photo> {
    let Some((first, others)) = scans.split_first() else {
        return Vec::new();
    };
    let mut merged = first.photos.clone();
    let mut known: HashSet<String> = merged.iter().map(photo_key).collect();
    for scan in others {
        for photo in &scan.photos {
            if known.insert(photo_key(photo)) {
                merged.push(photo.clone());
            }
        }
    }
    merged
}

/// The older backup folders worth reading along with `top`: valid, distinct, and neither inside nor around it.
fn older_folders(top: &str, candidates: &[&str]) -> Vec<String> {
    let mut folders: Vec<String> = Vec::new();
    for candidate in candidates {
        let Ok(folder) = resolve_inside("/", candidate) else {
            continue;
        };
        if folder == "/"
            || folder == top
            || is_inside(top, &folder)
            || is_inside(&folder, top)
            || folders.contains(&folder)
        {
            continue;
        }
        folders.push(folder);
    }
    folders
}

fn segment_count(path: &str) -> usize {
    segments_of(path).map_or(0, |segments| segments.len())
}

/// Every photo in the account's backup folder (root / [album /] year / month), and in `older` backup folders (from
/// before backups were kept per account) if there are any, so photos that haven't been moved yet are in the gallery
/// all the same; a photo present in both is shown once. Folders are read a few at a time, newest first, and
/// `on_partial` hears about the photos found so far, so the gallery fills in as it goes. A folder that doesn't
/// exist yet is just an empty gallery.
pub async fn load_photos<C: VaultClient>(
    client: &C,
    root: &str,
    older: &[&str],
    is_cancelled: impl Fn() -> bool,
    mut on_partial: impl FnMut(&[Photo]),
) -> Result<VaultListing, VaultError> {
    let top = resolve_inside(root, root)?;
    let mut tops = vec![top.clone()];
    tops.extend(older_folders(&top, older));
    let top_lengths: Vec<usize> = tops.iter().map(|top| segment_count(top)).collect();
    let mut scans: Vec<Scan> = tops.iter().map(|_| Scan::default()).collect();
    let start = tops
        .iter()
        .enumerate()
        .map(|(root, dir)| FolderJob {
            root,
            dir: dir.clone(),
            depth: 1,
            below: Vec::new(),
        })
        .collect();

    walk_folders(client, start, &is_cancelled, |job, result, queue| {
        let top = &tops[job.root];
        let items = match result {
            Ok(items) => items,
            Err(err) => {
                let scan = &mut scans[job.root];
                if job.dir == *top {
                    scan.failure = Some(err);
                } else {
                    scan.incomplete = true;
                }
                return ControlFlow::Continue(());
            }
        };
        let mut folders = Vec::new();
        let mut found = Vec::new();
        for item in items {
            // A name that would lead out of the folder is ignored.
            let Ok(path) =
                child_path(&job.dir, &item.name).and_then(|path| resolve_inside(top, &path))
            else {
                continue;
            };
            if item.is_dir {
                // The bin sits right under the backup folder and is not part of the gallery.
                if job.depth < MAX_DEPTH && !(job.depth == 1 && item.name == TRASH_FOLDER) {
                    folders.push(path);
                }
            } else if is_media_name(&item.name) {
                found.push(to_photo(path, item, top_lengths[job.root]));
            }
        }
        if !found.is_empty() {
            scans[job.root].photos.extend(found);
            on_partial(&merge_scans(&scans));
        }
        folders.sort_by(|a, b| js_cmp(b, a));
        queue.extend(folders.into_iter().map(|dir| FolderJob {
            root: job.root,
            dir,
            depth: job.depth + 1,
            below: Vec::new(),
        }));
        ControlFlow::Continue(())
    })
    .await;

    if let Some(err) = scans[0].failure.take() {
        let error = to_vault_error(err, "Impossible de lister les photos");
        if error.code != VaultErrorCode::NotFound {
            return Err(error);
        }
    }
    // An older folder that can't be read only means some photos may be missing from the list.
    let older_unreadable = scans[1..]
        .iter()
        .any(|scan| scan.failure.as_ref().is_some_and(|err| err.status != 404));
    Ok(VaultListing {
        photos: merge_scans(&scans),
        incomplete: older_unreadable || scans.iter().any(|scan| scan.incomplete),
    })
}

/// `path` made absolute and clean, provided it lies inside one of `roots`.
fn resolve_inside_any(roots: &[String], path: &str) -> Result<String, VaultError> {
    let mut first = None;
    for root in roots {
        match resolve_inside(root, path) {
            Ok(resolved) => return Ok(resolved),
            Err(err) => {
                first.get_or_insert(err);
            }
        }
    }
    Err(first.unwrap_or_else(|| forbidden("Chemin hors du dossier de sauvegarde")))
}

fn resolve_roots(roots: &[impl AsRef<str>]) -> Result<Vec<String>, VaultError> {
    let tops = roots
        .iter()
        .map(|root| resolve_inside(root.as_ref(), root.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    if tops.is_empty() {
        return Err(forbidden("Chemin invalide"));
    }
    Ok(tops)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedPath {
    pub path: String,
    pub message: String,
}

impl FailedPath {
    fn new(path: &str, message: &str) -> Self {
        Self {
            path: path.to_owned(),
            message: message.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeleteReport {
    pub deleted: Vec<String>,
    pub failed: Vec<FailedPath>,
}

async fn delete_one<C: VaultClient>(client: &C, tops: &[String], path: &str) -> Result<(), Fail> {
    let safe = resolve_inside_any(tops, path)?;
    let name = segments_of(&safe)?.last().copied().unwrap_or("").to_owned();
    if tops.contains(&safe) || !is_media_name(&name) {
        return Err(forbidden("Seules les photos peuvent être supprimées ici").into());
    }
    client.remove(&safe).await?;
    Ok(())
}

/// Deletes photos from the account's backup folders, for good: FileBrowser has no bin. Anything outside the
/// folders, and anything that isn't a photo or video (a folder, say), is refused. A lost session or server stops the
/// run rather than failing every remaining file one by one.
pub async fn delete_photos<C: VaultClient>(
    client: &C,
    roots: &[impl AsRef<str>],
    paths: &[impl AsRef<str>],
    mut on_each: impl FnMut(usize, usize),
) -> Result<DeleteReport, VaultError> {
    let tops = resolve_roots(roots)?;
    let mut report = DeleteReport::default();
    let mut stopped: Option<VaultError> = None;
    for (index, path) in paths.iter().enumerate() {
        let path = path.as_ref();
        if let Some(stop) = &stopped {
            report.failed.push(FailedPath::new(path, &stop.message));
            continue;
        }
        match delete_one(client, &tops, path).await {
            Ok(()) => report.deleted.push(path.to_owned()),
            Err(fail) => {
                let error = fail.into_vault("Suppression impossible");
                report.failed.push(FailedPath::new(path, &error.message));
                if error.is_fatal() {
                    stopped = Some(error);
                }
            }
        }
        on_each(index + 1, paths.len());
    }
    Ok(report)
}

// ---- the bin ----

fn is_day_folder(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// "2026-10-02": the day in the phone's own calendar, as the bin names its day folders.
pub fn day_stamp(date: Date) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// Days since 1970-01-01 of a day as JavaScript's `Date.UTC(year, month0, day)` counts it: months and days past the
/// end roll over, and years 0 to 99 are taken as 1900 to 1999.
fn utc_day_number(year: i64, month0: i64, day: i64) -> i64 {
    let year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    let y = year + month0.div_euclid(12);
    let m = month0.rem_euclid(12) + 1;
    // Days from civil (Howard Hinnant's algorithm), for the first of the month.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * ((m + 9) % 12) + 2) / 5;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468 + day - 1
}

/// Whole days from a bin day folder's date to `today` (0 for today); `None` when the name is not a day.
pub fn days_in_bin(day: &str, today: Date) -> Option<i64> {
    if !is_day_folder(day) {
        return None;
    }
    let number = |range: std::ops::Range<usize>| day[range].parse::<i64>().ok();
    let (year, month, date) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let today_number = utc_day_number(
        i64::from(today.year()),
        i64::from(today.month()) - 1,
        i64::from(today.day()),
    );
    Some(today_number - utc_day_number(year, month - 1, date))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashedPhoto {
    /// Where it is now, inside the bin.
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    pub size: u64,
    pub modified: i64,
    pub has_preview: Option<bool>,
    /// The day it went in the bin ("2026-10-02"); it is deleted for good [`TRASH_DAYS`] days later.
    pub trashed_on: String,
    /// Where it was: restoring puts it back there.
    pub original_path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrashListing {
    pub items: Vec<TrashedPhoto>,
    pub incomplete: bool,
}

/// A file moved, from where the caller named it to where it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Moved {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrashReport {
    pub moved: Vec<Moved>,
    pub failed: Vec<FailedPath>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreReport {
    pub restored: Vec<Moved>,
    pub failed: Vec<FailedPath>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EmptiedTrash {
    pub removed: usize,
    pub failed: usize,
}

/// Folders made and names seen during one run, so each folder is made and read once.
#[derive(Default)]
struct Known {
    made: HashSet<String>,
    present: HashMap<String, HashSet<String>>,
}

impl Known {
    /// What `dir` holds, read once per folder and kept up to date by the caller. A folder that can't be read is
    /// taken as empty.
    async fn names_in<C: VaultClient>(&mut self, client: &C, dir: &str) -> &mut HashSet<String> {
        if !self.present.contains_key(dir) {
            let names = match client.list(dir).await {
                Ok(items) => items.into_iter().map(|item| item.name).collect(),
                Err(_) => HashSet::new(),
            };
            self.present.insert(dir.to_owned(), names);
        }
        self.present.entry(dir.to_owned()).or_default()
    }

    /// Creates a folder and its parents, once each; "already exists" is the usual answer and is ignored.
    async fn ensure_folders<C: VaultClient>(
        &mut self,
        client: &C,
        dir: &str,
    ) -> Result<(), VaultError> {
        let segments = segments_of(dir)?;
        for i in 1..=segments.len() {
            let partial = join_segments(&segments[..i]);
            if self.made.contains(&partial) {
                continue;
            }
            let _ = client.create_folder(&partial).await;
            self.made.insert(partial);
        }
        Ok(())
    }

    /// Moves a file to `dir` under a free name.
    async fn move_into<C: VaultClient>(
        &mut self,
        client: &C,
        from: &str,
        dir: &str,
        name: &str,
    ) -> Result<String, Fail> {
        self.ensure_folders(client, dir).await?;
        let target = free_name(name, self.names_in(client, dir).await);
        let destination = format!("{dir}/{target}");
        client.rename(from, &destination).await?;
        self.names_in(client, dir).await.insert(target);
        Ok(destination)
    }
}

async fn trash_one<C: VaultClient>(
    client: &C,
    tops: &[String],
    bin_day: &[String],
    path: &str,
    known: &mut Known,
) -> Result<String, Fail> {
    let safe = resolve_inside_any(tops, path)?;
    let not_a_photo = || forbidden("Seules les photos peuvent être supprimées ici");
    let top = tops
        .iter()
        .find(|top| is_inside(top, &safe))
        .ok_or_else(not_a_photo)?;
    let segments = owned_segments(&safe)?;
    let relative = &segments[segment_count(top).min(segments.len())..];
    let Some((name, folders)) = relative.split_last() else {
        return Err(not_a_photo().into());
    };
    if !is_media_name(name) {
        return Err(not_a_photo().into());
    }
    if *top == tops[0] && relative[0] == TRASH_FOLDER {
        return Err(forbidden("Ce fichier est déjà dans la corbeille").into());
    }
    let dir = join_segments(&[bin_day, folders].concat());
    known.move_into(client, &safe, &dir, name).await
}

/// "Deletes" photos by moving them into the bin, a folder of the account's backup folder with one sub-folder per
/// day (`Corbeille/2026-10-02/2026/09/photo.jpg`), so restoring is moving back. Files from older backup folders go
/// into the account's bin (the first root's) too. Only photos and videos can be moved, never the bin's own content
/// or a folder.
pub async fn trash_photos<C: VaultClient>(
    client: &C,
    roots: &[impl AsRef<str>],
    paths: &[impl AsRef<str>],
    today: Date,
    mut on_each: impl FnMut(usize, usize),
) -> Result<TrashReport, VaultError> {
    let tops = resolve_roots(roots)?;
    let mut bin_day = owned_segments(&tops[0])?;
    bin_day.push(TRASH_FOLDER.to_owned());
    bin_day.push(day_stamp(today));
    let mut report = TrashReport::default();
    let mut known = Known::default();
    let mut stopped: Option<VaultError> = None;
    for (index, path) in paths.iter().enumerate() {
        let path = path.as_ref();
        if let Some(stop) = &stopped {
            report.failed.push(FailedPath::new(path, &stop.message));
            continue;
        }
        match trash_one(client, &tops, &bin_day, path, &mut known).await {
            Ok(to) => report.moved.push(Moved {
                from: path.to_owned(),
                to,
            }),
            Err(fail) => {
                let error = fail.into_vault("Suppression impossible");
                report.failed.push(FailedPath::new(path, &error.message));
                if error.is_fatal() {
                    stopped = Some(error);
                }
            }
        }
        on_each(index + 1, paths.len());
    }
    Ok(report)
}

/// What is in the account's bin, newest day first. A bin that doesn't exist yet is an empty one.
pub async fn load_trash<C: VaultClient>(
    client: &C,
    root: &str,
    is_cancelled: impl Fn() -> bool,
) -> Result<TrashListing, VaultError> {
    let top = resolve_inside(root, root)?;
    let top_segments = owned_segments(&top)?;
    let mut bin_segments = top_segments.clone();
    bin_segments.push(TRASH_FOLDER.to_owned());
    let bin = join_segments(&bin_segments);
    let mut listing = TrashListing::default();
    let days = match client.list(&bin).await {
        Ok(days) => days,
        Err(err) => {
            let error = to_vault_error(err, "Impossible de lire la corbeille");
            if error.code == VaultErrorCode::NotFound {
                return Ok(listing);
            }
            return Err(error);
        }
    };

    let start = days
        .into_iter()
        .filter(|entry| entry.is_dir && is_day_folder(&entry.name) && valid_name(&entry.name))
        .map(|entry| FolderJob {
            root: 0,
            dir: join_segments(
                &[bin_segments.as_slice(), std::slice::from_ref(&entry.name)].concat(),
            ),
            depth: 1,
            below: vec![entry.name],
        })
        .collect();
    walk_folders(client, start, &is_cancelled, |job, result, queue| {
        let Ok(listed) = result else {
            listing.incomplete = true;
            return ControlFlow::Continue(());
        };
        for item in listed {
            let Ok(path) =
                child_path(&job.dir, &item.name).and_then(|path| resolve_inside(&bin, &path))
            else {
                continue;
            };
            if item.is_dir {
                if job.depth < MAX_DEPTH {
                    let mut below = job.below.clone();
                    below.push(item.name);
                    queue.push_back(FolderJob {
                        root: 0,
                        dir: path,
                        depth: job.depth + 1,
                        below,
                    });
                }
            } else if is_media_name(&item.name) {
                // `below` starts with the day folder; the rest is where the file was.
                let original = [
                    top_segments.as_slice(),
                    &job.below[1..],
                    std::slice::from_ref(&item.name),
                ]
                .concat();
                listing.items.push(TrashedPhoto {
                    path,
                    kind: MediaKind::of(&item.name),
                    size: item.size,
                    modified: parse_time(&item.modified),
                    has_preview: item.has_preview,
                    trashed_on: job.below[0].clone(),
                    original_path: join_segments(&original),
                    name: item.name,
                });
            }
        }
        ControlFlow::Continue(())
    })
    .await;

    listing.items.sort_by(|a, b| {
        js_cmp(&b.trashed_on, &a.trashed_on)
            .then_with(|| js_cmp(&a.original_path, &b.original_path))
    });
    Ok(listing)
}

async fn restore_one<C: VaultClient>(
    client: &C,
    top_segments: &[String],
    bin_segments: &[String],
    path: &str,
    known: &mut Known,
) -> Result<String, Fail> {
    let safe = resolve_inside(&join_segments(bin_segments), path)?;
    let segments = owned_segments(&safe)?;
    let below = &segments[bin_segments.len().min(segments.len())..];
    let name = below.last().map_or("", String::as_str);
    if below.len() < 2 || !is_day_folder(&below[0]) || !is_media_name(name) {
        return Err(forbidden("Ce fichier n'est pas dans la corbeille").into());
    }
    let dir = join_segments(&[top_segments, &below[1..below.len() - 1]].concat());
    known.move_into(client, &safe, &dir, name).await
}

/// Puts files of the bin back where they came from (their folders are made again if need be). A name that has been
/// taken meanwhile is not overwritten: the file comes back under a numbered name.
pub async fn restore_trashed<C: VaultClient>(
    client: &C,
    root: &str,
    paths: &[impl AsRef<str>],
    mut on_each: impl FnMut(usize, usize),
) -> Result<RestoreReport, VaultError> {
    let top = resolve_inside(root, root)?;
    let top_segments = owned_segments(&top)?;
    let mut bin_segments = top_segments.clone();
    bin_segments.push(TRASH_FOLDER.to_owned());
    let mut report = RestoreReport::default();
    let mut known = Known::default();
    let mut stopped: Option<VaultError> = None;
    for (index, path) in paths.iter().enumerate() {
        let path = path.as_ref();
        if let Some(stop) = &stopped {
            report.failed.push(FailedPath::new(path, &stop.message));
            continue;
        }
        match restore_one(client, &top_segments, &bin_segments, path, &mut known).await {
            Ok(to) => report.restored.push(Moved {
                from: path.to_owned(),
                to,
            }),
            Err(fail) => {
                let error = fail.into_vault("Restauration impossible");
                report.failed.push(FailedPath::new(path, &error.message));
                if error.is_fatal() {
                    stopped = Some(error);
                }
            }
        }
        on_each(index + 1, paths.len());
    }
    Ok(report)
}

/// Deletes bin days for good: all of them, or only those at least `older_than_days` old on `today`. Only the day
/// folders the app made are touched; anything else somebody put in the bin folder is left alone.
pub async fn empty_trash<C: VaultClient>(
    client: &C,
    root: &str,
    older_than_days: Option<i64>,
    today: Date,
) -> Result<EmptiedTrash, VaultError> {
    let top = resolve_inside(root, root)?;
    let mut bin_segments = owned_segments(&top)?;
    bin_segments.push(TRASH_FOLDER.to_owned());
    let days = match client.list(&join_segments(&bin_segments)).await {
        Ok(days) => days,
        Err(err) => {
            let error = to_vault_error(err, "Impossible de lire la corbeille");
            if error.code == VaultErrorCode::NotFound {
                return Ok(EmptiedTrash::default());
            }
            return Err(error);
        }
    };
    let mut result = EmptiedTrash::default();
    for entry in days {
        if !entry.is_dir || !is_day_folder(&entry.name) || !valid_name(&entry.name) {
            continue;
        }
        if let Some(limit) = older_than_days {
            match days_in_bin(&entry.name, today) {
                Some(age) if age >= limit => {}
                _ => continue,
            }
        }
        let day =
            join_segments(&[bin_segments.as_slice(), std::slice::from_ref(&entry.name)].concat());
        match client.remove(&day).await {
            Ok(()) => result.removed += 1,
            Err(err) => {
                result.failed += 1;
                if to_vault_error(err, "").is_fatal() {
                    break;
                }
            }
        }
    }
    Ok(result)
}

/// Deletes what has been in the bin for [`TRASH_DAYS`] days or more.
pub async fn purge_expired_trash<C: VaultClient>(
    client: &C,
    root: &str,
    today: Date,
) -> Result<EmptiedTrash, VaultError> {
    empty_trash(client, root, Some(TRASH_DAYS), today).await
}

/// Whether the folder exists and has anything in it.
pub async fn has_backups<C: VaultClient>(client: &C, root: &str) -> bool {
    let Ok(folder) = resolve_inside("/", root) else {
        return false;
    };
    client
        .list(&folder)
        .await
        .is_ok_and(|items| !items.is_empty())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Photos and videos found in the old folder.
    pub total: usize,
    pub moved: usize,
    /// Already in the new folder under the same name: left where they are.
    pub skipped: usize,
    pub failed: usize,
    pub removed_folders: usize,
    /// The first few failures, for the user to read.
    pub errors: Vec<String>,
    pub cancelled: bool,
}

/// Moves `source` to `destination` unless that name is taken there; whether it moved.
async fn migrate_one<C: VaultClient>(
    client: &C,
    source: &str,
    destination: &str,
    dir: &str,
    name: &str,
    known: &mut Known,
) -> Result<bool, Fail> {
    known.ensure_folders(client, dir).await?;
    if known.names_in(client, dir).await.contains(name) {
        return Ok(false);
    }
    client.rename(source, destination).await?;
    known.names_in(client, dir).await.insert(name.to_owned());
    Ok(true)
}

/// Moves the photos and videos of an old backup folder into the account's folder, keeping the year/month layout. It
/// moves rather than copies, never overwrites (a file already there is left alone, and so is its twin), skips
/// anything that isn't a photo or video, and only removes old folders it has just found empty, so it can be stopped
/// and run again at any time.
pub async fn migrate_backups<C: VaultClient>(
    client: &C,
    from_root: &str,
    to_root: &str,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<MigrationReport, VaultError> {
    let from = resolve_inside("/", from_root)?;
    let to = resolve_inside("/", to_root)?;
    if from == "/" || from == to || is_inside(&from, &to) {
        return Err(forbidden(
            "Les dossiers source et destination se chevauchent",
        ));
    }

    let mut report = MigrationReport::default();
    let mut files: Vec<String> = Vec::new();
    let mut folders: Vec<String> = Vec::new();
    let mut failure: Option<ClientError> = None;
    let start = vec![FolderJob {
        root: 0,
        dir: from.clone(),
        depth: 1,
        below: Vec::new(),
    }];
    walk_folders(client, start, &|| false, |job, result, queue| {
        let items = match result {
            Ok(items) => items,
            Err(err) => {
                failure = Some(err);
                return ControlFlow::Break(());
            }
        };
        for item in items {
            let Ok(path) =
                child_path(&job.dir, &item.name).and_then(|path| resolve_inside(&from, &path))
            else {
                continue;
            };
            if item.is_dir {
                if job.depth < MAX_DEPTH {
                    folders.push(path.clone());
                    queue.push_back(FolderJob {
                        root: 0,
                        dir: path,
                        depth: job.depth + 1,
                        below: Vec::new(),
                    });
                }
            } else if is_media_name(&item.name) {
                files.push(path);
            }
        }
        ControlFlow::Continue(())
    })
    .await;
    if let Some(err) = failure {
        let error = to_vault_error(err, "Impossible de lire les anciennes sauvegardes");
        if error.code == VaultErrorCode::NotFound {
            return Ok(report);
        }
        return Err(error);
    }
    report.total = files.len();

    let mut known = Known::default();
    let mut aborted = false;
    let from_length = segment_count(&from);
    let to_segments = owned_segments(&to)?;
    for source in &files {
        if is_cancelled() {
            report.cancelled = true;
            break;
        }
        let source_segments = owned_segments(source)?;
        let wanted = [
            to_segments.as_slice(),
            &source_segments[from_length.min(source_segments.len())..],
        ]
        .concat();
        let destination = resolve_inside(&to, &join_segments(&wanted))?;
        let destination_segments = owned_segments(&destination)?;
        let Some((name, parents)) = destination_segments.split_last() else {
            continue;
        };
        let dir = join_segments(parents);
        match migrate_one(client, source, &destination, &dir, name, &mut known).await {
            Ok(true) => report.moved += 1,
            Ok(false) => report.skipped += 1,
            Err(fail) => {
                let error = fail.into_vault("Déplacement impossible");
                report.failed += 1;
                if report.errors.len() < 5 {
                    report.errors.push(format!("{name} : {}", error.message));
                }
                if error.is_fatal() {
                    aborted = true;
                    break;
                }
            }
        }
        on_progress(report.moved + report.skipped + report.failed, files.len());
    }

    if !report.cancelled && !aborted {
        // Deepest first, so a month folder goes before its year.
        folders.sort_by_key(|dir| std::cmp::Reverse(segment_count(dir)));
        for dir in &folders {
            if client.list(dir).await.is_ok_and(|items| items.is_empty())
                && client.remove(dir).await.is_ok()
            {
                report.removed_folders += 1;
            }
        }
    }
    Ok(report)
}

/// In the file browser, inside the central backup folder an account sees only its own sub-folder. This is a
/// courtesy on top of the lock, not the lock itself: the lock is the account's scope on the FileBrowser server.
pub fn hide_peer_folders<T: ListedItem>(
    items: Vec<T>,
    dir: &str,
    template: &str,
    username: &str,
) -> Vec<T> {
    let own = || -> Result<Option<String>, VaultError> {
        let Some(central) = central_folder_of(template)? else {
            return Ok(None);
        };
        if central == "/" || resolve_inside("/", dir)? != central {
            return Ok(None);
        }
        Ok(Some(sanitize_username(username)?))
    };
    match own() {
        Ok(Some(own)) => items
            .into_iter()
            .filter(|item| !item.is_dir() || item.name() == own)
            .collect(),
        _ => items,
    }
}

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;
