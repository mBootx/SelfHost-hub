//! What the PC's hub and the phones say to each other, on the wire.
//!
//! Port of the message shapes of `src/main/remoteHub.ts` (the PC's side) and `mobile/src/services/remoteControl.ts`
//! (the phone's side). Nothing here opens a socket: it only turns messages into text and text into messages, so
//! the same code serves the hub on the PC and the client on the phone, and the state machines of [`crate::hub`]
//! and [`crate::client`] are tested without a network.
//!
//! The conversation, all on one WebSocket (`ws://<ip>:51823`, one JSON object per text frame, `type` names it):
//!
//! 1. hub to phone: `challenge` (a fresh nonce, the hub's id and name);
//! 2. phone to hub: `hello` (its id, name, platform and the proof that it knows the pairing code, see
//!    `hub_core::pairing::proof_for`);
//! 3. hub to phone: `welcome`, accepted or not (and why);
//! 4. then both ways: `state` (what a player is doing), `command` (what a player is asked to do), and from the
//!    hub `devices` (who is connected).
//!
//! Besides the socket, the hub answers a plain `GET /selfhosthub/ping` so phones can find it by scanning their
//! subnet.
//!
//! Both sides read what arrives the way the TypeScript does: nothing is trusted to be well formed, a message that
//! does not make sense is ignored, and `String(x)` of the JavaScript (a number or an array where a string was
//! expected) is reproduced where the original relies on it.

use hub_core::pairing::is_private_address;
use hub_core::protocol::link::{DeviceState, DeviceSummary, RemoteSong, RepeatMode};
use serde_json::{Map, Value};

/// A JSON object, keys in the order they arrived (the hub relays what it was sent, key order included).
pub type JsonMap = Map<String, Value>;

/// The hub's port (`REMOTE_CONTROL_PORT` on both sides).
pub const PORT: u16 = 51823;
/// What the hub calls itself in the device list and in `welcome`.
pub const HUB_DEVICE_ID: &str = "hub";

/// The route phones probe to find a hub.
pub const PING_PATH: &str = "/selfhosthub/ping";
/// The `app` of the ping reply: anything else answering on the port is not a hub.
pub const PING_APP: &str = "selfhost-hub";
/// How long a phone waits for each address while scanning (`fetchWithTimeout(..., 400)`).
pub const PING_TIMEOUT_MS: u64 = 400;
/// How many addresses a phone probes at once.
pub const SCAN_CONCURRENCY: usize = 40;
/// A hub that gives no name is called this in the phone's list.
pub const DEFAULT_HUB_NAME: &str = "PC";

/// A connection that has not answered the challenge by then is dropped.
pub const HELLO_TIMEOUT_MS: u64 = 10_000;
/// The hub's `maxPayload`: a bigger frame closes the connection.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// A `hello` with a longer device id is refused. Counted in UTF-16 units, as JavaScript counts a string.
pub const MAX_DEVICE_ID_LEN: usize = 100;
/// A longer device name is cut. Counted in UTF-16 units.
pub const MAX_DEVICE_NAME_LEN: usize = 60;
/// What a phone is called when it sends no name.
pub const DEFAULT_CLIENT_NAME: &str = "Appareil";

/// The phone gives up on a handshake after this long.
pub const CONNECT_TIMEOUT_MS: u64 = 5_000;
/// A link to the PC that dropped is looked for again after this long.
pub const RECONNECT_DELAY_MS: u64 = 3_000;

/// What a phone may ask a player to do; any other action is ignored.
pub const COMMANDS: [&str; 9] = [
    "toggle",
    "play",
    "pause",
    "next",
    "prev",
    "seek",
    "setVolume",
    "toggleShuffle",
    "setRepeatMode",
];

// What the phone shows for each way the PC can turn it away or the connection can fail (verbatim).
pub const MSG_BAD_CODE: &str = "Code d'appairage incorrect";
pub const MSG_TOO_MANY_ATTEMPTS: &str = "Trop d'essais : réessayez dans quelques minutes";
pub const MSG_UPDATE_REQUIRED: &str = "Mettez l'application du PC à jour";
pub const MSG_REFUSED: &str = "Connexion refusée";
pub const MSG_TIMED_OUT: &str = "Connexion expirée";
pub const MSG_UNREACHABLE: &str = "Connexion impossible";
pub const MSG_CLOSED_BY_PC: &str = "Connexion refusée par le PC";

/// Where the websocket of a hub is.
pub fn ws_url(ip: &str, port: u16) -> String {
    format!("ws://{ip}:{port}")
}

/// What the phone and the PC say a device is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Desktop,
    Mobile,
}

impl Platform {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Mobile => "mobile",
        }
    }
}

/// Why a hub turned a phone away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The proof does not match the pairing code.
    BadCode,
    /// This address guessed wrong too often and is ignored for a while.
    TooManyAttempts,
    /// An older phone app, which sends no proof at all.
    UpdateRequired,
    /// Any other reason (`""` when the hub gave none).
    Other(String),
}

impl Rejection {
    pub fn wire(&self) -> &str {
        match self {
            Self::BadCode => "bad-code",
            Self::TooManyAttempts => "too-many-attempts",
            Self::UpdateRequired => "update-required",
            Self::Other(reason) => reason,
        }
    }

    pub fn from_wire(reason: &str) -> Self {
        match reason {
            "bad-code" => Self::BadCode,
            "too-many-attempts" => Self::TooManyAttempts,
            "update-required" => Self::UpdateRequired,
            other => Self::Other(other.to_owned()),
        }
    }

    /// What the phone shows (`HubRejected.message`).
    pub fn message(&self) -> &'static str {
        match self {
            Self::BadCode => MSG_BAD_CODE,
            Self::TooManyAttempts => MSG_TOO_MANY_ATTEMPTS,
            Self::UpdateRequired => MSG_UPDATE_REQUIRED,
            Self::Other(_) => MSG_REFUSED,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// What the phone sends the hub
// ---------------------------------------------------------------------------------------------------------

/// A phone's answer to the challenge, already read the way the hub reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    /// `""` when the message had no string id.
    pub device_id: String,
    /// `String(msg.deviceName ?? 'Appareil').slice(0, 60)`.
    pub device_name: String,
    pub platform: Platform,
    /// Only when the message had a string `proof`. Its absence is how an older app is told from a wrong guess.
    pub proof: Option<String>,
}

impl Hello {
    /// What a phone sends: `proof` is made by [`hub_core::pairing::proof_for`].
    pub fn encode(&self) -> String {
        let mut obj = JsonMap::new();
        obj.insert("type".into(), "hello".into());
        obj.insert("deviceId".into(), self.device_id.as_str().into());
        obj.insert("deviceName".into(), self.device_name.as_str().into());
        obj.insert("platform".into(), self.platform.wire().into());
        if let Some(proof) = &self.proof {
            obj.insert("proof".into(), proof.as_str().into());
        }
        Value::Object(obj).to_string()
    }
}

/// A command, as it travels: from a phone to the hub, from the hub to the phone that is the target.
///
/// The hub passes the very object it received on, extra fields included, so the whole thing is kept.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteCommand {
    raw: JsonMap,
}

impl RemoteCommand {
    /// `{ type: 'command', targetId, action, payload }`; a missing payload is left out, as `JSON.stringify` does.
    pub fn new(target_id: &str, action: &str, payload: Option<Value>) -> Self {
        let mut raw = JsonMap::new();
        raw.insert("type".into(), "command".into());
        raw.insert("targetId".into(), target_id.into());
        raw.insert("action".into(), action.into());
        if let Some(payload) = payload {
            raw.insert("payload".into(), payload);
        }
        Self { raw }
    }

    pub fn from_raw(raw: JsonMap) -> Self {
        Self { raw }
    }

    pub fn raw(&self) -> &JsonMap {
        &self.raw
    }

    pub fn encode(&self) -> String {
        Value::Object(self.raw.clone()).to_string()
    }

    pub fn action(&self) -> Option<&str> {
        self.raw.get("action").and_then(Value::as_str)
    }

    /// `String(msg.targetId)`: a missing id is the text "undefined", which no device has.
    pub fn target_id(&self) -> String {
        self.raw
            .get("targetId")
            .map_or_else(|| "undefined".to_owned(), js_string)
    }

    pub fn payload(&self) -> Option<&Value> {
        self.raw.get("payload")
    }

    /// Whether the hub lets this through: only playback controls are.
    pub fn is_allowed(&self) -> bool {
        self.action().is_some_and(|a| COMMANDS.contains(&a))
    }
}

/// What a phone may send once connected, as the hub reads it.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMessage {
    Hello(Hello),
    /// The whole object, whatever is in it: the hub keeps and relays it as it came.
    State(JsonMap),
    Command(RemoteCommand),
    /// Not JSON, not an object, or a type the hub does not know.
    Ignored,
}

/// Reads a frame a phone sent.
pub fn decode_client(text: &str) -> ClientMessage {
    let Some(msg) = parse_object(text) else {
        return ClientMessage::Ignored;
    };
    match msg.get("type").and_then(Value::as_str) {
        Some("hello") => ClientMessage::Hello(Hello {
            device_id: msg
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            device_name: truncate_utf16(
                &string_or(&msg, "deviceName", DEFAULT_CLIENT_NAME),
                MAX_DEVICE_NAME_LEN,
            ),
            platform: if msg.get("platform").and_then(Value::as_str) == Some("desktop") {
                Platform::Desktop
            } else {
                Platform::Mobile
            },
            proof: msg.get("proof").and_then(Value::as_str).map(str::to_owned),
        }),
        Some("state") => ClientMessage::State(msg),
        Some("command") => ClientMessage::Command(RemoteCommand::from_raw(msg)),
        _ => ClientMessage::Ignored,
    }
}

/// What a phone sends about its own player: `{ type: 'state', ...state }`, fields in the order the phone's
/// `currentStatePayload` writes them, and the song's optional fields left out when absent.
pub fn encode_state(state: &DeviceState) -> String {
    let mut obj = JsonMap::new();
    obj.insert("type".into(), "state".into());
    obj.extend(state_fields(state));
    Value::Object(obj).to_string()
}

fn state_fields(state: &DeviceState) -> JsonMap {
    let mut obj = JsonMap::new();
    obj.insert(
        "song".into(),
        state.song.as_ref().map_or(Value::Null, |song| {
            let mut s = JsonMap::new();
            s.insert("id".into(), song.id.as_str().into());
            s.insert("title".into(), song.title.as_str().into());
            s.insert("artist".into(), song.artist.as_str().into());
            if let Some(album) = &song.album {
                s.insert("album".into(), album.as_str().into());
            }
            if let Some(album_id) = &song.album_id {
                s.insert("albumId".into(), album_id.as_str().into());
            }
            if let Some(cover_art) = &song.cover_art {
                s.insert("coverArt".into(), cover_art.as_str().into());
            }
            s.insert("duration".into(), number(song.duration));
            Value::Object(s)
        }),
    );
    obj.insert("isPlaying".into(), state.is_playing.into());
    obj.insert("currentTime".into(), number(state.current_time));
    obj.insert("duration".into(), number(state.duration));
    obj.insert("shuffle".into(), state.shuffle.into());
    obj.insert("repeatMode".into(), state.repeat_mode.wire().into());
    obj.insert("volume".into(), number(state.volume));
    obj
}

/// What a player's state says, read leniently (a missing or odd field takes its default).
pub fn parse_device_state(state: &JsonMap) -> DeviceState {
    let song = match state.get("song") {
        Some(Value::Object(s)) => s.get("id").and_then(Value::as_str).map(|id| RemoteSong {
            id: id.to_owned(),
            title: str_field(s, "title").unwrap_or_default(),
            artist: str_field(s, "artist").unwrap_or_default(),
            album: str_field(s, "album"),
            album_id: str_field(s, "albumId"),
            cover_art: str_field(s, "coverArt"),
            duration: f64_field(s, "duration", 0.0),
        }),
        _ => None,
    };
    let song_duration = song.as_ref().map_or(0.0, |s| s.duration);
    DeviceState {
        is_playing: bool_field(state, "isPlaying"),
        current_time: f64_field(state, "currentTime", 0.0).max(0.0),
        duration: f64_field(state, "duration", song_duration).max(0.0),
        shuffle: bool_field(state, "shuffle"),
        repeat_mode: RepeatMode::from_wire(state.get("repeatMode").and_then(Value::as_str)),
        volume: f64_field(state, "volume", 1.0).clamp(0.0, 1.0),
        song,
    }
}

// ---------------------------------------------------------------------------------------------------------
// What the hub sends the phones
// ---------------------------------------------------------------------------------------------------------

/// A player's state as the hub passes it on: which device it is, and what the device said.
#[derive(Debug, Clone, PartialEq)]
pub struct StateUpdate {
    /// `String(msg.deviceId)`.
    pub device_id: String,
    /// The rest of the message, without `type` and `deviceId`.
    pub state: JsonMap,
}

impl StateUpdate {
    pub fn device_state(&self) -> DeviceState {
        parse_device_state(&self.state)
    }
}

/// How a hub answered a `hello`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Welcome {
    Accepted {
        /// What the hub calls itself in the device list ("hub").
        hub_device_id: String,
        hub_device_name: String,
    },
    Rejected(Rejection),
}

/// What a phone may receive from the hub, as the phone reads it.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMessage {
    Challenge {
        nonce: String,
        /// Names the PC (`String(msg.hubId ?? '')`).
        hub_id: String,
        hub_device_name: String,
    },
    Welcome(Welcome),
    Devices(Vec<DeviceSummary>),
    State(StateUpdate),
    Command(RemoteCommand),
    /// Not JSON, not an object, a type this phone does not know, or a challenge without a nonce.
    Ignored,
}

/// Reads a frame the hub sent.
pub fn decode_server(text: &str) -> ServerMessage {
    let Some(msg) = parse_object(text) else {
        return ServerMessage::Ignored;
    };
    match msg.get("type").and_then(Value::as_str) {
        Some("challenge") => match msg.get("nonce").and_then(Value::as_str) {
            Some(nonce) => ServerMessage::Challenge {
                nonce: nonce.to_owned(),
                hub_id: string_or(&msg, "hubId", ""),
                hub_device_name: msg
                    .get("hubDeviceName")
                    .map_or_else(String::new, js_string),
            },
            None => ServerMessage::Ignored,
        },
        Some("welcome") => {
            if msg.get("accepted").is_some_and(js_truthy) {
                ServerMessage::Welcome(Welcome::Accepted {
                    hub_device_id: msg.get("hubDeviceId").map_or_else(String::new, js_string),
                    hub_device_name: msg
                        .get("hubDeviceName")
                        .map_or_else(String::new, js_string),
                })
            } else {
                ServerMessage::Welcome(Welcome::Rejected(Rejection::from_wire(&string_or(
                    &msg, "reason", "",
                ))))
            }
        }
        Some("devices") => match msg.get("devices") {
            Some(Value::Array(list)) => ServerMessage::Devices(
                list.iter()
                    .filter_map(|d| {
                        let d = d.as_object()?;
                        Some(DeviceSummary {
                            device_id: js_string(d.get("deviceId")?),
                            device_name: d.get("deviceName").map_or_else(String::new, js_string),
                            platform: d.get("platform").map_or_else(String::new, js_string),
                        })
                    })
                    .collect(),
            ),
            // The phone's handlers would throw on this: nothing happens.
            _ => ServerMessage::Ignored,
        },
        Some("state") => {
            let device_id = msg.get("deviceId").map_or_else(String::new, js_string);
            let mut state = msg;
            state.shift_remove("type");
            state.shift_remove("deviceId");
            ServerMessage::State(StateUpdate { device_id, state })
        }
        Some("command") => ServerMessage::Command(RemoteCommand::from_raw(msg)),
        _ => ServerMessage::Ignored,
    }
}

/// The challenge sent to every new connection.
pub fn encode_challenge(nonce: &str, hub_id: &str, hub_device_name: &str) -> String {
    let mut obj = JsonMap::new();
    obj.insert("type".into(), "challenge".into());
    obj.insert("nonce".into(), nonce.into());
    obj.insert("hubId".into(), hub_id.into());
    obj.insert("hubDeviceName".into(), hub_device_name.into());
    Value::Object(obj).to_string()
}

/// The answer to a `hello`.
pub fn encode_welcome(welcome: &Welcome) -> String {
    let mut obj = JsonMap::new();
    obj.insert("type".into(), "welcome".into());
    match welcome {
        Welcome::Accepted {
            hub_device_id,
            hub_device_name,
        } => {
            obj.insert("accepted".into(), true.into());
            obj.insert("hubDeviceId".into(), hub_device_id.as_str().into());
            obj.insert("hubDeviceName".into(), hub_device_name.as_str().into());
        }
        Welcome::Rejected(reason) => {
            obj.insert("accepted".into(), false.into());
            obj.insert("reason".into(), reason.wire().into());
        }
    }
    Value::Object(obj).to_string()
}

/// The list of who is connected.
pub fn encode_devices(devices: &[DeviceSummary]) -> String {
    let list = devices
        .iter()
        .map(|d| {
            let mut o = JsonMap::new();
            o.insert("deviceId".into(), d.device_id.as_str().into());
            o.insert("deviceName".into(), d.device_name.as_str().into());
            o.insert("platform".into(), d.platform.as_str().into());
            Value::Object(o)
        })
        .collect();
    let mut obj = JsonMap::new();
    obj.insert("type".into(), "devices".into());
    obj.insert("devices".into(), Value::Array(list));
    Value::Object(obj).to_string()
}

/// A state a phone sent, as the hub passes it on: `{ ...msg, deviceId: clientId }`. The id is the one the
/// connection proved, whatever the phone wrote in it; it keeps its place if the phone sent one, else it is last.
pub fn relayed_state(msg: &JsonMap, device_id: &str) -> JsonMap {
    let mut out = msg.clone();
    out.insert("deviceId".into(), device_id.into());
    out
}

/// The PC's own player, as the hub tells the phones: `{ type: 'state', deviceId: 'hub', ...state }`. As in the
/// original, a `type` or `deviceId` inside `state` wins (it comes from the PC's own window).
pub fn local_state(state: &JsonMap) -> JsonMap {
    let mut out = JsonMap::new();
    out.insert("type".into(), "state".into());
    out.insert("deviceId".into(), HUB_DEVICE_ID.into());
    for (k, v) in state {
        out.insert(k.clone(), v.clone());
    }
    out
}

// ---------------------------------------------------------------------------------------------------------
// Discovery: the ping route and the subnet scan
// ---------------------------------------------------------------------------------------------------------

/// The hub's answer to `GET /selfhosthub/ping`: which PC it is, and nothing secret.
pub fn encode_ping(hub_id: &str, device_name: &str) -> String {
    let mut obj = JsonMap::new();
    obj.insert("app".into(), PING_APP.into());
    obj.insert("hubId".into(), hub_id.into());
    obj.insert("deviceName".into(), device_name.into());
    Value::Object(obj).to_string()
}

/// What a ping says, as a phone reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ping {
    pub hub_id: String,
    pub device_name: String,
}

/// Reads a ping reply; anything that is not a hub's gives `None`.
pub fn decode_ping(body: &str) -> Option<Ping> {
    let data = parse_object(body)?;
    if data.get("app").and_then(Value::as_str) != Some(PING_APP) {
        return None;
    }
    let hub_id = data.get("hubId").and_then(Value::as_str)?.to_owned();
    Some(Ping {
        hub_id,
        device_name: string_or(&data, "deviceName", DEFAULT_HUB_NAME),
    })
}

/// A hub a phone found on the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubInfo {
    pub ip: String,
    /// Names the PC to phones paired with it (not a secret).
    pub hub_id: String,
    pub device_name: String,
}

/// The address probed for a hub.
pub fn ping_url(ip: &str, port: u16) -> String {
    format!("http://{ip}:{port}{PING_PATH}")
}

/// The addresses a phone with address `own_ip` probes: the other 253 of its own /24 subnet. None when the phone
/// has no usable IPv4 address.
pub fn scan_candidates(own_ip: &str) -> Vec<String> {
    if own_ip.is_empty() || own_ip == "0.0.0.0" {
        return Vec::new();
    }
    let parts: Vec<&str> = own_ip.split('.').collect();
    if parts.len() != 4 {
        return Vec::new();
    }
    let base = parts[..3].join(".");
    (1..=254)
        .map(|i| format!("{base}.{i}"))
        .filter(|candidate| candidate != own_ip)
        .collect()
}

/// What to do with the body one address answered: a hub, unless it is not one or is not the PC that was asked
/// for (`wanted`, when the phone is looking for the one it is paired with).
pub fn hub_from_ping(ip: &str, body: &str, wanted: Option<&str>) -> Option<HubInfo> {
    let ping = decode_ping(body)?;
    if wanted.is_some_and(|wanted| wanted != ping.hub_id) {
        return None;
    }
    Some(HubInfo {
        ip: ip.to_owned(),
        hub_id: ping.hub_id,
        device_name: ping.device_name,
    })
}

/// Probes run side by side, so a few may answer before the first is noticed: one PC is wanted when one was asked
/// for, one is returned; otherwise they are all listed.
pub fn finish_discovery(mut found: Vec<HubInfo>, wanted: Option<&str>) -> Vec<HubInfo> {
    if wanted.is_some() {
        found.truncate(1);
    }
    found
}

/// A plain HTTP answer of the hub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub content_type: Option<&'static str>,
    pub body: String,
}

/// How the hub answers a plain HTTP request, whatever the socket library: nothing for addresses outside the
/// home network (403), the ping on `GET /selfhosthub/ping` (200), anything else is 404.
pub fn http_reply(
    remote_address: &str,
    method: &str,
    url: &str,
    hub_id: &str,
    device_name: &str,
) -> HttpReply {
    if !is_private_address(remote_address) {
        return HttpReply {
            status: 403,
            content_type: None,
            body: String::new(),
        };
    }
    if method == "GET" && url == PING_PATH {
        return HttpReply {
            status: 200,
            content_type: Some("application/json"),
            body: encode_ping(hub_id, device_name),
        };
    }
    HttpReply {
        status: 404,
        content_type: None,
        body: String::new(),
    }
}

// ---------------------------------------------------------------------------------------------------------
// JavaScript's coercions, where the original relies on them
// ---------------------------------------------------------------------------------------------------------

fn parse_object(text: &str) -> Option<JsonMap> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(obj)) => Some(obj),
        _ => None,
    }
}

/// `String(value)`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String(msg[key] ?? fallback)`.
fn string_or(msg: &JsonMap, key: &str, fallback: &str) -> String {
    match msg.get(key) {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(value) => js_string(value),
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `s.slice(0, max)`, counting UTF-16 units like JavaScript. A character that would be cut in two is dropped
/// whole (JavaScript would keep half of it, which nothing can show).
pub fn truncate_utf16(s: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in s.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    out
}

/// The length JavaScript gives a string.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A number as `JSON.stringify` writes it: `215`, not `215.0`; `null` for what JSON cannot hold.
fn number(x: f64) -> Value {
    if !x.is_finite() {
        Value::Null
    } else if x.fract() == 0.0 && x.abs() < 9.0e15 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

fn str_field(obj: &JsonMap, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn f64_field(obj: &JsonMap, key: &str, default: f64) -> f64 {
    obj.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn bool_field(obj: &JsonMap, key: &str) -> bool {
    obj.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(text: &str) -> JsonMap {
        match serde_json::from_str::<Value>(text).unwrap() {
            Value::Object(o) => o,
            other => panic!("not an object: {other}"),
        }
    }

    fn summary(id: &str, name: &str, platform: &str) -> DeviceSummary {
        DeviceSummary {
            device_id: id.into(),
            device_name: name.into(),
            platform: platform.into(),
        }
    }

    // Real messages, as the TypeScript on each side writes them.

    const CHALLENGE: &str = r#"{"type":"challenge","nonce":"0123456789abcdef0123456789abcdef","hubId":"aabbccddeeff001122334455","hubDeviceName":"Bureau"}"#;
    const HELLO: &str = r#"{"type":"hello","deviceId":"phone-1","deviceName":"Pixel","platform":"mobile","proof":"600074a13c4af0411239f60e31cbfd59255ce825ceafc136a270f88e89de1387"}"#;
    const WELCOME_OK: &str =
        r#"{"type":"welcome","accepted":true,"hubDeviceId":"hub","hubDeviceName":"Bureau"}"#;
    const WELCOME_NO: &str = r#"{"type":"welcome","accepted":false,"reason":"bad-code"}"#;
    const DEVICES: &str = r#"{"type":"devices","devices":[{"deviceId":"hub","deviceName":"Bureau","platform":"desktop"},{"deviceId":"phone-1","deviceName":"Pixel","platform":"mobile"}]}"#;
    const PHONE_STATE: &str = r#"{"type":"state","song":{"id":"s1","title":"Titre","artist":"Artiste","album":"Album","albumId":"a1","coverArt":"al-1","duration":215},"isPlaying":true,"currentTime":42.5,"duration":215,"shuffle":true,"repeatMode":"all","volume":0.6}"#;
    const COMMAND_VOLUME: &str =
        r#"{"type":"command","targetId":"hub","action":"setVolume","payload":{"volume":0.4}}"#;
    const PING: &str = r#"{"app":"selfhost-hub","hubId":"aabbccddeeff001122334455","deviceName":"Bureau"}"#;

    #[test]
    fn the_port_and_the_ping_route_are_the_ones_the_apps_use() {
        assert_eq!(PORT, 51823);
        assert_eq!(PING_PATH, "/selfhosthub/ping");
        assert_eq!(ws_url("192.168.1.20", PORT), "ws://192.168.1.20:51823");
        assert_eq!(
            ping_url("192.168.1.20", PORT),
            "http://192.168.1.20:51823/selfhosthub/ping"
        );
    }

    #[test]
    fn the_challenge_is_written_and_read_as_the_hub_sends_it() {
        let text = encode_challenge(
            "0123456789abcdef0123456789abcdef",
            "aabbccddeeff001122334455",
            "Bureau",
        );
        assert_eq!(text, CHALLENGE);
        assert_eq!(
            decode_server(CHALLENGE),
            ServerMessage::Challenge {
                nonce: "0123456789abcdef0123456789abcdef".into(),
                hub_id: "aabbccddeeff001122334455".into(),
                hub_device_name: "Bureau".into(),
            }
        );
    }

    #[test]
    fn a_challenge_without_a_string_nonce_is_ignored_and_a_missing_hub_id_reads_as_empty() {
        assert_eq!(
            decode_server(r#"{"type":"challenge","hubId":"h"}"#),
            ServerMessage::Ignored
        );
        assert_eq!(
            decode_server(r#"{"type":"challenge","nonce":7}"#),
            ServerMessage::Ignored
        );
        match decode_server(r#"{"type":"challenge","nonce":"n"}"#) {
            ServerMessage::Challenge { hub_id, .. } => assert_eq!(hub_id, ""),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_hello_is_written_and_read_as_the_phone_sends_it() {
        let hello = Hello {
            device_id: "phone-1".into(),
            device_name: "Pixel".into(),
            platform: Platform::Mobile,
            proof: Some("600074a13c4af0411239f60e31cbfd59255ce825ceafc136a270f88e89de1387".into()),
        };
        assert_eq!(hello.encode(), HELLO);
        assert_eq!(decode_client(HELLO), ClientMessage::Hello(hello));
    }

    #[test]
    fn an_old_apps_hello_has_no_proof() {
        let old = r#"{"type":"hello","deviceId":"old","deviceName":"Old","platform":"mobile","accountHash":"abc"}"#;
        match decode_client(old) {
            ClientMessage::Hello(h) => {
                assert_eq!(h.proof, None);
                assert_eq!(h.device_id, "old");
            }
            other => panic!("{other:?}"),
        }
        // A proof that is not text is no proof either: the hub does not count it as a guess.
        match decode_client(r#"{"type":"hello","deviceId":"x","proof":42}"#) {
            ClientMessage::Hello(h) => assert_eq!(h.proof, None),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_hello_is_read_the_way_the_hub_reads_it() {
        // No id, a number for an id: both are "no id".
        for text in [r#"{"type":"hello"}"#, r#"{"type":"hello","deviceId":5}"#] {
            match decode_client(text) {
                ClientMessage::Hello(h) => assert_eq!(h.device_id, ""),
                other => panic!("{other:?}"),
            }
        }
        // Name: a default, `String()` of anything, cut at 60 UTF-16 units; platform: desktop or else mobile.
        let name_of = |text: &str| match decode_client(text) {
            ClientMessage::Hello(h) => h.device_name,
            other => panic!("{other:?}"),
        };
        assert_eq!(name_of(r#"{"type":"hello","deviceId":"a"}"#), "Appareil");
        assert_eq!(
            name_of(r#"{"type":"hello","deviceId":"a","deviceName":null}"#),
            "Appareil"
        );
        assert_eq!(
            name_of(r#"{"type":"hello","deviceId":"a","deviceName":12}"#),
            "12"
        );
        assert_eq!(
            name_of(r#"{"type":"hello","deviceId":"a","deviceName":{"x":1}}"#),
            "[object Object]"
        );
        let long = format!(
            r#"{{"type":"hello","deviceId":"a","deviceName":"{}"}}"#,
            "é".repeat(80)
        );
        assert_eq!(name_of(&long).chars().count(), 60);
        let emoji = format!(
            r#"{{"type":"hello","deviceId":"a","deviceName":"{}"}}"#,
            "😀".repeat(40)
        );
        assert_eq!(
            utf16_len(&name_of(&emoji)),
            60,
            "30 emoji of two units each"
        );
        let platform = |p: &str| match decode_client(&format!(
            r#"{{"type":"hello","deviceId":"a","platform":{p}}}"#
        )) {
            ClientMessage::Hello(h) => h.platform,
            other => panic!("{other:?}"),
        };
        assert_eq!(platform(r#""desktop""#), Platform::Desktop);
        assert_eq!(platform(r#""mobile""#), Platform::Mobile);
        assert_eq!(platform(r#""tv""#), Platform::Mobile);
        assert_eq!(platform("1"), Platform::Mobile);
    }

    #[test]
    fn the_welcome_is_written_and_read_as_the_hub_sends_it() {
        let ok = Welcome::Accepted {
            hub_device_id: "hub".into(),
            hub_device_name: "Bureau".into(),
        };
        assert_eq!(encode_welcome(&ok), WELCOME_OK);
        assert_eq!(decode_server(WELCOME_OK), ServerMessage::Welcome(ok));
        let no = Welcome::Rejected(Rejection::BadCode);
        assert_eq!(encode_welcome(&no), WELCOME_NO);
        assert_eq!(decode_server(WELCOME_NO), ServerMessage::Welcome(no));
        for (reason, wire) in [
            (Rejection::TooManyAttempts, "too-many-attempts"),
            (Rejection::UpdateRequired, "update-required"),
        ] {
            assert_eq!(
                encode_welcome(&Welcome::Rejected(reason.clone())),
                format!(r#"{{"type":"welcome","accepted":false,"reason":"{wire}"}}"#)
            );
            assert_eq!(Rejection::from_wire(wire), reason);
        }
    }

    #[test]
    fn the_phone_reads_welcome_as_javascript_does() {
        // `if (msg.accepted)`: any truthy value lets the phone in; a missing reason is "".
        assert!(matches!(
            decode_server(r#"{"type":"welcome","accepted":1,"hubDeviceId":"hub","hubDeviceName":"B"}"#),
            ServerMessage::Welcome(Welcome::Accepted { .. })
        ));
        assert_eq!(
            decode_server(r#"{"type":"welcome"}"#),
            ServerMessage::Welcome(Welcome::Rejected(Rejection::Other(String::new())))
        );
        assert_eq!(
            decode_server(r#"{"type":"welcome","accepted":0,"reason":"later"}"#),
            ServerMessage::Welcome(Welcome::Rejected(Rejection::Other("later".into())))
        );
    }

    #[test]
    fn the_phone_says_why_the_pc_turned_it_away() {
        assert_eq!(Rejection::BadCode.message(), "Code d'appairage incorrect");
        assert_eq!(
            Rejection::TooManyAttempts.message(),
            "Trop d'essais : réessayez dans quelques minutes"
        );
        assert_eq!(
            Rejection::UpdateRequired.message(),
            "Mettez l'application du PC à jour"
        );
        assert_eq!(
            Rejection::Other("x".into()).message(),
            "Connexion refusée"
        );
        assert_eq!(Rejection::Other("x".into()).wire(), "x");
    }

    #[test]
    fn the_device_list_is_written_and_read_as_the_hub_sends_it() {
        let list = vec![
            summary("hub", "Bureau", "desktop"),
            summary("phone-1", "Pixel", "mobile"),
        ];
        assert_eq!(encode_devices(&list), DEVICES);
        assert_eq!(decode_server(DEVICES), ServerMessage::Devices(list));
        assert_eq!(
            decode_server(r#"{"type":"devices","devices":"nope"}"#),
            ServerMessage::Ignored
        );
    }

    #[test]
    fn a_state_is_written_as_the_phone_writes_it() {
        let state = DeviceState {
            song: Some(RemoteSong {
                id: "s1".into(),
                title: "Titre".into(),
                artist: "Artiste".into(),
                album: Some("Album".into()),
                album_id: Some("a1".into()),
                cover_art: Some("al-1".into()),
                duration: 215.0,
            }),
            is_playing: true,
            current_time: 42.5,
            duration: 215.0,
            shuffle: true,
            repeat_mode: RepeatMode::All,
            volume: 0.6,
        };
        assert_eq!(encode_state(&state), PHONE_STATE);
        // The hub keeps the object as it is and the phones read it back.
        let ClientMessage::State(msg) = decode_client(PHONE_STATE) else {
            panic!("not a state")
        };
        assert_eq!(parse_device_state(&msg), state);
    }

    #[test]
    fn a_state_without_a_song_has_null_and_optional_song_fields_are_left_out() {
        let idle = DeviceState {
            song: None,
            is_playing: false,
            current_time: 0.0,
            duration: 0.0,
            shuffle: false,
            repeat_mode: RepeatMode::Off,
            volume: 1.0,
        };
        assert_eq!(
            encode_state(&idle),
            r#"{"type":"state","song":null,"isPlaying":false,"currentTime":0,"duration":0,"shuffle":false,"repeatMode":"off","volume":1}"#
        );
        let bare = DeviceState {
            song: Some(RemoteSong {
                id: "s".into(),
                title: "T".into(),
                artist: "A".into(),
                album: None,
                album_id: None,
                cover_art: None,
                duration: 0.5,
            }),
            ..idle
        };
        assert!(encode_state(&bare).contains(r#""song":{"id":"s","title":"T","artist":"A","duration":0.5}"#));
    }

    #[test]
    fn a_state_that_makes_no_sense_reads_with_defaults() {
        let state = parse_device_state(&obj(r#"{"volume":9,"currentTime":-3,"repeatMode":"weird","song":{"title":"no id"}}"#));
        assert_eq!(state.volume, 1.0);
        assert_eq!(state.current_time, 0.0);
        assert_eq!(state.repeat_mode, RepeatMode::Off);
        assert_eq!(state.song, None);
        assert!(!state.is_playing);
    }

    #[test]
    fn the_hub_passes_a_state_on_under_the_id_the_connection_proved() {
        let msg = obj(PHONE_STATE);
        let relayed = relayed_state(&msg, "phone-1");
        let text = Value::Object(relayed).to_string();
        assert_eq!(
            text,
            PHONE_STATE.replacen(
                r#""volume":0.6}"#,
                r#""volume":0.6,"deviceId":"phone-1"}"#,
                1
            ),
            "added last, nothing else touched"
        );
        // A phone that wrote another id in its state does not get to speak for that device.
        let spoof = obj(r#"{"type":"state","deviceId":"hub","isPlaying":true}"#);
        assert_eq!(
            Value::Object(relayed_state(&spoof, "phone-1")).to_string(),
            r#"{"type":"state","deviceId":"phone-1","isPlaying":true}"#
        );
    }

    #[test]
    fn the_pcs_own_state_goes_out_as_from_the_hub() {
        let state = obj(r#"{"song":null,"isPlaying":false,"volume":0.5}"#);
        assert_eq!(
            Value::Object(local_state(&state)).to_string(),
            r#"{"type":"state","deviceId":"hub","song":null,"isPlaying":false,"volume":0.5}"#
        );
    }

    #[test]
    fn a_phone_reads_the_state_the_hub_passes_on() {
        let text = r#"{"type":"state","song":null,"isPlaying":true,"currentTime":1,"duration":2,"shuffle":false,"repeatMode":"one","volume":0.25,"deviceId":"phone-2"}"#;
        let ServerMessage::State(update) = decode_server(text) else {
            panic!("not a state")
        };
        assert_eq!(update.device_id, "phone-2");
        assert!(!update.state.contains_key("type"));
        assert!(!update.state.contains_key("deviceId"));
        let state = update.device_state();
        assert!(state.is_playing);
        assert_eq!(state.repeat_mode, RepeatMode::One);
        assert_eq!(state.volume, 0.25);
    }

    #[test]
    fn a_command_is_written_and_read_as_the_apps_write_it() {
        let command = RemoteCommand::new("hub", "setVolume", Some(json!({ "volume": 0.4 })));
        assert_eq!(command.encode(), COMMAND_VOLUME);
        assert_eq!(
            decode_client(COMMAND_VOLUME),
            ClientMessage::Command(command.clone())
        );
        assert_eq!(
            decode_server(COMMAND_VOLUME),
            ServerMessage::Command(command.clone())
        );
        assert_eq!(command.action(), Some("setVolume"));
        assert_eq!(command.target_id(), "hub");
        assert_eq!(command.payload(), Some(&json!({ "volume": 0.4 })));
        // `JSON.stringify` leaves `payload: undefined` out.
        assert_eq!(
            RemoteCommand::new("hub", "next", None).encode(),
            r#"{"type":"command","targetId":"hub","action":"next"}"#
        );
        // The seek the players send.
        assert_eq!(
            RemoteCommand::new("phone-1", "seek", Some(json!({ "seconds": 12.5 }))).encode(),
            r#"{"type":"command","targetId":"phone-1","action":"seek","payload":{"seconds":12.5}}"#
        );
        assert_eq!(
            RemoteCommand::new("hub", "setRepeatMode", Some(json!({ "mode": "all" }))).encode(),
            r#"{"type":"command","targetId":"hub","action":"setRepeatMode","payload":{"mode":"all"}}"#
        );
    }

    #[test]
    fn what_a_phone_may_ask_for_is_limited_to_playback_controls() {
        for action in COMMANDS {
            assert!(RemoteCommand::new("hub", action, None).is_allowed(), "{action}");
        }
        for action in ["rm -rf", "eval", "__proto__", "openUrl", "", "Play", "playMedia"] {
            assert!(
                !RemoteCommand::new("hub", action, None).is_allowed(),
                "{action}"
            );
        }
        let ClientMessage::Command(no_action) = decode_client(r#"{"type":"command","targetId":"hub","action":5}"#)
        else {
            panic!("not a command")
        };
        assert!(!no_action.is_allowed());
    }

    #[test]
    fn a_target_is_read_as_a_javascript_string() {
        let target = |text: &str| match decode_client(text) {
            ClientMessage::Command(c) => c.target_id(),
            other => panic!("{other:?}"),
        };
        assert_eq!(target(r#"{"type":"command","action":"next"}"#), "undefined");
        assert_eq!(
            target(r#"{"type":"command","action":"next","targetId":7}"#),
            "7"
        );
        assert_eq!(
            target(r#"{"type":"command","action":"next","targetId":null}"#),
            "null"
        );
    }

    #[test]
    fn what_is_not_a_message_is_ignored() {
        for text in [
            "not json",
            "",
            "null",
            "42",
            r#""hello""#,
            "[]",
            r#"[{"type":"hello"}]"#,
            "{}",
            r#"{"type":"nope"}"#,
            r#"{"type":7}"#,
        ] {
            assert_eq!(decode_client(text), ClientMessage::Ignored, "{text}");
            assert_eq!(decode_server(text), ServerMessage::Ignored, "{text}");
        }
    }

    #[test]
    fn discovery_tells_which_pc_it_is_and_nothing_secret() {
        assert_eq!(encode_ping("aabbccddeeff001122334455", "Bureau"), PING);
        let info = obj(PING);
        let mut keys: Vec<&str> = info.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["app", "deviceName", "hubId"]);
        assert!(!keys.iter().any(|k| k.to_lowercase().contains("hash")));
        assert_eq!(
            decode_ping(PING),
            Some(Ping {
                hub_id: "aabbccddeeff001122334455".into(),
                device_name: "Bureau".into()
            })
        );
    }

    #[test]
    fn the_plain_http_side_answers_the_ping_and_nothing_else() {
        let ok = http_reply("192.168.1.9", "GET", "/selfhosthub/ping", "h1", "Bureau");
        assert_eq!(ok.status, 200);
        assert_eq!(ok.content_type, Some("application/json"));
        assert_eq!(ok.body, encode_ping("h1", "Bureau"));
        assert_eq!(
            http_reply("127.0.0.1", "GET", "/other", "h1", "Bureau").status,
            404
        );
        assert_eq!(
            http_reply("127.0.0.1", "POST", "/selfhosthub/ping", "h1", "Bureau").status,
            404
        );
        // The internet is not served at all, not even the ping.
        let denied = http_reply("8.8.8.8", "GET", "/selfhosthub/ping", "h1", "Bureau");
        assert_eq!((denied.status, denied.body.as_str()), (403, ""));
        assert_eq!(
            http_reply("", "GET", "/selfhosthub/ping", "h1", "Bureau").status,
            403
        );
    }

    #[test]
    fn a_ping_reply_of_something_else_is_not_a_hub() {
        for body in [
            "",
            "<html>",
            "[]",
            r#"{"app":"other","hubId":"x"}"#,
            r#"{"app":"selfhost-hub"}"#,
            r#"{"app":"selfhost-hub","hubId":5}"#,
        ] {
            assert_eq!(decode_ping(body), None, "{body}");
        }
        // No name: the phone calls it "PC".
        assert_eq!(
            decode_ping(r#"{"app":"selfhost-hub","hubId":"x"}"#)
                .unwrap()
                .device_name,
            "PC"
        );
    }

    #[test]
    fn the_phone_finds_the_pc_it_was_paired_with_by_its_id_and_no_other() {
        let me = hub_from_ping("192.168.1.20", PING, Some("aabbccddeeff001122334455"));
        assert_eq!(
            me,
            Some(HubInfo {
                ip: "192.168.1.20".into(),
                hub_id: "aabbccddeeff001122334455".into(),
                device_name: "Bureau".into()
            })
        );
        assert_eq!(hub_from_ping("192.168.1.20", PING, Some("not-this-one")), None);
        assert!(
            hub_from_ping("192.168.1.20", PING, None).is_some(),
            "without an id every hub is a hub"
        );

        let a = hub_from_ping("192.168.1.20", PING, None).unwrap();
        let b = HubInfo {
            ip: "192.168.1.21".into(),
            ..a.clone()
        };
        assert_eq!(finish_discovery(vec![a.clone(), b.clone()], Some("x")), vec![a.clone()]);
        assert_eq!(finish_discovery(vec![a.clone(), b.clone()], None), vec![a, b]);
    }

    #[test]
    fn the_phone_scans_its_own_subnet_except_itself() {
        let c = scan_candidates("192.168.1.42");
        assert_eq!(c.len(), 253);
        assert_eq!(c.first().map(String::as_str), Some("192.168.1.1"));
        assert_eq!(c.last().map(String::as_str), Some("192.168.1.254"));
        assert!(!c.contains(&"192.168.1.42".to_owned()));
        assert!(scan_candidates("0.0.0.0").is_empty());
        assert!(scan_candidates("").is_empty());
        assert!(scan_candidates("fe80::1").is_empty());
        assert!(scan_candidates("10.0.0").is_empty());
    }

    #[test]
    fn a_name_is_cut_by_utf16_units_like_javascript_slice() {
        assert_eq!(truncate_utf16("abc", 60), "abc");
        assert_eq!(truncate_utf16("abcdef", 3), "abc");
        assert_eq!(truncate_utf16("a😀", 2), "a", "half an emoji is dropped whole");
        assert_eq!(truncate_utf16("😀😀", 4), "😀😀");
    }

    #[test]
    fn javascript_strings_of_values() {
        assert_eq!(js_string(&json!(null)), "null");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&json!({})), "[object Object]");
    }
}
