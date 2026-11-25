//! Pure message validation, no I/O.

use serde_json::{Map, Value, json};

pub const PROTOCOL_VERSION: u64 = 2;
pub const MAX_WEEKS_PER_PUSH: usize = 8;
pub const MAX_WEEK_BYTES: usize = 2 * 1024 * 1024;
pub const PAGE_SIZE: usize = 200;
pub const ALLOWED_ACTIONS: [&str; 10] = [
    "toggle",
    "play",
    "pause",
    "next",
    "prev",
    "seek",
    "setVolume",
    "toggleShuffle",
    "setRepeatMode",
    "playMedia",
];

pub fn error_json(code: &str, message: &str) -> String {
    json!({"type": "error", "code": code, "message": message}).to_string()
}

/// `yyyy-mm-dd` (digits only, shape check as in `^\d{4}-\d{2}-\d{2}$`).
pub fn is_week_key(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub device: DeviceInfo,
    pub user: String,
    pub token: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HelloError {
    UpdateRequired,
    BadHello,
}

impl HelloError {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::UpdateRequired => "update-required",
            Self::BadHello => "bad-hello",
        }
    }
}

pub fn parse_hello(v: &Value) -> Result<Hello, HelloError> {
    let o = v.as_object().ok_or(HelloError::BadHello)?;
    if o.get("v").and_then(Value::as_u64).is_none_or(|n| n < PROTOCOL_VERSION) {
        return Err(HelloError::UpdateRequired);
    }
    let s = |k: &str, max: usize| {
        o.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|x| !x.is_empty() && x.len() <= max)
            .map(str::to_string)
            .ok_or(HelloError::BadHello)
    };
    let platform = s("platform", 16)?;
    if !matches!(platform.as_str(), "mobile" | "desktop" | "watch") {
        return Err(HelloError::BadHello);
    }
    Ok(Hello {
        device: DeviceInfo { device_id: s("deviceId", 128)?, device_name: s("deviceName", 128)?, platform },
        user: s("user", 128)?,
        token: s("token", 256)?,
    })
}

/// What to do with a `listening.push`.
#[derive(Debug, Default)]
pub struct PushPlan {
    /// `(week, log JSON text)` to store, in message order.
    pub accepted: Vec<(String, String)>,
    /// `(code, message)` errors to report.
    pub errors: Vec<(&'static str, String)>,
}

pub fn plan_push(weeks: Option<&Value>) -> PushPlan {
    let mut plan = PushPlan::default();
    let Some(weeks) = weeks.and_then(Value::as_object) else {
        plan.errors.push(("bad-message", "weeks must be an object".into()));
        return plan;
    };
    plan_weeks(weeks, &mut plan);
    plan
}

fn plan_weeks(weeks: &Map<String, Value>, plan: &mut PushPlan) {
    if weeks.len() > MAX_WEEKS_PER_PUSH {
        plan.errors.push((
            "bad-message",
            format!("at most {MAX_WEEKS_PER_PUSH} weeks per push, processing the first {MAX_WEEKS_PER_PUSH}"),
        ));
    }
    for (week, log) in weeks.iter().take(MAX_WEEKS_PER_PUSH) {
        if !is_week_key(week) {
            plan.errors.push(("bad-message", format!("bad week key: {week}")));
        } else if !log.is_object() {
            plan.errors.push(("bad-message", format!("log of {week} must be an object")));
        } else {
            let text = log.to_string();
            if text.len() > MAX_WEEK_BYTES {
                plan.errors.push(("too-large", format!("week {week} is over 2 MiB")));
            } else {
                plan.accepted.push((week.clone(), text));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn week_keys() {
        assert!(is_week_key("2026-11-23"));
        assert!(!is_week_key("2026-1-23"));
        assert!(!is_week_key("2026-11-23x"));
        assert!(!is_week_key("20261123--"));
        assert!(!is_week_key("2026-11-2\u{e9}"));
    }

    #[test]
    fn push_limits_and_validation() {
        let mut m = Map::new();
        for d in 1..=10 {
            m.insert(format!("2026-11-{d:02}"), json!({"days": {}}));
        }
        let plan = plan_push(Some(&Value::Object(m)));
        assert_eq!(plan.accepted.len(), 8);
        assert_eq!(plan.accepted[0].0, "2026-11-01");
        assert_eq!(plan.errors.len(), 1);
        assert_eq!(plan.errors[0].0, "bad-message");

        let plan = plan_push(Some(&json!({"nope": {}, "2026-11-23": [1], "2026-11-16": {"a": 1}})));
        assert_eq!(plan.accepted.len(), 1);
        assert_eq!(plan.errors.len(), 2);

        assert_eq!(plan_push(None).errors.len(), 1);
    }

    #[test]
    fn too_large_week_does_not_block_others() {
        let big = "x".repeat(MAX_WEEK_BYTES + 1);
        let plan = plan_push(Some(&json!({"2026-11-23": {"s": big}, "2026-11-16": {}})));
        assert_eq!(plan.accepted.len(), 1);
        assert_eq!(plan.errors[0].0, "too-large");
    }

    #[test]
    fn hello_validation() {
        let good = json!({"type":"hello","v":2,"deviceId":"d","deviceName":"n","platform":"mobile","user":"Max","token":"t"});
        assert_eq!(parse_hello(&good).unwrap().user, "Max");
        let mut old = good.clone();
        old["v"] = json!(1);
        assert_eq!(parse_hello(&old), Err(HelloError::UpdateRequired));
        let mut bad = good.clone();
        bad["platform"] = json!("toaster");
        assert_eq!(parse_hello(&bad), Err(HelloError::BadHello));
        let mut bad = good;
        bad["deviceId"] = json!("");
        assert_eq!(parse_hello(&bad), Err(HelloError::BadHello));
    }
}
