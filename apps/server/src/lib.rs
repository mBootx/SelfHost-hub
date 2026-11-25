//! SelfHost Hub server: remote-control relay and listening-data store. Protocol: docs/server-protocol.md.

pub mod admin;
pub mod alerts;
pub mod auth;
pub mod backup;
pub mod config;
pub mod db;
pub mod downtify;
pub mod gate;
pub mod hub;
pub mod limiter;
pub mod protocol;
pub mod shell;
pub mod system;
pub mod terminal;
pub mod totp;
pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use axum::{Json, Router, extract::State, routing::get};
use tokio::sync::watch;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Everything a connection needs. Cheap to clone.
#[derive(Clone)]
pub struct AppState {
    pub server_name: Arc<str>,
    pub trust_proxy: bool,
    pub db: db::Db,
    pub hub: Arc<hub::Hub>,
    pub auth: Arc<dyn auth::Authenticator>,
    pub limiter: Arc<limiter::Limiter>,
    pub admin: Arc<admin::AdminState>,
    pub monitor: Arc<system::Monitor>,
    pub started: Instant,
    pub db_path: Option<PathBuf>,
    pub navidrome_url: Arc<str>,
    /// The admin terminal (off unless configured).
    pub shell: Arc<shell::ShellState>,
    /// The sign-in gate for other services (off unless GATE_DOMAIN is set).
    pub gate: Option<Arc<gate::Gate>>,
    /// Signer and verifier for mobile/desktop Downtify client tokens.
    pub client_token: Arc<downtify::ClientToken>,
    /// Reverse proxy to Downtify (off unless DOWNTIFY_URL is set).
    pub downtify: Option<Arc<downtify::DowntifyProxy>>,
    /// Threshold alert evaluator and webhook notifier.
    pub alerts: Arc<alerts::AlertEngine>,
    /// SQLite backup manager.
    pub backups: Option<Arc<backup::BackupManager>>,
    /// Turns `true` when the server is shutting down.
    pub shutdown: watch::Receiver<bool>,
}

impl AppState {
    pub fn new(
        server_name: &str,
        trust_proxy: bool,
        db: db::Db,
        auth: Arc<dyn auth::Authenticator>,
        shutdown: watch::Receiver<bool>,
    ) -> Self {
        Self {
            server_name: server_name.into(),
            trust_proxy,
            db,
            hub: Arc::new(hub::Hub::default()),
            auth,
            limiter: Arc::new(limiter::Limiter::default()),
            admin: Arc::default(),
            monitor: system::Monitor::new(system::SysConfig::default()),
            started: Instant::now(),
            db_path: None,
            navidrome_url: "".into(),
            shell: Arc::default(),
            gate: None,
            client_token: Arc::new(downtify::ClientToken::new(b"test-client-key-0123456789abcdef".to_vec())),
            downtify: None,
            alerts: alerts::AlertEngine::new(alerts::AlertConfig::default()),
            backups: None,
            shutdown,
        }
    }

    /// Turns the sign-in gate on.
    pub fn with_gate(mut self, gate: gate::Gate) -> Self {
        self.gate = Some(Arc::new(gate));
        self
    }

    /// Sets the Downtify client bearer-token signer.
    pub fn with_client_token(mut self, client_token: Arc<downtify::ClientToken>) -> Self {
        self.client_token = client_token;
        self
    }

    /// Turns the Downtify HTTP reverse proxy on.
    pub fn with_downtify(mut self, downtify: Arc<downtify::DowntifyProxy>) -> Self {
        self.downtify = Some(downtify);
        self
    }

    /// Sets the alert engine.
    pub fn with_alerts(mut self, alerts: Arc<alerts::AlertEngine>) -> Self {
        self.alerts = alerts;
        self
    }

    /// Sets the SQLite backup manager.
    pub fn with_backups(mut self, backups: Arc<backup::BackupManager>) -> Self {
        self.backups = Some(backups);
        self
    }

    /// What the admin panel shows about the process: the database file, Navidrome, and the host monitor.
    /// Turns the admin terminal on (or leaves it off, with the key only shown) with this configuration.
    pub fn with_shell(mut self, shell: shell::ShellState) -> Self {
        self.shell = Arc::new(shell);
        self
    }

    pub fn with_runtime(mut self, db_path: PathBuf, navidrome_url: &str, monitor: Arc<system::Monitor>) -> Self {
        self.db_path = Some(db_path);
        self.navidrome_url = navidrome_url.into();
        self.monitor = monitor;
        self
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/ws", get(ws::upgrade))
        .merge(admin::routes())
        .merge(gate::routes())
        .merge(downtify::routes())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "app": "selfhost-hub-server",
        "version": VERSION,
        "name": &*state.server_name,
    }))
}
