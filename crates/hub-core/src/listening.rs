//! Writes down what is listened to on this device, week by week, for the weekly recap ([`crate::wrapped`]). The
//! time is what was actually heard: the player's progress while it plays, without pauses or seeks (the ticks the
//! scrobbler counts). It stays on the device: Navidrome keeps no history of plays to read back.
//!
//! Port of `mobile/src/services/listeningLog.ts`. Saving is the app's: this says when, and what changed. A save is
//! due after every 30 seconds heard, at each change of song, when a song counts as played, and when the app goes to
//! the background; each week is its own entry, and only the weeks that changed are written.

use std::collections::BTreeSet;

use jiff::tz::TimeZone;

use crate::scrobble::{MAX_TICK_S, PlayerTick, counts_as_play};
use crate::song::SongInfo;
use crate::wrapped::{
    KEEP_WEEKS, Ledger, WeekLog, add_listening, add_play, merge_ledgers, prune, week_key,
};

/// Heard seconds not yet saved, at most: what an app killed in the background can lose.
const SAVE_EVERY_S: f64 = 30.0;

#[derive(Debug)]
struct Current {
    id: String,
    listened: f64,
    counted: bool,
}

/// What to write: the weeks that changed, the weeks forgotten, and the list of weeks when it changed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SaveBatch {
    pub updated: Vec<WeekLog>,
    pub removed: Vec<String>,
    pub index: Option<Vec<String>>,
}

#[derive(Debug, Default)]
pub struct ListeningLog {
    ledger: Ledger,
    loaded: bool,
    current: Option<Current>,
    unsaved: f64,
    /// The weeks changed since the last save.
    changed: BTreeSet<String>,
    /// The list of weeks as last saved.
    saved_index: Vec<String>,
}

impl ListeningLog {
    /// The weeks recorded, as of now (including what is not saved yet).
    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    /// The saved weeks are read back: what was heard meanwhile is added on top of them. A save follows.
    pub fn loaded(
        &mut self,
        saved: Ledger,
        saved_index: Vec<String>,
        now_ms: i64,
        tz: &TimeZone,
    ) -> Option<SaveBatch> {
        let mut index = saved_index;
        index.sort();
        self.saved_index = index;
        self.ledger = merge_ledgers(saved, std::mem::take(&mut self.ledger));
        self.loaded = true;
        self.save(now_ms, tz)
    }

    /// Follows the player; returns a batch when a save is due. `song` is the song of `tick`.
    pub fn on_tick(
        &mut self,
        prev: &PlayerTick<'_>,
        tick: &PlayerTick<'_>,
        song: Option<&SongInfo>,
        now_ms: i64,
        tz: &TimeZone,
    ) -> Option<SaveBatch> {
        let mut batch = None;
        if tick.song_id != self.current.as_ref().map(|c| c.id.as_str()) {
            // Another song: what was heard of the last one is kept at once.
            if self.current.is_some() {
                batch = self.save(now_ms, tz);
            }
            self.current = tick.song_id.map(|id| Current {
                id: id.to_owned(),
                listened: 0.0,
                counted: false,
            });
        }
        let (Some(song), Some(current)) = (song, self.current.as_mut()) else {
            return batch;
        };

        // Repeat-one, or "previous" restarting a song already counted: a new play.
        if current.counted
            && tick.current_time < 2.0
            && prev.current_time > tick.current_time + 10.0
        {
            *current = Current {
                id: song.id.clone(),
                listened: 0.0,
                counted: false,
            };
            return batch;
        }

        let same_song = prev.song_id == tick.song_id;
        let delta = tick.current_time - prev.current_time;
        if !tick.is_playing || !same_song || delta <= 0.0 || delta > MAX_TICK_S {
            return batch;
        }
        current.listened += delta;
        add_listening(&mut self.ledger, song, delta, now_ms, tz);
        self.changed.insert(week_key(now_ms, tz));
        self.unsaved += delta;
        let duration = if song.duration > 0.0 {
            song.duration
        } else {
            tick.duration
        };
        if !current.counted && counts_as_play(current.listened, duration) {
            current.counted = true;
            add_play(&mut self.ledger, song, now_ms, tz);
            return self.save(now_ms, tz).or(batch);
        }
        if self.unsaved >= SAVE_EVERY_S {
            return self.save(now_ms, tz).or(batch);
        }
        batch
    }

    /// What to write now (the recap is opened, the app goes to the background), or `None` when nothing changed.
    pub fn save(&mut self, now_ms: i64, tz: &TimeZone) -> Option<SaveBatch> {
        if !self.loaded {
            return None;
        }
        self.unsaved = 0.0;
        let removed = prune(&mut self.ledger, now_ms, tz, KEEP_WEEKS);
        let updated: Vec<WeekLog> = std::mem::take(&mut self.changed)
            .into_iter()
            .filter_map(|key| self.ledger.get(&key).cloned())
            .collect();
        let index: Vec<String> = self.ledger.keys().cloned().collect();
        let index_changed = index != self.saved_index;
        if updated.is_empty() && removed.is_empty() && !index_changed {
            return None;
        }
        if index_changed {
            self.saved_index = index.clone();
        }
        Some(SaveBatch {
            updated,
            removed,
            index: index_changed.then_some(index),
        })
    }
}

// Ported from the recording tests of mobile/tests/wrapped.test.js.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::wrapped::tests::{at, paris, song};

    /// A player driven one second at a time, its clock moving with it.
    struct Player {
        log: ListeningLog,
        clock: i64,
        song: Option<SongInfo>,
        time: f64,
        playing: bool,
        batches: Vec<SaveBatch>,
    }

    impl Player {
        fn new(clock: i64) -> Self {
            let mut log = ListeningLog::default();
            log.loaded(Ledger::new(), Vec::new(), clock, &paris());
            Self {
                log,
                clock,
                song: None,
                time: 0.0,
                playing: false,
                batches: Vec::new(),
            }
        }

        fn set(&mut self, song: Option<SongInfo>, time: f64, playing: bool) {
            let prev_id = self.song.as_ref().map(|s| s.id.clone());
            let prev = PlayerTick {
                song_id: prev_id.as_deref(),
                duration: 0.0,
                current_time: self.time,
                is_playing: self.playing,
            };
            let id = song.as_ref().map(|s| s.id.clone());
            let tick = PlayerTick {
                song_id: id.as_deref(),
                duration: 0.0,
                current_time: time,
                is_playing: playing,
            };
            if let Some(batch) = self
                .log
                .on_tick(&prev, &tick, song.as_ref(), self.clock, &paris())
            {
                self.batches.push(batch);
            }
            (self.song, self.time, self.playing) = (song, time, playing);
        }

        /// Plays `track` from `from` to `to` seconds, one second at a time.
        fn play(&mut self, track: &SongInfo, from: f64, to: f64) {
            if self.song.as_ref().map(|s| &s.id) != Some(&track.id) || self.time > from {
                self.set(Some(track.clone()), from, true);
            }
            self.set(Some(track.clone()), self.time, true);
            let mut t = from + 1.0;
            while t <= to {
                self.clock += 1000;
                self.set(Some(track.clone()), t, true);
                t += 1.0;
            }
        }

        fn pause(&mut self) {
            self.set(self.song.clone(), self.time, false);
        }

        fn stop(&mut self) {
            self.set(None, 0.0, false);
        }

        fn stat(&self, week: &str, id: &str) -> Option<(f64, u32)> {
            self.log
                .ledger()
                .get(week)?
                .song(id)
                .map(|s| (s.seconds, s.plays))
        }
    }

    fn with_duration(id: &str, duration: f64) -> SongInfo {
        SongInfo {
            duration,
            ..song(id)
        }
    }

    #[test]
    fn what_is_heard_while_playing_counts_pauses_seeks_and_going_back_do_not() {
        let mut p = Player::new(at(2026, 10, 7, 20, 0, 0));
        let a = song("a");
        p.play(&a, 0.0, 40.0);
        p.pause();
        p.play(&a, 40.0, 40.0);
        p.set(Some(a.clone()), 120.0, true); // a seek
        p.play(&a, 120.0, 130.0);
        p.set(Some(a.clone()), 20.0, true); // back
        p.stop();
        assert_eq!(p.stat("2026-10-05", "a"), Some((50.0, 0)));
        assert_eq!(p.log.ledger()["2026-10-05"].days[2], 50.0, "on Wednesday");
    }

    #[test]
    fn dragging_the_seek_bar_while_paused_is_not_listening() {
        let mut p = Player::new(at(2026, 10, 7, 21, 0, 0));
        let scrub = with_duration("scrub", 300.0);
        p.set(Some(scrub.clone()), 0.0, false);
        for t in (2..=60).step_by(2) {
            p.clock += 300;
            p.set(Some(scrub.clone()), f64::from(t), false);
        }
        p.stop();
        assert_eq!(p.stat("2026-10-05", "scrub"), None);
    }

    #[test]
    fn a_play_counts_at_half_the_song_once_and_again_when_it_starts_over() {
        let mut p = Player::new(at(2026, 10, 8, 9, 0, 0));
        let b = with_duration("b", 100.0);
        p.play(&b, 0.0, 49.0);
        assert_eq!(p.stat("2026-10-05", "b").unwrap().1, 0);
        p.play(&b, 49.0, 99.0);
        assert_eq!(p.stat("2026-10-05", "b").unwrap().1, 1);
        p.set(Some(b.clone()), 0.0, true); // repeat-one: back to the start
        p.play(&b, 0.0, 60.0);
        p.stop();
        assert_eq!(p.stat("2026-10-05", "b").unwrap().1, 2);
    }

    #[test]
    fn a_long_song_counts_after_4_minutes_a_very_short_one_never() {
        let mut p = Player::new(at(2026, 10, 8, 10, 0, 0));
        p.play(&with_duration("long", 1200.0), 0.0, 240.0);
        p.play(&with_duration("jingle", 20.0), 0.0, 20.0);
        p.stop();
        assert_eq!(p.stat("2026-10-05", "long").unwrap().1, 1);
        assert_eq!(p.stat("2026-10-05", "jingle"), Some((20.0, 0)));
    }

    #[test]
    fn listening_across_sunday_midnight_is_split_between_the_weeks() {
        let mut p = Player::new(at(2026, 10, 11, 23, 59, 29));
        p.play(&with_duration("midnight", 300.0), 0.0, 60.0);
        p.stop();
        assert_eq!(p.stat("2026-10-05", "midnight").unwrap().0, 30.0);
        assert_eq!(p.log.ledger()["2026-10-05"].days[6], 30.0);
        assert_eq!(p.stat("2026-10-12", "midnight").unwrap().0, 30.0);
        assert_eq!(p.log.ledger()["2026-10-12"].days[0], 30.0);
    }

    #[test]
    fn heard_seconds_are_saved_every_30_seconds_with_only_the_weeks_that_changed() {
        let mut p = Player::new(at(2026, 10, 12, 8, 30, 0));
        let c = with_duration("c", 600.0);
        p.play(&c, 0.0, 10.0);
        assert!(p.batches.is_empty(), "not after 10 s");
        p.play(&c, 10.0, 31.0);
        let batch = p.batches.last().unwrap();
        assert_eq!(
            batch
                .updated
                .iter()
                .map(|w| w.week.as_str())
                .collect::<Vec<_>>(),
            ["2026-10-12"]
        );
        assert!(batch.updated[0].song("c").unwrap().seconds >= 30.0);
        assert_eq!(
            batch.index.as_deref(),
            Some(&["2026-10-12".to_owned()][..]),
            "the first save lists the week"
        );
        p.play(&c, 31.0, 40.0);
        let on_background = p.log.save(p.clock, &paris()).unwrap();
        assert_eq!(on_background.updated[0].song("c").unwrap().seconds, 40.0);
        assert_eq!(
            on_background.index, None,
            "the list of weeks did not change"
        );
        assert_eq!(
            p.log.save(p.clock, &paris()),
            None,
            "nothing new: nothing to write"
        );
    }

    #[test]
    fn what_is_heard_before_the_saved_weeks_are_read_back_is_added_to_them() {
        let tz = paris();
        let mut early = ListeningLog::default();
        let mut ledger = Ledger::new();
        let midnight = with_duration("midnight", 300.0);
        add_listening(
            &mut ledger,
            &midnight,
            30.0,
            at(2026, 10, 12, 0, 0, 10),
            &tz,
        );
        // Heard while the saved weeks are being read: nothing can be saved yet.
        let prev = PlayerTick {
            song_id: Some("midnight"),
            duration: 300.0,
            current_time: 100.0,
            is_playing: true,
        };
        for t in 101..=110 {
            let tick = PlayerTick {
                current_time: f64::from(t),
                ..prev.clone()
            };
            let before = PlayerTick {
                current_time: f64::from(t - 1),
                ..prev.clone()
            };
            assert_eq!(
                early.on_tick(
                    &before,
                    &tick,
                    Some(&midnight),
                    at(2026, 10, 12, 8, 0, 0),
                    &tz
                ),
                None
            );
        }
        let batch = early
            .loaded(
                ledger,
                vec!["2026-10-12".into()],
                at(2026, 10, 12, 8, 0, 0),
                &tz,
            )
            .unwrap();
        assert_eq!(batch.updated[0].song("midnight").unwrap().seconds, 40.0);
    }
}
