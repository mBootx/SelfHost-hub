use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use selfhost_hub_server::auth::{AdminOutcome, AuthOutcome, Authenticator, BoxFuture};
use selfhost_hub_server::db::Db;
use selfhost_hub_server::{AppState, router};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

/// Token "good" is valid for any user; only "root" is an admin; "unreach" cannot reach Navidrome.
struct FakeAuth;

impl Authenticator for FakeAuth {
    fn check<'a>(&'a self, user: &'a str, token: &'a str, _salt: &'a str) -> BoxFuture<'a, AuthOutcome> {
        Box::pin(async move {
            if user == "unreach" {
                AuthOutcome::Unreachable
            } else if token == "good" {
                AuthOutcome::Ok
            } else {
                AuthOutcome::BadAuth
            }
        })
    }

    fn is_admin<'a>(&'a self, user: &'a str, _token: &'a str, _salt: &'a str) -> BoxFuture<'a, AdminOutcome> {
        Box::pin(async move { if user == "root" { AdminOutcome::Admin } else { AdminOutcome::NotAdmin } })
    }
}

struct Srv {
    addr: SocketAddr,
    http: reqwest::Client,
    _stop: watch::Sender<bool>,
}

async fn start(trust_proxy: bool) -> Srv {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (stop_tx, stop_rx) = watch::channel(false);
    let state = AppState::new("Maison", trust_proxy, Db::open_in_memory().unwrap(), Arc::new(FakeAuth), stop_rx);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    Srv { addr, http: reqwest::Client::new(), _stop: stop_tx }
}

impl Srv {
    fn url(&self, p: &str) -> String {
        format!("http://{}{p}", self.addr)
    }

    async fn nonce(&self) -> String {
        let r = self.http.get(self.url("/api/admin/challenge")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json_text().await;
        let n = v["nonce"].as_str().unwrap().to_string();
        assert_eq!(n.len(), 32);
        n
    }

    async fn login_with(&self, user: &str, token: &str, nonce: &str, extra: &[(&str, &str)]) -> reqwest::Response {
        let mut req = self
            .http
            .post(self.url("/api/admin/login"))
            .header("content-type", "application/json")
            .body(json!({"user": user, "token": token, "nonce": nonce}).to_string());
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        req.send().await.unwrap()
    }

    async fn login(&self, user: &str, token: &str) -> reqwest::Response {
        let n = self.nonce().await;
        self.login_with(user, token, &n, &[]).await
    }

    /// Signs in as admin and returns the cookie header value.
    async fn admin_cookie(&self) -> String {
        let r = self.login("root", "good").await;
        assert_eq!(r.status(), 200);
        let sc = r.headers()[reqwest::header::SET_COOKIE].to_str().unwrap().to_string();
        sc.split(';').next().unwrap().to_string()
    }

    async fn get(&self, path: &str, cookie: Option<&str>) -> reqwest::Response {
        let mut req = self.http.get(self.url(path));
        if let Some(c) = cookie {
            req = req.header("cookie", c);
        }
        req.send().await.unwrap()
    }

    async fn post(&self, path: &str, cookie: Option<&str>, csrf: bool, body: Value) -> reqwest::Response {
        let mut req = self.http.post(self.url(path)).header("content-type", "application/json").body(body.to_string());
        if let Some(c) = cookie {
            req = req.header("cookie", c);
        }
        if csrf {
            req = req.header("x-requested-with", "hub-admin");
        }
        req.send().await.unwrap()
    }
}

trait JsonText {
    async fn json_text(self) -> Value;
}

impl JsonText for reqwest::Response {
    async fn json_text(self) -> Value {
        serde_json::from_str(&self.text().await.unwrap()).unwrap()
    }
}

#[tokio::test]
async fn admin_page_has_security_headers() {
    let s = start(false).await;
    let r = s.get("/admin", None).await;
    assert_eq!(r.status(), 200);
    let h = r.headers().clone();
    assert!(h["content-type"].to_str().unwrap().starts_with("text/html"));
    let csp = h["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("default-src 'self'") && csp.contains("frame-ancestors 'none'") && csp.contains("connect-src 'self'"));
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert_eq!(h["referrer-policy"], "no-referrer");
    let body = r.text().await.unwrap();
    assert!(body.contains("<title>Administration SelfHost Hub</title>"));
    assert!(!body.contains("http://") && !body.contains("https://"), "no external resources");
}

#[tokio::test]
async fn admin_login_sets_a_strict_cookie_and_opens_the_api() {
    let s = start(false).await;
    let r = s.login("root", "good").await;
    assert_eq!(r.status(), 200);
    let sc = r.headers()[reqwest::header::SET_COOKIE].to_str().unwrap().to_string();
    assert!(sc.starts_with("hub_admin="), "{sc}");
    let id = sc.split(';').next().unwrap().trim_start_matches("hub_admin=");
    assert_eq!(id.len(), 64);
    for part in ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=43200"] {
        assert!(sc.contains(part), "{part} in {sc}");
    }
    assert!(!sc.contains("Secure"));
    assert_eq!(r.json_text().await["user"], "root");

    let cookie = format!("hub_admin={id}");
    let me = s.get("/api/admin/me", Some(&cookie)).await;
    assert_eq!(me.status(), 200);
    let sys = s.get("/api/admin/system", Some(&cookie)).await;
    assert_eq!(sys.status(), 200);
    let sys = sys.json_text().await;
    assert_eq!(sys["containers"]["configured"], false);
    assert!(sys["history"]["cpu"].is_array());
    let hub = s.get("/api/admin/hub", Some(&cookie)).await;
    assert_eq!(hub.status(), 200);
    let hub = hub.json_text().await;
    assert_eq!(hub["server"]["name"], "Maison");
    assert_eq!(hub["users"], json!([]));

    // Logout needs the CSRF header, then kills the session.
    assert_eq!(s.post("/api/admin/logout", Some(&cookie), false, json!({})).await.status(), 403);
    assert_eq!(s.get("/api/admin/me", Some(&cookie)).await.status(), 200);
    assert_eq!(s.post("/api/admin/logout", Some(&cookie), true, json!({})).await.status(), 200);
    assert_eq!(s.get("/api/admin/me", Some(&cookie)).await.status(), 401);
}

#[tokio::test]
async fn cookie_is_secure_only_behind_a_trusted_https_proxy() {
    let trusted = start(true).await;
    let n = trusted.nonce().await;
    let r = trusted.login_with("root", "good", &n, &[("x-forwarded-proto", "https")]).await;
    assert!(r.headers()[reqwest::header::SET_COOKIE].to_str().unwrap().ends_with("; Secure"));
    let n = trusted.nonce().await;
    let r = trusted.login_with("root", "good", &n, &[("x-forwarded-proto", "http")]).await;
    assert!(!r.headers()[reqwest::header::SET_COOKIE].to_str().unwrap().contains("Secure"));

    let untrusted = start(false).await;
    let n = untrusted.nonce().await;
    let r = untrusted.login_with("root", "good", &n, &[("x-forwarded-proto", "https")]).await;
    assert!(!r.headers()[reqwest::header::SET_COOKIE].to_str().unwrap().contains("Secure"));
}

#[tokio::test]
async fn non_admin_gets_403() {
    let s = start(false).await;
    let r = s.login("bob", "good").await;
    assert_eq!(r.status(), 403);
    assert!(r.headers().get(reqwest::header::SET_COOKIE).is_none());
    assert_eq!(r.json_text().await, json!({"error": "not-admin"}));
}

#[tokio::test]
async fn bad_token_is_401_and_five_failures_block() {
    let s = start(false).await;
    for _ in 0..5 {
        let r = s.login("root", "wrong").await;
        assert_eq!(r.status(), 401);
        assert_eq!(r.json_text().await["error"], "bad-auth");
    }
    // Blocked now, even with a good token.
    let r = s.login("root", "good").await;
    assert_eq!(r.status(), 429);
    assert_eq!(r.json_text().await["error"], "too-many-attempts");
}

#[tokio::test]
async fn navidrome_down_is_502() {
    let s = start(false).await;
    assert_eq!(s.login("unreach", "good").await.status(), 502);
}

#[tokio::test]
async fn nonce_is_single_use_and_must_exist() {
    let s = start(false).await;
    let n = s.nonce().await;
    assert_eq!(s.login_with("root", "good", &n, &[]).await.status(), 200);
    let again = s.login_with("root", "good", &n, &[]).await;
    assert_eq!(again.status(), 400);
    assert_eq!(again.json_text().await["error"], "bad-nonce");
    assert_eq!(s.login_with("root", "good", &"0".repeat(32), &[]).await.status(), 400);
    // A failed attempt burns the nonce too.
    let n = s.nonce().await;
    assert_eq!(s.login_with("root", "wrong", &n, &[]).await.status(), 401);
    assert_eq!(s.login_with("root", "good", &n, &[]).await.status(), 400);
}

#[tokio::test]
async fn session_is_required() {
    let s = start(false).await;
    for p in ["/api/admin/me", "/api/admin/hub", "/api/admin/system"] {
        assert_eq!(s.get(p, None).await.status(), 401, "{p}");
        assert_eq!(s.get(p, Some("hub_admin=deadbeef")).await.status(), 401, "{p}");
    }
    let body = json!({"user": "max", "deviceId": "a"});
    assert_eq!(s.post("/api/admin/disconnect", None, true, body).await.status(), 401);
}

#[tokio::test]
async fn disconnect_needs_the_csrf_header() {
    let s = start(false).await;
    let cookie = s.admin_cookie().await;
    let body = json!({"user": "max", "deviceId": "a"});
    let r = s.post("/api/admin/disconnect", Some(&cookie), false, body.clone()).await;
    assert_eq!(r.status(), 403);
    assert_eq!(r.json_text().await["error"], "csrf");
    // With the header but nobody online: 404.
    assert_eq!(s.post("/api/admin/disconnect", Some(&cookie), true, body).await.status(), 404);
}

#[tokio::test]
async fn disconnect_kicks_a_live_client_with_4001() {
    let s = start(false).await;
    let cookie = s.admin_cookie().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", s.addr)).await.unwrap();
    let _challenge = ws.next().await.unwrap().unwrap();
    ws.send(Message::text(
        json!({"type":"hello","v":2,"deviceId":"phone","deviceName":"Pixel","platform":"mobile","user":"Max","token":"good"}).to_string(),
    ))
    .await
    .unwrap();
    let welcome = ws.next().await.unwrap().unwrap();
    assert!(welcome.to_text().unwrap().contains("\"accepted\":true"));
    ws.send(Message::text(
        json!({"type":"state","song":{"title":"Song","artist":"Band"},"isPlaying":true}).to_string(),
    ))
    .await
    .unwrap();

    // The hub view shows it (poll: the state frame is processed asynchronously).
    let mut seen = Value::Null;
    for _ in 0..50 {
        let hub = s.get("/api/admin/hub", Some(&cookie)).await.json_text().await;
        if hub["users"][0]["online"][0]["state"]["title"] == "Song" {
            seen = hub;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let dev = &seen["users"][0]["online"][0];
    assert_eq!(seen["users"][0]["user"], "max");
    assert_eq!((dev["deviceId"].as_str(), dev["deviceName"].as_str()), (Some("phone"), Some("Pixel")));
    assert_eq!(dev["ip"], "127.0.0.1");
    assert_eq!(dev["state"]["artist"], "Band");
    assert_eq!(dev["state"]["isPlaying"], true);
    assert_eq!(seen["users"][0]["known"][0]["deviceId"], "phone");

    let r = s.post("/api/admin/disconnect", Some(&cookie), true, json!({"user": "Max", "deviceId": "phone"})).await;
    assert_eq!(r.status(), 200);
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
            Some(Ok(Message::Close(Some(frame)))) => {
                assert_eq!(u16::from(frame.code), 4001);
                assert_eq!(frame.reason.as_str(), "kicked");
                break;
            }
            Some(Ok(_)) => {}
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}
