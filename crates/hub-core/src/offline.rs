//! When the network is too slow to stream, or gone, the songs already on the device come first: how good the
//! network is from what playback and the server show, and how to reorder the queue. Also where to resume the song
//! left playing at the last session.
//!
//! Port of `mobile/src/services/offlinePriority.ts` and the resume rule of `playbackMemory.ts`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkQuality {
    Good,
    Slow,
    Offline,
}

/// A stall this long, while a streamed song should be playing, says on its own that the network cannot keep up.
const LONG_STALL_MS: i64 = 4_000;
/// Shorter stalls count when there are this many within the window.
const STALLS_FOR_SLOW: usize = 2;
const MIN_STALL_MS: i64 = 1_000;
const STALL_WINDOW_MS: i64 = 2 * 60_000;
/// The server answering a ping this slowly is a slow network too.
const SLOW_PING_MS: u64 = 1_500;
/// Back to good only after this long without trouble and a ping under GOOD_PING_MS: no flapping.
const CALM_MS: i64 = 2 * 60_000;
const GOOD_PING_MS: u64 = 800;
/// This many failed pings in a row with the device saying it is connected: the server cannot be reached.
const FAILED_PINGS_FOR_OFFLINE: u32 = 2;
/// What is asked of the server while the network is not good (kbit/s).
pub const SLOW_BITRATE: u32 = 128;

#[derive(Debug, Clone, Copy)]
struct Stall {
    start: i64,
    end: Option<i64>,
}

/// Judges the network from three kinds of evidence: what the device says about its connection, the stalls of a
/// streamed song while it should be playing, and pings to the server. Times are ms on any steady clock.
#[derive(Debug, Clone)]
pub struct NetworkMonitor {
    connected: bool,
    reachable: Option<bool>,
    stalls: Vec<Stall>,
    failed_pings: u32,
    last_ping_ms: Option<u64>,
    slow_since: Option<i64>,
    last_trouble: Option<i64>,
}

impl Default for NetworkMonitor {
    fn default() -> Self {
        Self {
            connected: true,
            reachable: None,
            stalls: Vec::new(),
            failed_pings: 0,
            last_ping_ms: None,
            slow_since: None,
            last_trouble: None,
        }
    }
}

impl NetworkMonitor {
    /// What the device says: a network or none, and whether it reaches the internet (`None`: it does not know). A
    /// network that came back clears the failed pings: the next ones decide again.
    pub fn note_connectivity(&mut self, connected: bool, reachable: Option<bool>) {
        if connected && !self.connected {
            self.failed_pings = 0;
        }
        self.connected = connected;
        self.reachable = reachable;
    }

    /// Whether the device says the internet is out of reach (worth a ping to see if the server still answers).
    pub fn internet_doubtful(&self) -> bool {
        self.reachable == Some(false)
    }

    /// A streamed song started or stopped waiting for data while it should have been playing.
    pub fn note_buffering(&mut self, buffering: bool, now: i64) {
        match self.stalls.last_mut() {
            Some(open) if open.end.is_none() => {
                if !buffering {
                    open.end = Some(now);
                }
            }
            _ if buffering => self.stalls.push(Stall {
                start: now,
                end: None,
            }),
            _ => {}
        }
        self.stalls
            .retain(|s| s.end.unwrap_or(now) >= now - STALL_WINDOW_MS);
    }

    /// How long the server took to answer a ping, or `None` when it did not.
    pub fn note_ping(&mut self, latency_ms: Option<u64>) {
        match latency_ms {
            None => self.failed_pings += 1,
            Some(_) => self.failed_pings = 0,
        }
        self.last_ping_ms = latency_ms;
    }

    /// The verdict, and why in a few words (for the diagnostics).
    pub fn snapshot(&mut self, now: i64) -> (NetworkQuality, &'static str) {
        if !self.connected {
            return (NetworkQuality::Offline, "pas de réseau");
        }
        // No internet is not offline: a server on the home network still answers. Only the server failing to does.
        if self.failed_pings >= FAILED_PINGS_FOR_OFFLINE {
            return (NetworkQuality::Offline, "serveur injoignable");
        }
        let length = |s: &Stall| s.end.unwrap_or(now) - s.start;
        let recent: Vec<&Stall> = self
            .stalls
            .iter()
            .filter(|s| s.end.unwrap_or(now) >= now - STALL_WINDOW_MS)
            .collect();
        let long_stall = recent.iter().any(|s| length(s) >= LONG_STALL_MS);
        let many_stalls =
            recent.iter().filter(|s| length(s) >= MIN_STALL_MS).count() >= STALLS_FOR_SLOW;
        let slow_ping = self.last_ping_ms.is_some_and(|p| p >= SLOW_PING_MS);
        if long_stall || many_stalls || slow_ping {
            self.last_trouble = Some(now);
            self.slow_since.get_or_insert(now);
            let reason = if long_stall {
                "lecture bloquée"
            } else if many_stalls {
                "lecture saccadée"
            } else {
                "serveur lent"
            };
            return (NetworkQuality::Slow, reason);
        }
        if self.slow_since.is_some() {
            // Calm again only after a while without trouble, and a quick ping to prove it.
            let calm = self.last_trouble.is_none_or(|t| now - t >= CALM_MS)
                && self.last_ping_ms.is_some_and(|p| p < GOOD_PING_MS);
            if !calm {
                return (NetworkQuality::Slow, "en observation");
            }
            self.slow_since = None;
        }
        (NetworkQuality::Good, "ok")
    }

    pub fn quality(&mut self, now: i64) -> NetworkQuality {
        self.snapshot(now).0
    }
}

/// The queue with what is still to come reordered: the songs on the device first, then the others, each group in
/// the order it had. What was already played and the song playing stay where they are, so "previous" still walks
/// back through what was heard. `None` when nothing moves.
pub fn prioritize_local<T: Clone>(
    queue: &[T],
    index: usize,
    is_local: impl Fn(&T) -> bool,
) -> Option<Vec<T>> {
    let split = (index + 1).min(queue.len());
    let (local, remote): (Vec<usize>, Vec<usize>) =
        (split..queue.len()).partition(|&i| is_local(&queue[i]));
    let order: Vec<usize> = (0..split).chain(local).chain(remote).collect();
    if order.iter().enumerate().all(|(i, &o)| i == o) {
        return None;
    }
    Some(order.into_iter().map(|i| queue[i].clone()).collect())
}

/// Where to go when the song at `index` cannot be streamed: the first song on the device from `index` on (round to
/// the start when the whole queue repeats). `None` when the queue has none.
pub fn next_local_index<T>(
    queue: &[T],
    index: usize,
    is_local: impl Fn(&T) -> bool,
    wrap: bool,
) -> Option<usize> {
    (index..queue.len())
        .find(|&i| is_local(&queue[i]))
        .or_else(|| {
            wrap.then(|| (0..index.min(queue.len())).find(|&i| is_local(&queue[i])))
                .flatten()
        })
}

/// The bitrate to ask the server for when streaming (kbit/s), or `None` for the original file.
pub fn stream_bitrate(quality: NetworkQuality, reduce_when_slow: bool) -> Option<u32> {
    (reduce_when_slow && quality != NetworkQuality::Good).then_some(SLOW_BITRATE)
}

/// A song left in its last seconds resumes from the top, rather than ending the moment play is pressed.
const END_MARGIN_S: f64 = 2.0;

/// Where to start the song restored from the last session: the saved second when it was saved for that very song
/// and is not in its last two seconds, else the top.
pub fn resume_seconds(
    saved_song_id: Option<&str>,
    saved_seconds: f64,
    song_id: &str,
    duration: f64,
) -> f64 {
    if saved_song_id != Some(song_id) || saved_seconds.is_nan() || saved_seconds <= 0.0 {
        return 0.0;
    }
    if duration > 0.0 && saved_seconds > duration - END_MARGIN_S {
        return 0.0;
    }
    saved_seconds
}

// Ported from the pure part of mobile/tests/offline.test.js.
#[cfg(test)]
mod tests {
    use super::*;

    struct Clock(i64);

    impl Clock {
        fn later(&mut self, ms: i64) -> i64 {
            self.0 += ms;
            self.0
        }
    }

    #[test]
    fn a_working_network_is_good_none_is_offline_and_coming_back_is_good() {
        let mut n = NetworkMonitor::default();
        assert_eq!(n.quality(0), NetworkQuality::Good);
        n.note_connectivity(false, Some(false));
        assert_eq!(n.quality(0), NetworkQuality::Offline);
        n.note_connectivity(true, Some(true));
        assert_eq!(n.quality(0), NetworkQuality::Good);
    }

    #[test]
    fn doubting_the_internet_is_not_offline_a_server_at_home_still_answers() {
        let mut n = NetworkMonitor::default();
        n.note_connectivity(true, Some(false));
        assert_eq!(n.quality(0), NetworkQuality::Good);
        assert!(n.internet_doubtful());
    }

    #[test]
    fn the_server_not_answering_twice_is_offline_one_answer_brings_it_back() {
        let mut n = NetworkMonitor::default();
        n.note_ping(None);
        assert_eq!(
            n.quality(0),
            NetworkQuality::Good,
            "one failure is not enough"
        );
        n.note_ping(None);
        assert_eq!(n.quality(0), NetworkQuality::Offline);
        n.note_ping(Some(120));
        assert_eq!(n.quality(0), NetworkQuality::Good);
    }

    #[test]
    fn one_long_stall_is_slow_a_short_one_alone_is_not() {
        let mut clock = Clock(1_000_000);
        let mut short = NetworkMonitor::default();
        short.note_buffering(true, clock.0);
        short.note_buffering(false, clock.later(2_000));
        assert_eq!(short.quality(clock.0), NetworkQuality::Good);
        let mut long = NetworkMonitor::default();
        long.note_buffering(true, clock.0);
        let now = clock.later(4_500);
        assert_eq!(
            long.snapshot(now),
            (NetworkQuality::Slow, "lecture bloquée"),
            "a stall still going counts too"
        );
    }

    #[test]
    fn two_stalls_within_two_minutes_are_slow_older_ones_are_forgotten() {
        let mut clock = Clock(1_000_000);
        let mut n = NetworkMonitor::default();
        n.note_buffering(true, clock.0);
        n.note_buffering(false, clock.later(1_500));
        clock.later(3 * 60_000);
        n.note_buffering(true, clock.0);
        n.note_buffering(false, clock.later(1_500));
        assert_eq!(
            n.quality(clock.0),
            NetworkQuality::Good,
            "the first one is too old"
        );
        clock.later(30_000);
        n.note_buffering(true, clock.0);
        n.note_buffering(false, clock.later(1_200));
        assert_eq!(n.quality(clock.0), NetworkQuality::Slow);
    }

    #[test]
    fn a_slow_server_is_a_slow_network_and_slow_stays_until_calm_and_quick() {
        let mut n = NetworkMonitor::default();
        n.note_ping(Some(1_800));
        assert_eq!(n.quality(0), NetworkQuality::Slow);

        let mut clock = Clock(1_000_000);
        let mut n = NetworkMonitor::default();
        n.note_buffering(true, clock.0);
        n.note_buffering(false, clock.later(5_000));
        assert_eq!(n.quality(clock.0), NetworkQuality::Slow);
        clock.later(60_000);
        n.note_ping(Some(300));
        assert_eq!(
            n.quality(clock.0),
            NetworkQuality::Slow,
            "calm, but not long enough"
        );
        clock.later(2 * 60_000);
        n.note_ping(Some(900));
        assert_eq!(
            n.quality(clock.0),
            NetworkQuality::Slow,
            "calm, but the answer was not quick"
        );
        n.note_ping(Some(300));
        assert_eq!(n.quality(clock.0), NetworkQuality::Good);
    }

    #[test]
    fn what_is_still_to_come_is_reordered_local_songs_first() {
        let queue = ["a", "b", "c", "d", "e", "f"];
        let local = ["a", "d", "f"];
        let result = prioritize_local(&queue, 1, |s| local.contains(s)).unwrap();
        assert_eq!(result, ["a", "b", "d", "f", "c", "e"]);
        assert_eq!(
            prioritize_local(&["a", "b", "c"], 0, |_| true),
            None,
            "nothing to move"
        );
        assert_eq!(prioritize_local(&["a", "b", "c"], 2, |_| false), None);
    }

    #[test]
    fn the_next_local_song_is_found_from_here_round_only_when_repeating() {
        let queue = ["a", "b", "c", "d"];
        let local = |s: &&str| *s == "a" || *s == "c";
        assert_eq!(next_local_index(&queue, 1, local, false), Some(2));
        assert_eq!(next_local_index(&queue, 2, local, false), Some(2));
        assert_eq!(next_local_index(&queue, 3, local, false), None);
        assert_eq!(next_local_index(&queue, 3, local, true), Some(0));
        assert_eq!(next_local_index(&queue, 0, |_| false, true), None);
    }

    #[test]
    fn streams_drop_to_128_only_while_not_good_and_with_the_setting_on() {
        assert_eq!(stream_bitrate(NetworkQuality::Good, true), None);
        assert_eq!(stream_bitrate(NetworkQuality::Slow, true), Some(128));
        assert_eq!(stream_bitrate(NetworkQuality::Offline, true), Some(128));
        assert_eq!(stream_bitrate(NetworkQuality::Slow, false), None);
    }

    #[test]
    fn a_restored_song_resumes_where_it_was_unless_nearly_over_or_another_song() {
        assert_eq!(resume_seconds(Some("s"), 61.5, "s", 200.0), 61.5);
        assert_eq!(
            resume_seconds(Some("s"), 199.0, "s", 200.0),
            0.0,
            "in its last two seconds"
        );
        assert_eq!(resume_seconds(Some("other"), 61.5, "s", 200.0), 0.0);
        assert_eq!(resume_seconds(None, 61.5, "s", 200.0), 0.0);
        assert_eq!(resume_seconds(Some("s"), f64::NAN, "s", 200.0), 0.0);
        assert_eq!(
            resume_seconds(Some("s"), 500.0, "s", 0.0),
            500.0,
            "length unknown: trusted"
        );
    }
}
