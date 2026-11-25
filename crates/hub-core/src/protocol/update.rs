//! Updating the watch app from the phone, over the Wear OS data layer.
//!
//! Port of `wear/core/.../UpdateProtocol.kt`. The phone's side is `mobile/src/services/watchUpdateProtocol.ts` and
//! `watchUpdate.ts`.
//!
//! - the phone downloads the watch APK from the GitHub release and opens a channel to the watch on [`APK_PATH`];
//!   what it writes is one line of JSON (an [`UpdateHeader`]: the version, the size, the SHA-256) and then the APK;
//! - the watch checks the header, keeps the bytes, checks them against the header and the APK's own manifest and
//!   signature, and hands the file to Android's package installer;
//! - the watch tells the phone how it goes, in messages on [`STATUS_PATH`] (an [`UpdateStatus`]).

use std::fmt;

use serde_json::{Map, Value};

pub const VERSION: i64 = 1;
pub const PREFIX: &str = "/selfhost/update";
pub const APK_PATH: &str = "/selfhost/update/apk";
pub const STATUS_PATH: &str = "/selfhost/update/status";
/// The phone asks which version of the app the watch has; the watch answers with a status ([`UpdateState::Version`]).
pub const ASK_PATH: &str = "/selfhost/update/ask";

/// The header is one short line: anything longer is not one of ours.
pub const MAX_HEADER_BYTES: usize = 1024;
/// The watch APK is about 3.5 MB; this is room to grow, and a limit on what a confused sender can fill the watch with.
pub const MAX_APK_BYTES: i64 = 40 * 1024 * 1024;

/// A status message is cut to this many characters.
const MAX_MESSAGE_CHARS: usize = 300;

/// What the phone says about the APK it is about to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateHeader {
    pub version_name: String,
    pub version_code: i64,
    pub size: i64,
    /// Lowercase hex.
    pub sha256: String,
    pub reinstall: bool,
}

/// What the watch says about an update: how far it got, or why it will not go on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateState {
    /// The whole APK arrived and matches what was announced: it is being handed to the installer.
    Received,
    /// Android is asking the person wearing the watch to confirm (a notification was posted).
    Confirm,
    /// The new version is running: sent by the new version itself, as soon as it starts.
    Installed,
    /// Which version the app is, in answer to the phone's question.
    Version,
    /// The watch will not take it; the reason says why, before anything was transferred.
    Refused,
    /// It went wrong on the way; the message says how.
    Failed,
}

impl UpdateState {
    pub const ALL: [Self; 6] = [
        Self::Received,
        Self::Confirm,
        Self::Installed,
        Self::Version,
        Self::Refused,
        Self::Failed,
    ];

    pub fn wire(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Confirm => "confirm",
            Self::Installed => "installed",
            Self::Version => "version",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.wire() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateRefusal {
    /// The watch has this version or a newer one (and no reinstall was asked for).
    UpToDate,
    /// The app may not install apps ("install unknown apps"), and the watch may have no screen to allow it on.
    NotAllowed,
    /// Not enough room on the watch for the file and the installer's copy of it.
    NoSpace,
    /// The header was not one the watch understands.
    BadHeader,
    /// Another update is being received or installed.
    Busy,
}

impl UpdateRefusal {
    pub const ALL: [Self; 5] = [
        Self::UpToDate,
        Self::NotAllowed,
        Self::NoSpace,
        Self::BadHeader,
        Self::Busy,
    ];

    pub fn wire(self) -> &'static str {
        match self {
            Self::UpToDate => "up-to-date",
            Self::NotAllowed => "not-allowed",
            Self::NoSpace => "no-space",
            Self::BadHeader => "bad-header",
            Self::Busy => "busy",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub version_name: Option<String>,
    pub version_code: Option<i64>,
    pub reason: Option<UpdateRefusal>,
    pub message: Option<String>,
}

impl UpdateStatus {
    pub fn new(state: UpdateState) -> Self {
        Self {
            state,
            version_name: None,
            version_code: None,
            reason: None,
            message: None,
        }
    }
}

/// Why a header was refused, in the words the watch shows (French, like the rest of the apps).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateFormatError(pub &'static str);

impl fmt::Display for UpdateFormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for UpdateFormatError {}

pub fn encode_header(header: &UpdateHeader) -> String {
    let mut obj = Map::new();
    obj.insert("v".into(), VERSION.into());
    obj.insert("versionName".into(), header.version_name.as_str().into());
    obj.insert("versionCode".into(), header.version_code.into());
    obj.insert("size".into(), header.size.into());
    obj.insert("sha256".into(), header.sha256.as_str().into());
    obj.insert("reinstall".into(), header.reinstall.into());
    Value::Object(obj).to_string()
}

/// Reads and checks the header line; anything that is not exactly what it should be is refused.
pub fn decode_header(line: &str) -> Result<UpdateHeader, UpdateFormatError> {
    let unreadable = UpdateFormatError("en-tête illisible");
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) else {
        return Err(unreadable);
    };
    if whole_number(&obj, "v") != Some(VERSION) {
        return Err(UpdateFormatError("version de mise à jour inconnue"));
    }
    let version_name = text(&obj, "versionName")
        .filter(|n| is_version_name(n))
        .ok_or(UpdateFormatError("version invalide"))?;
    let version_code = whole_number(&obj, "versionCode")
        .filter(|c| (1..=2_000_000_000).contains(c))
        .ok_or(UpdateFormatError("numéro de version invalide"))?;
    let size = whole_number(&obj, "size")
        .filter(|s| (1..=MAX_APK_BYTES).contains(s))
        .ok_or(UpdateFormatError("taille invalide"))?;
    let sha256 = text(&obj, "sha256")
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or(UpdateFormatError("empreinte invalide"))?;
    let reinstall = matches!(obj.get("reinstall"), Some(Value::Bool(true)));
    Ok(UpdateHeader {
        version_name: version_name.to_owned(),
        version_code,
        size,
        sha256: sha256.to_lowercase(),
        reinstall,
    })
}

pub fn encode_status(status: &UpdateStatus) -> String {
    let mut obj = Map::new();
    obj.insert("v".into(), VERSION.into());
    obj.insert("state".into(), status.state.wire().into());
    if let Some(name) = &status.version_name {
        obj.insert("versionName".into(), name.as_str().into());
    }
    if let Some(code) = status.version_code {
        obj.insert("versionCode".into(), code.into());
    }
    if let Some(reason) = status.reason {
        obj.insert("reason".into(), reason.wire().into());
    }
    if let Some(message) = &status.message {
        let cut: String = message.chars().take(MAX_MESSAGE_CHARS).collect();
        obj.insert("message".into(), cut.into());
    }
    Value::Object(obj).to_string()
}

/// Whether an announced update is one the watch should take, from what the watch knows about itself.
/// `None` when it can go on; otherwise why not.
pub fn refusal(
    header: &UpdateHeader,
    installed_code: i64,
    free_bytes: i64,
    may_install: bool,
) -> Option<UpdateRefusal> {
    // The file is kept, then copied into the installer's session: room for it twice over.
    const SPACE_FACTOR: i64 = 2;
    if header.version_code < installed_code
        || (header.version_code == installed_code && !header.reinstall)
    {
        return Some(UpdateRefusal::UpToDate);
    }
    if !may_install {
        return Some(UpdateRefusal::NotAllowed);
    }
    if free_bytes < header.size.saturating_mul(SPACE_FACTOR) {
        return Some(UpdateRefusal::NoSpace);
    }
    None
}

/// A JSON string only (not a number in text form).
fn text<'a>(obj: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    obj.get(name)?.as_str()
}

/// A JSON number with no fractional part (`20502.0` counts, `20502.5` and `"20502"` do not).
fn whole_number(obj: &Map<String, Value>, name: &str) -> Option<i64> {
    let Value::Number(n) = obj.get(name)? else {
        return None;
    };
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    let f = n.as_f64()?;
    (f.fract() == 0.0 && f.abs() < 9.0e18).then_some(f as i64)
}

/// Three groups of one to four ASCII digits, separated by dots.
fn is_version_name(name: &str) -> bool {
    let groups: Vec<&str> = name.split('.').collect();
    groups.len() == 3
        && groups
            .iter()
            .all(|g| (1..=4).contains(&g.len()) && g.bytes().all(|c| c.is_ascii_digit()))
}

// Ported from wear/core/src/test/kotlin/com/selfhosthub/wear/core/UpdateProtocolTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    const PHONE_UPDATE_HEADER: &str =
        include_str!("../../../../wear/core/src/test/resources/phone-update-header.json");
    const WATCH_UPDATE_STATUSES: &str =
        include_str!("../../../../wear/core/src/test/resources/watch-update-statuses.json");

    const SHA: &str = "a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    fn header() -> UpdateHeader {
        UpdateHeader {
            version_name: "2.5.2".into(),
            version_code: 20502,
            size: 3_562_118,
            sha256: SHA.into(),
            reinstall: false,
        }
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn a_header_is_written_and_read_back_the_same() {
        assert_eq!(decode_header(&encode_header(&header())), Ok(header()));
        let reinstall = UpdateHeader {
            reinstall: true,
            ..header()
        };
        assert_eq!(decode_header(&encode_header(&reinstall)), Ok(reinstall));
    }

    #[test]
    fn golden_the_header_the_phone_writes_is_read() {
        assert_eq!(decode_header(PHONE_UPDATE_HEADER.trim()), Ok(header()));
    }

    #[test]
    fn golden_the_header_written_here_is_the_sample_the_phone_is_held_to() {
        assert_eq!(json(&encode_header(&header())), json(PHONE_UPDATE_HEADER));
    }

    #[test]
    fn an_uppercase_digest_is_read_as_lowercase_and_a_missing_reinstall_is_false() {
        let read = decode_header(&format!(
            r#"{{"v":1,"versionName":"2.5.2","versionCode":20502,"size":10,"sha256":"{}"}}"#,
            SHA.to_uppercase()
        ))
        .unwrap();
        assert_eq!(read.sha256, SHA);
        assert!(!read.reinstall);
    }

    #[test]
    fn a_whole_number_written_with_a_decimal_point_is_accepted() {
        let read = decode_header(&format!(
            r#"{{"v":1.0,"versionName":"2.5.2","versionCode":20502.0,"size":10,"sha256":"{SHA}"}}"#
        ))
        .unwrap();
        assert_eq!(read.version_code, 20502);
    }

    #[test]
    fn headers_that_are_not_exactly_right_are_refused() {
        let good = format!(
            r#""v":1,"versionName":"2.5.2","versionCode":20502,"size":10,"sha256":"{SHA}""#
        );
        let whole = format!("{{{good}}}");
        let bad = [
            String::new(),
            "garbage".into(),
            "[]".into(),
            whole.replace(r#""v":1"#, r#""v":2"#),
            whole.replace(r#""v":1,"#, ""),
            whole.replace("2.5.2", "2.5"),
            whole.replace("2.5.2", "2.5.2-beta"),
            whole.replace("2.5.2", "10000.0.0"),
            whole.replace("20502", "0"),
            whole.replace("20502", "3000000000"),
            whole.replace("20502", "20502.5"),
            whole.replace("20502", "\"20502\""),
            whole.replace(r#""size":10"#, r#""size":0"#),
            whole.replace(r#""size":10"#, r#""size":-5"#),
            whole.replace(r#""size":10"#, &format!(r#""size":{}"#, MAX_APK_BYTES + 1)),
            whole.replace(SHA, &SHA[..63]),
            whole.replace(SHA, &"z".repeat(64)),
        ];
        for text in bad {
            assert!(decode_header(&text).is_err(), "{text}");
        }
    }

    #[test]
    fn golden_the_status_messages_written_here_are_the_ones_in_the_sample_file() {
        let samples = json(WATCH_UPDATE_STATUSES);
        let status =
            |state, name: Option<&str>, code: Option<i64>, reason, message: Option<&str>| {
                json(&encode_status(&UpdateStatus {
                    state,
                    version_name: name.map(Into::into),
                    version_code: code,
                    reason,
                    message: message.map(Into::into),
                }))
            };
        let v = Some("2.5.2");
        let c = Some(20502);
        assert_eq!(
            samples["received"],
            status(UpdateState::Received, v, c, None, None)
        );
        assert_eq!(
            samples["confirm"],
            status(
                UpdateState::Confirm,
                None,
                None,
                None,
                Some("Confirmez la mise à jour sur la montre")
            )
        );
        assert_eq!(
            samples["installed"],
            status(UpdateState::Installed, v, c, None, None)
        );
        assert_eq!(
            samples["version"],
            status(UpdateState::Version, v, c, None, None)
        );
        assert_eq!(
            samples["refusedNotAllowed"],
            status(
                UpdateState::Refused,
                v,
                c,
                Some(UpdateRefusal::NotAllowed),
                Some("L’application n’a pas le droit d’installer des applications sur la montre")
            )
        );
        assert_eq!(
            samples["failed"],
            status(
                UpdateState::Failed,
                v,
                c,
                None,
                Some("Fichier endommagé pendant le transfert")
            )
        );
        assert_eq!(
            samples.as_object().unwrap().len(),
            6,
            "every sample is covered"
        );
    }

    #[test]
    fn a_status_message_is_cut_to_a_length_that_fits_a_message() {
        let status = UpdateStatus {
            message: Some("x".repeat(5_000)),
            ..UpdateStatus::new(UpdateState::Failed)
        };
        let written = json(&encode_status(&status));
        assert_eq!(written["message"].as_str().unwrap().chars().count(), 300);
    }

    #[test]
    fn states_and_reasons_use_the_names_the_phone_knows() {
        let states: Vec<&str> = UpdateState::ALL.iter().map(|s| s.wire()).collect();
        assert_eq!(
            states,
            [
                "received",
                "confirm",
                "installed",
                "version",
                "refused",
                "failed"
            ]
        );
        let reasons: Vec<&str> = UpdateRefusal::ALL.iter().map(|r| r.wire()).collect();
        assert_eq!(
            reasons,
            [
                "up-to-date",
                "not-allowed",
                "no-space",
                "bad-header",
                "busy"
            ]
        );
        assert_eq!(
            UpdateState::from_wire("refused"),
            Some(UpdateState::Refused)
        );
        assert_eq!(UpdateState::from_wire("exploded"), None);
    }

    // --- What the watch will take ---

    fn refuse(
        code: i64,
        reinstall: bool,
        installed: i64,
        free: i64,
        may: bool,
    ) -> Option<UpdateRefusal> {
        let h = UpdateHeader {
            version_code: code,
            reinstall,
            ..header()
        };
        refusal(&h, installed, free, may)
    }

    const FREE: i64 = 100_000_000;

    #[test]
    fn a_newer_version_is_taken() {
        assert_eq!(refuse(20502, false, 20500, FREE, true), None);
    }

    #[test]
    fn the_same_or_an_older_version_is_not_unless_reinstalling_the_same() {
        assert_eq!(
            refuse(20500, false, 20500, FREE, true),
            Some(UpdateRefusal::UpToDate)
        );
        assert_eq!(
            refuse(20400, false, 20500, FREE, true),
            Some(UpdateRefusal::UpToDate)
        );
        assert_eq!(
            refuse(20400, true, 20500, FREE, true),
            Some(UpdateRefusal::UpToDate)
        );
        assert_eq!(refuse(20500, true, 20500, FREE, true), None);
    }

    #[test]
    fn without_the_right_to_install_or_room_for_the_file_twice_it_is_not_taken() {
        let size = header().size;
        assert_eq!(
            refuse(20502, false, 20500, FREE, false),
            Some(UpdateRefusal::NotAllowed)
        );
        assert_eq!(
            refuse(20502, false, 20500, size * 2 - 1, true),
            Some(UpdateRefusal::NoSpace)
        );
        assert_eq!(refuse(20502, false, 20500, size * 2, true), None);
    }

    #[test]
    fn being_up_to_date_is_said_before_permission_or_room() {
        assert_eq!(
            refuse(20500, false, 20500, 0, false),
            Some(UpdateRefusal::UpToDate)
        );
        assert_eq!(
            refuse(20502, false, 20500, 0, false),
            Some(UpdateRefusal::NotAllowed)
        );
    }

    #[test]
    fn the_paths_sit_under_the_prefix_the_manifests_listen_on() {
        for path in [APK_PATH, STATUS_PATH, ASK_PATH] {
            assert!(path.starts_with(PREFIX), "{path}");
        }
    }
}
