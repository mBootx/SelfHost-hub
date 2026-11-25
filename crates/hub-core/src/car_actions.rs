//! What the car mode's gestures and buttons do. They drive whatever the player drives: this phone, or the device
//! picked as the output (the PC, another phone), exactly like the player's own buttons.
//!
//! Port of the pure parts of `mobile/src/services/carActions.ts`: which gesture means which action, the volume
//! steps and the words shown on screen after an action. Sending the command, moving the phone's media volume and
//! starring the song are I/O and stay with the app; it feeds the results in here.

use crate::hand_gestures::Gesture;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CarAction {
    Toggle,
    Next,
    Prev,
    VolumeUp,
    VolumeDown,
    Like,
}

impl CarAction {
    /// The player command for the actions that are plain commands (`toggle`, `next`, `prev`), the ones sent to the
    /// chosen device as they are and that have nothing to say on screen.
    pub fn command(self) -> Option<&'static str> {
        match self {
            Self::Toggle => Some("toggle"),
            Self::Next => Some("next"),
            Self::Prev => Some("prev"),
            Self::VolumeUp | Self::VolumeDown | Self::Like => None,
        }
    }

    /// 1 for louder, -1 for quieter, `None` for the actions that are not about the volume.
    pub fn volume_direction(self) -> Option<i8> {
        match self {
            Self::VolumeUp => Some(1),
            Self::VolumeDown => Some(-1),
            _ => None,
        }
    }
}

/// What each gesture does: a pinch plays or pauses, waves skip, an open hand sets the volume, a thumb likes.
pub fn action_for(gesture: Gesture) -> CarAction {
    match gesture {
        Gesture::Pinch => CarAction::Toggle,
        Gesture::WaveRight => CarAction::Next,
        Gesture::WaveLeft => CarAction::Prev,
        Gesture::PalmUp => CarAction::VolumeUp,
        Gesture::PalmDown => CarAction::VolumeDown,
        Gesture::ThumbUp => CarAction::Like,
    }
}

/// A step of the volume of a remote device, or of the app's own player when the phone's volume can't be reached.
pub const VOLUME_STEP: f64 = 0.1;

/// The volume a remote device is taken to have when it has not said.
pub const UNKNOWN_REMOTE_VOLUME: f64 = 0.5;

fn clamp01(level: f64) -> f64 {
    if level.is_nan() {
        0.0
    } else {
        level.clamp(0.0, 1.0)
    }
}

/// JavaScript's `Math.round`: halves go up.
fn round_half_up(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// A volume level from 0 to 1 as the screen shows it: "67 %" (a plain space before the sign, as the app writes it).
pub fn percent(level: f64) -> String {
    format!("{} %", round_half_up(clamp01(level) * 100.0) as i64)
}

/// What the screen says once the volume moved: "Volume 67 %".
pub fn volume_outcome(level: f64) -> String {
    format!("Volume {}", percent(level))
}

/// One step from `current`, kept within 0 and 1. `direction` is 1 or -1 ([`CarAction::volume_direction`]).
pub fn stepped_volume(current: f64, direction: i8) -> f64 {
    clamp01(current + f64::from(direction) * VOLUME_STEP)
}

/// The volume to send to another device and the words to show: a tenth up or down from what it reported (half when
/// it has not said), within 0 and 1. The sent level is rounded to hundredths so the wire does not carry 0.5500000001.
pub fn remote_volume(reported: Option<f64>, direction: i8) -> (f64, String) {
    let level = stepped_volume(reported.unwrap_or(UNKNOWN_REMOTE_VOLUME), direction);
    (round_half_up(level * 100.0) / 100.0, volume_outcome(level))
}

/// What the phone's own volume answered after being stepped like its buttons: the words to show, or `None` when it
/// could not be reached (an older build without it, a failure, a negative answer) and the app's own player volume
/// moves instead.
pub fn phone_volume_outcome(answer: Option<f64>) -> Option<String> {
    answer.filter(|after| *after >= 0.0).map(volume_outcome)
}

pub const NOTHING_PLAYING: &str = "Aucun titre en cours";
pub const ALREADY_FAVOURITE: &str = "Déjà dans vos favoris";
pub const ADDED_TO_FAVOURITES: &str = "Ajouté aux favoris";
pub const FAVOURITES_UNREACHABLE: &str = "Favoris injoignables";

/// What a thumb up does, before anything is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LikePlan {
    /// No song is playing, or there is no server to star it on: only a message.
    Nothing,
    /// A like, never an unlike: a thumb up on a favourite leaves it one.
    AlreadyFavourite,
    /// Star the song, then show [`like_outcome`] with the server's answer.
    Star,
}

impl LikePlan {
    /// The words to show when nothing is sent, `None` when the song is to be starred.
    pub fn message(self) -> Option<&'static str> {
        match self {
            Self::Nothing => Some(NOTHING_PLAYING),
            Self::AlreadyFavourite => Some(ALREADY_FAVOURITE),
            Self::Star => None,
        }
    }
}

pub fn like_plan(has_song: bool, has_client: bool, is_starred: bool) -> LikePlan {
    if !has_song || !has_client {
        LikePlan::Nothing
    } else if is_starred {
        LikePlan::AlreadyFavourite
    } else {
        LikePlan::Star
    }
}

/// The words after starring: whether the server took it. A refused like is not kept.
pub fn like_outcome(starred: bool) -> &'static str {
    if starred {
        ADDED_TO_FAVOURITES
    } else {
        FAVOURITES_UNREACHABLE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_gesture_does_what_the_spec_says_pinch_plays_or_pauses_waves_skip_an_open_hand_sets_the_volume_a_thumb_likes()
     {
        let expected = [
            (Gesture::Pinch, CarAction::Toggle),
            (Gesture::WaveRight, CarAction::Next),
            (Gesture::WaveLeft, CarAction::Prev),
            (Gesture::PalmUp, CarAction::VolumeUp),
            (Gesture::PalmDown, CarAction::VolumeDown),
            (Gesture::ThumbUp, CarAction::Like),
        ];
        for (gesture, action) in expected {
            assert_eq!(action_for(gesture), action);
        }
        // Every gesture the recognizer can raise has an action.
        assert_eq!(Gesture::ALL.len(), expected.len());
        for gesture in Gesture::ALL {
            assert!(expected.iter().any(|(g, _)| *g == gesture));
        }
    }

    #[test]
    fn play_pause_and_the_skips_go_where_the_player_buttons_go() {
        assert_eq!(CarAction::Toggle.command(), Some("toggle"));
        assert_eq!(CarAction::Next.command(), Some("next"));
        assert_eq!(CarAction::Prev.command(), Some("prev"));
        for action in [CarAction::VolumeUp, CarAction::VolumeDown, CarAction::Like] {
            assert_eq!(action.command(), None);
        }
        assert_eq!(CarAction::VolumeUp.volume_direction(), Some(1));
        assert_eq!(CarAction::VolumeDown.volume_direction(), Some(-1));
        assert_eq!(CarAction::Toggle.volume_direction(), None);
    }

    #[test]
    fn on_this_phone_the_volume_is_the_phones_media_volume_moved_like_its_buttons() {
        // The phone answers with the level it reached; the screen says it in percent.
        assert_eq!(
            phone_volume_outcome(Some(0.67)).as_deref(),
            Some("Volume 67 %")
        );
        assert_eq!(
            phone_volume_outcome(Some(0.0)).as_deref(),
            Some("Volume 0 %")
        );
    }

    #[test]
    fn without_the_phones_volume_an_older_build_the_apps_own_volume_moves_instead_within_0_and_1() {
        // No answer, or a negative one, sends the app to its own player's volume.
        assert_eq!(phone_volume_outcome(None), None);
        assert_eq!(phone_volume_outcome(Some(-1.0)), None);
        let up = stepped_volume(0.95, 1);
        assert_eq!(up, 1.0);
        assert_eq!(volume_outcome(up), "Volume 100 %");
        assert_eq!(stepped_volume(0.05, -1), 0.0);
        assert!((stepped_volume(0.8, 1) - 0.9).abs() < 1e-9);
    }

    #[test]
    fn driving_another_device_the_volume_is_that_devices_a_tenth_at_a_time_within_0_and_1() {
        assert_eq!(
            remote_volume(Some(0.45), 1),
            (0.55, "Volume 55 %".to_string())
        );
        assert_eq!(remote_volume(Some(0.98), 1).0, 1.0);
        assert_eq!(remote_volume(Some(0.02), -1).0, 0.0);
        // The device has not said: half, so a step down lands on 0.4.
        assert_eq!(remote_volume(None, -1), (0.4, "Volume 40 %".to_string()));
    }

    #[test]
    fn the_volume_is_shown_in_whole_percent_and_never_outside_0_and_100() {
        assert_eq!(percent(0.665), "67 %");
        assert_eq!(percent(1.7), "100 %");
        assert_eq!(percent(-0.2), "0 %");
        assert_eq!(percent(f64::NAN), "0 %");
    }

    #[test]
    fn a_thumb_up_likes_the_song_playing_once_on_a_favourite_it_does_nothing_it_never_unlikes() {
        assert_eq!(like_plan(true, true, false), LikePlan::Star);
        assert_eq!(LikePlan::Star.message(), None);
        assert_eq!(like_outcome(true), "Ajouté aux favoris");
        // Once starred, the same thumb leaves it so.
        let again = like_plan(true, true, true);
        assert_eq!(again, LikePlan::AlreadyFavourite);
        assert_eq!(again.message(), Some("Déjà dans vos favoris"));
    }

    #[test]
    fn nothing_playing_or_the_server_refusing_is_said_a_refused_like_is_not_kept() {
        for plan in [
            like_plan(false, true, false),
            like_plan(true, false, false),
            like_plan(false, false, true),
        ] {
            assert_eq!(plan, LikePlan::Nothing);
            assert_eq!(plan.message(), Some("Aucun titre en cours"));
        }
        assert_eq!(like_outcome(false), "Favoris injoignables");
    }
}
