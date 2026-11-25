//! Navidrome's own API (the one its web pages use), for the server's owner: the only way to give a playlist to
//! another account, make it public or private, or unlock one imported from an M3U file (a playlist that follows its
//! file cannot have songs added or removed).
//!
//! Port of `mobile/src/services/navidromeAdmin.ts` and `src/renderer/src/services/navidromeAdmin.ts`.

use std::fmt;
use std::sync::Mutex;

use hub_core::home_network::is_home_host;
use serde_json::{Map, Value, json};

use crate::transport::{Method, Reply, Request, Transport};
use crate::url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminError {
    pub message: String,
    /// The HTTP status, or 0 when the server did not answer.
    pub status: u16,
}

impl AdminError {
    fn new(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}

impl fmt::Display for AdminError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AdminError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminUser {
    pub id: String,
    pub user_name: String,
    pub name: String,
    pub is_admin: bool,
}

/// A playlist as Navidrome's own API describes it, kept whole: a change is sent back as the whole playlist.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AdminPlaylist(pub Map<String, Value>);

impl AdminPlaylist {
    fn text(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn id(&self) -> &str {
        self.text("id").unwrap_or_default()
    }

    pub fn name(&self) -> &str {
        self.text("name").unwrap_or_default()
    }

    pub fn comment(&self) -> Option<&str> {
        self.text("comment")
    }

    pub fn owner_id(&self) -> &str {
        self.text("ownerId").unwrap_or_default()
    }

    pub fn owner_name(&self) -> Option<&str> {
        self.text("ownerName")
    }

    pub fn is_public(&self) -> bool {
        self.0
            .get("public")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn song_count(&self) -> u64 {
        self.0.get("songCount").and_then(Value::as_u64).unwrap_or(0)
    }

    /// The M3U file it was imported from, if it was.
    pub fn path(&self) -> Option<&str> {
        self.text("path").filter(|p| !p.is_empty())
    }

    /// Follows its M3U file: its songs cannot be changed in the apps (the file would put them back).
    pub fn sync(&self) -> bool {
        self.0.get("sync").and_then(Value::as_bool).unwrap_or(false)
    }

    /// Whether the playlist's songs can be changed: not a smart playlist, not following a file.
    pub fn tracks_editable(&self) -> bool {
        !self.sync() && self.0.get("rules").is_none_or(Value::is_null)
    }
}

/// What can be changed on a playlist; `None` leaves a field as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlaylistChanges {
    pub name: Option<String>,
    pub comment: Option<String>,
    pub public: Option<bool>,
    /// Gives the playlist to another account (an admin only).
    pub owner_id: Option<String>,
    pub sync: Option<bool>,
}

impl PlaylistChanges {
    fn apply(&self, playlist: &mut Map<String, Value>) {
        let mut set = |key: &str, value: Option<Value>| {
            if let Some(v) = value {
                playlist.insert(key.to_owned(), v);
            }
        };
        set("name", self.name.clone().map(Value::from));
        set("comment", self.comment.clone().map(Value::from));
        set("public", self.public.map(Value::from));
        set("ownerId", self.owner_id.clone().map(Value::from));
        set("sync", self.sync.map(Value::from));
    }
}

/// What Navidrome is sent back when a playlist is changed: the playlist as it is, with the changes, without what
/// the server makes itself (as its own web pages do).
pub fn update_body(current: &AdminPlaylist, changes: &PlaylistChanges) -> Value {
    let mut body = current.0.clone();
    body.remove("ownerName");
    body.remove("tracks");
    changes.apply(&mut body);
    Value::Object(body)
}

fn describe(status: u16, fallback: &str) -> String {
    match status {
        0 => "Serveur injoignable".into(),
        401 => "Identifiants refusés par Navidrome".into(),
        403 => "Réservé à un compte administrateur de Navidrome".into(),
        404 => "Playlist introuvable (supprimée entre-temps ?)".into(),
        409 => "Cette playlist ne peut pas être modifiée ainsi".into(),
        other => format!("{fallback} ({other})"),
    }
}

pub struct NavidromeAdmin<T: Transport> {
    transport: T,
    base_url: String,
    username: String,
    password: String,
    token: Mutex<Option<String>>,
    /// Held while signing in, so requests started at the same time share one sign-in.
    signing_in: tokio::sync::Mutex<()>,
}

impl<T: Transport> NavidromeAdmin<T> {
    pub fn new(transport: T, base_url: &str, username: &str, password: &str) -> Self {
        Self {
            transport,
            base_url: base_url.trim_end_matches('/').to_owned(),
            username: username.to_owned(),
            password: password.to_owned(),
            token: Mutex::new(None),
            signing_in: tokio::sync::Mutex::new(()),
        }
    }

    /// Every account of the server.
    pub async fn users(&self) -> Result<Vec<AdminUser>, AdminError> {
        let list = self
            .request(
                Method::Get,
                "/api/user?_sort=userName&_order=ASC&_start=0&_end=1000",
                None,
            )
            .await?;
        Ok(list
            .as_array()
            .map(|users| {
                users
                    .iter()
                    .map(|u| {
                        let text = |k: &str| {
                            u.get(k)
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned()
                        };
                        AdminUser {
                            id: text("id"),
                            user_name: text("userName"),
                            name: text("name"),
                            is_admin: u.get("isAdmin").and_then(Value::as_bool).unwrap_or(false),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Every playlist of every account (an admin sees them all).
    pub async fn playlists(&self) -> Result<Vec<AdminPlaylist>, AdminError> {
        let list = self
            .request(
                Method::Get,
                "/api/playlist?_sort=name&_order=ASC&_start=0&_end=10000",
                None,
            )
            .await?;
        Ok(list
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|p| p.as_object().cloned().map(AdminPlaylist))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Changes a playlist; giving it to another account (`owner_id`) is for an admin only.
    pub async fn update(
        &self,
        id: &str,
        changes: &PlaylistChanges,
    ) -> Result<AdminPlaylist, AdminError> {
        let path = format!("/api/playlist/{}", url::encode_uri_component(id));
        let current = match self.request(Method::Get, &path, None).await? {
            Value::Object(map) => AdminPlaylist(map),
            _ => AdminPlaylist::default(),
        };
        self.request(Method::Put, &path, Some(update_body(&current, changes)))
            .await?;
        let mut updated = current.0;
        changes.apply(&mut updated);
        Ok(AdminPlaylist(updated))
    }

    pub async fn remove(&self, id: &str) -> Result<(), AdminError> {
        let path = format!("/api/playlist/{}", url::encode_uri_component(id));
        self.request(Method::Delete, &path, None).await.map(|_| ())
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AdminError> {
        let mut retried = false;
        loop {
            let token = self.token().await?;
            let mut request = Request::new(method, format!("{}{path}", self.base_url))
                .header("Content-Type", "application/json")
                .header("X-ND-Authorization", format!("Bearer {token}"));
            request.body = body.as_ref().map(|b| b.to_string().into_bytes());
            let reply = self.send(request).await?;
            // The session ran out: one new sign-in, then the request again.
            if reply.status == 401 && !retried {
                retried = true;
                self.token.lock().unwrap().take();
                continue;
            }
            // Navidrome hands back a renewed token as it goes.
            if let Some(renewed) = reply
                .header("x-nd-authorization")
                .and_then(|h| h.strip_prefix("Bearer "))
            {
                *self.token.lock().unwrap() = Some(renewed.to_owned());
            }
            if !reply.is_success() {
                return Err(AdminError::new(
                    describe(reply.status, "Navidrome a refusé"),
                    reply.status,
                ));
            }
            return Ok(reply.json().unwrap_or(Value::Null));
        }
    }

    /// The current token, signing in first when there is none.
    async fn token(&self) -> Result<String, AdminError> {
        if let Some(token) = self.token.lock().unwrap().clone() {
            return Ok(token);
        }
        let _guard = self.signing_in.lock().await;
        // Another request may have signed in while this one waited.
        if let Some(token) = self.token.lock().unwrap().clone() {
            return Ok(token);
        }
        let token = self.login().await?;
        *self.token.lock().unwrap() = Some(token.clone());
        Ok(token)
    }

    async fn login(&self) -> Result<String, AdminError> {
        let request = Request::new(Method::Post, format!("{}/auth/login", self.base_url))
            .json(&json!({ "username": self.username, "password": self.password }));
        let reply = self.send(request).await?;
        let data = reply.json().unwrap_or(Value::Null);
        let token = data.get("token").and_then(Value::as_str);
        let (true, Some(token)) = (reply.is_success(), token) else {
            return Err(AdminError::new(
                describe(reply.status, "Connexion à Navidrome impossible"),
                reply.status,
            ));
        };
        if data.get("isAdmin").and_then(Value::as_bool) != Some(true) {
            return Err(AdminError::new(
                "Réservé à un compte administrateur de Navidrome",
                403,
            ));
        }
        Ok(token.to_owned())
    }

    async fn send(&self, request: Request) -> Result<Reply, AdminError> {
        let home = url::host_of(&request.url).is_some_and(is_home_host);
        self.transport
            .send(request.home_network(home))
            .await
            .map_err(|_| AdminError::new("Serveur injoignable", 0))
    }
}

// Ported from the admin part of mobile/tests/playlists.test.js.
#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::scripted::{Scripted, body, header, join, json as reply_json};
    use crate::subsonic::fake::block_on;

    const BASE: &str = "http://music.lan";

    fn admin(server: &Arc<Scripted>) -> NavidromeAdmin<Arc<Scripted>> {
        NavidromeAdmin::new(server.clone(), BASE, "mbootx", "secret")
    }

    fn signs_in_as_admin(server: &Scripted, token: &str) {
        server.on(
            Method::Post,
            &format!("{BASE}/auth/login"),
            reply_json(200, json!({ "token": token, "isAdmin": true })),
        );
    }

    #[test]
    fn signs_in_once_for_requests_started_together_and_sends_its_token() {
        let server = Arc::new(Scripted::default());
        server.yielding.store(true, Ordering::SeqCst);
        signs_in_as_admin(&server, "T1");
        server.on(
            Method::Get,
            &format!("{BASE}/api/user"),
            reply_json(
                200,
                json!([{ "id": "u1", "userName": "ana", "name": "Ana", "isAdmin": false }]),
            ),
        );
        server.on(Method::Get, &format!("{BASE}/api/playlist"), reply_json(200, json!([{ "id": "p1", "name": "Route", "ownerId": "u0", "public": true, "songCount": 3 }])));
        let api = admin(&server);
        let (playlists, users) = join(api.playlists(), api.users());
        assert_eq!(playlists.unwrap()[0].name(), "Route");
        assert_eq!(users.unwrap()[0].user_name, "ana");
        let sent = server.sent();
        let logins: Vec<&Request> = sent
            .iter()
            .filter(|r| r.url.ends_with("/auth/login"))
            .collect();
        assert_eq!(logins.len(), 1, "two requests at once share one sign-in");
        assert_eq!(
            body(logins[0]),
            json!({ "username": "mbootx", "password": "secret" })
        );
        assert_eq!(logins[0].method, Method::Post);
        for r in sent.iter().filter(|r| r.url.contains("/api/")) {
            assert_eq!(header(r, "X-ND-Authorization"), Some("Bearer T1"));
        }
    }

    #[test]
    fn an_account_that_is_not_an_admin_is_told_so() {
        let server = Arc::new(Scripted::default());
        server.on(
            Method::Post,
            BASE,
            reply_json(200, json!({ "token": "T", "isAdmin": false })),
        );
        let err = block_on(admin(&server).playlists()).unwrap_err();
        assert!(err.message.contains("administrateur"), "{}", err.message);
    }

    #[test]
    fn a_session_that_ran_out_signs_in_again_once_then_goes_on() {
        let server = Arc::new(Scripted::default());
        signs_in_as_admin(&server, "T1");
        server.on(
            Method::Get,
            &format!("{BASE}/api/playlist"),
            Reply::new(401, "", Vec::new()),
        );
        let api = admin(&server);
        // The first request is refused; while it signs in again, the server starts answering.
        let err = block_on(api.playlists()).unwrap_err();
        assert_eq!(err.status, 401, "a second 401 is not retried forever");
        let logins = server
            .sent()
            .iter()
            .filter(|r| r.url.ends_with("/auth/login"))
            .count();
        assert_eq!(logins, 2);

        let server = Arc::new(Scripted::default());
        let api = admin(&server);
        signs_in_as_admin(&server, "T1");
        server.on(
            Method::Get,
            &format!("{BASE}/api/playlist"),
            reply_json(200, json!([])),
        );
        block_on(api.playlists()).unwrap();
        *api.token.lock().unwrap() = Some("stale".into());
        server.clear();
        signs_in_as_admin(&server, "T2");
        server.on_match(
            |r| header(r, "X-ND-Authorization") == Some("Bearer stale"),
            Reply::new(401, "", Vec::new()),
        );
        server.on(
            Method::Get,
            &format!("{BASE}/api/playlist"),
            reply_json(200, json!([])),
        );
        block_on(api.playlists()).unwrap();
        assert_eq!(
            header(&server.last(), "X-ND-Authorization"),
            Some("Bearer T2")
        );
    }

    #[test]
    fn giving_a_playlist_away_sends_it_back_whole_without_what_the_server_makes() {
        let server = Arc::new(Scripted::default());
        signs_in_as_admin(&server, "T");
        let current = json!({ "id": "p1", "name": "Route", "comment": "", "ownerId": "u0", "ownerName": "mbootx", "public": true,
                              "songCount": 3, "path": "/music/Route.m3u", "sync": true, "rules": null, "tracks": [] });
        let mut get = reply_json(200, current);
        get.headers
            .push(("X-ND-Authorization".into(), "Bearer T-renewed".into()));
        server.on(Method::Get, &format!("{BASE}/api/playlist/p1"), get);
        server.on(
            Method::Put,
            &format!("{BASE}/api/playlist/p1"),
            reply_json(200, json!({ "id": "p1" })),
        );
        let changes = PlaylistChanges {
            owner_id: Some("u1".into()),
            public: Some(false),
            sync: Some(false),
            ..Default::default()
        };
        let updated = block_on(admin(&server).update("p1", &changes)).unwrap();
        let put = server
            .sent()
            .into_iter()
            .find(|r| r.method == Method::Put)
            .unwrap();
        assert!(put.url.ends_with("/api/playlist/p1"));
        assert_eq!(
            header(&put, "X-ND-Authorization"),
            Some("Bearer T-renewed"),
            "the renewed token is used"
        );
        let sent = body(&put);
        assert_eq!(
            (
                sent["ownerId"].as_str(),
                sent["public"].as_bool(),
                sent["sync"].as_bool()
            ),
            (Some("u1"), Some(false), Some(false))
        );
        assert_eq!(
            sent["name"], "Route",
            "what is not changed is sent as it was"
        );
        assert!(sent.get("ownerName").is_none() && sent.get("tracks").is_none());
        assert_eq!(updated.owner_id(), "u1");
        assert!(updated.tracks_editable());
    }

    #[test]
    fn a_server_out_of_reach_or_a_refusal_is_said_in_words() {
        let down = Arc::new(Scripted::default());
        down.unreachable(Method::Post, BASE);
        assert_eq!(
            block_on(admin(&down).users()),
            Err(AdminError::new("Serveur injoignable", 0))
        );
        let server = Arc::new(Scripted::default());
        signs_in_as_admin(&server, "T");
        server.on(Method::Get, BASE, Reply::new(403, "", Vec::new()));
        assert!(
            block_on(admin(&server).users())
                .unwrap_err()
                .message
                .contains("administrateur")
        );
        server.clear();
        signs_in_as_admin(&server, "T");
        server.on(Method::Delete, BASE, Reply::new(404, "", Vec::new()));
        assert!(
            block_on(admin(&server).remove("p9"))
                .unwrap_err()
                .message
                .contains("introuvable")
        );
    }

    #[test]
    fn a_playlist_following_its_file_or_a_smart_one_cannot_have_its_songs_changed() {
        let p = |v: Value| AdminPlaylist(v.as_object().unwrap().clone());
        assert!(!p(json!({ "sync": true })).tracks_editable());
        assert!(!p(json!({ "sync": false, "rules": { "all": [] } })).tracks_editable());
        assert!(p(json!({ "sync": false, "rules": null })).tracks_editable());
        assert!(p(json!({})).tracks_editable());
    }
}
