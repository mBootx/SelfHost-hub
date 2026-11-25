use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Failed sign-in limiter: `max` failures per address within `window` block it for `block`.
pub struct Limiter {
    max: usize,
    window: Duration,
    block: Duration,
    inner: Mutex<HashMap<IpAddr, Entry>>,
}

#[derive(Default)]
struct Entry {
    failures: VecDeque<Instant>,
    blocked_until: Option<Instant>,
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new(5, Duration::from_secs(600), Duration::from_secs(600))
    }
}

impl Limiter {
    pub fn new(max: usize, window: Duration, block: Duration) -> Self {
        Self { max, window, block, inner: Mutex::new(HashMap::new()) }
    }

    pub fn is_blocked(&self, ip: IpAddr, now: Instant) -> bool {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get_mut(&ip) else { return false };
        match entry.blocked_until {
            Some(until) if now < until => true,
            Some(_) => {
                map.remove(&ip);
                false
            }
            None => false,
        }
    }

    pub fn record_failure(&self, ip: IpAddr, now: Instant) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 1024 {
            map.retain(|_, e| {
                e.blocked_until.is_some_and(|u| now < u)
                    || e.failures.back().is_some_and(|t| now.duration_since(*t) < self.window)
            });
        }
        let entry = map.entry(ip).or_default();
        while entry.failures.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            entry.failures.pop_front();
        }
        entry.failures.push_back(now);
        if entry.failures.len() >= self.max {
            entry.blocked_until = Some(now + self.block);
            entry.failures.clear();
        }
    }

    pub fn record_success(&self, ip: IpAddr) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(&ip).is_some_and(|e| e.blocked_until.is_none()) {
            map.remove(&ip);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 1));
    const OTHER: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 2));

    #[test]
    fn blocks_after_five_failures_then_expires() {
        let l = Limiter::default();
        let t0 = Instant::now();
        for i in 0..4 {
            l.record_failure(IP, t0 + Duration::from_secs(i));
            assert!(!l.is_blocked(IP, t0 + Duration::from_secs(i)));
        }
        l.record_failure(IP, t0 + Duration::from_secs(4));
        assert!(l.is_blocked(IP, t0 + Duration::from_secs(5)));
        assert!(!l.is_blocked(OTHER, t0 + Duration::from_secs(5)));
        assert!(l.is_blocked(IP, t0 + Duration::from_secs(603)));
        assert!(!l.is_blocked(IP, t0 + Duration::from_secs(605)));
    }

    #[test]
    fn old_failures_leave_the_window() {
        let l = Limiter::default();
        let t0 = Instant::now();
        for i in 0..4 {
            l.record_failure(IP, t0 + Duration::from_secs(i));
        }
        l.record_failure(IP, t0 + Duration::from_secs(700));
        assert!(!l.is_blocked(IP, t0 + Duration::from_secs(701)));
    }

    #[test]
    fn success_clears_failures() {
        let l = Limiter::default();
        let t0 = Instant::now();
        for _ in 0..4 {
            l.record_failure(IP, t0);
        }
        l.record_success(IP);
        l.record_failure(IP, t0);
        assert!(!l.is_blocked(IP, t0));
    }
}
