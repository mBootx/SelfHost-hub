//! SelfHost Hub desktop app, Rust rewrite. Replaces the Electron app in `src/` (see docs/rust-rewrite.md).

// Release builds open no console window next to the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

fn main() -> Result<(), slint::PlatformError> {
    AppWindow::new()?.run()
}
