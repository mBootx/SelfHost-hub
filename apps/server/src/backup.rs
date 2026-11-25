//! Scheduled and on-demand SQLite backups via `VACUUM INTO`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::{Mutex, watch};

use crate::db::Db;

const STARTUP_DELAY: Duration = Duration::from_secs(60);
const BACKUP_INTERVAL_SECS: u64 = 86_400;

/// Metadata about one backup file on disk.
#[derive(Debug, Clone)]
pub struct BackupInfo {
    pub name: String,
    pub bytes: u64,
    pub created_at: u64,
}

impl BackupInfo {
    pub fn to_json(&self) -> Value {
        json!({"name": self.name, "bytes": self.bytes, "createdAt": self.created_at})
    }
}

/// Coordinates non-overlapping SQLite backups and retention pruning.
pub struct BackupManager {
    db: Db,
    dir: PathBuf,
    keep: usize,
    lock: Mutex<()>,
}

impl BackupManager {
    /// Creates a backup manager storing files in `dir` and retaining `keep` backups (`0` disables the schedule).
    pub fn new(db: Db, dir: PathBuf, keep: usize) -> Arc<Self> {
        Arc::new(Self { db, dir, keep, lock: Mutex::new(()) })
    }

    /// Configured retention count.
    pub fn keep(&self) -> usize {
        self.keep
    }

    /// Whether scheduled daily backups are enabled (`keep > 0`).
    pub fn enabled(&self) -> bool {
        self.keep > 0
    }

    /// Creates a consistent backup now and prunes older files beyond `keep.max(1)`.
    pub async fn run_once(&self) -> Result<BackupInfo, String> {
        let _guard = self.lock.lock().await;
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("create backup dir: {e}"))?;

        let now = unix_now();
        let name = next_backup_name(&self.dir, now);
        let final_path = self.dir.join(&name);
        let tmp_path = self.dir.join(format!(".{name}.tmp"));
        let _ = std::fs::remove_file(&tmp_path);

        let db = self.db.clone();
        let tmp_for_blocking = tmp_path.clone();
        let vacuum_res = tokio::task::spawn_blocking(move || db.vacuum_into(&tmp_for_blocking))
            .await
            .map_err(|e| format!("backup task failed: {e}"))
            .and_then(|r| r.map_err(|e| format!("vacuum into failed: {e}")));
        if let Err(e) = vacuum_res {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }

        if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("rename backup failed: {e}"));
        }

        let meta = std::fs::metadata(&final_path).map_err(|e| format!("stat backup failed: {e}"))?;
        let info = BackupInfo {
            name,
            bytes: meta.len(),
            created_at: modified_unix(&meta).unwrap_or(now),
        };

        let retain = self.keep.max(1);
        for old in list_entries(&self.dir).into_iter().skip(retain) {
            if let Err(e) = std::fs::remove_file(&old.path) {
                tracing::warn!(path = %old.path.display(), "failed to prune old backup: {e}");
            }
        }

        Ok(info)
    }

    /// Lists existing `hub-*.db` backup files sorted newest-first.
    pub fn list(&self) -> Vec<BackupInfo> {
        list_entries(&self.dir).into_iter().map(|e| e.info).collect()
    }

    /// Starts the background daily backup loop unless `keep == 0`.
    pub fn spawn(self: &Arc<Self>, mut shutdown: watch::Receiver<bool>) {
        if self.keep == 0 {
            return;
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            if *shutdown.borrow() {
                return;
            }
            tokio::select! {
                _ = tokio::time::sleep(STARTUP_DELAY) => {}
                _ = shutdown.changed() => return,
            }
            let due = me
                .list()
                .first()
                .is_none_or(|b| unix_now().saturating_sub(b.created_at) >= BACKUP_INTERVAL_SECS);
            if due {
                me.run_and_log().await;
            }
            let interval = Duration::from_secs(BACKUP_INTERVAL_SECS);
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    _ = shutdown.changed() => return,
                }
                me.run_and_log().await;
            }
        });
    }

    async fn run_and_log(&self) {
        match self.run_once().await {
            Ok(info) => tracing::info!(name = %info.name, bytes = info.bytes, "sqlite backup created"),
            Err(err) => tracing::warn!(%err, "sqlite backup failed"),
        }
    }
}

struct DiskBackup {
    info: BackupInfo,
    path: PathBuf,
    mtime: SystemTime,
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn modified_unix(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

fn next_backup_name(dir: &Path, secs: u64) -> String {
    let base = format!("hub-{}", format_utc_stamp(secs));
    let plain = format!("{base}.db");
    if !dir.join(&plain).exists() {
        return plain;
    }
    for i in 1u32.. {
        let candidate = format!("{base}-{i}.db");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn format_utc_stamp(secs: u64) -> String {
    let days = (secs / BACKUP_INTERVAL_SECS) as i64;
    let rem = secs % BACKUP_INTERVAL_SECS;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    // Howard Hinnant's civil_from_days: days since 1970-01-01 to proleptic Gregorian (Y, M, D).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{hour:02}{min:02}{sec:02}")
}

fn name_sort_key(name: &str) -> (&str, u64) {
    let stem = name.strip_prefix("hub-").and_then(|s| s.strip_suffix(".db")).unwrap_or(name);
    match stem.rsplit_once('-') {
        Some((prefix, suffix)) if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) && prefix.len() == 15 => {
            (prefix, suffix.parse().unwrap_or(0))
        }
        _ => (stem, 0),
    }
}

fn list_entries(dir: &Path) -> Vec<DiskBackup> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !(name.starts_with("hub-") && name.ends_with(".db")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
        let created_at = mtime.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        out.push(DiskBackup {
            info: BackupInfo { name: name.to_string(), bytes: meta.len(), created_at },
            path,
            mtime,
        });
    }
    out.sort_by(|a, b| {
        b.mtime
            .cmp(&a.mtime)
            .then_with(|| name_sort_key(&b.info.name).cmp(&name_sort_key(&a.info.name)))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::DeviceInfo;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!("shh-backup-{tag}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn utc_stamp_formats_epoch_and_known_date() {
        assert_eq!(format_utc_stamp(0), "19700101-000000");
        assert_eq!(format_utc_stamp(1_700_000_000), "20231114-221320");
    }

    #[tokio::test]
    async fn run_once_creates_valid_sqlite_backup_and_prunes() {
        let dir = temp_dir("prune");
        let db = Db::open_in_memory().unwrap();
        let dev = DeviceInfo { device_id: "d1".into(), device_name: "Phone".into(), platform: "mobile".into() };
        db.upsert_weeks("max", &dev, &[("2026-11-23".into(), r#"{"days":[1,2,3,4,5,6,7]}"#.into())]).unwrap();

        let mgr = BackupManager::new(db, dir.clone(), 2);
        assert!(mgr.enabled());
        assert_eq!(mgr.keep(), 2);

        let b1 = mgr.run_once().await.unwrap();
        let b2 = mgr.run_once().await.unwrap();
        let b3 = mgr.run_once().await.unwrap();
        assert_ne!(b1.name, b2.name);
        assert_ne!(b2.name, b3.name);
        assert!(b3.bytes > 0);

        let listed = mgr.list();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, b3.name);
        assert_eq!(listed[1].name, b2.name);

        let restored = Db::open(&dir.join(&listed[0].name)).unwrap();
        assert_eq!(restored.current_rev().unwrap(), 1);
        drop(restored);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn zero_keep_disables_schedule_without_panicking() {
        let dir = temp_dir("disabled");
        let db = Db::open_in_memory().unwrap();
        let mgr = BackupManager::new(db, dir.clone(), 0);
        assert!(!mgr.enabled());
        let (_tx, rx) = watch::channel(false);
        mgr.spawn(rx);
        assert!(mgr.list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
