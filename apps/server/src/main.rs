use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use selfhost_hub_server::auth::NavidromeAuth;
use selfhost_hub_server::config::Config;
use selfhost_hub_server::db::Db;
use selfhost_hub_server::shell;
use selfhost_hub_server::system::{Monitor, SysConfig};
use selfhost_hub_server::{AppState, router};
use tokio::sync::watch;

/// `--healthcheck`: GET /api/health on localhost, exit 0 when it answers 200. For the Docker HEALTHCHECK.
fn healthcheck() -> ExitCode {
    let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(51823u16);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let ok = (|| -> std::io::Result<bool> {
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
        s.set_read_timeout(Some(Duration::from_secs(3)))?;
        s.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut buf = String::new();
        s.read_to_string(&mut buf)?;
        Ok(buf.starts_with("HTTP/1.0 200") || buf.starts_with("HTTP/1.1 200"))
    })();
    if ok.unwrap_or(false) { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// --reset-totp <user> and --reset-shell-hostkey: edit the database and exit. For a lost phone or a reinstalled host.
fn reset(args: &[String]) -> Option<ExitCode> {
    let reset_totp = args.iter().position(|a| a == "--reset-totp");
    let reset_hostkey = args.iter().any(|a| a == "--reset-shell-hostkey");
    if reset_totp.is_none() && !reset_hostkey {
        return None;
    }
    let run = || -> Result<(), String> {
        let dir = std::env::var("DATA_DIR").ok().filter(|d| !d.trim().is_empty()).unwrap_or_else(|| "/data".into());
        let path = std::path::Path::new(&dir).join("hub.db");
        let db = Db::open(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        if let Some(i) = reset_totp {
            let user = args.get(i + 1).filter(|u| !u.starts_with("--")).ok_or("--reset-totp needs a user name")?.to_lowercase();
            let removed = db.totp_delete(&user).map_err(|e| e.to_string())?;
            println!("{}", if removed { format!("TOTP removed for {user}; set it up again in the Terminal tab.") } else { format!("{user} had no TOTP configured.") });
        }
        if reset_hostkey {
            let n = db.hostkey_clear().map_err(|e| e.to_string())?;
            println!("{n} pinned SSH host key(s) forgotten; the next connection pins the key the host presents.");
        }
        Ok(())
    };
    Some(match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("selfhost-hub-server: {e}");
            ExitCode::FAILURE
        }
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--healthcheck") {
        return healthcheck();
    }
    if let Some(code) = reset(&args) {
        return code;
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("selfhost-hub-server: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = Config::from_env()?;
    std::fs::create_dir_all(&config.data_dir).map_err(|e| format!("cannot create {}: {e}", config.data_dir.display()))?;
    let db_path = config.data_dir.join("hub.db");
    let db = Db::open(&db_path).map_err(|e| format!("cannot open {}: {e}", db_path.display()))?;
    // The terminal's key exists even when the feature is off, so the panel can show the line to add to authorized_keys.
    let key_path = config.data_dir.join(shell::KEY_FILE);
    let shell_key = match shell::load_or_create_key(&key_path) {
        Ok(k) => Some(k),
        Err(e) if config.shell.is_some() => return Err(e),
        Err(e) => {
            tracing::warn!("terminal key unavailable: {e}");
            None
        }
    };
    let auth = NavidromeAuth::new(&config.navidrome_url).map_err(|e| format!("http client: {e}"))?;

    let (stop_tx, stop_rx) = watch::channel(false);
    let monitor = Monitor::new(SysConfig {
        proc_dir: config.host_proc.clone(),
        sys_dir: config.host_sys.clone(),
        root: config.host_root.clone(),
        docker_url: config.docker_url.clone(),
    });
    monitor.spawn();
    let gate_key = match &config.gate_domain {
        Some(_) => Some(
            db.secret("gate-key", || {
                let mut k = vec![0u8; 32];
                getrandom::fill(&mut k).expect("system randomness");
                k
            })
            .map_err(|e| format!("gate key: {e}"))?,
        ),
        None => None,
    };
    let mut state = AppState::new(&config.server_name, config.trust_proxy, db, Arc::new(auth), stop_rx)
        .with_runtime(db_path.clone(), &config.navidrome_url, monitor)
        .with_shell(shell::ShellState::new(config.shell.clone(), shell_key));
    if let (Some(domain), Some(key)) = (&config.gate_domain, gate_key) {
        tracing::info!(%domain, "sign-in gate enabled");
        state = state.with_gate(selfhost_hub_server::gate::Gate::new(domain, key));
    }
    if let Some(s) = &config.shell {
        tracing::info!(host = %s.host, port = s.port, user = %s.user, "admin terminal enabled (SSH to the host)");
    }
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", config.port))?;
    tracing::info!(
        port = config.port, navidrome = %config.navidrome_url, db = %db_path.display(),
        "selfhost-hub-server {} started", selfhost_hub_server::VERSION
    );
    axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutting down");
            let _ = stop_tx.send(true);
        })
        .await
        .map_err(|e| e.to_string())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}
