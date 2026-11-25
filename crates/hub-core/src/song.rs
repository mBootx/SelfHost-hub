/// A song as the shared logic needs it: enough to show it and to play it again.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SongInfo {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artist_id: Option<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub cover_art: Option<String>,
    /// Seconds.
    pub duration: f64,
}
