//! Client for Downtify (an open-source downloader that finds songs on YouTube and YouTube Music, no Spotify
//! account needed). No authentication: the server tells callers apart only by a per-install `client_id`, which
//! keeps a separate settings profile. The routes were read from the app's own web front end.
//!
//! Port of `mobile/src/services/downtify.ts` (itself ported from the desktop's).

use std::fmt;
use std::time::Duration;

use hub_core::home_network::is_home_host;
use serde_json::{Map, Value, json};

use crate::transport::{Method, Reply, Request, Transport};
use crate::url;

const TIMEOUT: Duration = Duration::from_secs(20);
/// The server resolves, downloads and converts the song before it answers, which takes long.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
/// An album is at most this many songs.
const MAX_ALBUM_SONGS: usize = 25;

/// What went wrong. `status` is the HTTP status, or 0 when the server did not answer at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DowntifyError {
    pub message: String,
    pub status: u16,
}

impl fmt::Display for DowntifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DowntifyError {}

#[derive(Debug, Clone, PartialEq)]
pub struct DowntifySong {
    pub song_id: String,
    pub name: String,
    pub artists: Vec<String>,
    pub album_name: String,
    pub cover_url: String,
    /// Seconds.
    pub duration: f64,
    pub url: String,
    pub source: String,
}

impl DowntifySong {
    fn from_json(v: &Value) -> Self {
        let text = |name: &str| {
            v.get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        Self {
            song_id: text("song_id"),
            name: text("name"),
            artists: v
                .get("artists")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(Into::into).collect())
                .unwrap_or_default(),
            album_name: text("album_name"),
            cover_url: text("cover_url"),
            duration: v.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
            url: text("url"),
            source: text("source"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueueItem {
    pub song: DowntifySong,
    /// "queued", "downloading", "done", "error", or whatever a newer server says.
    pub status: String,
    pub progress: f64,
    pub message: String,
    pub filename: Option<String>,
}

/// The server's settings for this install, kept whole so that saving them back loses nothing a newer server added.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DowntifySettings(pub Map<String, Value>);

impl DowntifySettings {
    pub fn format(&self) -> &str {
        self.0
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    pub fn bitrate(&self) -> &str {
        self.0
            .get("bitrate")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    pub fn output(&self) -> &str {
        self.0
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    pub fn download_lyrics(&self) -> bool {
        self.0
            .get("download_lyrics")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn max_parallel_downloads(&self) -> u32 {
        self.0
            .get("max_parallel_downloads")
            .and_then(Value::as_u64)
            .unwrap_or(1) as u32
    }

    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.0.insert(key.to_owned(), value.into());
    }
}

/// What a free-text query is resolved to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryKind {
    /// The best match only.
    Track,
    /// The best match's album: every result from it, up to 25.
    Album,
}

pub struct DowntifyClient<T: Transport> {
    transport: T,
    base_url: String,
    client_id: String,
}

impl<T: Transport> DowntifyClient<T> {
    pub fn new(transport: T, url: &str, client_id: &str) -> Self {
        Self {
            transport,
            base_url: url.trim_end_matches('/').to_owned(),
            client_id: client_id.to_owned(),
        }
    }

    pub async fn test_connection(&self) -> Result<(), DowntifyError> {
        self.request(Method::Get, "/api/version", &[], None, TIMEOUT)
            .await
            .map(|_| ())
    }

    pub async fn queue(&self) -> Result<Vec<QueueItem>, DowntifyError> {
        let reply = self
            .request(Method::Get, "/api/queue", &[], None, TIMEOUT)
            .await?;
        Ok(array(&reply)
            .iter()
            .map(|item| QueueItem {
                song: item
                    .get("song")
                    .map(DowntifySong::from_json)
                    .unwrap_or_else(|| DowntifySong::from_json(&Value::Null)),
                status: item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                progress: item.get("progress").and_then(Value::as_f64).unwrap_or(0.0),
                message: item
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                filename: item.get("filename").and_then(Value::as_str).map(Into::into),
            })
            .collect())
    }

    pub async fn cancel_queue_item(&self, song_id: &str) -> Result<(), DowntifyError> {
        self.request(
            Method::Delete,
            "/api/queue/item",
            &[("song_id", song_id)],
            None,
            TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    pub async fn clear_queue(&self) -> Result<(), DowntifyError> {
        self.request(Method::Delete, "/api/queue", &[], None, TIMEOUT)
            .await
            .map(|_| ())
    }

    pub async fn search_songs(&self, query: &str) -> Result<Vec<DowntifySong>, DowntifyError> {
        let reply = self
            .request(
                Method::Get,
                "/api/songs/search",
                &[("query", query)],
                None,
                TIMEOUT,
            )
            .await?;
        Ok(array(&reply).iter().map(DowntifySong::from_json).collect())
    }

    /// Has the server download one song. It answers only once the song is downloaded and converted.
    pub async fn download_by_url(&self, song_url: &str) -> Result<(), DowntifyError> {
        let params = [("url", song_url), ("client_id", self.client_id.as_str())];
        self.request(
            Method::Post,
            "/api/download/url",
            &params,
            None,
            DOWNLOAD_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    /// The songs to download for a free-text query. The caller starts a [`Self::download_by_url`] for each
    /// without waiting on them, and follows the progress in the polled [`Self::queue`]: each download answers only
    /// when it is finished.
    pub async fn resolve_query(
        &self,
        query: &str,
        kind: QueryKind,
    ) -> Result<Vec<DowntifySong>, DowntifyError> {
        download_targets(self.search_songs(query).await?, kind)
    }

    /// The files of the server's library.
    pub async fn library(&self) -> Result<Vec<String>, DowntifyError> {
        let reply = self
            .request(Method::Get, "/list", &[], None, TIMEOUT)
            .await?;
        Ok(array(&reply)
            .iter()
            .filter_map(Value::as_str)
            .map(Into::into)
            .collect())
    }

    pub async fn delete_from_library(&self, file: &str) -> Result<(), DowntifyError> {
        self.request(Method::Delete, "/delete", &[("file", file)], None, TIMEOUT)
            .await
            .map(|_| ())
    }

    /// The address of a downloaded file, each part of its path encoded.
    pub fn file_url(&self, file: &str) -> String {
        let encoded: Vec<String> = file.split('/').map(url::encode_uri_component).collect();
        format!("{}/downloads/{}", self.base_url, encoded.join("/"))
    }

    pub fn cover_url(&self, file: &str) -> String {
        format!(
            "{}/cover?file={}",
            self.base_url,
            url::encode_uri_component(file)
        )
    }

    pub async fn settings(&self) -> Result<DowntifySettings, DowntifyError> {
        let reply = self
            .request(
                Method::Get,
                "/api/settings",
                &[("client_id", &self.client_id)],
                None,
                TIMEOUT,
            )
            .await?;
        Ok(DowntifySettings(match reply.json() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        }))
    }

    pub async fn update_settings(&self, settings: &DowntifySettings) -> Result<(), DowntifyError> {
        let body = Value::Object(settings.0.clone());
        self.request(
            Method::Post,
            "/api/settings/update",
            &[("client_id", &self.client_id)],
            Some(&body),
            TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        params: &[(&str, &str)],
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Reply, DowntifyError> {
        let query = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", url::query(params))
        };
        let address = format!("{}{path}{query}", self.base_url);
        let home = url::host_of(&address).is_some_and(is_home_host);
        let mut request = Request::new(method, address)
            .header("Content-Type", "application/json")
            .home_network(home)
            .timeout(timeout);
        if let Some(body) = body {
            request.body = Some(body.to_string().into_bytes());
        }
        let reply = self
            .transport
            .send(request)
            .await
            .map_err(|e| DowntifyError {
                message: e.0,
                status: 0,
            })?;
        if !reply.is_success() {
            return Err(DowntifyError {
                message: format!("Erreur Downtify ({})", reply.status),
                status: reply.status,
            });
        }
        Ok(reply)
    }
}

/// Which songs a query downloads: the best match, or every result from its album (25 at most).
pub fn download_targets(
    results: Vec<DowntifySong>,
    kind: QueryKind,
) -> Result<Vec<DowntifySong>, DowntifyError> {
    let Some(first) = results.first() else {
        let what = match kind {
            QueryKind::Album => "cet album",
            QueryKind::Track => "ce titre",
        };
        return Err(DowntifyError {
            message: format!("Aucun résultat trouvé pour {what}"),
            status: 404,
        });
    };
    if kind == QueryKind::Track || first.album_name.is_empty() {
        return Ok(vec![first.clone()]);
    }
    let album = first.album_name.clone();
    Ok(results
        .into_iter()
        .filter(|s| s.album_name == album)
        .take(MAX_ALBUM_SONGS)
        .collect())
}

fn array(reply: &Reply) -> Vec<Value> {
    match reply.json() {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// A song as Downtify describes it, for tests and for the watch relay's own tests.
pub fn song_json(id: &str, name: &str, album: &str) -> Value {
    json!({
        "song_id": id, "name": name, "artists": ["alt-J"], "album_name": album,
        "cover_url": "", "duration": 200, "url": format!("https://music.youtube.com/watch?v={id}"), "source": "youtube"
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::scripted::{Scripted, body, header, json as reply_json, query};
    use crate::subsonic::fake::block_on;

    const BASE: &str = "http://nas.local:8000";

    fn client() -> (Arc<Scripted>, DowntifyClient<Arc<Scripted>>) {
        let server = Arc::new(Scripted::default());
        let client = DowntifyClient::new(server.clone(), &format!("{BASE}//"), "install-1");
        (server, client)
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }

    #[test]
    fn a_search_reads_the_songs_and_goes_through_the_home_network() {
        let (server, client) = client();
        server.on(
            Method::Get,
            &format!("{BASE}/api/songs/search"),
            reply_json(
                200,
                json!([song_json("y1", "Breezeblocks", "An Awesome Wave"), { "song_id": "y2" }]),
            ),
        );
        let songs = block_on(client.search_songs("alt j")).unwrap();
        assert_eq!(songs.len(), 2);
        assert_eq!(songs[0].name, "Breezeblocks");
        assert_eq!(songs[0].artists, ["alt-J"]);
        assert_eq!(songs[0].duration, 200.0);
        assert_eq!(songs[1].name, "", "missing fields are empty, not an error");
        let sent = server.last();
        assert_eq!(query(&sent.url), pairs(&[("query", "alt j")]));
        assert!(sent.home_network, "nas.local is on the home network");
        assert_eq!(sent.timeout, Some(Duration::from_secs(20)));
    }

    #[test]
    fn a_download_waits_long_and_names_the_install() {
        let (server, client) = client();
        server.on(
            Method::Post,
            &format!("{BASE}/api/download/url"),
            Reply::new(200, "", Vec::new()),
        );
        block_on(client.download_by_url("https://music.youtube.com/watch?v=y1")).unwrap();
        let sent = server.last();
        assert_eq!(
            query(&sent.url),
            pairs(&[
                ("url", "https://music.youtube.com/watch?v=y1"),
                ("client_id", "install-1")
            ])
        );
        assert_eq!(sent.body, None);
        assert_eq!(sent.timeout, Some(Duration::from_secs(180)));
    }

    #[test]
    fn errors_say_whether_the_server_answered() {
        let (server, client) = client();
        server.on(
            Method::Get,
            &format!("{BASE}/api/queue"),
            Reply::new(502, "", Vec::new()),
        );
        assert_eq!(
            block_on(client.queue()),
            Err(DowntifyError {
                message: "Erreur Downtify (502)".into(),
                status: 502
            })
        );
        server.clear();
        server.unreachable(Method::Get, BASE);
        assert_eq!(block_on(client.test_connection()).unwrap_err().status, 0);
    }

    #[test]
    fn the_queue_is_read_leniently() {
        let (server, client) = client();
        server.on(
            Method::Get,
            &format!("{BASE}/api/queue"),
            reply_json(
                200,
                json!([
                    { "song": song_json("y1", "A", "X"), "status": "downloading", "progress": 42.5, "message": "", "filename": null },
                    { "song": song_json("y2", "B", "X"), "status": "done", "progress": 100, "message": "", "filename": "B.mp3" }
                ]),
            ),
        );
        let queue = block_on(client.queue()).unwrap();
        assert_eq!(queue[0].status, "downloading");
        assert_eq!(queue[0].progress, 42.5);
        assert_eq!(queue[0].filename, None);
        assert_eq!(queue[1].filename.as_deref(), Some("B.mp3"));
        server.clear();
        server.on(
            Method::Get,
            &format!("{BASE}/api/queue"),
            Reply::new(200, "text/plain", b"oops".to_vec()),
        );
        assert!(
            block_on(client.queue()).unwrap().is_empty(),
            "not a list: an empty queue"
        );
    }

    #[test]
    fn a_query_downloads_the_best_match_or_its_album() {
        let songs = |list: &[(&str, &str)]| -> Vec<DowntifySong> {
            list.iter()
                .map(|(id, album)| DowntifySong::from_json(&song_json(id, id, album)))
                .collect()
        };
        let ids = |list: Vec<DowntifySong>| list.into_iter().map(|s| s.song_id).collect::<Vec<_>>();
        let results = songs(&[("a", "X"), ("b", "Y"), ("c", "X")]);
        assert_eq!(
            ids(download_targets(results.clone(), QueryKind::Track).unwrap()),
            ["a"]
        );
        assert_eq!(
            ids(download_targets(results, QueryKind::Album).unwrap()),
            ["a", "c"]
        );
        let no_album = songs(&[("a", ""), ("b", "")]);
        assert_eq!(
            ids(download_targets(no_album, QueryKind::Album).unwrap()),
            ["a"]
        );
        let many: Vec<DowntifySong> = (0..40)
            .map(|i| DowntifySong::from_json(&song_json(&i.to_string(), "t", "X")))
            .collect();
        assert_eq!(download_targets(many, QueryKind::Album).unwrap().len(), 25);
        let none = download_targets(Vec::new(), QueryKind::Album).unwrap_err();
        assert_eq!(
            (none.status, none.message.as_str()),
            (404, "Aucun résultat trouvé pour cet album")
        );
    }

    #[test]
    fn settings_are_saved_back_whole_for_this_install() {
        let (server, client) = client();
        server.on(
            Method::Get,
            &format!("{BASE}/api/settings"),
            reply_json(
                200,
                json!({ "format": "mp3", "bitrate": "320k", "future_option": 7 }),
            ),
        );
        server.on(
            Method::Post,
            &format!("{BASE}/api/settings/update"),
            Reply::new(200, "", Vec::new()),
        );
        let mut settings = block_on(client.settings()).unwrap();
        assert_eq!(settings.format(), "mp3");
        assert_eq!(
            query(&server.last().url),
            pairs(&[("client_id", "install-1")])
        );
        settings.set("format", "flac");
        block_on(client.update_settings(&settings)).unwrap();
        let sent = server.last();
        assert_eq!(
            body(&sent),
            json!({ "format": "flac", "bitrate": "320k", "future_option": 7 })
        );
        assert_eq!(header(&sent, "Content-Type"), Some("application/json"));
    }

    #[test]
    fn library_files_and_their_addresses() {
        let (server, client) = client();
        server.on(
            Method::Get,
            &format!("{BASE}/list"),
            reply_json(200, json!(["alt-J/An Awesome Wave/01 Intro.mp3"])),
        );
        server.on(
            Method::Delete,
            &format!("{BASE}/delete"),
            Reply::new(200, "", Vec::new()),
        );
        assert_eq!(
            block_on(client.library()).unwrap(),
            ["alt-J/An Awesome Wave/01 Intro.mp3"]
        );
        assert_eq!(
            client.file_url("alt-J/An Awesome Wave/01 Intro.mp3"),
            format!("{BASE}/downloads/alt-J/An%20Awesome%20Wave/01%20Intro.mp3")
        );
        assert_eq!(
            client.cover_url("a/b c.mp3"),
            format!("{BASE}/cover?file=a%2Fb%20c.mp3")
        );
        block_on(client.delete_from_library("a/b.mp3")).unwrap();
        assert_eq!(query(&server.last().url), pairs(&[("file", "a/b.mp3")]));
        assert_eq!(server.last().method, Method::Delete);
    }

    #[test]
    fn cancelling_and_clearing_the_queue() {
        let (server, client) = client();
        server.on(
            Method::Delete,
            &format!("{BASE}/api/queue"),
            Reply::new(200, "", Vec::new()),
        );
        block_on(client.cancel_queue_item("y1")).unwrap();
        assert!(
            server
                .last()
                .url
                .starts_with(&format!("{BASE}/api/queue/item?song_id=y1"))
        );
        block_on(client.clear_queue()).unwrap();
        assert_eq!(server.last().url, format!("{BASE}/api/queue"));
    }
}
