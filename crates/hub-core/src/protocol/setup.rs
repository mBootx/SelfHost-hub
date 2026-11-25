//! What the phone hands the watch once, from its "Montre" setting: where Navidrome is and the signed-in token. It
//! travels over the Wear OS data layer as one message. Nothing about the PC is in it: the watch never talks to the
//! PC, only to the phone (see [`super::link`]) and to Navidrome.
//!
//! Port of `wear/core/.../WatchSetup.kt` and the store interface of `SetupStore.kt`. The phone's side is
//! `mobile/src/services/watchSync.ts`.

use std::fmt;

use serde_json::{Map, Value, json};

use super::Lenient;
use crate::subsonic::NavidromeLogin;

/// The watch app declares this capability, which is how the phone knows that a watch has it installed.
pub const CAPABILITY: &str = "selfhost_watch";
pub const SETUP_PATH: &str = "/selfhost/setup";
pub const ACK_PATH: &str = "/selfhost/setup/ack";
pub const VERSION: i64 = 1;

/// The longest text field accepted.
const MAX_TEXT_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchSetup {
    pub navidrome: NavidromeLogin,
}

/// Why a setup message was refused, in the words the watch shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupFormatError(pub &'static str);

impl fmt::Display for SetupFormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for SetupFormatError {}

pub fn encode(setup: &WatchSetup) -> String {
    let n = &setup.navidrome;
    json!({
        "v": VERSION,
        "navidrome": { "url": n.url, "username": n.username, "salt": n.salt, "token": n.token }
    })
    .to_string()
}

/// Reads and checks what the phone sent; anything that is not exactly what it should be is refused whole.
pub fn decode(text: &str) -> Result<WatchSetup, SetupFormatError> {
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) else {
        return Err(SetupFormatError("Message illisible"));
    };
    if obj.int("v") != Some(VERSION) {
        return Err(SetupFormatError(
            "Version de configuration inconnue : mettez à jour les deux applications",
        ));
    }
    let Some(Value::Object(n)) = obj.get("navidrome") else {
        return Err(SetupFormatError("Rien à configurer"));
    };
    let url = field(n, "url").ok_or(SetupFormatError("Adresse Navidrome manquante"))?;
    if !is_http_url(&url) {
        return Err(SetupFormatError("Adresse Navidrome invalide"));
    }
    let username = field(n, "username").ok_or(SetupFormatError("Nom d'utilisateur manquant"))?;
    let salt = field(n, "salt").ok_or(SetupFormatError("Sel manquant"))?;
    let token = field(n, "token").ok_or(SetupFormatError("Jeton manquant"))?;
    if token.len() != 32 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(SetupFormatError("Jeton invalide"));
    }
    Ok(WatchSetup {
        navidrome: NavidromeLogin {
            url,
            username,
            salt,
            token: token.to_lowercase(),
        },
    })
}

/// A text field, trimmed; missing when empty or longer than [`MAX_TEXT_CHARS`].
fn field(obj: &Map<String, Value>, name: &str) -> Option<String> {
    let value = obj.string(name)?.trim().to_owned();
    (!value.is_empty() && value.chars().count() <= MAX_TEXT_CHARS).then_some(value)
}

fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_lowercase();
    let Some(rest) = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
    else {
        return false;
    };
    !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with(':')
}

/// Where the watch keeps what the phone gave it. The token is a secret: the watch's real store keeps it encrypted
/// behind a key of the Android keystore.
pub trait SetupStore {
    fn load(&self) -> Option<WatchSetup>;
    fn save(&mut self, setup: WatchSetup);
    fn clear(&mut self);
}

/// A store that forgets everything when dropped, for tests.
#[derive(Debug, Default)]
pub struct MemorySetupStore(Option<WatchSetup>);

impl SetupStore for MemorySetupStore {
    fn load(&self) -> Option<WatchSetup> {
        self.0.clone()
    }

    fn save(&mut self, setup: WatchSetup) {
        self.0 = Some(setup);
    }

    fn clear(&mut self) {
        self.0 = None;
    }
}

// Ported from SetupCodecTest in wear/core/src/test/kotlin/com/selfhosthub/wear/core/SetupAndNetworkTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    const PHONE_SETUP: &str =
        include_str!("../../../../wear/core/src/test/resources/phone-setup.json");
    const TOKEN: &str = "26719a1196d2a940705a59634eb18eab";

    fn login() -> NavidromeLogin {
        NavidromeLogin {
            url: "https://music.example.org".into(),
            username: "maxime".into(),
            salt: "abc123".into(),
            token: TOKEN.into(),
        }
    }

    #[test]
    fn what_the_phone_sends_is_read_back_unchanged() {
        let setup = WatchSetup { navidrome: login() };
        assert_eq!(decode(&encode(&setup)), Ok(setup));
    }

    #[test]
    fn golden_the_phone_sample_is_read_and_written_alike() {
        let setup = decode(PHONE_SETUP).unwrap();
        assert_eq!(
            setup.navidrome,
            NavidromeLogin {
                salt: "c19b2d".into(),
                ..login()
            }
        );
        let written: Value = serde_json::from_str(&encode(&setup)).unwrap();
        let sample: Value = serde_json::from_str(PHONE_SETUP).unwrap();
        assert_eq!(written, sample);
    }

    #[test]
    fn the_token_is_kept_in_lower_case() {
        let text = r#"{"v":1,"navidrome":{"url":"https://a.b","username":"u","salt":"s","token":"26719A1196D2A940705A59634EB18EAB"}}"#;
        assert_eq!(decode(text).unwrap().navidrome.token, TOKEN);
    }

    #[test]
    fn a_setup_from_an_older_phone_build_that_still_carries_a_pc_is_read_without_it() {
        let text = format!(
            r#"{{"v":1,"navidrome":{{"url":"https://a.b","username":"u","salt":"s","token":"{TOKEN}"}},"hub":{{"hubId":"h","code":"ABCDEFGHJK"}}}}"#
        );
        assert_eq!(decode(&text).unwrap().navidrome.username, "u");
    }

    #[test]
    fn other_versions_and_malformed_messages_are_refused_whole() {
        let n = |url: &str, user: Option<&str>, token: &str| {
            let user = user.map_or(String::new(), |u| format!(r#""username":"{u}","#));
            format!(r#"{{"url":"{url}",{user}"salt":"s","token":"{token}"}}"#)
        };
        let good = n("https://a.b", Some("u"), TOKEN);
        let refused = [
            format!(r#"{{"v":2,"navidrome":{good}}}"#),
            format!(r#"{{"navidrome":{good}}}"#),
            "not json".into(),
            "[]".into(),
            r#"{"v":1}"#.into(),
            r#"{"v":1,"hub":{"hubId":"h","code":"ABCDEFGHJK"}}"#.into(),
            format!(
                r#"{{"v":1,"navidrome":{}}}"#,
                n("ftp://a.b", Some("u"), TOKEN)
            ),
            format!(
                r#"{{"v":1,"navidrome":{}}}"#,
                n("https://a.b", Some("u"), "not-a-token")
            ),
            format!(
                r#"{{"v":1,"navidrome":{}}}"#,
                n("https://a.b", Some(""), TOKEN)
            ),
            format!(r#"{{"v":1,"navidrome":{}}}"#, n("https://a.b", None, TOKEN)),
            format!(
                r#"{{"v":1,"navidrome":{}}}"#,
                n("https://", Some("u"), TOKEN)
            ),
            format!(
                r#"{{"v":1,"navidrome":{}}}"#,
                n("https://:8080", Some("u"), TOKEN)
            ),
        ];
        for text in refused {
            assert!(decode(&text).is_err(), "{text}");
        }
    }

    #[test]
    fn memory_store_keeps_and_forgets() {
        let mut store = MemorySetupStore::default();
        assert_eq!(store.load(), None);
        store.save(WatchSetup { navidrome: login() });
        assert_eq!(store.load().unwrap().navidrome, login());
        store.clear();
        assert_eq!(store.load(), None);
    }
}
