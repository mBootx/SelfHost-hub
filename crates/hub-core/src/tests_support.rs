//! Helpers for this crate's tests.

use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

/// Answers "not yet" once, so futures that run side by side take turns.
pub(crate) struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

pub(crate) fn yield_now() -> YieldOnce {
    YieldOnce(false)
}

/// Runs two futures side by side until both are done.
pub(crate) async fn join<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let (mut first, mut second) = (None, None);
    poll_fn(|cx| {
        if first.is_none()
            && let Poll::Ready(value) = a.as_mut().poll(cx)
        {
            first = Some(value);
        }
        if second.is_none()
            && let Poll::Ready(value) = b.as_mut().poll(cx)
        {
            second = Some(value);
        }
        match (first.take(), second.take()) {
            (Some(x), Some(y)) => Poll::Ready((x, y)),
            (x, y) => {
                first = x;
                second = y;
                Poll::Pending
            }
        }
    })
    .await
}

/// Runs a future that never waits on anything outside itself.
pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::yield_now();
    }
}
