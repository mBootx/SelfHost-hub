//! Reporting plays to Navidrome, so play counts and "recently played" follow the user from one device to another
//! (and on to Last.fm/ListenBrainz if the server forwards them). Like Last.fm, a song counts once it has been heard
//! for half its length or 4 minutes, whichever comes first. Plays that cannot be sent (offline songs, server
//! down) are kept and go out with the next one.
//!
//! Port of `mobile/src/services/scrobbler.ts`, split into the listening tracker (which says when to announce and
//! when to record a play) and the outbox (which sends the recorded plays and decides what to keep). The app wires
//! them to its player and its Navidrome client.

use std::future::Future;

const MIN_DURATION_S: f64 = 30.0;
const MAX_REQUIRED_S: f64 = 240.0;
/// The most plays kept waiting; the oldest go first.
pub const MAX_PENDING: usize = 500;
/// A play the server fails on without saying why is tried this many times in all, then given up on.
pub const MAX_TRIES: u32 = 5;
/// A bigger jump between two progress ticks is a seek, not listening.
pub const MAX_TICK_S: f64 = 3.0;

/// Whether `listened` seconds of a song `duration` seconds long make a play (also the weekly recap's rule).
pub fn counts_as_play(listened: f64, duration: f64) -> bool {
    duration >= MIN_DURATION_S && listened >= (duration / 2.0).min(MAX_REQUIRED_S)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The server cannot be reached, a proxy in front of it is down, or the login is no good right now: keep
    /// every waiting play and try again later.
    Outage,
    /// The server refuses this play for good (the song was deleted since): drop it.
    Rejected,
    /// It failed without saying why (Navidrome puts most errors in a 200 answer): a few more tries.
    Unexplained,
}

/// What a failed scrobble says. `status` is the HTTP status as the TypeScript client reported it (0: no answer,
/// 401 for Subsonic's code 40, 500 for any other error in a 200 answer); `code` is Subsonic's own error code, when
/// the answer was one (0 when it gave none).
pub fn classify_failure(status: u16, code: Option<i32>) -> Failure {
    if matches!(status, 0 | 401 | 408 | 429 | 502 | 503 | 504) {
        return Failure::Outage;
    }
    match code {
        Some(40..=44) => Failure::Outage,
        Some(0) => Failure::Unexplained,
        Some(_) => Failure::Rejected,
        None if status >= 500 => Failure::Unexplained,
        None => Failure::Rejected,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPlay {
    pub id: String,
    /// When the song started, in ms since the epoch: the server records the play at that time.
    pub time: u64,
    /// How many times the server has failed on it without a reason.
    pub tries: u32,
}

/// The plays waiting to be sent, oldest first. The app saves [`Outbox::plays`] after every change and gives them
/// back at the next start.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outbox {
    pending: Vec<PendingPlay>,
}

impl Outbox {
    pub fn from_saved(plays: Vec<PendingPlay>) -> Self {
        let mut outbox = Self { pending: plays };
        outbox.trim();
        outbox
    }

    pub fn plays(&self) -> &[PendingPlay] {
        &self.pending
    }

    pub fn push(&mut self, play: PendingPlay) {
        self.pending.push(play);
        self.trim();
    }

    fn trim(&mut self) {
        let excess = self.pending.len().saturating_sub(MAX_PENDING);
        self.pending.drain(..excess);
    }

    /// Sends every waiting play, oldest first, each one try per round, so one the server chokes on never holds the
    /// others back. Stops trying at the first outage (the rest wait, untried). Returns how many were sent.
    pub async fn flush<F, Fut>(&mut self, mut send: F) -> usize
    where
        F: FnMut(&PendingPlay) -> Fut,
        Fut: Future<Output = Result<(), Failure>>,
    {
        let mut sent = 0;
        let mut offline = false;
        let mut keep = Vec::with_capacity(self.pending.len());
        for waiting in std::mem::take(&mut self.pending) {
            if offline {
                keep.push(waiting);
                continue;
            }
            match send(&waiting).await {
                Ok(()) => sent += 1,
                Err(Failure::Outage) => {
                    offline = true;
                    keep.push(waiting);
                }
                Err(Failure::Unexplained) => {
                    let tries = waiting.tries + 1;
                    if tries < MAX_TRIES {
                        keep.push(PendingPlay { tries, ..waiting });
                    }
                }
                Err(Failure::Rejected) => {}
            }
        }
        self.pending = keep;
        sent
    }
}

/// What the player is doing, as the tracker hears it at every tick.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerTick<'a> {
    pub song_id: Option<&'a str>,
    /// The song's length in seconds (the queue's, else the player's).
    pub duration: f64,
    pub current_time: f64,
    pub is_playing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScrobbleAction {
    /// Tell the server this song is playing now (`submission: false`).
    AnnounceNowPlaying(String),
    /// The song counts as played: put it in the [`Outbox`] and flush.
    Record(PendingPlay),
}

#[derive(Debug, Clone)]
struct CurrentPlay {
    id: String,
    started_at: u64,
    listened: f64,
    now_playing_sent: bool,
    submitted: bool,
}

impl CurrentPlay {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            started_at: 0,
            listened: 0.0,
            now_playing_sent: false,
            submitted: false,
        }
    }
}

/// Follows the player tick by tick and says when a song starts and when it has been heard enough to count.
#[derive(Debug, Default)]
pub struct ListeningTracker {
    current: Option<CurrentPlay>,
}

impl ListeningTracker {
    /// `prev` is the tick before; `now_ms` the wall clock.
    pub fn on_tick(
        &mut self,
        prev: &PlayerTick<'_>,
        tick: &PlayerTick<'_>,
        now_ms: u64,
    ) -> Vec<ScrobbleAction> {
        let mut actions = Vec::new();
        if tick.song_id != self.current.as_ref().map(|c| c.id.as_str()) {
            self.current = tick.song_id.map(CurrentPlay::new);
        }
        let (Some(song), Some(play)) = (tick.song_id, self.current.as_mut()) else {
            return actions;
        };

        // Repeat-one, or "previous" restarting a song already counted: a new play.
        if play.submitted && tick.current_time < 2.0 && prev.current_time > tick.current_time + 10.0
        {
            *play = CurrentPlay::new(song);
            return actions;
        }

        if tick.is_playing && !play.now_playing_sent {
            play.now_playing_sent = true;
            play.started_at = now_ms;
            actions.push(ScrobbleAction::AnnounceNowPlaying(song.to_owned()));
        }

        let same_song = prev.song_id == Some(song);
        let delta = tick.current_time - prev.current_time;
        if tick.is_playing && same_song && delta > 0.0 && delta <= MAX_TICK_S {
            play.listened += delta;
        }

        if !play.submitted && counts_as_play(play.listened, tick.duration) {
            play.submitted = true;
            actions.push(ScrobbleAction::Record(PendingPlay {
                id: song.to_owned(),
                time: if play.started_at > 0 {
                    play.started_at
                } else {
                    now_ms
                },
                tries: 0,
            }));
        }
        actions
    }
}

// Ported from mobile/tests/scrobbler.test.js.
#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::future::ready;

    use super::*;
    use crate::tests_support::block_on;

    /// Plays a song from the start to `until` seconds, one second at a time (each tick jumping `jump` seconds
    /// after the second one, when given), then pauses; returns what the tracker asked for.
    fn listen(
        tracker: &mut ListeningTracker,
        id: &str,
        duration: f64,
        until: u32,
        jump: Option<f64>,
    ) -> Vec<ScrobbleAction> {
        let mut actions = Vec::new();
        let mut prev = PlayerTick {
            song_id: None,
            duration: 0.0,
            current_time: 0.0,
            is_playing: false,
        };
        let mut tick = PlayerTick {
            song_id: Some(id),
            duration,
            current_time: 0.0,
            is_playing: true,
        };
        actions.extend(tracker.on_tick(&prev, &tick, 1_000));
        for t in 1..=until {
            prev = tick.clone();
            let t = f64::from(t);
            tick.current_time = match jump {
                Some(j) if t > 2.0 => t * j,
                _ => t,
            };
            actions.extend(tracker.on_tick(&prev, &tick, 1_000 + t as u64 * 1000));
        }
        prev = tick.clone();
        tick.is_playing = false;
        actions.extend(tracker.on_tick(&prev, &tick, 99_000));
        actions
    }

    fn recorded(actions: &[ScrobbleAction]) -> Vec<String> {
        actions
            .iter()
            .filter_map(|a| match a {
                ScrobbleAction::Record(p) => Some(p.id.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_song_heard_for_half_its_length_is_recorded_once_and_its_start_announced() {
        let mut tracker = ListeningTracker::default();
        let actions = listen(&mut tracker, "a", 100.0, 60, None);
        assert_eq!(recorded(&actions), ["a"]);
        assert_eq!(actions[0], ScrobbleAction::AnnounceNowPlaying("a".into()));
        let ScrobbleAction::Record(play) = &actions[1] else {
            panic!()
        };
        assert_eq!(
            play.time, 1_000,
            "the play is recorded at the time the song started"
        );
    }

    #[test]
    fn a_song_skipped_early_too_short_or_jumped_through_is_not_recorded() {
        let mut tracker = ListeningTracker::default();
        assert!(recorded(&listen(&mut tracker, "early", 100.0, 20, None)).is_empty());
        assert!(recorded(&listen(&mut tracker, "short", 20.0, 19, None)).is_empty());
        assert!(recorded(&listen(&mut tracker, "seeker", 100.0, 20, Some(10.0))).is_empty());
    }

    #[test]
    fn four_minutes_count_for_a_long_song() {
        assert!(counts_as_play(240.0, 1200.0));
        assert!(!counts_as_play(239.0, 1200.0));
        assert!(counts_as_play(15.0, 30.0));
        assert!(!counts_as_play(29.0, 29.0));
    }

    #[test]
    fn a_song_started_again_after_it_counted_is_a_new_play() {
        let mut tracker = ListeningTracker::default();
        listen(&mut tracker, "loop", 100.0, 60, None);
        let prev = PlayerTick {
            song_id: Some("loop"),
            duration: 100.0,
            current_time: 95.0,
            is_playing: true,
        };
        let restart = PlayerTick {
            current_time: 0.5,
            ..prev.clone()
        };
        assert!(tracker.on_tick(&prev, &restart, 200_000).is_empty());
        let next = PlayerTick {
            current_time: 1.5,
            ..restart.clone()
        };
        assert_eq!(
            tracker.on_tick(&restart, &next, 201_000),
            [ScrobbleAction::AnnounceNowPlaying("loop".into())]
        );
    }

    fn play(id: &str) -> PendingPlay {
        PendingPlay {
            id: id.into(),
            time: 1,
            tries: 0,
        }
    }

    /// Flushes `outbox`, answering each send from `script`; returns the ids tried.
    fn flush(outbox: &mut Outbox, script: impl Fn(&str) -> Result<(), Failure>) -> Vec<String> {
        let tried = RefCell::new(Vec::new());
        block_on(outbox.flush(|p| {
            tried.borrow_mut().push(p.id.clone());
            ready(script(&p.id))
        }));
        tried.into_inner()
    }

    #[test]
    fn plays_made_while_the_server_is_out_of_reach_wait_in_order() {
        let mut outbox = Outbox::default();
        outbox.push(play("one"));
        assert_eq!(flush(&mut outbox, |_| Err(Failure::Outage)), ["one"]);
        outbox.push(play("two"));
        assert_eq!(
            flush(&mut outbox, |_| Err(Failure::Outage)),
            ["one"],
            "the second waits behind the first, untried"
        );
        assert_eq!(
            outbox
                .plays()
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        assert_eq!(flush(&mut outbox, |_| Ok(())), ["one", "two"]);
        assert!(outbox.plays().is_empty());
    }

    #[test]
    fn a_song_the_server_says_is_gone_is_dropped_and_the_others_go_out() {
        let mut outbox = Outbox::from_saved(vec![play("deleted"), play("fine")]);
        let tried = flush(&mut outbox, |id| {
            if id == "deleted" {
                Err(Failure::Rejected)
            } else {
                Ok(())
            }
        });
        assert_eq!(tried, ["deleted", "fine"]);
        assert!(outbox.plays().is_empty());
    }

    #[test]
    fn an_unexplained_failure_is_tried_five_times_in_all_without_holding_up_the_others() {
        let mut outbox = Outbox::from_saved(vec![play("odd")]);
        let script = |id: &str| {
            if id == "odd" {
                Err(Failure::Unexplained)
            } else {
                Ok(())
            }
        };
        flush(&mut outbox, script);
        assert_eq!(outbox.plays()[0].tries, 1);
        outbox.push(play("ok1"));
        assert_eq!(
            flush(&mut outbox, script),
            ["odd", "ok1"],
            "a later play is not stuck behind it"
        );
        for _ in 0..3 {
            flush(&mut outbox, script);
        }
        assert!(outbox.plays().is_empty(), "given up on after five tries");
    }

    #[test]
    fn at_most_five_hundred_plays_wait_the_oldest_go_first() {
        let mut outbox = Outbox::default();
        for i in 0..510 {
            outbox.push(play(&i.to_string()));
        }
        assert_eq!(outbox.plays().len(), MAX_PENDING);
        assert_eq!(outbox.plays()[0].id, "10");
    }

    #[test]
    fn a_plain_http_500_and_the_proxy_errors_are_told_apart() {
        assert_eq!(classify_failure(500, None), Failure::Unexplained);
        assert_eq!(classify_failure(500, Some(0)), Failure::Unexplained);
        assert_eq!(classify_failure(500, Some(70)), Failure::Rejected);
        assert_eq!(classify_failure(404, None), Failure::Rejected);
        for status in [0, 408, 429, 502, 503, 504] {
            assert_eq!(classify_failure(status, None), Failure::Outage, "{status}");
        }
        assert_eq!(
            classify_failure(401, None),
            Failure::Outage,
            "a login that is wrong right now is no reason to lose plays"
        );
        assert_eq!(classify_failure(500, Some(41)), Failure::Outage);
    }
}
