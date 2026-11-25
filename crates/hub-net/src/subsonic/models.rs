#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiArtist {
    pub id: String,
    pub name: String,
    pub album_count: i32,
    pub cover_art: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiAlbum {
    pub id: String,
    pub name: String,
    pub artist: String,
    pub artist_id: Option<String>,
    pub cover_art: Option<String>,
    pub song_count: i32,
    /// Seconds.
    pub duration: i32,
    pub year: Option<i32>,
    pub created: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ApiSong {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artist_id: Option<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub cover_art: Option<String>,
    /// Seconds.
    pub duration: i32,
    pub track: Option<i32>,
    /// When it was added to the favourites, if it is one.
    pub starred: Option<String>,
    pub genre: Option<String>,
    pub replay_gain: Option<ReplayGain>,
    /// The file's extension on the server (mp3, flac...).
    pub suffix: Option<String>,
}

pub use hub_core::music::ReplayGain;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiPlaylist {
    pub id: String,
    pub name: String,
    pub song_count: i32,
    /// Seconds.
    pub duration: i32,
    pub changed: Option<String>,
    pub cover_art: Option<String>,
    /// The account it belongs to (Navidrome says so; an older server may not).
    pub owner: Option<String>,
    /// Shown to every account of the server, not only to its owner.
    pub public: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiGenre {
    pub name: String,
    pub song_count: i32,
    pub album_count: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtistDetail {
    pub artist: ApiArtist,
    pub albums: Vec<ApiAlbum>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScanStatus {
    pub scanning: bool,
    /// Songs in the library.
    pub count: i64,
    pub folder_count: i64,
    pub last_scan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtistIndex {
    pub artists: Vec<ApiArtist>,
    /// The library's change stamp, when the server gives one.
    pub last_modified: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AlbumDetail {
    pub album: ApiAlbum,
    pub songs: Vec<ApiSong>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlaylistDetail {
    pub playlist: ApiPlaylist,
    pub songs: Vec<ApiSong>,
}

/// What a search found, or the favourites (`getStarred2`).
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResults {
    pub artists: Vec<ApiArtist>,
    pub albums: Vec<ApiAlbum>,
    pub songs: Vec<ApiSong>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PingInfo {
    pub version: Option<String>,
    pub latency_ms: u64,
}

/// A song someone is playing right now on any of their devices, as the server sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct NowPlayingEntry {
    pub song: ApiSong,
    pub username: String,
    pub minutes_ago: i32,
    pub player_name: Option<String>,
}
