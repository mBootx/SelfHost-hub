//! The covers kept on the phone, and the covers found elsewhere: which cover an address stands for, what its file is
//! called, which stored covers go when the store is full or emptied, and how the whole library's covers are listed.
//! Also the MusicBrainz / Cover Art Archive lookup for songs the server has no cover for.
//!
//! Port of the pure parts of `mobile/src/services/coverStore.ts` and `mobile/src/services/artwork.ts`. Everything
//! that touches the file system, the network or the clock is left to the caller: the rules take the list of stored
//! entries (or file names) as input and answer with what to keep, delete or ask for.
//!
//! Covers are known by what the Subsonic client's `cover_art_url` puts in the address: the cover's id and its size
//! bucket ([`size_bucket`]), written `"<id>@<size>"`. The file names are the same on disk as the Expo phone app
//! writes today, so the Rust phone app finds the covers already stored when it replaces the old one.

use std::collections::{HashMap, HashSet};

/// Past this many bytes in the store, the covers not seen for longest go first (never a downloaded song's).
pub const MAX_BYTES: u64 = 300 * 1024 * 1024;
/// When the store is over [`MAX_BYTES`], covers go until it is down to this: 90 %, so one download does not set off
/// a clean-up again at once.
pub const EVICT_TARGET_BYTES: u64 = MAX_BYTES / 10 * 9;
/// Downloads at once: enough to fill a screen of covers quickly, few enough not to choke a slow connection.
pub const CONCURRENCY: usize = 4;
/// Where the phone saves when each cover was last shown (a preference, key to ms).
pub const INDEX_PREF: &str = "covers.index";
/// The saved "last shown" time is only moved forward when it is older than this: enough for the eviction order,
/// without a save at every render.
pub const TOUCH_AFTER_MS: i64 = 60_000;
/// How long the "last shown" times wait before being saved to the preference.
pub const SAVE_DELAY_MS: u64 = 5_000;
/// The covers worth keeping for a song on the phone: the sizes the lists, the mini player and the player show.
pub const SONG_COVER_SIZES: [u32; 3] = [160, 320, 640];
/// Albums asked of the server per page when the whole library's covers are saved.
pub const LIBRARY_PAGE: usize = 500;

/// The size bucket a cover of `size` pixels is asked at: every size maps to 160, 320 or 640, so a cover is
/// downloaded and stored at most three times.
///
/// This is the rule of `hub-net`'s `cover_art_url`; that crate depends on this one, so the rule lives here and the
/// client should call it instead of keeping its own `match`.
pub fn size_bucket(size: u32) -> u32 {
    match size {
        0..=160 => 160,
        161..=320 => 320,
        _ => 640,
    }
}

// --- Keys and file names ---

/// The key of a stored cover: `"<id>@<size>"`.
pub fn cover_key_of(id: &str, size: u32) -> String {
    format!("{id}@{size}")
}

/// The first value of `name` in the query of `url` (after a `?` or `&`), cut by `take`, skipping a parameter whose
/// value comes out empty. Like the regex `[?&]name=(value)` it replaces, it looks at every `?` and `&`.
fn query_value<'a>(url: &'a str, name: &str, take: fn(&str) -> &str) -> Option<&'a str> {
    for (i, c) in url.char_indices() {
        if c != '?' && c != '&' {
            continue;
        }
        let Some(value) = url[i + 1..]
            .strip_prefix(name)
            .and_then(|rest| rest.strip_prefix('='))
        else {
            continue;
        };
        let value = take(value);
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn until_amp_or_hash(value: &str) -> &str {
    value.split(['&', '#']).next().unwrap_or("")
}

fn leading_digits(value: &str) -> &str {
    let end = value
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(value.len());
    &value[..end]
}

fn hex_value(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|d| u8::try_from(d).ok())
}

/// `decodeURIComponent`. The JavaScript version throws on a broken escape or bytes that are not UTF-8; here that is
/// `None`.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let high = hex_value(*bytes.get(i + 1)?)?;
            let low = hex_value(*bytes.get(i + 2)?)?;
            out.push(high * 16 + low);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The key of a cover address built by the Subsonic client's `cover_art_url` (`"<id>@<size>"`), or `None` for
/// anything else: an address that is not `getCoverArt`, or has no id or no size, or an id that is not valid
/// percent-encoding (the phone's JavaScript threw on that one).
pub fn cover_key(url: &str) -> Option<String> {
    if url.is_empty() || !url.contains("/rest/getCoverArt") {
        return None;
    }
    let id = query_value(url, "id", until_amp_or_hash)?;
    let size = query_value(url, "size", leading_digits)?;
    Some(format!("{}@{size}", decode_uri_component(id)?))
}

/// Splits a key at its last `@` into the cover's id and the size. Keys made by [`cover_key`] always have one; for
/// one that has none, the whole key is the id (the phone's `slice` cut its last character, which nothing relied on).
fn split_key(key: &str) -> (&str, &str) {
    match key.rfind('@') {
        Some(at) => (&key[..at], &key[at + 1..]),
        None => (key, ""),
    }
}

/// The cover's id inside a key (what the downloaded-songs rule is asked about).
pub fn cover_id_of(key: &str) -> &str {
    split_key(key).0
}

/// A file name for a key that is safe anywhere: anything but letters, digits, `-` and `_` in the id is written as
/// its code, `~<hex>~`. A character outside the Basic Multilingual Plane is written as its two UTF-16 halves, as the
/// phone's JavaScript does, so a file the old app saved keeps its name.
pub fn file_name_for(key: &str) -> String {
    let (id, size) = split_key(key);
    let mut name = String::with_capacity(id.len() + size.len() + 5);
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            name.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                name.push_str(&format!("~{unit:x}~"));
            }
        }
    }
    name.push('@');
    name.push_str(size);
    name.push_str(".jpg");
    name
}

/// The name a cover is downloaded under before it is complete: renamed when whole, so a download cut half way
/// leaves no broken cover.
pub fn part_file_name(file_name: &str) -> String {
    format!("{file_name}.part")
}

/// Undoes the `~<hex>~` escapes of [`file_name_for`]. Each escape is one UTF-16 unit (the low 16 bits of its value);
/// halves that pair up become one character, a lone half becomes U+FFFD.
fn unescape_id(text: &str) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if c == '~' {
            let digits = rest[1..]
                .bytes()
                .take_while(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                .count();
            if digits > 0 && rest[1 + digits..].starts_with('~') {
                let hex = &rest[1..=digits];
                let tail = &hex[hex.len().saturating_sub(4)..];
                units.push(u16::from_str_radix(tail, 16).unwrap_or(0));
                rest = &rest[digits + 2..];
                continue;
            }
        }
        let mut buf = [0u16; 2];
        units.extend_from_slice(c.encode_utf16(&mut buf));
        rest = &rest[c.len_utf8()..];
    }
    char::decode_utf16(units)
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// The key of a file in the covers folder (`<escaped id>@<size>.jpg`), or `None` for any other file.
pub fn key_of_file(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".jpg")?;
    let at = stem.rfind('@')?;
    let (id, size) = (&stem[..at], &stem[at + 1..]);
    if size.is_empty() || !size.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // `.` in the phone's pattern does not match a line break.
    if id.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(format!("{}@{size}", unescape_id(id)))
}

// --- The store ---

/// A cover on the phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverEntry {
    pub key: String,
    pub bytes: u64,
    /// When the cover was last shown (ms), for the eviction order.
    pub used_at: i64,
}

/// What the covers folder holds once read, and what in it is to be deleted.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LoadedStore {
    /// In the order of the folder.
    pub entries: Vec<CoverEntry>,
    /// File names of downloads that never finished (`*.part`).
    pub unfinished: Vec<String>,
}

/// Reads the covers folder: `files` is each file's name and size, `used` the saved "last shown" times (a cover
/// missing from it counts as never shown, 0). Files that are not covers are left alone, except `.part` ones, which
/// are listed to delete.
pub fn load_store(files: &[(String, u64)], used: &HashMap<String, i64>) -> LoadedStore {
    let mut loaded = LoadedStore::default();
    for (name, bytes) in files {
        match key_of_file(name) {
            Some(key) => {
                let entry = CoverEntry {
                    used_at: used.get(&key).copied().unwrap_or(0),
                    bytes: *bytes,
                    key,
                };
                // Two files for one key: the later one replaces the earlier, which keeps its place.
                match loaded.entries.iter_mut().find(|e| e.key == entry.key) {
                    Some(existing) => *existing = entry,
                    None => loaded.entries.push(entry),
                }
            }
            None if name.ends_with(".part") => loaded.unfinished.push(name.clone()),
            None => {}
        }
    }
    loaded
}

/// Whether a cover shown at `now` is worth saving a new "last shown" time for.
pub fn should_touch(now: i64, used_at: i64) -> bool {
    now - used_at > TOUCH_AFTER_MS
}

/// A downloaded cover with no bytes is no cover.
pub fn is_usable_download(bytes: u64) -> bool {
    bytes > 0
}

/// The total size of the stored covers.
pub fn total_bytes(entries: &[CoverEntry]) -> u64 {
    entries.iter().map(|e| e.bytes).sum()
}

/// The covers to delete, in this order, when the store is over [`MAX_BYTES`]: those not shown for longest first
/// (ties in the order of `entries`), never a downloaded song's (`is_pinned` is asked with the cover's id), until the
/// store is down to [`EVICT_TARGET_BYTES`] or only pinned covers are left. Empty when the store is not over the
/// limit. Pinned covers count in the total.
pub fn eviction_plan(entries: &[CoverEntry], is_pinned: impl Fn(&str) -> bool) -> Vec<String> {
    let mut total = total_bytes(entries);
    if total <= MAX_BYTES {
        return Vec::new();
    }
    let mut oldest_first: Vec<&CoverEntry> = entries
        .iter()
        .filter(|e| !is_pinned(cover_id_of(&e.key)))
        .collect();
    // Stable, like the phone's sort: equal times keep the order of the store.
    oldest_first.sort_by_key(|e| e.used_at);
    let mut plan = Vec::new();
    for entry in oldest_first {
        if total <= EVICT_TARGET_BYTES {
            break;
        }
        plan.push(entry.key.clone());
        total -= entry.bytes;
    }
    plan
}

/// The covers to delete to empty the store: all but those of downloaded songs.
pub fn clear_plan(entries: &[CoverEntry], is_pinned: impl Fn(&str) -> bool) -> Vec<String> {
    entries
        .iter()
        .filter(|e| !is_pinned(cover_id_of(&e.key)))
        .map(|e| e.key.clone())
        .collect()
}

// --- The whole library ---

/// How far saving the whole library's covers got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LibraryProgress {
    pub done: usize,
    /// `None` until the last page of albums has been read.
    pub total: Option<usize>,
    pub failed: usize,
}

impl LibraryProgress {
    /// Every page is read: `total` covers to save.
    pub fn start(total: usize) -> Self {
        Self {
            done: 0,
            total: Some(total),
            failed: 0,
        }
    }

    /// One cover is done; `ok` is whether it is on the phone now.
    pub fn record(&mut self, ok: bool) {
        self.done += 1;
        if !ok {
            self.failed += 1;
        }
    }
}

/// The cover of an album: its own, or its id when the server gives it none (an empty one counts as none).
pub fn album_cover_id(cover_art: Option<&str>, album_id: &str) -> String {
    cover_art
        .filter(|c| !c.is_empty())
        .unwrap_or(album_id)
        .to_owned()
}

/// Whether to ask for another page of albums: the last page is a short one, and a stop request ends it early.
pub fn has_more_library_pages(page_len: usize, stop_requested: bool) -> bool {
    page_len >= LIBRARY_PAGE && !stop_requested
}

/// Each cover once, in the order first met: albums sharing a cover cost one download.
pub fn unique_cover_ids(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

// --- Artwork for songs the server has no cover for ---

const MUSICBRAINZ: &str = "https://musicbrainz.org/ws/2";
const COVER_ART_ARCHIVE: &str = "https://coverartarchive.org";
/// MusicBrainz asks for a descriptive User-Agent.
pub const ARTWORK_USER_AGENT: &str = "SelfHostHub/1.0.0 (self-hosted music client)";
/// The preference the local artwork overrides are saved in (song or album id to cover address).
pub const OVERRIDES_KEY: &str = "artwork.overrides";
/// How long the Cover Art Archive gets to say whether a release group has a front cover.
pub const FRONT_COVER_PROBE_TIMEOUT_MS: u64 = 8_000;

/// Escapes what Lucene reads as syntax: `+ - ! ( ) { } [ ] ^ " ~ * ? : \ /`, and `&&` and `||`.
pub fn escape_lucene(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        let pair = matches!((c, chars.peek()), ('&', Some('&')) | ('|', Some('|')));
        if "\"\\+-!(){}[]^~*?:/".contains(c) {
            out.push('\\');
            out.push(c);
        } else if pair {
            out.push('\\');
            out.push(c);
            out.push(c);
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

/// `application/x-www-form-urlencoded`, as `URLSearchParams` writes it: a space is `+`, letters, digits and `*-._`
/// stay, every other byte is `%XX`.
fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b' ' => out.push('+'),
            b'*' | b'-' | b'.' | b'_' => out.push(char::from(b)),
            _ if b.is_ascii_alphanumeric() => out.push(char::from(b)),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The MusicBrainz search for an album's release group, up to three matches. `None` without an artist or an album:
/// there is nothing to search for (a saved override is looked up first, see [`artwork_override`]).
pub fn release_group_search_url(artist: &str, album: &str) -> Option<String> {
    if artist.is_empty() || album.is_empty() {
        return None;
    }
    let query = format!(
        "artist:\"{}\" AND releasegroup:\"{}\"",
        escape_lucene(artist),
        escape_lucene(album)
    );
    Some(format!(
        "{MUSICBRAINZ}/release-group/?query={}&fmt=json&limit=3",
        form_encode(&query)
    ))
}

/// The release group ids of a MusicBrainz search reply, best match first. A reply that is not the expected JSON
/// gives none, as a failed request does.
pub fn release_group_ids(body: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    json.get("release-groups")
        .and_then(|groups| groups.as_array())
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| g.get("id").and_then(|id| id.as_str()).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Where the Cover Art Archive serves a release group's front cover, 500 pixels wide. The archive answers 404 for
/// plenty of valid release groups, so the caller walks the matches until a `HEAD` of one succeeds.
pub fn front_cover_url(release_group_id: &str) -> String {
    format!("{COVER_ART_ARCHIVE}/release-group/{release_group_id}/front-500")
}

/// The saved override for `key` (a song or album id), if there is one; an empty address counts as none.
pub fn artwork_override<'a>(overrides: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    overrides
        .get(key)
        .map(String::as_str)
        .filter(|url| !url.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1024 * 1024;

    /// `encodeURIComponent`.
    fn encode_uri_component(value: &str) -> String {
        let mut out = String::new();
        for b in value.bytes() {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                out.push(char::from(b));
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    }

    /// An address as the Subsonic client writes it.
    fn url(id: &str, size: u32) -> String {
        format!(
            "https://music.example/rest/getCoverArt?u=me&t=abc&s=salt&v=1.16.1&c=x&f=json&id={}&size={size}",
            encode_uri_component(id)
        )
    }

    fn entry(key: &str, bytes: u64, used_at: i64) -> CoverEntry {
        CoverEntry {
            key: key.into(),
            bytes,
            used_at,
        }
    }

    // --- Keys ---

    #[test]
    fn a_cover_address_gives_its_id_and_size_anything_else_gives_nothing() {
        assert_eq!(
            cover_key(&url("al-123", 640)).as_deref(),
            Some("al-123@640")
        );
        assert_eq!(cover_key(&url("a b/c", 160)).as_deref(), Some("a b/c@160"));
        assert_eq!(cover_key("https://music.example/rest/stream?id=1"), None);
        // An id and a size do not make a cover.
        assert_eq!(
            cover_key("https://music.example/rest/stream?id=1&size=320"),
            None
        );
        assert_eq!(cover_key("file:///doc/covers/x@320.jpg"), None);
        assert_eq!(cover_key(""), None);
    }

    #[test]
    fn an_address_missing_its_id_or_size_or_with_a_broken_escape_gives_nothing() {
        let base = "https://music.example/rest/getCoverArt?u=me";
        assert_eq!(cover_key(&format!("{base}&size=320")), None);
        assert_eq!(cover_key(&format!("{base}&id=al-1")), None);
        assert_eq!(cover_key(&format!("{base}&id=&size=320")), None);
        assert_eq!(cover_key(&format!("{base}&id=a%zz&size=320")), None);
        assert_eq!(cover_key(&format!("{base}&id=a%&size=320")), None);
        // Not a parameter of its own: "uid" is not "id".
        assert_eq!(cover_key(&format!("{base}&uid=al-1&size=320")), None);
        // The first non-empty value wins, a fragment is not part of it.
        assert_eq!(
            cover_key(&format!("{base}&id=&id=al-2&size=320&size=640#id=x")).as_deref(),
            Some("al-2@320")
        );
        assert_eq!(
            cover_key(&format!("{base}&id=al-3#frag&size=160")).as_deref(),
            Some("al-3@160")
        );
    }

    #[test]
    fn file_names_are_safe_whatever_the_id() {
        assert_eq!(file_name_for("al-123_x@320"), "al-123_x@320.jpg");
        let name = file_name_for("a b/c:d@160");
        assert!(
            name.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_~@.-".contains(&b)),
            "{name}"
        );
        assert_eq!(name, "a~20~b~2f~c~3a~d@160.jpg");
    }

    #[test]
    fn a_file_name_gives_its_key_back_odd_ids_and_astral_characters_included() {
        for key in [
            "al-1@320",
            "a b/c:d@640",
            "~x~@160",
            "café@160",
            "😀 x@320",
            "a@b@160",
        ] {
            assert_eq!(
                key_of_file(&file_name_for(key)).as_deref(),
                Some(key),
                "{key}"
            );
        }
        // Written like the phone's JavaScript: one escape per UTF-16 half.
        assert_eq!(file_name_for("😀@320"), "~d83d~~de00~@320.jpg");
        assert_eq!(key_of_file("a~20~b@160.jpg").as_deref(), Some("a b@160"));
        assert_eq!(key_of_file("~@160.jpg").as_deref(), Some("~@160"));
        assert_eq!(key_of_file("~zz~@160.jpg").as_deref(), Some("~zz~@160"));
        assert_eq!(key_of_file("@160.jpg").as_deref(), Some("@160"));
    }

    #[test]
    fn files_that_are_not_covers_have_no_key() {
        assert_eq!(key_of_file("al-9@320.jpg.part"), None);
        assert_eq!(key_of_file("al-9@320.png"), None);
        assert_eq!(key_of_file("al-9@.jpg"), None);
        assert_eq!(key_of_file("al-9@big.jpg"), None);
        assert_eq!(key_of_file("al-9.jpg"), None);
        assert_eq!(key_of_file("a\nb@320.jpg"), None);
    }

    #[test]
    fn each_size_is_its_own_cover() {
        assert_ne!(cover_key(&url("al-1", 160)), cover_key(&url("al-1", 640)));
        assert_ne!(file_name_for("al-1@160"), file_name_for("al-1@640"));
        assert_eq!(cover_key_of("al-1", 160), "al-1@160");
        assert_eq!(cover_id_of("a@b@160"), "a@b");
    }

    #[test]
    fn something_that_is_not_a_cover_address_is_not_downloaded() {
        // The store downloads only what has a key.
        assert_eq!(cover_key("https://elsewhere.example/picture.png"), None);
    }

    #[test]
    fn every_size_asked_for_falls_in_one_of_three_buckets() {
        let buckets: Vec<u32> = [0, 100, 160, 161, 300, 320, 321, 640, 1000]
            .map(size_bucket)
            .into();
        assert_eq!(buckets, [160, 160, 160, 320, 320, 320, 640, 640, 640]);
    }

    // --- Saving ---

    #[test]
    fn a_downloaded_cover_with_no_bytes_is_not_kept() {
        assert!(!is_usable_download(0));
        assert!(is_usable_download(2000));
    }

    #[test]
    fn a_cover_is_shown_from_the_phone_and_its_time_moved_at_most_once_a_minute() {
        assert!(!should_touch(1_060_000, 1_000_000));
        assert!(should_touch(1_060_001, 1_000_000));
        // Never shown (0): moved at once.
        assert!(should_touch(1_000_000, 0));
        assert_eq!(part_file_name("al-1@320.jpg"), "al-1@320.jpg.part");
        assert_eq!(CONCURRENCY, 4);
    }

    // --- Restart ---

    #[test]
    fn after_a_restart_the_covers_are_found_on_the_phone_odd_ids_included_and_half_downloads_are_cleaned_up()
     {
        let files = vec![
            (file_name_for("al-1@320"), 2000),
            (file_name_for("a b/c:d@640"), 3000),
            ("al-9@320.jpg.part".to_owned(), 4),
            ("notes.txt".to_owned(), 10),
        ];
        let used = HashMap::from([("al-1@320".to_owned(), 5_000), ("zzz@1".to_owned(), 9)]);
        let loaded = load_store(&files, &used);
        assert_eq!(
            loaded.entries,
            [
                entry("al-1@320", 2000, 5_000),
                entry("a b/c:d@640", 3000, 0)
            ]
        );
        assert_eq!(loaded.unfinished, ["al-9@320.jpg.part"]);
        assert_eq!(total_bytes(&loaded.entries), 5000);
    }

    #[test]
    fn two_files_for_one_cover_leave_one_entry_in_the_first_place() {
        let files = vec![
            ("a~41~@1.jpg".to_owned(), 1),
            ("b@1.jpg".to_owned(), 2),
            ("aA@1.jpg".to_owned(), 3),
            ("aA@1.jpg".to_owned(), 4),
        ];
        let loaded = load_store(&files, &HashMap::new());
        assert_eq!(loaded.entries, [entry("aA@1", 4, 0), entry("b@1", 2, 0)]);
    }

    // --- The limit ---

    #[test]
    fn past_the_limit_the_covers_not_seen_for_longest_go_never_a_downloaded_songs() {
        // The phone's run: four covers of 80 MB; "al-old" is shown again after "al-seen" was saved.
        let pinned = |id: &str| id == "al-pinned";
        let entries = [
            entry("al-pinned@320", 80 * MB, 1_000_000),
            entry("al-old@320", 80 * MB, 1_360_000),
            entry("al-seen@320", 80 * MB, 1_240_000),
            entry("al-new@320", 80 * MB, 1_480_000),
        ];
        // 320 MB > 300 MB: down to 270 MB at most (one cover goes), the least seen first, the pinned one kept
        // whatever its age.
        assert_eq!(eviction_plan(&entries, pinned), ["al-seen@320"]);
        let kept: u64 = total_bytes(&entries) - 80 * MB;
        assert!(kept <= MAX_BYTES);
    }

    #[test]
    fn under_the_limit_nothing_goes_and_at_the_limit_nothing_goes_either() {
        let entries = [
            entry("a@1", MAX_BYTES / 2, 1),
            entry("b@1", MAX_BYTES / 2, 2),
        ];
        assert_eq!(total_bytes(&entries), MAX_BYTES);
        assert!(eviction_plan(&entries, |_| false).is_empty());
    }

    #[test]
    fn covers_go_oldest_first_down_to_ninety_percent_and_pinned_ones_may_keep_it_over() {
        assert_eq!(EVICT_TARGET_BYTES, 283_115_520);
        let entries = [
            entry("c@1", 100 * MB, 30),
            entry("a@1", 100 * MB, 10),
            entry("p@1", 100 * MB, 0),
            entry("b@1", 100 * MB, 20),
        ];
        // 400 MB: two unpinned go (200 MB left, under 270 MB), a third is not needed.
        assert_eq!(eviction_plan(&entries, |id| id == "p"), ["a@1", "b@1"]);
        // Everything pinned: nothing can go.
        assert!(eviction_plan(&entries, |_| true).is_empty());
        // Equal times keep the store's order.
        let same = [entry("x@1", 200 * MB, 5), entry("y@1", 200 * MB, 5)];
        assert_eq!(eviction_plan(&same, |_| false), ["x@1"]);
    }

    #[test]
    fn emptying_the_store_keeps_the_covers_of_downloaded_songs() {
        let entries = [entry("al-kept@320", 1, 0), entry("al-gone@320", 1, 0)];
        assert_eq!(clear_plan(&entries, |id| id == "al-kept"), ["al-gone@320"]);
        assert_eq!(clear_plan(&entries, |_| false).len(), 2);
    }

    // --- The whole library ---

    #[test]
    fn saving_the_whole_library_reads_every_page_each_cover_once_and_says_how_far_it_got() {
        let mut albums: Vec<(String, Option<String>)> = (0..1203)
            .map(|i| (format!("al-{i}"), (i % 2 == 1).then(|| format!("al-{i}"))))
            .collect();
        albums.push(("dup".into(), Some("al-1".into())));
        let mut pages = Vec::new();
        let mut ids = Vec::new();
        let mut offset = 0;
        loop {
            pages.push(offset);
            let page = &albums[offset.min(albums.len())..(offset + LIBRARY_PAGE).min(albums.len())];
            ids.extend(
                page.iter()
                    .map(|(id, cover)| album_cover_id(cover.as_deref(), id)),
            );
            if !has_more_library_pages(page.len(), false) {
                break;
            }
            offset += LIBRARY_PAGE;
        }
        assert_eq!(pages, [0, 500, 1000]);
        let unique = unique_cover_ids(ids);
        assert_eq!(unique.len(), 1203);
        assert_eq!(unique[0], "al-0");
        let mut progress = LibraryProgress::start(unique.len());
        assert_eq!(progress.total, Some(1203));
        for i in 0..unique.len() {
            progress.record(i != 7);
        }
        assert_eq!(progress.done, 1203);
        assert_eq!(progress.failed, 1);
    }

    #[test]
    fn a_stop_request_ends_the_pages_and_an_empty_cover_falls_back_to_the_album() {
        assert!(has_more_library_pages(500, false));
        assert!(!has_more_library_pages(499, false));
        assert!(!has_more_library_pages(500, true));
        assert_eq!(album_cover_id(Some(""), "al-1"), "al-1");
        assert_eq!(album_cover_id(None, "al-1"), "al-1");
        assert_eq!(album_cover_id(Some("mf-9"), "al-1"), "mf-9");
        assert_eq!(
            unique_cover_ids(["b", "a", "b", "c", "a"].map(String::from)),
            ["b", "a", "c"]
        );
        assert_eq!(LibraryProgress::default().total, None);
    }

    // --- Downloaded songs ---

    #[test]
    fn a_downloaded_song_brings_its_covers_at_every_size_the_app_shows() {
        assert_eq!(SONG_COVER_SIZES, [160, 320, 640]);
        for size in SONG_COVER_SIZES {
            assert_eq!(size_bucket(size), size);
        }
    }

    // --- Artwork ---

    #[test]
    fn lucene_syntax_in_a_name_is_escaped() {
        assert_eq!(escape_lucene("AC/DC"), "AC\\/DC");
        assert_eq!(
            escape_lucene("a && b || c & d | e"),
            "a \\&& b \\|| c & d | e"
        );
        assert_eq!(
            escape_lucene("\"(x)\" [y]: {z}^~*?\\+-!"),
            "\\\"\\(x\\)\\\" \\[y\\]\\: \\{z\\}\\^\\~\\*\\?\\\\\\+\\-\\!"
        );
        assert_eq!(escape_lucene("a&&&b"), "a\\&&&b");
        assert_eq!(escape_lucene("plain é"), "plain é");
    }

    #[test]
    fn the_release_group_search_is_written_like_url_search_params() {
        assert_eq!(
            release_group_search_url("AC/DC", "Back in Black").as_deref(),
            Some(
                "https://musicbrainz.org/ws/2/release-group/?query=artist%3A%22AC%5C%2FDC%22+AND+releasegroup%3A%22Back+in+Black%22&fmt=json&limit=3"
            )
        );
        assert_eq!(release_group_search_url("", "x"), None);
        assert_eq!(release_group_search_url("x", ""), None);
        assert!(
            release_group_search_url("Beyoncé", "x")
                .unwrap()
                .contains("Beyonc%C3%A9")
        );
    }

    #[test]
    fn matches_are_read_best_first_and_a_bad_reply_has_none() {
        let body = r#"{"release-groups":[{"id":"g1"},{"id":"g2","score":90},{"nope":1}]}"#;
        assert_eq!(release_group_ids(body), ["g1", "g2"]);
        assert!(release_group_ids("{}").is_empty());
        assert!(release_group_ids("not json").is_empty());
        assert_eq!(
            front_cover_url("g1"),
            "https://coverartarchive.org/release-group/g1/front-500"
        );
    }

    #[test]
    fn a_saved_override_wins_unless_it_is_empty() {
        let overrides = HashMap::from([
            ("s1".to_owned(), "https://x/y".to_owned()),
            ("s2".to_owned(), String::new()),
        ]);
        assert_eq!(artwork_override(&overrides, "s1"), Some("https://x/y"));
        assert_eq!(artwork_override(&overrides, "s2"), None);
        assert_eq!(artwork_override(&overrides, "s3"), None);
    }
}
