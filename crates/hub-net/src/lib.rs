//! HTTP clients: Subsonic (Navidrome), Navidrome admin, FileBrowser, Downtify, lyrics.
//!
//! The clients hold the protocol logic only: what to ask, how to sign it, how to read the answer. The actual HTTP
//! requests go through a [`Transport`], so the same client runs on the desktop, the phone and the watch, and the
//! tests run against an in-memory server.

pub mod downtify;
pub mod filebrowser;
#[cfg(feature = "http")]
mod http;
pub mod lyrics;
pub mod navidrome_admin;
pub mod radio;
#[cfg(test)]
mod scripted;
pub mod subsonic;
mod transport;
mod url;

#[cfg(feature = "http")]
pub use http::HttpTransport;
pub use transport::{Method, Reply, Request, Transport, TransportError};
