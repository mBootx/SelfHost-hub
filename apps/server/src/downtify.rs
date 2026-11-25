//! Client API tokens and authenticated HTTP reverse proxy to Downtify.

use std::borrow::Borrow;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header, request::Parts};
use axum::response::Response;
use axum::routing::{any, post};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::AppState;
use crate::admin::{fail, reply, str_field, unix_now};
use crate::auth::AuthOutcome;
use crate::gate::{Gate, gate_cookie, hex, unhex};
use crate::ws::client_ip;

/// Lifetime of a mobile/desktop Downtify client token (seconds).
pub const TOKEN_TTL: u64 = 24 * 3600;
const MAX_PROXY_BODY: usize = 1024 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(180);

/// HMAC-SHA256 bearer token signer/verifier for native clients.
#[derive(Clone)]
pub struct ClientToken {
    key: Vec<u8>,
}

impl ClientToken {
    /// Creates a token signer/verifier backed by `key`.
    pub fn new(key: Vec<u8>) -> Self {
        Self { key }
    }

    fn mac(&self, user: &str, expires: u64) -> Hmac<Sha256> {
        let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key).expect("HMAC takes any key length");
        m.update(format!("client-v1|{user}|{expires}").as_bytes());
        m
    }

    /// Signs a client token (`<user_hex>.<expires>.<hmac_hex>`) valid until `expires` (unix seconds).
    pub fn sign(&self, user: &str, expires: u64) -> String {
        format!(
            "{}.{expires}.{}",
            hex(user.as_bytes()),
            hex(&self.mac(user, expires).finalize().into_bytes())
        )
    }

    /// Returns the authenticated user when `token` is genuine and not expired at `now`.
    pub fn verify(&self, token: &str, now: u64) -> Option<String> {
        let mut it = token.split('.');
        let (user, expires, tag) = (it.next()?, it.next()?, it.next()?);
        if it.next().is_some() {
            return None;
        }
        let user = String::from_utf8(unhex(user)?).ok()?;
        let expires: u64 = expires.parse().ok()?;
        if expires <= now || user.is_empty() {
            return None;
        }
        self.mac(&user, expires).verify_slice(&unhex(tag)?).ok()?;
        Some(user)
    }
}

/// Upstream HTTP client targeting the local Downtify service.
#[derive(Clone)]
pub struct DowntifyProxy {
    base_url: String,
    client: reqwest::Client,
}

impl DowntifyProxy {
    /// Builds a proxy targeting `base_url` with redirects disabled and a 180 s timeout.
    pub fn new(base_url: &str) -> Result<Self, String> {
        let base_url = base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err("downtify base URL is empty".into());
        }
        let client = reqwest::Client::builder()
            .timeout(UPSTREAM_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { base_url, client })
    }
}

/// Returns whether `method` and `path` are permitted by the Downtify proxy allowlist.
pub fn is_allowed(method: &Method, path: &str) -> bool {
    let path = path.trim_start_matches('/');
    if path.is_empty()
        || path.contains("..")
        || path.chars().any(|c| matches!(c, '\\' | '?' | '#' | '@') || c.is_control())
        || path.split('/').any(|seg| seg == "." || seg == "..")
    {
        return false;
    }
    match *method {
        Method::GET => {
            matches!(path, "api/version" | "api/queue" | "api/songs/search" | "list" | "cover")
                || path.strip_prefix("downloads/").is_some_and(|rest| !rest.is_empty())
        }
        Method::POST => path == "api/download/url",
        Method::DELETE => matches!(path, "api/queue" | "api/queue/item" | "delete"),
        _ => false,
    }
}

/// Routes for client token issuance and the Downtify proxy.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/client/token", post(issue_token))
        .route("/api/downtify/{*path}", any(proxy))
}

async fn issue_token(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let (Some(user), Some(token), Some(nonce)) =
        (str_field(&body, "user"), str_field(&body, "token"), str_field(&body, "nonce"))
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
            tracing::info!(%ip, %user, "client token refused");
            return fail(StatusCode::UNAUTHORIZED, "bad-auth");
        }
        AuthOutcome::Unreachable => {
            state.admin.note_navidrome(false);
            return fail(StatusCode::BAD_GATEWAY, "navidrome-unreachable");
        }
    }
    state.limiter.record_success(ip);
    let user_lower = user.to_lowercase();
    tracing::info!(%ip, user = %user_lower, "client token issued");
    let signer: &ClientToken = state.client_token.borrow();
    let api_token = signer.sign(&user_lower, unix_now() + TOKEN_TTL);
    reply(
        StatusCode::OK,
        json!({
            "ok": true,
            "user": user_lower,
            "apiToken": api_token,
            "expiresIn": TOKEN_TTL,
        }),
    )
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = raw.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

async fn proxy(State(state): State<AppState>, Path(path): Path<String>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    handle_proxy(
        state.client_token.borrow(),
        state.gate.as_deref(),
        state.downtify.as_ref().map(Borrow::borrow),
        &path,
        &parts,
        body,
    )
    .await
}

async fn handle_proxy(
    client_token: &ClientToken,
    gate: Option<&Gate>,
    downtify: Option<&DowntifyProxy>,
    path: &str,
    parts: &Parts,
    body: Body,
) -> Response {
    let now = unix_now();
    let authed = bearer_token(&parts.headers).and_then(|t| client_token.verify(t, now)).is_some()
        || gate
            .and_then(|g| gate_cookie(&parts.headers).and_then(|c| g.verify(&c, now)))
            .is_some();
    if !authed {
        return fail(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(proxy) = downtify else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "downtify-not-configured");
    };
    if !is_allowed(&parts.method, path) {
        return fail(StatusCode::FORBIDDEN, "path-not-allowed");
    }
    let Ok(bytes) = to_bytes(body, MAX_PROXY_BODY).await else {
        return fail(StatusCode::PAYLOAD_TOO_LARGE, "body-too-large");
    };
    let clean = path.trim_start_matches('/');
    let mut url = format!("{}/{clean}", proxy.base_url);
    if let Some(q) = parts.uri.query().filter(|q| !q.is_empty()) {
        url.push('?');
        url.push_str(q);
    }
    let Ok(rmethod) = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()) else {
        return fail(StatusCode::BAD_REQUEST, "bad-method");
    };
    let mut builder = proxy.client.request(rmethod, url.as_str());
    if let Some(ct) = parts.headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        builder = builder.header("content-type", ct);
    }
    if !bytes.is_empty() {
        builder = builder.body(bytes);
    }
    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e.without_url(), "downtify upstream request failed");
            return fail(StatusCode::BAD_GATEWAY, "downtify-unreachable");
        }
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let ctype = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| HeaderValue::from_str(s).ok());
    let Ok(resp_bytes) = upstream.bytes().await else {
        return fail(StatusCode::BAD_GATEWAY, "downtify-unreachable");
    };
    let mut resp = Response::new(Body::from(resp_bytes));
    *resp.status_mut() = status;
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(ct) = ctype {
        resp.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    resp
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::extract::Query;
    use axum::routing::get;
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn client_token_round_trip_tamper_and_expiry() {
        let ct = ClientToken::new(b"0123456789abcdef0123456789abcdef".to_vec());
        let tok = ct.sign("alice", 2000);
        assert_eq!(ct.verify(&tok, 1999).as_deref(), Some("alice"));
        assert_eq!(ct.verify(&tok, 2000), None, "expired at boundary");
        assert_eq!(ct.verify(&tok, 2001), None, "expired");

        let other = ClientToken::new(b"different-secret-key-0123456789ab".to_vec());
        assert_eq!(other.verify(&tok, 1000), None, "wrong key");

        let (u, rest) = tok.split_once('.').unwrap();
        assert_eq!(ct.verify(&format!("{}.{rest}", hex(b"admin")), 1000), None, "tampered user");
        assert_eq!(
            ct.verify(&format!("{u}.{}", rest.replacen("2000", "9999", 1)), 1000),
            None,
            "tampered expiry"
        );
        for bad in ["", "x", "a.b.c", "61.2000", "61.2000.zz", &format!("{tok}.extra")] {
            assert_eq!(ct.verify(bad, 1000), None, "{bad}");
        }
    }

    #[test]
    fn allowlist_and_path_traversal() {
        for (method, path) in [
            (Method::GET, "api/version"),
            (Method::GET, "/api/version"),
            (Method::GET, "api/queue"),
            (Method::GET, "api/songs/search"),
            (Method::GET, "list"),
            (Method::GET, "cover"),
            (Method::GET, "downloads/artist/track.mp3"),
            (Method::GET, "downloads/my%20song.flac"),
            (Method::POST, "api/download/url"),
            (Method::DELETE, "api/queue"),
            (Method::DELETE, "api/queue/item"),
            (Method::DELETE, "delete"),
        ] {
            assert!(is_allowed(&method, path), "{method} {path} should be allowed");
        }

        for (method, path) in [
            (Method::GET, ""),
            (Method::GET, "/"),
            (Method::GET, "downloads/"),
            (Method::GET, "downloads/."),
            (Method::GET, "downloads/.."),
            (Method::GET, "downloads/../secret"),
            (Method::GET, "downloads/a/./b"),
            (Method::GET, "downloads/a\\b"),
            (Method::GET, "downloads/a?b=c"),
            (Method::GET, "downloads/a#frag"),
            (Method::GET, "downloads/user@host"),
            (Method::GET, "downloads/bad\nline"),
            (Method::GET, "admin"),
            (Method::POST, "api/queue"),
            (Method::POST, "api/version"),
            (Method::DELETE, "downloads/song.mp3"),
            (Method::PUT, "api/version"),
        ] {
            assert!(!is_allowed(&method, path), "{method} {path} should be rejected");
        }
    }

    #[tokio::test]
    async fn proxy_auth_forwarding_and_allowlist() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let upstream = Router::new()
            .route(
                "/api/songs/search",
                get(|Query(q): Query<std::collections::HashMap<String, String>>| async move {
                    Json(json!({"q": q.get("q").cloned().unwrap_or_default()}))
                }),
            )
            .route(
                "/api/download/url",
                post(|headers: HeaderMap, body: String| async move {
                    let ct = headers
                        .get(header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    (StatusCode::CREATED, Json(json!({"ct": ct, "body": body})))
                }),
            );
        let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(up_listener, upstream).await.unwrap();
        });

        #[derive(Clone)]
        struct ProxyState {
            token: Arc<ClientToken>,
            proxy: Arc<DowntifyProxy>,
        }
        let state = ProxyState {
            token: Arc::new(ClientToken::new(b"test-client-token-secret-key-123".to_vec())),
            proxy: Arc::new(DowntifyProxy::new(&format!("http://{up_addr}/")).unwrap()),
        };
        let app = Router::new()
            .route(
                "/api/downtify/{*path}",
                any(
                    |State(s): State<ProxyState>, Path(path): Path<String>, req: Request| async move {
                        let (parts, body) = req.into_parts();
                        handle_proxy(&s.token, None, Some(&s.proxy), &path, &parts, body).await
                    },
                ),
            )
            .with_state(state.clone());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let url = |p: &str| format!("http://{addr}{p}");
        let valid = state.token.sign("alice", unix_now() + 300);

        // Missing or invalid bearer token -> 401.
        assert_eq!(client.get(url("/api/downtify/api/songs/search")).send().await.unwrap().status(), 401);
        assert_eq!(
            client
                .get(url("/api/downtify/api/songs/search"))
                .bearer_auth("bogus")
                .send()
                .await
                .unwrap()
                .status(),
            401
        );

        // Disallowed path -> 403.
        assert_eq!(
            client
                .get(url("/api/downtify/secret/admin"))
                .bearer_auth(&valid)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );

        // Query string forwarding on GET.
        let r = client
            .get(url("/api/downtify/api/songs/search?q=daft+punk"))
            .bearer_auth(&valid)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
        let v: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
        assert_eq!(v, json!({"q": "daft punk"}));

        // Content-Type and body forwarding on POST.
        let r = client
            .post(url("/api/downtify/api/download/url"))
            .bearer_auth(&valid)
            .header("content-type", "application/json")
            .body(r#"{"url":"https://example.com/track"}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 201);
        let v: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
        assert_eq!(v["ct"], "application/json");
        assert_eq!(v["body"], r#"{"url":"https://example.com/track"}"#);
    }
}
