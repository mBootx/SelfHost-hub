//! The player's queue: what plays next, shuffle that can be turned off again, repeat, "play next", moving and
//! removing songs, and the song radio that keeps the queue topped up.
//!
//! Port of the queue half of `mobile/src/store/navidromeStore.ts` (`playQueue`, `jumpTo`, `startRadio`,
//! `extendRadio`, `stopAtTrackEnd`, `addToQueue`, `playNext`, `removeFromQueueAt`, `reorderQueue`, `clearQueue`,
//! `next`, `prev`, `toggleShuffle`, `moveInOrder`) and of `radioNeedsMore` from `services/radio.ts`.
//!
//! What stays outside, because it is I/O: asking the server for similar songs (`hub-net::radio`), cover prefetching,
//! the audio engine's `seekTo`, logging. The queue tells its caller what is left to do through [`Followup`] and
//! [`RadioExtension`]. Randomness is injected as an `FnMut() -> f64` in `[0, 1)` (what `Math.random` is), so the
//! tests, and a saved session, can replay a shuffle.

use std::collections::HashSet;

use crate::song::SongInfo;

/// The queue is topped up once this few songs are left after the current one (same value as `hub-net::radio`).
pub const RADIO_LOW_WATER: usize = 3;

/// Whether a radio's queue has run low enough to add more.
pub fn radio_needs_more(queue_length: usize, queue_index: usize) -> bool {
    queue_length.saturating_sub(queue_index + 1) <= RADIO_LOW_WATER
}

/// What the queue needs to know about a song: only its identity. Two entries with the same id are the same song,
/// even if they are two places in the queue.
pub trait QueueSong: Clone {
    fn id(&self) -> &str;
}

impl QueueSong for SongInfo {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RepeatMode {
    #[default]
    Off,
    All,
    /// Repeating one song is the audio engine's job when a track ends; skipping still moves on.
    One,
}

/// The song radio running: what it was started from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Radio {
    pub seed_id: String,
    pub seed_title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RadioStart {
    Started,
    /// Nothing similar was found: the queue and the radio are left as they were.
    Empty,
}

/// What the caller still has to do after a queue move. The queue cannot do these itself: it holds no player and no
/// network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Followup {
    /// The song to play is the one already loaded, so nothing would restart it: seek the player to 0.
    pub seek_to_start: bool,
    /// A radio is running and the queue is low: call [`PlayQueue::begin_radio_extension`].
    pub extend_radio: bool,
}

/// A request for more radio songs, handed out by [`PlayQueue::begin_radio_extension`].
#[derive(Debug, Clone)]
pub struct RadioExtension<T> {
    radio_seed_id: String,
    /// The radio drifts: each batch is made from the last song queued.
    pub seed: T,
    /// Ids already in the queue, which the batch must not repeat.
    pub exclude: HashSet<String>,
}

/// One place in a queue. `key` tells entries apart when the same song is queued twice, and links an entry of the
/// shuffled queue to its twin in the order shuffle goes back to (the JS code compares object identity for this).
#[derive(Debug, Clone)]
struct Entry<T> {
    song: T,
    key: u64,
    /// Added with "play next": those still ahead of the song playing keep the order they were added in.
    up_next: bool,
}

/// Where a song is in a list: the same entry if it is there, else the first with its id.
fn index_in<T: QueueSong>(list: &[Entry<T>], entry: &Entry<T>) -> Option<usize> {
    list.iter()
        .position(|e| e.key == entry.key)
        .or_else(|| list.iter().position(|e| e.song.id() == entry.song.id()))
}

/// A song moved in the shuffled queue moves in the order shuffle goes back to as well: it is put right after the song
/// it now follows (first if it now leads). Otherwise turning shuffle off would undo every move made meanwhile.
fn move_in_order<T: QueueSong>(
    ordered: &[Entry<T>],
    moved: &Entry<T>,
    after: Option<&Entry<T>>,
) -> Vec<Entry<T>> {
    let Some(at) = index_in(ordered, moved) else {
        return ordered.to_vec();
    };
    let mut rest = ordered.to_vec();
    let taken = rest.remove(at);
    let anchor = after.and_then(|a| index_in(&rest, a)).map_or(0, |i| i + 1);
    rest.insert(anchor, taken);
    rest
}

/// Fisher-Yates, drawing the same numbers in the same order as the phone's loop does.
fn shuffle_in_place<E>(items: &mut [E], rng: &mut impl FnMut() -> f64) {
    for i in (1..items.len()).rev() {
        // `as usize` saturates, so a NaN or negative draw means 0; `min` covers a draw of exactly 1.0.
        let j = ((rng() * (i + 1) as f64) as usize).min(i);
        items.swap(i, j);
    }
}

/// The queue, the playing position, shuffle and repeat, and the radio, as the player's store keeps them.
#[derive(Debug, Clone)]
pub struct PlayQueue<T> {
    queue: Vec<Entry<T>>,
    /// The pre-shuffle order, kept so turning shuffle off can restore it. Only while shuffle is on.
    ordered: Option<Vec<Entry<T>>>,
    /// `None` is the phone's `-1`: nothing is playing.
    index: Option<usize>,
    shuffle: bool,
    radio: Option<Radio>,
    /// A radio adds songs only one request at a time.
    extending: bool,
    next_key: u64,
    pub repeat_mode: RepeatMode,
    pub is_playing: bool,
    /// Seconds into the current song.
    pub current_time: f64,
}

impl<T> Default for PlayQueue<T> {
    fn default() -> Self {
        Self {
            queue: Vec::new(),
            ordered: None,
            index: None,
            shuffle: false,
            radio: None,
            extending: false,
            next_key: 0,
            repeat_mode: RepeatMode::Off,
            is_playing: false,
            current_time: 0.0,
        }
    }
}

impl<T: QueueSong> PlayQueue<T> {
    pub fn new() -> Self {
        Self::default()
    }

    fn entry(&mut self, song: T, up_next: bool) -> Entry<T> {
        let key = self.next_key;
        self.next_key += 1;
        Entry { song, key, up_next }
    }

    fn entries(&mut self, songs: impl IntoIterator<Item = T>) -> Vec<Entry<T>> {
        songs.into_iter().map(|s| self.entry(s, false)).collect()
    }

    // --- reading ---

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// The songs in play order.
    pub fn songs(&self) -> impl Iterator<Item = &T> {
        self.queue.iter().map(|e| &e.song)
    }

    /// The order shuffle goes back to, while shuffle is on.
    pub fn ordered_songs(&self) -> Option<impl Iterator<Item = &T>> {
        self.ordered.as_ref().map(|o| o.iter().map(|e| &e.song))
    }

    pub fn current_index(&self) -> Option<usize> {
        self.index
    }

    pub fn current_song(&self) -> Option<&T> {
        self.index.and_then(|i| self.queue.get(i)).map(|e| &e.song)
    }

    pub fn shuffle(&self) -> bool {
        self.shuffle
    }

    pub fn radio(&self) -> Option<&Radio> {
        self.radio.as_ref()
    }

    /// Whether the entry at this place was added with "play next" (and so counts as lined up).
    pub fn is_up_next(&self, index: usize) -> bool {
        self.queue.get(index).is_some_and(|e| e.up_next)
    }

    // --- starting playback ---

    /// Plays a list from `start_index`. Starting something new while shuffle is on shuffles it too, with the song
    /// picked first. Playing by hand ends the radio.
    pub fn play_queue(&mut self, songs: Vec<T>, start_index: usize, rng: &mut impl FnMut() -> f64) {
        let entries = self.entries(songs);
        if self.shuffle {
            let mut rest = entries.clone();
            let picked = (start_index < rest.len()).then(|| rest.remove(start_index));
            shuffle_in_place(&mut rest, rng);
            self.queue = picked.into_iter().chain(rest).collect();
            self.ordered = Some(entries);
            self.index = Some(0);
        } else {
            self.queue = entries;
            self.ordered = None;
            self.index = Some(start_index);
        }
        self.is_playing = true;
        self.current_time = 0.0;
        self.radio = None;
    }

    /// Plays the song at this place in the queue, which stays as it is (its order, the radio). Out of range: nothing
    /// happens.
    pub fn jump_to(&mut self, index: usize) -> Followup {
        if index >= self.queue.len() {
            return Followup::default();
        }
        // The song already playing starts again: nothing else would reload it.
        let seek_to_start = self.index == Some(index);
        self.index = Some(index);
        self.current_time = 0.0;
        self.is_playing = true;
        Followup {
            seek_to_start,
            extend_radio: self.radio_low(index),
        }
    }

    fn radio_low(&self, index: usize) -> bool {
        self.radio.is_some() && radio_needs_more(self.queue.len(), index)
    }

    /// The Next button, and a song ending. At the end it stops, unless the whole queue repeats.
    pub fn next(&mut self) -> Followup {
        if self.queue.is_empty() {
            return Followup::default();
        }
        let mut next = self.index.map_or(0, |i| i + 1);
        if next >= self.queue.len() {
            if self.repeat_mode == RepeatMode::All {
                next = 0;
            } else {
                self.is_playing = false;
                return Followup::default();
            }
        }
        self.index = Some(next);
        self.current_time = 0.0;
        self.is_playing = true;
        Followup {
            seek_to_start: false,
            extend_radio: self.radio_low(next),
        }
    }

    /// The Previous button: restarts the song unless it is in its first seconds, and then goes back one. Shuffle
    /// reorders the queue itself, so going back walks through the songs actually heard.
    pub fn prev(&mut self) -> Followup {
        if self.queue.is_empty() {
            return Followup::default();
        }
        match self.index {
            Some(i) if i > 0 && self.current_time <= 3.0 => {
                self.index = Some(i - 1);
                self.current_time = 0.0;
                self.is_playing = true;
                Followup::default()
            }
            _ => {
                // The index stays, so nothing else would move the player: it must be seeked.
                self.current_time = 0.0;
                self.is_playing = true;
                Followup {
                    seek_to_start: true,
                    extend_radio: false,
                }
            }
        }
    }

    /// "Stop after this track": moves on to the next song, paused. With nothing after, the song just ended stays and
    /// is put back at its start.
    pub fn stop_at_track_end(&mut self) -> Followup {
        let at = self.index.map_or(0, |i| i + 1);
        let has_next = at < self.queue.len();
        if has_next {
            self.index = Some(at);
        }
        self.current_time = 0.0;
        self.is_playing = false;
        Followup {
            seek_to_start: !has_next,
            extend_radio: false,
        }
    }

    pub fn toggle_play(&mut self) {
        self.is_playing = !self.queue.is_empty() && !self.is_playing;
    }

    pub fn set_repeat_mode(&mut self, mode: RepeatMode) {
        self.repeat_mode = mode;
    }

    // --- shuffle ---

    /// Shuffle reorders the queue itself rather than picking a random song on every next, so the order played is a
    /// real sequence. The song playing stays put and leads the shuffled run: turning shuffle on never interrupts it.
    /// Turning it off restores the original order (with its additions and moves) and keeps the same song playing.
    pub fn toggle_shuffle(&mut self, rng: &mut impl FnMut() -> f64) {
        let current = self.index.and_then(|i| self.queue.get(i)).cloned();

        if !self.shuffle {
            let mut rest: Vec<Entry<T>> = self
                .queue
                .iter()
                .enumerate()
                .filter(|(i, _)| Some(*i) != self.index)
                .map(|(_, e)| e.clone())
                .collect();
            shuffle_in_place(&mut rest, rng);
            self.ordered = Some(std::mem::take(&mut self.queue));
            self.queue = current.into_iter().chain(rest).collect();
            self.index = Some(0);
            self.shuffle = true;
            return;
        }

        let restored = self
            .ordered
            .take()
            .unwrap_or_else(|| std::mem::take(&mut self.queue));
        self.index = Some(current.and_then(|c| index_in(&restored, &c)).unwrap_or(0));
        self.queue = restored;
        self.shuffle = false;
    }

    // --- editing ---

    /// Adds songs at the end. With shuffle on they also join the order shuffle goes back to, or turning it off would
    /// silently drop them.
    pub fn add_to_queue(&mut self, songs: Vec<T>) {
        let entries = self.entries(songs);
        self.append(entries);
    }

    fn append(&mut self, entries: Vec<Entry<T>>) {
        if let Some(ordered) = &mut self.ordered {
            ordered.extend(entries.iter().cloned());
        }
        self.queue.extend(entries);
    }

    /// Slots a song after the one playing, without disturbing the rest. Songs added this way line up in the order
    /// they were added: the first plays next, each later one after it. Returns how many were lined up ahead of it.
    /// On an empty queue the song starts playing.
    pub fn play_next(&mut self, song: T) -> usize {
        let entry = self.entry(song, true);
        if self.queue.is_empty() {
            self.queue = vec![entry];
            self.ordered = None;
            self.index = Some(0);
            self.is_playing = true;
            return 0;
        }
        let first = self.index.map_or(0, |i| i + 1);
        let mut at = first;
        while self.queue.get(at).is_some_and(|e| e.up_next) {
            at += 1;
        }
        if let Some(ordered) = &mut self.ordered {
            ordered.push(entry.clone());
        }
        self.queue.insert(at, entry);
        at - first
    }

    /// Takes the song at this place out. Removing the one playing moves on to what took its place (or the new last
    /// one); an emptied queue stops. Out of range: nothing happens.
    pub fn remove_from_queue_at(&mut self, index: usize) {
        if index >= self.queue.len() {
            return;
        }
        let removed = self.queue.remove(index);
        if let Some(ordered) = &mut self.ordered
            && let Some(at) = index_in(ordered, &removed)
        {
            ordered.remove(at);
        }
        if let Some(current) = self.index {
            if index == current {
                self.index = self
                    .queue
                    .len()
                    .checked_sub(1)
                    .map(|last| current.min(last));
                self.current_time = 0.0;
            } else if index < current {
                self.index = Some(current - 1);
            }
        }
        if self.queue.is_empty() {
            self.is_playing = false;
        }
    }

    /// Moves a song to another place, the song playing staying the same one. While shuffled the move is made in the
    /// original order too (see [`move_in_order`]). Out of range or no move: nothing happens.
    pub fn reorder_queue(&mut self, from: usize, to: usize) {
        let len = self.queue.len();
        if from == to || from >= len || to >= len {
            return;
        }
        let moved = self.queue.remove(from);
        self.queue.insert(to, moved.clone());
        if let Some(current) = self.index {
            self.index = Some(if from == current {
                to
            } else if from < current && to >= current {
                current - 1
            } else if from > current && to <= current {
                current + 1
            } else {
                current
            });
        }
        if let Some(ordered) = &self.ordered {
            let after = to.checked_sub(1).and_then(|i| self.queue.get(i));
            self.ordered = Some(move_in_order(ordered, &moved, after));
        }
    }

    /// Empties the queue, stops, and ends the radio.
    pub fn clear_queue(&mut self) {
        self.queue.clear();
        self.ordered = None;
        self.index = None;
        self.is_playing = false;
        self.current_time = 0.0;
        self.radio = None;
    }

    // --- song radio ---

    /// Plays the seed and then the songs found like it (the seed itself and repeats already left out, as
    /// `hub-net::radio::find_radio_songs` does). With none found nothing changes.
    pub fn start_radio(
        &mut self,
        seed: T,
        songs: Vec<T>,
        seed_title: &str,
        rng: &mut impl FnMut() -> f64,
    ) -> RadioStart {
        if songs.is_empty() {
            return RadioStart::Empty;
        }
        let seed_id = seed.id().to_owned();
        let list = std::iter::once(seed).chain(songs).collect();
        self.play_queue(list, 0, rng);
        self.radio = Some(Radio {
            seed_id,
            seed_title: seed_title.to_owned(),
        });
        RadioStart::Started
    }

    /// Starts a request for more radio songs, if one is wanted: a radio is running, a request is not already out,
    /// and there is a last song to make the batch from. Answer it with [`Self::finish_radio_extension`], or
    /// [`Self::abort_radio_extension`] if the request failed.
    pub fn begin_radio_extension(&mut self) -> Option<RadioExtension<T>> {
        let radio = self.radio.as_ref()?;
        if self.extending {
            return None;
        }
        let seed = self.queue.last()?.song.clone();
        let exclude = self.queue.iter().map(|e| e.song.id().to_owned()).collect();
        let radio_seed_id = radio.seed_id.clone();
        self.extending = true;
        Some(RadioExtension {
            radio_seed_id,
            seed,
            exclude,
        })
    }

    /// Adds the batch, unless another radio, or something played by hand, took over while it was loading. Returns
    /// whether it was added.
    pub fn finish_radio_extension(&mut self, request: RadioExtension<T>, songs: Vec<T>) -> bool {
        self.extending = false;
        let same_radio = self
            .radio
            .as_ref()
            .is_some_and(|r| r.seed_id == request.radio_seed_id);
        if songs.is_empty() || !same_radio {
            return false;
        }
        self.add_to_queue(songs);
        true
    }

    /// The request failed: the next skip tries again.
    pub fn abort_radio_extension(&mut self) {
        self.extending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str) -> SongInfo {
        SongInfo {
            id: id.into(),
            title: format!("Title {id}"),
            artist: "Artist".into(),
            duration: 100.0,
            ..SongInfo::default()
        }
    }

    fn songs(ids: &[&str]) -> Vec<SongInfo> {
        ids.iter().map(|id| song(id)).collect()
    }

    /// A draw that always picks the first place: a fixed, known shuffle.
    fn first() -> impl FnMut() -> f64 {
        || 0.0
    }

    /// A queue in a given state, like `store.setState` in the JS tests. With `ordered`, the queue's entries are
    /// the same ones as in that order (as the phone keeps them), and shuffle is on.
    fn state(
        queue: &[&str],
        ordered: Option<&[&str]>,
        index: Option<usize>,
    ) -> PlayQueue<SongInfo> {
        let mut q = PlayQueue::new();
        match ordered {
            Some(ordered) => {
                let entries = q.entries(songs(ordered));
                // A song listed twice takes each of its two entries once.
                let mut used = HashSet::new();
                q.queue = queue
                    .iter()
                    .map(|id| {
                        let e = entries
                            .iter()
                            .find(|e| e.song.id == *id && !used.contains(&e.key))
                            .unwrap();
                        used.insert(e.key);
                        e.clone()
                    })
                    .collect();
                q.ordered = Some(entries);
                q.shuffle = true;
            }
            None => q.queue = q.entries(songs(queue)),
        }
        q.index = index;
        q
    }

    fn ids(q: &PlayQueue<SongInfo>) -> Vec<&str> {
        q.songs().map(|s| s.id.as_str()).collect()
    }

    fn ordered_ids(q: &PlayQueue<SongInfo>) -> Vec<&str> {
        q.ordered_songs().unwrap().map(|s| s.id.as_str()).collect()
    }

    /// What the radio's server call does with a batch: no song already queued, as `find_radio_songs` filters.
    fn fresh(request: &RadioExtension<SongInfo>, found: &[&str]) -> Vec<SongInfo> {
        songs(found)
            .into_iter()
            .filter(|s| !request.exclude.contains(&s.id))
            .collect()
    }

    #[test]
    fn a_radio_plays_the_song_first_and_then_the_songs_like_it() {
        let mut q = PlayQueue::new();
        let result = q.start_radio(song("a"), songs(&["b", "c"]), "Title a", &mut first());
        assert_eq!(result, RadioStart::Started);
        assert_eq!(ids(&q), ["a", "b", "c"]);
        assert_eq!((q.current_index(), q.is_playing), (Some(0), true));
        assert_eq!(
            q.radio(),
            Some(&Radio {
                seed_id: "a".into(),
                seed_title: "Title a".into()
            })
        );
    }

    #[test]
    fn a_song_with_nothing_similar_does_not_start_a_radio_or_touch_the_queue() {
        let mut q = state(&["x"], None, Some(0));
        let result = q.start_radio(song("a"), vec![], "Title a", &mut first());
        assert_eq!(result, RadioStart::Empty);
        assert_eq!(ids(&q), ["x"]);
        assert_eq!(q.radio(), None);
    }

    #[test]
    fn skipping_towards_the_end_of_a_radio_adds_more_songs_like_the_last_one_without_repeats() {
        let mut q = PlayQueue::new();
        q.start_radio(song("a"), songs(&["b", "c", "d"]), "Title a", &mut first());
        assert_eq!(ids(&q), ["a", "b", "c", "d"]);
        // On "b": 2 songs left after it, which is low.
        assert!(q.next().extend_radio);
        let request = q.begin_radio_extension().unwrap();
        assert_eq!(request.seed.id, "d", "asked for songs like the last one");
        // The server answers d, e, f, a: those already queued are left out.
        let batch = fresh(&request, &["d", "e", "f", "a"]);
        assert!(q.finish_radio_extension(request, batch));
        assert_eq!(ids(&q), ["a", "b", "c", "d", "e", "f"]);
        assert!(q.radio().is_some());
    }

    #[test]
    fn while_a_batch_is_being_fetched_skipping_again_does_not_ask_twice() {
        let mut q = PlayQueue::new();
        q.start_radio(song("a"), songs(&["b", "c"]), "Title a", &mut first());
        let mut asked = 0;
        let mut pending = None;
        for _ in 0..2 {
            if q.next().extend_radio
                && let Some(request) = q.begin_radio_extension()
            {
                asked += 1;
                // Its answer has not come yet.
                pending = Some(request);
            }
        }
        assert_eq!(asked, 1);
        assert!(q.finish_radio_extension(pending.unwrap(), songs(&["x", "y"])));
        assert_eq!(ids(&q), ["a", "b", "c", "x", "y"]);
    }

    #[test]
    fn playing_something_by_hand_ends_the_radio_and_so_does_emptying_the_queue() {
        let mut q = PlayQueue::new();
        q.start_radio(song("a"), songs(&["b", "c"]), "Title a", &mut first());
        q.play_queue(songs(&["p", "q"]), 0, &mut first());
        assert_eq!(q.radio(), None);
        q.start_radio(song("a"), songs(&["b", "c"]), "Title a", &mut first());
        q.clear_queue();
        assert_eq!(q.radio(), None);
    }

    #[test]
    fn a_batch_that_arrives_after_another_radio_started_is_thrown_away() {
        let mut q = PlayQueue::new();
        q.start_radio(song("a"), songs(&["b", "c"]), "Title a", &mut first());
        // Low on songs: asks for more, like the last one ("c"), and waits.
        assert!(q.next().extend_radio);
        let request = q.begin_radio_extension().unwrap();
        assert_eq!(request.seed.id, "c");
        // A different radio takes over meanwhile.
        q.start_radio(song("z"), songs(&["z1", "z2"]), "Title z", &mut first());
        let added = q.finish_radio_extension(request, songs(&["late1", "late2"]));
        assert!(!added);
        assert_eq!(
            ids(&q),
            ["z", "z1", "z2"],
            "the late batch of the first radio was dropped"
        );
        assert_eq!(q.radio().unwrap().seed_id, "z");
        // The request is answered, so the new radio can ask in its turn.
        assert!(q.begin_radio_extension().is_some());
    }

    #[test]
    fn stopping_after_a_track_moves_on_to_the_next_one_paused() {
        let mut q = state(&["a", "b"], None, Some(0));
        q.is_playing = true;
        q.current_time = 90.0;
        let followup = q.stop_at_track_end();
        assert_eq!(
            (q.current_index(), q.is_playing, q.current_time),
            (Some(1), false, 0.0)
        );
        assert!(
            !followup.seek_to_start,
            "nothing to rewind: the next track starts from its beginning"
        );
    }

    #[test]
    fn stopping_after_the_last_track_stays_on_it_paused_and_back_at_its_start() {
        let mut q = state(&["a", "b"], None, Some(1));
        q.is_playing = true;
        q.current_time = 99.0;
        let followup = q.stop_at_track_end();
        assert_eq!((q.current_index(), q.is_playing), (Some(1), false));
        assert!(followup.seek_to_start);
    }

    #[test]
    fn a_tap_in_the_queue_plays_that_song_and_leaves_the_shuffled_order_and_the_radio_alone() {
        let mut q = state(&["a", "b", "c", "d"], Some(&["d", "c", "b", "a"]), Some(0));
        q.radio = Some(Radio {
            seed_id: "a".into(),
            seed_title: "A".into(),
        });
        q.current_time = 42.0;
        q.jump_to(2);
        assert_eq!(
            ids(&q),
            ["a", "b", "c", "d"],
            "the queue is not shuffled again"
        );
        assert_eq!(
            (q.current_index(), q.is_playing, q.current_time),
            (Some(2), true, 0.0)
        );
        assert_eq!(
            ordered_ids(&q),
            ["d", "c", "b", "a"],
            "the order to go back to is kept"
        );
        assert_eq!(q.radio().unwrap().seed_id, "a", "the radio keeps going");
        assert!(q.jump_to(2).seek_to_start, "the song playing starts again");
        assert_eq!(q.jump_to(9), Followup::default());
        assert_eq!(q.current_index(), Some(2), "out of range: nothing happens");
    }

    #[test]
    fn songs_added_with_play_next_line_up_in_the_order_they_were_added() {
        let mut q = state(&["a", "b", "c"], None, Some(0));
        q.is_playing = true;
        assert_eq!(q.play_next(song("x")), 0, "the first plays next");
        assert_eq!(q.play_next(song("y")), 1, "the second after it");
        assert_eq!(q.play_next(song("z")), 2);
        assert_eq!(ids(&q), ["a", "x", "y", "z", "b", "c"]);
        // Once the first of them plays, a new one still goes after those left.
        q.next();
        assert_eq!(q.play_next(song("w")), 2);
        assert_eq!(ids(&q), ["a", "x", "y", "z", "w", "b", "c"]);

        // A song that is in the queue already, but not added this way, is not counted as one of them.
        let mut q = state(&["a", "b"], None, Some(0));
        q.play_next(song("b"));
        assert_eq!(ids(&q), ["a", "b", "b"]);
        q.play_next(song("c"));
        assert_eq!(ids(&q), ["a", "b", "c", "b"]);

        // An empty queue starts playing the song.
        let mut q = PlayQueue::new();
        q.play_next(song("q"));
        assert_eq!(
            (ids(&q), q.current_index(), q.is_playing),
            (vec!["q"], Some(0), true)
        );
    }

    #[test]
    fn a_song_moved_while_shuffled_keeps_its_move_when_shuffle_is_turned_off() {
        let album = ["1", "2", "3", "4", "5", "6"];
        let mut q = state(&["5", "2", "6", "1", "4", "3"], Some(&album), Some(0));
        // "6" is moved right after the song playing ("5").
        q.reorder_queue(2, 1);
        assert_eq!(ids(&q), ["5", "6", "2", "1", "4", "3"]);
        q.toggle_shuffle(&mut first());
        assert_eq!(ids(&q), ["1", "2", "3", "4", "5", "6"]);
        assert_eq!(
            q.current_song().unwrap().id,
            "5",
            "the song playing stays the one playing"
        );

        // Moved to the very top, it leads the order shuffle goes back to.
        let mut q = state(&["3", "1", "2"], Some(&["1", "2", "3"]), Some(0));
        q.reorder_queue(2, 0);
        q.toggle_shuffle(&mut first());
        assert_eq!(ids(&q), ["2", "1", "3"]);
    }

    // The tests below have no JS counterpart in queue.test.js: they cover queue rules of the store that the
    // phone's other suites only reach through the UI.

    #[test]
    fn shuffling_keeps_the_song_playing_first_and_turning_it_off_restores_the_order() {
        let mut q = state(&["a", "b", "c", "d", "e"], None, Some(2));
        q.toggle_shuffle(&mut first());
        assert!(q.shuffle());
        // "c" leads; the rest is [a, b, d, e] shuffled by always swapping with the first place.
        assert_eq!(ids(&q), ["c", "b", "d", "e", "a"]);
        assert_eq!(q.current_index(), Some(0));
        assert_eq!(ordered_ids(&q), ["a", "b", "c", "d", "e"]);
        q.toggle_shuffle(&mut first());
        assert!(!q.shuffle());
        assert_eq!(ids(&q), ["a", "b", "c", "d", "e"]);
        assert_eq!(q.current_index(), Some(2));
        assert_eq!(q.ordered_songs().map(|_| ()), None);
    }

    #[test]
    fn a_shuffle_draws_from_the_given_numbers() {
        let mut q = PlayQueue::new();
        q.shuffle = true;
        let mut draws = [0.99, 0.0, 0.5].into_iter();
        q.play_queue(songs(&["a", "b", "c", "d"]), 1, &mut || {
            draws.next().unwrap()
        });
        // "b" first; [a, c, d]: i=2 draws 0.99 -> j=2, i=1 draws 0.0 -> j=0, so [c, a, d].
        assert_eq!(ids(&q), ["b", "c", "a", "d"]);
        assert_eq!(ordered_ids(&q), ["a", "b", "c", "d"]);
        assert_eq!(q.current_index(), Some(0));
        // A draw of exactly 1.0 stays in range (it picks the last place, so nothing moves).
        let mut items = [1, 2, 3];
        shuffle_in_place(&mut items, &mut || 1.0);
        assert_eq!(items, [1, 2, 3]);
    }

    #[test]
    fn songs_added_while_shuffled_survive_turning_shuffle_off() {
        let mut q = state(&["a", "b", "c"], None, Some(0));
        q.toggle_shuffle(&mut first());
        q.add_to_queue(songs(&["x"]));
        q.play_next(song("y"));
        q.toggle_shuffle(&mut first());
        assert_eq!(ids(&q), ["a", "b", "c", "x", "y"]);
    }

    #[test]
    fn next_stops_at_the_end_unless_the_queue_repeats() {
        let mut q = state(&["a", "b"], None, Some(1));
        q.is_playing = true;
        q.next();
        assert_eq!((q.current_index(), q.is_playing), (Some(1), false));
        q.set_repeat_mode(RepeatMode::One);
        q.is_playing = true;
        q.next();
        assert_eq!((q.current_index(), q.is_playing), (Some(1), false));
        q.set_repeat_mode(RepeatMode::All);
        q.current_time = 50.0;
        q.next();
        assert_eq!(
            (q.current_index(), q.is_playing, q.current_time),
            (Some(0), true, 0.0)
        );
        assert_eq!(PlayQueue::<SongInfo>::new().next(), Followup::default());
    }

    #[test]
    fn previous_restarts_a_song_past_its_first_seconds_and_else_goes_back() {
        let mut q = state(&["a", "b", "c"], None, Some(2));
        q.current_time = 10.0;
        assert!(q.prev().seek_to_start);
        assert_eq!((q.current_index(), q.current_time), (Some(2), 0.0));
        q.current_time = 2.0;
        assert!(!q.prev().seek_to_start);
        assert_eq!(q.current_index(), Some(1));
        q.prev();
        assert_eq!(q.current_index(), Some(0));
        assert!(q.prev().seek_to_start, "on the first song it restarts");
        assert_eq!(q.current_index(), Some(0));
    }

    #[test]
    fn removing_songs_keeps_the_playing_one_and_the_shuffled_order_in_step() {
        let mut q = state(&["c", "a", "b"], Some(&["a", "b", "c"]), Some(1));
        q.is_playing = true;
        q.remove_from_queue_at(0);
        assert_eq!(ids(&q), ["a", "b"]);
        assert_eq!(
            q.current_index(),
            Some(0),
            "one before the playing song: it moves up"
        );
        assert_eq!(ordered_ids(&q), ["a", "b"]);
        q.current_time = 30.0;
        q.remove_from_queue_at(0);
        assert_eq!(ids(&q), ["b"]);
        assert_eq!((q.current_index(), q.current_time), (Some(0), 0.0));
        q.remove_from_queue_at(5);
        assert_eq!(ids(&q), ["b"], "out of range: nothing happens");
        q.remove_from_queue_at(0);
        assert!(q.is_empty());
        assert_eq!((q.current_index(), q.is_playing), (None, false));
    }

    #[test]
    fn removing_the_last_song_while_it_plays_moves_to_the_new_last() {
        let mut q = state(&["a", "b", "c"], None, Some(2));
        q.remove_from_queue_at(2);
        assert_eq!(q.current_index(), Some(1));
    }

    #[test]
    fn moving_songs_keeps_the_playing_one_the_same() {
        let mut q = state(&["a", "b", "c", "d"], None, Some(1));
        q.reorder_queue(3, 0);
        assert_eq!(ids(&q), ["d", "a", "b", "c"]);
        assert_eq!(q.current_song().unwrap().id, "b");
        q.reorder_queue(0, 3);
        assert_eq!(ids(&q), ["a", "b", "c", "d"]);
        assert_eq!(q.current_song().unwrap().id, "b");
        q.reorder_queue(1, 3);
        assert_eq!(ids(&q), ["a", "c", "d", "b"]);
        assert_eq!(q.current_song().unwrap().id, "b");
        q.reorder_queue(1, 1);
        q.reorder_queue(0, 9);
        assert_eq!(
            ids(&q),
            ["a", "c", "d", "b"],
            "no move, or out of range: nothing happens"
        );
    }

    #[test]
    fn a_song_queued_twice_moves_as_the_entry_that_was_moved() {
        // The shuffled queue holds the same song twice: moving the second one moves that one in the order too.
        let mut q = state(&["x", "a", "x"], Some(&["x", "a", "x"]), Some(0));
        q.reorder_queue(2, 1);
        assert_eq!(ids(&q), ["x", "x", "a"]);
        assert_eq!(ordered_ids(&q), ["x", "x", "a"]);
    }

    #[test]
    fn radio_asks_for_more_when_three_or_fewer_songs_are_left() {
        assert!(!radio_needs_more(30, 0));
        assert!(!radio_needs_more(30, 25));
        assert!(radio_needs_more(30, 26));
        assert!(radio_needs_more(1, 0));
        assert!(radio_needs_more(0, 0));
    }

    #[test]
    fn a_failed_radio_request_lets_the_next_skip_ask_again() {
        let mut q = PlayQueue::new();
        q.start_radio(song("a"), songs(&["b"]), "Title a", &mut first());
        assert!(q.begin_radio_extension().is_some());
        assert!(q.begin_radio_extension().is_none());
        q.abort_radio_extension();
        assert!(q.begin_radio_extension().is_some());
    }

    #[test]
    fn nothing_is_asked_without_a_radio() {
        let mut q = state(&["a", "b"], None, Some(0));
        assert!(!q.next().extend_radio);
        assert!(q.begin_radio_extension().is_none());
    }
}
