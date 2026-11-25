//! Threshold-based alert evaluation and optional webhook notifications.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::watch;

const EVAL_INTERVAL: Duration = Duration::from_secs(30);

/// One active or resolved system alert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    pub id: String,
    pub severity: &'static str,
    pub title: String,
    pub detail: String,
    pub since: u64,
}

impl Alert {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "severity": self.severity, "title": self.title, "detail": self.detail, "since": self.since})
    }
}

/// Thresholds and optional webhook URL for [`AlertEngine`].
#[derive(Debug, Clone)]
pub struct AlertConfig {
    pub disk_percent: f64,
    pub temp_c: f64,
    pub webhook_url: Option<String>,
}

impl Default for AlertConfig {
    fn default() -> Self {
        Self { disk_percent: 90.0, temp_c: 85.0, webhook_url: None }
    }
}

/// Tracks active system alerts and notifies a webhook on transitions.
pub struct AlertEngine {
    cfg: AlertConfig,
    active: Mutex<HashMap<String, Alert>>,
}

impl AlertEngine {
    /// Creates an alert engine with the given thresholds and webhook configuration.
    pub fn new(cfg: AlertConfig) -> Arc<Self> {
        Arc::new(Self { cfg, active: Mutex::new(HashMap::new()) })
    }

    /// Evaluates `snap` and `navidrome_ok`, updates active alerts (preserving `since`), and returns `(newly_raised, newly_resolved)`.
    pub fn evaluate(&self, snap: &Value, navidrome_ok: Option<bool>, now: u64) -> (Vec<Alert>, Vec<Alert>) {
        let mut desired: HashMap<String, Alert> = HashMap::new();

        if let Some(items) = snap.pointer("/disks/items").and_then(Value::as_array) {
            for item in items {
                let (Some(mount), Some(percent)) = (
                    item.get("mountpoint").and_then(Value::as_str),
                    item.get("percent").and_then(Value::as_f64),
                ) else {
                    continue;
                };
                if percent >= self.cfg.disk_percent {
                    let id = format!("disk:{mount}");
                    let severity = if percent >= 95.0 { "critical" } else { "warn" };
                    desired.insert(
                        id.clone(),
                        Alert {
                            id,
                            severity,
                            title: format!("Disque presque plein ({mount})"),
                            detail: format!("{percent:.1} % utilisés"),
                            since: now,
                        },
                    );
                }
            }
        }

        if let Some(max) = snap
            .pointer("/temps/max")
            .and_then(Value::as_f64)
            .filter(|&max| max >= self.cfg.temp_c)
        {
            let severity = if max >= self.cfg.temp_c + 10.0 { "critical" } else { "warn" };
            desired.insert(
                "temp:max".into(),
                Alert {
                    id: "temp:max".into(),
                    severity,
                    title: "Température élevée".into(),
                    detail: format!("{max:.1} °C"),
                    since: now,
                },
            );
        }

        if let Some(items) = snap.pointer("/containers/items").and_then(Value::as_array) {
            for item in items {
                let (Some(name), Some(state)) = (
                    item.get("name").and_then(Value::as_str),
                    item.get("state").and_then(Value::as_str),
                ) else {
                    continue;
                };
                if state != "running" {
                    let status = item.get("status").and_then(Value::as_str).unwrap_or(state);
                    let id = format!("container:{name}");
                    desired.insert(
                        id.clone(),
                        Alert {
                            id,
                            severity: "warn",
                            title: format!("Conteneur arrêté : {name}"),
                            detail: status.to_string(),
                            since: now,
                        },
                    );
                }
            }
        }

        if navidrome_ok == Some(false) {
            desired.insert(
                "navidrome:down".into(),
                Alert {
                    id: "navidrome:down".into(),
                    severity: "critical",
                    title: "Navidrome injoignable".into(),
                    detail: "La dernière vérification a échoué.".into(),
                    since: now,
                },
            );
        }

        let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let mut newly_resolved: Vec<Alert> = guard
            .iter()
            .filter(|(id, _)| !desired.contains_key(*id))
            .map(|(_, alert)| alert.clone())
            .collect();

        let mut newly_raised = Vec::new();
        for (id, alert) in &mut desired {
            if let Some(prev) = guard.get(id) {
                alert.since = prev.since;
            } else {
                newly_raised.push(alert.clone());
            }
        }
        *guard = desired;
        drop(guard);

        sort_alerts(&mut newly_raised);
        sort_alerts(&mut newly_resolved);
        (newly_raised, newly_resolved)
    }

    /// Returns currently active alerts, sorted critical-first, then `since`, then `id`.
    pub fn active(&self) -> Vec<Alert> {
        let mut list: Vec<Alert> = self.active.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        sort_alerts(&mut list);
        list
    }

    /// Starts the periodic 30 s alert evaluation and webhook notification loop.
    pub fn spawn(
        self: &Arc<Self>,
        snap_fn: impl Fn() -> Value + Send + Sync + 'static,
        navidrome_ok: impl Fn() -> Option<bool> + Send + Sync + 'static,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            if *shutdown.borrow() {
                return;
            }
            let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().ok();
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(EVAL_INTERVAL) => {}
                    _ = shutdown.changed() => return,
                }
                let snap = snap_fn();
                let nav = navidrome_ok();
                let (raised, resolved) = me.evaluate(&snap, nav, unix_now());
                if raised.is_empty() && resolved.is_empty() {
                    continue;
                }
                if let (Some(url), Some(http)) = (&me.cfg.webhook_url, &client) {
                    let text = format_webhook_message(&raised, &resolved);
                    if let Err(err) = send_webhook(http, url, text).await {
                        tracing::warn!(%err, "alert webhook failed");
                    }
                }
            }
        });
    }
}

fn severity_rank(s: &str) -> u8 {
    if s == "critical" { 0 } else { 1 }
}

fn sort_alerts(alerts: &mut [Alert]) {
    alerts.sort_by(|a, b| {
        (severity_rank(a.severity), a.since, &a.id).cmp(&(severity_rank(b.severity), b.since, &b.id))
    });
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn format_webhook_message(raised: &[Alert], resolved: &[Alert]) -> String {
    let mut lines = Vec::with_capacity(raised.len() + resolved.len());
    for a in raised {
        let tag = if a.severity == "critical" { "CRITIQUE" } else { "ALERTE" };
        lines.push(format!("[{tag}] {} — {}", a.title, a.detail));
    }
    for a in resolved {
        lines.push(format!("[RÉSOLU] {}", a.title));
    }
    lines.join("\n")
}

async fn send_webhook(client: &reqwest::Client, url: &str, text: String) -> Result<(), String> {
    let is_discord = url.contains("discord.com/api/webhooks") || url.contains("discordapp.com/api/webhooks");
    let req = if is_discord {
        let body = serde_json::to_vec(&json!({"content": text})).map_err(|e| format!("encode json: {e}"))?;
        client.post(url).header("Content-Type", "application/json").body(body)
    } else {
        client.post(url).header("Title", "SelfHost Hub").body(text)
    };
    let resp = req.send().await.map_err(|e| e.without_url().to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_all_sources_preserves_since_and_resolves() {
        let engine = AlertEngine::new(AlertConfig::default());
        let snap = json!({
            "disks": { "items": [
                { "mountpoint": "/", "percent": 91.5 },
                { "mountpoint": "/data", "percent": 96.2 },
                { "mountpoint": "/boot", "percent": 40.0 }
            ]},
            "temps": { "max": 96.0 },
            "containers": { "items": [
                { "name": "navidrome", "state": "running", "status": "Up 2 hours" },
                { "name": "downtify", "state": "exited", "status": "Exited (1) 3m ago" }
            ]}
        });

        let (raised, resolved) = engine.evaluate(&snap, Some(false), 100);
        assert!(resolved.is_empty());
        assert_eq!(raised.len(), 5);

        let active = engine.active();
        assert_eq!(active.len(), 5);
        assert_eq!(active[0].id, "disk:/data");
        assert_eq!(active[0].severity, "critical");
        assert_eq!(active[1].id, "navidrome:down");
        assert_eq!(active[1].severity, "critical");
        assert_eq!(active[2].id, "temp:max");
        assert_eq!(active[2].severity, "critical");
        assert_eq!(active[3].id, "container:downtify");
        assert_eq!(active[3].severity, "warn");
        assert_eq!(active[4].id, "disk:/");
        assert_eq!(active[4].severity, "warn");

        // Re-evaluating later preserves `since = 100` for ongoing alerts and resolves cleared ones.
        let snap2 = json!({
            "disks": { "items": [{ "mountpoint": "/data", "percent": 97.0 }] },
            "temps": { "max": 70.0 },
            "containers": { "items": [{ "name": "downtify", "state": "running", "status": "Up 1s" }] }
        });
        let (raised2, resolved2) = engine.evaluate(&snap2, Some(true), 250);
        assert!(raised2.is_empty());
        assert_eq!(resolved2.len(), 4);

        let active2 = engine.active();
        assert_eq!(active2.len(), 1);
        assert_eq!(active2[0].id, "disk:/data");
        assert_eq!(active2[0].since, 100);
        assert_eq!(active2[0].detail, "97.0 % utilisés");

        // Recovery clears the last alert.
        let (raised3, resolved3) = engine.evaluate(&json!({}), None, 300);
        assert!(raised3.is_empty());
        assert_eq!(resolved3.len(), 1);
        assert_eq!(resolved3[0].id, "disk:/data");
        assert!(engine.active().is_empty());
    }
}
