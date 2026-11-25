//! The watch's own settings and when it opens its player by itself.
//!
//! Port of `wear/core/.../WatchPrefs.kt` (the settings, not their Android storage) and `AutoOpenPolicy.kt`.
//! Times are milliseconds on the wall clock, as the Kotlin app stored them.

/// The watch's own settings and small memories: nothing in here is a secret. The app persists the whole struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchPrefs {
    /// The player picked by hand; `None` while the watch follows whichever one is playing.
    pub manual_target_id: Option<String>,
    /// When it was picked: a player that starts playing after that is followed instead.
    pub manual_target_at: u64,
    /// The player that was being controlled last, to come back to it.
    pub last_target_id: Option<String>,
    /// Open the player when music starts after a quiet spell (and offer it as a chip on the watch face).
    pub auto_launch: bool,
    /// When something was last heard playing (0: never), so a restart of the app does not reopen it mid-song.
    pub last_playing_at: u64,
    /// Whether something was playing in the last state heard.
    pub was_playing: bool,
}

impl Default for WatchPrefs {
    fn default() -> Self {
        Self {
            manual_target_id: None,
            manual_target_at: 0,
            last_target_id: None,
            auto_launch: true,
            last_playing_at: 0,
            was_playing: false,
        }
    }
}

impl WatchPrefs {
    /// Forgets the players the watch had been using (the settings that are not choices of the user).
    pub fn forget_players(&mut self) {
        self.manual_target_id = None;
        self.last_target_id = None;
    }
}

/// When the watch opens its player by itself: music starts (any player going from silent to playing) after at
/// least `quiet_ms` without music, the setting is on, and the app is not already on screen. A pause and a resume a
/// minute later, or a skip, do not open it again; a song already playing when the app process starts does not
/// either (what was playing is remembered in the preferences, not in memory).
#[derive(Debug, Clone, Copy)]
pub struct AutoOpenPolicy {
    pub quiet_ms: u64,
}

impl Default for AutoOpenPolicy {
    fn default() -> Self {
        Self {
            quiet_ms: Self::DEFAULT_QUIET_MS,
        }
    }
}

impl AutoOpenPolicy {
    pub const DEFAULT_QUIET_MS: u64 = 3 * 60_000;

    /// Called with every state heard; true when the player should be opened now. Updates `prefs`.
    pub fn on_state(
        &self,
        prefs: &mut WatchPrefs,
        playing: bool,
        now: u64,
        app_visible: bool,
    ) -> bool {
        let was_playing = prefs.was_playing;
        let started = playing && !was_playing;
        let quiet_long_enough = prefs.last_playing_at == 0
            || now.saturating_sub(prefs.last_playing_at) >= self.quiet_ms;
        // Playing now, or playing until this moment: either way music was heard just now.
        if playing || was_playing {
            prefs.last_playing_at = now;
        }
        prefs.was_playing = playing;
        started && quiet_long_enough && prefs.auto_launch && !app_visible
    }
}

// Ported from wear/core/src/test/kotlin/com/selfhosthub/wear/core/AutoOpenPolicyTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: u64 = 60_000;

    #[test]
    fn music_starting_opens_the_player_once_not_again_while_it_plays() {
        let (policy, mut prefs) = (AutoOpenPolicy::default(), WatchPrefs::default());
        assert!(policy.on_state(&mut prefs, true, 0, false));
        assert!(!policy.on_state(&mut prefs, true, 30_000, false));
        assert!(!policy.on_state(&mut prefs, true, 4 * MINUTE, false));
    }

    #[test]
    fn a_pause_and_a_resume_soon_after_do_not_open_it_again() {
        let (policy, mut prefs) = (AutoOpenPolicy::default(), WatchPrefs::default());
        policy.on_state(&mut prefs, true, 0, false);
        policy.on_state(&mut prefs, false, 10 * MINUTE, false);
        assert!(!policy.on_state(&mut prefs, true, 11 * MINUTE, false));
    }

    #[test]
    fn music_starting_after_three_quiet_minutes_opens_it_again() {
        let (policy, mut prefs) = (AutoOpenPolicy::default(), WatchPrefs::default());
        policy.on_state(&mut prefs, true, 0, false);
        policy.on_state(&mut prefs, false, 10 * MINUTE, false);
        assert!(!policy.on_state(&mut prefs, false, 12 * MINUTE, false));
        assert!(policy.on_state(&mut prefs, true, 13 * MINUTE, false));
    }

    #[test]
    fn nothing_opens_over_the_app_on_screen_or_with_the_setting_off() {
        let policy = AutoOpenPolicy::default();
        assert!(!policy.on_state(&mut WatchPrefs::default(), true, 0, true));
        let mut off = WatchPrefs {
            auto_launch: false,
            ..WatchPrefs::default()
        };
        assert!(!policy.on_state(&mut off, true, 0, false));
    }

    #[test]
    fn the_app_process_starting_again_while_music_plays_does_not_reopen_it() {
        let mut prefs = WatchPrefs::default();
        AutoOpenPolicy::default().on_state(&mut prefs, true, 0, false);
        // A new process: a new policy, the same preferences.
        assert!(!AutoOpenPolicy::default().on_state(&mut prefs, true, 2 * MINUTE, false));
    }

    #[test]
    fn the_time_of_the_last_music_heard_is_kept_also_when_it_stops() {
        let (policy, mut prefs) = (AutoOpenPolicy::default(), WatchPrefs::default());
        policy.on_state(&mut prefs, true, 5 * MINUTE, false);
        assert_eq!(prefs.last_playing_at, 5 * MINUTE);
        policy.on_state(&mut prefs, false, 9 * MINUTE, false);
        assert_eq!(prefs.last_playing_at, 9 * MINUTE);
        assert!(!prefs.was_playing);
        policy.on_state(&mut prefs, false, 20 * MINUTE, false);
        assert_eq!(prefs.last_playing_at, 9 * MINUTE);
    }

    #[test]
    fn forgetting_the_players_keeps_the_user_choices() {
        let mut prefs = WatchPrefs {
            manual_target_id: Some("hub".into()),
            last_target_id: Some("local".into()),
            auto_launch: false,
            ..WatchPrefs::default()
        };
        prefs.forget_players();
        assert_eq!(prefs.manual_target_id, None);
        assert_eq!(prefs.last_target_id, None);
        assert!(!prefs.auto_launch);
    }
}
