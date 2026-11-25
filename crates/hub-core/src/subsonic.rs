//! Subsonic's "token" authentication (API 1.13 and later, which Navidrome speaks): a request carries the user, a
//! salt and `md5(password + salt)` instead of the password itself.
//!
//! Port of `wear/core/.../SubsonicAuth.kt` and of the authentication half of `NavidromeClient` in
//! `src/renderer/src/services/navidrome.ts` and `mobile/src/services/navidrome.ts`, which were three copies of the
//! same rules.

use md5::{Digest, Md5};

/// The Subsonic API version every app announces.
pub const API_VERSION: &str = "1.16.1";
/// The client name the desktop and phone apps send.
pub const CLIENT_NAME: &str = "SelfHostHub";
/// The client name the watch app sends.
pub const WATCH_CLIENT_NAME: &str = "SelfHostHubWear";

pub fn md5_hex(text: &str) -> String {
    let digest = Md5::digest(text.as_bytes());
    let mut out = String::with_capacity(32);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// What a request carries instead of the password.
pub fn token(password: &str, salt: &str) -> String {
    md5_hex(&format!("{password}{salt}"))
}

/// A random salt of twelve hex characters.
pub fn new_salt() -> String {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).expect("the operating system's random generator is unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A fixed salt for cover-art addresses, made from public account details only, so a cover's address stays the
/// same across restarts and the disk cache keeps working. Same value as the TypeScript apps.
pub fn cover_salt(username: &str, base_url: &str) -> String {
    md5_hex(&format!("{username}@{base_url}"))[..12].to_owned()
}

/// The server address as every call uses it: no surrounding spaces, no trailing slashes.
pub fn base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_owned()
}

/// Where Navidrome is and how to sign in to it without the password. The phone gives the watch a salt and its
/// token: the server accepts any salt, so a fixed pair works for every request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavidromeLogin {
    pub url: String,
    pub username: String,
    pub salt: String,
    pub token: String,
}

impl NavidromeLogin {
    /// The login another device can use, made from the password and a fresh salt.
    pub fn from_password(url: &str, username: &str, password: &str) -> Self {
        let salt = new_salt();
        Self {
            url: base_url(url),
            username: username.to_owned(),
            token: token(password, &salt),
            salt,
        }
    }

    /// The login the desktop and phone apps sign every call with: its salt is [`cover_salt`], fixed per account,
    /// so a cover's address stays the same across restarts and image caches keep working (any salt is valid).
    pub fn stable(url: &str, username: &str, password: &str) -> Self {
        let url = base_url(url);
        let salt = cover_salt(username, &url);
        Self {
            token: token(password, &salt),
            username: username.to_owned(),
            salt,
            url,
        }
    }

    pub fn base_url(&self) -> String {
        base_url(&self.url)
    }

    /// The query parameters every Subsonic call carries, JSON answers requested.
    pub fn query_parameters(&self, client: &str) -> Vec<(&'static str, String)> {
        vec![
            ("u", self.username.clone()),
            ("t", self.token.clone()),
            ("s", self.salt.clone()),
            ("v", API_VERSION.to_owned()),
            ("c", client.to_owned()),
            ("f", "json".to_owned()),
        ]
    }

    /// Same server and account, whatever the secret: tells whether a library kept on a device is still the right one.
    pub fn same_account(&self, other: Option<&NavidromeLogin>) -> bool {
        other.is_some_and(|o| {
            o.base_url().to_lowercase() == self.base_url().to_lowercase()
                && o.username == self.username
        })
    }
}

/// Whether a playlist belongs to the signed-in account. Navidrome lists everyone's public playlists, and every
/// playlist to an admin: the apps keep to the account's own. A playlist whose owner the server does not say (an
/// older server) is kept, and so is everything when no account is known.
///
/// Port of `ownPlaylists` in `mobile/src/services/navidromeAdmin.ts`.
pub fn is_own_playlist(owner: Option<&str>, username: Option<&str>) -> bool {
    let Some(me) = username
        .map(|u| u.trim().to_lowercase())
        .filter(|u| !u.is_empty())
    else {
        return true;
    };
    owner
        .filter(|o| !o.is_empty())
        .is_none_or(|o| o.trim().to_lowercase() == me)
}

// Ported from SubsonicAuthTest in wear/core/src/test/kotlin/com/selfhosthub/wear/core/ProtocolTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    fn login(url: &str, user: &str, salt: &str, token: &str) -> NavidromeLogin {
        NavidromeLogin {
            url: url.into(),
            username: user.into(),
            salt: salt.into(),
            token: token.into(),
        }
    }

    #[test]
    fn the_token_is_the_md5_of_password_and_salt_as_documented() {
        // The example of the Subsonic API documentation: password "sesame" with the salt "c19b2d".
        assert_eq!(
            token("sesame", "c19b2d"),
            "26719a1196d2a940705a59634eb18eab"
        );
    }

    #[test]
    fn salts_are_twelve_hex_characters_and_differ() {
        let a = new_salt();
        assert_eq!(a.len(), 12);
        assert!(
            a.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')),
            "{a}"
        );
        assert_ne!(a, new_salt());
    }

    #[test]
    fn a_login_carries_the_six_query_parameters_of_every_call() {
        let l = login(
            "https://music.example.org/",
            "maxime",
            "abc123",
            &"0".repeat(32),
        );
        assert_eq!(l.base_url(), "https://music.example.org");
        let params = l.query_parameters(WATCH_CLIENT_NAME);
        let names: Vec<&str> = params.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, ["u", "t", "s", "v", "c", "f"]);
        assert_eq!(params[4].1, "SelfHostHubWear");
        assert_eq!(params[5].1, "json");
    }

    #[test]
    fn two_logins_are_the_same_account_when_server_and_user_match() {
        let a = login(
            "https://Music.example.org/",
            "maxime",
            "s1",
            &"a".repeat(32),
        );
        let b = login("https://music.example.org", "maxime", "s2", &"b".repeat(32));
        assert!(a.same_account(Some(&b)));
        assert!(!a.same_account(Some(&login(
            "https://music.example.org",
            "alice",
            "s1",
            &"a".repeat(32)
        ))));
        assert!(!a.same_account(None));
    }

    #[test]
    fn a_login_made_from_the_password_signs_in_with_its_own_salt() {
        let l = NavidromeLogin::from_password(" https://music.example.org// ", "maxime", "sesame");
        assert_eq!(l.url, "https://music.example.org");
        assert_eq!(l.token, token("sesame", &l.salt));
    }

    #[test]
    fn only_the_account_own_playlists_are_kept() {
        // From mobile/tests/playlists.test.js.
        let lists = [(1, Some("MBootx")), (2, Some("ana")), (3, None)];
        let kept = |user: Option<&str>| -> Vec<i32> {
            lists
                .iter()
                .filter(|(_, owner)| is_own_playlist(*owner, user))
                .map(|(id, _)| *id)
                .collect()
        };
        assert_eq!(kept(Some("mbootx")), [1, 3]);
        assert_eq!(kept(Some("ana ")), [2, 3]);
        assert_eq!(kept(None), [1, 2, 3], "no account known: nothing hidden");
    }

    #[test]
    fn the_cover_salt_is_fixed_per_account() {
        let salt = cover_salt("maxime", "https://music.example.org");
        assert_eq!(salt.len(), 12);
        assert_eq!(salt, md5_hex("maxime@https://music.example.org")[..12]);
        assert_eq!(salt, cover_salt("maxime", "https://music.example.org"));
        assert_ne!(salt, cover_salt("alice", "https://music.example.org"));
    }
}
