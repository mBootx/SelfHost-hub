use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use selfhost_hub_server::auth::{AuthOutcome, Authenticator, BoxFuture, NavidromeAuth};
use selfhost_hub_server::db::Db;
use selfhost_hub_server::{AppState, router};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// Accepts the token "good" for any user.
struct FakeAuth;

impl Authenticator for FakeAuth {
    fn check<'a>(&'a self, _user: &'a str, token: &'a str, _salt: &'a str) -> BoxFuture<'a, AuthOutcome> {
        Box::pin(async move { if token == "good" { AuthOutcome::Ok } else { AuthOutcome::BadAuth } })
    }
}

async fn start_server() -> (SocketAddr, watch::Sender<bool>) {
    let (stop_tx, stop_rx) = watch::channel(false);
    let state = AppState::new("Maison", false, Db::open_in_memory().unwrap(), Arc::new(FakeAuth), stop_rx);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    (addr, stop_tx)
}

type Seen = Arc<Mutex<Vec<(String, HashMap<String, String>)>>>;
type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Client {
    ws: Ws,
}

impl Client {
    async fn raw(addr: SocketAddr) -> (Self, Value) {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
        let mut c = Self { ws };
        let challenge = c.recv().await;
        (c, challenge)
    }

    async fn send(&mut self, v: Value) {
        self.ws.send(Message::text(v.to_string())).await.unwrap();
    }

    async fn recv(&mut self) -> Value {
        loop {
            let m = tokio::time::timeout(Duration::from_secs(5), self.ws.next())
                .await
                .expect("timed out waiting for a frame")
                .expect("socket closed")
                .expect("socket error");
            if let Message::Text(t) = m {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    }

    async fn hello(&mut self, user: &str, id: &str, token: &str) {
        self.send(json!({
            "type": "hello", "v": 2, "deviceId": id, "deviceName": format!("dev-{id}"),
            "platform": "mobile", "user": user, "token": token,
        }))
        .await;
    }

    /// Connects and signs in; returns the client after consuming welcome and the first devices message.
    async fn join(addr: SocketAddr, user: &str, id: &str) -> Self {
        let (mut c, challenge) = Self::raw(addr).await;
        assert_eq!(challenge["type"], "challenge");
        assert_eq!(challenge["v"], 2);
        assert_eq!(challenge["nonce"].as_str().unwrap().len(), 32);
        assert_eq!(challenge["serverName"], "Maison");
        c.hello(user, id, "good").await;
        let welcome = c.recv().await;
        assert_eq!(welcome["type"], "welcome");
        assert_eq!(welcome["accepted"], true);
        assert_eq!(welcome["user"], user.to_lowercase());
        assert_eq!(welcome["deviceId"], id);
        assert_eq!(c.recv().await["type"], "devices");
        c
    }
}

#[tokio::test]
async fn health_endpoint() {
    let (addr, _stop) = start_server().await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    s.write_all(b"GET /api/health HTTP/1.0\r\n\r\n").await.unwrap();
    let mut body = String::new();
    s.read_to_string(&mut body).await.unwrap();
    assert!(body.starts_with("HTTP/1.0 200"));
    assert!(body.contains("\"app\":\"selfhost-hub-server\""));
    assert!(body.contains("\"name\":\"Maison\""));
}

#[tokio::test]
async fn bad_token_is_refused() {
    let (addr, _stop) = start_server().await;
    let (mut c, _) = Client::raw(addr).await;
    c.hello("max", "a", "wrong").await;
    let w = c.recv().await;
    assert_eq!(w["type"], "welcome");
    assert_eq!(w["accepted"], false);
    assert_eq!(w["reason"], "bad-auth");
}

#[tokio::test]
async fn old_protocol_needs_update() {
    let (addr, _stop) = start_server().await;
    let (mut c, _) = Client::raw(addr).await;
    c.send(json!({"type":"hello","deviceId":"a","deviceName":"n","platform":"mobile","user":"max","token":"good"})).await;
    assert_eq!(c.recv().await["reason"], "update-required");
}

#[tokio::test]
async fn remote_control_between_two_devices() {
    let (addr, _stop) = start_server().await;
    let mut a = Client::join(addr, "Max", "a").await;
    let mut b = Client::join(addr, "max", "b").await;

    // b's own devices message lists both; a is told too.
    // (join() consumed b's first devices message, so check that it was complete via a's update.)
    let d = a.recv().await;
    assert_eq!(d["type"], "devices");
    assert_eq!(d["devices"].as_array().unwrap().len(), 2);

    // State relay stamps deviceId and goes to the other device only.
    a.send(json!({"type":"state","song":null,"isPlaying":true,"currentTime":1.5,"volume":0.8})).await;
    let s = b.recv().await;
    assert_eq!(s["type"], "state");
    assert_eq!(s["deviceId"], "a");
    assert_eq!(s["isPlaying"], true);

    // A newcomer receives the last known state of the others right after devices.
    let (mut c, _) = Client::raw(addr).await;
    c.hello("max", "c", "good").await;
    assert_eq!(c.recv().await["type"], "welcome");
    let devices = c.recv().await;
    assert_eq!(devices["devices"].as_array().unwrap().len(), 3);
    let replay = c.recv().await;
    assert_eq!(replay["type"], "state");
    assert_eq!(replay["deviceId"], "a");

    // Commands go to the target with fromId.
    b.recv().await; // devices (c joined)
    a.recv().await;
    b.send(json!({"type":"command","targetId":"a","action":"seek","payload":12})).await;
    let cmd = a.recv().await;
    assert_eq!(cmd["type"], "command");
    assert_eq!(cmd["fromId"], "b");
    assert_eq!(cmd["targetId"], "a");
    assert_eq!(cmd["action"], "seek");
    assert_eq!(cmd["payload"], 12);

    // Disallowed action.
    b.send(json!({"type":"command","targetId":"a","action":"rm-rf"})).await;
    let err = b.recv().await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "bad-command");
}

#[tokio::test]
async fn command_to_another_users_device_is_refused() {
    let (addr, _stop) = start_server().await;
    let mut a = Client::join(addr, "max", "a").await;
    let mut other = Client::join(addr, "lea", "z").await;
    a.send(json!({"type":"command","targetId":"z","action":"play"})).await;
    let err = a.recv().await;
    assert_eq!(err["code"], "bad-command");
    // Nothing reached the other user (a ping-like probe: the next frame is a reply to its own message).
    other.send(json!({"type":"command","targetId":"nobody","action":"play"})).await;
    assert_eq!(other.recv().await["code"], "bad-command");
}

#[tokio::test]
async fn same_device_id_replaces_the_old_connection() {
    let (addr, _stop) = start_server().await;
    let mut first = Client::join(addr, "max", "a").await;
    let _second = Client::join(addr, "max", "a").await;
    loop {
        match tokio::time::timeout(Duration::from_secs(5), first.ws.next()).await.unwrap() {
            Some(Ok(Message::Close(Some(frame)))) => {
                assert_eq!(u16::from(frame.code), 4000);
                break;
            }
            Some(Ok(_)) => {}
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn listening_push_notifies_and_pull_returns_entry() {
    let (addr, _stop) = start_server().await;
    let mut a = Client::join(addr, "max", "a").await;
    let mut b = Client::join(addr, "max", "b").await;
    a.recv().await; // devices (b joined)

    a.send(json!({"type":"listening.push","weeks":{"2026-11-23":{"days":{"mon":3},"songs":{}}}})).await;
    let ack = a.recv().await;
    assert_eq!(ack["type"], "listening.ack");
    assert_eq!(ack["weeks"], json!(["2026-11-23"]));
    assert_eq!(ack["rev"], 1);

    let changed = b.recv().await;
    assert_eq!(changed["type"], "listening.changed");
    assert_eq!(changed["rev"], 1);

    b.send(json!({"type":"listening.pull","since":0})).await;
    let data = b.recv().await;
    assert_eq!(data["type"], "listening.data");
    assert_eq!(data["rev"], 1);
    assert_eq!(data["more"], false);
    let e = &data["entries"][0];
    assert_eq!(e["deviceId"], "a");
    assert_eq!(e["deviceName"], "dev-a");
    assert_eq!(e["week"], "2026-11-23");
    assert_eq!(e["log"]["days"]["mon"], 3);
    assert_eq!(e["rev"], 1);

    // The pusher does not get its own rows back.
    a.send(json!({"type":"listening.pull","since":0})).await;
    assert_eq!(a.recv().await["entries"], json!([]));

    // Bad week key: error, ack with nothing stored.
    a.send(json!({"type":"listening.push","weeks":{"nope":{}}})).await;
    assert_eq!(a.recv().await["code"], "bad-message");
    let ack = a.recv().await;
    assert_eq!(ack["weeks"], json!([]));
    assert_eq!(ack["rev"], 1);
}

// --- the real Navidrome check against a tiny local fake Navidrome ---

#[tokio::test]
async fn navidrome_check_builds_the_right_request() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let seen: Seen = Arc::default();
    let seen2 = seen.clone();
    let app = axum::Router::new().route(
        "/rest/ping.view",
        axum::routing::get(
            move |uri: axum::http::Uri, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>| {
                let seen = seen2.clone();
                async move {
                    let ok = q.get("t").map(String::as_str) == Some("tok");
                    seen.lock().unwrap().push((uri.path().to_string(), q));
                    let status = if ok { "ok" } else { "failed" };
                    axum::Json(json!({"subsonic-response": {"status": status, "version": "1.16.1"}}))
                }
            },
        ),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let auth = NavidromeAuth::new(&format!("http://{addr}/")).unwrap();
    assert_eq!(auth.check("Max", "tok", "abcdef").await, AuthOutcome::Ok);
    assert_eq!(auth.check("Max", "nope", "abcdef").await, AuthOutcome::BadAuth);

    let (path, q) = seen.lock().unwrap()[0].clone();
    assert_eq!(path, "/rest/ping.view");
    for (k, v) in [("u", "Max"), ("t", "tok"), ("s", "abcdef"), ("v", "1.16.1"), ("c", "selfhost-hub-server"), ("f", "json")] {
        assert_eq!(q.get(k).map(String::as_str), Some(v), "param {k}");
    }

    // Nothing listening on the port: unreachable.
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_addr = dead.local_addr().unwrap();
    drop(dead);
    let auth = NavidromeAuth::new(&format!("http://{dead_addr}")).unwrap();
    assert_eq!(auth.check("max", "tok", "s").await, AuthOutcome::Unreachable);
}
