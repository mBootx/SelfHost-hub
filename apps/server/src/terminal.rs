//! Admin terminal endpoints: TOTP setup, unlock, shell info and audit, and the shell WebSocket.
//! Protocol: docs/server-protocol.md.

use std::net::{IpAddr, SocketAddr};
use std::time::Instant;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::admin::{ELEVATION, clear_cookie, fail, over_https, reply, require_csrf, require_session_id, str_field};
use crate::shell::{MAX_SHELLS, ShellError, ShellSlot, SshShell, fingerprint};
use crate::ws::client_ip;
use crate::{AppState, totp};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/admin/totp/setup", post(totp_setup))
        .route("/api/admin/totp/confirm", post(totp_confirm))
        .route("/api/admin/shell/unlock", post(unlock))
        .route("/api/admin/shell/info", get(info))
        .route("/api/admin/shell/audit", get(audit))
        .route("/api/admin/shell/ws", get(shell_ws))
}

fn now_secs() -> u64 {
    crate::admin::unix_now()
}

// ---------- TOTP codes ----------

enum CodeCheck {
    Ok,
    NotSet,
    Bad,
    Db,
}

/// Checks `code` against the user's stored secret and burns its time step.
async fn check_user_code(state: &AppState, user: &str, code: &str) -> CodeCheck {
    let db = state.db.clone();
    let u = user.to_string();
    let Ok(Ok(row)) = tokio::task::spawn_blocking(move || db.totp_get(&u)).await else { return CodeCheck::Db };
    let Some((secret_b32, last)) = row else { return CodeCheck::NotSet };
    let (Some(secret), Some(code)) = (totp::decode_secret(&secret_b32), totp::parse_code(code)) else { return CodeCheck::Bad };
    let Some(step) = totp::verify(&secret, code, now_secs()) else { return CodeCheck::Bad };
    if (step as i64) <= last {
        return CodeCheck::Bad;
    }
    let db = state.db.clone();
    let u = user.to_string();
    // The update only succeeds for a step newer than the stored one: two requests with the same code cannot both pass.
    match tokio::task::spawn_blocking(move || db.totp_accept_step(&u, step as i64)).await {
        Ok(Ok(true)) => CodeCheck::Ok,
        Ok(Ok(false)) => CodeCheck::Bad,
        _ => CodeCheck::Db,
    }
}

/// A wrong code: feeds the IP limiter, counts against the session and destroys it on the fifth.
fn bad_code(state: &AppState, headers: &HeaderMap, sid: &str, ip: IpAddr, user: &str) -> Response {
    state.limiter.record_failure(ip, Instant::now());
    if state.admin.note_code_failure(sid) {
        tracing::warn!(%ip, %user, "terminal: too many wrong codes, session destroyed");
        let mut resp = fail(StatusCode::UNAUTHORIZED, "session-destroyed");
        resp.headers_mut().insert(header::SET_COOKIE, clear_cookie(state, headers));
        return resp;
    }
    tracing::info!(%ip, %user, "terminal: wrong code");
    reply(StatusCode::FORBIDDEN, json!({"error": "bad-code", "attemptsLeft": state.admin.code_attempts_left(sid)}))
}

/// Session, CSRF header and limiter gate shared by the code-taking POSTs.
#[allow(clippy::result_large_err)]
fn code_gate(state: &AppState, headers: &HeaderMap, peer: SocketAddr) -> Result<(String, String, IpAddr), Response> {
    let (sid, user) = require_session_id(state, headers)?;
    require_csrf(headers)?;
    let ip = client_ip(state.trust_proxy, headers, peer.ip());
    if state.limiter.is_blocked(ip, Instant::now()) {
        return Err(fail(StatusCode::TOO_MANY_REQUESTS, "too-many-attempts"));
    }
    Ok((sid, user, ip))
}

async fn totp_configured(state: &AppState, user: &str) -> Option<bool> {
    let db = state.db.clone();
    let u = user.to_string();
    tokio::task::spawn_blocking(move || db.totp_get(&u)).await.ok()?.ok().map(|r| r.is_some())
}

async fn totp_setup(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let (sid, user, ip) = match code_gate(&state, &headers, peer) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(configured) = totp_configured(&state, &user).await else { return fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error") };
    if configured {
        // Rotating a secret needs a valid current code.
        let Some(code) = str_field(&body, "code") else { return fail(StatusCode::FORBIDDEN, "code-required") };
        match check_user_code(&state, &user, &code).await {
            CodeCheck::Ok => {}
            CodeCheck::Bad | CodeCheck::NotSet => return bad_code(&state, &headers, &sid, ip, &user),
            CodeCheck::Db => return fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error"),
        }
    }
    let secret = totp::new_secret();
    let b32 = totp::encode_secret(&secret);
    let uri = totp::otpauth_uri(&user, &b32);
    let Some(svg) = totp::qr_svg(&uri) else { return fail(StatusCode::INTERNAL_SERVER_ERROR, "qr-error") };
    state.admin.set_pending_totp(&user, secret.to_vec());
    tracing::info!(%ip, %user, rotate = configured, "terminal: TOTP setup started");
    reply(StatusCode::OK, json!({"secret": b32, "otpauth": uri, "qrSvg": svg}))
}

async fn totp_confirm(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let (sid, user, ip) = match code_gate(&state, &headers, peer) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(secret) = state.admin.pending_totp(&user) else { return fail(StatusCode::CONFLICT, "no-pending-setup") };
    let Some(code) = str_field(&body, "code").and_then(|c| totp::parse_code(&c)) else {
        return bad_code(&state, &headers, &sid, ip, &user);
    };
    let Some(step) = totp::verify(&secret, code, now_secs()) else { return bad_code(&state, &headers, &sid, ip, &user) };
    let db = state.db.clone();
    let (u, b32) = (user.clone(), totp::encode_secret(&secret));
    if !matches!(tokio::task::spawn_blocking(move || db.totp_set(&u, &b32, step as i64)).await, Ok(Ok(()))) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error");
    }
    state.admin.clear_pending_totp(&user);
    // The owner just proved they hold the new secret: no second code needed right now.
    state.admin.elevate(&sid);
    tracing::info!(%ip, %user, "terminal: TOTP configured");
    reply(StatusCode::OK, json!({"ok": true, "elevatedFor": ELEVATION.as_secs()}))
}

async fn unlock(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let (sid, user, ip) = match code_gate(&state, &headers, peer) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let code = str_field(&body, "code").unwrap_or_default();
    match check_user_code(&state, &user, &code).await {
        CodeCheck::Ok => {
            state.admin.elevate(&sid);
            state.limiter.record_success(ip);
            tracing::info!(%ip, %user, "terminal: unlocked");
            reply(StatusCode::OK, json!({"ok": true, "elevatedFor": ELEVATION.as_secs()}))
        }
        CodeCheck::NotSet => fail(StatusCode::CONFLICT, "totp-not-set"),
        CodeCheck::Bad => bad_code(&state, &headers, &sid, ip, &user),
        CodeCheck::Db => fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error"),
    }
}

// ---------- info and audit ----------

async fn info(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (sid, user) = match require_session_id(&state, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let sh = &state.shell;
    let db = state.db.clone();
    let target = sh.config.as_ref().map(|c| c.target());
    let u = user.clone();
    let Ok(Ok((totp, pinned))) = tokio::task::spawn_blocking(move || {
        Ok::<_, rusqlite::Error>((db.totp_get(&u)?.is_some(), match target {
            Some(t) => db.hostkey_get(&t)?,
            None => None,
        }))
    })
    .await
    else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error");
    };
    reply(
        StatusCode::OK,
        json!({
            "enabled": sh.enabled(),
            "host": sh.config.as_ref().map(|c| &c.host),
            "port": sh.config.as_ref().map(|c| c.port),
            "sshUser": sh.config.as_ref().map(|c| &c.user),
            "authorizedKey": sh.key.as_ref().map(|k| crate::shell::authorized_line(k)),
            "keyFingerprint": sh.key.as_ref().map(|k| fingerprint(k.public_key())),
            "hostKey": pinned,
            "totp": totp,
            "elevatedFor": state.admin.elevated_for(&sid).map_or(0, |d| d.as_secs() + 1),
            "active": sh.active(),
            "max": MAX_SHELLS,
            "idleSeconds": sh.idle.as_secs(),
            "maxSeconds": sh.max.as_secs(),
        }),
    )
}

async fn audit(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_session_id(&state, &headers) {
        return r;
    }
    let db = state.db.clone();
    let Ok(Ok(rows)) = tokio::task::spawn_blocking(move || db.audit_recent(50)).await else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error");
    };
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id, "user": r.user, "ip": r.ip, "startedAt": r.started_at, "endedAt": r.ended_at,
                "bytesIn": r.bytes_in, "bytesOut": r.bytes_out, "endReason": r.end_reason,
            })
        })
        .collect();
    reply(StatusCode::OK, json!({"sessions": rows}))
}

// ---------- the shell WebSocket ----------

/// The Origin of a browser WebSocket must be this very site, or another site could drive the shell with the
/// admin's cookie (the cookie is `SameSite=Strict`, but this does not rely on it).
pub fn origin_matches(state: &AppState, headers: &HeaderMap) -> bool {
    let (Some(origin), Some(host)) = (
        headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()),
        headers.get(header::HOST).and_then(|v| v.to_str().ok()),
    ) else {
        return false;
    };
    let scheme = if over_https(state, headers) { "https" } else { "http" };
    origin.eq_ignore_ascii_case(&format!("{scheme}://{host}"))
}

fn query_num(uri: &Uri, key: &str, default: u32) -> u32 {
    uri.query()
        .into_iter()
        .flat_map(|q| q.split('&'))
        .find_map(|p| p.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
        .and_then(|v| v.parse::<u32>().ok())
        .map_or(default, |n| n.clamp(1, 500))
}

async fn shell_ws(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let (sid, user) = match require_session_id(&state, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !origin_matches(&state, &headers) {
        return fail(StatusCode::FORBIDDEN, "bad-origin");
    }
    if !state.shell.enabled() {
        return fail(StatusCode::FORBIDDEN, "shell-disabled");
    }
    match totp_configured(&state, &user).await {
        Some(true) => {}
        Some(false) => return fail(StatusCode::CONFLICT, "totp-not-set"),
        None => return fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error"),
    }
    if state.admin.elevated_for(&sid).is_none() {
        return fail(StatusCode::FORBIDDEN, "not-elevated");
    }
    let upgrade = match upgrade {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let Some(slot) = state.shell.acquire() else { return fail(StatusCode::TOO_MANY_REQUESTS, "too-many-shells") };
    let Some(ended) = state.admin.watch_session(&sid) else { return fail(StatusCode::UNAUTHORIZED, "unauthorized") };
    let ip = client_ip(state.trust_proxy, &headers, peer.ip());
    let (cols, rows) = (query_num(&uri, "cols", 80), query_num(&uri, "rows", 24));
    upgrade.on_upgrade(move |socket| run_shell(state, socket, slot, sid, user, ip, ended, cols, rows))
}

fn text(v: Value) -> Message {
    Message::Text(v.to_string().into())
}

#[allow(clippy::too_many_arguments)]
async fn run_shell(
    state: AppState,
    mut socket: WebSocket,
    _slot: ShellSlot,
    sid: String,
    user: String,
    ip: IpAddr,
    mut ended: tokio::sync::watch::Receiver<bool>,
    cols: u32,
    rows: u32,
) {
    let db = state.db.clone();
    let (u, ip_text) = (user.clone(), ip.to_string());
    let audit_id = tokio::task::spawn_blocking(move || db.audit_start(&u, &ip_text)).await.ok().and_then(Result::ok);
    tracing::info!(%user, %ip, audit = ?audit_id, "terminal opened");

    let (mut bytes_in, mut bytes_out) = (0u64, 0u64);
    let reason = bridge(&state, &mut socket, &sid, &user, &mut ended, cols, rows, &mut bytes_in, &mut bytes_out).await;

    let _ = socket.send(text(json!({"type": "closed", "reason": reason}))).await;
    let _ = socket.send(Message::Close(Some(CloseFrame { code: 1000, reason: "closed".into() }))).await;
    if let Some(id) = audit_id {
        let db = state.db.clone();
        let r = reason.clone();
        let _ = tokio::task::spawn_blocking(move || db.audit_end(id, bytes_in, bytes_out, &r)).await;
    }
    tracing::info!(%user, %ip, audit = ?audit_id, bytes_in, bytes_out, %reason, "terminal closed");
}

/// Connects to the host and pumps bytes until something ends the session. Returns the reason.
#[allow(clippy::too_many_arguments)]
async fn bridge(
    state: &AppState,
    socket: &mut WebSocket,
    sid: &str,
    _user: &str,
    ended: &mut tokio::sync::watch::Receiver<bool>,
    cols: u32,
    rows: u32,
    bytes_in: &mut u64,
    bytes_out: &mut u64,
) -> String {
    let (Some(cfg), Some(key)) = (state.shell.config.clone(), state.shell.key.clone()) else { return "shell-disabled".into() };
    let mut shell = match SshShell::connect(&cfg, key, &state.db, cols, rows).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "terminal: SSH connection failed");
            let _ = socket.send(text(error_frame(&e))).await;
            return format!("connect-failed:{}", e.code());
        }
    };
    let _ = socket.send(text(json!({"type": "ready"}))).await;

    let started = Instant::now();
    let mut last_activity = Instant::now();
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    let mut stop = state.shutdown.clone();
    let reason = loop {
        tokio::select! {
            msg = socket.recv() => match msg {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break "closed-by-client",
                Some(Ok(Message::Binary(b))) => {
                    *bytes_in += b.len() as u64;
                    last_activity = Instant::now();
                    if shell.write(&b).await.is_err() { break "ssh-error" }
                }
                Some(Ok(Message::Text(t))) => {
                    if let Some((c, r)) = parse_resize(&t) {
                        last_activity = Instant::now();
                        if shell.resize(c, r).await.is_err() { break "ssh-error" }
                    }
                }
                Some(Ok(_)) => {}
            },
            out = shell.read() => match out {
                None => break "closed-by-host",
                Some(data) => {
                    *bytes_out += data.len() as u64;
                    last_activity = Instant::now();
                    if socket.send(Message::Binary(data.into())).await.is_err() { break "closed-by-client" }
                }
            },
            _ = ended.changed() => break "session-ended",
            _ = stop.changed() => break "server-shutdown",
            _ = tick.tick() => {
                if state.admin.session_user(sid).is_none() { break "session-ended" }
                if started.elapsed() >= state.shell.max { break "max-duration" }
                if last_activity.elapsed() >= state.shell.idle { break "idle-timeout" }
            }
        }
    };
    shell.close().await;
    reason.into()
}

fn error_frame(e: &ShellError) -> Value {
    json!({"type": "error", "code": e.code(), "message": e.to_string()})
}

fn parse_resize(text: &str) -> Option<(u32, u32)> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("type")?.as_str()? != "resize" {
        return None;
    }
    let dim = |k: &str| v.get(k).and_then(Value::as_u64).filter(|n| (1..=500).contains(n)).map(|n| n as u32);
    Some((dim("cols")?, dim("rows")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_frames() {
        assert_eq!(parse_resize(r#"{"type":"resize","cols":120,"rows":40}"#), Some((120, 40)));
        for bad in ["", "x", r#"{"type":"data"}"#, r#"{"type":"resize","cols":0,"rows":4}"#, r#"{"type":"resize","cols":501,"rows":4}"#, r#"{"type":"resize","cols":9}"#] {
            assert_eq!(parse_resize(bad), None, "{bad}");
        }
    }

    #[test]
    fn query_numbers_are_clamped_with_defaults() {
        let u: Uri = "/x?cols=120&rows=9999".parse().unwrap();
        assert_eq!((query_num(&u, "cols", 80), query_num(&u, "rows", 24), query_num(&u, "nope", 7)), (120, 500, 7));
        let u: Uri = "/x?cols=abc".parse().unwrap();
        assert_eq!(query_num(&u, "cols", 80), 80);
    }
}
