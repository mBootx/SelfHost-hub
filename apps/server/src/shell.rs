//! The admin terminal's SSH side: a pure-Rust SSH client that opens an interactive shell on the host.
//!
//! The hub holds an ed25519 key (`DATA_DIR/shell_ed25519`); the owner puts its public half in the host user's
//! `authorized_keys`. The host key is trusted on first use and its fingerprint pinned in the database.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};

use crate::db::Db;

pub const KEY_FILE: &str = "shell_ed25519";
pub const KEY_COMMENT: &str = "selfhost-hub-shell";
/// Shells open at the same time, all users together.
pub const MAX_SHELLS: usize = 2;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const MAX_DURATION: Duration = Duration::from_secs(4 * 3600);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl ShellConfig {
    /// What the host key is pinned for.
    pub fn target(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// The terminal feature as the rest of the server sees it: off (no config) or on, with its key.
pub struct ShellState {
    pub config: Option<ShellConfig>,
    pub key: Option<Arc<PrivateKey>>,
    pub idle: Duration,
    pub max: Duration,
    active: AtomicUsize,
}

impl Default for ShellState {
    fn default() -> Self {
        Self::new(None, None)
    }
}

/// Holds one of the [`MAX_SHELLS`] places until dropped.
pub struct ShellSlot(Arc<ShellState>);

impl Drop for ShellSlot {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ShellState {
    pub fn new(config: Option<ShellConfig>, key: Option<PrivateKey>) -> Self {
        Self { config, key: key.map(Arc::new), idle: IDLE_TIMEOUT, max: MAX_DURATION, active: AtomicUsize::new(0) }
    }

    /// Other idle and total time limits (tests).
    pub fn with_limits(mut self, idle: Duration, max: Duration) -> Self {
        self.idle = idle;
        self.max = max;
        self
    }

    pub fn enabled(&self) -> bool {
        self.config.is_some() && self.key.is_some()
    }

    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    /// A place for one more shell, or `None` when [`MAX_SHELLS`] are open.
    pub fn acquire(self: &Arc<Self>) -> Option<ShellSlot> {
        self.active.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_SHELLS).then_some(n + 1)).ok()?;
        Some(ShellSlot(self.clone()))
    }
}

// ---------- key ----------

/// A fresh ed25519 key, from the system's randomness.
pub fn generate_key() -> PrivateKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).expect("system randomness");
    PrivateKey::new(KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed)), KEY_COMMENT).expect("an ed25519 key")
}

/// Reads `path`, or creates it (mode 0600) with a new key when it does not exist.
pub fn load_or_create_key(path: &Path) -> Result<PrivateKey, String> {
    match std::fs::read(path) {
        Ok(bytes) => PrivateKey::from_openssh(&bytes).map_err(|e| format!("{} is not a valid OpenSSH key: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = generate_key();
            let pem = key.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;
            write_private(path, pem.as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            tracing::info!(path = %path.display(), "generated the terminal's SSH key");
            Ok(key)
        }
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)?.write_all(bytes)
}

/// The `authorized_keys` line to paste on the host: restricted to Docker networks and to a plain shell.
pub fn authorized_line(key: &PrivateKey) -> String {
    let public = key.public_key().to_openssh().unwrap_or_default();
    format!(r#"from="172.16.0.0/12,192.168.0.0/16",no-agent-forwarding,no-X11-forwarding,no-port-forwarding {public}"#)
}

pub fn fingerprint(key: &russh::keys::PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

// ---------- errors ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellError {
    /// The host did not answer (or refused the connection).
    Unreachable(String),
    /// The host presents another key than the pinned one.
    HostKeyMismatch { pinned: String, presented: String },
    AuthFailed,
    Ssh(String),
}

impl ShellError {
    /// Stable code for the panel.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreachable(_) => "ssh-unreachable",
            Self::HostKeyMismatch { .. } => "hostkey-mismatch",
            Self::AuthFailed => "ssh-auth-failed",
            Self::Ssh(_) => "ssh-error",
        }
    }
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(e) => write!(f, "cannot reach the SSH server: {e}"),
            Self::HostKeyMismatch { pinned, presented } => {
                write!(f, "the host key changed (pinned {pinned}, presented {presented}); run --reset-shell-hostkey if that is expected")
            }
            Self::AuthFailed => write!(f, "the host refused the hub's key: add it to authorized_keys"),
            Self::Ssh(e) => write!(f, "SSH error: {e}"),
        }
    }
}

// ---------- client ----------

enum Rejection {
    Mismatch { pinned: String, presented: String },
    Db(String),
}

struct Client {
    target: String,
    db: Db,
    rejected: Arc<Mutex<Option<Rejection>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let presented = fingerprint(&server_public_key.public_key());
        let verdict = match self.db.hostkey_get(&self.target) {
            Ok(Some(pinned)) if pinned == presented => None,
            Ok(Some(pinned)) => Some(Rejection::Mismatch { pinned, presented }),
            // First use: trust and pin. A concurrent first connection pins one key only; the other is checked on its next try.
            Ok(None) => match self.db.hostkey_pin(&self.target, &presented) {
                Ok(_) => {
                    tracing::info!(target = %self.target, fingerprint = %presented, "pinned the SSH host key (first use)");
                    None
                }
                Err(e) => Some(Rejection::Db(e.to_string())),
            },
            Err(e) => Some(Rejection::Db(e.to_string())),
        };
        let ok = verdict.is_none();
        if let Some(v) = verdict {
            *self.rejected.lock().unwrap_or_else(|e| e.into_inner()) = Some(v);
        }
        Ok(ok)
    }
}

/// An open interactive shell on the host.
pub struct SshShell {
    handle: client::Handle<Client>,
    channel: Channel<client::Msg>,
}

impl SshShell {
    /// Connects, checks the host key against the pin, signs in with `key` and opens a shell on a
    /// `xterm-256color` terminal of `cols` x `rows`.
    pub async fn connect(cfg: &ShellConfig, key: Arc<PrivateKey>, db: &Db, cols: u32, rows: u32) -> Result<Self, ShellError> {
        let rejected = Arc::new(Mutex::new(None));
        let handler = Client { target: cfg.target(), db: db.clone(), rejected: rejected.clone() };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 4,
            nodelay: true,
            ..Default::default()
        });
        let rejection = || rejected.lock().unwrap_or_else(|e| e.into_inner()).take();
        let connect = client::connect(config, (cfg.host.as_str(), cfg.port), handler);
        let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
            Err(_) => return Err(ShellError::Unreachable("timeout".into())),
            Ok(Ok(h)) => h,
            Ok(Err(e)) => {
                return Err(match rejection() {
                    Some(Rejection::Mismatch { pinned, presented }) => ShellError::HostKeyMismatch { pinned, presented },
                    Some(Rejection::Db(e)) => ShellError::Ssh(format!("database: {e}")),
                    None => match e {
                        russh::Error::IO(io) => ShellError::Unreachable(io.to_string()),
                        other => ShellError::Ssh(other.to_string()),
                    },
                });
            }
        };
        let auth = handle
            .authenticate_publickey(cfg.user.clone(), PrivateKeyWithHashAlg::new(key, None))
            .await
            .map_err(|e| ShellError::Ssh(e.to_string()))?;
        if !auth.success() {
            return Err(ShellError::AuthFailed);
        }
        let ssh = |e: russh::Error| ShellError::Ssh(e.to_string());
        let channel = handle.channel_open_session().await.map_err(ssh)?;
        channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(ssh)?;
        channel.request_shell(true).await.map_err(ssh)?;
        Ok(Self { handle, channel })
    }

    pub async fn write(&self, data: &[u8]) -> Result<(), ShellError> {
        self.channel.data_bytes(data.to_vec()).await.map_err(|e| ShellError::Ssh(e.to_string()))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), ShellError> {
        self.channel.window_change(cols, rows, 0, 0).await.map_err(|e| ShellError::Ssh(e.to_string()))
    }

    /// The next bytes the shell printed; `None` once the shell is gone. Cancel safe.
    pub async fn read(&mut self) -> Option<Vec<u8>> {
        loop {
            match self.channel.wait().await? {
                ChannelMsg::Data { data } => return Some(data.to_vec()),
                ChannelMsg::ExtendedData { data, .. } => return Some(data.to_vec()),
                ChannelMsg::Close => return None,
                _ => {}
            }
        }
    }

    /// Hangs up.
    pub async fn close(self) {
        let _ = self.channel.close().await;
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_line_is_restricted_and_ready_to_paste() {
        let key = generate_key();
        let line = authorized_line(&key);
        assert!(line.starts_with(r#"from="172.16.0.0/12,192.168.0.0/16",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 AAAA"#), "{line}");
        assert!(line.ends_with(" selfhost-hub-shell"), "{line}");
        assert!(!line.contains('\n'));
    }

    #[test]
    fn key_is_created_once_and_reloaded() {
        let dir = std::env::temp_dir().join(format!("shh-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(KEY_FILE);
        let a = load_or_create_key(&path).unwrap();
        let b = load_or_create_key(&path).unwrap();
        assert_eq!(a.public_key(), b.public_key());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&path, "garbage").unwrap();
        assert!(load_or_create_key(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slots_are_limited_and_released() {
        let s = Arc::new(ShellState::default());
        let a = s.acquire().unwrap();
        let _b = s.acquire().unwrap();
        assert!(s.acquire().is_none());
        assert_eq!(s.active(), 2);
        drop(a);
        assert!(s.acquire().is_some());
    }
}
