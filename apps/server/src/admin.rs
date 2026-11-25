//! Admin panel: `GET /admin` (one embedded page) and the JSON API under `/api/admin/*`. Protocol: docs/server-protocol.md.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::auth::{AdminOutcome, AuthOutcome};
use crate::ws::client_ip;
use crate::{AppState, VERSION};

const PAGE: &str = include_str!("../admin/index.html");
const COOKIE: &str = "hub_admin";
const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);
const NONCE_TTL: Duration = Duration::from_secs(120);
const MAX_NONCES: usize = 2000;
const MAX_SESSIONS: usize = 200;
/// How long a correct TOTP code opens the terminal.
pub const ELEVATION: Duration = Duration::from_secs(600);
/// A pending TOTP setup that is not confirmed in this time is forgotten.
const PENDING_TTL: Duration = Duration::from_secs(600);
/// Wrong TOTP codes in one session before it is destroyed.
const MAX_CODE_FAILURES: u32 = 5;
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

struct Session {
    user: String,
    expires: Instant,
    /// The terminal is unlocked until then (a correct TOTP code).
    elevated_until: Option<Instant>,
    code_failures: u32,
    /// Dropped with the session: a shell watching the receiver learns the session is gone.
    ended: watch::Sender<bool>,
}

/// Login nonces, sessions and the last Navidrome check. All in memory: a restart signs everybody out.
#[derive(Default)]
pub struct AdminState {
    nonces: Mutex<HashMap<String, Instant>>,
    sessions: Mutex<HashMap<String, Session>>,
    navidrome: Mutex<Option<(bool, u64)>>,
    /// TOTP secrets made by `totp/setup` and not confirmed yet, by user.
    pending_totp: Mutex<HashMap<String, (Vec<u8>, Instant)>>,
}

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).expect("system randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AdminState {
    /// Records whether the last call to Navidrome got an answer.
    pub fn note_navidrome(&self, reachable: bool) {
        *lock(&self.navidrome) = Some((reachable, unix_now()));
    }

    fn new_nonce(&self) -> Option<String> {
        let mut m = lock(&self.nonces);
        let now = Instant::now();
        m.retain(|_, t| now.duration_since(*t) < NONCE_TTL);
        if m.len() >= MAX_NONCES {
            return None;
        }
        let n = random_hex(16);
        m.insert(n.clone(), now);
        Some(n)
    }

    /// Single use: removes the nonce and says whether it was valid and fresh.
    pub(crate) fn take_nonce(&self, nonce: &str) -> bool {
        lock(&self.nonces).remove(nonce).is_some_and(|t| t.elapsed() < NONCE_TTL)
    }

    fn new_session(&self, user: &str) -> Option<String> {
        let mut m = lock(&self.sessions);
        let now = Instant::now();
        m.retain(|_, s| s.expires > now);
        if m.len() >= MAX_SESSIONS {
            return None;
        }
        let id = random_hex(32);
        let (ended, _) = watch::channel(false);
        m.insert(id.clone(), Session { user: user.to_string(), expires: now + SESSION_TTL, elevated_until: None, code_failures: 0, ended });
        Some(id)
    }

    pub(crate) fn session_user(&self, id: &str) -> Option<String> {
        let mut m = lock(&self.sessions);
        match m.get(id) {
            Some(s) if s.expires > Instant::now() => Some(s.user.clone()),
            Some(_) => {
                m.remove(id);
                None
            }
            None => None,
        }
    }

    fn end_session(&self, id: &str) {
        if let Some(s) = lock(&self.sessions).remove(id) {
            let _ = s.ended.send(true);
        }
    }

    /// A receiver that wakes (`changed()`) when the session ends: sign-out, destruction or expiry cleanup.
    pub(crate) fn watch_session(&self, id: &str) -> Option<watch::Receiver<bool>> {
        lock(&self.sessions).get(id).map(|s| s.ended.subscribe())
    }

    /// Unlocks the terminal for this session for [`ELEVATION`].
    pub(crate) fn elevate(&self, id: &str) {
        if let Some(s) = lock(&self.sessions).get_mut(id) {
            s.elevated_until = Some(Instant::now() + ELEVATION);
            s.code_failures = 0;
        }
    }

    /// Time left of the unlocked window, if any.
    pub(crate) fn elevated_for(&self, id: &str) -> Option<Duration> {
        let now = Instant::now();
        lock(&self.sessions)
            .get(id)
            .and_then(|s| s.elevated_until)
            .and_then(|t| t.checked_duration_since(now))
            .filter(|d| !d.is_zero())
    }

    /// Counts a wrong code. On the last allowed one the session is destroyed and this returns true.
    pub(crate) fn note_code_failure(&self, id: &str) -> bool {
        let mut m = lock(&self.sessions);
        let Some(s) = m.get_mut(id) else { return true };
        s.code_failures += 1;
        if s.code_failures >= MAX_CODE_FAILURES {
            if let Some(s) = m.remove(id) {
                let _ = s.ended.send(true);
            }
            return true;
        }
        false
    }

    pub(crate) fn code_attempts_left(&self, id: &str) -> u32 {
        lock(&self.sessions).get(id).map_or(0, |s| MAX_CODE_FAILURES.saturating_sub(s.code_failures))
    }

    pub(crate) fn set_pending_totp(&self, user: &str, secret: Vec<u8>) {
        let mut m = lock(&self.pending_totp);
        m.retain(|_, (_, t)| t.elapsed() < PENDING_TTL);
        m.insert(user.to_string(), (secret, Instant::now()));
    }

    pub(crate) fn pending_totp(&self, user: &str) -> Option<Vec<u8>> {
        lock(&self.pending_totp).get(user).filter(|(_, t)| t.elapsed() < PENDING_TTL).map(|(s, _)| s.clone())
    }

    pub(crate) fn clear_pending_totp(&self, user: &str) {
        lock(&self.pending_totp).remove(user);
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin", get(page))
        .route("/api/admin/challenge", get(challenge))
        .route("/api/admin/login", post(login))
        .route("/api/admin/logout", post(logout))
        .route("/api/admin/me", get(me))
        .route("/api/admin/hub", get(hub))
        .route("/api/admin/system", get(system))
        .route("/api/admin/disconnect", post(disconnect))
        .route("/admin/vendor/{file}", get(vendor))
        .merge(crate::terminal::routes())
}

/// The terminal's front-end libraries, embedded and served same-origin with a long cache.
const VENDOR: [(&str, &[u8], &str); 3] = [
    ("xterm.js", include_bytes!("../admin/vendor/xterm.js"), "text/javascript; charset=utf-8"),
    ("xterm.css", include_bytes!("../admin/vendor/xterm.css"), "text/css; charset=utf-8"),
    ("addon-fit.js", include_bytes!("../admin/vendor/addon-fit.js"), "text/javascript; charset=utf-8"),
];

async fn vendor(axum::extract::Path(file): axum::extract::Path<String>) -> Response {
    match VENDOR.iter().find(|(n, _, _)| *n == file) {
        Some((_, body, ctype)) => (
            [
                (header::CONTENT_TYPE, *ctype),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            *body,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) fn reply(status: StatusCode, body: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

pub(crate) fn fail(status: StatusCode, code: &str) -> Response {
    reply(status, json!({"error": code}))
}

async fn page() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Html(PAGE),
    )
        .into_response()
}

pub(crate) fn cookie_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|p| p.trim().strip_prefix("hub_admin=").map(str::to_string))
        .filter(|id| !id.is_empty())
}

/// The signed-in admin, or the 401 to send back.
#[allow(clippy::result_large_err)]
pub(crate) fn require_session(state: &AppState, headers: &HeaderMap) -> Result<String, Response> {
    require_session_id(state, headers).map(|(_, user)| user)
}

/// The signed-in admin's session id and user name, or the 401 to send back.
#[allow(clippy::result_large_err)]
pub(crate) fn require_session_id(state: &AppState, headers: &HeaderMap) -> Result<(String, String), Response> {
    cookie_id(headers)
        .and_then(|id| state.admin.session_user(&id).map(|user| (id, user)))
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "unauthorized"))
}

/// A `Set-Cookie` value that clears the session cookie.
pub(crate) fn clear_cookie(state: &AppState, headers: &HeaderMap) -> HeaderValue {
    let secure = if over_https(state, headers) { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}")).expect("ASCII cookie")
}

/// Mutating calls must carry a header a cross-site form cannot set.
#[allow(clippy::result_large_err)]
pub(crate) fn require_csrf(headers: &HeaderMap) -> Result<(), Response> {
    match headers.get("x-requested-with").and_then(|v| v.to_str().ok()) {
        Some("hub-admin") => Ok(()),
        _ => Err(fail(StatusCode::FORBIDDEN, "csrf")),
    }
}

pub(crate) fn over_https(state: &AppState, headers: &HeaderMap) -> bool {
    state.trust_proxy
        && headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').next().is_some_and(|p| p.trim().eq_ignore_ascii_case("https")))
}

async fn challenge(State(state): State<AppState>) -> Response {
    match state.admin.new_nonce() {
        Some(nonce) => reply(StatusCode::OK, json!({"nonce": nonce})),
        None => fail(StatusCode::TOO_MANY_REQUESTS, "too-many-challenges"),
    }
}

pub(crate) fn str_field(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && s.len() <= 256).map(str::to_string)
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let (Some(user), Some(token), Some(nonce)) = (str_field(&body, "user"), str_field(&body, "token"), str_field(&body, "nonce"))
    else {
        return fail(StatusCode::BAD_REQUEST, "bad-request");
    };
    if !state.admin.take_nonce(&nonce) {
        return fail(StatusCode::BAD_REQUEST, "bad-nonce");
    }
    let ip = client_ip(state.trust_proxy, &headers, peer.ip());
    if state.limiter.is_blocked(ip, Instant::now()) {
        return fail(StatusCode::TOO_MANY_REQUESTS, "too-many-attempts");
    }
    match state.auth.check(&user, &token, &nonce).await {
        AuthOutcome::Ok => state.admin.note_navidrome(true),
        AuthOutcome::BadAuth => {
            state.admin.note_navidrome(true);
            state.limiter.record_failure(ip, Instant::now());
            tracing::info!(%ip, %user, "admin sign-in refused");
            return fail(StatusCode::UNAUTHORIZED, "bad-auth");
        }
        AuthOutcome::Unreachable => {
            state.admin.note_navidrome(false);
            return fail(StatusCode::BAD_GATEWAY, "navidrome-unreachable");
        }
    }
    match state.auth.is_admin(&user, &token, &nonce).await {
        AdminOutcome::Admin => {}
        AdminOutcome::NotAdmin => {
            state.limiter.record_success(ip);
            tracing::info!(%ip, %user, "admin sign-in refused: not an admin");
            return fail(StatusCode::FORBIDDEN, "not-admin");
        }
        AdminOutcome::BadAuth => {
            state.limiter.record_failure(ip, Instant::now());
            return fail(StatusCode::UNAUTHORIZED, "bad-auth");
        }
        AdminOutcome::Unreachable => return fail(StatusCode::BAD_GATEWAY, "navidrome-unreachable"),
    }
    state.limiter.record_success(ip);
    let user = user.to_lowercase();
    let Some(id) = state.admin.new_session(&user) else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "too-many-sessions");
    };
    tracing::info!(%ip, %user, "admin signed in");
    let secure = if over_https(&state, &headers) { "; Secure" } else { "" };
    let cookie = format!("{COOKIE}={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{secure}", SESSION_TTL.as_secs());
    let mut resp = reply(StatusCode::OK, json!({"ok": true, "user": user}));
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, v);
    }
    resp
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_csrf(&headers) {
        return r;
    }
    if let Some(id) = cookie_id(&headers) {
        state.admin.end_session(&id);
    }
    let mut resp = reply(StatusCode::OK, json!({"ok": true}));
    resp.headers_mut().insert(header::SET_COOKIE, clear_cookie(&state, &headers));
    resp
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match require_session(&state, &headers) {
        Ok(user) => reply(StatusCode::OK, json!({"user": user})),
        Err(r) => r,
    }
}

async fn system(State(state): State<AppState>, headers: HeaderMap, uri: axum::http::Uri) -> Response {
    // `?processes=1`: every process too (the Processus tab), left out otherwise to keep the answer small.
    let processes = uri.query().is_some_and(|q| q.split('&').any(|kv| kv == "processes=1"));
    match require_session(&state, &headers) {
        Ok(_) => reply(StatusCode::OK, state.monitor.snapshot(processes)),
        Err(r) => r,
    }
}

async fn disconnect(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let admin = match require_session(&state, &headers) {
        Ok(u) => u,
        Err(r) => return r,
    };
    if let Err(r) = require_csrf(&headers) {
        return r;
    }
    let (Some(user), Some(device)) = (str_field(&body, "user"), str_field(&body, "deviceId")) else {
        return fail(StatusCode::BAD_REQUEST, "bad-request");
    };
    if state.hub.kick(&user.to_lowercase(), &device) {
        tracing::info!(%admin, %user, %device, "device kicked");
        reply(StatusCode::OK, json!({"ok": true}))
    } else {
        fail(StatusCode::NOT_FOUND, "not-online")
    }
}

fn state_summary(state: &Option<Value>) -> Value {
    let Some(s) = state else { return Value::Null };
    json!({
        "title": s.pointer("/song/title"),
        "artist": s.pointer("/song/artist"),
        "isPlaying": s.get("isPlaying").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// Online devices, known devices and listening rows of one user.
type UserRows = (Vec<Value>, Vec<Value>, Vec<Value>);

async fn hub(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_session(&state, &headers) {
        return r;
    }
    let db = state.db.clone();
    let Ok(Ok((known, stats))) = tokio::task::spawn_blocking(move || Ok::<_, rusqlite::Error>((db.known_devices()?, db.listening_stats()?))).await
    else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "db-error");
    };
    let mut users: BTreeMap<String, UserRows> = BTreeMap::new();
    for d in state.hub.snapshot() {
        users.entry(d.user).or_default().0.push(json!({
            "deviceId": d.info.device_id, "deviceName": d.info.device_name, "platform": d.info.platform,
            "ip": d.ip.to_string(), "connectedAt": d.connected_at, "state": state_summary(&d.state),
        }));
    }
    for d in known {
        users.entry(d.user).or_default().1.push(json!({
            "deviceId": d.device_id, "deviceName": d.device_name, "platform": d.platform, "lastSeen": d.last_seen,
        }));
    }
    for s in stats {
        users.entry(s.user).or_default().2.push(json!({
            "deviceId": s.device_id, "weeks": s.weeks, "totalSeconds": s.total_seconds, "rev": s.rev,
        }));
    }
    let users: Vec<Value> = users
        .into_iter()
        .map(|(user, (online, known, listening))| json!({"user": user, "online": online, "known": known, "listening": listening}))
        .collect();
    let db_bytes = state.db_path.as_ref().map(|p| {
        let wal = std::path::PathBuf::from(format!("{}-wal", p.display()));
        [p.as_path(), wal.as_path()].iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum::<u64>()
    });
    let nav = *lock(&state.admin.navidrome);
    reply(
        StatusCode::OK,
        json!({
            "server": {"name": &*state.server_name, "version": VERSION, "uptime": state.started.elapsed().as_secs()},
            "navidrome": {"url": &*state.navidrome_url, "ok": nav.map(|n| n.0), "checkedAt": nav.map(|n| n.1)},
            "dbBytes": db_bytes,
            "users": users,
        }),
    )
}
