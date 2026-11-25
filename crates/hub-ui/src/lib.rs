//! Slint components shared by the desktop, phone and watch apps.
//!
//! The components live in this crate's `ui/` folder. Apps import them from `.slint` files as
//! `@hub-ui/<file>.slint`, after mapping the `hub-ui` library name to [`UI_DIR`] in their build script.

/// Absolute path of this crate's `ui/` folder, for `slint_build::CompilerConfiguration::with_library_paths`.
pub const UI_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/ui");
