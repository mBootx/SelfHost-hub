//! The real [`Transport`]: reqwest over rustls, with the `ring` crypto provider and the platform's certificate
//! store, so each device trusts the servers it trusted before the rewrite (see docs/rust-rewrite.md).
//!
//! Needs a Tokio runtime to run on. On Android, `rustls-platform-verifier` must also be initialised from the app's
//! Kotlin shim before the first HTTPS request.

use std::time::Duration;

use crate::transport::{Method, Reply, Request, Transport, TransportError};

/// The watch app's OkHttp settings, kept for every app.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT: Duration = Duration::from_secs(40);

/// Two clients: one for servers on the internet, one for servers only the home network can reach. They are the
/// same on the desktop; the watch builds its home client bound to its own Wi-Fi.
#[derive(Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
    home: reqwest::Client,
}

impl HttpTransport {
    /// The same client for every server, with the default timeouts.
    pub fn new() -> Result<Self, TransportError> {
        let client = Self::builder().build().map_err(setup_error)?;
        Ok(Self::with_clients(client.clone(), client))
    }

    /// A client builder with the crypto provider installed and the default timeouts, for an app that needs to
    /// change something (the watch's home client, bound to its Wi-Fi).
    pub fn builder() -> reqwest::ClientBuilder {
        install_crypto_provider();
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .timeout(CALL_TIMEOUT)
    }

    pub fn with_clients(client: reqwest::Client, home: reqwest::Client) -> Self {
        Self { client, home }
    }
}

impl Transport for HttpTransport {
    async fn send(&self, request: Request) -> Result<Reply, TransportError> {
        let client = if request.home_network {
            &self.home
        } else {
            &self.client
        };
        let method = match request.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        };
        let mut builder = client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        let response = builder.send().await.map_err(request_error)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
            })
            .collect();
        let body = response.bytes().await.map_err(request_error)?.to_vec();
        Ok(Reply {
            status,
            headers,
            body,
        })
    }
}

/// rustls needs one crypto provider for the whole process; reqwest takes the installed one. Installing it a second
/// time fails harmlessly.
fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// The words the TypeScript apps used for a request that got no answer.
fn request_error(e: reqwest::Error) -> TransportError {
    if e.is_timeout() {
        TransportError("Le serveur ne répond pas".into())
    } else {
        TransportError("Serveur injoignable".into())
    }
}

fn setup_error(e: reqwest::Error) -> TransportError {
    TransportError(format!("Client HTTP impossible à créer : {e}"))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    use hub_core::subsonic::{CLIENT_NAME, NavidromeLogin};

    use super::*;
    use crate::subsonic::SubsonicClient;

    /// Serves one request with `response` (a full HTTP/1.1 response) and sends back the whole request it got,
    /// head and body.
    fn serve_once(response: String) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            let head_end = loop {
                if let Some(at) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at + 4;
                }
                let n = socket.read(&mut buf).unwrap();
                if n == 0 {
                    break request.len();
                }
                request.extend_from_slice(&buf[..n]);
            };
            let head = String::from_utf8_lossy(&request[..head_end]).to_lowercase();
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            while request.len() < head_end + length {
                let n = socket.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
            }
            // The test may not care about the request and have dropped the receiver.
            let _ = tx.send(String::from_utf8_lossy(&request).into_owned());
            socket.write_all(response.as_bytes()).unwrap();
        });
        (port, rx)
    }

    fn first_line(request: &str) -> &str {
        request.lines().next().unwrap_or_default()
    }

    fn response(status: &str, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn a_client_with_the_platform_store_can_be_made() {
        assert!(HttpTransport::new().is_ok());
    }

    #[test]
    fn an_answer_comes_back_whole_with_its_status_and_type() {
        let (port, request) = serve_once(response("200 OK", "image/jpeg", "pixels"));
        let transport = HttpTransport::new().unwrap();
        let reply = run(transport.get(
            &format!("http://127.0.0.1:{port}/rest/getCoverArt.view?id=al%2D1"),
            false,
        ))
        .unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.content_type(), "image/jpeg");
        assert_eq!(reply.body, b"pixels");
        assert_eq!(
            first_line(&request.recv().unwrap()),
            "GET /rest/getCoverArt.view?id=al%2D1 HTTP/1.1"
        );
    }

    #[test]
    fn a_request_carries_its_method_headers_and_body_and_every_reply_header_comes_back() {
        let reply_text = "HTTP/1.1 200 OK\r\nSet-Cookie: a=1; Path=/\r\nSet-Cookie: b=2; Path=/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned();
        let (port, request) = serve_once(reply_text);
        let sent = Request::new(
            Method::Patch,
            format!("http://127.0.0.1:{port}/api/resources"),
        )
        .header("Authorization", "Bearer x.y.z")
        .json(&serde_json::json!({ "action": "move" }));
        let reply = run(HttpTransport::new().unwrap().send(sent)).unwrap();
        let cookies: Vec<&str> = reply.headers_named("set-cookie").collect();
        assert_eq!(cookies, ["a=1; Path=/", "b=2; Path=/"]);
        let received = request.recv().unwrap();
        assert_eq!(first_line(&received), "PATCH /api/resources HTTP/1.1");
        let lower = received.to_lowercase();
        assert!(lower.contains("authorization: bearer x.y.z"), "{received}");
        assert!(
            lower.contains("content-type: application/json"),
            "{received}"
        );
        assert!(received.ends_with(r#"{"action":"move"}"#), "{received}");
    }

    #[test]
    fn an_error_status_is_an_answer_not_a_transport_error() {
        let (port, _) = serve_once(response("500 Internal Server Error", "text/plain", "boom"));
        let reply = run(HttpTransport::new()
            .unwrap()
            .get(&format!("http://127.0.0.1:{port}/"), false))
        .unwrap();
        assert_eq!(reply.status, 500);
        assert!(!reply.is_success());
    }

    #[test]
    fn a_server_that_is_not_there_is_a_transport_error() {
        // A port that was free a moment ago: nobody listens on it any more.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let result = run(HttpTransport::new()
            .unwrap()
            .get(&format!("http://127.0.0.1:{port}/"), false));
        assert_eq!(result, Err(TransportError("Serveur injoignable".into())));
    }

    #[test]
    fn the_subsonic_client_runs_over_it_end_to_end() {
        let body =
            r#"{"subsonic-response":{"status":"ok","version":"1.16.1","serverVersion":"0.54.5"}}"#;
        let (port, request) = serve_once(response("200 OK", "application/json", body));
        let client = SubsonicClient::new(HttpTransport::new().unwrap(), CLIENT_NAME, move || {
            Some(NavidromeLogin {
                url: format!("http://127.0.0.1:{port}"),
                username: "maxime".into(),
                salt: "c19b2d".into(),
                token: "26719a1196d2a940705a59634eb18eab".into(),
            })
        });
        let info = run(client.ping()).unwrap();
        assert_eq!(info.version.as_deref(), Some("0.54.5"));
        let received = request.recv().unwrap();
        let line = first_line(&received);
        assert!(line.starts_with("GET /rest/ping.view?u=maxime&t=26719a1196d2a940705a59634eb18eab&s=c19b2d&v=1.16.1&c=SelfHostHub&f=json "), "{line}");
    }
}
