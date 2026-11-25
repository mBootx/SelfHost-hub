//! Read-only host monitor: pure parsers over /proc, /sys and Docker API text, and the background samplers.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

/// Host sampling while someone has the panel open, the 60 points of the live graphs.
const HOST_EVERY: Duration = Duration::from_secs(1);
const LIVE_LEN: usize = 60;
/// Nobody looking (no panel request for WATCHED_FOR): fewer samples, the history still fills.
const IDLE_EVERY: Duration = Duration::from_secs(5);
const WATCHED_FOR: Duration = Duration::from_secs(20);
const HISTORY_EVERY: Duration = Duration::from_secs(10);
const HISTORY_LEN: usize = 360;
const CONTAINERS_EVERY: Duration = Duration::from_secs(2);
const CONTAINERS_IDLE_EVERY: Duration = Duration::from_secs(15);
const CLK_TCK: f64 = 100.0;
const REAL_FS: [&str; 10] = ["ext2", "ext3", "ext4", "xfs", "btrfs", "vfat", "exfat", "zfs", "ntfs", "f2fs"];

#[derive(Debug, Clone)]
pub struct SysConfig {
    pub proc_dir: PathBuf,
    pub sys_dir: PathBuf,
    pub root: Option<PathBuf>,
    pub docker_url: Option<String>,
}

impl Default for SysConfig {
    fn default() -> Self {
        Self { proc_dir: "/proc".into(), sys_dir: "/sys".into(), root: None, docker_url: None }
    }
}

// ---------------------------------------------------------------- parsers

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MemInfo {
    pub total: u64,
    pub available: u64,
    pub buffers_cache: u64,
    pub swap_total: u64,
    pub swap_used: u64,
}

/// `/proc/meminfo`, values in bytes.
pub fn parse_meminfo(s: &str) -> Option<MemInfo> {
    let map: HashMap<&str, u64> = s
        .lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.trim(), v.split_whitespace().next()?.parse::<u64>().ok()? * 1024))
        })
        .collect();
    let get = |k: &str| map.get(k).copied().unwrap_or(0);
    let total = *map.get("MemTotal")?;
    let buffers_cache = get("Buffers") + get("Cached") + get("SReclaimable");
    let available = map.get("MemAvailable").copied().unwrap_or_else(|| get("MemFree") + get("Buffers") + get("Cached"));
    Some(MemInfo {
        total,
        available: available.min(total),
        buffers_cache,
        swap_total: get("SwapTotal"),
        swap_used: get("SwapTotal").saturating_sub(get("SwapFree")),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuTimes {
    pub total: u64,
    pub idle: u64,
}

/// `/proc/stat`: the aggregate `cpu` line and the `cpuN` lines.
pub fn parse_cpu_stat(s: &str) -> (Option<CpuTimes>, Vec<CpuTimes>) {
    let mut all = None;
    let mut cores = Vec::new();
    for line in s.lines() {
        let mut it = line.split_whitespace();
        let Some(name) = it.next() else { continue };
        let Some(rest) = name.strip_prefix("cpu") else { continue };
        let f: Vec<u64> = it.take(8).filter_map(|x| x.parse().ok()).collect();
        if f.len() < 5 {
            continue;
        }
        let t = CpuTimes { total: f.iter().sum(), idle: f[3] + f[4] };
        if rest.is_empty() {
            all = Some(t);
        } else if rest.bytes().all(|b| b.is_ascii_digit()) {
            cores.push(t);
        }
    }
    (all, cores)
}

pub fn cpu_percent(prev: CpuTimes, cur: CpuTimes) -> f64 {
    let total = cur.total.saturating_sub(prev.total);
    if total == 0 {
        return 0.0;
    }
    let idle = cur.idle.saturating_sub(prev.idle).min(total);
    (total - idle) as f64 / total as f64 * 100.0
}

pub fn parse_loadavg(s: &str) -> Option<[f64; 3]> {
    let mut it = s.split_whitespace().map(|x| x.parse::<f64>());
    Some([it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?])
}

pub fn parse_uptime(s: &str) -> Option<f64> {
    s.split_whitespace().next()?.parse().ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetCounters {
    pub name: String,
    pub rx: u64,
    pub tx: u64,
}

/// `/proc/net/dev`.
pub fn parse_net_dev(s: &str) -> Vec<NetCounters> {
    s.lines()
        .filter_map(|l| {
            let (name, rest) = l.split_once(':')?;
            let f: Vec<&str> = rest.split_whitespace().collect();
            if f.len() < 9 {
                return None;
            }
            Some(NetCounters { name: name.trim().to_string(), rx: f[0].parse().ok()?, tx: f[8].parse().ok()? })
        })
        .collect()
}

pub fn is_virtual_iface(name: &str) -> bool {
    name == "lo" || name == "docker0" || name.starts_with("veth") || name.starts_with("br-")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mount {
    pub device: String,
    pub mountpoint: String,
    pub fstype: String,
}

fn unescape_mount(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 4 <= b.len()
            && let Ok(oct) = std::str::from_utf8(&b[i + 1..i + 4])
            && let Ok(v) = u8::from_str_radix(oct, 8)
        {
            out.push(v);
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `/proc/<pid>/mounts`: real filesystems only, one per device (the first mountpoint listed).
pub fn parse_mounts(s: &str) -> Vec<Mount> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in s.lines() {
        let mut it = line.split_whitespace();
        let (Some(dev), Some(mp), Some(fs)) = (it.next(), it.next(), it.next()) else { continue };
        if !REAL_FS.contains(&fs) || !seen.insert(dev.to_string()) {
            continue;
        }
        out.push(Mount { device: unescape_mount(dev), mountpoint: unescape_mount(mp), fstype: fs.to_string() });
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PidStat {
    pub comm: String,
    pub state: char,
    pub ppid: u32,
    /// utime + stime, in clock ticks.
    pub ticks: u64,
    pub threads: u32,
}

/// `/proc/<pid>/stat`. `comm` may contain spaces and parentheses.
pub fn parse_pid_stat(s: &str) -> Option<PidStat> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    if close < open {
        return None;
    }
    let f: Vec<&str> = s[close + 1..].split_whitespace().collect();
    // After ")": state is field 3, so ppid (4) is at 1, utime (14) and stime (15) at 11 and 12, num_threads (20) at 17.
    let ticks = f.get(11)?.parse::<u64>().ok()?.checked_add(f.get(12)?.parse::<u64>().ok()?)?;
    Some(PidStat {
        comm: s[open + 1..close].to_string(),
        state: f.first()?.chars().next()?,
        ppid: f.get(1)?.parse().ok()?,
        ticks,
        threads: f.get(17).and_then(|x| x.parse().ok()).unwrap_or(1),
    })
}

/// `VmRSS` of `/proc/<pid>/status`, in bytes.
pub fn parse_vmrss(status: &str) -> Option<u64> {
    let l = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    Some(l.split_whitespace().nth(1)?.parse::<u64>().ok()? * 1024)
}

/// The real uid on the `Uid:` line of `/proc/<pid>/status`.
pub fn parse_uid(status: &str) -> Option<u32> {
    status.lines().find(|l| l.starts_with("Uid:"))?.split_whitespace().nth(1)?.parse().ok()
}

/// `/etc/passwd` to uid -> name.
pub fn parse_passwd(s: &str) -> HashMap<u32, String> {
    s.lines()
        .filter_map(|l| {
            let mut it = l.split(':');
            let name = it.next()?;
            let uid = it.nth(1)?.parse().ok()?;
            Some((uid, name.to_string()))
        })
        .collect()
}

/// The Docker container a process runs in, from `/proc/<pid>/cgroup`: the first 64-hex-digit id, cut to 12 like
/// `docker ps` (`.../docker-<id>.scope` with systemd, `/docker/<id>` without).
pub fn container_of(cgroup: &str) -> Option<String> {
    let b = cgroup.as_bytes();
    let mut run = 0;
    for (i, c) in b.iter().enumerate() {
        if c.is_ascii_hexdigit() && !c.is_ascii_uppercase() {
            run += 1;
            if run == 64 && b.get(i + 1).is_none_or(|n| !n.is_ascii_hexdigit()) {
                return Some(cgroup[i + 1 - 64..i + 1 - 52].to_string());
            }
        } else {
            run = 0;
        }
    }
    None
}

/// What to call a process: the file name of its program when `comm` was cut to 15 bytes by the kernel and is the
/// start of it, `comm` otherwise; and its command line, NUL-separated in `/proc/<pid>/cmdline`, at most 300 characters.
pub fn process_name(comm: &str, cmdline: &[u8]) -> (String, String) {
    let args: Vec<String> =
        cmdline.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    let mut cmd = args.join(" ");
    if let Some((cut, _)) = cmd.char_indices().nth(300) {
        cmd.truncate(cut);
    }
    let name = args
        .first()
        .map(|a0| a0.rsplit('/').next().unwrap_or(a0).split_whitespace().next().unwrap_or("").to_string())
        // Only a comm the kernel cut (15 bytes) is completed: a program may have renamed itself on purpose.
        .filter(|n| comm.len() >= 15 && n.starts_with(comm) && n.len() > comm.len())
        .unwrap_or_else(|| comm.to_string());
    (name, cmd)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskCounters {
    pub name: String,
    pub read_bytes: u64,
    pub write_bytes: u64,
    /// Milliseconds spent doing I/O (`io_ticks`).
    pub busy_ms: u64,
}

/// Whole disks, not their partitions nor loop, ram or device-mapper devices.
pub fn is_whole_disk(name: &str) -> bool {
    let letters = |p: &str| name.strip_prefix(p).is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_lowercase()));
    let nvme = name
        .strip_prefix("nvme")
        .and_then(|r| r.split_once('n'))
        .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && (a.bytes().chain(b.bytes())).all(|c| c.is_ascii_digit()));
    let mmc = name.strip_prefix("mmcblk").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()));
    letters("sd") || letters("vd") || letters("hd") || letters("xvd") || nvme || mmc
}

/// `/proc/diskstats`, whole disks only. Sectors there are always 512 bytes.
pub fn parse_diskstats(s: &str) -> Vec<DiskCounters> {
    s.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let name = *f.get(2)?;
            if !is_whole_disk(name) {
                return None;
            }
            let n = |i: usize| f.get(i).and_then(|x| x.parse::<u64>().ok());
            Some(DiskCounters { name: name.to_string(), read_bytes: n(5)? * 512, write_bytes: n(9)? * 512, busy_ms: n(12)? })
        })
        .collect()
}

/// The first `model name` of `/proc/cpuinfo`.
pub fn parse_cpu_model(s: &str) -> Option<String> {
    let l = s.lines().find(|l| l.starts_with("model name"))?;
    Some(l.split_once(':')?.1.split_whitespace().collect::<Vec<_>>().join(" "))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Temp {
    pub source: &'static str,
    pub chip: String,
    pub label: String,
    pub celsius: f64,
    pub high: Option<f64>,
    pub crit: Option<f64>,
}

fn read_trim(p: &Path) -> Option<String> {
    Some(std::fs::read_to_string(p).ok()?.trim().to_string())
}

fn read_milli(p: &Path) -> Option<f64> {
    Some(read_trim(p)?.parse::<i64>().ok()? as f64 / 1000.0)
}

fn list_names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    v.sort_by_key(|a| natural_key(a));
    v
}

/// Sort `hwmon10` after `hwmon2`.
fn natural_key(s: &str) -> (String, u64) {
    let digits_at = s.find(|c: char| c.is_ascii_digit()).unwrap_or(s.len());
    (s[..digits_at].to_string(), s[digits_at..].parse().unwrap_or(0))
}

/// hwmon `temp*_input` (with chip name, label, max/crit) and `thermal_zone*/temp` (with trip points).
pub fn read_temps(sys: &Path) -> Vec<Temp> {
    let mut out = Vec::new();
    let hw = sys.join("class/hwmon");
    for dn in list_names(&hw).into_iter().filter(|n| n.starts_with("hwmon")) {
        let dir = hw.join(&dn);
        let chip = read_trim(&dir.join("name")).unwrap_or_else(|| dn.clone());
        for f in list_names(&dir) {
            let Some(idx) = f.strip_prefix("temp").and_then(|r| r.strip_suffix("_input")) else { continue };
            let Some(celsius) = read_milli(&dir.join(&f)) else { continue };
            out.push(Temp {
                source: "hwmon",
                label: read_trim(&dir.join(format!("temp{idx}_label"))).unwrap_or_else(|| format!("temp{idx}")),
                chip: chip.clone(),
                celsius,
                high: read_milli(&dir.join(format!("temp{idx}_max"))),
                crit: read_milli(&dir.join(format!("temp{idx}_crit"))),
            });
        }
    }
    let th = sys.join("class/thermal");
    for dn in list_names(&th).into_iter().filter(|n| n.starts_with("thermal_zone")) {
        let dir = th.join(&dn);
        let Some(celsius) = read_milli(&dir.join("temp")) else { continue };
        let (mut high, mut crit) = (None, None);
        for i in 0..16 {
            let Some(kind) = read_trim(&dir.join(format!("trip_point_{i}_type"))) else { break };
            let t = read_milli(&dir.join(format!("trip_point_{i}_temp")));
            match kind.as_str() {
                "critical" => crit = crit.or(t),
                "hot" | "passive" => high = high.or(t),
                _ => {}
            }
        }
        out.push(Temp {
            source: "thermal",
            chip: read_trim(&dir.join("type")).unwrap_or_else(|| dn.clone()),
            label: dn,
            celsius,
            high,
            crit,
        });
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub project: Option<String>,
}

/// Docker `GET /containers/json`.
pub fn parse_container_list(s: &str) -> Option<Vec<ContainerInfo>> {
    let v: Value = serde_json::from_str(s).ok()?;
    let text = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some(
        v.as_array()?
            .iter()
            .map(|c| ContainerInfo {
                id: text(c, "Id"),
                name: c
                    .pointer("/Names/0")
                    .and_then(Value::as_str)
                    .map_or_else(|| text(c, "Id").chars().take(12).collect(), |n| n.trim_start_matches('/').to_string()),
                image: text(c, "Image"),
                state: text(c, "State"),
                status: text(c, "Status"),
                project: c.pointer("/Labels/com.docker.compose.project").and_then(Value::as_str).map(str::to_string),
            })
            .collect(),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuRaw {
    pub total: u64,
    pub system: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContainerStats {
    /// Share of the whole machine, 0 to 100 (`docker stats` shows it per core, up to 100 × cores).
    pub cpu_percent: Option<f64>,
    pub mem_used: u64,
    pub mem_limit: u64,
    pub rx: u64,
    pub tx: u64,
    pub blk_read: u64,
    pub blk_write: u64,
    pub pids: Option<u64>,
    pub raw: Option<CpuRaw>,
}

/// Docker `GET /containers/{id}/stats`. `prev` is our own previous sample, used when `precpu_stats` is empty.
pub fn parse_container_stats(s: &str, prev: Option<CpuRaw>) -> Option<ContainerStats> {
    let v: Value = serde_json::from_str(s).ok()?;
    let u = |p: &str| v.pointer(p).and_then(Value::as_u64);
    let raw = match (u("/cpu_stats/cpu_usage/total_usage"), u("/cpu_stats/system_cpu_usage")) {
        (Some(total), Some(system)) => Some(CpuRaw { total, system }),
        _ => None,
    };
    let pre = match (u("/precpu_stats/cpu_usage/total_usage"), u("/precpu_stats/system_cpu_usage")) {
        (Some(total), Some(system)) if total > 0 && system > 0 => Some(CpuRaw { total, system }),
        _ => prev,
    };
    // system_cpu_usage counts every core, so this is already a share of the whole machine.
    let cpu_percent = match (raw, pre) {
        (Some(c), Some(p)) if c.total >= p.total && c.system > p.system => {
            Some(((c.total - p.total) as f64 / (c.system - p.system) as f64 * 100.0).min(100.0))
        }
        _ => None,
    };
    let (mut blk_read, mut blk_write) = (0, 0);
    if let Some(list) = v.pointer("/blkio_stats/io_service_bytes_recursive").and_then(Value::as_array) {
        for e in list {
            let n = e.get("value").and_then(Value::as_u64).unwrap_or(0);
            match e.get("op").and_then(Value::as_str).map(str::to_ascii_lowercase).as_deref() {
                Some("read") => blk_read += n,
                Some("write") => blk_write += n,
                _ => {}
            }
        }
    }
    let usage = u("/memory_stats/usage").unwrap_or(0);
    let cache = u("/memory_stats/stats/inactive_file")
        .or_else(|| u("/memory_stats/stats/total_inactive_file"))
        .or_else(|| u("/memory_stats/stats/cache"))
        .unwrap_or(0);
    let (mut rx, mut tx) = (0, 0);
    if let Some(nets) = v.get("networks").and_then(Value::as_object) {
        for n in nets.values() {
            rx += n.get("rx_bytes").and_then(Value::as_u64).unwrap_or(0);
            tx += n.get("tx_bytes").and_then(Value::as_u64).unwrap_or(0);
        }
    }
    Some(ContainerStats {
        cpu_percent,
        mem_used: usage.saturating_sub(cache),
        mem_limit: u("/memory_stats/limit").unwrap_or(0),
        rx,
        tx,
        blk_read,
        blk_write,
        pids: u("/pids_stats/current"),
        raw,
    })
}

// ---------------------------------------------------------------- statvfs

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FsUsage {
    pub total: u64,
    pub used: u64,
    pub free: u64,
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
pub fn statvfs(path: &Path) -> Option<FsUsage> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `libc::statvfs` is a plain C struct for which all-zero bytes are valid.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated string and `s` a valid out-pointer for the call's duration.
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut s) };
    if rc != 0 {
        return None;
    }
    let unit = if s.f_frsize > 0 { s.f_frsize as u64 } else { s.f_bsize as u64 };
    Some(FsUsage {
        total: s.f_blocks as u64 * unit,
        used: (s.f_blocks as u64).saturating_sub(s.f_bfree as u64) * unit,
        free: s.f_bavail as u64 * unit,
    })
}

#[cfg(not(unix))]
pub fn statvfs(_path: &Path) -> Option<FsUsage> {
    None
}

// ---------------------------------------------------------------- host sampling

#[derive(Default)]
struct Prev {
    at: Option<Instant>,
    cpu: Option<(CpuTimes, Vec<CpuTimes>)>,
    net: HashMap<String, (u64, u64)>,
    disks: HashMap<String, (u64, u64, u64)>,
    procs: HashMap<u32, u64>,
    users: Option<(Instant, HashMap<u32, String>)>,
    cpu_model: Option<Option<String>>,
}

struct HostSample {
    json: Value,
    procs: Value,
    point: Point,
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn unavailable(reason: impl Into<String>) -> Value {
    json!({"unavailable": reason.into()})
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn unreadable(what: &str) -> String {
    format!("{what} illisible : montez /proc de l'hôte, voir le README")
}

/// Average current and highest maximum frequency of the cores, in MHz.
fn cpu_freq(sys: &Path) -> (Option<f64>, Option<f64>) {
    let base = sys.join("devices/system/cpu");
    let (mut sum, mut n, mut max) = (0.0, 0, None::<f64>);
    for name in list_names(&base) {
        if !name.strip_prefix("cpu").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit())) {
            continue;
        }
        let dir = base.join(&name).join("cpufreq");
        if let Some(cur) = read_trim(&dir.join("scaling_cur_freq")).and_then(|s| s.parse::<f64>().ok()) {
            sum += cur / 1000.0;
            n += 1;
        }
        if let Some(m) = read_trim(&dir.join("cpuinfo_max_freq")).and_then(|s| s.parse::<f64>().ok()) {
            max = Some(max.map_or(m / 1000.0, |x| x.max(m / 1000.0)));
        }
    }
    ((n > 0).then(|| (sum / n as f64).round()), max.map(f64::round))
}

fn sample_host(cfg: &SysConfig, prev: &mut Prev, now: Instant) -> HostSample {
    let p = &cfg.proc_dir;
    let dt = prev.at.map(|t| now.duration_since(t).as_secs_f64()).filter(|d| *d > 0.0);
    let read = |rel: &str| std::fs::read_to_string(p.join(rel));
    let mut doc = Map::new();
    let mut point = Point::default();

    // cpu
    let stat = read("stat").ok().map(|s| parse_cpu_stat(&s));
    let cores = stat.as_ref().map_or(0, |(_, c)| c.len());
    let model = prev.cpu_model.get_or_insert_with(|| read("cpuinfo").ok().and_then(|s| parse_cpu_model(&s))).clone();
    match stat {
        Some((Some(all), per_core)) => {
            let pct = prev.cpu.as_ref().map(|(pa, pc)| {
                let per: Vec<f64> = per_core.iter().zip(pc.iter()).map(|(c, o)| r1(cpu_percent(*o, *c))).collect();
                (r1(cpu_percent(*pa, all)), per)
            });
            point.cpu = pct.as_ref().map(|(t, _)| *t);
            point.cores = pct.as_ref().map(|(_, c)| c.clone()).unwrap_or_default();
            let (freq, freq_max) = cpu_freq(&cfg.sys_dir);
            doc.insert(
                "cpu".into(),
                json!({"total": point.cpu, "cores": point.cores, "model": model, "freqMhz": freq, "freqMaxMhz": freq_max}),
            );
            prev.cpu = Some((all, per_core));
        }
        _ => {
            doc.insert("cpu".into(), unavailable(unreadable("HOST_PROC/stat")));
        }
    }

    // memory
    match read("meminfo").ok().and_then(|s| parse_meminfo(&s)) {
        Some(m) => {
            let used = m.total - m.available;
            point.mem = Some(r1(used as f64 / m.total.max(1) as f64 * 100.0));
            doc.insert(
                "memory".into(),
                json!({
                    "total": m.total, "used": used, "available": m.available, "buffersCache": m.buffers_cache,
                    "swapTotal": m.swap_total, "swapUsed": m.swap_used, "percent": point.mem,
                }),
            );
        }
        None => {
            doc.insert("memory".into(), unavailable(unreadable("HOST_PROC/meminfo")));
        }
    }

    // temperatures
    let temps = read_temps(&cfg.sys_dir);
    let max_temp = temps
        .iter()
        .map(|t| t.celsius)
        .filter(|c| (-20.0..150.0).contains(c))
        .fold(None, |m: Option<f64>, c| Some(m.map_or(c, |m| m.max(c))));
    point.temp = max_temp.map(r1);
    doc.insert(
        "temps".into(),
        if temps.is_empty() {
            unavailable("aucun capteur dans HOST_SYS/class/hwmon : montez /sys de l'hôte, voir le README")
        } else {
            json!({
                "max": point.temp,
                "sensors": temps.iter().map(|t| json!({
                    "source": t.source, "chip": t.chip, "label": t.label,
                    "celsius": r1(t.celsius), "high": t.high, "crit": t.crit,
                })).collect::<Vec<_>>(),
            })
        },
    );

    doc.insert("disks".into(), sample_disks(cfg));

    // disk activity
    let rate = |cur: u64, old: Option<u64>| match (dt, old) {
        (Some(dt), Some(o)) => cur.saturating_sub(o) as f64 / dt,
        _ => 0.0,
    };
    match read("diskstats") {
        Ok(s) => {
            let mut list = Vec::new();
            let mut next = HashMap::new();
            for d in parse_diskstats(&s) {
                let old = prev.disks.get(&d.name);
                let (r, w) = (rate(d.read_bytes, old.map(|o| o.0)), rate(d.write_bytes, old.map(|o| o.1)));
                let busy = match (dt, old) {
                    (Some(dt), Some(o)) => (d.busy_ms.saturating_sub(o.2) as f64 / (dt * 1000.0) * 100.0).min(100.0),
                    _ => 0.0,
                };
                point.dr += r;
                point.dw += w;
                point.busy = point.busy.max(busy);
                list.push(json!({"name": d.name, "readRate": r1(r), "writeRate": r1(w), "busy": r1(busy)}));
                next.insert(d.name.clone(), (d.read_bytes, d.write_bytes, d.busy_ms));
            }
            prev.disks = next;
            doc.insert("diskio".into(), json!({"devices": list}));
        }
        Err(_) => {
            doc.insert("diskio".into(), unavailable(unreadable("HOST_PROC/diskstats")));
        }
    }

    // network
    let net_path = p.join("1/net/dev");
    match std::fs::read_to_string(&net_path) {
        Ok(s) => {
            let mut list = Vec::new();
            let mut next = HashMap::new();
            for n in parse_net_dev(&s) {
                let old = prev.net.get(&n.name);
                let (rx, tx) = (rate(n.rx, old.map(|o| o.0)), rate(n.tx, old.map(|o| o.1)));
                let virt = is_virtual_iface(&n.name);
                if !virt {
                    point.rx += rx;
                    point.tx += tx;
                }
                list.push(json!({
                    "name": n.name, "rxRate": r1(rx), "txRate": r1(tx),
                    "rxTotal": n.rx, "txTotal": n.tx, "virtual": virt,
                }));
                next.insert(n.name.clone(), (n.rx, n.tx));
            }
            prev.net = next;
            doc.insert("network".into(), json!({"interfaces": list}));
        }
        Err(e) => {
            doc.insert(
                "network".into(),
                json!({"interfaces": [], "unavailable": format!("{} illisible ({e}) : montez /proc de l'hôte, voir le README", net_path.display())}),
            );
        }
    }

    let (procs, count, threads) = sample_processes(cfg, prev, dt, cores.max(1));
    doc.insert(
        "host".into(),
        json!({
            "hostname": read("sys/kernel/hostname").map(|s| s.trim().to_string()).ok(),
            "kernel": read("sys/kernel/osrelease").map(|s| s.trim().to_string()).ok(),
            "uptime": read("uptime").ok().and_then(|s| parse_uptime(&s)),
            "load": read("loadavg").ok().and_then(|s| parse_loadavg(&s)),
            "cores": cores,
            "processes": count,
            "threads": threads,
        }),
    );
    prev.at = Some(now);
    HostSample { json: Value::Object(doc), procs, point }
}

fn sample_disks(cfg: &SysConfig) -> Value {
    let (src, root) = match &cfg.root {
        Some(r) => (cfg.proc_dir.join("1/mounts"), r.clone()),
        None => (cfg.proc_dir.join("self/mounts"), PathBuf::from("/")),
    };
    let text = match std::fs::read_to_string(&src) {
        Ok(t) => t,
        Err(e) => return unavailable(format!("{} illisible ({e}) : montez /proc de l'hôte, voir le README", src.display())),
    };
    let items: Vec<Value> = parse_mounts(&text)
        .into_iter()
        .filter_map(|m| {
            let path = if cfg.root.is_some() { root.join(m.mountpoint.trim_start_matches('/')) } else { PathBuf::from(&m.mountpoint) };
            let u = statvfs(&path).filter(|u| u.total > 0)?;
            let percent = u.used as f64 / (u.used + u.free).max(1) as f64 * 100.0;
            Some(json!({
                "mountpoint": m.mountpoint, "device": m.device, "fstype": m.fstype,
                "total": u.total, "used": u.used, "free": u.free, "percent": r1(percent),
            }))
        })
        .collect();
    json!({"items": items})
}

/// Every process, as Task Manager lists them: CPU is a share of the whole machine (`cores` of them). Returns the list,
/// the number of processes (kernel threads left out) and of their threads.
fn sample_processes(cfg: &SysConfig, prev: &mut Prev, dt: Option<f64>, cores: usize) -> (Value, usize, u64) {
    let rd = match std::fs::read_dir(&cfg.proc_dir) {
        Ok(rd) => rd,
        Err(e) => return (unavailable(format!("{} illisible ({e}) : montez /proc de l'hôte, voir le README", cfg.proc_dir.display())), 0, 0),
    };
    let stale = prev.users.as_ref().is_none_or(|(at, _)| at.elapsed() >= Duration::from_secs(60));
    if stale {
        let passwd = cfg.root.as_ref().map_or_else(|| PathBuf::from("/etc/passwd"), |r| r.join("etc/passwd"));
        prev.users = Some((Instant::now(), std::fs::read_to_string(passwd).map(|s| parse_passwd(&s)).unwrap_or_default()));
    }
    let users = prev.users.as_ref().map(|(_, u)| u);
    let mut next = HashMap::new();
    let mut list = Vec::new();
    let (mut count, mut threads) = (0, 0u64);
    for entry in rd.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let dir = entry.path();
        // The process may vanish between any two reads.
        let Some(st) = std::fs::read_to_string(dir.join("stat")).ok().and_then(|s| parse_pid_stat(&s)) else { continue };
        let cpu = match (dt, prev.procs.get(&pid)) {
            (Some(dt), Some(old)) => (st.ticks.saturating_sub(*old) as f64 / CLK_TCK / dt / cores as f64 * 100.0).min(100.0),
            _ => 0.0,
        };
        next.insert(pid, st.ticks);
        let kernel = pid == 2 || st.ppid == 2;
        if !kernel {
            count += 1;
            threads += u64::from(st.threads);
        }
        let status = std::fs::read_to_string(dir.join("status")).unwrap_or_default();
        let uid = parse_uid(&status);
        let (name, cmd) = process_name(&st.comm, &std::fs::read(dir.join("cmdline")).unwrap_or_default());
        let container = std::fs::read_to_string(dir.join("cgroup")).ok().and_then(|s| container_of(&s));
        list.push(json!({
            "pid": pid, "ppid": st.ppid, "name": name, "cmd": cmd, "state": st.state.to_string(),
            "user": uid.map(|u| users.and_then(|m| m.get(&u)).cloned().unwrap_or_else(|| u.to_string())),
            "threads": st.threads, "rss": parse_vmrss(&status).unwrap_or(0), "cpu": r1(cpu),
            "container": container, "kernel": kernel,
        }));
    }
    prev.procs = next;
    (json!({"items": list}), count, threads)
}

// ---------------------------------------------------------------- monitor

#[derive(Clone, Default)]
struct Point {
    cpu: Option<f64>,
    cores: Vec<f64>,
    mem: Option<f64>,
    temp: Option<f64>,
    rx: f64,
    tx: f64,
    dr: f64,
    dw: f64,
    busy: f64,
}

struct Inner {
    host: Option<Value>,
    procs: Value,
    sampled_at: u64,
    live: VecDeque<Point>,
    history: VecDeque<Point>,
    last_point: Option<Instant>,
    containers: Value,
    viewed: Option<Instant>,
}

pub struct Monitor {
    cfg: SysConfig,
    inner: Mutex<Inner>,
}

fn push(q: &mut VecDeque<Point>, p: Point, len: usize) {
    if q.len() >= len {
        q.pop_front();
    }
    q.push_back(p);
}

impl Monitor {
    pub fn new(cfg: SysConfig) -> Arc<Self> {
        let containers = if cfg.docker_url.is_some() {
            unavailable("première lecture en cours")
        } else {
            json!({"configured": false, "unavailable": "non configuré"})
        };
        Arc::new(Self {
            cfg,
            inner: Mutex::new(Inner {
                host: None,
                procs: json!({"items": []}),
                sampled_at: 0,
                live: VecDeque::new(),
                history: VecDeque::new(),
                last_point: None,
                containers,
                viewed: None,
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Someone has the panel open: sampling runs at full speed for a while.
    fn watched(&self) -> bool {
        self.lock().viewed.is_some_and(|t| t.elapsed() < WATCHED_FOR)
    }

    /// Starts the background samplers. Call once from inside the runtime.
    pub fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut prev = Prev::default();
            let mut tick = tokio::time::interval(HOST_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                // Nobody looking: a sample every few seconds is enough for the history.
                if !me.watched() && prev.at.is_some_and(|t| t.elapsed() < IDLE_EVERY) {
                    continue;
                }
                let cfg = me.cfg.clone();
                match tokio::task::spawn_blocking(move || {
                    let s = sample_host(&cfg, &mut prev, Instant::now());
                    (s, prev)
                })
                .await
                {
                    Ok((s, p)) => {
                        prev = p;
                        me.store(s);
                    }
                    Err(_) => prev = Prev::default(),
                }
            }
        });
        if let Some(url) = self.cfg.docker_url.clone() {
            let me = self.clone();
            tokio::spawn(async move { me.containers_loop(url).await });
        }
    }

    fn store(&self, s: HostSample) {
        let mut g = self.lock();
        g.host = Some(s.json);
        g.procs = s.procs;
        g.sampled_at = unix_now();
        if g.last_point.is_none_or(|t| t.elapsed() >= HISTORY_EVERY) {
            g.last_point = Some(Instant::now());
            push(&mut g.history, Point { cores: Vec::new(), ..s.point.clone() }, HISTORY_LEN);
        }
        push(&mut g.live, s.point, LIVE_LEN);
    }

    async fn containers_loop(self: Arc<Self>, base: String) {
        let base = base.trim_end_matches('/').to_string();
        let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(5)).build() else { return };
        let mut prev: HashMap<String, ContainerPrev> = HashMap::new();
        loop {
            let value = match fetch_containers(&client, &base, &mut prev).await {
                Ok(items) => json!({"configured": true, "items": items}),
                Err(e) => json!({"configured": true, "unavailable": e, "items": []}),
            };
            self.lock().containers = value;
            let wait = if self.watched() { CONTAINERS_EVERY } else { CONTAINERS_IDLE_EVERY };
            tokio::time::sleep(wait).await;
        }
    }

    /// The `GET /api/admin/system` document; with `processes`, every process too.
    pub fn snapshot(&self, processes: bool) -> Value {
        let mut g = self.lock();
        g.viewed = Some(Instant::now());
        let mut doc = match &g.host {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        doc.insert("ready".into(), json!(g.host.is_some()));
        doc.insert("sampledAt".into(), json!(g.sampled_at));
        doc.insert("containers".into(), g.containers.clone());
        if processes {
            doc.insert("processes".into(), g.procs.clone());
        }
        let series = |q: &VecDeque<Point>, step: u64| {
            let col = |f: fn(&Point) -> Option<f64>| q.iter().map(|p| f(p).map(r1)).collect::<Vec<_>>();
            json!({
                "step": step,
                "cpu": col(|p| p.cpu), "mem": col(|p| p.mem), "temp": col(|p| p.temp),
                "rx": col(|p| Some(p.rx)), "tx": col(|p| Some(p.tx)),
                "dr": col(|p| Some(p.dr)), "dw": col(|p| Some(p.dw)), "busy": col(|p| Some(p.busy)),
            })
        };
        let mut live = series(&g.live, HOST_EVERY.as_secs());
        live["cores"] = json!(g.live.iter().map(|p| p.cores.clone()).collect::<Vec<_>>());
        doc.insert("live".into(), live);
        doc.insert("history".into(), series(&g.history, HISTORY_EVERY.as_secs()));
        Value::Object(doc)
    }
}

#[derive(Clone, Copy)]
struct ContainerPrev {
    at: Instant,
    raw: Option<CpuRaw>,
    rx: u64,
    tx: u64,
    br: u64,
    bw: u64,
}

async fn fetch_containers(
    client: &reqwest::Client,
    base: &str,
    prev: &mut HashMap<String, ContainerPrev>,
) -> Result<Vec<Value>, String> {
    let get = |url: String| {
        let client = client.clone();
        async move {
            let r = client.get(url).send().await.map_err(|e| e.without_url().to_string())?;
            if !r.status().is_success() {
                return Err(format!("HTTP {}", r.status()));
            }
            r.text().await.map_err(|e| e.without_url().to_string())
        }
    };
    let text = get(format!("{base}/containers/json?all=1")).await.map_err(|e| format!("Docker injoignable : {e}"))?;
    let mut list = parse_container_list(&text).ok_or("réponse Docker illisible")?;
    list.sort_by(|a, b| a.name.cmp(&b.name));
    let mut set = tokio::task::JoinSet::new();
    for c in list.iter().filter(|c| c.state == "running") {
        let (id, old) = (c.id.clone(), prev.get(&c.id).and_then(|p| p.raw));
        let fut = get(format!("{base}/containers/{id}/stats?stream=false&one-shot=true"));
        set.spawn(async move { (id, fut.await.ok().and_then(|t| parse_container_stats(&t, old))) });
    }
    let mut stats = HashMap::new();
    while let Some(Ok((id, s))) = set.join_next().await {
        if let Some(s) = s {
            stats.insert(id, s);
        }
    }
    let now = Instant::now();
    let mut next = HashMap::new();
    let items = list
        .iter()
        .map(|c| {
            let s = stats.get(&c.id);
            let old = prev.get(&c.id).copied();
            let rate = |cur: u64, f: fn(&ContainerPrev) -> u64| {
                old.map(|o| (o, now.duration_since(o.at).as_secs_f64()))
                    .filter(|(_, dt)| *dt > 0.0)
                    .map(|(o, dt)| r1(cur.saturating_sub(f(&o)) as f64 / dt))
            };
            if let Some(s) = s {
                next.insert(c.id.clone(), ContainerPrev { at: now, raw: s.raw, rx: s.rx, tx: s.tx, br: s.blk_read, bw: s.blk_write });
            }
            json!({
                "id": c.id.chars().take(12).collect::<String>(), "name": c.name, "image": c.image,
                "state": c.state, "status": c.status, "project": c.project,
                "cpu": s.and_then(|s| s.cpu_percent).map(r1),
                "memUsed": s.map(|s| s.mem_used), "memLimit": s.map(|s| s.mem_limit),
                "rx": s.map(|s| s.rx), "tx": s.map(|s| s.tx),
                "rxRate": s.and_then(|s| rate(s.rx, |o| o.rx)), "txRate": s.and_then(|s| rate(s.tx, |o| o.tx)),
                "readRate": s.and_then(|s| rate(s.blk_read, |o| o.br)), "writeRate": s.and_then(|s| rate(s.blk_write, |o| o.bw)),
                "pids": s.and_then(|s| s.pids),
            })
        })
        .collect();
    *prev = next;
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMINFO: &str = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    9000000 kB\nBuffers:          500000 kB\nCached:          6000000 kB\nSReclaimable:     200000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n";

    #[test]
    fn meminfo() {
        let m = parse_meminfo(MEMINFO).unwrap();
        assert_eq!(m.total, 16_000_000 * 1024);
        assert_eq!(m.available, 9_000_000 * 1024);
        assert_eq!(m.buffers_cache, 6_700_000 * 1024);
        assert_eq!((m.swap_total, m.swap_used), (2_000_000 * 1024, 500_000 * 1024));
        assert!(parse_meminfo("nonsense").is_none());
    }

    #[test]
    fn cpu_stat_and_percent() {
        let a = "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0\nintr 5\n";
        let b = "cpu  200 0 200 750 150 0 0 0 0 0\ncpu0 100 0 100 375 75 0 0 0 0 0\ncpu1 100 0 100 375 75 0 0 0 0 0\n";
        let (ta, ca) = parse_cpu_stat(a);
        let (tb, cb) = parse_cpu_stat(b);
        assert_eq!(ca.len(), 2);
        // delta total 300, delta idle 100 => 66.6 %
        let p = cpu_percent(ta.unwrap(), tb.unwrap());
        assert!((p - 66.666).abs() < 0.01, "{p}");
        assert!((cpu_percent(ca[0], cb[0]) - 66.666).abs() < 0.01);
        assert_eq!(cpu_percent(ta.unwrap(), ta.unwrap()), 0.0);
    }

    #[test]
    fn load_and_uptime() {
        assert_eq!(parse_loadavg("0.52 0.40 0.31 1/234 5678\n"), Some([0.52, 0.40, 0.31]));
        assert_eq!(parse_uptime("12345.67 54321.00\n"), Some(12345.67));
        assert_eq!(parse_uptime(""), None);
    }

    #[test]
    fn net_dev() {
        let s = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n  eth0: 123456 100 0 0 0 0 0 0 654321 90 0 0 0 0 0 0\nveth1a2b:5 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0\n";
        let v = parse_net_dev(s);
        assert_eq!(v.len(), 3);
        assert_eq!(v[1], NetCounters { name: "eth0".into(), rx: 123_456, tx: 654_321 });
        assert_eq!((v[2].rx, v[2].tx), (5, 7));
        assert!(is_virtual_iface("lo") && is_virtual_iface("veth1a2b") && is_virtual_iface("br-abc") && is_virtual_iface("docker0"));
        assert!(!is_virtual_iface("eth0"));
    }

    #[test]
    fn mounts() {
        let s = "proc /proc proc rw 0 0\n/dev/sda1 / ext4 rw,relatime 0 0\n/dev/sda1 /var/lib/docker ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sdb1 /mnt/My\\040Disk xfs rw 0 0\n/dev/sdc1 /boot/efi vfat rw 0 0\noverlay /var/x overlay rw 0 0\n";
        let m = parse_mounts(s);
        assert_eq!(m.len(), 3);
        assert_eq!((m[0].device.as_str(), m[0].mountpoint.as_str()), ("/dev/sda1", "/"));
        assert_eq!(m[1].mountpoint, "/mnt/My Disk");
        assert_eq!(m[2].fstype, "vfat");
    }

    #[test]
    fn pid_stat_with_tricky_comm() {
        let s = "42 (my (weird) proc) S 1 42 42 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 100 1000 200 18446744073709551615";
        assert_eq!(
            parse_pid_stat(s),
            Some(PidStat { comm: "my (weird) proc".to_string(), state: 'S', ppid: 1, ticks: 200, threads: 1 })
        );
        assert_eq!(parse_pid_stat("garbage"), None);
        assert_eq!(parse_uid("Name:\tx\nUid:\t1000\t1000\t1000\t1000\n"), Some(1000));
        assert_eq!(parse_vmrss("Name:\tx\nVmRSS:\t   2048 kB\n"), Some(2048 * 1024));
        assert_eq!(parse_vmrss("Name:\tkthreadd\n"), None);
    }

    #[test]
    fn temps_from_a_fake_sys_tree() {
        let root = std::env::temp_dir().join(format!("shh-sys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let w = |rel: &str, v: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, v).unwrap();
        };
        w("class/hwmon/hwmon0/name", "coretemp\n");
        w("class/hwmon/hwmon0/temp1_input", "45000\n");
        w("class/hwmon/hwmon0/temp1_label", "Package id 0\n");
        w("class/hwmon/hwmon0/temp1_max", "80000\n");
        w("class/hwmon/hwmon0/temp1_crit", "100000\n");
        w("class/hwmon/hwmon0/temp2_input", "41500\n");
        w("class/hwmon/hwmon10/temp1_input", "30000\n");
        w("class/thermal/thermal_zone0/type", "acpitz\n");
        w("class/thermal/thermal_zone0/temp", "27800\n");
        w("class/thermal/thermal_zone0/trip_point_0_type", "critical\n");
        w("class/thermal/thermal_zone0/trip_point_0_temp", "105000\n");
        let t = read_temps(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(t.len(), 4);
        assert_eq!((t[0].chip.as_str(), t[0].label.as_str(), t[0].celsius), ("coretemp", "Package id 0", 45.0));
        assert_eq!((t[0].high, t[0].crit), (Some(80.0), Some(100.0)));
        assert_eq!((t[1].label.as_str(), t[1].high), ("temp2", None));
        assert_eq!(t[2].chip, "hwmon10");
        assert_eq!((t[3].source, t[3].chip.as_str(), t[3].crit), ("thermal", "acpitz", Some(105.0)));
    }

    #[test]
    fn docker_list() {
        let s = r#"[{"Id":"abcdef1234567890","Names":["/navidrome"],"Image":"deluan/navidrome:latest","State":"running","Status":"Up 2 hours","Labels":{"com.docker.compose.project":"navidrome"}},{"Id":"0123","Names":[],"Image":"x","State":"exited","Status":"Exited (0)"}]"#;
        let v = parse_container_list(s).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!((v[0].name.as_str(), v[0].project.as_deref(), v[0].state.as_str()), ("navidrome", Some("navidrome"), "running"));
        assert_eq!((v[1].name.as_str(), v[1].project.clone()), ("0123", None));
        assert!(parse_container_list("{}").is_none());
    }

    #[test]
    fn docker_stats_with_precpu() {
        let s = r#"{"cpu_stats":{"cpu_usage":{"total_usage":2000000},"system_cpu_usage":100000000,"online_cpus":4},
            "precpu_stats":{"cpu_usage":{"total_usage":1000000},"system_cpu_usage":90000000},
            "memory_stats":{"usage":300,"limit":1000,"stats":{"inactive_file":100,"cache":999}},
            "networks":{"eth0":{"rx_bytes":10,"tx_bytes":20},"eth1":{"rx_bytes":1,"tx_bytes":2}}}"#;
        let c = parse_container_stats(s, None).unwrap();
        // 1e6 / 1e7 * 100 = 10 % of the whole machine (docker stats would say 40 %, per core)
        assert!((c.cpu_percent.unwrap() - 10.0).abs() < 1e-9);
        assert_eq!((c.mem_used, c.mem_limit, c.rx, c.tx), (200, 1000, 11, 22));
        assert_eq!((c.blk_read, c.blk_write, c.pids), (0, 0, None));
        let io = r#"{"cpu_stats":{},"memory_stats":{},"pids_stats":{"current":7},
            "blkio_stats":{"io_service_bytes_recursive":[{"major":8,"minor":0,"op":"read","value":4096},{"major":8,"minor":0,"op":"write","value":100},{"op":"Read","value":4}]}}"#;
        let blk = parse_container_stats(io, None).unwrap();
        assert_eq!((blk.blk_read, blk.blk_write, blk.pids), (4100, 100, Some(7)));
        assert_eq!(c.raw, Some(CpuRaw { total: 2_000_000, system: 100_000_000 }));
    }

    #[test]
    fn docker_stats_one_shot_uses_previous_sample() {
        let s = r#"{"cpu_stats":{"cpu_usage":{"total_usage":3000,"percpu_usage":[1,2]},"system_cpu_usage":20000},
            "precpu_stats":{"cpu_usage":{"total_usage":0},"system_cpu_usage":0},
            "memory_stats":{"usage":500,"limit":0,"stats":{"cache":50}}}"#;
        let first = parse_container_stats(s, None).unwrap();
        assert_eq!(first.cpu_percent, None);
        assert_eq!(first.mem_used, 450);
        let prev = CpuRaw { total: 1000, system: 10000 };
        // 2000 / 10000 * 100 = 20 % of the machine
        let second = parse_container_stats(s, Some(prev)).unwrap();
        assert!((second.cpu_percent.unwrap() - 20.0).abs() < 1e-9);
    }

    #[test]
    fn passwd_and_containers() {
        let p = parse_passwd("root:x:0:0:root:/root:/bin/bash\nmboot:x:1000:100::/home/mboot:/bin/bash\nbad line\n");
        assert_eq!((p[&0].as_str(), p[&1000].as_str(), p.len()), ("root", "mboot", 2));
        let id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(container_of(&format!("0::/system.slice/docker-{id}.scope\n")).as_deref(), Some("0123456789ab"));
        assert_eq!(container_of(&format!("12:memory:/docker/{id}\n")).as_deref(), Some("0123456789ab"));
        assert_eq!(container_of("0::/user.slice/user-1000.slice/session-1.scope\n"), None);
        assert_eq!(container_of(&format!("0::/x/{id}0\n")), None, "65 hex digits are not an id");
    }

    #[test]
    fn names_of_processes() {
        assert_eq!(process_name("selfhost-hub-se", b"/selfhost-hub-server\0--flag\0"), ("selfhost-hub-server".into(), "/selfhost-hub-server --flag".into()));
        assert_eq!(process_name("java", b"/usr/bin/java\0-jar\0x.jar\0"), ("java".into(), "/usr/bin/java -jar x.jar".into()));
        // A program that renamed itself keeps its comm.
        assert_eq!(process_name("postgres", b"postgres: checkpointer\0").0, "postgres");
        assert_eq!(process_name("kworker/0:1", b""), ("kworker/0:1".into(), String::new()));
        assert_eq!(process_name("x", &[b'a'; 400]).1.len(), 300);
    }

    #[test]
    fn diskstats_and_cpuinfo() {
        let s = "   8       0 sda 100 0 2000 50 10 0 400 20 0 30 70 0 0 0 0\n   8       1 sda1 90 0 1800 40 9 0 300 10 0 20 50\n 259 0 nvme0n1 1 0 8 1 1 0 16 1 0 5 2\n 259 1 nvme0n1p1 1 0 8 1 1 0 16 1 0 5 2\n   7 0 loop0 5 0 10 0 0 0 0 0 0 1 0\n 253 0 dm-0 1 0 1 0 1 0 1 0 0 1 0\n";
        let d = parse_diskstats(s);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], DiskCounters { name: "sda".into(), read_bytes: 2000 * 512, write_bytes: 400 * 512, busy_ms: 30 });
        assert_eq!(d[1].name, "nvme0n1");
        assert!(is_whole_disk("vda") && is_whole_disk("mmcblk0") && !is_whole_disk("mmcblk0p1") && !is_whole_disk("sd"));
        assert_eq!(
            parse_cpu_model("processor\t: 0\nmodel name\t: Intel(R) Core(TM)   i5-6400 CPU @ 2.70GHz\n").as_deref(),
            Some("Intel(R) Core(TM) i5-6400 CPU @ 2.70GHz")
        );
    }
}
