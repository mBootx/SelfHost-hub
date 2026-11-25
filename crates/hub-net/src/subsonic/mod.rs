//! The Subsonic API as Navidrome serves it.
//!
//! Port of the watch's `wear/data/.../net/SubsonicApi.kt`. The desktop's and phone's `navidrome.ts` clients have
//! more calls (playlist editing, scrobbling, lyrics, admin); they are added here as their screens are ported.

mod client;
mod json;
mod models;

/// The in-memory Navidrome, for this crate's tests and, with the `fake` feature, for other crates' tests.
#[cfg(any(test, feature = "fake"))]
pub mod fake;

pub use client::{NetError, SubsonicClient, SubsonicError};
pub use models::*;
