use std::fmt;
use std::time::Instant;

use hub_core::home_network::is_home_host;
use hub_core::subsonic::{NavidromeLogin, is_own_playlist};
use serde_json::Value;

use super::json::{self, Obj, children, object};
use super::models::*;
use crate::transport::{Method, Reply, Request, Transport, TransportError};
use crate::url;

/// The server answered, but not with what was asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubsonicError {
    pub message: String,
    /// Subsonic's own error code, when it gave one (70: not found, 40: wrong credentials...).
    pub code: Option<i32>,
    pub http_status: Option<u16>,
}

impl SubsonicError {
    fn new(message: impl Into<String>, code: Option<i32>, http_status: Option<u16>) -> Self {
        Self {
            message: message.into(),
            code,
            http_status,
        }
    }

    /// The account or the token is not accepted (Subsonic code 40, 41 or 44, or an HTTP 401).
    pub fn is_auth_failure(&self) -> bool {
        matches!(self.code, Some(40 | 41 | 44)) || self.http_status == Some(401)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    /// Navidrome is not set up yet: nothing was sent.
    NotConfigured,
    Subsonic(SubsonicError),
    /// The request never got an answer.
    Transport(TransportError),
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => f.write_str("Navidrome n'est pas configuré"),
            Self::Subsonic(e) => f.write_str(&e.message),
            Self::Transport(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for NetError {}

impl NetError {
    /// How a failed scrobble is handled: kept for later, dropped, or tried a few more times.
    pub fn scrobble_failure(&self) -> hub_core::scrobble::Failure {
        use hub_core::scrobble::{Failure, classify_failure};
        match self {
            Self::NotConfigured | Self::Transport(_) => Failure::Outage,
            // An error in the server's answer, as the TypeScript client reported it: 401 for code 40, else 500.
            Self::Subsonic(SubsonicError {
                code: Some(code), ..
            }) => classify_failure(if *code == 40 { 401 } else { 500 }, Some(*code)),
            Self::Subsonic(e) => classify_failure(e.http_status.unwrap_or(0), None),
        }
    }
}

impl From<SubsonicError> for NetError {
    fn from(e: SubsonicError) -> Self {
        Self::Subsonic(e)
    }
}

impl From<TransportError> for NetError {
    fn from(e: TransportError) -> Self {
        Self::Transport(e)
    }
}

type LoginSource = Box<dyn Fn() -> Option<NavidromeLogin> + Send + Sync>;

/// The part of the Subsonic API the apps use. Every call signs itself with the current login, so a login that
/// changes is picked up by the next request.
pub struct SubsonicClient<T: Transport> {
    transport: T,
    client_name: &'static str,
    login: LoginSource,
}

impl<T: Transport> SubsonicClient<T> {
    /// `client_name` is [`hub_core::subsonic::CLIENT_NAME`] or [`hub_core::subsonic::WATCH_CLIENT_NAME`].
    pub fn new(
        transport: T,
        client_name: &'static str,
        login: impl Fn() -> Option<NavidromeLogin> + Send + Sync + 'static,
    ) -> Self {
        Self {
            transport,
            client_name,
            login: Box::new(login),
        }
    }

    pub async fn ping(&self) -> Result<PingInfo, NetError> {
        let started = Instant::now();
        let body = self.call("ping", &[]).await?;
        Ok(PingInfo {
            version: json::string(&body, "serverVersion")
                .or_else(|| json::string(&body, "version")),
            latency_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Every artist, flat out of the alphabetical index, with the library's change stamp.
    pub async fn artists(&self) -> Result<ArtistIndex, NetError> {
        let body = self.call("getArtists", &[]).await?;
        let artists = object(Some(&body), "artists");
        let list = children(artists, "index")
            .into_iter()
            .flat_map(|group| children(Some(group), "artist"))
            .filter_map(json::artist)
            .collect();
        Ok(ArtistIndex {
            artists: list,
            last_modified: artists.and_then(|a| json::long(a, "lastModified")),
        })
    }

    /// Subsonic's `getArtist`: the albums of one artist.
    pub async fn albums_by_artist(&self, artist_id: &str) -> Result<Vec<ApiAlbum>, NetError> {
        let body = self.call("getArtist", &[("id", artist_id)]).await?;
        Ok(children(object(Some(&body), "artist"), "album")
            .into_iter()
            .filter_map(json::album)
            .collect())
    }

    /// One page of `getAlbumList2`. `kind` is one of alphabeticalByName, newest, recent, frequent, random...
    pub async fn album_list(
        &self,
        kind: &str,
        size: u32,
        offset: u32,
    ) -> Result<Vec<ApiAlbum>, NetError> {
        let (size, offset) = (size.to_string(), offset.to_string());
        let body = self
            .call(
                "getAlbumList2",
                &[("type", kind), ("size", &size), ("offset", &offset)],
            )
            .await?;
        Ok(children(object(Some(&body), "albumList2"), "album")
            .into_iter()
            .filter_map(json::album)
            .collect())
    }

    /// Subsonic's `getAlbum`: the album and its songs.
    pub async fn songs_of_album(&self, album_id: &str) -> Result<AlbumDetail, NetError> {
        let body = self.call("getAlbum", &[("id", album_id)]).await?;
        let album = object(Some(&body), "album")
            .ok_or_else(|| SubsonicError::new("Album introuvable", Some(70), None))?;
        Ok(AlbumDetail {
            album: json::album(album)
                .ok_or_else(|| SubsonicError::new("Album illisible", None, None))?,
            songs: children(Some(album), "song")
                .into_iter()
                .filter_map(json::song)
                .collect(),
        })
    }

    /// The playlists of the signed-in account. Navidrome also lists everyone's public playlists, and every
    /// playlist of every account to an admin: each account sees only its own, as in all the apps.
    pub async fn playlists(&self) -> Result<Vec<ApiPlaylist>, NetError> {
        let body = self.call("getPlaylists", &[]).await?;
        let me = (self.login)().map(|l| l.username);
        Ok(children(object(Some(&body), "playlists"), "playlist")
            .into_iter()
            .filter_map(json::playlist)
            .filter(|p| is_own_playlist(p.owner.as_deref(), me.as_deref()))
            .collect())
    }

    pub async fn songs_of_playlist(&self, playlist_id: &str) -> Result<PlaylistDetail, NetError> {
        let body = self.call("getPlaylist", &[("id", playlist_id)]).await?;
        let playlist = object(Some(&body), "playlist")
            .ok_or_else(|| SubsonicError::new("Playlist introuvable", Some(70), None))?;
        Ok(PlaylistDetail {
            playlist: json::playlist(playlist)
                .ok_or_else(|| SubsonicError::new("Playlist illisible", None, None))?,
            songs: children(Some(playlist), "entry")
                .into_iter()
                .filter_map(json::song)
                .collect(),
        })
    }

    pub async fn search(
        &self,
        query: &str,
        artist_count: u32,
        album_count: u32,
        song_count: u32,
    ) -> Result<SearchResults, NetError> {
        let (ar, al, so) = (
            artist_count.to_string(),
            album_count.to_string(),
            song_count.to_string(),
        );
        let body = self
            .call(
                "search3",
                &[
                    ("query", query),
                    ("artistCount", &ar),
                    ("albumCount", &al),
                    ("songCount", &so),
                ],
            )
            .await?;
        let result = object(Some(&body), "searchResult3");
        Ok(SearchResults {
            artists: children(result, "artist")
                .into_iter()
                .filter_map(json::artist)
                .collect(),
            albums: children(result, "album")
                .into_iter()
                .filter_map(json::album)
                .collect(),
            songs: children(result, "song")
                .into_iter()
                .filter_map(json::song)
                .collect(),
        })
    }

    /// What everyone is playing right now, as the server sees it.
    pub async fn now_playing(&self) -> Result<Vec<NowPlayingEntry>, NetError> {
        let body = self.call("getNowPlaying", &[]).await?;
        Ok(children(object(Some(&body), "nowPlaying"), "entry")
            .into_iter()
            .filter_map(|entry| {
                Some(NowPlayingEntry {
                    song: json::song(entry)?,
                    username: json::string(entry, "username").unwrap_or_default(),
                    minutes_ago: json::int(entry, "minutesAgo").unwrap_or(0),
                    player_name: json::string(entry, "playerName"),
                })
            })
            .collect())
    }

    /// Adds a song to the favourites (Navidrome's "starred").
    pub async fn star(&self, id: &str) -> Result<(), NetError> {
        self.call("star", &[("id", id)]).await.map(|_| ())
    }

    /// A cover, resized by the server to `size` pixels square.
    pub async fn cover_art(&self, cover_id: &str, size: u32) -> Result<Vec<u8>, NetError> {
        let login = (self.login)().ok_or(NetError::NotConfigured)?;
        let size = size.to_string();
        let reply = self
            .send(&login, "getCoverArt", &[("id", cover_id), ("size", &size)])
            .await?;
        if !reply.is_success() {
            return Err(failed_request(&reply).into());
        }
        // A cover that does not exist comes back as a 200 with an error document instead of an image.
        if !reply.content_type().starts_with("image/") || reply.body.is_empty() {
            return Err(SubsonicError::new("Pas de pochette", None, Some(reply.status)).into());
        }
        Ok(reply.body)
    }

    /// The address of a call, signed, for anything that loads it itself (an audio player, an image view).
    pub fn url_for(
        &self,
        login: &NavidromeLogin,
        method: &str,
        params: &[(&str, &str)],
    ) -> Result<String, SubsonicError> {
        let base = login.base_url();
        if !url::is_http_url(&base) {
            return Err(SubsonicError::new("Adresse Navidrome invalide", None, None));
        }
        let auth = login.query_parameters(self.client_name);
        let mut all: Vec<(&str, &str)> = auth.iter().map(|(k, v)| (*k, v.as_str())).collect();
        all.extend_from_slice(params);
        Ok(format!("{base}/rest/{method}.view?{}", url::query(&all)))
    }

    async fn send(
        &self,
        login: &NavidromeLogin,
        method: &str,
        params: &[(&str, &str)],
    ) -> Result<Reply, NetError> {
        let address = self.url_for(login, method, params)?;
        let home = url::host_of(&address).is_some_and(is_home_host);
        Ok(self.transport.get(&address, home).await?)
    }

    /// A call with its parameters sent as a form rather than in the address: for a long list of songs, which in
    /// an address could pass what a proxy in front of the server accepts.
    async fn send_form(
        &self,
        login: &NavidromeLogin,
        method: &str,
        params: &[(&str, &str)],
    ) -> Result<Reply, NetError> {
        let signed = self.url_for(login, method, params)?;
        let (address, form) = signed.split_once('?').unwrap_or((&signed, ""));
        let home = url::host_of(address).is_some_and(is_home_host);
        let mut request = Request::new(Method::Post, address)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .home_network(home);
        request.body = Some(form.as_bytes().to_vec());
        Ok(self.transport.send(request).await?)
    }

    async fn call(&self, method: &str, params: &[(&str, &str)]) -> Result<Obj, NetError> {
        self.call_as(method, params, false).await
    }

    async fn call_as(
        &self,
        method: &str,
        params: &[(&str, &str)],
        form: bool,
    ) -> Result<Obj, NetError> {
        let login = (self.login)().ok_or(NetError::NotConfigured)?;
        let reply = if form {
            self.send_form(&login, method, params).await?
        } else {
            self.send(&login, method, params).await?
        };
        if !reply.is_success() {
            return Err(failed_request(&reply).into());
        }
        let invalid = || SubsonicError::new("Réponse Navidrome invalide", None, Some(reply.status));
        let Ok(Value::Object(mut root)) = serde_json::from_slice::<Value>(&reply.body) else {
            return Err(invalid().into());
        };
        let Some(Value::Object(body)) = root.remove("subsonic-response") else {
            return Err(invalid().into());
        };
        if json::string(&body, "status").as_deref() == Some("failed") {
            let error = body.get("error").and_then(Value::as_object);
            return Err(SubsonicError::new(
                error
                    .and_then(|e| json::string(e, "message"))
                    .unwrap_or_else(|| "Erreur Navidrome".into()),
                // An error the server gives no code for is code 0, as the TypeScript client read it: that is
                // how a refusal in the answer is told from a broken answer (see `NetError::scrobble_failure`).
                Some(error.and_then(|e| json::int(e, "code")).unwrap_or(0)),
                Some(reply.status),
            )
            .into());
        }
        Ok(body)
    }
}

/// The calls of the desktop's and phone's `navidrome.ts` that the watch did not use.
impl<T: Transport> SubsonicClient<T> {
    /// One artist and its albums.
    pub async fn artist(&self, id: &str) -> Result<ArtistDetail, NetError> {
        let body = self.call("getArtist", &[("id", id)]).await?;
        let artist = object(Some(&body), "artist")
            .ok_or_else(|| SubsonicError::new("Artiste introuvable", Some(70), None))?;
        Ok(ArtistDetail {
            artist: json::artist(artist)
                .ok_or_else(|| SubsonicError::new("Artiste illisible", None, None))?,
            albums: children(Some(artist), "album")
                .into_iter()
                .filter_map(json::album)
                .collect(),
        })
    }

    /// One song by id (to play a song the watch asked for).
    pub async fn song(&self, id: &str) -> Result<ApiSong, NetError> {
        let body = self.call("getSong", &[("id", id)]).await?;
        object(Some(&body), "song")
            .and_then(json::song)
            .ok_or_else(|| SubsonicError::new("Titre introuvable", Some(70), Some(404)).into())
    }

    /// Every album of the library, newest first (the server gives at most 500 at a time).
    pub async fn all_albums(&self) -> Result<Vec<ApiAlbum>, NetError> {
        const PAGE: u32 = 500;
        let mut albums = Vec::new();
        for offset in (0..).step_by(PAGE as usize) {
            let page = self.album_list("newest", PAGE, offset).await?;
            let last = page.len() < PAGE as usize;
            albums.extend(page);
            if last {
                break;
            }
        }
        Ok(albums)
    }

    /// Songs like this one, as the server works them out (Last.fm or its own tags). Often empty on a small library.
    pub async fn similar_songs(&self, id: &str, count: u32) -> Result<Vec<ApiSong>, NetError> {
        self.song_list(
            "getSimilarSongs",
            "similarSongs",
            &[("id", id), ("count", &count.to_string())],
        )
        .await
    }

    /// Songs from artists like this one.
    pub async fn similar_songs_by_artist(
        &self,
        artist_id: &str,
        count: u32,
    ) -> Result<Vec<ApiSong>, NetError> {
        self.song_list(
            "getSimilarSongs2",
            "similarSongs2",
            &[("id", artist_id), ("count", &count.to_string())],
        )
        .await
    }

    pub async fn random_songs(
        &self,
        count: u32,
        genre: Option<&str>,
    ) -> Result<Vec<ApiSong>, NetError> {
        let size = count.to_string();
        let mut params = vec![("size", size.as_str())];
        if let Some(genre) = genre.filter(|g| !g.is_empty()) {
            params.push(("genre", genre));
        }
        self.song_list("getRandomSongs", "randomSongs", &params)
            .await
    }

    /// The genres, by name whatever the case and accents.
    pub async fn genres(&self) -> Result<Vec<ApiGenre>, NetError> {
        let body = self.call("getGenres", &[]).await?;
        let mut genres: Vec<ApiGenre> = children(object(Some(&body), "genres"), "genre")
            .into_iter()
            .filter_map(json::genre)
            .collect();
        genres.sort_by(|a, b| hub_core::text::compare_names(&a.name, &b.name));
        Ok(genres)
    }

    pub async fn albums_by_genre(
        &self,
        genre: &str,
        size: u32,
        offset: u32,
    ) -> Result<Vec<ApiAlbum>, NetError> {
        let (size, offset) = (size.to_string(), offset.to_string());
        let body = self
            .call(
                "getAlbumList2",
                &[
                    ("type", "byGenre"),
                    ("genre", genre),
                    ("size", &size),
                    ("offset", &offset),
                ],
            )
            .await?;
        Ok(children(object(Some(&body), "albumList2"), "album")
            .into_iter()
            .filter_map(json::album)
            .collect())
    }

    /// A new playlist, with these songs in it.
    pub async fn create_playlist(
        &self,
        name: &str,
        song_ids: &[&str],
    ) -> Result<ApiPlaylist, NetError> {
        let mut params = vec![("name", name)];
        params.extend(song_ids.iter().map(|id| ("songId", *id)));
        let body = self.call("createPlaylist", &params).await?;
        object(Some(&body), "playlist")
            .and_then(json::playlist)
            .ok_or_else(|| SubsonicError::new("Playlist illisible", None, None).into())
    }

    /// Puts the playlist's songs in this order (the whole list: Subsonic's `createPlaylist` with an id replaces
    /// its songs). Refused for a playlist that follows an M3U file.
    pub async fn replace_playlist_songs(
        &self,
        playlist_id: &str,
        song_ids: &[&str],
    ) -> Result<(), NetError> {
        let mut params = vec![("playlistId", playlist_id)];
        params.extend(song_ids.iter().map(|id| ("songId", *id)));
        self.call_as("createPlaylist", &params, true)
            .await
            .map(|_| ())
    }

    /// Shown to every account (true) or to its owner only (false).
    pub async fn set_playlist_public(
        &self,
        playlist_id: &str,
        public: bool,
    ) -> Result<(), NetError> {
        let public = if public { "true" } else { "false" };
        self.call(
            "updatePlaylist",
            &[("playlistId", playlist_id), ("public", public)],
        )
        .await
        .map(|_| ())
    }

    pub async fn add_to_playlist(
        &self,
        playlist_id: &str,
        song_ids: &[&str],
    ) -> Result<(), NetError> {
        if song_ids.is_empty() {
            return Ok(());
        }
        let mut params = vec![("playlistId", playlist_id)];
        params.extend(song_ids.iter().map(|id| ("songIdToAdd", *id)));
        self.call("updatePlaylist", &params).await.map(|_| ())
    }

    /// `index` is the 0-based position of the entry within the playlist, not a song id.
    pub async fn remove_from_playlist(
        &self,
        playlist_id: &str,
        index: usize,
    ) -> Result<(), NetError> {
        let index = index.to_string();
        self.call(
            "updatePlaylist",
            &[("playlistId", playlist_id), ("songIndexToRemove", &index)],
        )
        .await
        .map(|_| ())
    }

    pub async fn delete_playlist(&self, playlist_id: &str) -> Result<(), NetError> {
        self.call("deletePlaylist", &[("id", playlist_id)])
            .await
            .map(|_| ())
    }

    pub async fn unstar(&self, id: &str) -> Result<(), NetError> {
        self.call("unstar", &[("id", id)]).await.map(|_| ())
    }

    /// The favourites.
    pub async fn starred(&self) -> Result<SearchResults, NetError> {
        let body = self.call("getStarred2", &[]).await?;
        let starred = object(Some(&body), "starred2");
        Ok(SearchResults {
            artists: children(starred, "artist")
                .into_iter()
                .filter_map(json::artist)
                .collect(),
            albums: children(starred, "album")
                .into_iter()
                .filter_map(json::album)
                .collect(),
            songs: children(starred, "song")
                .into_iter()
                .filter_map(json::song)
                .collect(),
        })
    }

    /// The server's own plain lyrics for a song, if it has any. Never an error: lyrics are a nicety.
    pub async fn lyrics(&self, artist: &str, title: &str) -> Option<String> {
        let body = self
            .call("getLyrics", &[("artist", artist), ("title", title)])
            .await
            .ok()?;
        object(Some(&body), "lyrics")
            .and_then(|l| json::string(l, "value"))
            .filter(|v| !v.trim().is_empty())
    }

    /// Reports a play. `submission: false` marks the song as now playing; `true` records the play, which feeds
    /// play counts and "recently played" and goes on to Last.fm/ListenBrainz if the server is set up for it.
    /// `time` is when it was played, in ms since the epoch.
    pub async fn scrobble(
        &self,
        id: &str,
        submission: bool,
        time: Option<u64>,
    ) -> Result<(), NetError> {
        let time = time.filter(|t| *t > 0).map(|t| t.to_string());
        let mut params = vec![
            ("id", id),
            ("submission", if submission { "true" } else { "false" }),
        ];
        if let Some(time) = &time {
            params.push(("time", time));
        }
        self.call("scrobble", &params).await.map(|_| ())
    }

    pub async fn scan_status(&self) -> Result<ScanStatus, NetError> {
        let body = self.call("getScanStatus", &[]).await?;
        Ok(json::scan_status(object(Some(&body), "scanStatus")))
    }

    /// Looks for new or changed files in the music folders. Needs an admin account.
    pub async fn start_scan(&self) -> Result<ScanStatus, NetError> {
        let body = self.call("startScan", &[]).await?;
        Ok(json::scan_status(object(Some(&body), "scanStatus")))
    }

    /// The song's audio; with `max_bitrate` (kbit/s) the server re-encodes it at that rate when it can (a slow
    /// network).
    pub fn stream_url(&self, song_id: &str, max_bitrate: Option<u32>) -> Result<String, NetError> {
        let login = (self.login)().ok_or(NetError::NotConfigured)?;
        let rate = max_bitrate.filter(|r| *r > 0).map(|r| r.to_string());
        let mut params = vec![("id", song_id)];
        if let Some(rate) = &rate {
            params.push(("maxBitRate", rate));
        }
        Ok(self.url_for(&login, "stream", &params)?)
    }

    /// The song's file as it is on the server, never converted (Subsonic `format=raw`): what a download keeps.
    pub fn original_url(&self, song_id: &str) -> Result<String, NetError> {
        let login = (self.login)().ok_or(NetError::NotConfigured)?;
        Ok(self.url_for(&login, "stream", &[("id", song_id), ("format", "raw")])?)
    }

    pub fn download_url(&self, id: &str) -> Result<String, NetError> {
        let login = (self.login)().ok_or(NetError::NotConfigured)?;
        Ok(self.url_for(&login, "download", &[("id", id)])?)
    }

    /// A cover's address. Every size asked for maps to 160, 320 or 640 pixels, so a cover is downloaded (and
    /// cached) at most three times; with a login made by `NavidromeLogin::stable`, the address stays the same
    /// across restarts and the image cache keeps working.
    pub fn cover_art_url(&self, cover_id: &str, size: u32) -> Result<String, NetError> {
        let login = (self.login)().ok_or(NetError::NotConfigured)?;
        let bucket = match size {
            0..=160 => "160",
            161..=320 => "320",
            _ => "640",
        };
        Ok(self.url_for(&login, "getCoverArt", &[("id", cover_id), ("size", bucket)])?)
    }

    async fn song_list(
        &self,
        method: &str,
        key: &str,
        params: &[(&str, &str)],
    ) -> Result<Vec<ApiSong>, NetError> {
        let body = self.call(method, params).await?;
        Ok(children(object(Some(&body), key), "song")
            .into_iter()
            .filter_map(json::song)
            .collect())
    }
}

fn failed_request(reply: &Reply) -> SubsonicError {
    SubsonicError::new(
        format!("Requête échouée ({})", reply.status),
        None,
        Some(reply.status),
    )
}

// The calls the desktop and phone use (navidrome.ts), against a scripted server.
#[cfg(test)]
mod library_tests {
    use std::sync::Arc;

    use hub_core::subsonic::{CLIENT_NAME, NavidromeLogin};
    use serde_json::json;

    use super::*;
    use crate::scripted::{Scripted, json as reply_json, query};
    use crate::subsonic::fake::block_on;

    const BASE: &str = "http://music.lan";

    fn client() -> (Arc<Scripted>, SubsonicClient<Arc<Scripted>>) {
        let server = Arc::new(Scripted::default());
        let client = SubsonicClient::new(server.clone(), CLIENT_NAME, || {
            Some(NavidromeLogin::stable("http://music.lan/", "ana", "sesame"))
        });
        (server, client)
    }

    fn ok(payload: Value) -> Reply {
        let mut body = payload.as_object().cloned().unwrap_or_default();
        body.insert("status".into(), "ok".into());
        reply_json(200, json!({ "subsonic-response": body }))
    }

    fn values(url: &str, name: &str) -> Vec<String> {
        query(url)
            .into_iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v)
            .collect()
    }

    #[test]
    fn a_song_carries_its_replaygain_file_type_and_favourite() {
        let (server, client) = client();
        server.on(
            Method::Get,
            &format!("{BASE}/rest/getSong.view"),
            ok(json!({ "song": { "id": "s1", "title": "T", "artist": "A", "artistId": "ar", "suffix": "flac", "starred": "2026-01-01",
                "replayGain": { "trackGain": -6.5, "albumGain": -7, "trackPeak": 0.98 } } })),
        );
        let song = block_on(client.song("s1")).unwrap();
        assert_eq!(song.suffix.as_deref(), Some("flac"));
        assert!(song.starred.is_some());
        let gain = song.replay_gain.unwrap();
        assert_eq!(
            (gain.track_gain, gain.album_gain, gain.fallback_gain),
            (Some(-6.5), Some(-7.0), None)
        );
        server.clear();
        server.on(Method::Get, BASE, ok(json!({})));
        assert!(
            matches!(block_on(client.song("nope")), Err(NetError::Subsonic(e)) if e.http_status == Some(404))
        );
    }

    #[test]
    fn playlists_are_made_and_edited_with_repeated_song_ids() {
        let (server, client) = client();
        server.on(Method::Get, &format!("{BASE}/rest/createPlaylist.view"), ok(json!({ "playlist": { "id": "new", "name": "Neuve", "owner": "ana", "public": true } })));
        let made = block_on(client.create_playlist("Neuve", &["s1", "s2"])).unwrap();
        assert_eq!((made.id.as_str(), made.public), ("new", true));
        assert_eq!(values(&server.last().url, "songId"), ["s1", "s2"]);

        server.on(
            Method::Get,
            &format!("{BASE}/rest/updatePlaylist.view"),
            ok(json!({})),
        );
        block_on(client.add_to_playlist("new", &["s3", "s4"])).unwrap();
        assert_eq!(values(&server.last().url, "songIdToAdd"), ["s3", "s4"]);
        let before = server.sent().len();
        block_on(client.add_to_playlist("new", &[])).unwrap();
        assert_eq!(server.sent().len(), before, "nothing to add: nothing sent");
        block_on(client.set_playlist_public("new", false)).unwrap();
        assert_eq!(values(&server.last().url, "public"), ["false"]);
        block_on(client.remove_from_playlist("new", 3)).unwrap();
        assert_eq!(values(&server.last().url, "songIndexToRemove"), ["3"]);
    }

    #[test]
    fn a_reordered_playlist_is_sent_as_a_form_not_in_the_address() {
        let (server, client) = client();
        server.on(
            Method::Post,
            &format!("{BASE}/rest/createPlaylist.view"),
            ok(json!({})),
        );
        let ids: Vec<String> = (0..300).map(|i| format!("song-{i}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        block_on(client.replace_playlist_songs("p1", &refs)).unwrap();
        let sent = server.last();
        assert_eq!(sent.url, format!("{BASE}/rest/createPlaylist.view"));
        assert_eq!(
            header_value(&sent, "Content-Type"),
            Some("application/x-www-form-urlencoded")
        );
        let form = format!("?{}", String::from_utf8(sent.body.unwrap()).unwrap());
        assert_eq!(values(&form, "songId").len(), 300);
        assert_eq!(values(&form, "u"), ["ana"], "the form is signed too");
    }

    fn header_value<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
        crate::scripted::header(request, name)
    }

    #[test]
    fn genres_by_name_whatever_the_case_and_accents_and_none_without_a_name() {
        let (server, client) = client();
        server.on(
            Method::Get,
            BASE,
            ok(json!({ "genres": { "genre": [{ "value": "rock", "songCount": 3 }, { "value": "Électro" }, { "value": " " }, { "value": "Ambient", "albumCount": 2 }] } })),
        );
        let names: Vec<String> = block_on(client.genres())
            .unwrap()
            .into_iter()
            .map(|g| g.name)
            .collect();
        assert_eq!(names, ["Ambient", "Électro", "rock"]);
    }

    #[test]
    fn a_play_is_reported_with_its_time_only_when_known() {
        let (server, client) = client();
        server.on(Method::Get, BASE, ok(json!({})));
        block_on(client.scrobble("s1", false, None)).unwrap();
        assert_eq!(values(&server.last().url, "submission"), ["false"]);
        assert!(values(&server.last().url, "time").is_empty());
        block_on(client.scrobble("s1", true, Some(1_790_000_000_000))).unwrap();
        assert_eq!(values(&server.last().url, "time"), ["1790000000000"]);
    }

    #[test]
    fn missing_lyrics_or_a_failure_are_simply_none() {
        let (server, client) = client();
        server.on(
            Method::Get,
            BASE,
            ok(json!({ "lyrics": { "value": "Paroles" } })),
        );
        assert_eq!(
            block_on(client.lyrics("a", "t")).as_deref(),
            Some("Paroles")
        );
        server.clear();
        server.on(Method::Get, BASE, Reply::new(500, "", Vec::new()));
        assert_eq!(block_on(client.lyrics("a", "t")), None);
    }

    #[test]
    fn media_addresses_and_cover_sizes() {
        let (_, client) = client();
        let cover = client.cover_art_url("al-1", 300).unwrap();
        assert_eq!(values(&cover, "size"), ["320"]);
        assert_eq!(
            client.cover_art_url("al-1", 100).unwrap(),
            client.cover_art_url("al-1", 160).unwrap()
        );
        assert_eq!(
            values(&client.cover_art_url("al-1", 1000).unwrap(), "size"),
            ["640"]
        );
        assert_eq!(
            values(&cover, "s"),
            [hub_core::subsonic::cover_salt("ana", "http://music.lan")],
            "a stable login keeps cover addresses the same across restarts"
        );
        assert_eq!(
            values(&client.stream_url("s1", Some(128)).unwrap(), "maxBitRate"),
            ["128"]
        );
        assert!(values(&client.stream_url("s1", None).unwrap(), "maxBitRate").is_empty());
        assert_eq!(
            values(&client.original_url("s1").unwrap(), "format"),
            ["raw"]
        );
        assert!(
            client
                .download_url("s1")
                .unwrap()
                .contains("/rest/download.view?")
        );
    }

    #[test]
    fn every_album_is_fetched_page_by_page() {
        let (server, client) = client();
        let page = |n: usize, from: usize| {
            ok(
                json!({ "albumList2": { "album": (from..from + n).map(|i| json!({ "id": format!("al-{i}") })).collect::<Vec<_>>() } }),
            )
        };
        server.on_match(
            |r| r.url.contains("offset=0&") || r.url.ends_with("offset=0"),
            page(500, 0),
        );
        server.on_match(|r| r.url.contains("offset=500"), page(12, 500));
        let all = block_on(client.all_albums()).unwrap();
        assert_eq!(all.len(), 512);
        assert_eq!(server.sent().len(), 2);
    }

    #[test]
    fn scans_and_favourites() {
        let (server, client) = client();
        server.on(
            Method::Get,
            &format!("{BASE}/rest/getScanStatus.view"),
            ok(json!({ "scanStatus": { "scanning": true, "count": 4200, "folderCount": 31 } })),
        );
        let status = block_on(client.scan_status()).unwrap();
        assert_eq!(
            (
                status.scanning,
                status.count,
                status.folder_count,
                status.last_scan
            ),
            (true, 4200, 31, None)
        );
        server.on(
            Method::Get,
            &format!("{BASE}/rest/getStarred2.view"),
            ok(json!({ "starred2": { "song": [{ "id": "s1" }], "album": { "id": "al-1" } } })),
        );
        let starred = block_on(client.starred()).unwrap();
        assert_eq!(
            (
                starred.songs.len(),
                starred.albums.len(),
                starred.artists.len()
            ),
            (1, 1, 0)
        );
    }
}

// Ported from wear/data/src/test/kotlin/com/selfhosthub/wear/data/SubsonicApiTest.kt. Its three tests about
// answers left open after a cancelled call are OkHttp-specific: here dropping the transport's future closes the
// request, which each transport must honour.
#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use hub_core::subsonic::{WATCH_CLIENT_NAME, token};

    use super::*;
    use crate::subsonic::fake::{
        FakeAlbum, FakeArtist, FakeNavidrome, FakePlaylist, FakeSong, block_on,
    };

    fn navidrome() -> Arc<FakeNavidrome> {
        let n = FakeNavidrome::default();
        {
            let mut lib = n.library.lock().unwrap();
            lib.artists.push(FakeArtist::new("ar-1", "Alt-J", 2));
            lib.artists.push(FakeArtist::new("ar-2", "Björk", 1));
            lib.artists.push(FakeArtist::new("ar-3", "Air", 1));
            lib.albums.push(FakeAlbum::new(
                "al-1",
                "An Awesome Wave",
                "Alt-J",
                "ar-1",
                2012,
                vec![
                    FakeSong::new("so-1", "Intro", "Alt-J", 1, 168),
                    FakeSong::new("so-2", "Tessellate", "Alt-J", 2, 183),
                ],
            ));
            lib.albums.push(FakeAlbum::new(
                "al-2",
                "Relaxer",
                "Alt-J",
                "ar-1",
                2017,
                vec![FakeSong::new("so-3", "3WW", "Alt-J", 1, 340)],
            ));
            lib.albums.push(FakeAlbum::new(
                "al-3",
                "Homogenic",
                "Björk",
                "ar-2",
                1997,
                vec![FakeSong::new("so-4", "Hunter", "Björk", 1, 252)],
            ));
        }
        Arc::new(n)
    }

    fn login() -> NavidromeLogin {
        NavidromeLogin {
            url: "http://navidrome.test:4533/".into(),
            username: "maxime".into(),
            salt: "c19b2d".into(),
            token: token("sesame", "c19b2d"),
        }
    }

    fn api(n: &Arc<FakeNavidrome>) -> SubsonicClient<Arc<FakeNavidrome>> {
        SubsonicClient::new(n.clone(), WATCH_CLIENT_NAME, || Some(login()))
    }

    fn subsonic_error(result: Result<impl fmt::Debug, NetError>) -> SubsonicError {
        match result {
            Err(NetError::Subsonic(e)) => e,
            other => panic!("expected a Subsonic error, got {other:?}"),
        }
    }

    #[test]
    fn every_call_is_signed_with_user_token_and_salt_and_asks_for_json() {
        let n = navidrome();
        block_on(api(&n).ping()).unwrap();
        let sent = n.requests.lock().unwrap().last().unwrap().clone();
        assert_eq!(sent.param("u"), "maxime");
        assert_eq!(sent.param("t"), login().token);
        assert_eq!(sent.param("s"), "c19b2d");
        assert_eq!(sent.param("v"), "1.16.1");
        assert_eq!(sent.param("c"), "SelfHostHubWear");
        assert_eq!(sent.param("f"), "json");
        // The password itself is never part of the request.
        assert!(!sent.url.contains("sesame"));
    }

    #[test]
    fn ping_reports_the_server_version() {
        let n = navidrome();
        assert_eq!(
            block_on(api(&n).ping()).unwrap().version.as_deref(),
            Some("0.54.5")
        );
    }

    #[test]
    fn artists_come_flat_out_of_the_alphabetical_index_with_the_stamp() {
        let n = navidrome();
        let index = block_on(api(&n).artists()).unwrap();
        let names: Vec<&str> = index.artists.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Air", "Alt-J", "Björk"]);
        assert_eq!(
            index
                .artists
                .iter()
                .find(|a| a.id == "ar-1")
                .unwrap()
                .album_count,
            2
        );
        assert_eq!(index.last_modified, Some(1_000));
    }

    #[test]
    fn a_server_that_sends_no_stamp_gives_none() {
        let n = navidrome();
        n.library.lock().unwrap().last_modified = None;
        assert_eq!(block_on(api(&n).artists()).unwrap().last_modified, None);
    }

    #[test]
    fn the_albums_of_an_artist() {
        let n = navidrome();
        let albums = block_on(api(&n).albums_by_artist("ar-1")).unwrap();
        let ids: Vec<&str> = albums.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["al-1", "al-2"]);
        assert_eq!(albums[0].year, Some(2012));
        assert_eq!(albums[0].artist_id.as_deref(), Some("ar-1"));
        assert_eq!(albums[0].song_count, 2);
    }

    #[test]
    fn album_lists_are_paged_and_sorted_as_asked() {
        let n = navidrome();
        let api = api(&n);
        let names = |albums: Vec<ApiAlbum>| albums.into_iter().map(|a| a.name).collect::<Vec<_>>();
        assert_eq!(
            names(block_on(api.album_list("alphabeticalByName", 2, 0)).unwrap()),
            ["An Awesome Wave", "Homogenic"]
        );
        assert_eq!(
            names(block_on(api.album_list("alphabeticalByName", 2, 2)).unwrap()),
            ["Relaxer"]
        );
        assert_eq!(n.calls_to("getAlbumList2"), 2);
    }

    #[test]
    fn the_songs_of_an_album() {
        let n = navidrome();
        let detail = block_on(api(&n).songs_of_album("al-1")).unwrap();
        assert_eq!(detail.album.name, "An Awesome Wave");
        let titles: Vec<&str> = detail.songs.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["Intro", "Tessellate"]);
        assert_eq!(detail.songs[0].duration, 168);
        assert_eq!(detail.songs[0].album_id.as_deref(), Some("al-1"));
        assert_eq!(detail.songs[0].cover_art.as_deref(), Some("al-1"));
    }

    #[test]
    fn an_album_that_does_not_exist_is_a_subsonic_error() {
        let n = navidrome();
        let e = subsonic_error(block_on(api(&n).songs_of_album("nope")));
        assert_eq!(e.code, Some(70));
        assert!(!e.is_auth_failure());
    }

    #[test]
    fn playlists_and_their_entries() {
        let n = navidrome();
        n.library.lock().unwrap().playlists.push(FakePlaylist::new(
            "pl-1",
            "Route",
            vec![FakeSong::new("so-9", "Titre", "Quelqu'un", 1, 200).in_album("al-1")],
            Some("maxime"),
        ));
        let api = api(&n);
        let list = block_on(api.playlists()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Route");
        assert_eq!(list[0].changed.as_deref(), Some("2026-01-01T10:00:00Z"));
        let detail = block_on(api.songs_of_playlist("pl-1")).unwrap();
        assert_eq!(
            detail
                .songs
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["so-9"]
        );
    }

    #[test]
    fn only_the_account_own_playlists_are_kept() {
        let n = navidrome();
        {
            let mut lib = n.library.lock().unwrap();
            lib.playlists
                .push(FakePlaylist::new("pl-1", "Mienne", vec![], Some("Maxime")));
            lib.playlists.push(FakePlaylist::new(
                "pl-2",
                "Celle d'Ana, publique",
                vec![],
                Some("ana"),
            ));
            lib.playlists.push(FakePlaylist::new(
                "pl-3",
                "Sans propriétaire dit",
                vec![],
                None,
            ));
        }
        let names: Vec<String> = block_on(api(&n).playlists())
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["Mienne", "Sans propriétaire dit"]);
    }

    #[test]
    fn search_gives_artists_albums_and_songs() {
        let n = navidrome();
        let api = api(&n);
        let result = block_on(api.search("a", 8, 8, 20)).unwrap();
        assert!(
            !result.artists.is_empty() && !result.albums.is_empty() && !result.songs.is_empty()
        );
        let songs = block_on(api.search("hunt", 8, 8, 20)).unwrap().songs;
        assert_eq!(
            songs.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["so-4"]
        );
    }

    #[test]
    fn a_search_with_spaces_and_accents_reaches_the_server_intact() {
        let n = navidrome();
        block_on(api(&n).search("sigur rós & co", 1, 1, 1)).unwrap();
        assert_eq!(
            n.requests.lock().unwrap().last().unwrap().param("query"),
            "sigur rós & co"
        );
    }

    #[test]
    fn now_playing_lists_what_others_are_playing() {
        let n = navidrome();
        n.library.lock().unwrap().now_playing = vec![(
            FakeSong::new("so-1", "Intro", "Alt-J", 1, 168).in_album("al-1"),
            "alice".into(),
        )];
        let entries = block_on(api(&n).now_playing()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].song.title, "Intro");
        assert_eq!(entries[0].username, "alice");
        assert_eq!(entries[0].player_name.as_deref(), Some("Phone"));
    }

    #[test]
    fn a_cover_comes_back_as_bytes() {
        let n = navidrome();
        assert_eq!(
            block_on(api(&n).cover_art("al-1", 160)).unwrap(),
            [0x42, 0x13, 0x37]
        );
        let request = n.requests.lock().unwrap().last().unwrap().clone();
        assert_eq!(request.param("size"), "160");
        assert_eq!(request.param("id"), "al-1");
    }

    #[test]
    fn a_missing_cover_is_an_error_not_an_image() {
        let n = navidrome();
        n.library.lock().unwrap().missing_covers.push("al-9".into());
        subsonic_error(block_on(api(&n).cover_art("al-9", 160)));
    }

    #[test]
    fn wrong_credentials_are_an_authentication_failure() {
        let n = navidrome();
        n.fail_with(FakeNavidrome::auth_failure());
        let e = subsonic_error(block_on(api(&n).artists()));
        assert_eq!(e.code, Some(40));
        assert!(e.is_auth_failure());
    }

    #[test]
    fn an_http_error_carries_its_status() {
        let n = navidrome();
        n.fail_with(FakeNavidrome::server_error());
        assert_eq!(
            subsonic_error(block_on(api(&n).ping())).http_status,
            Some(500)
        );
    }

    #[test]
    fn something_that_is_not_a_subsonic_answer_is_refused() {
        let n = navidrome();
        n.fail_with(Reply::new(
            200,
            "text/html",
            b"<html>proxy error</html>".to_vec(),
        ));
        subsonic_error(block_on(api(&n).ping()));
    }

    #[test]
    fn an_unreachable_server_is_a_transport_error() {
        let n = navidrome();
        n.unreachable
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(
            block_on(api(&n).ping()),
            Err(NetError::Transport(_))
        ));
    }

    #[test]
    fn without_a_login_nothing_is_sent() {
        let n = navidrome();
        let unconfigured = SubsonicClient::new(n.clone(), WATCH_CLIENT_NAME, || None);
        assert_eq!(block_on(unconfigured.ping()), Err(NetError::NotConfigured));
        assert_eq!(
            block_on(unconfigured.cover_art("al-1", 160)),
            Err(NetError::NotConfigured)
        );
        assert!(n.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn the_login_is_read_at_every_call_so_a_new_one_takes_effect_at_once() {
        let n = navidrome();
        let current: Arc<std::sync::Mutex<Option<NavidromeLogin>>> = Arc::default();
        let source = current.clone();
        let changing = SubsonicClient::new(n.clone(), WATCH_CLIENT_NAME, move || {
            source.lock().unwrap().clone()
        });
        assert_eq!(block_on(changing.ping()), Err(NetError::NotConfigured));
        *current.lock().unwrap() = Some(login());
        block_on(changing.ping()).unwrap();
        assert_eq!(n.calls_to("ping"), 1);
    }

    #[test]
    fn a_home_server_goes_through_the_home_network_any_other_does_not() {
        let n = navidrome();
        // "localhost" is a name without a dot: a home name. 127.0.0.1 is no address of a home network.
        for url in [
            "http://localhost:4533",
            "http://127.0.0.1:4533",
            "https://music.example.org",
        ] {
            let client = SubsonicClient::new(n.clone(), WATCH_CLIENT_NAME, move || {
                Some(NavidromeLogin {
                    url: url.into(),
                    ..login()
                })
            });
            block_on(client.ping()).unwrap();
        }
        let home: Vec<bool> = n
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.home_network)
            .collect();
        assert_eq!(home, [true, false, false]);
    }

    #[test]
    fn a_single_object_where_an_array_is_expected_is_read_as_a_list_of_one() {
        let n = navidrome();
        n.fail_with(Reply::new(
            200,
            "application/json",
            br#"{"subsonic-response":{"status":"ok","version":"1.16.1","playlists":{"playlist":{"id":"pl-1","name":"Seule","songCount":1}}}}"#.to_vec(),
        ));
        let names: Vec<String> = block_on(api(&n).playlists())
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["Seule"]);
    }

    #[test]
    fn an_address_that_is_not_http_is_refused_before_sending() {
        let n = navidrome();
        let client = SubsonicClient::new(n.clone(), WATCH_CLIENT_NAME, || {
            Some(NavidromeLogin {
                url: "ftp://nas".into(),
                ..login()
            })
        });
        assert_eq!(
            subsonic_error(block_on(client.ping())).message,
            "Adresse Navidrome invalide"
        );
        assert!(n.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn a_server_under_a_path_keeps_its_path() {
        let n = navidrome();
        let client = SubsonicClient::new(n.clone(), WATCH_CLIENT_NAME, || {
            Some(NavidromeLogin {
                url: "https://example.org/navidrome/".into(),
                ..login()
            })
        });
        block_on(client.ping()).unwrap();
        let url = n.requests.lock().unwrap().last().unwrap().url.clone();
        assert!(
            url.starts_with("https://example.org/navidrome/rest/ping.view?"),
            "{url}"
        );
    }
}
