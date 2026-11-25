use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::protocol::{DeviceInfo, PAGE_SIZE};

/// One SQLite connection behind a mutex. Calls are short; async code runs them on `spawn_blocking`.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub week: String,
    pub log: Value,
    pub rev: i64,
}

#[derive(Debug, PartialEq)]
pub struct Page {
    pub rev: i64,
    pub entries: Vec<Entry>,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KnownDevice {
    pub user: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub last_seen: i64,
}

/// Per device listening summary for the admin panel.
#[derive(Debug, Clone, PartialEq)]
pub struct ListeningStat {
    pub user: String,
    pub device_id: String,
    pub weeks: i64,
    pub total_seconds: f64,
    pub rev: i64,
}

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |t| t.as_secs()) as i64
}

/// One row of the terminal audit trail.
#[derive(Debug, Clone, PartialEq)]
pub struct ShellAudit {
    pub id: i64,
    pub user: String,
    pub ip: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub bytes_in: i64,
    pub bytes_out: i64,
    pub end_reason: Option<String>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS listening (
    user TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    week TEXT NOT NULL,
    log TEXT NOT NULL,
    rev INTEGER NOT NULL,
    UNIQUE(user, device_id, week)
);
CREATE INDEX IF NOT EXISTS listening_user_rev ON listening(user, rev);
CREATE TABLE IF NOT EXISTS revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
);
INSERT OR IGNORE INTO revision (id, value) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS devices (
    user TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (user, device_id)
);
CREATE TABLE IF NOT EXISTS totp (
    user TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    last_step INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_hostkey (
    target TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    ip TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    bytes_in INTEGER NOT NULL DEFAULT 0,
    bytes_out INTEGER NOT NULL DEFAULT 0,
    end_reason TEXT
);
";

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        // No shell survives a restart: close the rows a crash left open.
        conn.execute(
            "UPDATE shell_audit SET ended_at = ?1, end_reason = 'server-restart' WHERE ended_at IS NULL",
            [unix_now()],
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn touch_device(&self, user: &str, d: &DeviceInfo) -> rusqlite::Result<()> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |t| t.as_secs()) as i64;
        self.lock().execute(
            "INSERT INTO devices (user, device_id, device_name, platform, last_seen) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user, device_id) DO UPDATE SET
                device_name = excluded.device_name, platform = excluded.platform, last_seen = excluded.last_seen",
            params![user, d.device_id, d.device_name, d.platform, now],
        )?;
        Ok(())
    }

    pub fn known_devices(&self) -> rusqlite::Result<Vec<KnownDevice>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT user, device_id, device_name, platform, last_seen FROM devices ORDER BY user, last_seen DESC",
        )?;
        stmt.query_map([], |r| {
            Ok(KnownDevice { user: r.get(0)?, device_id: r.get(1)?, device_name: r.get(2)?, platform: r.get(3)?, last_seen: r.get(4)? })
        })?
        .collect()
    }

    /// Weeks, total of every number in each week's `days` (array or object) and highest rev, per device.
    pub fn listening_stats(&self) -> rusqlite::Result<Vec<ListeningStat>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT user, device_id, COUNT(*), MAX(rev),
                    SUM((SELECT COALESCE(SUM(j.value), 0) FROM json_each(listening.log, '$.days') j
                         WHERE j.type IN ('integer', 'real')))
             FROM listening GROUP BY user, device_id ORDER BY user, device_id",
        )?;
        stmt.query_map([], |r| {
            Ok(ListeningStat {
                user: r.get(0)?,
                device_id: r.get(1)?,
                weeks: r.get(2)?,
                rev: r.get(3)?,
                total_seconds: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
            })
        })?
        .collect()
    }

    /// The stored TOTP secret (base32) and last accepted time step of a user.
    pub fn totp_get(&self, user: &str) -> rusqlite::Result<Option<(String, i64)>> {
        use rusqlite::OptionalExtension;
        self.lock()
            .query_row("SELECT secret, last_step FROM totp WHERE user = ?1", [user], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
    }

    pub fn totp_set(&self, user: &str, secret: &str, last_step: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO totp (user, secret, last_step) VALUES (?1, ?2, ?3)
             ON CONFLICT(user) DO UPDATE SET secret = excluded.secret, last_step = excluded.last_step",
            params![user, secret, last_step],
        )?;
        Ok(())
    }

    /// Records `step` as used, once: false when it is not newer than the last accepted step (a replay).
    pub fn totp_accept_step(&self, user: &str, step: i64) -> rusqlite::Result<bool> {
        Ok(self.lock().execute("UPDATE totp SET last_step = ?2 WHERE user = ?1 AND last_step < ?2", params![user, step])? == 1)
    }

    /// Removes the user's TOTP secret (`--reset-totp`). True when there was one.
    pub fn totp_delete(&self, user: &str) -> rusqlite::Result<bool> {
        Ok(self.lock().execute("DELETE FROM totp WHERE user = ?1", [user])? > 0)
    }

    pub fn hostkey_get(&self, target: &str) -> rusqlite::Result<Option<String>> {
        use rusqlite::OptionalExtension;
        self.lock().query_row("SELECT fingerprint FROM shell_hostkey WHERE target = ?1", [target], |r| r.get(0)).optional()
    }

    /// Pins the fingerprint unless one is already pinned (first use wins). True when this call pinned it.
    pub fn hostkey_pin(&self, target: &str, fingerprint: &str) -> rusqlite::Result<bool> {
        Ok(self.lock().execute("INSERT OR IGNORE INTO shell_hostkey (target, fingerprint) VALUES (?1, ?2)", [target, fingerprint])? == 1)
    }

    /// Forgets every pinned host key (`--reset-shell-hostkey`). Returns how many were removed.
    pub fn hostkey_clear(&self) -> rusqlite::Result<usize> {
        self.lock().execute("DELETE FROM shell_hostkey", [])
    }

    pub fn audit_start(&self, user: &str, ip: &str) -> rusqlite::Result<i64> {
        let conn = self.lock();
        conn.execute("INSERT INTO shell_audit (user, ip, started_at) VALUES (?1, ?2, ?3)", params![user, ip, unix_now()])?;
        Ok(conn.last_insert_rowid())
    }

    pub fn audit_end(&self, id: i64, bytes_in: u64, bytes_out: u64, reason: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE shell_audit SET ended_at = ?2, bytes_in = ?3, bytes_out = ?4, end_reason = ?5 WHERE id = ?1",
            params![id, unix_now(), bytes_in as i64, bytes_out as i64, reason],
        )?;
        Ok(())
    }

    /// The most recent `limit` sessions, newest first.
    pub fn audit_recent(&self, limit: u32) -> rusqlite::Result<Vec<ShellAudit>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, user, ip, started_at, ended_at, bytes_in, bytes_out, end_reason FROM shell_audit ORDER BY id DESC LIMIT ?1",
        )?;
        stmt.query_map([limit], |r| {
            Ok(ShellAudit {
                id: r.get(0)?,
                user: r.get(1)?,
                ip: r.get(2)?,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                bytes_in: r.get(5)?,
                bytes_out: r.get(6)?,
                end_reason: r.get(7)?,
            })
        })?
        .collect()
    }
    pub fn current_rev(&self) -> rusqlite::Result<i64> {
        Self::rev_of(&self.lock())
    }

    fn rev_of(conn: &Connection) -> rusqlite::Result<i64> {
        conn.query_row("SELECT value FROM revision WHERE id = 1", [], |r| r.get(0))
    }

    /// Upsert `(week, log JSON text)` rows of one device, each with the next revision.
    /// Returns the highest revision (the current one when `weeks` is empty).
    pub fn upsert_weeks(&self, user: &str, d: &DeviceInfo, weeks: &[(String, String)]) -> rusqlite::Result<i64> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let mut rev = Self::rev_of(&tx)?;
        if !weeks.is_empty() {
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO listening (user, device_id, device_name, platform, week, log, rev)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(user, device_id, week) DO UPDATE SET
                        device_name = excluded.device_name, platform = excluded.platform,
                        log = excluded.log, rev = excluded.rev",
                )?;
                for (week, log) in weeks {
                    rev += 1;
                    stmt.execute(params![user, d.device_id, d.device_name, d.platform, week, log, rev])?;
                }
            }
            tx.execute("UPDATE revision SET value = ?1 WHERE id = 1", [rev])?;
        }
        tx.commit()?;
        Ok(rev)
    }

    /// Rows of the user's other devices with `rev > since`, oldest first, one page.
    pub fn pull(&self, user: &str, own_device: &str, since: i64) -> rusqlite::Result<Page> {
        let conn = self.lock();
        let rev = Self::rev_of(&conn)?;
        let mut stmt = conn.prepare(
            "SELECT device_id, device_name, platform, week, log, rev FROM listening
             WHERE user = ?1 AND device_id != ?2 AND rev > ?3 ORDER BY rev LIMIT ?4",
        )?;
        let mut entries = stmt
            .query_map(params![user, own_device, since, PAGE_SIZE as i64 + 1], |r| {
                let log: String = r.get(4)?;
                Ok(Entry {
                    device_id: r.get(0)?,
                    device_name: r.get(1)?,
                    platform: r.get(2)?,
                    week: r.get(3)?,
                    log: serde_json::from_str(&log).unwrap_or(Value::Null),
                    rev: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = entries.len() > PAGE_SIZE;
        entries.truncate(PAGE_SIZE);
        Ok(Page { rev, entries, more })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str) -> DeviceInfo {
        DeviceInfo { device_id: id.into(), device_name: format!("name-{id}"), platform: "mobile".into() }
    }

    fn w(week: &str, log: &str) -> (String, String) {
        (week.into(), log.into())
    }

    #[test]
    fn upsert_assigns_increasing_revs_and_replaces() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.current_rev().unwrap(), 0);
        let r = db.upsert_weeks("max", &dev("a"), &[w("2026-11-16", "{\"n\":1}"), w("2026-11-23", "{\"n\":2}")]).unwrap();
        assert_eq!(r, 2);
        let r = db.upsert_weeks("max", &dev("a"), &[w("2026-11-16", "{\"n\":3}")]).unwrap();
        assert_eq!(r, 3);
        assert_eq!(db.upsert_weeks("max", &dev("a"), &[]).unwrap(), 3);
        let page = db.pull("max", "b", 0).unwrap();
        assert_eq!(page.rev, 3);
        assert_eq!(page.entries.len(), 2);
        // Ordered by rev: the untouched week first, then the replaced one.
        assert_eq!(page.entries[0].week, "2026-11-23");
        assert_eq!(page.entries[1].week, "2026-11-16");
        assert_eq!(page.entries[1].log["n"], 3);
        assert_eq!(page.entries[1].device_name, "name-a");
    }

    #[test]
    fn admin_stats_sum_days_arrays_and_objects() {
        let db = Db::open_in_memory().unwrap();
        db.touch_device("max", &dev("a")).unwrap();
        db.upsert_weeks("max", &dev("a"), &[w("2026-11-16", r#"{"days":[10,20,0.5,0,0,0,0]}"#), w("2026-11-23", r#"{"days":{"mon":3,"tue":4}}"#)]).unwrap();
        db.upsert_weeks("max", &dev("b"), &[w("2026-11-16", r#"{"songs":{}}"#)]).unwrap();
        let s = db.listening_stats().unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].device_id.as_str(), s[0].weeks, s[0].rev, s[0].total_seconds), ("a", 2, 2, 37.5));
        assert_eq!((s[1].weeks, s[1].total_seconds), (1, 0.0));
        let k = db.known_devices().unwrap();
        assert_eq!((k.len(), k[0].device_name.as_str()), (1, "name-a"));
    }

    #[test]
    fn pull_excludes_own_and_other_users_and_respects_since() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_weeks("max", &dev("a"), &[w("2026-11-16", "{}")]).unwrap();
        db.upsert_weeks("max", &dev("b"), &[w("2026-11-16", "{}")]).unwrap();
        db.upsert_weeks("lea", &dev("c"), &[w("2026-11-16", "{}")]).unwrap();
        let page = db.pull("max", "a", 0).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].device_id, "b");
        assert_eq!(page.rev, 3);
        assert!(db.pull("max", "a", 2).unwrap().entries.is_empty());
    }

    #[test]
    fn pull_pages_by_200() {
        let db = Db::open_in_memory().unwrap();
        for chunk in 0..30 {
            let weeks: Vec<_> = (0..8).map(|i| w(&format!("2000-{:02}-{:02}", chunk + 1, i + 1), "{}")).collect();
            db.upsert_weeks("max", &dev("a"), &weeks).unwrap();
        }
        let p1 = db.pull("max", "z", 0).unwrap();
        assert_eq!((p1.entries.len(), p1.more, p1.rev), (200, true, 240));
        let last = p1.entries.last().unwrap().rev;
        assert_eq!(last, 200);
        let p2 = db.pull("max", "z", last).unwrap();
        assert_eq!((p2.entries.len(), p2.more), (40, false));
        assert_eq!(p2.entries[0].rev, 201);
    }

    #[test]
    fn reopening_a_file_keeps_data() {
        let dir = std::env::temp_dir().join(format!("shh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hub.db");
        {
            let db = Db::open(&path).unwrap();
            db.touch_device("max", &dev("a")).unwrap();
            db.upsert_weeks("max", &dev("a"), &[w("2026-11-16", "{}")]).unwrap();
        }
        assert_eq!(Db::open(&path).unwrap().current_rev().unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn totp_steps_are_single_use() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.totp_get("max").unwrap(), None);
        assert!(!db.totp_accept_step("max", 5).unwrap());
        db.totp_set("max", "ABC", 10).unwrap();
        assert_eq!(db.totp_get("max").unwrap(), Some(("ABC".into(), 10)));
        assert!(!db.totp_accept_step("max", 10).unwrap());
        assert!(!db.totp_accept_step("max", 9).unwrap());
        assert!(db.totp_accept_step("max", 11).unwrap());
        assert!(!db.totp_accept_step("max", 11).unwrap());
        assert!(db.totp_delete("max").unwrap());
        assert!(!db.totp_delete("max").unwrap());
    }

    #[test]
    fn hostkey_first_pin_wins_and_clears() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.hostkey_pin("h:22", "SHA256:a").unwrap());
        assert!(!db.hostkey_pin("h:22", "SHA256:b").unwrap());
        assert_eq!(db.hostkey_get("h:22").unwrap().as_deref(), Some("SHA256:a"));
        assert_eq!(db.hostkey_clear().unwrap(), 1);
        assert_eq!(db.hostkey_get("h:22").unwrap(), None);
    }

    #[test]
    fn audit_rows_open_close_and_list_newest_first() {
        let db = Db::open_in_memory().unwrap();
        let a = db.audit_start("max", "1.2.3.4").unwrap();
        let b = db.audit_start("max", "1.2.3.5").unwrap();
        db.audit_end(a, 10, 20, "closed-by-client").unwrap();
        let rows = db.audit_recent(50).unwrap();
        assert_eq!((rows[0].id, rows[0].ended_at, rows[0].end_reason.as_deref()), (b, None, None));
        assert_eq!((rows[1].bytes_in, rows[1].bytes_out, rows[1].end_reason.as_deref()), (10, 20, Some("closed-by-client")));
        assert!(rows[1].ended_at.is_some());
        assert_eq!(db.audit_recent(1).unwrap().len(), 1);
    }}
