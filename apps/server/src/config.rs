use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
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
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

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
}