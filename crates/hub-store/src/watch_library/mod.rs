//! The library as the watch keeps it, so it can be browsed without the server answering.
//!
//! Port of `wear/data/src/main/kotlin/com/selfhosthub/wear/data/`: the Room database (`db/`), `LibrarySync.kt`,
//! `LibraryRepository.kt` and `ArtworkRepository.kt`, with their tests.
//!
//! The database file keeps Room's exact schema (same tables, columns, indexes, version and identity hash), so the
//! Rust watch app opens the file the Kotlin one left behind when it installs over it.

pub mod db;

pub use db::{
    AlbumRow, ArtistRow, ArtworkRow, Dao, DbError, DbResult, PlaylistRow, PlaylistTrackRow, SyncKind,
    SyncLogRow, SyncStatus, TrackRow, WatchDatabase,
};

#[cfg(test)]
pub(crate) mod testing;
