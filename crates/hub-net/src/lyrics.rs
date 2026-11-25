//! Looking up song lyrics. LRCLIB (lrclib.net) is a free, open source, key-less lyrics database that serves LRC
//! synced lyrics; it asks callers to name themselves in the User-Agent. Navidrome's own plain lyrics are the last
//! resort.
//!
//! Port of the network half of `mobile/src/services/lyrics.ts`; the parsing is in [`hub_core::lyrics`].

use hub_core::lyrics::{LyricsResult, LyricsSource, from_lrclib};
use serde_json::Value;

use crate::transport::{Method, Request, Transport};
use crate::url;

pub const LRCLIB: &str = "https://lrclib.net/api";
const USER_AGENT: &str = "SelfHostHub/1.0.0 (self-hosted music client)";

/// The song whose lyrics are looked up.
#[derive(Debug, Clone, PartialEq)]
pub struct LyricsQuery<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub artist: &'a str,
    pub album: &'a str,
    /// Seconds.
    pub duration: f64,
}

/// Where lyrics found once are kept on the device.
pub trait LyricsCache {
    fn load(&self, song_id: &str) -> Option<LyricsResult>;
    fn save(&self, song_id: &str, lyrics: &LyricsResult);
}

pub struct LyricsClient<T: Transport> {
    transport: T,
    base: String,
}

impl<T: Transport> LyricsClient<T> {
    pub fn new(transport: T) -> Self {
        Self::with_base(transport, LRCLIB)
    }

    /// Another LRCLIB server (a self-hosted one, or a test).
    pub fn with_base(transport: T, base: &str) -> Self {
        Self {
            transport,
            base: base.trim_end_matches('/').to_owned(),
        }
    }

    /// Exact match: artist, title, album and duration. The best hits; misses easily.
    pub async fn get(
        &self,
        artist: &str,
        title: &str,
        album: &str,
        duration: f64,
    ) -> Option<LyricsResult> {
        let duration = format!("{}", (duration + 0.5).floor().max(0.0));
        let params = [
            ("artist_name", artist),
            ("track_name", title),
            ("album_name", album),
            ("duration", &duration),
        ];
        let record = self
            .fetch(&format!("{}/get?{}", self.base, url::query(&params)))
            .await?;
        record_result(&record)
    }

    /// Looser: no album, no duration. The record with synced lyrics is preferred to the first hit.
    pub async fn search(&self, artist: &str, title: &str) -> Option<LyricsResult> {
        let params = [("track_name", title), ("artist_name", artist)];
        let records = self
            .fetch(&format!("{}/search?{}", self.base, url::query(&params)))
            .await?;
        let records = records.as_array()?;
        let best = records
            .iter()
            .find(|r| {
                r.get("syncedLyrics")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
            })
            .or_else(|| records.first())?;
        record_result(best)
    }

    /// Lyrics for a song: the cache, then the exact LRCLIB match. With `wide` (the "search" button, after a normal
    /// lookup came up empty), also the looser search, then `navidrome` (the server's own lyrics). A hit is cached.
    pub async fn fetch_lyrics<F, Fut>(
        &self,
        song: &LyricsQuery<'_>,
        cache: &impl LyricsCache,
        wide: bool,
        navidrome: Option<F>,
    ) -> Option<LyricsResult>
    where
        F: FnOnce(String, String) -> Fut,
        Fut: Future<Output = Option<String>>,
    {
        if let Some(cached) = cache.load(song.id) {
            return Some(cached);
        }
        let mut result = self
            .get(song.artist, song.title, song.album, song.duration)
            .await;
        if result.is_none() && wide {
            result = self.search(song.artist, song.title).await;
            if result.is_none()
                && let Some(lookup) = navidrome
                && let Some(plain) = lookup(song.artist.to_owned(), song.title.to_owned()).await
                && !plain.trim().is_empty()
            {
                result = Some(LyricsResult {
                    synced: None,
                    plain: Some(plain.trim().to_owned()),
                    source: LyricsSource::Navidrome,
                });
            }
        }
        if let Some(found) = &result {
            cache.save(song.id, found);
        }
        result
    }

    /// The JSON answer, or `None` for a miss, a refusal or no network (lyrics are a nicety).
    async fn fetch(&self, address: &str) -> Option<Value> {
        let reply = self
            .transport
            .send(Request::new(Method::Get, address).header("User-Agent", USER_AGENT))
            .await
            .ok()?;
        reply.is_success().then(|| reply.json()).flatten()
    }
}

fn record_result(record: &Value) -> Option<LyricsResult> {
    from_lrclib(
        record.get("syncedLyrics").and_then(Value::as_str),
        record.get("plainLyrics").and_then(Value::as_str),
        record
            .get("instrumental")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::scripted::{Scripted, header, json as reply_json, query};
    use crate::subsonic::fake::block_on;
    use crate::transport::Reply;

    #[derive(Default)]
    struct MemoryCache(RefCell<HashMap<String, LyricsResult>>);

    impl LyricsCache for MemoryCache {
        fn load(&self, song_id: &str) -> Option<LyricsResult> {
            self.0.borrow().get(song_id).cloned()
        }

        fn save(&self, song_id: &str, lyrics: &LyricsResult) {
            self.0
                .borrow_mut()
                .insert(song_id.to_owned(), lyrics.clone());
        }
    }

    const SONG: LyricsQuery<'static> = LyricsQuery {
        id: "so-1",
        title: "Breezeblocks",
        artist: "alt-J",
        album: "An Awesome Wave",
        duration: 227.4,
    };

    type NoLookup = fn(String, String) -> std::future::Ready<Option<String>>;

    #[test]
    fn the_exact_match_names_the_app_and_is_cached() {
        let server = Arc::new(Scripted::default());
        server.on(
            Method::Get,
            &format!("{LRCLIB}/get"),
            reply_json(200, json!({ "syncedLyrics": "[00:01.00]She may contain the urge", "plainLyrics": "She may contain the urge" })),
        );
        let client = LyricsClient::new(server.clone());
        let cache = MemoryCache::default();
        let found = block_on(client.fetch_lyrics(&SONG, &cache, false, None::<NoLookup>)).unwrap();
        assert_eq!(found.synced.unwrap()[0].text, "She may contain the urge");
        let sent = server.last();
        assert_eq!(header(&sent, "User-Agent"), Some(USER_AGENT));
        let params = query(&sent.url);
        assert!(
            params.contains(&("duration".into(), "227".into())),
            "{params:?}"
        );
        assert!(params.contains(&("album_name".into(), "An Awesome Wave".into())));
        // The second time comes from the cache: nothing is sent.
        server.clear();
        assert!(block_on(client.fetch_lyrics(&SONG, &cache, false, None::<NoLookup>)).is_some());
        assert!(server.sent().is_empty());
    }

    #[test]
    fn a_wide_lookup_tries_the_search_preferring_synced_lyrics() {
        let server = Arc::new(Scripted::default());
        server.on(
            Method::Get,
            &format!("{LRCLIB}/get"),
            Reply::new(404, "", Vec::new()),
        );
        server.on(
            Method::Get,
            &format!("{LRCLIB}/search"),
            reply_json(200, json!([{ "plainLyrics": "plain only" }, { "syncedLyrics": "[00:02]synced", "plainLyrics": "synced" }])),
        );
        let client = LyricsClient::new(server.clone());
        let narrow =
            block_on(client.fetch_lyrics(&SONG, &MemoryCache::default(), false, None::<NoLookup>));
        assert_eq!(narrow, None, "without wide, only the exact match");
        let wide =
            block_on(client.fetch_lyrics(&SONG, &MemoryCache::default(), true, None::<NoLookup>))
                .unwrap();
        assert_eq!(wide.plain.as_deref(), Some("synced"));
    }

    #[test]
    fn navidrome_is_the_last_resort_and_an_outage_is_no_error() {
        let server = Arc::new(Scripted::default());
        server.unreachable(Method::Get, LRCLIB);
        let client = LyricsClient::new(server);
        let asked = RefCell::new(None);
        let lookup = |artist: String, title: String| {
            *asked.borrow_mut() = Some((artist, title));
            std::future::ready(Some("  Paroles du serveur \n".to_owned()))
        };
        let found =
            block_on(client.fetch_lyrics(&SONG, &MemoryCache::default(), true, Some(lookup)))
                .unwrap();
        assert_eq!(found.source, LyricsSource::Navidrome);
        assert_eq!(found.plain.as_deref(), Some("Paroles du serveur"));
        assert_eq!(
            asked.into_inner(),
            Some(("alt-J".into(), "Breezeblocks".into()))
        );
    }

    #[test]
    fn an_instrumental_says_so() {
        let server = Arc::new(Scripted::default());
        server.on(
            Method::Get,
            LRCLIB,
            reply_json(200, json!({ "instrumental": true })),
        );
        let found = block_on(LyricsClient::new(server).get("a", "b", "c", 10.0)).unwrap();
        assert_eq!(found.plain.as_deref(), Some(hub_core::lyrics::INSTRUMENTAL));
    }
}
