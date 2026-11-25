//! Per-user rooms: who is online, their last state, and the relays.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::{ALLOWED_ACTIONS, DeviceInfo};

/// What the connection task should write to its socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    Text(String),
    Close(u16, &'static str),
}

struct Conn {
    id: u64,
    info: DeviceInfo,
    tx: UnboundedSender<Outgoing>,
    state: Option<Value>,
    ip: IpAddr,
    connected_at: u64,
}

/// One online device, as the admin panel sees it.
#[derive(Debug, Clone)]
pub struct OnlineDevice {
    pub user: String,
    pub info: DeviceInfo,
    pub ip: IpAddr,
    pub connected_at: u64,
    pub state: Option<Value>,
}

#[derive(Default)]
struct Rooms {
    next_id: u64,
    users: HashMap<String, HashMap<String, Conn>>,
}

#[derive(Default)]
pub struct Hub {
    rooms: Mutex<Rooms>,
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn devices_message(room: &HashMap<String, Conn>) -> String {
    let mut list: Vec<&DeviceInfo> = room.values().map(|c| &c.info).collect();
    list.sort_by(|a, b| (&a.device_name, &a.device_id).cmp(&(&b.device_name, &b.device_id)));
    let devices: Vec<Value> = list
        .iter()
        .map(|d| json!({"deviceId": d.device_id, "deviceName": d.device_name, "platform": d.platform}))
        .collect();
    json!({"type": "devices", "devices": devices}).to_string()
}

fn broadcast_devices(room: &HashMap<String, Conn>) {
    let msg = devices_message(room);
    for c in room.values() {
        let _ = c.tx.send(Outgoing::Text(msg.clone()));
    }
}

impl Hub {
    fn lock(&self) -> std::sync::MutexGuard<'_, Rooms> {
        self.rooms.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Adds a device, replacing (and closing with 4000) a previous connection of the same id.
    /// Returns the connection id to pass to [`Hub::leave`].
    pub fn join(&self, user: &str, info: DeviceInfo, tx: UnboundedSender<Outgoing>, ip: IpAddr) -> u64 {
        let mut rooms = self.lock();
        rooms.next_id += 1;
        let id = rooms.next_id;
        let room = rooms.users.entry(user.to_string()).or_default();
        if let Some(old) = room.insert(info.device_id.clone(), Conn { id, info: info.clone(), tx: tx.clone(), state: None, ip, connected_at: unix_now() }) {
            let _ = old.tx.send(Outgoing::Close(4000, "replaced"));
        }
        broadcast_devices(room);
        for (device_id, c) in room.iter() {
            if *device_id != info.device_id
                && let Some(state) = &c.state
            {
                let _ = tx.send(Outgoing::Text(state.to_string()));
            }
        }
        id
    }

    /// Removes the connection unless it was already replaced by a newer one.
    pub fn leave(&self, user: &str, device_id: &str, conn_id: u64) {
        let mut rooms = self.lock();
        let Some(room) = rooms.users.get_mut(user) else { return };
        if room.get(device_id).is_some_and(|c| c.id == conn_id) {
            room.remove(device_id);
            if room.is_empty() {
                rooms.users.remove(user);
            } else if let Some(room) = rooms.users.get(user) {
                broadcast_devices(room);
            }
        }
    }

    /// Stores the sender's state and forwards it, stamped with its `deviceId`, to the user's other devices.
    pub fn relay_state(&self, user: &str, from: &str, mut state: Value) {
        let Some(obj) = state.as_object_mut() else { return };
        obj.insert("deviceId".into(), Value::String(from.to_string()));
        let mut rooms = self.lock();
        let Some(room) = rooms.users.get_mut(user) else { return };
        let text = state.to_string();
        for (id, c) in room.iter() {
            if id != from {
                let _ = c.tx.send(Outgoing::Text(text.clone()));
            }
        }
        if let Some(c) = room.get_mut(from) {
            c.state = Some(state);
        }
    }

    /// Forwards a command to its target. `Err(message)` means a `bad-command` error for the sender.
    pub fn relay_command(&self, user: &str, from: &str, msg: &Value) -> Result<(), String> {
        let action = msg.get("action").and_then(Value::as_str).unwrap_or("");
        if !ALLOWED_ACTIONS.contains(&action) {
            return Err(format!("action not allowed: {action}"));
        }
        let target = msg.get("targetId").and_then(Value::as_str).unwrap_or("");
        let rooms = self.lock();
        let conn = rooms.users.get(user).and_then(|r| r.get(target)).ok_or("unknown target")?;
        let mut out = json!({"type": "command", "targetId": target, "fromId": from, "action": action});
        if let Some(p) = msg.get("payload") {
            out["payload"] = p.clone();
        }
        let _ = conn.tx.send(Outgoing::Text(out.to_string()));
        Ok(())
    }

    /// Every online device, sorted by user then device name.
    pub fn snapshot(&self) -> Vec<OnlineDevice> {
        let rooms = self.lock();
        let mut v: Vec<OnlineDevice> = rooms
            .users
            .iter()
            .flat_map(|(user, room)| {
                room.values().map(|c| OnlineDevice {
                    user: user.clone(),
                    info: c.info.clone(),
                    ip: c.ip,
                    connected_at: c.connected_at,
                    state: c.state.clone(),
                })
            })
            .collect();
        v.sort_by(|a, b| (&a.user, &a.info.device_name, &a.info.device_id).cmp(&(&b.user, &b.info.device_name, &b.info.device_id)));
        v
    }

    /// Closes the device's connection with 4001 `kicked`. False when it is not online.
    pub fn kick(&self, user: &str, device_id: &str) -> bool {
        let rooms = self.lock();
        match rooms.users.get(user).and_then(|r| r.get(device_id)) {
            Some(c) => c.tx.send(Outgoing::Close(4001, "kicked")).is_ok(),
            None => false,
        }
    }

    /// Sends `text` to the user's online devices other than `from`.
    pub fn notify_others(&self, user: &str, from: &str, text: &str) {
        let rooms = self.lock();
        if let Some(room) = rooms.users.get(user) {
            for (id, c) in room {
                if id != from {
                    let _ = c.tx.send(Outgoing::Text(text.to_string()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    const IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

    fn dev(id: &str) -> DeviceInfo {
        DeviceInfo { device_id: id.into(), device_name: id.into(), platform: "desktop".into() }
    }

    #[test]
    fn replace_closes_old_and_old_leave_is_ignored() {
        let hub = Hub::default();
        let (t1, mut r1) = unbounded_channel();
        let (t2, mut r2) = unbounded_channel();
        let c1 = hub.join("max", dev("a"), t1, IP);
        let c2 = hub.join("max", dev("a"), t2, IP);
        let mut saw_close = false;
        while let Ok(m) = r1.try_recv() {
            saw_close |= m == Outgoing::Close(4000, "replaced");
        }
        assert!(saw_close);
        while r2.try_recv().is_ok() {}
        hub.leave("max", "a", c1);
        assert!(r2.try_recv().is_err(), "stale leave must not broadcast");
        hub.leave("max", "a", c2);
    }

    #[test]
    fn commands_are_scoped_to_the_user() {
        let hub = Hub::default();
        let (t1, _r1) = unbounded_channel();
        let (t2, mut r2) = unbounded_channel();
        hub.join("max", dev("a"), t1, IP);
        hub.join("lea", dev("b"), t2, IP);
        while r2.try_recv().is_ok() {}
        let cmd = json!({"type":"command","targetId":"b","action":"play"});
        assert!(hub.relay_command("max", "a", &cmd).is_err());
        assert!(r2.try_recv().is_err());
        let bad = json!({"type":"command","targetId":"a","action":"format-disk"});
        assert!(hub.relay_command("max", "b", &bad).is_err());
    }

    #[test]
    fn kick_sends_4001_and_snapshot_lists_devices() {
        let hub = Hub::default();
        let (t1, mut r1) = unbounded_channel();
        hub.join("max", dev("a"), t1, IP);
        let snap = hub.snapshot();
        assert_eq!((snap.len(), snap[0].user.as_str(), snap[0].ip), (1, "max", IP));
        assert!(!hub.kick("max", "nope"));
        assert!(!hub.kick("lea", "a"));
        assert!(hub.kick("max", "a"));
        let mut saw = false;
        while let Ok(m) = r1.try_recv() {
            saw |= m == Outgoing::Close(4001, "kicked");
        }
        assert!(saw);
    }
}
