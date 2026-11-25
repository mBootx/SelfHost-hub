//! Rules of the music player that are not tied to a screen: volume normalisation and the sleep timer.
//!
//! Port of `mobile/src/services/loudness.ts` and the pure parts of `sleepTimer.ts`.

/// ReplayGain as OpenSubsonic servers report it, in dB. Only there for files that carry the tags.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ReplayGain {
    pub track_gain: Option<f64>,
    pub album_gain: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_peak: Option<f64>,
    /// What a client should apply to a file that has no ReplayGain tags of its own.
    pub fallback_gain: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NormalizeMode {
    #[default]
    Off,
    Track,
    Album,
}

impl NormalizeMode {
    pub const ALL: [Self; 3] = [Self::Off, Self::Track, Self::Album];

    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "Désactivée",
            Self::Track => "Par titre",
            Self::Album => "Par album",
        }
    }
}

/// ReplayGain 2 aims at -18 LUFS, quiet next to the music of the last twenty years; streaming services play at
/// about -14. This much is added to every gain before it is capped, so most songs are turned down a little
/// instead of a lot.
pub const TARGET_BOOST_DB: f64 = 4.0;

/// The most a song can be turned down: past this, the tags are not to be trusted.
const FLOOR_DB: f64 = -30.0;

/// What to multiply a song's volume by (1 = leave it). It only ever turns down: a player cannot go above its
/// maximum, and boosting would distort. With `Track`, the song's own gain is used, else its album's; with `Album`
/// the other way round, which keeps the quieter and louder songs of one album in proportion. A song without usable
/// tags is left alone, unless the server gave a fallback gain for such files.
pub fn loudness_factor(gain: Option<&ReplayGain>, mode: NormalizeMode) -> f64 {
    let Some(tags) = gain.filter(|_| mode != NormalizeMode::Off) else {
        return 1.0;
    };
    let usable = |g: Option<f64>| g.filter(|v| v.is_finite());
    let own = match mode {
        NormalizeMode::Album => usable(tags.album_gain).or(usable(tags.track_gain)),
        _ => usable(tags.track_gain).or(usable(tags.album_gain)),
    };
    let Some(db) = own.or(usable(tags.fallback_gain)) else {
        return 1.0;
    };
    let db = (db + TARGET_BOOST_DB).max(FLOOR_DB);
    10f64.powf(db / 20.0).min(1.0)
}

/// Sleep timer choices, in minutes. "At the end of this song" is the other one.
pub const SLEEP_PRESETS_MINUTES: [u32; 5] = [15, 30, 45, 60, 90];
/// The music fades out over this long before it stops.
pub const SLEEP_FADE_MS: u64 = 10_000;

/// A sleep timer of `minutes`: how long it runs and how long the fade at its end lasts (never longer than the
/// timer itself), in ms.
pub fn sleep_timer_span(minutes: f64) -> (u64, u64) {
    let duration = ((minutes * 60_000.0).round() as u64).max(1);
    (duration, duration.min(SLEEP_FADE_MS))
}

/// What is left on a timer: "1 h 05", "23 min", "moins d'une minute".
pub fn describe_remaining(ms: i64) -> String {
    let minutes = (ms as f64 / 60_000.0).ceil() as i64;
    if minutes <= 0 {
        return "moins d'une minute".into();
    }
    if minutes < 60 {
        return format!("{minutes} min");
    }
    format!("{} h {:02}", minutes / 60, minutes % 60)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SleepMode {
    #[default]
    Off,
    /// Stops the music at `ends_at`.
    Timer { ends_at: u64 },
    /// Stops the music when the song playing now ends.
    AfterTrack,
}

impl SleepMode {
    /// On return to the app: a timer that ran out while it was away (a second's grace) is over.
    pub fn on_resume(self, now_ms: u64) -> Self {
        match self {
            Self::Timer { ends_at } if now_ms > ends_at + 1000 => Self::Off,
            other => other,
        }
    }
}

// Ported from mobile/tests/music.test.js (loudness) and mobile/tests/sleep.test.js (what is shown).
#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "{a} vs {b}");
    }

    fn gain(track: Option<f64>, album: Option<f64>, fallback: Option<f64>) -> ReplayGain {
        ReplayGain {
            track_gain: track,
            album_gain: album,
            fallback_gain: fallback,
            ..Default::default()
        }
    }

    #[test]
    fn without_the_setting_or_tags_a_song_is_left_alone() {
        assert_eq!(
            loudness_factor(Some(&gain(Some(-10.0), None, None)), NormalizeMode::Off),
            1.0
        );
        assert_eq!(loudness_factor(None, NormalizeMode::Track), 1.0);
        assert_eq!(
            loudness_factor(Some(&ReplayGain::default()), NormalizeMode::Album),
            1.0
        );
    }

    #[test]
    fn a_loud_song_is_turned_down_by_its_gain_plus_the_boost_and_a_quiet_one_never_up() {
        near(
            loudness_factor(Some(&gain(Some(-10.0), None, None)), NormalizeMode::Track),
            10f64.powf(-6.0 / 20.0),
        );
        near(
            loudness_factor(Some(&gain(Some(-4.0), None, None)), NormalizeMode::Track),
            1.0,
        );
        assert_eq!(
            loudness_factor(Some(&gain(Some(3.0), None, None)), NormalizeMode::Track),
            1.0
        );
        assert_eq!(
            loudness_factor(Some(&gain(Some(-2.0), None, None)), NormalizeMode::Track),
            1.0
        );
    }

    #[test]
    fn each_mode_prefers_its_own_gain_and_falls_back_on_the_other_then_the_server_fallback() {
        let both = gain(Some(-12.0), Some(-8.0), None);
        near(
            loudness_factor(Some(&both), NormalizeMode::Track),
            10f64.powf(-8.0 / 20.0),
        );
        near(
            loudness_factor(Some(&both), NormalizeMode::Album),
            10f64.powf(-4.0 / 20.0),
        );
        near(
            loudness_factor(Some(&gain(None, Some(-10.0), None)), NormalizeMode::Track),
            10f64.powf(-6.0 / 20.0),
        );
        near(
            loudness_factor(Some(&gain(Some(-10.0), None, None)), NormalizeMode::Album),
            10f64.powf(-6.0 / 20.0),
        );
        near(
            loudness_factor(Some(&gain(None, None, Some(-9.0))), NormalizeMode::Track),
            10f64.powf(-5.0 / 20.0),
        );
        near(
            loudness_factor(
                Some(&gain(Some(-10.0), None, Some(-20.0))),
                NormalizeMode::Track,
            ),
            10f64.powf(-6.0 / 20.0),
        );
    }

    #[test]
    fn absurd_or_broken_tags_do_not_silence_or_break_playback() {
        let floor = loudness_factor(Some(&gain(Some(-90.0), None, None)), NormalizeMode::Track);
        near(floor, 10f64.powf(-30.0 / 20.0));
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                loudness_factor(Some(&gain(Some(bad), None, None)), NormalizeMode::Track),
                1.0,
                "{bad}"
            );
        }
    }

    #[test]
    fn a_timer_fades_over_ten_seconds_or_all_of_it_when_shorter() {
        assert_eq!(sleep_timer_span(30.0), (1_800_000, 10_000));
        assert_eq!(sleep_timer_span(0.05), (3000, 3000));
    }

    #[test]
    fn what_is_left_is_written_for_people() {
        assert_eq!(describe_remaining(0), "moins d'une minute");
        assert_eq!(describe_remaining(-5000), "moins d'une minute");
        assert_eq!(describe_remaining(30_000), "1 min");
        assert_eq!(describe_remaining(23 * 60_000 - 5000), "23 min");
        assert_eq!(describe_remaining(60 * 60_000), "1 h 00");
        assert_eq!(describe_remaining(65 * 60_000), "1 h 05");
        assert_eq!(describe_remaining(90 * 60_000 - 1), "1 h 30");
    }

    #[test]
    fn coming_back_after_the_deadline_ends_the_timer_before_it_nothing_changes() {
        let timer = SleepMode::Timer { ends_at: 10_000 };
        assert_eq!(timer.on_resume(10_500), timer);
        assert_eq!(timer.on_resume(11_001), SleepMode::Off);
        assert_eq!(
            SleepMode::AfterTrack.on_resume(u64::MAX),
            SleepMode::AfterTrack
        );
    }
}
