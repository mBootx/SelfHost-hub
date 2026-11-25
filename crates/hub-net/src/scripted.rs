//! A scripted server for client tests: answers each request with the first rule that matches it, and keeps every
//! request it received. Like the `xhrReplies` stub of `mobile/tests/`.

use std::sync::Mutex;

use crate::transport::{Method, Reply, Request, Transport, TransportError};

type Matcher = Box<dyn Fn(&Request) -> bool + Send + Sync>;

#[derive(Default)]
pub(crate) struct Scripted {
    rules: Mutex<Vec<(Matcher, Result<Reply, TransportError>)>>,
    pub log: Mutex<Vec<Request>>,
    /// When set, every request waits one turn before it is answered, so that requests started together overlap.
    pub yielding: std::sync::atomic::AtomicBool,
}

/// A future that is pending once, then ready.
struct YieldOnce(bool);

impl std::future::Future for YieldOnce {
    type Output = ();

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<()> {
        if self.0 {
            std::task::Poll::Ready(())
        } else {
            self.0 = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    }
}

/// Runs two futures together, polling each in turn, until both are done.
pub(crate) fn join<A: std::future::Future, B: std::future::Future>(
    a: A,
    b: B,
) -> (A::Output, B::Output) {
    use std::task::{Context, Poll, Waker};
    let (mut a, mut b) = (std::pin::pin!(a), std::pin::pin!(b));
    let (mut ra, mut rb) = (None, None);
    let mut cx = Context::from_waker(Waker::noop());
    while ra.is_none() || rb.is_none() {
        if ra.is_none()
            && let Poll::Ready(v) = a.as_mut().poll(&mut cx)
        {
            ra = Some(v);
        }
        if rb.is_none()
            && let Poll::Ready(v) = b.as_mut().poll(&mut cx)
        {
            rb = Some(v);
        }
    }
    (ra.unwrap(), rb.unwrap())
}

impl Scripted {
    /// Answers requests of `method` whose address starts with `url_prefix`.
    pub(crate) fn on(&self, method: Method, url_prefix: &str, reply: Reply) {
        let prefix = url_prefix.to_owned();
        self.on_match(
            move |r| r.method == method && r.url.starts_with(&prefix),
            reply,
        );
    }

    pub(crate) fn on_match(
        &self,
        matcher: impl Fn(&Request) -> bool + Send + Sync + 'static,
        reply: Reply,
    ) {
        self.rules
            .lock()
            .unwrap()
            .push((Box::new(matcher), Ok(reply)));
    }

    /// Fails requests of `method` to addresses starting with `url_prefix` as if the server were down.
    pub(crate) fn unreachable(&self, method: Method, url_prefix: &str) {
        let prefix = url_prefix.to_owned();
        self.rules.lock().unwrap().push((
            Box::new(move |r: &Request| r.method == method && r.url.starts_with(&prefix)),
            Err(TransportError("Serveur injoignable".into())),
        ));
    }

    pub(crate) fn clear(&self) {
        self.rules.lock().unwrap().clear();
        self.log.lock().unwrap().clear();
    }

    pub(crate) fn last(&self) -> Request {
        self.log
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("no request was sent")
    }

    pub(crate) fn sent(&self) -> Vec<Request> {
        self.log.lock().unwrap().clone()
    }
}

impl Transport for Scripted {
    async fn send(&self, request: Request) -> Result<Reply, TransportError> {
        if self.yielding.load(std::sync::atomic::Ordering::SeqCst) {
            YieldOnce(false).await;
        }
        let answer = self
            .rules
            .lock()
            .unwrap()
            .iter()
            .find(|(matches, _)| matches(&request))
            .map(|(_, reply)| reply.clone())
            .unwrap_or_else(|| Ok(Reply::new(404, "", Vec::new())));
        self.log.lock().unwrap().push(request);
        answer
    }
}

/// A JSON reply.
pub(crate) fn json(status: u16, value: serde_json::Value) -> Reply {
    Reply::new(status, "application/json", value.to_string().into_bytes())
}

/// The decoded query parameters of an address, in order.
pub(crate) fn query(url: &str) -> Vec<(String, String)> {
    let query = url.split_once('?').map_or("", |(_, q)| q);
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (
                crate::url::decode_component(k),
                crate::url::decode_component(v),
            )
        })
        .collect()
}

/// A request's header, whatever its case.
pub(crate) fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// A request's JSON body.
pub(crate) fn body(request: &Request) -> serde_json::Value {
    serde_json::from_slice(request.body.as_deref().unwrap_or_default()).unwrap_or_default()
}
