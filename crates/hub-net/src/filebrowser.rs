//! Client for FileBrowser Quantum (github.com/gtsteffaniak/filebrowser), 1.3 and later, with the older routes as
//! fallbacks.
//!
//! Port of `mobile/src/services/filebrowser.ts` (itself ported from the desktop's). Login is cookie/JWT based: the
//! token comes back in a `Set-Cookie` header and is then sent as `Authorization: Bearer`, never in an address.
//! Every resource call names a "source", since Quantum can serve several storage backends.
//!
//! Big uploads and downloads stream through the apps' own code, with the addresses and rules given here
//! ([`FileBrowserClient::upload_url`], [`upload_result`], [`FileBrowserClient::download_url`]...).

use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

use hub_core::home_network::is_home_host;
use hub_core::paths::{base_name, join_path, normalize_path};
use hub_core::vault;
use serde_json::{Map, Value, json};

use crate::transport::{Method, Reply, Request, Transport};
use crate::url;

const JWT_COOKIE_NAME: &str = "filebrowser_quantum_jwt";
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileBrowserConfig {
    pub url: String,
    pub username: String,
    pub password: String,
}

/// What went wrong. `status` is the HTTP status, or 0 when the server did not answer at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileBrowserError {
    pub message: String,
    pub status: u16,
}

impl FileBrowserError {
    fn new(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }

    /// The session has lapsed or the login was refused: only these should sign the user out.
    pub fn is_auth_failure(&self) -> bool {
        matches!(self.status, 401 | 403)
    }
}

impl fmt::Display for FileBrowserError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FileBrowserError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FbItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: String,
    /// The server's type: "directory", a MIME type...
    pub kind: Option<String>,
    /// Whether the server can make a thumbnail (false for a video when ffmpeg is not installed there).
    pub has_preview: Option<bool>,
    /// The item already has a share link.
    pub is_shared: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareUnit {
    Minutes,
    Hours,
    Days,
}

impl ShareUnit {
    fn wire(self) -> &'static str {
        match self {
            Self::Minutes => "minutes",
            Self::Hours => "hours",
            Self::Days => "days",
        }
    }
}

/// How long a share link lasts; `None` where one is taken means for ever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShareDuration {
    pub value: u32,
    pub unit: ShareUnit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLink {
    pub hash: String,
    /// The page that opens the share in a browser, on the address the app uses.
    pub url: String,
    /// The file itself, with the token that lets a password-protected share through.
    pub download_url: String,
    pub path: String,
    /// When the link stops working (ms since the epoch), or `None` if it never does.
    pub expires_at: Option<u64>,
    pub has_password: bool,
    /// Who made it; only the server's list says.
    pub username: Option<String>,
    pub path_exists: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
    pub kind: Option<String>,
    pub has_preview: Option<bool>,
}

/// What a request on several files did for each of them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BatchResult {
    pub done: Vec<String>,
    /// Each path that failed, with the server's reason.
    pub failed: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceUsage {
    pub name: String,
    pub used: u64,
    pub total: u64,
    pub used_percentage: u32,
    pub num_files: u64,
    pub num_dirs: u64,
    pub status: String,
}

/// Which thumbnail route answered last: FileBrowser 1.3 and later, or the old one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewRoute {
    Current,
    Legacy,
}

#[derive(Debug)]
struct Session {
    token: Option<String>,
    source: Option<String>,
    /// The account's name as the server spells it; what was typed at login may differ in case.
    account_name: Option<String>,
    preview_route: PreviewRoute,
}

pub struct FileBrowserClient<T: Transport> {
    transport: T,
    base_url: String,
    username: String,
    password: String,
    /// Identifies this app run to the server's search, which keeps results per session.
    session_id: String,
    session: Mutex<Session>,
}

impl<T: Transport> FileBrowserClient<T> {
    pub fn new(transport: T, config: FileBrowserConfig) -> Self {
        let mut id = [0u8; 8];
        getrandom::fill(&mut id).expect("the operating system's random generator is unavailable");
        Self {
            transport,
            base_url: config.url.trim_end_matches('/').to_owned(),
            username: config.username,
            password: config.password,
            session_id: id.iter().map(|b| format!("{b:02x}")).collect(),
            session: Mutex::new(Session {
                token: None,
                source: None,
                account_name: None,
                preview_route: PreviewRoute::Current,
            }),
        }
    }

    pub fn source_name(&self) -> Option<String> {
        self.session.lock().unwrap().source.clone()
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    /// The name the server knows this account by: what the account's backup folder is named after.
    pub fn account_name(&self) -> String {
        self.session
            .lock()
            .unwrap()
            .account_name
            .clone()
            .unwrap_or_else(|| self.username.clone())
    }

    /// What every signed-in request, image and video sends instead of the login in the address: an address ends
    /// up in the server's and the proxy's logs, and in the clipboard when someone copies it.
    pub fn auth_headers(&self) -> Vec<(String, String)> {
        self.session
            .lock()
            .unwrap()
            .token
            .as_ref()
            .map(|t| vec![("Authorization".to_owned(), format!("Bearer {t}"))])
            .unwrap_or_default()
    }

    pub async fn login(&self) -> Result<(), FileBrowserError> {
        let address = format!(
            "{}/api/auth/login?{}",
            self.base_url,
            url::query(&[("username", &self.username), ("recaptcha", "")])
        );
        let reply = self
            .send(
                Request::new(Method::Post, address)
                    .header("X-Password", url::encode_uri_component(&self.password))
                    .header("X-Secret", ""),
            )
            .await?;
        if !reply.is_success() {
            // Unreachable is not the same as rejected: callers sign out only on a real 401 or 403.
            let mut message =
                matches!(reply.status, 401 | 403).then(|| "Identifiants invalides".to_owned());
            if let Some(server) = data(&reply)
                .get("message")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
            {
                message = Some(server.to_owned());
            }
            let status = if reply.status == 0 { 401 } else { reply.status };
            return Err(FileBrowserError::new(
                message.unwrap_or_else(|| "Connexion échouée".into()),
                status,
            ));
        }
        let token = reply
            .headers_named("set-cookie")
            .find_map(|cookie| cookie_value(cookie, JWT_COOKIE_NAME))
            .ok_or_else(|| {
                FileBrowserError::new(
                    "Session introuvable dans la réponse du serveur (l'authentification à deux facteurs n'est pas gérée)",
                    500,
                )
            })?;
        self.session.lock().unwrap().token = Some(token);
        self.resolve_source().await;
        Ok(())
    }

    /// The account's own name and the storage source it may use: the first of its scopes, else the first
    /// source the server lists, else "default".
    async fn resolve_source(&self) {
        let me = self
            .get(&format!("{}/api/users?id=self", self.base_url))
            .await;
        if let Ok(reply) = &me
            && reply.is_success()
        {
            let me = data(reply);
            if let Some(name) = me
                .get("username")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
            {
                self.session.lock().unwrap().account_name = Some(name.to_owned());
            }
            if let Some(scope) = me
                .get("scopes")
                .and_then(Value::as_array)
                .and_then(|s| s.first())
            {
                self.session.lock().unwrap().source =
                    scope.get("name").and_then(Value::as_str).map(Into::into);
                return;
            }
        }
        let sources = self.get(&format!("{}/api/sources", self.base_url)).await;
        if let Ok(reply) = &sources
            && reply.is_success()
            && let Some(first) = data(reply).as_array().and_then(|s| s.first().cloned())
        {
            self.session.lock().unwrap().source =
                first.get("name").and_then(Value::as_str).map(Into::into);
            return;
        }
        self.session.lock().unwrap().source = Some("default".into());
    }

    /// The status the server gives a signed-in request: 0 when it does not answer at all, 401 or 403 when the
    /// session has lapsed.
    pub async fn probe(&self) -> u16 {
        let request = Request::new(Method::Get, format!("{}/api/users?id=self", self.base_url))
            .headers(self.auth_headers())
            .timeout(PROBE_TIMEOUT);
        self.send(request).await.map_or(0, |r| r.status)
    }

    /// Whether the server answers at all (anything below 500): tells a dead connection from a refused file.
    pub async fn is_reachable(&self) -> bool {
        let status = self.probe().await;
        status > 0 && status < 500
    }

    pub async fn list(&self, path: &str) -> Result<Vec<FbItem>, FileBrowserError> {
        let source = self.source();
        let reply = self
            .get(&format!(
                "{}/api/resources?{}",
                self.base_url,
                url::query(&[("path", path), ("source", &source)])
            ))
            .await?;
        if reply.status == 401 {
            return Err(FileBrowserError::new("Session expirée", 401));
        }
        if !reply.is_success() {
            return Err(FileBrowserError::new(
                "Impossible de lister le dossier",
                reply.status,
            ));
        }
        let listing = data(&reply);
        let entries = |key: &str, is_dir: bool| -> Vec<(Map<String, Value>, bool)> {
            listing
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|i| i.as_object().cloned())
                        .map(|o| (o, is_dir))
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok(entries("folders", true)
            .into_iter()
            .chain(entries("files", false))
            .map(|(item, folder)| {
                let name = text(&item, "name").unwrap_or_default();
                let kind = item.get("type").and_then(Value::as_str).map(str::to_owned);
                FbItem {
                    path: join_path(path, &name),
                    size: number(item.get("size")),
                    is_dir: folder
                        || item.get("isDir").and_then(Value::as_bool).unwrap_or(false)
                        || kind.as_deref() == Some("directory"),
                    modified: text(&item, "modified")
                        .filter(|m| !m.is_empty())
                        .or_else(|| text(&item, "mtime"))
                        .unwrap_or_default(),
                    has_preview: item.get("hasPreview").and_then(Value::as_bool),
                    is_shared: item.get("isShared") == Some(&Value::Bool(true)),
                    kind,
                    name,
                }
            })
            .collect())
    }

    /// The address of a file's content, for viewing. It carries no login: send [`Self::auth_headers`] with it.
    pub fn raw_url(&self, path: &str) -> String {
        let source = self.source();
        format!(
            "{}/api/resources/download?{}",
            self.base_url,
            url::query(&[("source", &source), ("file", path), ("inline", "true")])
        )
    }

    /// The address of a file to download (no login in it).
    pub fn download_url(&self, path: &str) -> String {
        let source = self.source();
        format!(
            "{}/api/resources/download?{}",
            self.base_url,
            url::query(&[("source", &source), ("file", path)])
        )
    }

    /// The address of several files and folders as one zip (no login in it).
    pub fn archive_url(&self, paths: &[&str]) -> String {
        let source = self.source();
        let mut params: Vec<(&str, &str)> = vec![("source", &source), ("algo", "zip")];
        params.extend(paths.iter().map(|p| ("file", *p)));
        format!(
            "{}/api/resources/download?{}",
            self.base_url,
            url::query(&params)
        )
    }

    /// Addresses of the server-made thumbnail, best guess first: FileBrowser 1.3 and later serve it at
    /// `/api/resources/preview`, older ones at `/api/preview`. Callers try them in turn, then fall back to
    /// [`Self::raw_url`], and tell [`Self::note_preview_worked`] which one answered.
    pub fn preview_urls(&self, path: &str, large: bool) -> [String; 2] {
        let source = self.source();
        let size = if large { "large" } else { "small" };
        let query = url::query(&[
            ("source", &source),
            ("path", path),
            ("size", size),
            ("inline", "true"),
        ]);
        let current = format!("{}/api/resources/preview?{query}", self.base_url);
        let legacy = format!("{}/api/preview?{query}", self.base_url);
        match self.session.lock().unwrap().preview_route {
            PreviewRoute::Current => [current, legacy],
            PreviewRoute::Legacy => [legacy, current],
        }
    }

    pub fn note_preview_worked(&self, address: &str) {
        self.session.lock().unwrap().preview_route = if address.contains("/api/resources/preview") {
            PreviewRoute::Current
        } else {
            PreviewRoute::Legacy
        };
    }

    /// Where to POST a file's bytes. A file of the same name is left alone and answered with a 409 unless
    /// `replace` says otherwise: nothing is overwritten by accident. Check the answer with [`upload_result`].
    pub fn upload_url(&self, dest_dir: &str, filename: &str, replace: bool) -> String {
        let source = self.source();
        format!(
            "{}/api/resources?{}",
            self.base_url,
            url::query(&[
                ("path", &join_path(dest_dir, filename)),
                ("source", &source),
                ("override", if replace { "true" } else { "false" }),
            ])
        )
    }

    /// Deletes several files or folders in one request; the server reports each one it could not delete.
    pub async fn remove_many(&self, paths: &[&str]) -> Result<BatchResult, FileBrowserError> {
        if paths.is_empty() {
            return Ok(BatchResult::default());
        }
        let source = self.source_value();
        let items: Vec<Value> = paths
            .iter()
            .map(|p| json!({ "source": source, "path": p }))
            .collect();
        let reply = self
            .send(
                Request::new(
                    Method::Delete,
                    format!("{}/api/resources/bulk", self.base_url),
                )
                .headers(self.auth_headers())
                .json(&Value::Array(items)),
            )
            .await?;
        batch_outcome(&reply, paths, "Suppression impossible")
    }

    pub async fn remove(&self, path: &str) -> Result<(), FileBrowserError> {
        let result = self.remove_many(&[path]).await?;
        match result.failed.into_iter().next() {
            Some((_, message)) => Err(FileBrowserError::new(message, 500)),
            None => Ok(()),
        }
    }

    /// Moves files or folders into another folder, keeping their names; nothing at the destination is overwritten.
    pub async fn move_items(
        &self,
        paths: &[&str],
        dest_dir: &str,
    ) -> Result<BatchResult, FileBrowserError> {
        if paths.is_empty() {
            return Ok(BatchResult::default());
        }
        let moves: Vec<(String, String)> = paths
            .iter()
            .map(|p| ((*p).to_owned(), join_path(dest_dir, base_name(p))))
            .collect();
        let reply = self.send_moves(&moves).await?;
        batch_outcome(&reply, paths, "Déplacement impossible")
    }

    pub async fn rename(&self, path: &str, new_path: &str) -> Result<(), FileBrowserError> {
        let reply = self
            .send_moves(&[(path.to_owned(), new_path.to_owned())])
            .await?;
        let result = batch_outcome(&reply, &[path], "Renommage impossible")?;
        match result.failed.into_iter().next() {
            Some((_, message)) => Err(FileBrowserError::new(
                message,
                if reply.status == 0 { 500 } else { reply.status },
            )),
            None => Ok(()),
        }
    }

    async fn send_moves(&self, moves: &[(String, String)]) -> Result<Reply, FileBrowserError> {
        let source = self.source_value();
        let items: Vec<Value> = moves
            .iter()
            .map(|(from, to)| json!({ "fromSource": source, "fromPath": from, "toSource": source, "toPath": to }))
            .collect();
        let body = json!({ "items": items, "action": "move", "overwrite": false, "rename": false });
        self.send(
            Request::new(Method::Patch, format!("{}/api/resources", self.base_url))
                .headers(self.auth_headers())
                .json(&body),
        )
        .await
    }

    /// Makes a link anyone can open without an account. It points at this server through the address the app
    /// uses, whatever the server believes its own address to be behind a reverse proxy.
    pub async fn create_share(
        &self,
        path: &str,
        duration: Option<ShareDuration>,
        password: Option<&str>,
    ) -> Result<ShareLink, FileBrowserError> {
        let mut body = Map::new();
        body.insert("path".into(), path.into());
        body.insert("source".into(), self.source_value());
        if let Some(d) = duration {
            body.insert("expires".into(), d.value.to_string().into());
            body.insert("unit".into(), d.unit.wire().into());
        }
        if let Some(password) = password.filter(|p| !p.is_empty()) {
            body.insert("password".into(), password.into());
        }
        let reply = self
            .send(
                Request::new(Method::Post, format!("{}/api/share", self.base_url))
                    .headers(self.auth_headers())
                    .json(&Value::Object(body)),
            )
            .await?;
        let raw = data(&reply);
        if !reply.is_success() || !raw.get("hash").is_some_and(Value::is_string) {
            if reply.status == 403 {
                return Err(FileBrowserError::new(
                    "Ce compte n'a pas le droit de partager des fichiers",
                    403,
                ));
            }
            return Err(FileBrowserError::new(
                message_of(&reply).unwrap_or_else(|| "Création du lien impossible".into()),
                nonzero(reply.status),
            ));
        }
        Ok(self.share_link(&raw))
    }

    /// The share links of this account (all of them for an administrator), newest first.
    pub async fn list_shares(&self) -> Result<Vec<ShareLink>, FileBrowserError> {
        let mut reply = self
            .get(&format!("{}/api/share/list", self.base_url))
            .await?;
        // Before FileBrowser 1.3 the list lived at /api/shares.
        if reply.status == 404 {
            reply = self.get(&format!("{}/api/shares", self.base_url)).await?;
        }
        let raw = data(&reply);
        let (true, Some(list)) = (reply.is_success(), raw.as_array()) else {
            return Err(FileBrowserError::new(
                message_of(&reply).unwrap_or_else(|| "Impossible de lister les liens".into()),
                nonzero(reply.status),
            ));
        };
        Ok(list
            .iter()
            .filter(|s| s.get("hash").is_some_and(Value::is_string))
            .map(|s| self.share_link(s))
            .rev()
            .collect())
    }

    pub async fn delete_share(&self, hash: &str) -> Result<(), FileBrowserError> {
        let reply = self
            .send(
                Request::new(
                    Method::Delete,
                    format!(
                        "{}/api/share?{}",
                        self.base_url,
                        url::query(&[("hash", hash)])
                    ),
                )
                .headers(self.auth_headers()),
            )
            .await?;
        if !reply.is_success() {
            return Err(FileBrowserError::new(
                message_of(&reply).unwrap_or_else(|| "Suppression du lien impossible".into()),
                reply.status,
            ));
        }
        Ok(())
    }

    fn share_link(&self, raw: &Value) -> ShareLink {
        let hash = raw
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let has_password = raw.get("hasPassword") == Some(&Value::Bool(true));
        let token = raw
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| has_password && !t.is_empty())
            .map(|t| format!("&token={}", url::encode_uri_component(t)))
            .unwrap_or_default();
        let expire = number_f64(raw.get("expire"));
        ShareLink {
            url: format!("{}/public/share/{hash}", self.base_url),
            download_url: format!(
                "{}/public/api/resources/download?hash={}{token}",
                self.base_url,
                url::encode_uri_component(&hash)
            ),
            path: raw.get("path").map(lenient_text).unwrap_or_default(),
            expires_at: (expire > 0.0).then_some((expire * 1000.0) as u64),
            has_password,
            username: raw.get("username").and_then(Value::as_str).map(Into::into),
            path_exists: raw.get("pathExists").and_then(Value::as_bool),
            hash,
        }
    }

    /// Looks for files and folders by name under `scope`. Only what the server has indexed turns up.
    pub async fn search(
        &self,
        query: &str,
        scope: &str,
    ) -> Result<Vec<SearchHit>, FileBrowserError> {
        let source = self.source();
        let params = url::query(&[("query", query), ("source", &source), ("scope", scope)]);
        let search = |route: &str| {
            Request::new(Method::Get, format!("{}{route}?{params}", self.base_url))
                .headers(self.auth_headers())
                .header("SessionId", self.session_id.clone())
        };
        let mut reply = self.send(search("/api/tools/search")).await?;
        // Before FileBrowser 1.3 the search lived at /api/search.
        if reply.status == 404 {
            reply = self.send(search("/api/search")).await?;
        }
        let raw = data(&reply);
        let (true, Some(hits)) = (reply.is_success(), raw.as_array()) else {
            return Err(FileBrowserError::new(
                message_of(&reply).unwrap_or_else(|| "Recherche impossible".into()),
                nonzero(reply.status),
            ));
        };
        Ok(hits
            .iter()
            .filter_map(|hit| {
                let found = hit.get("path")?.as_str()?;
                let kind = hit.get("type").and_then(Value::as_str).map(str::to_owned);
                let path = normalize_path(&format!("/{found}"));
                Some(SearchHit {
                    name: base_name(&path).to_owned(),
                    is_dir: kind.as_deref() == Some("directory") || found.ends_with('/'),
                    size: number(hit.get("size")),
                    modified: hit.get("modified").map(lenient_text).unwrap_or_default(),
                    has_preview: hit.get("hasPreview").and_then(Value::as_bool),
                    kind,
                    path,
                })
            })
            .collect())
    }

    pub async fn create_folder(&self, path: &str) -> Result<(), FileBrowserError> {
        let source = self.source();
        let address = format!(
            "{}/api/resources?{}",
            self.base_url,
            url::query(&[
                ("path", &normalize_path(path)),
                ("source", &source),
                ("isDir", "true")
            ])
        );
        let reply = self
            .send(Request::new(Method::Post, address).headers(self.auth_headers()))
            .await?;
        if !reply.is_success() {
            return Err(FileBrowserError::new(
                "Création du dossier impossible",
                reply.status,
            ));
        }
        Ok(())
    }

    pub async fn sources_usage(&self) -> Result<Vec<SourceUsage>, FileBrowserError> {
        let reply = self
            .get(&format!("{}/api/settings/sources", self.base_url))
            .await?;
        if !reply.is_success() {
            return Err(FileBrowserError::new(
                "Impossible de récupérer l'espace disque",
                reply.status,
            ));
        }
        let Value::Object(sources) = data(&reply) else {
            return Ok(Vec::new());
        };
        Ok(sources
            .iter()
            .map(|(key, v)| {
                let total = number(v.get("total"));
                let used = number(v.get("used"));
                let named = |field: &str| {
                    v.get(field)
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                };
                SourceUsage {
                    name: named("name").unwrap_or(key).to_owned(),
                    used,
                    total,
                    used_percentage: if total == 0 {
                        0
                    } else {
                        (used as f64 / total as f64 * 100.0 + 0.5).floor() as u32
                    },
                    num_files: number(v.get("numFiles")),
                    num_dirs: number(v.get("numDirs")),
                    status: named("status").unwrap_or("unknown").to_owned(),
                }
            })
            .collect())
    }

    /// The usage of the source this account works in, else the first one listed.
    pub async fn current_source_usage(&self) -> Result<Option<SourceUsage>, FileBrowserError> {
        let all = self.sources_usage().await?;
        let source = self.source_name();
        let position = all
            .iter()
            .position(|s| Some(&s.name) == source.as_ref())
            .unwrap_or(0);
        Ok(all.into_iter().nth(position))
    }

    /// A text file's content, for its preview. Sent as the server stored it (the TypeScript apps re-wrote JSON
    /// files on one line).
    pub async fn text_preview(&self, path: &str) -> Result<String, FileBrowserError> {
        let reply = self.get(&self.raw_url(path)).await?;
        if !reply.is_success() {
            return Err(FileBrowserError::new("Aperçu impossible", reply.status));
        }
        Ok(reply.text())
    }

    fn source(&self) -> String {
        self.source_name().unwrap_or_default()
    }

    fn source_value(&self) -> Value {
        self.source_name().map_or(Value::Null, Value::String)
    }

    async fn get(&self, address: &str) -> Result<Reply, FileBrowserError> {
        self.send(Request::new(Method::Get, address).headers(self.auth_headers()))
            .await
    }

    async fn send(&self, request: Request) -> Result<Reply, FileBrowserError> {
        let home = url::host_of(&request.url).is_some_and(is_home_host);
        self.transport
            .send(request.home_network(home))
            .await
            .map_err(|e| FileBrowserError::new(e.0, 0))
    }
}

/// How an upload's answer reads: a 409 means a file of that name is already there and was left alone.
pub fn upload_result(status: u16) -> Result<(), FileBrowserError> {
    match status {
        200..=299 => Ok(()),
        409 => Err(FileBrowserError::new(
            "Un fichier du même nom existe déjà",
            409,
        )),
        0 => Err(FileBrowserError::new("Échec de l'envoi", 500)),
        other => Err(FileBrowserError::new("Échec de l'envoi", other)),
    }
}

/// Reads the answer to a request on several files. The server answers 200 when all went well, 207 when some did
/// not and 500 when none did, listing the failures with a reason: a 207 must not pass for success.
fn batch_outcome(
    reply: &Reply,
    paths: &[&str],
    fallback: &str,
) -> Result<BatchResult, FileBrowserError> {
    let raw = data(reply);
    let failed_list = raw.get("failed").and_then(Value::as_array);
    let all_done = || BatchResult {
        done: paths.iter().map(|p| (*p).to_owned()).collect(),
        failed: Vec::new(),
    };
    let failures = match failed_list {
        Some(list) if !list.is_empty() => list,
        _ if reply.is_success() => return Ok(all_done()),
        _ => {
            return Err(FileBrowserError::new(
                message_of(reply).unwrap_or_else(|| fallback.to_owned()),
                reply.status,
            ));
        }
    };
    let failed: Vec<(String, String)> = failures
        .iter()
        .map(|entry| {
            let path = entry
                .get("fromPath")
                .filter(|v| !v.is_null())
                .or_else(|| entry.get("path").filter(|v| !v.is_null()))
                .map(lenient_text)
                .unwrap_or_default();
            let message = entry
                .get("message")
                .map(lenient_text)
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| fallback.to_owned());
            (path, message)
        })
        .collect();
    // Every file failed, or the server named the ones that did.
    if failed.len() >= paths.len() {
        return Ok(BatchResult {
            done: Vec::new(),
            failed: paths
                .iter()
                .enumerate()
                .map(|(i, p)| ((*p).to_owned(), failed[i.min(failed.len() - 1)].1.clone()))
                .collect(),
        });
    }
    let failed_paths: Vec<String> = failed.iter().map(|(p, _)| normalize_path(p)).collect();
    Ok(BatchResult {
        done: paths
            .iter()
            .filter(|p| !failed_paths.contains(&normalize_path(p)))
            .map(|p| (*p).to_owned())
            .collect(),
        failed: failed
            .into_iter()
            .map(|(path, message)| {
                let asked = paths
                    .iter()
                    .find(|p| normalize_path(p) == normalize_path(&path))
                    .map_or(path, |p| (*p).to_owned());
                (asked, message)
            })
            .collect(),
    })
}

/// The body as the XMLHttpRequest of the TypeScript apps saw it: JSON when it is, else the text.
fn data(reply: &Reply) -> Value {
    reply.json().unwrap_or_else(|| {
        let text = reply.text();
        if text.is_empty() {
            Value::Null
        } else {
            Value::String(text)
        }
    })
}

/// What the server said went wrong, if it said anything readable.
fn message_of(reply: &Reply) -> Option<String> {
    match data(reply) {
        Value::Object(obj) => obj
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .map(Into::into),
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty() && text.len() < 200 && !trimmed.starts_with('<'))
                .then(|| trimmed.to_owned())
        }
        _ => None,
    }
}

/// The value of cookie `name` in one `Set-Cookie` header, decoded.
fn cookie_value(set_cookie: &str, name: &str) -> Option<String> {
    let start = set_cookie.find(&format!("{name}="))? + name.len() + 1;
    let value = set_cookie[start..].split(';').next().unwrap_or_default();
    (!value.is_empty()).then(|| url::decode_uri_component(value))
}

fn text(obj: &Map<String, Value>, name: &str) -> Option<String> {
    obj.get(name).and_then(Value::as_str).map(Into::into)
}

/// JavaScript's `String(value)` for the values a server sends.
fn lenient_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// JavaScript's `Number(value) || 0`, as a size or count.
fn number(value: Option<&Value>) -> u64 {
    let n = number_f64(value);
    if n > 0.0 { n as u64 } else { 0 }
}

fn number_f64(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// The status to report, 500 when there was none.
fn nonzero(status: u16) -> u16 {
    if status == 0 { 500 } else { status }
}

impl From<FileBrowserError> for vault::ClientError {
    fn from(err: FileBrowserError) -> Self {
        Self::new(err.status, err.message)
    }
}

impl From<FbItem> for vault::VaultItem {
    fn from(item: FbItem) -> Self {
        Self {
            name: item.name,
            size: item.size,
            is_dir: item.is_dir,
            modified: item.modified,
            has_preview: item.has_preview,
        }
    }
}

impl vault::ListedItem for FbItem {
    fn name(&self) -> &str {
        &self.name
    }

    fn is_dir(&self) -> bool {
        self.is_dir
    }
}

/// The photo vault reaches the account's backups through the signed-in client.
impl<T: Transport> vault::VaultClient for FileBrowserClient<T> {
    async fn list(&self, path: &str) -> Result<Vec<vault::VaultItem>, vault::ClientError> {
        let items = FileBrowserClient::list(self, path).await?;
        Ok(items.into_iter().map(vault::VaultItem::from).collect())
    }

    async fn remove(&self, path: &str) -> Result<(), vault::ClientError> {
        Ok(FileBrowserClient::remove(self, path).await?)
    }

    async fn rename(&self, path: &str, new_path: &str) -> Result<(), vault::ClientError> {
        Ok(FileBrowserClient::rename(self, path, new_path).await?)
    }

    async fn create_folder(&self, path: &str) -> Result<(), vault::ClientError> {
        Ok(FileBrowserClient::create_folder(self, path).await?)
    }
}

// Ported from mobile/tests/filebrowser.test.js. The download and upload tests there exercise expo-file-system
// tasks; here the addresses and the upload rule they used are tested instead.
#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::scripted::{Scripted, body, header, json as reply_json, query};
    use crate::subsonic::fake::block_on;

    const BASE: &str = "https://files.example";

    fn signed_in() -> (Arc<Scripted>, FileBrowserClient<Arc<Scripted>>) {
        let server = Arc::new(Scripted::default());
        let mut login = Reply::new(200, "application/json", b"{}".to_vec());
        login.headers.push((
            "Set-Cookie".into(),
            "filebrowser_quantum_jwt=aaa.bbb.ccc; Path=/".into(),
        ));
        server.on(Method::Post, &format!("{BASE}/api/auth/login"), login);
        server.on(
            Method::Get,
            &format!("{BASE}/api/users?id=self"),
            reply_json(
                200,
                json!({ "username": "Alice", "scopes": [{ "name": "main", "scope": "/" }] }),
            ),
        );
        let client = FileBrowserClient::new(
            server.clone(),
            FileBrowserConfig {
                url: format!("{BASE}/"),
                username: "alice".into(),
                password: "p w!".into(),
            },
        );
        block_on(client.login()).unwrap();
        server.clear();
        (server, client)
    }

    fn param(address: &str, name: &str) -> String {
        query(address)
            .into_iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
            .unwrap_or_default()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }

    #[test]
    fn login_keeps_the_token_the_source_name_and_the_account_name() {
        let (_, client) = signed_in();
        assert_eq!(client.source_name().as_deref(), Some("main"));
        assert_eq!(client.account_name(), "Alice");
        assert_eq!(
            client.auth_headers(),
            pairs(&[("Authorization", "Bearer aaa.bbb.ccc")])
        );
    }

    #[test]
    fn login_sends_the_password_in_a_header_encoded_as_the_apps_did() {
        let server = Arc::new(Scripted::default());
        let client = FileBrowserClient::new(
            server.clone(),
            FileBrowserConfig {
                url: BASE.into(),
                username: "alice".into(),
                password: "p w!*é".into(),
            },
        );
        let _ = block_on(client.login());
        let sent = server.sent()[0].clone();
        assert_eq!(header(&sent, "X-Password"), Some("p%20w!*%C3%A9"));
        assert_eq!(param(&sent.url, "username"), "alice");
        assert!(
            !sent.url.contains("p%20w"),
            "the password is not in the address"
        );
    }

    #[test]
    fn a_refused_login_an_unreachable_server_and_a_missing_cookie_are_told_apart() {
        let config = FileBrowserConfig {
            url: BASE.into(),
            username: "alice".into(),
            password: "bad".into(),
        };
        let server = Arc::new(Scripted::default());
        server.on(Method::Post, BASE, reply_json(401, json!({})));
        let client = FileBrowserClient::new(server.clone(), config.clone());
        assert_eq!(
            block_on(client.login()),
            Err(FileBrowserError::new("Identifiants invalides", 401))
        );

        let down = Arc::new(Scripted::default());
        down.unreachable(Method::Post, BASE);
        let err = block_on(FileBrowserClient::new(down, config.clone()).login()).unwrap_err();
        assert_eq!(err.status, 0);
        assert!(!err.is_auth_failure());

        let no_cookie = Arc::new(Scripted::default());
        no_cookie.on(Method::Post, BASE, reply_json(200, json!({})));
        let err = block_on(FileBrowserClient::new(no_cookie, config).login()).unwrap_err();
        assert_eq!(err.status, 500);
        assert!(err.message.contains("deux facteurs"), "{}", err.message);
    }

    #[test]
    fn without_scopes_the_first_source_listed_is_used_then_default() {
        let config = FileBrowserConfig {
            url: BASE.into(),
            username: "alice".into(),
            password: "pw".into(),
        };
        let mut login = Reply::new(200, "", Vec::new());
        login.headers.push((
            "set-cookie".into(),
            "filebrowser_quantum_jwt=t; Path=/".into(),
        ));

        let server = Arc::new(Scripted::default());
        server.on(Method::Post, BASE, login.clone());
        server.on(
            Method::Get,
            &format!("{BASE}/api/sources"),
            reply_json(200, json!([{ "name": "disk2" }])),
        );
        let client = FileBrowserClient::new(server, config.clone());
        block_on(client.login()).unwrap();
        assert_eq!(client.source_name().as_deref(), Some("disk2"));

        let bare = Arc::new(Scripted::default());
        bare.on(Method::Post, BASE, login);
        let client = FileBrowserClient::new(bare, config);
        block_on(client.login()).unwrap();
        assert_eq!(client.source_name().as_deref(), Some("default"));
        assert_eq!(client.account_name(), "alice");
    }

    #[test]
    fn a_listing_carries_thumbnails_and_shares() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/resources?"),
            reply_json(
                200,
                json!({ "folders": [{ "name": "Trips", "type": "directory" }], "files": [
                    { "name": "a.jpg", "size": 5, "type": "image/jpeg", "hasPreview": true, "isShared": true },
                    { "name": "b.mp4", "size": 9, "type": "video/mp4", "hasPreview": false },
                    { "name": "c.txt", "size": 1, "type": "text/plain" }
                ]}),
            ),
        );
        let items = block_on(client.list("/Photos")).unwrap();
        let summary: Vec<(&str, bool, Option<bool>, bool)> = items
            .iter()
            .map(|i| (i.name.as_str(), i.is_dir, i.has_preview, i.is_shared))
            .collect();
        assert_eq!(
            summary,
            [
                ("Trips", true, None, false),
                ("a.jpg", false, Some(true), true),
                ("b.mp4", false, Some(false), false),
                ("c.txt", false, None, false),
            ]
        );
        assert_eq!(items[1].path, "/Photos/a.jpg");
        assert_eq!(items[1].size, 5);
        assert_eq!(param(&server.last().url, "source"), "main");
        assert_eq!(
            header(&server.last(), "Authorization"),
            Some("Bearer aaa.bbb.ccc")
        );
    }

    #[test]
    fn the_photo_vault_reads_the_backups_through_the_client() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/resources?"),
            reply_json(
                200,
                json!({ "folders": [], "files": [
                    { "name": "a.jpg", "size": 5, "type": "image/jpeg", "hasPreview": true, "modified": "2026-09-15T10:00:00Z" },
                    { "name": "notes.txt", "size": 1, "type": "text/plain" }
                ]}),
            ),
        );
        let load = vault::load_photos(&client, "/backups/photos/alice", &[], || false, |_| {});
        // The apps run it on a multi-threaded runtime.
        fn assert_send<F: Send>(_: &F) {}
        assert_send(&load);
        let listing = block_on(load).unwrap();
        assert_eq!(listing.photos.len(), 1);
        assert_eq!(listing.photos[0].path, "/backups/photos/alice/a.jpg");
        assert_eq!(listing.photos[0].has_preview, Some(true));
        assert_eq!(listing.photos[0].modified, 1_789_466_400_000);

        server.clear();
        server.on(
            Method::Get,
            &format!("{BASE}/api/resources?"),
            reply_json(401, json!({})),
        );
        let err = block_on(vault::load_photos(
            &client,
            "/backups/photos/alice",
            &[],
            || false,
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(err.code, vault::VaultErrorCode::Unauthorized);
    }

    #[test]
    fn a_lapsed_session_while_listing_is_an_auth_failure() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/resources?"),
            reply_json(401, json!({})),
        );
        let err = block_on(client.list("/")).unwrap_err();
        assert_eq!(err, FileBrowserError::new("Session expirée", 401));
        assert!(err.is_auth_failure());
    }

    #[test]
    fn addresses_of_files_and_thumbnails_never_contain_the_login() {
        let (_, client) = signed_in();
        let raw = client.raw_url("/a b/c.jpg");
        assert!(
            !raw.contains("auth") && !raw.contains("aaa.bbb.ccc"),
            "{raw}"
        );
        assert_eq!(
            query(&raw),
            pairs(&[
                ("source", "main"),
                ("file", "/a b/c.jpg"),
                ("inline", "true")
            ])
        );
        for address in client.preview_urls("/a b/c.jpg", false) {
            assert!(
                !address.contains("auth") && !address.contains("aaa.bbb.ccc"),
                "{address}"
            );
        }
        assert!(!client.download_url("/a/b.pdf").contains("aaa.bbb.ccc"));
    }

    #[test]
    fn thumbnails_try_the_current_route_first_and_remember_which_answered() {
        let (_, client) = signed_in();
        let [first, second] = client.preview_urls("/p.jpg", false);
        assert!(
            first.starts_with(&format!("{BASE}/api/resources/preview?")),
            "{first}"
        );
        assert!(
            second.starts_with(&format!("{BASE}/api/preview?")),
            "{second}"
        );
        assert_eq!(
            query(&first),
            pairs(&[
                ("source", "main"),
                ("path", "/p.jpg"),
                ("size", "small"),
                ("inline", "true")
            ])
        );
        client.note_preview_worked(&second);
        assert!(
            client.preview_urls("/q.jpg", false)[0].starts_with(&format!("{BASE}/api/preview?"))
        );
        client.note_preview_worked(&first);
        assert!(
            client.preview_urls("/q.jpg", true)[0]
                .starts_with(&format!("{BASE}/api/resources/preview?"))
        );
    }

    #[test]
    fn creating_a_share_link_on_the_address_the_app_uses() {
        let (server, client) = signed_in();
        server.on(
            Method::Post,
            &format!("{BASE}/api/share"),
            reply_json(
                200,
                json!({ "hash": "h4sh", "path": "/Photos/a.jpg", "expire": 1790000000, "hasPassword": false,
                        "shareUrl": "http://backend:8080/public/share/h4sh" }),
            ),
        );
        let duration = ShareDuration {
            value: 7,
            unit: ShareUnit::Days,
        };
        let link = block_on(client.create_share("/Photos/a.jpg", Some(duration), None)).unwrap();
        let sent = server.last();
        assert_eq!(sent.method, Method::Post);
        assert_eq!(
            body(&sent),
            json!({ "path": "/Photos/a.jpg", "source": "main", "expires": "7", "unit": "days" })
        );
        assert_eq!(header(&sent, "Authorization"), Some("Bearer aaa.bbb.ccc"));
        assert_eq!(
            link.url,
            format!("{BASE}/public/share/h4sh"),
            "not the server's idea of its own address"
        );
        assert_eq!(
            link.download_url,
            format!("{BASE}/public/api/resources/download?hash=h4sh")
        );
        assert_eq!(link.expires_at, Some(1_790_000_000_000));
        assert!(
            !format!("{link:?}").contains("aaa.bbb.ccc"),
            "the login is nowhere in the link"
        );
    }

    #[test]
    fn a_share_without_end_sends_no_expiry_and_a_protected_one_gets_its_token() {
        let (server, client) = signed_in();
        server.on(
            Method::Post,
            &format!("{BASE}/api/share"),
            reply_json(200, json!({ "hash": "zz", "path": "/f", "expire": 0, "hasPassword": true, "token": "p.q" })),
        );
        let link = block_on(client.create_share("/f", None, Some("secret"))).unwrap();
        assert_eq!(
            body(&server.last()),
            json!({ "path": "/f", "source": "main", "password": "secret" })
        );
        assert_eq!(link.expires_at, None);
        assert!(link.has_password);
        assert_eq!(
            link.download_url,
            format!("{BASE}/public/api/resources/download?hash=zz&token=p.q")
        );
    }

    #[test]
    fn an_account_that_may_not_share_is_told_so() {
        let (server, client) = signed_in();
        server.on(
            Method::Post,
            &format!("{BASE}/api/share"),
            reply_json(403, json!({ "message": "forbidden" })),
        );
        let err = block_on(client.create_share("/f", None, None)).unwrap_err();
        assert_eq!(err.status, 403);
        assert!(err.message.contains("pas le droit"));
    }

    #[test]
    fn share_links_newest_first_with_the_old_route_as_fallback() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/share/list"),
            Reply::new(404, "", Vec::new()),
        );
        server.on(
            Method::Get,
            &format!("{BASE}/api/shares"),
            reply_json(
                200,
                json!([{ "hash": "one", "path": "/a", "expire": 0 }, { "hash": "two", "path": "/b", "expire": 10, "username": "bob" }]),
            ),
        );
        let links = block_on(client.list_shares()).unwrap();
        assert_eq!(
            links.iter().map(|l| l.hash.as_str()).collect::<Vec<_>>(),
            ["two", "one"]
        );
        assert_eq!(links[0].username.as_deref(), Some("bob"));
        assert_eq!(links[0].expires_at, Some(10_000));

        server.clear();
        server.on(
            Method::Get,
            &format!("{BASE}/api/share/list"),
            reply_json(
                200,
                json!([{ "hash": "x", "path": "/a" }, { "path": "no hash" }]),
            ),
        );
        assert_eq!(block_on(client.list_shares()).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_share_link() {
        let (server, client) = signed_in();
        server.on(
            Method::Delete,
            &format!("{BASE}/api/share?hash=ab%2Fc"),
            Reply::new(200, "", Vec::new()),
        );
        block_on(client.delete_share("ab/c")).unwrap();
        assert_eq!(server.last().method, Method::Delete);
    }

    #[test]
    fn search_sends_the_session_header_falls_back_and_tidies_folders() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/tools/search"),
            Reply::new(404, "", Vec::new()),
        );
        server.on(
            Method::Get,
            &format!("{BASE}/api/search"),
            reply_json(
                200,
                json!([
                    { "path": "/Docs/report.pdf", "type": "pdf", "size": 12, "modified": "2026-01-01T00:00:00Z" },
                    { "path": "/Docs/Old/", "type": "directory" },
                    { "type": "x" }
                ]),
            ),
        );
        let hits = block_on(client.search("rep ort", "/Docs")).unwrap();
        let calls = server.sent();
        assert_eq!(
            query(&calls[0].url),
            pairs(&[("query", "rep ort"), ("source", "main"), ("scope", "/Docs")])
        );
        assert!(header(&calls[0], "SessionId").is_some_and(|s| s.len() > 3));
        assert!(calls[1].url.starts_with(&format!("{BASE}/api/search?")));
        let summary: Vec<(&str, &str, bool)> = hits
            .iter()
            .map(|h| (h.path.as_str(), h.name.as_str(), h.is_dir))
            .collect();
        assert_eq!(
            summary,
            [
                ("/Docs/report.pdf", "report.pdf", false),
                ("/Docs/Old", "Old", true)
            ]
        );
        assert_eq!(hits[0].size, 12);
    }

    #[test]
    fn deleting_several_files_all_some_and_none_are_told_apart() {
        let (server, client) = signed_in();
        server.on(
            Method::Delete,
            BASE,
            reply_json(200, json!({ "succeeded": [], "failed": [] })),
        );
        assert_eq!(
            block_on(client.remove_many(&["/a", "/b"])).unwrap(),
            BatchResult {
                done: vec!["/a".into(), "/b".into()],
                failed: vec![]
            }
        );
        assert_eq!(
            body(&server.last()),
            json!([{ "source": "main", "path": "/a" }, { "source": "main", "path": "/b" }])
        );

        server.clear();
        server.on(
            Method::Delete,
            BASE,
            reply_json(207, json!({ "succeeded": [{ "path": "/a" }], "failed": [{ "path": "/b", "message": "permission denied" }] })),
        );
        assert_eq!(
            block_on(client.remove_many(&["/a", "/b"])).unwrap(),
            BatchResult {
                done: vec!["/a".into()],
                failed: vec![("/b".into(), "permission denied".into())]
            }
        );

        server.clear();
        server.on(
            Method::Delete,
            BASE,
            reply_json(500, json!({ "succeeded": [], "failed": [{ "path": "/a", "message": "busy" }, { "path": "/b", "message": "busy" }] })),
        );
        let none = block_on(client.remove_many(&["/a", "/b"])).unwrap();
        assert!(none.done.is_empty());
        assert_eq!(none.failed.len(), 2);

        server.clear();
        server.on(
            Method::Delete,
            BASE,
            Reply::new(502, "text/html", b"<html>Bad Gateway</html>".to_vec()),
        );
        assert_eq!(
            block_on(client.remove_many(&["/a"])).unwrap_err().status,
            502
        );
        assert_eq!(block_on(client.remove("/a")).unwrap_err().status, 502);
    }

    #[test]
    fn one_file_that_cannot_be_deleted_makes_remove_fail_with_the_reason() {
        let (server, client) = signed_in();
        server.on(Method::Delete, BASE, reply_json(500, json!({ "succeeded": [], "failed": [{ "path": "/a", "message": "file is locked" }] })));
        assert_eq!(
            block_on(client.remove("/a")).unwrap_err().message,
            "file is locked"
        );
    }

    #[test]
    fn moving_several_files_into_a_folder() {
        let (server, client) = signed_in();
        server.on(
            Method::Patch,
            BASE,
            reply_json(200, json!({ "succeeded": [], "failed": [] })),
        );
        let result = block_on(client.move_items(&["/a/x.txt", "/b/y.txt"], "/Archive")).unwrap();
        assert_eq!(
            body(&server.last()),
            json!({
                "items": [
                    { "fromSource": "main", "fromPath": "/a/x.txt", "toSource": "main", "toPath": "/Archive/x.txt" },
                    { "fromSource": "main", "fromPath": "/b/y.txt", "toSource": "main", "toPath": "/Archive/y.txt" }
                ],
                "action": "move", "overwrite": false, "rename": false
            })
        );
        assert_eq!(result.done, ["/a/x.txt", "/b/y.txt"]);

        server.clear();
        server.on(Method::Patch, BASE, reply_json(207, json!({ "succeeded": [], "failed": [{ "fromPath": "/b/y.txt", "message": "destination exists" }] })));
        assert_eq!(
            block_on(client.move_items(&["/a/x.txt", "/b/y.txt"], "/Archive")).unwrap(),
            BatchResult {
                done: vec!["/a/x.txt".into()],
                failed: vec![("/b/y.txt".into(), "destination exists".into())]
            }
        );
    }

    #[test]
    fn a_refused_rename_is_an_error_with_its_reason_not_a_success() {
        let (server, client) = signed_in();
        server.on(Method::Patch, BASE, reply_json(500, json!({ "succeeded": [], "failed": [{ "fromPath": "/a", "message": "destination exists" }] })));
        assert_eq!(
            block_on(client.rename("/a", "/b")).unwrap_err().message,
            "destination exists"
        );
        server.clear();
        server.on(
            Method::Patch,
            BASE,
            reply_json(
                207,
                json!({ "succeeded": [], "failed": [{ "fromPath": "/a", "message": "nope" }] }),
            ),
        );
        assert_eq!(
            block_on(client.rename("/a", "/b")).unwrap_err().message,
            "nope"
        );
        server.clear();
        server.on(
            Method::Patch,
            BASE,
            reply_json(
                200,
                json!({ "succeeded": [{ "fromPath": "/a" }], "failed": [] }),
            ),
        );
        block_on(client.rename("/a", "/b")).unwrap();
    }

    #[test]
    fn an_upload_does_not_replace_a_file_of_the_same_name_unless_told_to() {
        let (_, client) = signed_in();
        let address = client.upload_url("/Photos", "x.jpg", false);
        assert_eq!(
            query(&address),
            pairs(&[
                ("path", "/Photos/x.jpg"),
                ("source", "main"),
                ("override", "false")
            ])
        );
        assert_eq!(
            param(&client.upload_url("/Photos", "x.jpg", true), "override"),
            "true"
        );
        assert_eq!(upload_result(200), Ok(()));
        let taken = upload_result(409).unwrap_err();
        assert_eq!(taken.status, 409);
        assert!(taken.message.contains("existe déjà"));
        assert_eq!(upload_result(500).unwrap_err().status, 500);
    }

    #[test]
    fn a_zip_lists_every_file() {
        let (_, client) = signed_in();
        let address = client.archive_url(&["/a/b.pdf", "/c d"]);
        let files: Vec<String> = query(&address)
            .into_iter()
            .filter(|(k, _)| k == "file")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(files, ["/a/b.pdf", "/c d"]);
        assert_eq!(param(&address, "algo"), "zip");
        assert!(!address.contains("aaa.bbb.ccc"));
    }

    #[test]
    fn usage_of_the_sources_and_of_the_current_one() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/settings/sources"),
            reply_json(
                200,
                json!({
                    "other": { "name": "other", "used": 1, "total": 4 },
                    "main": { "used": 50, "total": 200, "numFiles": 3, "numDirs": 2, "status": "ready" }
                }),
            ),
        );
        let all = block_on(client.sources_usage()).unwrap();
        assert_eq!(all[0].used_percentage, 25);
        assert_eq!(all[0].status, "unknown");
        let current = block_on(client.current_source_usage()).unwrap().unwrap();
        assert_eq!(current.name, "main");
        assert_eq!(
            (current.used_percentage, current.num_files, current.num_dirs),
            (25, 3, 2)
        );
    }

    #[test]
    fn a_text_preview_and_a_new_folder() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/resources/download?"),
            Reply::new(200, "text/plain", "bonjour".as_bytes().to_vec()),
        );
        assert_eq!(block_on(client.text_preview("/a.txt")).unwrap(), "bonjour");
        server.on(
            Method::Post,
            &format!("{BASE}/api/resources?"),
            Reply::new(200, "", Vec::new()),
        );
        block_on(client.create_folder("/New//Folder/")).unwrap();
        let sent = server.last();
        assert_eq!(
            query(&sent.url),
            pairs(&[
                ("path", "/New/Folder"),
                ("source", "main"),
                ("isDir", "true")
            ])
        );
    }

    #[test]
    fn probing_tells_a_dead_server_from_a_lapsed_session() {
        let (server, client) = signed_in();
        server.on(
            Method::Get,
            &format!("{BASE}/api/users?id=self"),
            reply_json(401, json!({})),
        );
        assert_eq!(block_on(client.probe()), 401);
        assert!(block_on(client.is_reachable()));
        assert_eq!(server.last().timeout, Some(Duration::from_secs(8)));
        server.clear();
        server.unreachable(Method::Get, BASE);
        assert_eq!(block_on(client.probe()), 0);
        assert!(!block_on(client.is_reachable()));
    }
}
