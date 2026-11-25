use std::fmt;
use std::future::Future;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

/// One HTTP request, body held in memory. Large uploads and downloads stream through the apps' own code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// True for a server only the home network can reach (see [`hub_core::home_network::is_home_host`]): the
    /// watch then binds the request to its own Wi-Fi.
    pub home_network: bool,
    /// Replaces the transport's own time limit for the whole call, for a request known to take long.
    pub timeout: Option<Duration>,
}

impl Request {
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            home_network: false,
            timeout: None,
        }
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_owned(), value.into()));
        self
    }

    pub fn headers(mut self, headers: impl IntoIterator<Item = (String, String)>) -> Self {
        self.headers.extend(headers);
        self
    }

    /// A JSON body, with its content type.
    pub fn json(mut self, value: &serde_json::Value) -> Self {
        self.body = Some(value.to_string().into_bytes());
        self.header("Content-Type", "application/json")
    }

    pub fn home_network(mut self, home: bool) -> Self {
        self.home_network = home;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

/// What a server answered, read in full: nothing is left holding a connection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reply {
    pub status: u16,
    /// Every header, in the order received; names as the server wrote them.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        let headers = if content_type.is_empty() {
            Vec::new()
        } else {
            vec![("Content-Type".to_owned(), content_type.to_owned())]
        };
        Self {
            status,
            headers,
            body: body.into(),
        }
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The first header of that name, whatever its case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Every header of that name (a server sends one `Set-Cookie` per cookie).
    pub fn headers_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.headers
            .iter()
            .filter(move |(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The `Content-Type` header, empty when there was none.
    pub fn content_type(&self) -> &str {
        self.header("Content-Type").unwrap_or_default()
    }

    /// The body as JSON, when it is JSON.
    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// The request never got an answer: no network, the server or its proxy down, a timeout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError(pub String);

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TransportError {}

/// Sends HTTP requests. Each app provides one; dropping the returned future must cancel the request.
pub trait Transport: Send + Sync {
    fn send(&self, request: Request) -> impl Future<Output = Result<Reply, TransportError>> + Send;

    fn get(
        &self,
        url: &str,
        home_network: bool,
    ) -> impl Future<Output = Result<Reply, TransportError>> + Send {
        self.send(Request::new(Method::Get, url).home_network(home_network))
    }
}

/// A shared transport: one connection pool for every client of an app.
impl<T: Transport> Transport for std::sync::Arc<T> {
    fn send(&self, request: Request) -> impl Future<Output = Result<Reply, TransportError>> + Send {
        (**self).send(request)
    }
}
