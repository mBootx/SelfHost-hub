//! Songs kept on the phone and what the player does with them: how the offline mode reacts to the network verdict
//! (toasts, probing the server, reordering the queue), playlists kept downloaded, and the download rules (what to
//! fetch, under which name, how many at once, what to tell the user, how much room it takes).
//!
//! Port of `mobile/src/services/offlineMode.ts`, `keptPlaylists.ts` and the pure rules of `store/offlineStore.ts` and
//! `store/downloadStore.ts`. What was React Native, expo or storage is an input or an output here: the caller reads
//! the network state, pings the server, downloads the files, shows the toasts and saves the manifests, then tells
//! these types what happened and does what they answer. Times are ms on any steady clock (the epoch for the kept
//! playlists' half-hour gap).

use std::collections::HashMap;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::offline::{NetworkMonitor, NetworkQuality, next_local_index, prioritize_local};
use crate::song::SongInfo;

// --- Offline mode: what the player does with the network verdict ---

/// While the network is not good, the server is pinged this often to see whether it got better (or worse).
pub const PROBE_EVERY_MS: u64 = 30_000;
/// A ping with no answer after this long counts as failed.
pub const PING_TIMEOUT_MS: u64 = 6_000;

/// The word the diagnostics log uses for a verdict.
pub fn quality_name(quality: NetworkQuality) -> &'static str {
    match quality {
        NetworkQuality::Good => "good",
        NetworkQuality::Slow => "slow",
        NetworkQuality::Offline => "offline",
    }
}

/// What is said when the verdict changes to `quality`.
pub fn quality_toast(quality: NetworkQuality, offline_first: bool) -> &'static str {
    match (quality, offline_first) {
        (NetworkQuality::Offline, true) => "Hors connexion : lecture des titres téléchargés",
        (NetworkQuality::Offline, false) => "Hors connexion",
        (NetworkQuality::Slow, true) => "Réseau lent : les titres téléchargés passent en premier",
        (NetworkQuality::Slow, false) => "Réseau lent",
        (NetworkQuality::Good, _) => "Connexion rétablie",
    }
}

/// Said (once) when playback stops because nothing in the queue is on the phone.
pub const NOTHING_DOWNLOADED_TOAST: &str = "Hors connexion : aucun titre téléchargé dans la file";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
}

/// The repeating ping to the server the caller runs while the network is not good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeTimer {
    Start,
    Stop,
}

/// What the caller has to do after telling [`OfflineMode`] something. Every field is optional work.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Update {
    /// A toast to show.
    pub toast: Option<&'static str>,
    /// A line for the diagnostics log (the "connection" category).
    pub log: Option<(LogLevel, String)>,
    /// Start or stop pinging the server every [`PROBE_EVERY_MS`].
    pub timer: Option<ProbeTimer>,
    /// Ping the server now: call [`OfflineMode::begin_probe`], which says whether to.
    pub probe: bool,
}

/// What to do with the player after [`OfflineMode::react`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Keep playing what is playing.
    Stay,
    /// Go to this index of the (reordered) queue, from the start of the song.
    Jump(usize),
    /// The song cannot be streamed and nothing in the queue is on the phone: pause (when it was playing) rather than
    /// leave the player stuck trying to stream. `announce`: say [`NOTHING_DOWNLOADED_TOAST`], which is done once
    /// for a given queue and song.
    Stuck { pause: bool, announce: bool },
}

/// The queue to keep and the step to take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reaction<T> {
    /// The queue reordered (songs on the phone first), or `None` when nothing moved.
    pub queue: Option<Vec<T>>,
    pub step: Step,
}

/// Downloaded songs first when the network is bad. Holds the verdict, the evidence behind it, and the bookkeeping the
/// app kept in module variables (is a ping running, is the repeating ping on, which stuck queue was already said).
#[derive(Debug, Clone)]
pub struct OfflineMode {
    monitor: NetworkMonitor,
    quality: NetworkQuality,
    reason: &'static str,
    offline_first: bool,
    probing: bool,
    timer_on: bool,
    /// The song a "nothing on the phone" pause was made for, so it is said once, not at every check.
    last_stuck: String,
}

impl Default for OfflineMode {
    /// A good network and the setting on (its default).
    fn default() -> Self {
        Self {
            monitor: NetworkMonitor::default(),
            quality: NetworkQuality::Good,
            reason: "ok",
            offline_first: true,
            probing: false,
            timer_on: false,
            last_stuck: String::new(),
        }
    }
}

impl OfflineMode {
    pub fn quality(&self) -> NetworkQuality {
        self.quality
    }

    pub fn reason(&self) -> &'static str {
        self.reason
    }

    /// Whether the device says the internet is out of reach.
    pub fn internet_doubtful(&self) -> bool {
        self.monitor.internet_doubtful()
    }

    /// The "songs on the phone first" setting. Call [`Self::react`] after changing it: the order is looked at again.
    pub fn set_offline_first(&mut self, on: bool) {
        self.offline_first = on;
    }

    /// The song playing (when streamed, not on the phone) started or stopped waiting for data.
    pub fn note_stall(&mut self, buffering: bool, now: i64) -> Update {
        self.monitor.note_buffering(buffering, now);
        let mut update = self.evaluate(now);
        update.probe = buffering;
        update
    }

    /// What the device says about its connection (`isConnected`, `isInternetReachable`; `None`: it does not know).
    /// Only an explicit "not connected" is offline. On a network, or one the device doubts reaches the internet, the
    /// server itself is asked.
    pub fn note_connectivity(
        &mut self,
        is_connected: Option<bool>,
        is_internet_reachable: Option<bool>,
        now: i64,
    ) -> Update {
        let connected = is_connected != Some(false);
        self.monitor
            .note_connectivity(connected, is_internet_reachable);
        let mut update = self.evaluate(now);
        update.probe = connected;
        update
    }

    /// Whether to ping the server now: there must be a client and no ping already running. When it says yes, call
    /// [`Self::end_probe`] once the ping answered, failed or took more than [`PING_TIMEOUT_MS`].
    pub fn begin_probe(&mut self, has_client: bool) -> bool {
        if !has_client || self.probing {
            return false;
        }
        self.probing = true;
        true
    }

    /// The ping's answer time in ms, or `None` when it failed or timed out.
    pub fn end_probe(&mut self, latency_ms: Option<u64>, now: i64) -> Update {
        self.probing = false;
        self.monitor.note_ping(latency_ms);
        self.evaluate(now)
    }

    fn evaluate(&mut self, now: i64) -> Update {
        let (quality, reason) = self.monitor.snapshot(now);
        let mut update = Update::default();
        if quality != self.quality {
            self.quality = quality;
            self.reason = reason;
            let level = if quality == NetworkQuality::Good {
                LogLevel::Info
            } else {
                LogLevel::Warn
            };
            update.log = Some((
                level,
                format!("Réseau : {} ({reason})", quality_name(quality)),
            ));
            update.toast = Some(quality_toast(quality, self.offline_first));
            self.last_stuck.clear();
        } else {
            self.reason = reason;
        }
        // While it is bad the server is asked now and then, which is also how it is found to be good again.
        if quality != NetworkQuality::Good && !self.timer_on {
            self.timer_on = true;
            update.timer = Some(ProbeTimer::Start);
        } else if quality == NetworkQuality::Good && self.timer_on {
            self.timer_on = false;
            update.timer = Some(ProbeTimer::Stop);
        }
        update
    }

    /// Puts the queue in order for the network there is. Safe to call at any time: it changes nothing when nothing
    /// needs to. Call it after the verdict changed (the [`Update`]s), the queue or the song changed, a download
    /// finished or the setting was switched. `id` and `is_local` are about one song of the queue.
    pub fn react<T: Clone>(
        &mut self,
        queue: &[T],
        index: usize,
        repeat_all: bool,
        is_playing: bool,
        id: impl Fn(&T) -> String,
        is_local: impl Fn(&T) -> bool,
    ) -> Reaction<T> {
        let stay = Reaction {
            queue: None,
            step: Step::Stay,
        };
        if self.quality == NetworkQuality::Good || !self.offline_first || queue.is_empty() {
            return stay;
        }
        let reordered = prioritize_local(queue, index, &is_local);
        let current_queue = reordered.as_deref().unwrap_or(queue);
        let step = self.step(current_queue, index, repeat_all, is_playing, id, is_local);
        Reaction {
            queue: reordered,
            step,
        }
    }

    fn step<T>(
        &mut self,
        queue: &[T],
        index: usize,
        repeat_all: bool,
        is_playing: bool,
        id: impl Fn(&T) -> String,
        is_local: impl Fn(&T) -> bool,
    ) -> Step {
        if self.quality != NetworkQuality::Offline {
            return Step::Stay;
        }
        let Some(current) = queue.get(index) else {
            return Step::Stay;
        };
        if is_local(current) {
            return Step::Stay;
        }
        if let Some(target) = next_local_index(queue, index, &is_local, repeat_all) {
            return Step::Jump(target);
        }
        // Nothing on the phone to go to: stopping beats a player stuck trying to stream.
        let stuck = format!("{}@{index}", id(current));
        let announce = stuck != self.last_stuck;
        self.last_stuck = stuck;
        Step::Stuck {
            pause: is_playing,
            announce,
        }
    }
}

// --- Kept playlists ---

/// Kept playlists are looked at for new songs at most this often (unless asked).
pub const MIN_GAP_MS: i64 = 30 * 60_000;
/// Subsonic's error for "not found": a kept playlist that gives it was deleted on the server.
pub const PLAYLIST_NOT_FOUND: i64 = 70;
/// Where the kept playlists are saved (id to name).
pub const KEPT_PLAYLISTS_KEY: &str = "navidrome.keptPlaylists";
/// Where the downloaded songs' manifest is saved.
pub const OFFLINE_TRACKS_KEY: &str = "navidrome.offlineTracks";

/// What expo-network calls the kind of connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionType {
    None,
    Unknown,
    Cellular,
    Wifi,
    Bluetooth,
    Ethernet,
    Wimax,
    Vpn,
    Other,
}

/// Whether the phone is on a network that costs nothing per byte. `None`: the state could not be read.
pub fn is_unmetered(kind: Option<ConnectionType>) -> bool {
    matches!(kind, Some(ConnectionType::Wifi | ConnectionType::Ethernet))
}

/// The answer of [`KeptSync::gate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Not now.
    Skip,
    /// Go on only if [`is_unmetered`] says the network is free of charge.
    CheckNetwork,
    /// Go.
    Go,
}

/// When the kept playlists are synced: a client connected to Navidrome, nothing already running, something kept, and
/// unless forced a half hour since the last run and a network that costs nothing per byte.
#[derive(Debug, Clone, Default)]
pub struct KeptSync {
    last_run: i64,
    running: bool,
}

impl KeptSync {
    /// `connected`: there is a Navidrome client and its status is connected. `force`: now, on any network.
    pub fn gate(&self, connected: bool, kept_count: usize, force: bool, now: i64) -> Gate {
        if !connected || self.running || kept_count == 0 {
            return Gate::Skip;
        }
        if force {
            return Gate::Go;
        }
        if now - self.last_run < MIN_GAP_MS {
            return Gate::Skip;
        }
        Gate::CheckNetwork
    }

    /// A run starts (after [`Gate::Go`], or [`Gate::CheckNetwork`] and a free network).
    pub fn start(&mut self, now: i64) {
        self.running = true;
        self.last_run = now;
    }

    /// The run ended, however it did.
    pub fn finish(&mut self) {
        self.running = false;
    }
}

/// The playlists kept on the phone (id to name), in the order they were kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeptPlaylists {
    names: IndexMap<String, String>,
}

impl KeptPlaylists {
    /// Reads what was saved: anything but an object of names is nothing kept.
    pub fn from_json(saved: Option<&Value>) -> Self {
        let names = saved
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(id, name)| Some((id.clone(), name.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        Self { names }
    }

    /// What to save: `{"p1": "Route"}`.
    pub fn to_json(&self) -> Value {
        Value::Object(
            self.names
                .iter()
                .map(|(id, name)| (id.clone(), Value::String(name.clone())))
                .collect(),
        )
    }

    /// Keeps a playlist on the phone, or stops (the songs already downloaded stay).
    pub fn set(&mut self, playlist_id: &str, name: &str, keep: bool) {
        if keep {
            self.names.insert(playlist_id.to_string(), name.to_string());
        } else {
            self.names.shift_remove(playlist_id);
        }
    }

    /// A kept playlist's sync failed with this Subsonic code: when the playlist is gone from the server it is not kept
    /// any more. Says whether it was dropped.
    pub fn forget_if_gone(&mut self, playlist_id: &str, code: Option<i64>) -> bool {
        if code != Some(PLAYLIST_NOT_FOUND) {
            return false;
        }
        self.names.shift_remove(playlist_id).is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn contains(&self, playlist_id: &str) -> bool {
        self.names.contains_key(playlist_id)
    }

    /// (id, name) of each kept playlist.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.names
            .iter()
            .map(|(id, name)| (id.as_str(), name.as_str()))
    }
}

/// What the downloaded songs of a kept playlist are called in the message: the name the server has now, else the one
/// kept.
pub fn kept_label<'a>(server_name: Option<&'a str>, kept_name: &'a str) -> &'a str {
    server_name
        .filter(|name| !name.is_empty())
        .unwrap_or(kept_name)
}

/// The diagnostics line (level warn, category "music") for a kept playlist that could not be synced.
pub fn kept_failure_log(name: &str, error: &str) -> String {
    format!("Playlist gardée « {name} » : {error}")
}

// --- Downloads ---

/// The folder, in the app's documents, the downloaded songs go into.
pub const OFFLINE_DIR: &str = "offline-music";
/// Songs downloaded at once: firing twenty at the same time opened twenty sockets and write streams on a phone for no
/// gain on a single connection.
pub const CONCURRENCY: usize = 3;
/// The progress of a download is published at most this often (seconds), unless it just ended.
const PROGRESS_EVERY_S: f64 = 0.2;

/// "1 titre", "12 titres", "1 234 titres": French takes the singular for 0 and 1 and groups thousands with a narrow
/// no-break space.
fn plural(count: usize, one: &str, many: &str) -> String {
    let digits = count.to_string();
    let mut grouped = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push('\u{202f}');
        }
        grouped.push(digit);
    }
    format!("{grouped} {}", if count > 1 { many } else { one })
}

/// The extension a song is saved under: the server's own, when it looks like one (1 to 5 letters or digits), else mp3.
pub fn file_extension(suffix: Option<&str>) -> String {
    let clean = suffix.unwrap_or("").trim().to_lowercase();
    let plausible = (1..=5).contains(&clean.chars().count())
        && clean
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if plausible { clean } else { "mp3".to_string() }
}

/// The file a song is downloaded to, in [`OFFLINE_DIR`]: the original under its own extension (a FLAC stays a FLAC).
pub fn track_filename(song_id: &str, suffix: Option<&str>) -> String {
    format!("{song_id}.{}", file_extension(suffix))
}

/// A song kept on the phone.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OfflineTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub cover_art: Option<String>,
    pub duration: f64,
    pub filename: String,
    /// The file's size in bytes (songs downloaded before 2.7.1 don't have it: their file is measured).
    pub size: Option<u64>,
}

impl OfflineTrack {
    /// The manifest entry for a song just downloaded. Its cover is the song's, else its album's.
    pub fn downloaded(song: &SongInfo, suffix: Option<&str>, size: Option<u64>) -> Self {
        let cover = song
            .cover_art
            .as_deref()
            .filter(|c| !c.is_empty())
            .or(song.album_id.as_deref());
        Self {
            id: song.id.clone(),
            title: song.title.clone(),
            artist: song.artist.clone(),
            album: song.album.clone(),
            cover_art: cover.map(str::to_string),
            duration: song.duration,
            filename: track_filename(&song.id, suffix),
            size,
        }
    }

    /// One entry of the saved manifest, in the field names the app has always used. Only `id` and `filename` are
    /// required.
    pub fn from_json(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            id: text("id")?,
            title: text("title").unwrap_or_default(),
            artist: text("artist").unwrap_or_default(),
            album: text("album"),
            cover_art: text("coverArt"),
            duration: value.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
            filename: text("filename")?,
            size: value.get("size").and_then(Value::as_u64),
        })
    }

    pub fn to_json(&self) -> Value {
        let mut entry = Map::new();
        entry.insert("id".into(), json!(self.id));
        entry.insert("title".into(), json!(self.title));
        entry.insert("artist".into(), json!(self.artist));
        if let Some(album) = &self.album {
            entry.insert("album".into(), json!(album));
        }
        if let Some(cover) = &self.cover_art {
            entry.insert("coverArt".into(), json!(cover));
        }
        entry.insert("duration".into(), json!(self.duration));
        entry.insert("filename".into(), json!(self.filename));
        if let Some(size) = self.size {
            entry.insert("size".into(), json!(size));
        }
        Value::Object(entry)
    }
}

/// How much room the downloaded songs take, in bytes: their recorded size, or the file measured for the older ones
/// (`measure` gets the file name; `None` for a file gone missing, which counts for nothing).
pub fn offline_bytes<'a>(
    tracks: impl IntoIterator<Item = &'a OfflineTrack>,
    measure: impl Fn(&str) -> Option<u64>,
) -> u64 {
    tracks
        .into_iter()
        .map(|track| track.size.or_else(|| measure(&track.filename)).unwrap_or(0))
        .sum()
}

/// How far a download is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DownloadProgress {
    pub loaded: u64,
    pub total: u64,
    pub speed_bps: f64,
}

/// Turns the file system's progress callbacks into the progress worth showing: at most five a second, and always the
/// last one, with the speed since the previous one.
#[derive(Debug, Clone)]
pub struct ProgressThrottle {
    last_loaded: u64,
    last_tick: i64,
}

impl ProgressThrottle {
    /// `now`: when the download started.
    pub fn new(now: i64) -> Self {
        Self {
            last_loaded: 0,
            last_tick: now,
        }
    }

    pub fn update(
        &mut self,
        bytes_written: u64,
        total_bytes: u64,
        now: i64,
    ) -> Option<DownloadProgress> {
        let elapsed = (now - self.last_tick) as f64 / 1000.0;
        if elapsed < PROGRESS_EVERY_S && bytes_written != total_bytes {
            return None;
        }
        let speed_bps = if elapsed > 0.0 {
            bytes_written.saturating_sub(self.last_loaded) as f64 / elapsed
        } else {
            0.0
        };
        self.last_loaded = bytes_written;
        self.last_tick = now;
        Some(DownloadProgress {
            loaded: bytes_written,
            total: total_bytes,
            speed_bps,
        })
    }
}

/// Said when a download fails with no reason of its own.
pub const DEFAULT_DOWNLOAD_ERROR: &str = "Erreur de téléchargement";

/// The toast for one song that could not be downloaded.
pub fn download_failed_toast(title: &str, reason: &str) -> String {
    format!("« {title} » n’a pas pu être téléchargé : {reason}")
}

/// The diagnostics line (level warn, category "music") for it.
pub fn download_failed_log(title: &str, error: &str) -> String {
    format!("Téléchargement de « {title} » impossible : {error}")
}

/// What the songs downloaded to the phone are, and what is going on.
#[derive(Debug, Clone, Default)]
pub struct OfflineLibrary {
    pub tracks: IndexMap<String, OfflineTrack>,
    pub downloading: HashMap<String, DownloadProgress>,
    /// Why the last try for a song failed.
    pub errors: HashMap<String, String>,
    pub kept: KeptPlaylists,
}

impl OfflineLibrary {
    /// Reads the saved manifest and kept playlists. Entries that are not songs are dropped.
    pub fn from_saved(tracks: Option<&Value>, kept: Option<&Value>) -> Self {
        let tracks = tracks
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(id, entry)| Some((id.clone(), OfflineTrack::from_json(entry)?)))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            tracks,
            kept: KeptPlaylists::from_json(kept),
            ..Self::default()
        }
    }

    /// What to save under [`OFFLINE_TRACKS_KEY`].
    pub fn tracks_json(&self) -> Value {
        Value::Object(
            self.tracks
                .iter()
                .map(|(id, track)| (id.clone(), track.to_json()))
                .collect(),
        )
    }

    pub fn is_offline(&self, song_id: &str) -> bool {
        self.tracks.contains_key(song_id)
    }

    /// Where, among `song_ids`, the songs still to download are: not on the phone, not being downloaded, and once
    /// each even when the same song is twice in a playlist.
    pub fn wanted(&self, song_ids: &[&str]) -> Vec<usize> {
        song_ids
            .iter()
            .enumerate()
            .filter(|&(i, id)| {
                !self.tracks.contains_key(*id)
                    && !self.downloading.contains_key(*id)
                    && song_ids.iter().position(|other| other == id) == Some(i)
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// A download is about to start. `false`: the song is there or already coming, nothing to do. Otherwise it is
    /// marked as starting and its last error forgotten.
    pub fn begin_fetch(&mut self, song_id: &str) -> bool {
        if self.tracks.contains_key(song_id) || self.downloading.contains_key(song_id) {
            return false;
        }
        self.errors.remove(song_id);
        self.downloading.insert(
            song_id.to_string(),
            DownloadProgress {
                loaded: 0,
                total: 0,
                speed_bps: 0.0,
            },
        );
        true
    }

    pub fn set_progress(&mut self, song_id: &str, progress: DownloadProgress) {
        self.downloading.insert(song_id.to_string(), progress);
    }

    /// The file is down: the song is on the phone. Save [`Self::tracks_json`] after it.
    pub fn finish_fetch(&mut self, track: OfflineTrack) {
        self.downloading.remove(&track.id);
        self.tracks.insert(track.id.clone(), track);
    }

    /// The download failed (the caller deletes what was written of the file, so a later try starts clean). Gives the
    /// reason that is kept and told.
    pub fn fail_fetch(&mut self, song_id: &str, reason: Option<&str>) -> String {
        let reason = reason
            .filter(|r| !r.is_empty())
            .unwrap_or(DEFAULT_DOWNLOAD_ERROR)
            .to_string();
        self.downloading.remove(song_id);
        self.errors.insert(song_id.to_string(), reason.clone());
        reason
    }

    /// A song removed from the phone. Gives its entry, whose file the caller deletes (a file already gone changes
    /// nothing); save [`Self::tracks_json`] after it.
    pub fn remove(&mut self, song_id: &str) -> Option<OfflineTrack> {
        self.tracks.shift_remove(song_id)
    }
}

/// How a download was asked for.
#[derive(Debug, Clone, Default)]
pub struct DownloadOptions {
    /// A download the app starts on its own (a playlist kept on the phone): it only speaks up when it got something.
    pub quiet: bool,
    /// What the songs are, for that message ("Route").
    pub label: Option<String>,
}

/// The toast when a download is asked for: `wanted` songs are to be fetched among `asked` songs.
pub fn start_message(wanted: usize, asked: usize, options: &DownloadOptions) -> Option<String> {
    if options.quiet {
        return None;
    }
    if wanted == 0 {
        return (asked > 0).then(|| "Déjà téléchargé sur le téléphone".to_string());
    }
    Some(format!(
        "Téléchargement de {}…",
        plural(wanted, "titre", "titres")
    ))
}

/// The songs of one download request, handed out to the workers and counted.
#[derive(Debug, Clone)]
pub struct DownloadBatch {
    wanted: usize,
    cursor: usize,
    failed: usize,
    last_failure: String,
}

impl DownloadBatch {
    /// `wanted`: how many songs [`OfflineLibrary::wanted`] found.
    pub fn new(wanted: usize) -> Self {
        Self {
            wanted,
            cursor: 0,
            failed: 0,
            last_failure: String::new(),
        }
    }

    /// How many downloads to run at the same time.
    pub fn workers(&self) -> usize {
        CONCURRENCY.min(self.wanted)
    }

    /// The next song to fetch (an index into the wanted list), for whichever worker is free.
    pub fn next_slot(&mut self) -> Option<usize> {
        (self.cursor < self.wanted).then(|| {
            self.cursor += 1;
            self.cursor - 1
        })
    }

    /// A worker's result: `None` when the song is there, else why it failed.
    pub fn record(&mut self, failure: Option<&str>) {
        if let Some(reason) = failure {
            self.failed += 1;
            self.last_failure = reason.to_string();
        }
    }

    /// How many songs were downloaded.
    pub fn done(&self) -> usize {
        self.wanted - self.failed
    }

    /// The toast once everyone is finished. Kept playlists only tell the news; their failures go to the diagnostics.
    pub fn summary(&self, options: &DownloadOptions) -> Option<String> {
        let done = self.done();
        if options.quiet {
            if done == 0 {
                return None;
            }
            let of = match options.label.as_deref().filter(|l| !l.is_empty()) {
                Some(label) => format!(" de « {label} »"),
                None => String::new(),
            };
            return Some(format!(
                "{}{of} sur le téléphone",
                plural(done, "nouveau titre", "nouveaux titres")
            ));
        }
        if self.failed == 0 {
            return Some(format!(
                "{} sur le téléphone",
                plural(self.wanted, "titre téléchargé", "titres téléchargés")
            ));
        }
        let what = if self.failed > 1 {
            "n'ont pas pu être téléchargés"
        } else {
            "n'a pas pu être téléchargé"
        };
        Some(format!(
            "{} sur {} {what} : {}",
            self.failed, self.wanted, self.last_failure
        ))
    }
}

// --- Files downloaded from FileBrowser ---

/// A file downloaded from the server through the file browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadedFile {
    /// Filename on disk, which is also the identity: downloads are de-duplicated by it.
    pub filename: String,
    /// Where it came from on the server, so the row can show a meaningful subtitle.
    pub source_path: String,
    pub size_bytes: u64,
    pub downloaded_at: i64,
}

/// The manifest of those files, newest first. Where it is saved is [`DOWNLOADS_MANIFEST_KEY`].
#[derive(Debug, Clone, Default)]
pub struct DownloadedFiles {
    pub files: Vec<DownloadedFile>,
}

pub const DOWNLOADS_MANIFEST_KEY: &str = "filebrowser.downloads";

impl DownloadedFiles {
    /// The manifest can drift from reality (the user cleared the app's storage, an older build wrote elsewhere), so
    /// the disk is trusted: only files that `exists` are kept. Says whether the manifest changed and must be saved.
    pub fn retain_present(&mut self, exists: impl Fn(&str) -> bool) -> bool {
        let before = self.files.len();
        self.files.retain(|f| exists(&f.filename));
        self.files.len() != before
    }

    /// A file just downloaded goes first; the same name downloaded before is replaced.
    pub fn record(&mut self, file: DownloadedFile) {
        self.files.retain(|f| f.filename != file.filename);
        self.files.insert(0, file);
    }

    /// The file is dropped from the manifest (the caller deletes it; already gone is fine).
    pub fn remove(&mut self, filename: &str) {
        self.files.retain(|f| f.filename != filename);
    }

    pub fn clear(&mut self) {
        self.files.clear();
    }
}

// Ported from the player part of mobile/tests/offline.test.js (the network verdict and the queue helpers are in
// offline.rs) and mobile/tests/downloads.test.js (the drag arithmetic is in gestures.rs).
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const NOW: i64 = 1_000_000;

    /// The player's queue and what the app does with a [`Reaction`].
    struct Player {
        queue: Vec<&'static str>,
        index: usize,
        playing: bool,
        local: HashSet<&'static str>,
    }

    impl Player {
        fn new(ids: &[&'static str], index: usize) -> Self {
            Self {
                queue: ids.to_vec(),
                index,
                playing: true,
                local: HashSet::new(),
            }
        }

        fn set_local(&mut self, ids: &[&'static str]) {
            self.local = ids.iter().copied().collect();
        }

        /// What the subscription to the stores does: `react`, then apply the answer.
        fn react(&mut self, mode: &mut OfflineMode) -> (Step, Vec<&'static str>) {
            let local = self.local.clone();
            let reaction = mode.react(
                &self.queue,
                self.index,
                false,
                self.playing,
                |s| s.to_string(),
                |s| local.contains(s),
            );
            if let Some(queue) = reaction.queue {
                self.queue = queue;
            }
            match reaction.step {
                Step::Jump(target) => self.index = target,
                Step::Stuck { pause: true, .. } => self.playing = false,
                _ => {}
            }
            (reaction.step, self.queue.clone())
        }
    }

    fn offline() -> OfflineMode {
        let mut mode = OfflineMode::default();
        mode.note_connectivity(Some(false), Some(false), NOW);
        mode
    }

    #[test]
    fn with_a_good_network_nothing_moves() {
        let mut mode = OfflineMode::default();
        let mut player = Player::new(&["a", "b", "c"], 0);
        player.set_local(&["c"]);
        let (step, queue) = player.react(&mut mode);
        assert_eq!(step, Step::Stay);
        assert_eq!(queue, ["a", "b", "c"]);
        assert_eq!(mode.quality(), NetworkQuality::Good);
    }

    #[test]
    fn no_network_the_song_that_cannot_be_streamed_gives_way_to_the_next_one_on_the_phone_the_rest_reordered()
     {
        let mut mode = OfflineMode::default();
        let mut player = Player::new(&["a", "b", "c", "d", "e"], 0);
        player.set_local(&["c", "e"]);
        let update = mode.note_connectivity(Some(false), Some(false), NOW);
        assert_eq!(mode.quality(), NetworkQuality::Offline);
        assert_eq!(
            update.toast,
            Some("Hors connexion : lecture des titres téléchargés")
        );
        assert_eq!(
            update.log,
            Some((LogLevel::Warn, "Réseau : offline (pas de réseau)".into()))
        );
        assert_eq!(update.timer, Some(ProbeTimer::Start));
        let (step, queue) = player.react(&mut mode);
        assert_eq!(queue, ["a", "c", "e", "b", "d"]);
        assert_eq!(step, Step::Jump(1), "now on c");
    }

    #[test]
    fn no_network_and_nothing_on_the_phone_playback_stops_said_once() {
        let mut mode = offline();
        let mut player = Player::new(&["x", "y"], 0);
        let (step, _) = player.react(&mut mode);
        assert_eq!(
            step,
            Step::Stuck {
                pause: true,
                announce: true
            }
        );
        assert!(!player.playing);
        assert_eq!(
            NOTHING_DOWNLOADED_TOAST,
            "Hors connexion : aucun titre téléchargé dans la file"
        );
        let (again, _) = player.react(&mut mode);
        assert_eq!(
            again,
            Step::Stuck {
                pause: false,
                announce: false
            },
            "not again"
        );
        // Another song is another stop to say.
        let mut other = Player::new(&["x", "y"], 1);
        let (other_step, _) = other.react(&mut mode);
        assert_eq!(
            other_step,
            Step::Stuck {
                pause: true,
                announce: true
            }
        );
    }

    #[test]
    fn a_stop_is_said_again_after_the_network_changed() {
        let mut mode = offline();
        let mut player = Player::new(&["x", "y"], 0);
        player.react(&mut mode);
        mode.end_probe(Some(80), NOW);
        mode.note_connectivity(Some(true), Some(true), NOW);
        assert_eq!(mode.quality(), NetworkQuality::Good);
        mode.note_connectivity(Some(false), Some(false), NOW);
        let (step, _) = player.react(&mut mode);
        assert_eq!(
            step,
            Step::Stuck {
                pause: false,
                announce: true
            }
        );
    }

    #[test]
    fn a_song_downloaded_meanwhile_is_picked_up_at_once() {
        let mut mode = offline();
        let mut player = Player::new(&["x", "y", "z"], 0);
        player.react(&mut mode);
        player.set_local(&["z"]);
        let (step, queue) = player.react(&mut mode);
        assert_eq!(queue[player.index], "z");
        assert_eq!(step, Step::Jump(1));
    }

    #[test]
    fn with_the_setting_off_the_queue_is_left_alone_even_offline() {
        let mut mode = offline();
        mode.set_offline_first(false);
        let mut player = Player::new(&["a", "b", "c"], 0);
        player.set_local(&["c"]);
        let (step, queue) = player.react(&mut mode);
        assert_eq!((step, queue), (Step::Stay, vec!["a", "b", "c"]));
        assert_eq!(player.index, 0);
        mode.set_offline_first(true);
        let (_, queue) = player.react(&mut mode);
        assert_eq!(
            queue,
            ["a", "c", "b"],
            "switched back on: reordered at once"
        );
    }

    #[test]
    fn back_on_the_network_good_again_said_and_nothing_more_moves() {
        let mut mode = offline();
        let update = mode.note_connectivity(Some(true), Some(true), NOW);
        assert!(update.probe, "back on a network: the server is asked");
        assert!(mode.begin_probe(true));
        let update = mode.end_probe(Some(80), NOW);
        assert_eq!(mode.quality(), NetworkQuality::Good);
        assert_eq!(update.toast, Some("Connexion rétablie"));
        assert_eq!(
            update.log,
            Some((LogLevel::Info, "Réseau : good (ok)".into()))
        );
        assert_eq!(update.timer, Some(ProbeTimer::Stop));
        let mut player = Player::new(&["a", "b", "c"], 0);
        player.set_local(&["c"]);
        let (step, queue) = player.react(&mut mode);
        assert_eq!((step, queue), (Step::Stay, vec!["a", "b", "c"]));
    }

    #[test]
    fn on_a_network_android_doubts_the_server_itself_is_asked_at_once() {
        let mut mode = OfflineMode::default();
        let update = mode.note_connectivity(Some(true), Some(false), NOW);
        assert!(update.probe);
        assert!(mode.begin_probe(true));
        assert!(!mode.begin_probe(true), "one ping at a time");
        mode.end_probe(Some(60), NOW);
        assert_eq!(
            mode.quality(),
            NetworkQuality::Good,
            "it answered: a home server without internet is fine"
        );
        assert!(mode.internet_doubtful());
        // Unknown means connected; only an explicit false is no network.
        assert!(!mode.note_connectivity(Some(false), None, NOW).probe);
        assert!(mode.note_connectivity(None, None, NOW).probe);
    }

    #[test]
    fn a_streamed_song_stalling_makes_the_network_slow_downloaded_songs_first_but_the_song_playing_is_kept()
     {
        let mut mode = OfflineMode::default();
        let mut player = Player::new(&["a", "b", "c"], 0);
        player.set_local(&["c"]);
        let started = mode.note_stall(true, NOW);
        assert!(started.probe, "a stall makes the server be asked");
        let update = mode.note_stall(false, NOW + 5_000);
        assert!(!update.probe);
        assert_eq!(mode.quality(), NetworkQuality::Slow);
        assert_eq!(
            update.toast,
            Some("Réseau lent : les titres téléchargés passent en premier")
        );
        let (step, queue) = player.react(&mut mode);
        assert_eq!(queue, ["a", "c", "b"]);
        assert_eq!(step, Step::Stay);
        assert_eq!(player.index, 0, "a still plays: slow is not offline");
    }

    #[test]
    fn a_server_that_stops_answering_is_offline_even_with_the_phone_on_wi_fi() {
        let mut mode = OfflineMode::default();
        assert!(mode.note_stall(true, NOW).probe);
        assert!(mode.begin_probe(true));
        mode.end_probe(None, NOW);
        mode.note_stall(false, NOW);
        assert!(mode.note_stall(true, NOW).probe);
        assert!(mode.begin_probe(true));
        mode.end_probe(None, NOW);
        assert_eq!(mode.quality(), NetworkQuality::Offline);
        assert_eq!(mode.reason(), "serveur injoignable");
    }

    #[test]
    fn no_client_no_ping_and_the_toasts_follow_the_setting() {
        let mut mode = OfflineMode::default();
        assert!(!mode.begin_probe(false));
        assert_eq!(
            quality_toast(NetworkQuality::Offline, false),
            "Hors connexion"
        );
        assert_eq!(quality_toast(NetworkQuality::Slow, false), "Réseau lent");
        mode.set_offline_first(false);
        let update = mode.note_connectivity(Some(false), Some(false), NOW);
        assert_eq!(update.toast, Some("Hors connexion"));
    }

    #[test]
    fn a_still_bad_network_keeps_one_timer_and_only_the_reason_changes() {
        let mut mode = OfflineMode::default();
        mode.note_stall(true, NOW);
        let first = mode.note_stall(false, NOW + 5_000);
        assert_eq!(first.timer, Some(ProbeTimer::Start));
        let second = mode.end_probe(Some(2_000), NOW + 6_000);
        assert_eq!(second.timer, None);
        assert_eq!(second.toast, None, "same verdict: nothing said");
        assert_eq!(mode.quality(), NetworkQuality::Slow);
    }

    #[test]
    fn a_kept_playlist_is_remembered_and_dropping_it_keeps_the_songs() {
        let mut library = OfflineLibrary::default();
        library.kept.set("p1", "Route", true);
        assert_eq!(library.kept.to_json(), json!({ "p1": "Route" }));
        library.tracks.insert(
            "a".into(),
            OfflineTrack {
                id: "a".into(),
                filename: "a.mp3".into(),
                ..Default::default()
            },
        );
        library.kept.set("p1", "Route", false);
        assert_eq!(library.kept.to_json(), json!({}));
        assert!(library.is_offline("a"), "the files stay");
    }

    #[test]
    fn new_songs_of_a_kept_playlist_come_down_on_wi_fi_not_on_mobile_data_unless_asked() {
        let mut sync = KeptSync::default();
        let day = 24 * 3_600_000;
        assert_eq!(sync.gate(true, 1, false, day), Gate::CheckNetwork);
        assert!(
            !is_unmetered(Some(ConnectionType::Cellular)),
            "not on mobile data"
        );
        assert!(is_unmetered(Some(ConnectionType::Wifi)));
        assert!(is_unmetered(Some(ConnectionType::Ethernet)));
        assert!(!is_unmetered(Some(ConnectionType::Vpn)));
        assert!(!is_unmetered(None), "state unreadable: not free");
        assert_eq!(
            sync.gate(true, 1, true, day),
            Gate::Go,
            "asked for: any network"
        );
        sync.start(day);
        assert_eq!(
            sync.gate(true, 1, true, day),
            Gate::Skip,
            "one run at a time"
        );
        sync.finish();
        assert_eq!(sync.gate(true, 1, false, day + MIN_GAP_MS - 1), Gate::Skip);
        assert_eq!(
            sync.gate(true, 1, false, day + MIN_GAP_MS),
            Gate::CheckNetwork,
            "half an hour later"
        );
        assert_eq!(
            sync.gate(true, 1, true, day + 1),
            Gate::Go,
            "forced: the gap does not apply"
        );
    }

    #[test]
    fn nothing_to_sync_without_a_connected_client_or_a_kept_playlist() {
        let sync = KeptSync::default();
        assert_eq!(sync.gate(false, 1, true, NOW), Gate::Skip);
        assert_eq!(sync.gate(true, 0, true, NOW), Gate::Skip);
    }

    #[test]
    fn a_kept_playlist_deleted_on_the_server_is_not_kept_any_more() {
        let mut kept = KeptPlaylists::default();
        kept.set("gone", "Ancienne", true);
        kept.set("other", "Autre", true);
        assert!(
            !kept.forget_if_gone("gone", Some(0)),
            "another error: still kept"
        );
        assert!(!kept.forget_if_gone("gone", None));
        assert!(kept.forget_if_gone("gone", Some(70)));
        assert!(!kept.contains("gone"));
        assert_eq!(kept.len(), 1);
        assert_eq!(
            kept_failure_log("Ancienne", "Playlist not found"),
            "Playlist gardée « Ancienne » : Playlist not found"
        );
    }

    #[test]
    fn kept_playlists_come_back_from_what_was_saved_and_are_named_by_the_server_first() {
        let kept =
            KeptPlaylists::from_json(Some(&json!({ "p1": "Route", "p2": "Soir", "bad": 3 })));
        assert_eq!(
            kept.iter().collect::<Vec<_>>(),
            [("p1", "Route"), ("p2", "Soir")]
        );
        assert!(KeptPlaylists::from_json(Some(&json!("oops"))).is_empty());
        assert!(KeptPlaylists::from_json(None).is_empty());
        assert_eq!(kept_label(Some("Route 66"), "Route"), "Route 66");
        assert_eq!(kept_label(Some(""), "Route"), "Route");
        assert_eq!(kept_label(None, "Route"), "Route");
    }

    fn song(id: &str) -> SongInfo {
        SongInfo {
            id: id.into(),
            title: format!("Titre {id}"),
            artist: "A".into(),
            duration: 200.0,
            ..Default::default()
        }
    }

    #[test]
    fn a_song_is_downloaded_as_the_original_file_under_its_own_extension() {
        assert_eq!(track_filename("s1", Some("FLAC")), "s1.flac");
        let track = OfflineTrack::downloaded(&song("s1"), Some("FLAC"), Some(3000));
        assert_eq!(
            (track.filename.as_str(), track.size),
            ("s1.flac", Some(3000))
        );
        assert_eq!(OFFLINE_DIR, "offline-music");
        // No extension said, or a strange one: mp3, as before.
        assert_eq!(track_filename("s2", Some("../x")), "s2.mp3");
        assert_eq!(track_filename("s3", None), "s3.mp3");
        assert_eq!(file_extension(Some(" Ogg ")), "ogg");
        assert_eq!(file_extension(Some("")), "mp3");
        assert_eq!(file_extension(Some("abcdef")), "mp3", "six is too long");
        assert_eq!(file_extension(Some("abcde")), "abcde");
        assert_eq!(file_extension(Some("m4a\n")), "m4a");
        assert_eq!(file_extension(Some("é")), "mp3");
    }

    #[test]
    fn the_cover_of_a_track_is_the_songs_else_its_albums() {
        let mut s = song("a");
        s.album_id = Some("al".into());
        assert_eq!(
            OfflineTrack::downloaded(&s, None, None)
                .cover_art
                .as_deref(),
            Some("al")
        );
        s.cover_art = Some("".into());
        assert_eq!(
            OfflineTrack::downloaded(&s, None, None)
                .cover_art
                .as_deref(),
            Some("al")
        );
        s.cover_art = Some("co".into());
        assert_eq!(
            OfflineTrack::downloaded(&s, None, None)
                .cover_art
                .as_deref(),
            Some("co")
        );
    }

    #[test]
    fn a_song_twice_in_a_playlist_is_downloaded_once_and_what_is_there_is_not_fetched_again() {
        let mut library = OfflineLibrary::default();
        let options = DownloadOptions::default();
        let asked = ["a", "b", "a"];
        let wanted = library.wanted(&asked);
        assert_eq!(wanted, [0, 1]);
        assert_eq!(
            start_message(wanted.len(), asked.len(), &options).as_deref(),
            Some("Téléchargement de 2 titres…")
        );
        let mut batch = DownloadBatch::new(wanted.len());
        assert_eq!(batch.workers(), 2);
        while let Some(slot) = batch.next_slot() {
            let song = song(asked[wanted[slot]]);
            assert!(library.begin_fetch(&song.id));
            assert!(!library.begin_fetch(&song.id), "already coming");
            library.finish_fetch(OfflineTrack::downloaded(&song, None, Some(3000)));
            batch.record(None);
        }
        assert_eq!(batch.done(), 2);
        assert_eq!(
            batch.summary(&options).as_deref(),
            Some("2 titres téléchargés sur le téléphone")
        );
        assert!(!library.begin_fetch("a"), "on the phone: not fetched again");
        let again = library.wanted(&["a", "b"]);
        assert!(again.is_empty());
        assert_eq!(
            start_message(again.len(), 2, &options).as_deref(),
            Some("Déjà téléchargé sur le téléphone")
        );
        assert_eq!(
            start_message(0, 0, &options),
            None,
            "nothing asked: nothing said"
        );
    }

    #[test]
    fn a_quiet_download_a_kept_playlist_only_speaks_when_it_got_something_new() {
        let mut library = OfflineLibrary::default();
        library.tracks.insert(
            "a".into(),
            OfflineTrack {
                id: "a".into(),
                filename: "a.mp3".into(),
                ..Default::default()
            },
        );
        let options = DownloadOptions {
            quiet: true,
            label: Some("Route".into()),
        };
        assert_eq!(start_message(0, 1, &options), None);
        assert_eq!(
            start_message(2, 3, &options),
            None,
            "no start message either"
        );
        assert_eq!(
            DownloadBatch::new(0).summary(&options),
            None,
            "nothing new: nothing said"
        );
        let wanted = library.wanted(&["a", "b", "c"]);
        assert_eq!(wanted, [1, 2]);
        let mut batch = DownloadBatch::new(wanted.len());
        batch.record(None);
        batch.record(None);
        assert_eq!(
            batch.summary(&options).as_deref(),
            Some("2 nouveaux titres de « Route » sur le téléphone")
        );
        let mut one = DownloadBatch::new(2);
        one.record(None);
        one.record(Some("boom"));
        assert_eq!(
            one.summary(&options).as_deref(),
            Some("1 nouveau titre de « Route » sur le téléphone"),
            "failures go to the diagnostics, not the toast"
        );
        let unnamed = DownloadOptions {
            quiet: true,
            label: None,
        };
        assert_eq!(
            batch.summary(&unnamed).as_deref(),
            Some("2 nouveaux titres sur le téléphone")
        );
    }

    #[test]
    fn failures_are_counted_and_told_with_the_last_reason() {
        let options = DownloadOptions::default();
        let mut batch = DownloadBatch::new(3);
        batch.record(Some("réseau"));
        batch.record(None);
        assert_eq!(
            batch.summary(&options).as_deref(),
            Some("1 sur 3 n'a pas pu être téléchargé : réseau")
        );
        batch.record(Some("disque plein"));
        assert_eq!(
            batch.summary(&options).as_deref(),
            Some("2 sur 3 n'ont pas pu être téléchargés : disque plein")
        );
        assert_eq!(batch.done(), 1);
        assert_eq!(
            download_failed_toast("Titre a", "réseau"),
            "« Titre a » n’a pas pu être téléchargé : réseau"
        );
        assert_eq!(
            download_failed_log("Titre a", "HTTP 500"),
            "Téléchargement de « Titre a » impossible : HTTP 500"
        );
    }

    #[test]
    fn at_most_three_downloads_run_at_once_and_each_song_is_handed_out_once() {
        assert_eq!(DownloadBatch::new(10).workers(), 3);
        assert_eq!(DownloadBatch::new(1).workers(), 1);
        assert_eq!(DownloadBatch::new(0).workers(), 0);
        let mut batch = DownloadBatch::new(2);
        assert_eq!(
            [batch.next_slot(), batch.next_slot(), batch.next_slot()],
            [Some(0), Some(1), None]
        );
    }

    #[test]
    fn a_failed_download_keeps_its_reason_and_a_new_try_forgets_it() {
        let mut library = OfflineLibrary::default();
        assert!(library.begin_fetch("a"));
        let reason = library.fail_fetch("a", None);
        assert_eq!(reason, "Erreur de téléchargement");
        assert!(!library.downloading.contains_key("a"));
        assert_eq!(library.errors["a"], reason);
        assert_eq!(library.fail_fetch("a", Some("HTTP 404")), "HTTP 404");
        assert!(library.begin_fetch("a"), "a later try starts clean");
        assert!(!library.errors.contains_key("a"));
        assert!(library.downloading.contains_key("a"));
    }

    #[test]
    fn progress_is_published_five_times_a_second_at_most_and_always_at_the_end() {
        let mut throttle = ProgressThrottle::new(0);
        assert_eq!(throttle.update(100, 1000, 100), None);
        let tick = throttle.update(500, 1000, 250).unwrap();
        assert_eq!((tick.loaded, tick.total), (500, 1000));
        assert!(
            (tick.speed_bps - 2000.0).abs() < 1e-9,
            "500 bytes in 0.25 s"
        );
        assert_eq!(throttle.update(600, 1000, 300), None);
        let end = throttle.update(1000, 1000, 310).unwrap();
        assert!((end.speed_bps - 500.0 / 0.06).abs() < 1e-6);
        let instant = throttle.update(1000, 1000, 310).unwrap();
        assert_eq!(instant.speed_bps, 0.0, "no time passed: no speed");
    }

    #[test]
    fn the_room_the_downloads_take_their_recorded_size_or_the_file_measured_for_older_ones() {
        let mut library = OfflineLibrary::default();
        library.tracks.insert(
            "a".into(),
            OfflineTrack {
                id: "a".into(),
                filename: "a.flac".into(),
                size: Some(3000),
                ..Default::default()
            },
        );
        library.tracks.insert(
            "old".into(),
            OfflineTrack {
                id: "old".into(),
                filename: "old.mp3".into(),
                ..Default::default()
            },
        );
        library.tracks.insert(
            "lost".into(),
            OfflineTrack {
                id: "lost".into(),
                filename: "lost.mp3".into(),
                ..Default::default()
            },
        );
        let bytes = offline_bytes(library.tracks.values(), |name| {
            (name == "old.mp3").then_some(5000)
        });
        assert_eq!(bytes, 8000, "a file gone missing counts for nothing");
    }

    #[test]
    fn the_manifest_round_trips_and_older_entries_without_a_size_still_load() {
        let saved = json!({
            "a": { "id": "a", "title": "A", "artist": "X", "album": "Al", "coverArt": "c", "duration": 12.5, "filename": "a.flac", "size": 3000 },
            "old": { "id": "old", "filename": "old.mp3" },
            "junk": { "title": "no id" },
            "text": "nope"
        });
        let library = OfflineLibrary::from_saved(Some(&saved), Some(&json!({ "p1": "Route" })));
        assert_eq!(library.tracks.len(), 2);
        assert_eq!(library.tracks["a"].size, Some(3000));
        assert_eq!(library.tracks["old"].size, None);
        assert_eq!(library.tracks["old"].title, "");
        assert_eq!(library.kept.len(), 1);
        let again = OfflineLibrary::from_saved(Some(&library.tracks_json()), None);
        assert_eq!(again.tracks, library.tracks);
        assert_eq!(
            library.tracks_json()["old"],
            json!({ "id": "old", "title": "", "artist": "", "duration": 0.0, "filename": "old.mp3" })
        );
        assert!(OfflineLibrary::from_saved(None, None).tracks.is_empty());
        assert_eq!(OFFLINE_TRACKS_KEY, "navidrome.offlineTracks");
        assert_eq!(KEPT_PLAYLISTS_KEY, "navidrome.keptPlaylists");
    }

    #[test]
    fn removing_a_song_gives_its_file_to_delete() {
        let mut library = OfflineLibrary::default();
        library.finish_fetch(OfflineTrack::downloaded(&song("a"), Some("mp3"), None));
        assert_eq!(library.remove("a").unwrap().filename, "a.mp3");
        assert!(library.remove("a").is_none());
        assert!(!library.is_offline("a"));
    }

    #[test]
    fn counts_in_french_take_the_singular_for_zero_and_one_and_group_thousands() {
        assert_eq!(plural(0, "titre", "titres"), "0 titre");
        assert_eq!(plural(1, "titre", "titres"), "1 titre");
        assert_eq!(plural(12, "titre", "titres"), "12 titres");
        assert_eq!(plural(1234, "titre", "titres"), "1\u{202f}234 titres");
        assert_eq!(
            plural(1_000_000, "titre", "titres"),
            "1\u{202f}000\u{202f}000 titres"
        );
    }

    fn file(name: &str, at: i64) -> DownloadedFile {
        DownloadedFile {
            filename: name.into(),
            source_path: format!("/files/{name}"),
            size_bytes: 10,
            downloaded_at: at,
        }
    }

    #[test]
    fn downloaded_files_are_listed_newest_first_and_deduplicated_by_name() {
        let mut files = DownloadedFiles::default();
        files.record(file("a.pdf", 1));
        files.record(file("b.pdf", 2));
        files.record(file("a.pdf", 3));
        let names: Vec<_> = files.files.iter().map(|f| f.filename.as_str()).collect();
        assert_eq!(names, ["a.pdf", "b.pdf"]);
        assert_eq!(files.files[0].downloaded_at, 3);
        files.remove("b.pdf");
        assert_eq!(files.files.len(), 1);
        files.clear();
        assert!(files.files.is_empty());
    }

    #[test]
    fn the_disk_is_trusted_over_the_downloads_manifest() {
        let mut files = DownloadedFiles::default();
        files.record(file("a.pdf", 1));
        files.record(file("gone.pdf", 2));
        assert!(!files.retain_present(|_| true));
        assert!(files.retain_present(|name| name == "a.pdf"));
        assert_eq!(files.files.len(), 1);
        assert_eq!(DOWNLOADS_MANIFEST_KEY, "filebrowser.downloads");
    }
}
