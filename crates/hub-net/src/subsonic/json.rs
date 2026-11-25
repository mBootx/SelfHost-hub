//! Reading Subsonic JSON: tolerant of missing fields, and of the single object that some servers send instead of
//! an array of one. Follows the Gson readers of the Kotlin client.

use serde_json::{Map, Value};

use super::models::{ApiAlbum, ApiArtist, ApiGenre, ApiPlaylist, ApiSong, ReplayGain, ScanStatus};

pub(crate) type Obj = Map<String, Value>;

pub(crate) fn object<'a>(parent: Option<&'a Obj>, name: &str) -> Option<&'a Obj> {
    parent?.get(name)?.as_object()
}

/// The objects under `name`: an array's objects, or a single object as a list of one.
pub(crate) fn children<'a>(parent: Option<&'a Obj>, name: &str) -> Vec<&'a Obj> {
    match parent.and_then(|p| p.get(name)) {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        Some(Value::Object(one)) => vec![one],
        _ => Vec::new(),
    }
}

/// A string, or a number or boolean in text form; `None` when missing or empty.
pub(crate) fn string(obj: &Obj, name: &str) -> Option<String> {
    let text = match obj.get(name)? {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

pub(crate) fn number(obj: &Obj, name: &str) -> Option<f64> {
    match obj.get(name)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|v: &f64| !v.is_nan())
}

/// A number truncated to an `i32`, saturating like Kotlin's `Double.toInt()`.
pub(crate) fn int(obj: &Obj, name: &str) -> Option<i32> {
    number(obj, name).map(|v| v as i32)
}

pub(crate) fn long(obj: &Obj, name: &str) -> Option<i64> {
    number(obj, name).map(|v| v as i64)
}

pub(crate) fn artist(obj: &Obj) -> Option<ApiArtist> {
    Some(ApiArtist {
        id: string(obj, "id")?,
        name: string(obj, "name").unwrap_or_else(|| "?".into()),
        album_count: int(obj, "albumCount").unwrap_or(0),
        cover_art: string(obj, "coverArt"),
    })
}

pub(crate) fn album(obj: &Obj) -> Option<ApiAlbum> {
    Some(ApiAlbum {
        id: string(obj, "id")?,
        name: string(obj, "name")
            .or_else(|| string(obj, "title"))
            .unwrap_or_else(|| "?".into()),
        artist: string(obj, "artist").unwrap_or_default(),
        artist_id: string(obj, "artistId"),
        cover_art: string(obj, "coverArt"),
        song_count: int(obj, "songCount").unwrap_or(0),
        duration: int(obj, "duration").unwrap_or(0),
        year: int(obj, "year").filter(|y| *y > 0),
        created: string(obj, "created"),
    })
}

pub(crate) fn song(obj: &Obj) -> Option<ApiSong> {
    Some(ApiSong {
        id: string(obj, "id")?,
        title: string(obj, "title").unwrap_or_else(|| "?".into()),
        artist: string(obj, "artist").unwrap_or_default(),
        artist_id: string(obj, "artistId"),
        album: string(obj, "album"),
        album_id: string(obj, "albumId"),
        cover_art: string(obj, "coverArt"),
        duration: int(obj, "duration").unwrap_or(0),
        track: int(obj, "track").filter(|t| *t > 0),
        starred: string(obj, "starred"),
        genre: string(obj, "genre"),
        replay_gain: obj.get("replayGain").and_then(Value::as_object).map(|g| {
            let gain = |k: &str| number(g, k);
            ReplayGain {
                track_gain: gain("trackGain"),
                album_gain: gain("albumGain"),
                track_peak: gain("trackPeak"),
                album_peak: gain("albumPeak"),
                fallback_gain: gain("fallbackGain"),
            }
        }),
        suffix: string(obj, "suffix"),
    })
}

pub(crate) fn playlist(obj: &Obj) -> Option<ApiPlaylist> {
    Some(ApiPlaylist {
        id: string(obj, "id")?,
        name: string(obj, "name").unwrap_or_else(|| "?".into()),
        song_count: int(obj, "songCount").unwrap_or(0),
        duration: int(obj, "duration").unwrap_or(0),
        changed: string(obj, "changed"),
        cover_art: string(obj, "coverArt"),
        owner: string(obj, "owner"),
        public: obj.get("public").and_then(Value::as_bool).unwrap_or(false),
    })
}

pub(crate) fn genre(obj: &Obj) -> Option<ApiGenre> {
    let name = string(obj, "value").filter(|v| !v.trim().is_empty())?;
    Some(ApiGenre {
        name,
        song_count: int(obj, "songCount").unwrap_or(0),
        album_count: int(obj, "albumCount").unwrap_or(0),
    })
}

pub(crate) fn scan_status(obj: Option<&Obj>) -> ScanStatus {
    let Some(obj) = obj else {
        return ScanStatus::default();
    };
    ScanStatus {
        scanning: obj
            .get("scanning")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        count: long(obj, "count").unwrap_or(0),
        folder_count: long(obj, "folderCount").unwrap_or(0),
        last_scan: string(obj, "lastScan"),
    }
}
