//! A small in-memory stand-in for Navidrome's Subsonic API, enough for the clients' calls, that records what it
//! was asked. Port of `wear/data/src/test/kotlin/com/selfhosthub/wear/data/FakeNavidrome.kt`, serving a
//! [`Transport`] instead of a socket.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Waker};

use serde_json::{Map, Value, json};

use crate::transport::{Reply, Request, Transport, TransportError};
use crate::url::decode_component;

/// Runs a future that never waits on anything outside itself, as every call to the fake does.
pub fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::yield_now();
    }
}

#[derive(Debug, Clone)]
pub struct FakeArtist {
    id: String,
    name: String,
    album_count: i32,
}

impl FakeArtist {
    pub fn new(id: &str, name: &str, album_count: i32) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            album_count,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FakeSong {
    id: String,
    title: String,
    artist: String,
    track: i32,
    duration: i32,
    album_id: Option<String>,
}

impl FakeSong {
    pub fn new(id: &str, title: &str, artist: &str, track: i32, duration: i32) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            track,
            duration,
            album_id: None,
        }
    }

    pub fn in_album(mut self, album_id: &str) -> Self {
        self.album_id = Some(album_id.into());
        self
    }
}

#[derive(Debug, Clone)]
pub struct FakeAlbum {
    id: String,
    name: String,
    artist: String,
    artist_id: String,
    year: i32,
    created: String,
    songs: Vec<FakeSong>,
}

impl FakeAlbum {
    pub fn new(
        id: &str,
        name: &str,
        artist: &str,
        artist_id: &str,
        year: i32,
        songs: Vec<FakeSong>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            artist: artist.into(),
            artist_id: artist_id.into(),
            year,
            created: "2024-01-01T00:00:00Z".into(),
            songs,
        }
    }

    /// When the server added it (an ISO date), which is what the `newest` list sorts by.
    pub fn created(mut self, created: &str) -> Self {
        self.created = created.into();
        self
    }
}

#[derive(Debug, Clone)]
pub struct FakePlaylist {
    id: String,
    name: String,
    changed: String,
    songs: Vec<FakeSong>,
    owner: Option<String>,
}

impl FakePlaylist {
    pub fn new(id: &str, name: &str, songs: Vec<FakeSong>, owner: Option<&str>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            changed: "2026-01-01T10:00:00Z".into(),
            songs,
            owner: owner.map(Into::into),
        }
    }

    /// The server's "last changed" stamp.
    pub fn changed(mut self, changed: &str) -> Self {
        self.changed = changed.into();
        self
    }
}

pub struct Library {
    pub artists: Vec<FakeArtist>,
    pub albums: Vec<FakeAlbum>,
    pub playlists: Vec<FakePlaylist>,
    pub last_modified: Option<i64>,
    pub now_playing: Vec<(FakeSong, String)>,
    pub missing_covers: Vec<String>,
    pub cover_bytes: Vec<u8>,
}

impl Default for Library {
    fn default() -> Self {
        Self {
            artists: Vec::new(),
            albums: Vec::new(),
            playlists: Vec::new(),
            last_modified: Some(1_000),
            now_playing: Vec::new(),
            missing_covers: Vec::new(),
            cover_bytes: vec![0x42, 0x13, 0x37],
        }
    }
}

/// One request as the fake received it.
#[derive(Debug, Clone)]
pub struct Received {
    pub url: String,
    pub method: String,
    params: Vec<(String, String)>,
    pub home_network: bool,
}

impl Received {
    /// A query parameter, decoded; empty when missing.
    pub fn param(&self, name: &str) -> String {
        self.params
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    }
}

#[derive(Default)]
pub struct FakeNavidrome {
    pub library: Mutex<Library>,
    pub requests: Mutex<Vec<Received>>,
    /// When set, answers every request with this instead.
    failure: Mutex<Option<Reply>>,
    /// When set, every request fails as if the server were down.
    pub unreachable: AtomicBool,
}

impl FakeNavidrome {
    pub fn calls_to(&self, method: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == method)
            .count()
    }

    pub fn fail_with(&self, reply: Reply) {
        *self.failure.lock().unwrap() = Some(reply);
    }

    pub fn auth_failure() -> Reply {
        json_reply(
            r#"{"subsonic-response":{"status":"failed","version":"1.16.1","error":{"code":40,"message":"Wrong username or password"}}}"#,
        )
    }

    pub fn server_error() -> Reply {
        Reply::new(500, "", b"boom".to_vec())
    }

    fn dispatch(&self, request: &Received) -> Reply {
        if let Some(failure) = self.failure.lock().unwrap().clone() {
            return failure;
        }
        let lib = self.library.lock().unwrap();
        let param = |name: &str| request.param(name);
        match request.method.as_str() {
            "ping" => ok(None),
            "getArtists" => {
                let mut groups: BTreeMap<String, Vec<&FakeArtist>> = BTreeMap::new();
                for artist in &lib.artists {
                    let letter = artist
                        .name
                        .chars()
                        .next()
                        .unwrap_or('?')
                        .to_uppercase()
                        .to_string();
                    groups.entry(letter).or_default().push(artist);
                }
                let index: Vec<Value> = groups
                    .into_iter()
                    .map(|(letter, mut group)| {
                        group.sort_by_key(|a| a.name.to_lowercase());
                        json!({ "name": letter, "artist": group.iter().map(|a| artist_json(a)).collect::<Vec<_>>() })
                    })
                    .collect();
                let mut artists = Map::new();
                if let Some(stamp) = lib.last_modified {
                    artists.insert("lastModified".into(), stamp.into());
                }
                artists.insert("index".into(), index.into());
                ok(Some(("artists", Value::Object(artists))))
            }
            "getArtist" => {
                let Some(artist) = lib.artists.iter().find(|a| a.id == param("id")) else {
                    return error(70, "Artist not found");
                };
                let mut body = artist_json(artist);
                let albums: Vec<Value> = lib
                    .albums
                    .iter()
                    .filter(|a| a.artist_id == artist.id)
                    .map(album_json)
                    .collect();
                body.as_object_mut()
                    .unwrap()
                    .insert("album".into(), albums.into());
                ok(Some(("artist", body)))
            }
            "getAlbumList2" => {
                let size: usize = param("size").parse().unwrap_or(10);
                let offset: usize = param("offset").parse().unwrap_or(0);
                let mut sorted: Vec<&FakeAlbum> = lib.albums.iter().collect();
                if param("type") == "newest" {
                    sorted.sort_by(|a, b| b.created.cmp(&a.created));
                } else {
                    sorted.sort_by_key(|a| a.name.to_lowercase());
                }
                let page: Vec<Value> = sorted
                    .into_iter()
                    .skip(offset)
                    .take(size)
                    .map(album_json)
                    .collect();
                ok(Some(("albumList2", json!({ "album": page }))))
            }
            "getAlbum" => {
                let Some(album) = lib.albums.iter().find(|a| a.id == param("id")) else {
                    return error(70, "Album not found");
                };
                let mut body = album_json(album);
                let songs: Vec<Value> = album
                    .songs
                    .iter()
                    .map(|s| song_json(&lib, s, Some(&album.id)))
                    .collect();
                body.as_object_mut()
                    .unwrap()
                    .insert("song".into(), songs.into());
                ok(Some(("album", body)))
            }
            "getPlaylists" => {
                let list: Vec<Value> = lib.playlists.iter().map(playlist_json).collect();
                ok(Some(("playlists", json!({ "playlist": list }))))
            }
            "getPlaylist" => {
                let Some(playlist) = lib.playlists.iter().find(|p| p.id == param("id")) else {
                    return error(70, "Playlist not found");
                };
                let mut body = playlist_json(playlist);
                let entries: Vec<Value> = playlist
                    .songs
                    .iter()
                    .map(|s| song_json(&lib, s, s.album_id.as_deref()))
                    .collect();
                body.as_object_mut()
                    .unwrap()
                    .insert("entry".into(), entries.into());
                ok(Some(("playlist", body)))
            }
            "search3" => {
                let q = param("query").to_lowercase();
                let artists: Vec<Value> = lib
                    .artists
                    .iter()
                    .filter(|a| a.name.to_lowercase().contains(&q))
                    .map(artist_json)
                    .collect();
                let albums: Vec<Value> = lib
                    .albums
                    .iter()
                    .filter(|a| a.name.to_lowercase().contains(&q))
                    .map(album_json)
                    .collect();
                let songs: Vec<Value> = lib
                    .albums
                    .iter()
                    .flat_map(|a| a.songs.iter().map(move |s| (s, a.id.as_str())))
                    .filter(|(s, _)| s.title.to_lowercase().contains(&q))
                    .map(|(s, album_id)| song_json(&lib, s, Some(album_id)))
                    .collect();
                ok(Some((
                    "searchResult3",
                    json!({ "artist": artists, "album": albums, "song": songs }),
                )))
            }
            "getNowPlaying" => {
                let entries: Vec<Value> = lib
                    .now_playing
                    .iter()
                    .map(|(song, user)| {
                        let mut entry = song_json(&lib, song, song.album_id.as_deref());
                        let obj = entry.as_object_mut().unwrap();
                        obj.insert("username".into(), user.as_str().into());
                        obj.insert("minutesAgo".into(), 2.into());
                        obj.insert("playerName".into(), "Phone".into());
                        entry
                    })
                    .collect();
                ok(Some(("nowPlaying", json!({ "entry": entries }))))
            }
            "getCoverArt" => {
                if lib.missing_covers.contains(&param("id")) {
                    json_reply(
                        r#"{"subsonic-response":{"status":"failed","version":"1.16.1","error":{"code":70,"message":"Cover not found"}}}"#,
                    )
                } else {
                    Reply::new(200, "image/jpeg", lib.cover_bytes.clone())
                }
            }
            "star" => ok(None),
            other => error(0, &format!("Unknown method {other}")),
        }
    }
}

impl Transport for FakeNavidrome {
    async fn send(&self, request: Request) -> Result<Reply, TransportError> {
        if self.unreachable.load(Ordering::SeqCst) {
            return Err(TransportError("connection refused".into()));
        }
        let (url, home_network) = (request.url.as_str(), request.home_network);
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
        let method = path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .trim_end_matches(".view")
            .to_owned();
        let params = query
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|p| {
                let (k, v) = p.split_once('=').unwrap_or((p, ""));
                (decode_component(k), decode_component(v))
            })
            .collect();
        let received = Received {
            url: url.to_owned(),
            method,
            params,
            home_network,
        };
        let reply = self.dispatch(&received);
        self.requests.lock().unwrap().push(received);
        Ok(reply)
    }
}

fn json_reply(body: &str) -> Reply {
    Reply::new(200, "application/json", body.as_bytes().to_vec())
}

fn ok(payload: Option<(&str, Value)>) -> Reply {
    let mut body = Map::new();
    body.insert("status".into(), "ok".into());
    body.insert("version".into(), "1.16.1".into());
    body.insert("serverVersion".into(), "0.54.5".into());
    if let Some((key, value)) = payload {
        body.insert(key.into(), value);
    }
    json_reply(&json!({ "subsonic-response": body }).to_string())
}

fn error(code: i32, message: &str) -> Reply {
    json_reply(
        &json!({ "subsonic-response": {
            "status": "failed", "version": "1.16.1", "error": { "code": code, "message": message }
        }})
        .to_string(),
    )
}

fn artist_json(a: &FakeArtist) -> Value {
    json!({ "id": a.id, "name": a.name, "albumCount": a.album_count, "coverArt": format!("ar-{}", a.id) })
}

fn album_json(a: &FakeAlbum) -> Value {
    json!({
        "id": a.id, "name": a.name, "artist": a.artist, "artistId": a.artist_id, "coverArt": a.id,
        "songCount": a.songs.len(), "duration": a.songs.iter().map(|s| s.duration).sum::<i32>(),
        "year": a.year, "created": a.created
    })
}

fn song_json(lib: &Library, s: &FakeSong, album_id: Option<&str>) -> Value {
    let mut obj = Map::new();
    obj.insert("id".into(), s.id.as_str().into());
    obj.insert("title".into(), s.title.as_str().into());
    obj.insert("artist".into(), s.artist.as_str().into());
    obj.insert("track".into(), s.track.into());
    obj.insert("duration".into(), s.duration.into());
    if let Some(album_id) = album_id {
        let album = lib
            .albums
            .iter()
            .find(|a| a.id == album_id)
            .map_or("Album", |a| a.name.as_str());
        obj.insert("albumId".into(), album_id.into());
        obj.insert("album".into(), album.into());
        obj.insert("coverArt".into(), album_id.into());
    }
    Value::Object(obj)
}

fn playlist_json(p: &FakePlaylist) -> Value {
    let mut obj = Map::new();
    obj.insert("id".into(), p.id.as_str().into());
    obj.insert("name".into(), p.name.as_str().into());
    obj.insert("songCount".into(), p.songs.len().into());
    obj.insert("changed".into(), p.changed.as_str().into());
    if let Some(owner) = &p.owner {
        obj.insert("owner".into(), owner.as_str().into());
    }
    Value::Object(obj)
}
