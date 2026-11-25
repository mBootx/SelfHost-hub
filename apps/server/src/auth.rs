use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use reqwest::Url;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    Ok,
    BadAuth,
    Unreachable,
}

/// Result of the admin check: valid credentials and `adminRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminOutcome {
    Admin,
    NotAdmin,
    BadAuth,
    Unreachable,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Checks a Subsonic salt+token pair. A trait so tests can fake Navidrome.
pub trait Authenticator: Send + Sync {
    fn check<'a>(&'a self, user: &'a str, token: &'a str, salt: &'a str) -> BoxFuture<'a, AuthOutcome>;

    /// Whether the user (already checked with [`Authenticator::check`]) has the Navidrome admin role.
    /// The default says no, so a fake only has to override this in tests that need an admin.
    fn is_admin<'a>(&'a self, _user: &'a str, _token: &'a str, _salt: &'a str) -> BoxFuture<'a, AdminOutcome> {
        Box::pin(async { AdminOutcome::NotAdmin })
    }
}

pub struct NavidromeAuth {
    client: reqwest::Client,
    base: String,
}

impl NavidromeAuth {
    pub fn new(base: &str) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?;
        Ok(Self { client, base: base.trim_end_matches('/').to_string() })
    }
}

/// `{base}/rest/ping.view?u=..&t=..&s=..&v=1.16.1&c=selfhost-hub-server&f=json`
pub fn ping_url(base: &str, user: &str, token: &str, salt: &str) -> Option<Url> {
    rest_url(base, "ping.view", user, token, salt, None)
}

/// `{base}/rest/getUser.view?u=..&t=..&s=..&v=..&c=..&f=json&username=..`
pub fn get_user_url(base: &str, user: &str, token: &str, salt: &str) -> Option<Url> {
    rest_url(base, "getUser.view", user, token, salt, Some(("username", user)))
}

fn rest_url(base: &str, endpoint: &str, user: &str, token: &str, salt: &str, extra: Option<(&str, &str)>) -> Option<Url> {
    let mut url = Url::parse(&format!("{}/rest/{endpoint}", base.trim_end_matches('/'))).ok()?;
    url.query_pairs_mut()
        .append_pair("u", user)
        .append_pair("t", token)
        .append_pair("s", salt)
        .append_pair("v", "1.16.1")
        .append_pair("c", "selfhost-hub-server")
        .append_pair("f", "json");
    if let Some((k, v)) = extra {
        url.query_pairs_mut().append_pair(k, v);
    }
    Some(url)
}

/// Reads a `getUser` body: status ok and `user.adminRole == true` is an admin.
pub fn parse_get_user(body: &str) -> AdminOutcome {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return AdminOutcome::Unreachable };
    match v.pointer("/subsonic-response/status").and_then(Value::as_str) {
        Some("ok") => {
            if v.pointer("/subsonic-response/user/adminRole").and_then(Value::as_bool) == Some(true) {
                AdminOutcome::Admin
            } else {
                AdminOutcome::NotAdmin
            }
        }
        Some(_) => AdminOutcome::BadAuth,
        None => AdminOutcome::Unreachable,
    }
}

/// Reads a Subsonic JSON body: `subsonic-response.status == "ok"` is a yes, a well-formed other status a no.
pub fn parse_ping(body: &str) -> AuthOutcome {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return AuthOutcome::Unreachable };
    match v.pointer("/subsonic-response/status").and_then(Value::as_str) {
        Some("ok") => AuthOutcome::Ok,
        Some(_) => AuthOutcome::BadAuth,
        None => AuthOutcome::Unreachable,
    }
}

impl NavidromeAuth {
    /// GET, then the body text. `None` when Navidrome cannot be reached or answers a non-2xx.
    async fn fetch(&self, url: Url) -> Option<String> {
        let resp = match self.client.get(url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                tracing::warn!("navidrome answered HTTP {}", r.status());
                return None;
            }
            Err(e) => {
                tracing::warn!("navidrome unreachable: {}", e.without_url());
                return None;
            }
        };
        resp.text().await.ok()
    }
}

impl Authenticator for NavidromeAuth {
    fn is_admin<'a>(&'a self, user: &'a str, token: &'a str, salt: &'a str) -> BoxFuture<'a, AdminOutcome> {
        Box::pin(async move {
            let Some(url) = get_user_url(&self.base, user, token, salt) else { return AdminOutcome::Unreachable };
            match self.fetch(url).await {
                Some(body) => parse_get_user(&body),
                None => AdminOutcome::Unreachable,
            }
        })
    }

    fn check<'a>(&'a self, user: &'a str, token: &'a str, salt: &'a str) -> BoxFuture<'a, AuthOutcome> {
        Box::pin(async move {
            let Some(url) = ping_url(&self.base, user, token, salt) else { return AuthOutcome::Unreachable };
            match self.fetch(url).await {
                Some(body) => parse_ping(&body),
                None => AuthOutcome::Unreachable,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_has_expected_params() {
        let u = ping_url("http://navidrome:4533/", "max", "abc123", "0011").unwrap();
        assert_eq!(u.path(), "/rest/ping.view");
        assert_eq!(
            u.query(),
            Some("u=max&t=abc123&s=0011&v=1.16.1&c=selfhost-hub-server&f=json")
        );
    }

    #[test]
    fn user_is_url_encoded() {
        let u = ping_url("http://n", "a b&c", "t", "s").unwrap();
        assert!(u.query().unwrap().starts_with("u=a+b%26c&"));
    }

    #[test]
    fn ping_body_parsing() {
        assert_eq!(parse_ping(r#"{"subsonic-response":{"status":"ok"}}"#), AuthOutcome::Ok);
        assert_eq!(parse_ping(r#"{"subsonic-response":{"status":"failed","error":{"code":40}}}"#), AuthOutcome::BadAuth);
        assert_eq!(parse_ping("<html>"), AuthOutcome::Unreachable);
    }

    #[test]
    fn get_user_admin_role() {
        assert_eq!(parse_get_user(r#"{"subsonic-response":{"status":"ok","user":{"username":"a","adminRole":true}}}"#), AdminOutcome::Admin);
        assert_eq!(parse_get_user(r#"{"subsonic-response":{"status":"ok","user":{"adminRole":false}}}"#), AdminOutcome::NotAdmin);
        assert_eq!(parse_get_user(r#"{"subsonic-response":{"status":"failed"}}"#), AdminOutcome::BadAuth);
        assert_eq!(parse_get_user("x"), AdminOutcome::Unreachable);
        let u = get_user_url("http://n/", "max", "t", "s").unwrap();
        assert_eq!(u.path(), "/rest/getUser.view");
        assert!(u.query().unwrap().ends_with("&f=json&username=max"));
    }
}
