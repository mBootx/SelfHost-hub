//! Looking for a song to download with Downtify, from the watch. The watch never talks to Downtify (it has no
//! address or login for it): it asks the phone, which has them, over the same Wear OS data layer as the link.
//!
//! Port of `wear/core/.../DowntifyProtocol.kt`. The phone's side is `mobile/src/services/watchDowntify.ts`.
//!
//! - the watch sends `search` with a request id and the words; the phone answers `results` with the same id, the
//!   songs found (a few, with what is needed to tell them apart) or why there are none;
//! - the watch sends `download` with a request id and one song's id from the last results; the phone answers
//!   `queued` as soon as Downtify has been asked (the download itself goes on without the watch).

use serde_json::{Map, Value};

use super::Lenient;

pub const VERSION: i64 = 1;
pub const PREFIX: &str = "/selfhost/downtify";
pub const SEARCH_PATH: &str = "/selfhost/downtify/search";
pub const RESULTS_PATH: &str = "/selfhost/downtify/results";
pub const DOWNLOAD_PATH: &str = "/selfhost/downtify/download";
pub const QUEUED_PATH: &str = "/selfhost/downtify/queued";

/// The most songs the phone sends back: a small screen has no use for more, and a message is small.
pub const MAX_RESULTS: usize = 12;
/// The phone cuts a query at this many characters, and so does the watch before sending it.
pub const MAX_QUERY_CHARS: usize = 120;

/// What the watch shows when the phone gives no reason for a failed search.
const DEFAULT_FAILURE: &str = "Recherche impossible";

/// A song Downtify found, as the watch shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct DowntifySong {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    /// Seconds; 0 when Downtify did not say.
    pub duration: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DowntifyReply {
    Results {
        request_id: String,
        songs: Vec<DowntifySong>,
    },
    /// The phone could not search: Downtify is not connected there, or did not answer.
    Failure { request_id: String, message: String },
    /// Downtify was asked for the song (`ok`), or the phone says why it was not.
    Queued {
        request_id: String,
        song_id: String,
        ok: bool,
        message: Option<String>,
    },
}

impl DowntifyReply {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Results { request_id, .. }
            | Self::Failure { request_id, .. }
            | Self::Queued { request_id, .. } => request_id,
        }
    }
}

pub fn search_request(request_id: &str, query: &str) -> String {
    let query: String = query.trim().chars().take(MAX_QUERY_CHARS).collect();
    let mut obj = Map::new();
    obj.insert("v".into(), VERSION.into());
    obj.insert("id".into(), request_id.into());
    obj.insert("query".into(), query.into());
    Value::Object(obj).to_string()
}

pub fn download_request(request_id: &str, song_id: &str) -> String {
    let mut obj = Map::new();
    obj.insert("v".into(), VERSION.into());
    obj.insert("id".into(), request_id.into());
    obj.insert("songId".into(), song_id.into());
    Value::Object(obj).to_string()
}

/// Reads what the phone sent on `path`; `None` for anything that is not a well-formed answer of ours.
pub fn parse(path: &str, text: &str) -> Option<DowntifyReply> {
    if path != RESULTS_PATH && path != QUEUED_PATH {
        return None;
    }
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    if obj.int("v") != Some(VERSION) {
        return None;
    }
    let request_id = obj.string("id").filter(|id| !id.is_empty())?;
    let ok = obj.bool_or("ok", false);

    if path == QUEUED_PATH {
        return Some(DowntifyReply::Queued {
            song_id: obj.string("songId")?,
            message: obj.string("message"),
            request_id,
            ok,
        });
    }
    if !ok {
        return Some(DowntifyReply::Failure {
            message: obj
                .string("error")
                .unwrap_or_else(|| DEFAULT_FAILURE.to_owned()),
            request_id,
        });
    }
    let songs = match obj.get("songs") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|element| {
                let song = element.as_object()?;
                let id = song.string("id").filter(|id| !id.is_empty())?;
                Some(DowntifySong {
                    id,
                    title: song.string("title").unwrap_or_default(),
                    artist: song.string("artist").unwrap_or_default(),
                    album: song.string("album").filter(|a| !a.is_empty()),
                    duration: song.f64_or("duration", 0.0).max(0.0),
                })
            })
            .take(MAX_RESULTS)
            .collect(),
        _ => Vec::new(),
    };
    Some(DowntifyReply::Results { request_id, songs })
}

// Ported from wear/core/src/test/kotlin/com/selfhosthub/wear/core/DowntifyProtocolTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    const RESULTS: &str =
        include_str!("../../../../wear/core/src/test/resources/downtify-results.json");
    const FAILURE: &str =
        include_str!("../../../../wear/core/src/test/resources/downtify-failure.json");
    const QUEUED: &str =
        include_str!("../../../../wear/core/src/test/resources/downtify-queued.json");

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn song(
        id: &str,
        title: &str,
        artist: &str,
        album: Option<&str>,
        duration: f64,
    ) -> DowntifySong {
        DowntifySong {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            album: album.map(Into::into),
            duration,
        }
    }

    #[test]
    fn golden_the_results_the_phone_sends_are_read() {
        let Some(DowntifyReply::Results { request_id, songs }) = parse(RESULTS_PATH, RESULTS)
        else {
            panic!("not results");
        };
        assert_eq!(request_id, "r1");
        assert_eq!(
            songs,
            vec![
                song(
                    "yt-1",
                    "Breezeblocks",
                    "alt-J",
                    Some("An Awesome Wave"),
                    227.0
                ),
                song("yt-2", "Tessellate", "alt-J, Invité", None, 183.0),
            ]
        );
    }

    #[test]
    fn golden_the_phone_saying_it_cannot_search_is_read_with_its_reason() {
        assert_eq!(
            parse(RESULTS_PATH, FAILURE),
            Some(DowntifyReply::Failure {
                request_id: "r1".into(),
                message: "Downtify n’est pas connecté sur le téléphone".into(),
            })
        );
    }

    #[test]
    fn golden_the_answer_to_a_download_is_read() {
        assert_eq!(
            parse(QUEUED_PATH, QUEUED),
            Some(DowntifyReply::Queued {
                request_id: "r2".into(),
                song_id: "yt-1".into(),
                ok: true,
                message: None,
            })
        );
        let refused = parse(
            QUEUED_PATH,
            r#"{"v":1,"id":"r3","songId":"yt-9","ok":false,"message":"Relancez la recherche"}"#,
        );
        assert_eq!(
            refused,
            Some(DowntifyReply::Queued {
                request_id: "r3".into(),
                song_id: "yt-9".into(),
                ok: false,
                message: Some("Relancez la recherche".into()),
            })
        );
    }

    #[test]
    fn what_the_watch_sends_is_what_the_phone_reads() {
        let search = json(&search_request("a1", "  alt-J "));
        assert_eq!(
            search,
            serde_json::json!({ "v": 1, "id": "a1", "query": "alt-J" })
        );
        assert_eq!(json(&download_request("a2", "yt-2"))["songId"], "yt-2");
        let long = json(&search_request("a3", &"x".repeat(400)));
        assert_eq!(long["query"].as_str().unwrap().chars().count(), 120);
    }

    #[test]
    fn nothing_that_is_not_a_well_formed_answer_of_ours_is_taken_for_one() {
        assert_eq!(parse(RESULTS_PATH, "garbage"), None);
        assert_eq!(
            parse(RESULTS_PATH, r#"{"v":2,"id":"r","ok":true,"songs":[]}"#),
            None
        );
        assert_eq!(parse(RESULTS_PATH, r#"{"v":1,"ok":true,"songs":[]}"#), None);
        assert_eq!(parse(QUEUED_PATH, r#"{"v":1,"id":"r","ok":true}"#), None);
        assert_eq!(parse("/selfhost/downtify/other", RESULTS), None);
    }

    #[test]
    fn songs_without_an_id_are_dropped_a_missing_list_is_empty_at_most_twelve_kept() {
        let songs: Vec<String> = (1..=20)
            .map(|i| format!(r#"{{"id":"s{i}","title":"T{i}","artist":"A"}}"#))
            .collect();
        let text = format!(
            r#"{{"v":1,"id":"r","ok":true,"songs":[{{"title":"sans id"}},{}]}}"#,
            songs.join(",")
        );
        let Some(DowntifyReply::Results { songs, .. }) = parse(RESULTS_PATH, &text) else {
            panic!("not results");
        };
        assert_eq!(songs.len(), 12);
        assert_eq!(songs[0].id, "s1");

        let Some(DowntifyReply::Results { songs, .. }) =
            parse(RESULTS_PATH, r#"{"v":1,"id":"r","ok":true}"#)
        else {
            panic!("not results");
        };
        assert!(songs.is_empty());
    }

    #[test]
    fn every_reply_names_its_request() {
        assert_eq!(parse(QUEUED_PATH, QUEUED).unwrap().request_id(), "r2");
    }
}
