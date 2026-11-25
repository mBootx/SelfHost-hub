//! Sign-in gate for other web services behind Nginx Proxy Manager (Downtify): any Navidrome account signs in on
//! `GET /gate`, gets a signed cookie for the whole domain, and Nginx asks `GET /api/gate/verify` (`auth_request`)
//! before letting a request through. Off unless GATE_DOMAIN is set. Protocol: docs/server-protocol.md.

use std::net::SocketAddr;
use std::time::Instant;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::AppState;
use crate::admin::{fail, reply, require_csrf, str_field, unix_now};
use crate::auth::AuthOutcome;
use crate::ws::client_ip;

const PAGE: &str = include_str!("../admin/gate.html");
const COOKIE: &str = "hub_gate";
/// A sign-in lasts this long (seconds).
pub const TTL: u64 = 30 * 24 * 3600;
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

pub struct Gate {
    /// Allowed cookie domains; each covers its apex and subdomains (e.g. `goofysound.duckdns.org`).
    domains: Vec<String>,
    key: Vec<u8>,
    /// Services shown on the signed-in page: `(name, url)`.
    services: Vec<(String, String)>,
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub(crate) fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn strip_port(authority: &str) -> &str {
    authority
        .rsplit_once(':')
        .filter(|(_, p)| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        .map_or(authority, |(h, _)| h)
}

fn host_matches(host: &str, domain: &str) -> bool {
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

fn redirect_host(rd: &str) -> Option<String> {
    let rest = rd.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains(['@', '\\']) || rd.chars().any(|c| c.is_control() || c == ' ') {
        return None;
    }
    Some(strip_port(authority).to_ascii_lowercase())
}

impl Gate {
    pub fn new(domain: &str, key: Vec<u8>) -> Self {
        let domains = domain
            .split(',')
            .map(|d| d.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|d| !d.is_empty())
            .collect();
        Self { domains, key, services: Vec::new() }
    }

    /// Sets the `(name, url)` service links returned by `/api/gate/verify`.
    pub fn with_services(mut self, services: Vec<(String, String)>) -> Self {
        self.services = services;
        self
    }

    /// Configured `(name, url)` service links for this gate.
    pub fn services(&self) -> &[(String, String)] {
        &self.services
    }

    pub fn domain_for_host(&self, host_header: Option<&str>) -> &str {
        if let Some(raw) = host_header.map(str::trim).filter(|h| !h.is_empty()) {
            let host = strip_port(raw).to_ascii_lowercase();
            if let Some(d) = self.domains.iter().find(|d| host_matches(&host, d)) {
                return d.as_str();
            }
        }
        self.domains.first().map_or("", String::as_str)
    }

    fn mac(&self, user: &str, expires: u64) -> Hmac<Sha256> {
        let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key).expect("HMAC takes any key length");
        m.update(format!("gate-v1|{user}|{expires}").as_bytes());
        m
    }

    /// The cookie value: user (hex), expiry (unix seconds) and their HMAC.
    pub fn sign(&self, user: &str, expires: u64) -> String {
        format!("{}.{expires}.{}", hex(user.as_bytes()), hex(&self.mac(user, expires).finalize().into_bytes()))
    }

    /// The user a cookie value was signed for, if it is genuine and not expired.
    pub fn verify(&self, value: &str, now: u64) -> Option<String> {
        let mut it = value.split('.');
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

    /// `rd` when it is an https address on `domain` (anything else would make the page an open redirect).
    pub fn safe_redirect_for(&self, rd: &str, domain: &str) -> Option<String> {
        let host = redirect_host(rd)?;
        host_matches(&host, domain).then(|| rd.to_string())
    }

    /// `rd` when it is an https address on any of the gate's domains.
    pub fn safe_redirect(&self, rd: &str) -> Option<String> {
        let host = redirect_host(rd)?;
        self.domains.iter().any(|d| host_matches(&host, d)).then(|| rd.to_string())
    }

    fn cookie(&self, domain: &str, value: &str, max_age: u64) -> Option<HeaderValue> {
        (!domain.is_empty())
            .then(|| {
                HeaderValue::from_str(&format!(
                    "{COOKIE}={value}; Domain={domain}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={max_age}"
                ))
                .ok()
            })
            .flatten()
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/gate", get(page))
        .route("/api/gate/login", post(login))
        .route("/api/gate/logout", post(logout))
        .route("/api/gate/verify", get(verify))
}

pub(crate) fn gate_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|p| p.trim().strip_prefix("hub_gate=").map(str::to_string))
}

async fn page(State(state): State<AppState>) -> Response {
    if state.gate.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
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

/// Nginx's `auth_request`: 200 with the user when the cookie is good, 401 otherwise (Nginx then sends to `/gate`).
async fn verify(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(gate) = &state.gate else { return fail(StatusCode::NOT_FOUND, "gate-off") };
    match gate_cookie(&headers).and_then(|v| gate.verify(&v, unix_now())) {
        Some(user) => {
            let services: Vec<Value> = gate
                .services
                .iter()
                .map(|(name, url)| json!({"name": name, "url": url}))
                .collect();
            let mut resp = reply(StatusCode::OK, json!({"user": user, "services": services}));
            if let Ok(v) = HeaderValue::from_str(&user) {
                resp.headers_mut().insert("x-hub-user", v);
            }
            resp
        }
        None => fail(StatusCode::UNAUTHORIZED, "unauthorized"),
    }
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(gate) = state.gate.clone() else { return fail(StatusCode::NOT_FOUND, "gate-off") };
    if let Err(r) = require_csrf(&headers) {
        return r;
    }
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
            tracing::info!(%ip, %user, "gate sign-in refused");
            return fail(StatusCode::UNAUTHORIZED, "bad-auth");
        }
        AuthOutcome::Unreachable => {
            state.admin.note_navidrome(false);
            return fail(StatusCode::BAD_GATEWAY, "navidrome-unreachable");
        }
    }
    state.limiter.record_success(ip);
    let user = user.to_lowercase();
    tracing::info!(%ip, %user, "gate signed in");
    let domain = gate.domain_for_host(headers.get(header::HOST).and_then(|v| v.to_str().ok()));
    let redirect = body.get("rd").and_then(Value::as_str).and_then(|rd| gate.safe_redirect_for(rd, domain));
    let mut resp = reply(StatusCode::OK, json!({"ok": true, "user": user, "redirect": redirect}));
    if let Some(c) = gate.cookie(domain, &gate.sign(&user, unix_now() + TTL), TTL) {
        resp.headers_mut().insert(header::SET_COOKIE, c);
    }
    resp
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(gate) = &state.gate else { return fail(StatusCode::NOT_FOUND, "gate-off") };
    if let Err(r) = require_csrf(&headers) {
        return r;
    }
    let domain = gate.domain_for_host(headers.get(header::HOST).and_then(|v| v.to_str().ok()));
    let mut resp = reply(StatusCode::OK, json!({"ok": true}));
    if let Some(c) = gate.cookie(domain, "", 0) {
        resp.headers_mut().insert(header::SET_COOKIE, c);
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> Gate {
        Gate::new(".GoofySound.duckdns.org", b"0123456789abcdef0123456789abcdef".to_vec())
    }

    fn multi_gate() -> Gate {
        Gate::new("goofysound.duckdns.org,goofydownloader.duckdns.org", b"0123456789abcdef0123456789abcdef".to_vec())
    }

    #[test]
    fn cookie_round_trip() {
        let g = gate();
        let v = g.sign("max.b", 2000);
        assert_eq!(g.verify(&v, 1999).as_deref(), Some("max.b"));
        assert_eq!(g.verify(&v, 2000), None, "expired");
        let other = Gate::new("goofysound.duckdns.org", b"another key".to_vec());
        assert_eq!(other.verify(&v, 1000), None, "another key");
        let (u, rest) = v.split_once('.').unwrap();
        assert_eq!(g.verify(&format!("{}.{rest}", hex(b"admin")), 1000), None, "another user");
        assert_eq!(g.verify(&format!("{u}.{}", rest.replacen("2000", "9999", 1)), 1000), None, "a later expiry");
        for bad in ["", "x", "a.b.c", "61.2000", "61.2000.zz", &format!("{v}.x")] {
            assert_eq!(g.verify(bad, 1000), None, "{bad}");
        }
    }

    #[test]
    fn redirects_only_on_the_domain() {
        let g = gate();
        for ok in [
            "https://downtify.goofysound.duckdns.org/",
            "https://goofysound.duckdns.org",
            "https://downtify.goofysound.duckdns.org:443/a?b=c&d=e",
            "https://DOWNTIFY.goofysound.duckdns.org/x",
        ] {
            assert_eq!(g.safe_redirect(ok).as_deref(), Some(ok), "{ok}");
        }
        for bad in [
            "http://downtify.goofysound.duckdns.org/",
            "https://evil.com/?x=goofysound.duckdns.org",
            "https://goofysound.duckdns.org.evil.com/",
            "https://evilgoofysound.duckdns.org/",
            "https://user@evil.com@goofysound.duckdns.org/",
            "https://x.goofysound.duckdns.org\\@evil.com/",
            "//goofysound.duckdns.org/",
            "javascript:alert(1)",
            "https:///x",
        ] {
            assert_eq!(g.safe_redirect(bad), None, "{bad}");
        }
    }

    #[test]
    fn cookie_header() {
        let g = gate();
        let c = g.cookie(g.domain_for_host(None), "abc", 60).unwrap();
        assert_eq!(c.to_str().unwrap(), "hub_gate=abc; Domain=goofysound.duckdns.org; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60");
    }

    #[test]
    fn multi_domain_host_and_redirects() {
        let g = multi_gate();
        assert_eq!(g.domain_for_host(Some("hub.goofysound.duckdns.org")), "goofysound.duckdns.org");
        assert_eq!(g.domain_for_host(Some("goofydownloader.duckdns.org:443")), "goofydownloader.duckdns.org");
        assert_eq!(g.domain_for_host(Some("GOOFYDOWNLOADER.duckdns.org")), "goofydownloader.duckdns.org");
        assert_eq!(g.domain_for_host(Some("unknown.example.com")), "goofysound.duckdns.org");
        assert_eq!(g.domain_for_host(None), "goofysound.duckdns.org");

        let d1 = g.domain_for_host(Some("hub.goofysound.duckdns.org"));
        let d2 = g.domain_for_host(Some("goofydownloader.duckdns.org"));
        assert_eq!(
            g.cookie(d1, "abc", 60).unwrap().to_str().unwrap(),
            "hub_gate=abc; Domain=goofysound.duckdns.org; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60"
        );
        assert_eq!(
            g.cookie(d2, "abc", 60).unwrap().to_str().unwrap(),
            "hub_gate=abc; Domain=goofydownloader.duckdns.org; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60"
        );

        assert_eq!(
            g.safe_redirect_for("https://goofydownloader.duckdns.org/dl?q=1", d2).as_deref(),
            Some("https://goofydownloader.duckdns.org/dl?q=1")
        );
        assert_eq!(g.safe_redirect_for("https://hub.goofysound.duckdns.org/", d2), None);
        assert_eq!(g.safe_redirect_for("https://goofydownloader.duckdns.org/", d1), None);
        assert_eq!(
            g.safe_redirect_for("https://downtify.goofysound.duckdns.org/", d1).as_deref(),
            Some("https://downtify.goofysound.duckdns.org/")
        );
    }

    struct DummyAuth;
    impl crate::auth::Authenticator for DummyAuth {
        fn check<'a>(&'a self, _u: &'a str, _t: &'a str, _s: &'a str) -> crate::auth::BoxFuture<'a, AuthOutcome> {
            Box::pin(async { AuthOutcome::BadAuth })
        }
    }

    #[tokio::test]
    async fn with_services_populates_verify_response() {
        let g = gate().with_services(vec![
            ("Downtify".into(), "https://downtify.goofysound.duckdns.org".into()),
            ("Navidrome".into(), "https://music.goofysound.duckdns.org".into()),
        ]);
        assert_eq!(
            g.services(),
            &[
                ("Downtify".to_string(), "https://downtify.goofysound.duckdns.org".to_string()),
                ("Navidrome".to_string(), "https://music.goofysound.duckdns.org".to_string()),
            ]
        );
        let tok = g.sign("max.b", unix_now() + 60);
        let (_stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let state = AppState::new(
            "Test",
            false,
            crate::db::Db::open_in_memory().unwrap(),
            std::sync::Arc::new(DummyAuth),
            stop_rx,
        )
        .with_gate(g);

        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(&format!("hub_gate={tok}")).unwrap());
        let resp = verify(State(state), headers).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-hub-user"], "max.b");
        let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            v,
            json!({
                "user": "max.b",
                "services": [
                    {"name": "Downtify", "url": "https://downtify.goofysound.duckdns.org"},
                    {"name": "Navidrome", "url": "https://music.goofysound.duckdns.org"},
                ]
            })
        );
    }
}
