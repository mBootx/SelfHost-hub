//! The live link between the watch and the phone app, over the Wear OS data layer.
//!
//! Port of `wear/core/src/main/kotlin/com/selfhosthub/wear/core/LinkProtocol.kt` (the watch's side). The phone's
//! side is `mobile/src/services/watchLink.ts`. The watch never talks to the PC: the phone is the only thing that
//! does, and it passes on what the watch needs.
//!
//! - the watch sends a request, and the phone answers with a snapshot: its own player, and the players the PC's
//!   hub lists;
//! - the watch sends commands, which the phone applies to its own player or forwards to the hub;
//! - the phone sends a fresh snapshot whenever something worth showing changes;
//! - when the phone app's process runs without its UI, the phone says so at once ("closed").

use serde_json::{Map, Value, json};

use super::Lenient;

pub const VERSION: i64 = 1;
pub const PREFIX: &str = "/selfhost/link";
pub const REQUEST_PATH: &str = "/selfhost/link/request";
pub const SNAPSHOT_PATH: &str = "/selfhost/link/snapshot";
pub const COMMAND_PATH: &str = "/selfhost/link/command";
pub const CLOSED_PATH: &str = "/selfhost/link/closed";

/// Watch to phone: "open me". Android does not let the watch app open its own screen from the background; the
/// phone can, through the Wear OS companion, with this address, which the watch app's activity answers.
pub const OPEN_PATH: &str = "/selfhost/link/open";
pub const OPEN_URI: &str = "selfhosthub-watch://player";

/// What the watch calls the phone's own player.
pub const PHONE_ID: &str = "local";
/// What the watch calls the PC's player (the hub names itself so).
pub const HUB_ID: &str = "hub";

/// The phone's name when its snapshot gives none.
const DEFAULT_PHONE_NAME: &str = "Téléphone";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RepeatMode {
    #[default]
    Off,
    All,
    One,
}

impl RepeatMode {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::All => "all",
            Self::One => "one",
        }
    }

    /// Unknown or missing values mean off.
    pub fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("all") => Self::All,
            Some("one") => Self::One,
            _ => Self::Off,
        }
    }

    /// The mode the repeat button goes to next.
    pub fn next(self) -> Self {
        match self {
            Self::Off => Self::All,
            Self::All => Self::One,
            Self::One => Self::Off,
        }
    }
}

/// The song a player is on, as the players describe it (seconds for the duration).
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteSong {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub cover_art: Option<String>,
    pub duration: f64,
}

/// One player's state: the phone, a PC, another phone. `volume` runs from 0 to 1, times are in seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceState {
    pub song: Option<RemoteSong>,
    pub is_playing: bool,
    pub current_time: f64,
    pub duration: f64,
    pub shuffle: bool,
    pub repeat_mode: RepeatMode,
    pub volume: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSummary {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
}

/// How the phone stands with the PC, as the phone tells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcState {
    Connected,
    Connecting,
    Disconnected,
    Off,
    Unpaired,
    Error,
}

impl PcState {
    /// Unknown or missing values mean disconnected.
    pub fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("connected") => Self::Connected,
            Some("connecting") => Self::Connecting,
            Some("off") => Self::Off,
            Some("unpaired") => Self::Unpaired,
            Some("error") => Self::Error,
            _ => Self::Disconnected,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PcLink {
    pub state: PcState,
    pub name: Option<String>,
    pub message: Option<String>,
}

/// What the phone tells the watch: the players, and how the phone stands with the PC. The phone's own player is
/// first. `states` keeps the order the phone sent.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub phone_name: String,
    pub pc: PcLink,
    pub devices: Vec<DeviceSummary>,
    pub states: Vec<(String, DeviceState)>,
}

impl Snapshot {
    pub fn state(&self, device_id: &str) -> Option<&DeviceState> {
        self.states
            .iter()
            .find(|(id, _)| id == device_id)
            .map(|(_, s)| s)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LinkMessage {
    Snap(Snapshot),
    /// The phone app's process is there but its UI is not running.
    Closed,
    /// A message of a version this app does not know: the phone and the watch need to be updated together.
    UnsupportedVersion(Option<i64>),
    Unknown(String),
}

/// The watch app's version, sent with each request so the phone knows whether to offer an update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppVersion {
    pub name: String,
    pub code: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Song,
    Album,
    Playlist,
}

impl MediaKind {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Song => "song",
            Self::Album => "album",
            Self::Playlist => "playlist",
        }
    }
}

/// Whether media replaces the queue, goes next, or goes last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlayMode {
    #[default]
    Now,
    Next,
    Last,
}

impl PlayMode {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Now => "now",
            Self::Next => "next",
            Self::Last => "last",
        }
    }
}

/// What can be asked of a player. The names are the phone's: it ignores any other.
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerCommand {
    Toggle,
    Play,
    Pause,
    Next,
    Prev,
    Seek {
        seconds: f64,
    },
    /// Clamped to 0..=1 on the wire: the phone's volume runs from 0 to 1, whatever the watch shows.
    SetVolume {
        volume: f64,
    },
    ToggleShuffle,
    SetRepeatMode(RepeatMode),
    /// Asks the phone to play something from its Navidrome: the whole album or playlist (from the song `song_id`,
    /// or the position `index`, when given) or one song. It always plays on the phone, whichever player the watch
    /// was controlling.
    PlayMedia {
        kind: MediaKind,
        id: String,
        index: Option<i64>,
        song_id: Option<String>,
        mode: PlayMode,
    },
}

impl PlayerCommand {
    pub fn action(&self) -> &'static str {
        match self {
            Self::Toggle => "toggle",
            Self::Play => "play",
            Self::Pause => "pause",
            Self::Next => "next",
            Self::Prev => "prev",
            Self::Seek { .. } => "seek",
            Self::SetVolume { .. } => "setVolume",
            Self::ToggleShuffle => "toggleShuffle",
            Self::SetRepeatMode(_) => "setRepeatMode",
            Self::PlayMedia { .. } => "playMedia",
        }
    }

    fn payload(&self) -> Option<Value> {
        match self {
            Self::Seek { seconds } => Some(json!({ "seconds": seconds })),
            Self::SetVolume { volume } => Some(json!({ "volume": volume.clamp(0.0, 1.0) })),
            Self::SetRepeatMode(mode) => Some(json!({ "mode": mode.wire() })),
            Self::PlayMedia {
                kind,
                id,
                index,
                song_id,
                mode,
            } => {
                let mut body = Map::new();
                body.insert("kind".into(), kind.wire().into());
                body.insert("id".into(), id.as_str().into());
                if let Some(index) = index {
                    body.insert("index".into(), (*index).into());
                }
                if let Some(song_id) = song_id {
                    body.insert("songId".into(), song_id.as_str().into());
                }
                body.insert("mode".into(), mode.wire().into());
                Some(Value::Object(body))
            }
            _ => None,
        }
    }
}

/// What the watch sends to ask for a snapshot. It says which version of the app it is: that is how the phone
/// knows whether to offer an update. A phone that does not read it simply ignores it.
pub fn request(app: Option<&AppVersion>) -> String {
    let mut obj = Map::new();
    obj.insert("v".into(), VERSION.into());
    if let Some(app) = app {
        obj.insert("app".into(), json!({ "name": app.name, "code": app.code }));
    }
    Value::Object(obj).to_string()
}

pub fn command(target_id: &str, command: &PlayerCommand) -> String {
    let mut obj = Map::new();
    obj.insert("v".into(), VERSION.into());
    obj.insert("targetId".into(), target_id.into());
    obj.insert("action".into(), command.action().into());
    if let Some(payload) = command.payload() {
        obj.insert("payload".into(), payload);
    }
    Value::Object(obj).to_string()
}

/// Reads a message the phone sent on `path`. Nothing that arrives is trusted to be well formed.
pub fn parse(path: &str, text: &str) -> LinkMessage {
    if path == CLOSED_PATH {
        return LinkMessage::Closed;
    }
    if path != SNAPSHOT_PATH {
        return LinkMessage::Unknown(path.to_owned());
    }
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) else {
        return LinkMessage::Unknown(path.to_owned());
    };
    let version = obj.int("v");
    if version != Some(VERSION) {
        return LinkMessage::UnsupportedVersion(version);
    }

    let devices: Vec<DeviceSummary> = match obj.get("devices") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|element| {
                let device = element.as_object()?;
                let id = device.string("deviceId").filter(|id| !id.is_empty())?;
                Some(DeviceSummary {
                    device_name: device.string("deviceName").unwrap_or_else(|| id.clone()),
                    platform: device
                        .string("platform")
                        .unwrap_or_else(|| "mobile".to_owned()),
                    device_id: id,
                })
            })
            .collect(),
        _ => Vec::new(),
    };

    let states = match obj.get("states") {
        Some(Value::Object(states)) => states
            .iter()
            .filter_map(|(id, element)| Some((id.clone(), parse_state(element.as_object()?))))
            .collect(),
        _ => Vec::new(),
    };

    let pc = match obj.get("pc") {
        Some(Value::Object(pc)) => PcLink {
            state: PcState::from_wire(pc.string("state").as_deref()),
            name: pc.string("name"),
            message: pc.string("message"),
        },
        _ => PcLink {
            state: PcState::Disconnected,
            name: None,
            message: None,
        },
    };

    let phone_name = obj
        .string("phone")
        .or_else(|| devices.first().map(|d| d.device_name.clone()))
        .unwrap_or_else(|| DEFAULT_PHONE_NAME.to_owned());

    LinkMessage::Snap(Snapshot {
        phone_name,
        pc,
        devices,
        states,
    })
}

fn parse_state(obj: &Map<String, Value>) -> DeviceState {
    let song = match obj.get("song") {
        Some(Value::Object(s)) => s.string("id").map(|id| RemoteSong {
            id,
            title: s.string("title").unwrap_or_default(),
            artist: s.string("artist").unwrap_or_default(),
            album: s.string("album"),
            album_id: s.string("albumId"),
            cover_art: s.string("coverArt"),
            duration: s.f64_or("duration", 0.0),
        }),
        _ => None,
    };
    let song_duration = song.as_ref().map_or(0.0, |s| s.duration);
    DeviceState {
        is_playing: obj.bool_or("isPlaying", false),
        current_time: obj.f64_or("currentTime", 0.0).max(0.0),
        duration: obj.f64_or("duration", song_duration).max(0.0),
        shuffle: obj.bool_or("shuffle", false),
        repeat_mode: RepeatMode::from_wire(obj.string("repeatMode").as_deref()),
        volume: obj.f64_or("volume", 1.0).clamp(0.0, 1.0),
        song,
    }
}

// Ported from wear/core/src/test/kotlin/com/selfhosthub/wear/core/ProtocolTest.kt (LinkCodecTest), plus golden
// tests against the samples both the Kotlin and the TypeScript sides read.
#[cfg(test)]
mod tests {
    use super::*;

    const PHONE_SNAPSHOT: &str =
        include_str!("../../../../wear/core/src/test/resources/phone-snapshot.json");
    const WATCH_REQUEST: &str =
        include_str!("../../../../wear/core/src/test/resources/watch-request.json");
    const WATCH_COMMANDS: &str =
        include_str!("../../../../wear/core/src/test/resources/watch-commands.json");

    fn snapshot(json: &str) -> Snapshot {
        match parse(SNAPSHOT_PATH, json) {
            LinkMessage::Snap(s) => s,
            other => panic!("not a snapshot: {other:?}"),
        }
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn summary(id: &str, name: &str, platform: &str) -> DeviceSummary {
        DeviceSummary {
            device_id: id.into(),
            device_name: name.into(),
            platform: platform.into(),
        }
    }

    #[test]
    fn a_snapshot_is_read_as_the_phone_sends_it() {
        let s = snapshot(
            r#"{"v":1,"phone":"Pixel","pc":{"state":"connected","name":"PC de Max"},
               "devices":[{"deviceId":"local","deviceName":"Pixel","platform":"mobile"},{"deviceId":"hub","deviceName":"PC de Max","platform":"desktop"}],
               "states":{"local":{"song":{"id":"s1","title":"Titre","artist":"Artiste","album":"Album","albumId":"a1","coverArt":"al-1","duration":215},
                         "isPlaying":true,"currentTime":42.5,"duration":215,"shuffle":true,"repeatMode":"all","volume":0.6},
                         "hub":{"song":null,"isPlaying":false,"currentTime":0,"duration":0,"shuffle":false,"repeatMode":"off","volume":1}}}"#,
        );
        assert_eq!(s.phone_name, "Pixel");
        assert_eq!(
            s.pc,
            PcLink {
                state: PcState::Connected,
                name: Some("PC de Max".into()),
                message: None
            }
        );
        assert_eq!(
            s.devices,
            vec![
                summary("local", "Pixel", "mobile"),
                summary("hub", "PC de Max", "desktop")
            ]
        );
        let phone = s.state("local").unwrap();
        assert_eq!(
            phone.song,
            Some(RemoteSong {
                id: "s1".into(),
                title: "Titre".into(),
                artist: "Artiste".into(),
                album: Some("Album".into()),
                album_id: Some("a1".into()),
                cover_art: Some("al-1".into()),
                duration: 215.0,
            })
        );
        assert!(phone.is_playing);
        assert_eq!(phone.current_time, 42.5);
        assert_eq!(phone.duration, 215.0);
        assert!(phone.shuffle);
        assert_eq!(phone.repeat_mode, RepeatMode::All);
        assert!((phone.volume - 0.6).abs() < 1e-9);
        assert_eq!(s.state("hub").unwrap().song, None);
    }

    #[test]
    fn odd_values_are_read_with_safe_defaults() {
        let s = snapshot(
            r#"{"v":1,"devices":[{"deviceId":"local","deviceName":"P"}],
               "states":{"local":{"song":null,"isPlaying":"yes","currentTime":-5,"volume":7,"repeatMode":"sideways"}}}"#,
        );
        let state = s.state("local").unwrap();
        assert_eq!(state.song, None);
        assert!(!state.is_playing);
        assert_eq!(state.current_time, 0.0);
        assert_eq!(state.volume, 1.0);
        assert_eq!(state.repeat_mode, RepeatMode::Off);
    }

    #[test]
    fn a_device_without_an_id_is_skipped_one_without_a_name_takes_its_id() {
        let s = snapshot(
            r#"{"v":1,"devices":[{"deviceName":"nameless"},{"deviceId":""},{"deviceId":"p1"},"junk"],"states":{}}"#,
        );
        assert_eq!(s.devices, vec![summary("p1", "p1", "mobile")]);
    }

    #[test]
    fn the_phone_name_falls_back_on_its_list_entry_then_a_default() {
        assert_eq!(
            snapshot(
                r#"{"v":1,"devices":[{"deviceId":"local","deviceName":"Pixel"}],"states":{}}"#
            )
            .phone_name,
            "Pixel"
        );
        assert_eq!(
            snapshot(r#"{"v":1,"devices":[],"states":{}}"#).phone_name,
            "Téléphone"
        );
    }

    #[test]
    fn the_pc_link_is_read_and_anything_unknown_means_disconnected() {
        let pc = |json: &str| {
            snapshot(&format!(
                r#"{{"v":1,"devices":[],"states":{{}},"pc":{json}}}"#
            ))
            .pc
        };
        let link = |state, message: Option<&str>| PcLink {
            state,
            name: None,
            message: message.map(Into::into),
        };
        assert_eq!(
            pc(r#"{"state":"error","message":"PC introuvable"}"#),
            link(PcState::Error, Some("PC introuvable"))
        );
        assert_eq!(pc(r#"{"state":"off"}"#), link(PcState::Off, None));
        assert_eq!(pc(r#"{"state":"unpaired"}"#), link(PcState::Unpaired, None));
        assert_eq!(
            pc(r#"{"state":"connecting"}"#),
            link(PcState::Connecting, None)
        );
        assert_eq!(
            pc(r#"{"state":"something new"}"#),
            link(PcState::Disconnected, None)
        );
        assert_eq!(
            snapshot(r#"{"v":1,"devices":[],"states":{}}"#).pc,
            link(PcState::Disconnected, None)
        );
    }

    #[test]
    fn a_snapshot_of_another_version_is_not_read() {
        assert_eq!(
            parse(SNAPSHOT_PATH, r#"{"v":2,"devices":[],"states":{}}"#),
            LinkMessage::UnsupportedVersion(Some(2))
        );
        assert_eq!(
            parse(SNAPSHOT_PATH, r#"{"devices":[],"states":{}}"#),
            LinkMessage::UnsupportedVersion(None)
        );
        assert_eq!(
            parse(SNAPSHOT_PATH, r#"{"v":"one"}"#),
            LinkMessage::UnsupportedVersion(None)
        );
    }

    #[test]
    fn closed_means_closed_and_what_is_not_a_snapshot_is_unknown() {
        assert_eq!(parse(CLOSED_PATH, r#"{"v":1}"#), LinkMessage::Closed);
        assert_eq!(parse(CLOSED_PATH, "whatever"), LinkMessage::Closed);
        assert!(matches!(
            parse(SNAPSHOT_PATH, "not json"),
            LinkMessage::Unknown(_)
        ));
        assert!(matches!(
            parse(SNAPSHOT_PATH, "[1,2]"),
            LinkMessage::Unknown(_)
        ));
        assert_eq!(
            parse("/selfhost/link/other", "{}"),
            LinkMessage::Unknown("/selfhost/link/other".into())
        );
    }

    #[test]
    fn the_request_names_the_version_and_nothing_else() {
        assert_eq!(json(&request(None)), json!({ "v": 1 }));
    }

    #[test]
    fn commands_carry_the_phone_action_names_and_payloads() {
        let cmd = |target: &str, c: PlayerCommand| json(&command(target, &c));

        assert_eq!(cmd("local", PlayerCommand::Toggle)["v"], 1);
        assert_eq!(cmd("local", PlayerCommand::Toggle)["action"], "toggle");
        assert_eq!(cmd("hub", PlayerCommand::Next)["targetId"], "hub");
        assert!(cmd("hub", PlayerCommand::Next).get("payload").is_none());
        assert_eq!(
            cmd("hub", PlayerCommand::Seek { seconds: 93.0 })["payload"]["seconds"],
            93.0
        );
        assert_eq!(
            cmd("hub", PlayerCommand::SetVolume { volume: 4.0 })["payload"]["volume"],
            1.0
        );
        assert_eq!(
            cmd("local", PlayerCommand::SetRepeatMode(RepeatMode::One))["payload"]["mode"],
            "one"
        );

        let play = cmd(
            "local",
            PlayerCommand::PlayMedia {
                kind: MediaKind::Album,
                id: "al-1".into(),
                index: Some(3),
                song_id: None,
                mode: PlayMode::Next,
            },
        );
        assert_eq!(play["action"], "playMedia");
        assert_eq!(
            play["payload"],
            json!({ "kind": "album", "id": "al-1", "index": 3, "mode": "next" })
        );
    }

    #[test]
    fn the_repeat_button_cycles_off_all_one() {
        assert_eq!(RepeatMode::Off.next(), RepeatMode::All);
        assert_eq!(RepeatMode::All.next(), RepeatMode::One);
        assert_eq!(RepeatMode::One.next(), RepeatMode::Off);
    }

    // --- Golden samples shared with the Kotlin and TypeScript tests ---

    #[test]
    fn golden_the_phone_snapshot_sample_is_read_in_full() {
        let s = snapshot(PHONE_SNAPSHOT);
        assert_eq!(s.phone_name, "Galaxy S25 Ultra");
        assert_eq!(
            s.pc,
            PcLink {
                state: PcState::Connected,
                name: Some("PC de Maxime".into()),
                message: None
            }
        );
        assert_eq!(
            s.devices,
            vec![
                summary("local", "Galaxy S25 Ultra", "mobile"),
                summary("hub", "PC de Maxime", "desktop"),
                summary("tablet-1", "Tablette salon", "mobile"),
            ]
        );
        let ids: Vec<&str> = s.states.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            ["local", "hub", "tablet-1"],
            "the phone's order is kept"
        );

        let local = s.state("local").unwrap();
        assert_eq!(local.song.as_ref().unwrap().title, "Nuits blanches");
        assert_eq!(local.song.as_ref().unwrap().duration, 243.5);
        assert!(local.is_playing);
        assert_eq!(local.current_time, 61.25);
        assert_eq!(local.volume, 0.8);

        let hub = s.state("hub").unwrap();
        assert_eq!(
            hub.song.as_ref().unwrap().album_id.as_deref(),
            Some("al-12")
        );
        assert!(hub.shuffle);
        assert_eq!(hub.repeat_mode, RepeatMode::All);
        assert_eq!(hub.duration, 187.0);

        let tablet = s.state("tablet-1").unwrap();
        assert_eq!(tablet.song, None);
        assert_eq!(tablet.volume, 1.0);
    }

    #[test]
    fn golden_the_request_matches_the_watch_sample() {
        let app = AppVersion {
            name: "2.5.2".into(),
            code: 20502,
        };
        assert_eq!(json(&request(Some(&app))), json(WATCH_REQUEST));
    }

    #[test]
    fn golden_every_command_matches_the_watch_sample() {
        let samples = json(WATCH_COMMANDS);
        let cases = [
            ("toggle", "local", PlayerCommand::Toggle),
            ("next", "hub", PlayerCommand::Next),
            ("prev", "hub", PlayerCommand::Prev),
            ("toggleShuffle", "local", PlayerCommand::ToggleShuffle),
            ("seek", "hub", PlayerCommand::Seek { seconds: 95.5 }),
            (
                "setVolume",
                "hub",
                PlayerCommand::SetVolume { volume: 0.64 },
            ),
            (
                "setRepeatMode",
                "local",
                PlayerCommand::SetRepeatMode(RepeatMode::All),
            ),
            (
                "playAlbum",
                "local",
                PlayerCommand::PlayMedia {
                    kind: MediaKind::Album,
                    id: "al-77".into(),
                    index: None,
                    song_id: Some("s-4412".into()),
                    mode: PlayMode::Now,
                },
            ),
            (
                "playSongNext",
                "local",
                PlayerCommand::PlayMedia {
                    kind: MediaKind::Song,
                    id: "s-9001".into(),
                    index: None,
                    song_id: None,
                    mode: PlayMode::Next,
                },
            ),
        ];
        let sample_names: Vec<&String> = samples.as_object().unwrap().keys().collect();
        assert_eq!(sample_names.len(), cases.len(), "every sample has a case");
        for (name, target, c) in cases {
            assert_eq!(json(&command(target, &c)), samples[name], "{name}");
        }
    }
}
