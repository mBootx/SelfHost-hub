//! The song radio: songs to play after a seed song, from the server.
//!
//! Port of `mobile/src/services/radio.ts`.

use std::collections::HashSet;
use std::future::Future;

use crate::subsonic::{ApiSong, NetError, SubsonicClient};
use crate::transport::Transport;

/// How many songs a radio starts with, and how many are added each time it runs low.
pub const RADIO_BATCH: usize = 30;
/// The queue is topped up once this few songs are left after the current one.
pub const RADIO_LOW_WATER: usize = 3;

/// What the radio needs from the server; the Subsonic client has all of it.
pub trait RadioSource {
    fn similar_songs(
        &self,
        id: &str,
        count: u32,
    ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>>;
    fn similar_songs_by_artist(
        &self,
        artist_id: &str,
        count: u32,
    ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>>;
    fn random_songs(
        &self,
        count: u32,
        genre: Option<&str>,
    ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>>;
}

impl<T: Transport> RadioSource for SubsonicClient<T> {
    fn similar_songs(
        &self,
        id: &str,
        count: u32,
    ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>> {
        SubsonicClient::similar_songs(self, id, count)
    }

    fn similar_songs_by_artist(
        &self,
        artist_id: &str,
        count: u32,
    ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>> {
        SubsonicClient::similar_songs_by_artist(self, artist_id, count)
    }

    fn random_songs(
        &self,
        count: u32,
        genre: Option<&str>,
    ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>> {
        SubsonicClient::random_songs(self, count, genre)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RadioKind {
    Similar,
    Artist,
    Genre,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Radio {
    pub songs: Vec<ApiSong>,
    /// The first source that gave anything: what to call the radio. `None` when nothing was found.
    pub kind: Option<RadioKind>,
}

/// Songs to play after `seed`: the ones the server finds similar to it; if that is not enough, songs from artists
/// like its artist; if still not, random songs of its genre. Never the seed, nothing in `exclude`, nothing twice. A
/// server without one of these calls (or with nothing to say) gives no songs from it, not an error.
pub async fn find_radio_songs(
    source: &impl RadioSource,
    seed: &ApiSong,
    count: usize,
    exclude: &HashSet<String>,
) -> Radio {
    let mut seen: HashSet<String> = exclude.clone();
    seen.insert(seed.id.clone());
    let mut radio = Radio {
        songs: Vec::new(),
        kind: None,
    };
    let asked = count as u32;
    let found = source.similar_songs(&seed.id, asked).await;
    take(found, RadioKind::Similar, &mut radio, &mut seen, count);
    if radio.songs.len() < count
        && let Some(artist) = seed.artist_id.as_deref()
    {
        let found = source.similar_songs_by_artist(artist, asked).await;
        take(found, RadioKind::Artist, &mut radio, &mut seen, count);
    }
    if radio.songs.len() < count {
        let genre = seed.genre.as_deref().filter(|g| !g.is_empty());
        let found = source
            .random_songs((count + seen.len()) as u32, genre)
            .await;
        take(found, RadioKind::Genre, &mut radio, &mut seen, count);
    }
    radio
}

fn take(
    found: Result<Vec<ApiSong>, NetError>,
    from: RadioKind,
    radio: &mut Radio,
    seen: &mut HashSet<String>,
    count: usize,
) {
    for song in found.unwrap_or_default() {
        if radio.songs.len() >= count {
            return;
        }
        if song.id.is_empty() || !seen.insert(song.id.clone()) {
            continue;
        }
        radio.songs.push(song);
        radio.kind.get_or_insert(from);
    }
}

/// Whether a radio's queue has run low enough to add more.
pub fn radio_needs_more(queue_length: usize, queue_index: usize) -> bool {
    queue_length.saturating_sub(queue_index + 1) <= RADIO_LOW_WATER
}

// Ported from the radio part of mobile/tests/music.test.js.
#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::future::ready;

    use super::*;
    use crate::subsonic::SubsonicError;
    use crate::subsonic::fake::block_on;

    #[derive(Default)]
    struct Source {
        similar: Option<Vec<ApiSong>>,
        artist: Option<Vec<ApiSong>>,
        random: Option<Vec<ApiSong>>,
        calls: RefCell<Vec<(&'static str, String, Option<String>)>>,
    }

    fn answer(part: &Option<Vec<ApiSong>>) -> Result<Vec<ApiSong>, NetError> {
        part.clone().ok_or_else(|| {
            NetError::Subsonic(SubsonicError {
                message: "no such call".into(),
                code: Some(0),
                http_status: Some(200),
            })
        })
    }

    impl RadioSource for Source {
        fn similar_songs(
            &self,
            id: &str,
            count: u32,
        ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>> {
            self.calls
                .borrow_mut()
                .push(("similar", id.into(), Some(count.to_string())));
            ready(answer(&self.similar))
        }

        fn similar_songs_by_artist(
            &self,
            artist_id: &str,
            count: u32,
        ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>> {
            self.calls
                .borrow_mut()
                .push(("artist", artist_id.into(), Some(count.to_string())));
            ready(answer(&self.artist))
        }

        fn random_songs(
            &self,
            count: u32,
            genre: Option<&str>,
        ) -> impl Future<Output = Result<Vec<ApiSong>, NetError>> {
            self.calls
                .borrow_mut()
                .push(("random", count.to_string(), genre.map(Into::into)));
            ready(answer(&self.random))
        }
    }

    fn song(id: &str) -> ApiSong {
        ApiSong {
            id: id.into(),
            title: id.into(),
            duration: 100,
            ..Default::default()
        }
    }

    fn seed(artist: Option<&str>, genre: Option<&str>) -> ApiSong {
        ApiSong {
            artist_id: artist.map(Into::into),
            genre: genre.map(Into::into),
            ..song("seed")
        }
    }

    fn ids(radio: &Radio) -> Vec<&str> {
        radio.songs.iter().map(|s| s.id.as_str()).collect()
    }

    fn sources_asked(source: &Source) -> Vec<&'static str> {
        source.calls.borrow().iter().map(|c| c.0).collect()
    }

    #[test]
    fn the_radio_is_the_similar_songs_without_the_seed_or_doubles() {
        let source = Source {
            similar: Some(vec![
                song("seed"),
                song("a"),
                song("b"),
                song("a"),
                song("c"),
            ]),
            ..Default::default()
        };
        let radio = block_on(find_radio_songs(
            &source,
            &seed(Some("art"), Some("Rock")),
            3,
            &HashSet::new(),
        ));
        assert_eq!(ids(&radio), ["a", "b", "c"]);
        assert_eq!(radio.kind, Some(RadioKind::Similar));
        assert_eq!(
            sources_asked(&source),
            ["similar"],
            "enough: nothing else is asked"
        );
    }

    #[test]
    fn too_few_similar_songs_are_filled_by_like_artists_then_the_genre() {
        let source = Source {
            similar: Some(vec![song("a")]),
            artist: Some(vec![song("b"), song("a")]),
            random: Some(vec![song("c"), song("d"), song("b")]),
            ..Default::default()
        };
        let radio = block_on(find_radio_songs(
            &source,
            &seed(Some("art"), Some("Rock")),
            4,
            &HashSet::new(),
        ));
        assert_eq!(ids(&radio), ["a", "b", "c", "d"]);
        assert_eq!(
            radio.kind,
            Some(RadioKind::Similar),
            "named after the first source that gave anything"
        );
        assert_eq!(sources_asked(&source), ["similar", "artist", "random"]);
        assert_eq!(source.calls.borrow()[2].2.as_deref(), Some("Rock"));
    }

    #[test]
    fn a_server_without_similar_songs_still_gives_a_radio_from_the_genre_or_anything() {
        let no_similar = Source {
            random: Some(vec![song("r1"), song("r2")]),
            ..Default::default()
        };
        let radio = block_on(find_radio_songs(
            &no_similar,
            &seed(Some("art"), Some("Jazz")),
            RADIO_BATCH,
            &HashSet::new(),
        ));
        assert_eq!(ids(&radio), ["r1", "r2"]);
        assert_eq!(radio.kind, Some(RadioKind::Genre));
        let anything = Source {
            similar: Some(vec![]),
            random: Some(vec![song("r1")]),
            ..Default::default()
        };
        block_on(find_radio_songs(
            &anything,
            &seed(None, None),
            RADIO_BATCH,
            &HashSet::new(),
        ));
        assert_eq!(
            anything
                .calls
                .borrow()
                .iter()
                .find(|c| c.0 == "random")
                .unwrap()
                .2,
            None
        );
        assert!(
            !sources_asked(&anything).contains(&"artist"),
            "no artist known: that step is skipped"
        );
    }

    #[test]
    fn nothing_known_is_an_empty_radio_not_an_error() {
        let radio = block_on(find_radio_songs(
            &Source::default(),
            &seed(None, None),
            RADIO_BATCH,
            &HashSet::new(),
        ));
        assert_eq!(
            radio,
            Radio {
                songs: vec![],
                kind: None
            }
        );
    }

    #[test]
    fn songs_already_queued_are_not_added_again_and_songs_without_id_are_ignored() {
        let source = Source {
            similar: Some(vec![song("a"), song(""), song("b"), song("c")]),
            ..Default::default()
        };
        let exclude: HashSet<String> = ["a".to_owned(), "c".to_owned()].into();
        assert_eq!(
            ids(&block_on(find_radio_songs(
                &source,
                &seed(None, None),
                10,
                &exclude
            ))),
            ["b"]
        );
    }

    #[test]
    fn a_radio_asks_for_more_when_few_songs_are_left() {
        assert!(!radio_needs_more(30, 0));
        assert!(!radio_needs_more(30, 25));
        assert!(radio_needs_more(30, 26));
        assert!(radio_needs_more(30, 29));
        assert!(radio_needs_more(1, 0));
    }
}
