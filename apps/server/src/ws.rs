//! One WebSocket connection: sign-in, then message dispatch and keep-alive.

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use axum::extract::ConnectInfo;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{Value, json};
use tokio::sync::mpsc::unbounded_channel;

use crate::auth::AuthOutcome;
use crate::hub::Outgoing;
use crate::protocol::{DeviceInfo, error_json, parse_hello, plan_push};
use crate::{AppState, VERSION};

const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_RESUME_BYTES: usize = 512 * 1024;
const AUTO_RESUME_EVERY: Duration = Duration::from_secs(30);
const RESUME_STATE_KEYS: [&str; 8] = ["song", "upNext", "isPlaying", "currentTime", "duration", "shuffle", "repeatMode", "volume"];
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(30);
const DEAD_AFTER: Duration = Duration::from_secs(75);

#[derive(Default)]
struct AutoResume {
    last_song_id: Option<String>,
    last_at: Option<Instant>,
}

pub async fn upgrade(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let ip = client_ip(state.trust_proxy, &headers, peer.ip());
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| connection(socket, state, ip))
}

/// The peer address, or with `trust_proxy` the first address of `X-Forwarded-For`.
pub fn client_ip(trust_proxy: bool, headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    if trust_proxy
        && let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse().ok())
    {
        return ip;
    }
    peer
}

fn text(s: String) -> Message {
    Message::Text(s.into())
}

fn nonce() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("system randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

async fn refuse(socket: &mut WebSocket, reason: &str) {
    let _ = socket.send(text(json!({"type": "welcome", "accepted": false, "reason": reason}).to_string())).await;
    let _ = socket.send(Message::Close(None)).await;
}

/// Waits for the first text frame that is a `hello` (other frames are skipped).
async fn read_hello(socket: &mut WebSocket) -> Option<Result<Value, ()>> {
    loop {
        match socket.recv().await? {
            Ok(Message::Text(t)) => {
                return Some(match serde_json::from_str::<Value>(t.as_str()) {
                    Ok(v) if v.get("type").and_then(Value::as_str) == Some("hello") => Ok(v),
                    Ok(_) => continue,
                    Err(_) => Err(()),
                });
            }
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

async fn connection(mut socket: WebSocket, state: AppState, ip: IpAddr) {
    let salt = nonce();
    let challenge = json!({
        "type": "challenge", "v": 2, "nonce": salt,
        "serverName": &*state.server_name, "serverVersion": VERSION,
    });
    if socket.send(text(challenge.to_string())).await.is_err() {
        return;
    }
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, read_hello(&mut socket)).await {
        Ok(Some(Ok(v))) => v,
        Ok(Some(Err(()))) => return refuse(&mut socket, "bad-hello").await,
        Ok(None) | Err(_) => return,
    };
    let hello = match parse_hello(&hello) {
        Ok(h) => h,
        Err(e) => return refuse(&mut socket, e.reason()).await,
    };
    if state.limiter.is_blocked(ip, Instant::now()) {
        return refuse(&mut socket, "too-many-attempts").await;
    }
    match state.auth.check(&hello.user, &hello.token, &salt).await {
        AuthOutcome::Ok => {
            state.admin.note_navidrome(true);
            state.limiter.record_success(ip)
        }
        AuthOutcome::BadAuth => {
            state.admin.note_navidrome(true);
            state.limiter.record_failure(ip, Instant::now());
            tracing::info!(%ip, user = %hello.user, "sign-in refused");
            return refuse(&mut socket, "bad-auth").await;
        }
        AuthOutcome::Unreachable => {
            state.admin.note_navidrome(false);
            return refuse(&mut socket, "navidrome-unreachable").await;
        }
    }

    let user = hello.user.to_lowercase();
    let device = hello.device;
    let mut features = vec!["remote", "listening", "resume"];
    if state.downtify.is_some() {
        features.push("downtify");
    }
    let api_token = state.client_token.sign(&user, crate::admin::unix_now() + crate::downtify::TOKEN_TTL);
    let welcome = json!({
        "type": "welcome", "accepted": true, "user": user, "deviceId": device.device_id,
        "serverVersion": VERSION, "features": features, "apiToken": api_token,
    });
    if socket.send(text(welcome.to_string())).await.is_err() {
        return;
    }
    {
        let db = state.db.clone();
        let (u, d) = (user.clone(), device.clone());
        if let Ok(Err(e)) = tokio::task::spawn_blocking(move || db.touch_device(&u, &d)).await {
            tracing::warn!("touch_device: {e}");
        }
    }
    tracing::info!(%ip, %user, device = %device.device_id, platform = %device.platform, "device online");

    let (tx, mut rx) = unbounded_channel();
    let conn_id = state.hub.join(&user, device.clone(), tx, ip);
    let resume_ok = {
        let db = state.db.clone();
        let u = user.clone();
        match tokio::task::spawn_blocking(move || db.get_resume(&u)).await {
            Ok(Ok(Some(r))) => socket.send(text(resume_state_json(Some(&r)))).await.is_ok(),
            Ok(Ok(None)) => true,
            other => {
                tracing::warn!("get_resume on connect: {other:?}");
                true
            }
        }
    };
    if resume_ok {
        run(&mut socket, &state, &user, &device, &mut rx).await;
    }
    state.hub.leave(&user, &device.device_id, conn_id);
    tracing::info!(%user, device = %device.device_id, "device offline");
}

async fn run(
    socket: &mut WebSocket,
    state: &AppState,
    user: &str,
    device: &DeviceInfo,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<Outgoing>,
) {
    let mut shutdown = state.shutdown.clone();
    let mut last_seen = Instant::now();
    let mut last_ping = Instant::now();
    let mut auto_resume = AutoResume::default();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { return };
                last_seen = Instant::now();
                match msg {
                    Message::Text(t) => {
                        for reply in dispatch(state, user, device, &mut auto_resume, t.as_str()).await {
                            if socket.send(text(reply)).await.is_err() {
                                return;
                            }
                        }
                    }
                    Message::Close(_) => return,
                    _ => {}
                }
            }
            out = rx.recv() => match out {
                Some(Outgoing::Text(s)) => {
                    if socket.send(text(s)).await.is_err() {
                        return;
                    }
                }
                Some(Outgoing::Close(code, reason)) => {
                    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
                    return;
                }
                None => return,
            },
            _ = tick.tick() => {
                if last_seen.elapsed() > DEAD_AFTER {
                    tracing::info!(%user, device = %device.device_id, "no pong, dropping");
                    return;
                }
                if last_ping.elapsed() >= PING_EVERY {
                    last_ping = Instant::now();
                    if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                        return;
                    }
                }
            }
            _ = shutdown.changed() => {
                let _ = socket.send(Message::Close(Some(CloseFrame { code: 1001, reason: "shutdown".into() }))).await;
                return;
            }
        }
    }
}

/// Handles one text frame; returns the frames to send back to the sender.
async fn dispatch(
    state: &AppState,
    user: &str,
    device: &DeviceInfo,
    auto_resume: &mut AutoResume,
    raw: &str,
) -> Vec<String> {
    let Ok(msg) = serde_json::from_str::<Value>(raw) else {
        return vec![error_json("bad-message", "not JSON")];
    };
    let Some(kind) = msg.get("type").and_then(Value::as_str) else {
        return vec![error_json("bad-message", "missing type")];
    };
    match kind {
        "state" => {
            state.hub.relay_state(user, &device.device_id, msg.clone());
            maybe_auto_save_resume(state, user, device, auto_resume, &msg);
            vec![]
        }
        "command" => match state.hub.relay_command(user, &device.device_id, &msg) {
            Ok(()) => vec![],
            Err(m) => vec![error_json("bad-command", &m)],
        },
        "sessions.refresh" => state.hub.session_frames(user, &device.device_id),
        "listening.push" => listening_push(state, user, device, &msg).await,
        "listening.pull" => listening_pull(state, user, device, &msg).await,
        "resume.save" => resume_save(state, user, device, &msg).await,
        "resume.get" => resume_get(state, user).await,
        _ => vec![],
    }
}

fn resume_state_json(row: Option<&crate::db::ResumeRow>) -> String {
    match row {
        Some(r) => json!({
            "type": "resume.state",
            "deviceId": r.device_id,
            "deviceName": r.device_name,
            "platform": r.platform,
            "updatedAt": r.updated_at,
            "state": r.state,
        })
        .to_string(),
        None => json!({"type": "resume.state", "state": Value::Null}).to_string(),
    }
}

fn maybe_auto_save_resume(
    state: &AppState,
    user: &str,
    device: &DeviceInfo,
    auto: &mut AutoResume,
    msg: &Value,
) {
    let Some(song) = msg.get("song").filter(|v| v.is_object()) else {
        return;
    };
    let song_id = song.get("id").and_then(Value::as_str).map(str::to_string);
    let song_changed = song_id != auto.last_song_id;
    let paused = msg.get("isPlaying").and_then(Value::as_bool) == Some(false);
    let due = auto.last_at.is_none_or(|t| t.elapsed() >= AUTO_RESUME_EVERY);
    if !(song_changed || paused || due) {
        return;
    }
    auto.last_song_id = song_id;
    auto.last_at = Some(Instant::now());

    let mut clean = serde_json::Map::new();
    if let Some(obj) = msg.as_object() {
        for key in RESUME_STATE_KEYS {
            if let Some(v) = obj.get(key) {
                clean.insert(key.into(), v.clone());
            }
        }
    }
    let text = Value::Object(clean).to_string();
    if text.len() > MAX_RESUME_BYTES {
        return;
    }
    let (db, u, d) = (state.db.clone(), user.to_string(), device.clone());
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || db.save_resume(&u, &d, &text)).await;
    });
}

async fn resume_save(state: &AppState, user: &str, device: &DeviceInfo, msg: &Value) -> Vec<String> {
    let Some(state_val) = msg.get("state").filter(|v| v.is_object()) else {
        return vec![error_json("bad-message", "state must be an object")];
    };
    let text = state_val.to_string();
    if text.len() > MAX_RESUME_BYTES {
        return vec![error_json("too-large", "resume state is over 512 KiB")];
    }
    let (db, u, d) = (state.db.clone(), user.to_string(), device.clone());
    match tokio::task::spawn_blocking(move || db.save_resume(&u, &d, &text)).await {
        Ok(Ok(ts)) => {
            let broadcast = json!({
                "type": "resume.state",
                "deviceId": device.device_id,
                "deviceName": device.device_name,
                "platform": device.platform,
                "updatedAt": ts,
                "state": state_val,
            })
            .to_string();
            state.hub.notify_others(user, &device.device_id, &broadcast);
            vec![json!({"type": "resume.ack", "updatedAt": ts}).to_string()]
        }
        other => {
            tracing::error!("resume.save failed: {other:?}");
            vec![error_json("bad-message", "server error")]
        }
    }
}

async fn resume_get(state: &AppState, user: &str) -> Vec<String> {
    let (db, u) = (state.db.clone(), user.to_string());
    match tokio::task::spawn_blocking(move || db.get_resume(&u)).await {
        Ok(Ok(row)) => vec![resume_state_json(row.as_ref())],
        other => {
            tracing::error!("resume.get failed: {other:?}");
            vec![error_json("bad-message", "server error")]
        }
    }
}

async fn listening_push(state: &AppState, user: &str, device: &DeviceInfo, msg: &Value) -> Vec<String> {
    let plan = plan_push(msg.get("weeks"));
    let mut replies: Vec<String> = plan.errors.iter().map(|(c, m)| error_json(c, m)).collect();
    let weeks: Vec<String> = plan.accepted.iter().map(|(w, _)| w.clone()).collect();
    let (db, u, d, rows) = (state.db.clone(), user.to_string(), device.clone(), plan.accepted);
    let wrote = !rows.is_empty();
    match tokio::task::spawn_blocking(move || db.upsert_weeks(&u, &d, &rows)).await {
        Ok(Ok(rev)) => {
            replies.push(json!({"type": "listening.ack", "weeks": weeks, "rev": rev}).to_string());
            if wrote {
                let changed = json!({"type": "listening.changed", "rev": rev}).to_string();
                state.hub.notify_others(user, &device.device_id, &changed);
            }
        }
        other => {
            tracing::error!("listening.push failed: {other:?}");
            replies.push(error_json("bad-message", "server error"));
        }
    }
    replies
}

async fn listening_pull(state: &AppState, user: &str, device: &DeviceInfo, msg: &Value) -> Vec<String> {
    let since = msg.get("since").and_then(Value::as_i64).unwrap_or(0).max(0);
    let (db, u, d) = (state.db.clone(), user.to_string(), device.device_id.clone());
    match tokio::task::spawn_blocking(move || db.pull(&u, &d, since)).await {
        Ok(Ok(page)) => {
            let entries: Vec<Value> = page
                .entries
                .into_iter()
                .map(|e| {
                    json!({
                        "deviceId": e.device_id, "deviceName": e.device_name, "platform": e.platform,
                        "week": e.week, "log": e.log, "rev": e.rev,
                    })
                })
                .collect();
            vec![json!({"type": "listening.data", "rev": page.rev, "entries": entries, "more": page.more}).to_string()]
        }
        other => {
            tracing::error!("listening.pull failed: {other:?}");
            vec![error_json("bad-message", "server error")]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_for_only_when_trusted() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        let peer: IpAddr = "172.18.0.2".parse().unwrap();
        assert_eq!(client_ip(false, &h, peer), peer);
        assert_eq!(client_ip(true, &h, peer), "203.0.113.9".parse::<IpAddr>().unwrap());
        h.insert("x-forwarded-for", "garbage".parse().unwrap());
        assert_eq!(client_ip(true, &h, peer), peer);
    }
}
