//! Pure logic shared by all apps, with no I/O: models, the link/update/Downtify protocols, pairing,
//! queue and shuffle rules, cover palette, lyrics parsing, scrobble rules, weekly recap, photo-vault path rules,
//! gesture recognizer.

pub mod app_lock;
pub mod car_actions;
pub mod cover_look;
pub mod downloads;
pub mod diagnostics;
pub mod covers;
pub mod format;
pub mod gallery;
pub mod gestures;
pub mod hand_gestures;
pub mod home_network;
pub mod listening;
pub mod lyrics;
pub mod music;
pub mod offline;
pub mod pairing;
pub mod palette;
pub mod paths;
pub mod plural;
pub mod protocol;
pub mod queue;
pub mod scrobble;
pub mod share_links;
pub mod song;
pub mod subsonic;
pub mod text;
pub mod update_asset;
pub mod upload_conflicts;
pub mod vault;
pub mod watch;
pub mod wrapped;

#[cfg(test)]
mod tests_support;
