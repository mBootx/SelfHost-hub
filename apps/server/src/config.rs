use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub navidrome_url: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub server_name: String,
    pub trust_proxy: bool,
    pub host_proc: PathBuf,
    pub host_sys: PathBuf,
    pub host_root: Option<PathBuf>,
    pub docker_url: Option<String>,
    /// The admin terminal: None unless SHELL_ENABLED=true.
    pub shell: Option<crate::shell::ShellConfig>,
    /// The sign-in gate's cookie domain (GATE_DOMAIN): None leaves the gate off.
    pub gate_domain: Option<String>,
    /// Internal Downtify URL shown on the admin panel (`DOWNTIFY_URL`).
    pub downtify_url: Option<String>,
    /// Disk usage percentage threshold triggering an alert (`ALERT_DISK_PERCENT`).
    pub alert_disk_percent: f64,
    /// Temperature threshold in °C triggering an alert (`ALERT_TEMP_C`).
    pub alert_temp_c: f64,
    /// Optional webhook URL for alert notifications (`ALERT_WEBHOOK_URL`).
    pub alert_webhook_url: Option<String>,
    /// Number of scheduled SQLite backups to retain (`BACKUP_KEEP`, 0 disables).
    pub backup_keep: usize,
    /// Extra services shown on the sign-in gate page (`GATE_SERVICES`).
    pub gate_services: Vec<(String, String)>,
}

fn parse_f64_range(name: &str, raw: Option<String>, default: f64, min: f64, max: f64) -> Result<f64, String> {
    match raw {
        Some(s) => {
            let v: f64 = s.parse().map_err(|_| format!("{name} is not a valid number: {s}"))?;
            if !v.is_finite() || !(min..=max).contains(&v) {
                return Err(format!("{name} must be between {min} and {max}: {s}"));
            }
            Ok(v)
        }
        None => Ok(default),
    }
}

fn is_http_url(u: &str) -> bool {
    u.starts_with("http://") || u.starts_with("https://")
}

impl Config {
    /// Loads configuration from process environment variables.
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Loads configuration from an arbitrary variable lookup function.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let non_empty = |k: &str| get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let navidrome_url = non_empty("NAVIDROME_URL")
            .ok_or("NAVIDROME_URL is required (for example http://navidrome:4533)")?;
        let port = match non_empty("PORT") {
            Some(p) => p.parse().map_err(|_| format!("PORT is not a valid port: {p}"))?,
            None => 51823,
        };
        let trust_proxy = non_empty("TRUST_PROXY")
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "true" | "1" | "yes"));
        let truthy = |k: &str| non_empty(k).is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "true" | "1" | "yes"));
        let shell = if truthy("SHELL_ENABLED") {
            let port = match non_empty("SHELL_SSH_PORT") {
                Some(p) => p.parse().map_err(|_| format!("SHELL_SSH_PORT is not a valid port: {p}"))?,
                None => 22,
            };
            Some(crate::shell::ShellConfig {
                host: non_empty("SHELL_SSH_HOST").unwrap_or_else(|| "host.docker.internal".into()),
                port,
                user: non_empty("SHELL_SSH_USER").ok_or("SHELL_SSH_USER is required when SHELL_ENABLED=true")?,
            })
        } else {
            None
        };
        let downtify_url = match non_empty("DOWNTIFY_URL") {
            Some(raw) => {
                let u = raw.trim_end_matches('/').to_string();
                if !is_http_url(&u) {
                    return Err(format!("DOWNTIFY_URL must start with http:// or https://: {raw}"));
                }
                Some(u)
            }
            None => None,
        };
        let alert_disk_percent = parse_f64_range("ALERT_DISK_PERCENT", non_empty("ALERT_DISK_PERCENT"), 90.0, 1.0, 100.0)?;
        let alert_temp_c = parse_f64_range("ALERT_TEMP_C", non_empty("ALERT_TEMP_C"), 85.0, 10.0, 150.0)?;
        let alert_webhook_url = match non_empty("ALERT_WEBHOOK_URL") {
            Some(u) if is_http_url(&u) => Some(u),
            Some(u) => return Err(format!("ALERT_WEBHOOK_URL must start with http:// or https://: {u}")),
            None => None,
        };
        let backup_keep = match non_empty("BACKUP_KEEP") {
            Some(raw) => raw.parse().map_err(|_| format!("BACKUP_KEEP is not a valid integer: {raw}"))?,
            None => 7,
        };
        let mut gate_services = Vec::new();
        if let Some(raw) = non_empty("GATE_SERVICES") {
            for item in raw.split(',') {
                let item = item.trim();
                let Some((label, url)) = item.split_once('=') else {
                    return Err(format!("GATE_SERVICES entry must be Label=URL: {item}"));
                };
                let (label, url) = (label.trim(), url.trim());
                if label.is_empty() {
                    return Err(format!("GATE_SERVICES entry has an empty label: {item}"));
                }
                if !is_http_url(url) {
                    return Err(format!("GATE_SERVICES URL must start with http:// or https://: {url}"));
                }
                gate_services.push((label.to_string(), url.to_string()));
            }
        }
        Ok(Self {
            navidrome_url,
            port,
            data_dir: non_empty("DATA_DIR").unwrap_or_else(|| "/data".into()).into(),
            server_name: non_empty("SERVER_NAME").unwrap_or_else(|| "SelfHost Hub".into()),
            trust_proxy,
            host_proc: non_empty("HOST_PROC").unwrap_or_else(|| "/proc".into()).into(),
            host_sys: non_empty("HOST_SYS").unwrap_or_else(|| "/sys".into()).into(),
            host_root: non_empty("HOST_ROOT").map(PathBuf::from),
            docker_url: non_empty("DOCKER_URL"),
            shell,
            gate_domain: match non_empty("GATE_DOMAIN") {
                Some(raw) => {
                    let mut domains = Vec::new();
                    for part in raw.split(',') {
                        let d = part.trim().trim_start_matches('.').to_ascii_lowercase();
                        if !(d.contains('.') && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')) {
                            return Err(format!("GATE_DOMAIN is not a domain name: {d}"));
                        }
                        domains.push(d);
                    }
                    Some(domains.join(","))
                }
                None => None,
            },
            downtify_url,
            alert_disk_percent,
            alert_temp_c,
            alert_webhook_url,
            backup_keep,
            gate_services,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_navidrome_url() {
        assert!(Config::from_lookup(|_| None).is_err());
    }

    #[test]
    fn defaults_and_overrides() {
        let c = Config::from_lookup(|k| (k == "NAVIDROME_URL").then(|| "http://n:4533".into())).unwrap();
        assert_eq!(c.port, 51823);
        assert_eq!(c.server_name, "SelfHost Hub");
        assert!(!c.trust_proxy);
        assert_eq!((c.host_proc.as_path(), c.host_sys.as_path()), ("/proc".as_ref(), "/sys".as_ref()));
        assert_eq!((c.host_root.clone(), c.docker_url.clone()), (None, None));
        assert_eq!(c.shell, None);
        assert_eq!(c.gate_domain, None);
        let gate = |d: &'static str| Config::from_lookup(move |k| match k {
            "NAVIDROME_URL" => Some("http://n".into()),
            "GATE_DOMAIN" => Some(d.into()),
            _ => None,
        });
        assert_eq!(gate(".GoofySound.duckdns.org").unwrap().gate_domain.as_deref(), Some("goofysound.duckdns.org"));
        assert_eq!(
            gate(".GoofySound.duckdns.org, goofydownloader.duckdns.org").unwrap().gate_domain.as_deref(),
            Some("goofysound.duckdns.org,goofydownloader.duckdns.org")
        );
        assert!(gate("localhost").is_err() && gate("a.b; Path=/").is_err() && gate("a.com,").is_err());
        let c = Config::from_lookup(|k| match k {
            "NAVIDROME_URL" => Some("http://n".into()),
            "PORT" => Some("8080".into()),
            "TRUST_PROXY" => Some("true".into()),
            "HOST_PROC" => Some("/host/proc".into()),
            "HOST_ROOT" => Some("/hostfs".into()),
            "DOCKER_URL" => Some("http://docker-proxy:2375".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(c.port, 8080);
        assert!(c.trust_proxy);
        assert_eq!(c.host_proc, PathBuf::from("/host/proc"));
        assert_eq!(c.host_root, Some(PathBuf::from("/hostfs")));
        assert_eq!(c.docker_url.as_deref(), Some("http://docker-proxy:2375"));
    }

    #[test]
    fn shell_settings() {
        let get = |extra: &'static [(&'static str, &'static str)]| {
            Config::from_lookup(move |k| {
                if k == "NAVIDROME_URL" {
                    return Some("http://n".into());
                }
                extra.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
            })
        };
        assert_eq!(get(&[("SHELL_ENABLED", "false"), ("SHELL_SSH_USER", "max")]).unwrap().shell, None);
        assert!(get(&[("SHELL_ENABLED", "true")]).is_err());
        assert!(get(&[("SHELL_ENABLED", "true"), ("SHELL_SSH_USER", "max"), ("SHELL_SSH_PORT", "x")]).is_err());
        let s = get(&[("SHELL_ENABLED", "true"), ("SHELL_SSH_USER", "max")]).unwrap().shell.unwrap();
        assert_eq!((s.host.as_str(), s.port, s.user.as_str()), ("host.docker.internal", 22, "max"));
        let s = get(&[("SHELL_ENABLED", "1"), ("SHELL_SSH_USER", "max"), ("SHELL_SSH_HOST", "10.0.0.1"), ("SHELL_SSH_PORT", "2222")])
            .unwrap()
            .shell
            .unwrap();
        assert_eq!((s.host.as_str(), s.port), ("10.0.0.1", 2222));
    }

    #[test]
    fn phase1_settings_defaults_overrides_and_validation() {
        let get = |extra: &[(&str, &str)]| {
            Config::from_lookup(|k| {
                if k == "NAVIDROME_URL" {
                    return Some("http://n".into());
                }
                extra.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_string())
            })
        };

        let def = get(&[]).unwrap();
        assert_eq!(def.downtify_url, None);
        assert_eq!(def.alert_disk_percent, 90.0);
        assert_eq!(def.alert_temp_c, 85.0);
        assert_eq!(def.alert_webhook_url, None);
        assert_eq!(def.backup_keep, 7);
        assert!(def.gate_services.is_empty());

        let ok = get(&[
            ("DOWNTIFY_URL", " https://dl.example.com/// "),
            ("ALERT_DISK_PERCENT", "75.5"),
            ("ALERT_TEMP_C", "70"),
            ("ALERT_WEBHOOK_URL", " https://ntfy.sh/hub "),
            ("BACKUP_KEEP", "0"),
            ("GATE_SERVICES", "Downtify = https://dl.example.com/a?x=1 , Logs=http://10.0.0.2:8080"),
        ])
        .unwrap();
        assert_eq!(ok.downtify_url.as_deref(), Some("https://dl.example.com"));
        assert_eq!(ok.alert_disk_percent, 75.5);
        assert_eq!(ok.alert_temp_c, 70.0);
        assert_eq!(ok.alert_webhook_url.as_deref(), Some("https://ntfy.sh/hub"));
        assert_eq!(ok.backup_keep, 0);
        assert_eq!(
            ok.gate_services,
            vec![
                ("Downtify".into(), "https://dl.example.com/a?x=1".into()),
                ("Logs".into(), "http://10.0.0.2:8080".into()),
            ]
        );
        assert!(get(&[("GATE_SERVICES", "   ")]).unwrap().gate_services.is_empty());

        for bad in [
            ("DOWNTIFY_URL", "ftp://dl"),
            ("DOWNTIFY_URL", "http://"),
            ("ALERT_DISK_PERCENT", "0.5"),
            ("ALERT_DISK_PERCENT", "101"),
            ("ALERT_DISK_PERCENT", "NaN"),
            ("ALERT_DISK_PERCENT", "abc"),
            ("ALERT_TEMP_C", "9.9"),
            ("ALERT_TEMP_C", "151"),
            ("ALERT_TEMP_C", "inf"),
            ("ALERT_WEBHOOK_URL", "not-a-url"),
            ("BACKUP_KEEP", "-1"),
            ("BACKUP_KEEP", "many"),
            ("GATE_SERVICES", "NoEquals"),
            ("GATE_SERVICES", "=https://a.com"),
            ("GATE_SERVICES", "App=ftp://a.com"),
            ("GATE_SERVICES", "App=https://a.com,"),
        ] {
            assert!(get(&[bad]).is_err(), "expected error for {bad:?}");
        }
    }
}