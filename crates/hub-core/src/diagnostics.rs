//! What the Diagnostic screen shows, gathered into one [`Snapshot`] so the same text can be copied as a report: the
//! report itself, the list of what is wrong right now, and the redaction that hides whose servers they are before
//! the report is pasted to someone else.
//!
//! Port of `mobile/src/services/diagnosticsReport.ts`, plus the log entry types of `diagnostics.ts` that the report
//! reads. The record itself (keeping the 300 newest lines, saving and merging runs) is the app's: this only formats.
//!
//! Everything the phone has to ask the device (the snapshot, the clock, the time zone) comes in as a parameter. The
//! texts are the screen's and stay in French, verbatim.

use jiff::tz::TimeZone;
use jiff::{Timestamp, ZonedDateTime};

/// Where in the app a log line comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogScope {
    App,
    Backup,
    Photos,
    Files,
    Music,
    Scrobbler,
    Update,
    Remote,
    Connection,
    Lock,
    Watch,
}

impl LogScope {
    /// The scope as the report words it.
    pub fn label(self) -> &'static str {
        match self {
            Self::App => "application",
            Self::Backup => "sauvegarde",
            Self::Photos => "photos",
            Self::Files => "fichiers",
            Self::Music => "musique",
            Self::Scrobbler => "écoutes",
            Self::Update => "mise à jour",
            Self::Remote => "contrôle à distance",
            Self::Connection => "connexion",
            Self::Lock => "verrouillage",
            Self::Watch => "montre",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// One line of the activity record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    /// When it happened (ms since the epoch).
    pub t: i64,
    pub scope: LogScope,
    pub level: LogLevel,
    pub message: String,
}

/// Whether a server works, as the screen colours it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ServerState {
    /// Signed in and working.
    Ok,
    /// Configured but not working.
    Down,
    /// Never set up.
    #[default]
    Off,
}

/// How the last connection test of a server went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Latency {
    /// Nothing was tested.
    #[default]
    Untested,
    /// The test failed: the server did not answer.
    Failed,
    /// How long the test took (ms).
    Ms(u64),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ServerLine {
    pub name: String,
    pub state: ServerState,
    /// "connecté", "déconnecté", "erreur"... as the screen words it.
    pub status: String,
    pub account: Option<String>,
    pub host: Option<String>,
    pub latency: Latency,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupLine {
    pub enabled: bool,
    /// The backup's phase as the app names it ("idle", "waiting-wifi"...); see [`describe_phase`].
    pub phase: String,
    /// The folder photos go to on the server.
    pub destination: Option<String>,
    pub pending: Option<u32>,
    pub uploaded: u32,
    pub gave_up: u32,
    pub last_success_at: Option<i64>,
    pub last_check_at: Option<i64>,
    pub error: Option<String>,
    /// Photos and videos taken after this moment are backed up (ms), or `None` before anything was read.
    pub cursor: Option<i64>,
    pub remembered_sent: Option<u32>,
    pub failing: Option<u32>,
    /// The state of the photo permission, as the screen words it ("accordé", "limité", "refusé", "inconnu").
    pub permission: String,
    pub network: String,
    pub charging: Option<bool>,
    pub wifi_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppLine {
    pub version: String,
    pub build: String,
    pub device: String,
    pub lock: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteLine {
    pub enabled: bool,
    /// As the screen words it.
    pub status: String,
    /// It is an error, not just "not connected".
    pub failed: bool,
    pub paired: bool,
    pub error: Option<String>,
}

/// Everything the Diagnostic screen shows, at one moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The moment of the snapshot (ms since the epoch).
    pub now: i64,
    pub app: AppLine,
    pub servers: Vec<ServerLine>,
    pub backup: BackupLine,
    pub remote: RemoteLine,
    /// Oldest first.
    pub entries: Vec<LogEntry>,
}

/// How many log lines the report holds unless asked otherwise.
pub const DEFAULT_LOG_LINES: usize = 80;

// --- Times and words ---

/// The moment in the phone's own time. A time outside what a timestamp can hold shows as the epoch.
fn local(t: i64, tz: &TimeZone) -> ZonedDateTime {
    Timestamp::from_millisecond(t)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned_datetime(tz.clone())
}

/// "02/10/2026 11:20:05" in the phone's own time.
pub fn format_date_time(t: i64, tz: &TimeZone) -> String {
    let d = local(t, tz);
    format!(
        "{:02}/{:02}/{} {:02}:{:02}:{:02}",
        d.day(),
        d.month(),
        d.year(),
        d.hour(),
        d.minute(),
        d.second()
    )
}

/// "11:20:05".
pub fn format_time_of_day(t: i64, tz: &TimeZone) -> String {
    let d = local(t, tz);
    format!("{:02}:{:02}:{:02}", d.hour(), d.minute(), d.second())
}

/// The time of day for today's lines, the day and time for older ones: "11:20:05" / "01/10 22:04".
pub fn format_stamp(t: i64, now: i64, tz: &TimeZone) -> String {
    let d = local(t, tz);
    if d.date() == local(now, tz).date() {
        format_time_of_day(t, tz)
    } else {
        format!(
            "{:02}/{:02} {:02}:{:02}",
            d.day(),
            d.month(),
            d.hour(),
            d.minute()
        )
    }
}

/// The backup's phase in words. A phase this version does not know is shown as it is.
pub fn describe_phase(phase: &str) -> &str {
    match phase {
        "idle" => "au repos",
        "running" => "envoi en cours",
        "waiting-wifi" => "attend le Wi-Fi",
        "waiting-charger" => "attend le chargeur",
        "no-permission" => "accès aux photos refusé",
        "no-server" => "FileBrowser injoignable",
        "error" => "interrompue",
        other => other,
    }
}

/// "il y a 5 min" / "il y a 2 h" / "il y a 3 j" relative to `now`.
pub fn ago(t: Option<i64>, now: i64) -> String {
    let Some(t) = t else {
        return "jamais".to_owned();
    };
    // Rounded half up, like the app's Math.round; a time in the future counts as now.
    let minutes = ((now - t) as f64 / 60_000.0 + 0.5).floor().max(0.0) as i64;
    if minutes < 1 {
        return "à l'instant".to_owned();
    }
    if minutes < 60 {
        return format!("il y a {minutes} min");
    }
    let hours = (minutes + 30) / 60;
    if hours < 24 {
        return format!("il y a {hours} h");
    }
    format!("il y a {} j", (hours + 12) / 24)
}

// --- What is hidden ---

/// Names shorter than this are only replaced where they stand alone.
const SHORT_SECRET: usize = 5;

/// A name to hide, and what to write in its place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Secret {
    pub value: String,
    pub label: String,
}

/// The characters that make a short name part of a longer word: letters and digits, accents included (À-ÿ).
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || ('\u{C0}'..='\u{FF}').contains(&c)
}

/// One character in lower case. A character whose lower case is several (or none) stays as it is, so the text and the
/// name always compare character for character.
fn lower(c: char) -> char {
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// Hides what identifies the person or the servers: every secret given (host names, account names...) is replaced by
/// a label, whatever case it is in. The report is copied by hand and pasted to someone else, so it should say what
/// went wrong without saying whose server it is.
///
/// One pass over the text, longest secret first at each spot, so a label that was put in is never read again as part
/// of another secret (an account called "navidrome" must not eat the label of the Navidrome host).
pub fn redact(text: &str, secrets: &[Secret]) -> String {
    let mut by_length: Vec<&Secret> = secrets.iter().collect();
    // Stable, so of two secrets of the same length the first one given wins.
    by_length.sort_by_key(|s| std::cmp::Reverse(s.value.trim().chars().count()));

    let mut ordered: Vec<(Vec<char>, &str)> = Vec::new();
    let mut seen: Vec<Vec<char>> = Vec::new();
    for secret in by_length {
        let name: Vec<char> = secret.value.trim().chars().map(lower).collect();
        if name.len() < 2 || seen.contains(&name) {
            continue;
        }
        seen.push(name.clone());
        ordered.push((name, &secret.label));
    }
    if ordered.is_empty() {
        return text.to_owned();
    }

    let chars: Vec<char> = text.chars().collect();
    let folded: Vec<char> = chars.iter().copied().map(lower).collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let hit = ordered.iter().find(|(name, _)| {
            let end = i + name.len();
            if end > chars.len() || folded[i..end] != name[..] {
                return false;
            }
            // A short name ("al") also sits inside other words ("normal"): only the whole word is replaced.
            let inside_word = (i > 0 && is_word_char(chars[i - 1]))
                || chars.get(end).copied().is_some_and(is_word_char);
            name.len() >= SHORT_SECRET || !inside_word
        });
        match hit {
            Some((name, label)) => {
                out.push_str(label);
                i += name.len();
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// "nas.local:4533" from "https://nas.local:4533/music".
pub fn host_of(url: &str) -> String {
    let url = url.trim();
    let without_scheme = match url.split_once(':') {
        Some((scheme, rest)) if is_scheme(scheme) && rest.starts_with("//") => &rest[2..],
        _ => url,
    };
    without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// A URL scheme: a letter, then letters, digits, "+", "." or "-".
fn is_scheme(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// The same without its port: "nas.local".
pub fn host_name(url: &str) -> String {
    let host = host_of(url);
    if host.starts_with('[') {
        // An IPv6 address keeps its brackets; a host that never closes them has nothing worth keeping.
        let end = host.find(']').map_or(0, |i| i + 1);
        return host[..end].to_owned();
    }
    match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            name.to_owned()
        }
        _ => host,
    }
}

/// What identifies one service: where it is and who signs in to it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ServiceIdentity {
    pub label: String,
    pub url: Option<String>,
    /// The accounts that sign in to it; an account that is not set is left out.
    pub accounts: Vec<String>,
}

/// The secrets to hide from a report, with a label each that says what was there.
pub fn secrets_for(services: &[ServiceIdentity]) -> Vec<Secret> {
    let mut secrets = Vec::new();
    for service in services {
        let label = &service.label;
        if let Some(url) = service.url.as_deref().filter(|u| !u.is_empty()) {
            let base = url.trim().trim_end_matches('/');
            secrets.push(Secret {
                value: base.to_owned(),
                label: format!("[adresse {label}]"),
            });
            secrets.push(Secret {
                value: host_of(base),
                label: format!("[hôte {label}]"),
            });
            secrets.push(Secret {
                value: host_name(base),
                label: format!("[hôte {label}]"),
            });
        }
        for account in service.accounts.iter().filter(|a| !a.is_empty()) {
            secrets.push(Secret {
                value: account.clone(),
                label: format!("[compte {label}]"),
            });
        }
    }
    secrets
}

/// Where an IPv4 address (with an optional port) starts at `start` and how far it goes, as `\b\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?\b`
/// would read it. Written by hand to keep a regex library out of the crate.
fn ipv4_at(chars: &[char], start: usize) -> Option<usize> {
    // A word character is a letter, a digit or "_": "v1.2.3.4" is not an address.
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let digits = |from: usize| {
        chars[from.min(chars.len())..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    if start > 0 && word(chars[start - 1]) {
        return None;
    }
    let mut at = start;
    for octet in 0..4 {
        if octet > 0 {
            if chars.get(at) != Some(&'.') {
                return None;
            }
            at += 1;
        }
        // A digit run longer than 3 cannot be cut anywhere that satisfies the next step.
        let run = digits(at);
        if !(1..=3).contains(&run) {
            return None;
        }
        at += run;
    }
    let boundary = |end: usize| !chars.get(end).copied().is_some_and(word);
    if chars.get(at) == Some(&':') {
        let port = digits(at + 1);
        if (1..=5).contains(&port) && boundary(at + 1 + port) {
            return Some(at + 1 + port);
        }
    }
    boundary(at).then_some(at)
}

/// Any IPv4 address left in the text (a PC found on the network, say) is hidden too.
pub fn mask_addresses(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        match chars[i]
            .is_ascii_digit()
            .then(|| ipv4_at(&chars, i))
            .flatten()
        {
            Some(end) => {
                out.push_str("[adresse IP]");
                i = end;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

// --- The report ---

fn yes_no(value: bool) -> &'static str {
    if value { "oui" } else { "non" }
}

/// What the screen's fields hold when they are empty text: not set.
fn non_empty(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|t| !t.is_empty())
}

fn count_or(value: Option<u32>, unknown: &str) -> String {
    value.map_or_else(|| unknown.to_owned(), |n| n.to_string())
}

/// The report as plain text, newest log lines last. `log_lines` is how many of them it keeps
/// ([`DEFAULT_LOG_LINES`] when `None`); times are in `tz`, the phone's own.
pub fn build_report(snapshot: &Snapshot, tz: &TimeZone, log_lines: Option<usize>) -> String {
    let Snapshot {
        now,
        app,
        servers,
        backup,
        remote,
        entries,
    } = snapshot;
    let mut lines: Vec<String> = Vec::new();
    lines.push("SelfHost Hub — rapport de diagnostic".to_owned());
    lines.push(format!("Généré le {}", format_date_time(*now, tz)));
    lines.push(String::new());

    lines.push("Application".to_owned());
    lines.push(format!("  Version : {} (build {})", app.version, app.build));
    lines.push(format!("  Appareil : {}", app.device));
    lines.push(format!(
        "  Verrouillage : {}",
        if app.lock { "activé" } else { "désactivé" }
    ));
    lines.push(String::new());

    lines.push("Serveurs".to_owned());
    for server in servers {
        let mut parts = vec![server.status.clone()];
        if let Some(account) = non_empty(&server.account) {
            parts.push(format!("compte « {account} »"));
        }
        if let Some(host) = non_empty(&server.host) {
            parts.push(host.to_owned());
        }
        match server.latency {
            Latency::Untested => {}
            Latency::Failed => parts.push("ne répond pas".to_owned()),
            Latency::Ms(ms) => parts.push(format!("{ms} ms")),
        }
        if let Some(detail) = non_empty(&server.detail) {
            parts.push(detail.to_owned());
        }
        lines.push(format!("  {} : {}", server.name, parts.join(" — ")));
    }
    lines.push(String::new());

    lines.push("Sauvegarde des photos".to_owned());
    lines.push(format!(
        "  Activée : {} (état : {})",
        yes_no(backup.enabled),
        describe_phase(&backup.phase)
    ));
    lines.push(format!(
        "  Destination : {}",
        backup.destination.as_deref().unwrap_or("—")
    ));
    lines.push(format!(
        "  En attente : {} · envoyés : {} · refusés par le serveur : {}",
        count_or(backup.pending, "?"),
        backup.uploaded,
        backup.gave_up
    ));
    lines.push(format!(
        "  Dernier envoi : {} · dernière vérification : {}",
        ago(backup.last_success_at, *now),
        ago(backup.last_check_at, *now)
    ));
    lines.push(format!(
        "  Accès aux photos : {} · réseau : {}{} · en charge : {}",
        backup.permission,
        backup.network,
        if backup.wifi_only {
            " (Wi-Fi uniquement)"
        } else {
            ""
        },
        backup.charging.map_or("?", yes_no)
    ));
    if let Some(cursor) = backup.cursor {
        let reached = if cursor > 0 {
            format!(
                "tout ce qui date d'avant {} est sauvegardé",
                format_date_time(cursor, tz)
            )
        } else {
            "rien n’a encore été passé en revue".to_owned()
        };
        lines.push(format!(
            "  Journal : {reached} · {} fichiers retenus · {} en échec",
            backup.remembered_sent.unwrap_or(0),
            backup.failing.unwrap_or(0)
        ));
    }
    if let Some(error) = non_empty(&backup.error) {
        lines.push(format!("  Dernière erreur : {error}"));
    }
    lines.push(String::new());

    lines.push("Contrôle à distance".to_owned());
    lines.push(format!(
        "  Activé : {} · état : {} · appairé : {}{}",
        yes_no(remote.enabled),
        remote.status,
        yes_no(remote.paired),
        non_empty(&remote.error).map_or_else(String::new, |e| format!(" · {e}"))
    ));
    lines.push(String::new());

    let keep = log_lines.unwrap_or(DEFAULT_LOG_LINES);
    let shown = &entries[entries.len().saturating_sub(keep)..];
    lines.push(format!("Journal (les {} derniers événements)", shown.len()));
    if shown.is_empty() {
        lines.push("  (vide)".to_owned());
    }
    for entry in shown {
        let mark = match entry.level {
            LogLevel::Error => "!! ",
            LogLevel::Warn => "!  ",
            LogLevel::Info => "   ",
        };
        lines.push(format!(
            "{mark}{} [{}] {}",
            format_date_time(entry.t, tz),
            entry.scope.label(),
            entry.message
        ));
    }
    lines.join("\n")
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// "s" when more than one: the screen's plural for "fichier".
fn s_if_many(n: u32) -> &'static str {
    if n > 1 { "s" } else { "" }
}

/// What is wrong right now, in a sentence each, for the line at the top of the screen. Empty when all is well.
pub fn find_problems(snapshot: &Snapshot) -> Vec<String> {
    let Snapshot {
        now,
        servers,
        backup,
        remote,
        entries,
        ..
    } = snapshot;
    let mut problems = Vec::new();

    for server in servers {
        let detail = non_empty(&server.detail);
        match server.state {
            ServerState::Down => problems.push(format!(
                "{} : {}.",
                server.name,
                server.detail.as_deref().unwrap_or(&server.status)
            )),
            ServerState::Ok if server.latency == Latency::Failed => problems.push(format!(
                "{} ne répond pas au test{}.",
                server.name,
                detail.map_or_else(String::new, |d| format!(" ({d})"))
            )),
            ServerState::Ok => {
                if let Some(detail) = detail {
                    problems.push(format!("{} : {detail}.", server.name));
                }
            }
            ServerState::Off => {}
        }
    }

    if backup.enabled {
        if backup.phase == "no-permission" || backup.permission == "refusé" {
            problems.push("La sauvegarde n'a pas accès aux photos du téléphone.".to_owned());
        } else if backup.permission == "limité" {
            problems.push("L'accès aux photos est limité à celles que vous avez choisies : le reste n'est pas sauvegardé.".to_owned());
        }
        if backup.phase == "no-server" {
            problems.push(format!(
                "La sauvegarde ne joint pas FileBrowser{}.",
                non_empty(&backup.error).map_or_else(String::new, |e| format!(" ({e})"))
            ));
        }
        if backup.phase == "error" {
            problems.push(format!(
                "La sauvegarde est interrompue : {}.",
                backup.error.as_deref().unwrap_or("erreur inconnue")
            ));
        }
        if backup.gave_up > 0 {
            problems.push(format!(
                "{} fichier{} que le serveur refuse.",
                backup.gave_up,
                s_if_many(backup.gave_up)
            ));
        }
        let waiting = backup.pending.unwrap_or(0);
        let stalled = backup
            .last_success_at
            .is_some_and(|last| now - last > 3 * DAY_MS);
        if waiting > 0 && backup.phase == "idle" && stalled {
            problems.push(format!(
                "{waiting} fichier{} depuis plus de 3 jours : aucun envoi n'a abouti.",
                if waiting > 1 {
                    "s attendent"
                } else {
                    " attend"
                }
            ));
        }
    }

    if remote.enabled && remote.failed {
        problems.push(format!(
            "Contrôle à distance : {}.",
            remote.error.as_deref().unwrap_or("erreur")
        ));
    }

    let crash = entries
        .iter()
        .rev()
        .find(|e| e.scope == LogScope::App && e.level == LogLevel::Error);
    if let Some(crash) = crash
        && now - crash.t < 3 * DAY_MS
    {
        problems.push(format!(
            "Un plantage a été enregistré {}.",
            ago(Some(crash.t), *now)
        ));
    }
    problems
}

/// The report as it is copied to send to someone: the servers' addresses and the account names are hidden.
pub fn shareable_report(
    snapshot: &Snapshot,
    services: &[ServiceIdentity],
    tz: &TimeZone,
    log_lines: Option<usize>,
) -> String {
    mask_addresses(&redact(
        &build_report(snapshot, tz, log_lines),
        &secrets_for(services),
    ))
}

// Ported from mobile/tests/diagnostics.test.js (the report and what it hides, the problem list, words and times).
// The record's own tests (cut to 300 lines, saving, merging runs, the error handler) and the phone's backup
// environment test belong to `diagnostics.ts` and `cameraBackup.ts`, which keep the device's storage and APIs.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::wrapped::tests::{at, paris};

    fn secret(value: &str, label: &str) -> Secret {
        Secret {
            value: value.to_owned(),
            label: label.to_owned(),
        }
    }

    fn secrets() -> Vec<Secret> {
        vec![
            secret("https://music.example.org", "[adresse]"),
            secret("music.example.org", "[hôte]"),
            secret("maxime", "[compte]"),
        ]
    }

    #[test]
    fn redact_replaces_names_whatever_their_case_and_leaves_the_rest_alone() {
        let text = "Maxime sur MUSIC.EXAMPLE.ORG (https://music.example.org/rest) : maxime@music.example.org";
        assert_eq!(
            redact(text, &secrets()),
            "[compte] sur [hôte] ([adresse]/rest) : [compte]@[hôte]"
        );
        assert_eq!(redact("rien à cacher", &secrets()), "rien à cacher");
        assert_eq!(redact("texte", &[]), "texte");
    }

    #[test]
    fn a_short_name_is_only_replaced_as_a_whole_word() {
        let al = [secret("al", "[compte]")];
        assert_eq!(
            redact("al a envoyé 12 fichiers, normal, Al.", &al),
            "[compte] a envoyé 12 fichiers, normal, [compte]."
        );
        assert_eq!(
            redact("un seul caractère : x", &[secret("x", "[x]")]),
            "un seul caractère : x",
            "one letter is never a secret"
        );
    }

    #[test]
    fn a_label_that_was_put_in_is_not_read_again_as_part_of_another_secret() {
        let secrets = [
            secret("navidrome", "[compte Navidrome]"),
            secret("https://nas.local:4533", "[adresse Navidrome]"),
        ];
        assert_eq!(
            redact("Navidrome sur https://nas.local:4533", &secrets),
            "[compte Navidrome] sur [adresse Navidrome]"
        );
    }

    #[test]
    fn special_characters_in_a_name_are_taken_literally() {
        let secrets = [secret("a.b+c(d)", "[nom]")];
        assert_eq!(
            redact("x a.b+c(d) y aXb+c(d)", &secrets),
            "x [nom] y aXb+c(d)"
        );
    }

    #[test]
    fn addresses_left_in_the_text_are_masked() {
        assert_eq!(
            mask_addresses("PC 192.168.1.20:8765 et 10.0.0.5, version 2.3.1, build 12"),
            "PC [adresse IP] et [adresse IP], version 2.3.1, build 12"
        );
    }

    #[test]
    fn only_whole_addresses_are_masked() {
        // Not an address: glued to a word, a number of four digits, only three numbers.
        for text in ["v1.2.3.4", "1.2.3.4567", "x1.2.3.4a", "1.2.3"] {
            assert_eq!(mask_addresses(text), text, "{text}");
        }
        // A fifth number is left as it is, like the regex does (the address ends at a dot).
        assert_eq!(mask_addresses("1.2.3.4.5"), "[adresse IP].5");
        // A port that is too long or not a port stays out of the match.
        assert_eq!(mask_addresses("1.2.3.4:123456"), "[adresse IP]:123456");
        assert_eq!(mask_addresses("http://1.2.3.4/x"), "http://[adresse IP]/x");
        assert_eq!(mask_addresses("(10.0.0.5)"), "([adresse IP])");
    }

    #[test]
    fn host_and_port_are_taken_from_an_address() {
        assert_eq!(host_of("https://nas.local:4533/music/"), "nas.local:4533");
        assert_eq!(host_name("https://nas.local:4533/music/"), "nas.local");
        assert_eq!(host_of("http://192.168.1.5"), "192.168.1.5");
        assert_eq!(host_name("nas.local"), "nas.local");
        assert_eq!(host_name("http://[fe80::1]:8080/x"), "[fe80::1]");
        // No scheme, and a path, a query or a fragment right after the host.
        assert_eq!(host_of("  nas.local:4533?x=1 "), "nas.local:4533");
        assert_eq!(host_of("nas.local#top"), "nas.local");
        assert_eq!(host_of("HTTPS://Nas.Local/x"), "Nas.Local");
    }

    /// 2 October 2026, 12:00 in Paris.
    fn now() -> i64 {
        at(2026, 10, 2, 12, 0, 0)
    }

    fn minutes_ago(minutes: i64) -> i64 {
        now() - minutes * 60_000
    }

    fn entry(t: i64, scope: LogScope, level: LogLevel, message: &str) -> LogEntry {
        LogEntry {
            t,
            scope,
            level,
            message: message.to_owned(),
        }
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            now: now(),
            app: AppLine {
                version: "2.4.0".to_owned(),
                build: "24".to_owned(),
                device: "Samsung SM-S918B Android 15".to_owned(),
                lock: true,
            },
            servers: vec![
                ServerLine {
                    name: "Navidrome".to_owned(),
                    state: ServerState::Ok,
                    status: "connecté".to_owned(),
                    account: Some("maxime".to_owned()),
                    host: Some("music.example.org:4533".to_owned()),
                    latency: Latency::Ms(85),
                    detail: None,
                },
                ServerLine {
                    name: "FileBrowser".to_owned(),
                    state: ServerState::Ok,
                    status: "connecté".to_owned(),
                    account: Some("maxime".to_owned()),
                    host: Some("files.example.org".to_owned()),
                    ..ServerLine::default()
                },
                ServerLine {
                    name: "Downtify".to_owned(),
                    state: ServerState::Off,
                    status: "non configuré".to_owned(),
                    ..ServerLine::default()
                },
            ],
            backup: BackupLine {
                enabled: true,
                phase: "idle".to_owned(),
                destination: Some("/backups/photos/maxime/AAAA/MM".to_owned()),
                pending: Some(0),
                uploaded: 1200,
                gave_up: 0,
                last_success_at: Some(minutes_ago(30)),
                last_check_at: Some(minutes_ago(5)),
                error: None,
                cursor: Some(minutes_ago(60)),
                remembered_sent: Some(14),
                failing: Some(0),
                permission: "accordé".to_owned(),
                network: "Wi-Fi".to_owned(),
                charging: Some(true),
                wifi_only: true,
            },
            remote: RemoteLine {
                enabled: true,
                status: "connecté au PC".to_owned(),
                failed: false,
                paired: true,
                error: None,
            },
            entries: vec![
                entry(
                    minutes_ago(20),
                    LogScope::Backup,
                    LogLevel::Info,
                    "Envoi de 3 fichiers",
                ),
                entry(
                    minutes_ago(10),
                    LogScope::Connection,
                    LogLevel::Warn,
                    "Navidrome : timeout sur music.example.org",
                ),
                entry(
                    minutes_ago(1),
                    LogScope::App,
                    LogLevel::Info,
                    "Connecté au PC (192.168.1.20)",
                ),
            ],
        }
    }

    fn report(snapshot: &Snapshot) -> String {
        build_report(snapshot, &paris(), None)
    }

    #[test]
    fn the_report_lists_every_section_and_the_log_with_the_newest_line_last() {
        let report = report(&snapshot());
        for heading in [
            "SelfHost Hub — rapport de diagnostic",
            "Application",
            "Serveurs",
            "Sauvegarde des photos",
            "Contrôle à distance",
            "Journal",
        ] {
            assert!(report.contains(heading), "{heading}");
        }
        assert!(report.contains("Généré le 02/10/2026 12:00:00"));
        assert!(report.contains("Version : 2.4.0 (build 24)"));
        assert!(
            report.contains(
                "Navidrome : connecté — compte « maxime » — music.example.org:4533 — 85 ms"
            )
        );
        assert!(report.contains("Downtify : non configuré"));
        assert!(report.contains("Destination : /backups/photos/maxime/AAAA/MM"));
        assert!(report.contains("en charge : oui"));
        let lines: Vec<&str> = report.split('\n').collect();
        let position = |needle: &str| lines.iter().position(|l| l.contains(needle));
        let first = position("Envoi de 3 fichiers").expect("the oldest line is there");
        let last = position("Connecté au PC").expect("the newest line is there");
        assert!(first > 0 && last > first, "oldest first, newest last");
        let warning = position("Navidrome : timeout").expect("the warning is there");
        assert!(lines[warning].starts_with("!  "), "a warning is marked");
    }

    #[test]
    fn the_report_keeps_only_the_last_log_lines_asked_for() {
        let many: Vec<LogEntry> = (0..200)
            .map(|i| {
                entry(
                    minutes_ago(200 - i),
                    LogScope::App,
                    LogLevel::Info,
                    &format!("event {i}"),
                )
            })
            .collect();
        let with_log = Snapshot {
            entries: many,
            ..snapshot()
        };
        let report = build_report(&with_log, &paris(), Some(10));
        assert!(report.contains("les 10 derniers événements"));
        assert!(report.contains("event 199") && !report.contains("event 189"));
        let empty = Snapshot {
            entries: Vec::new(),
            ..snapshot()
        };
        assert!(self::report(&empty).contains("(vide)"));
        // Without a number, the last 80 are kept.
        assert!(build_report(&with_log, &paris(), None).contains("les 80 derniers événements"));
    }

    #[test]
    fn the_copied_report_hides_the_servers_the_accounts_and_any_address() {
        let services = [
            ServiceIdentity {
                label: "Navidrome".to_owned(),
                url: Some("https://music.example.org:4533/".to_owned()),
                accounts: vec!["maxime".to_owned()],
            },
            ServiceIdentity {
                label: "FileBrowser".to_owned(),
                url: Some("https://files.example.org".to_owned()),
                // An account that is not set (null in the app) is simply not given.
                accounts: vec!["Maxime".to_owned(), String::new()],
            },
            ServiceIdentity {
                label: "Downtify".to_owned(),
                url: None,
                accounts: Vec::new(),
            },
        ];
        let text = shareable_report(&snapshot(), &services, &paris(), None);
        let lowered = text.to_lowercase();
        for leaked in [
            "music.example.org",
            "files.example.org",
            "maxime",
            "192.168.1.20",
        ] {
            assert!(!lowered.contains(leaked), "still shows {leaked}");
        }
        assert!(
            text.contains("[hôte Navidrome]")
                && text.contains("[compte Navidrome]")
                && text.contains("[adresse IP]")
        );
        assert!(
            text.contains("Version : 2.4.0") && text.contains("Envoi de 3 fichiers"),
            "the rest stays readable"
        );
    }

    #[test]
    fn a_backup_that_has_not_looked_at_anything_yet_is_not_reported_as_up_to_date_to_1970() {
        let mut fresh = snapshot();
        fresh.backup.cursor = Some(0);
        let report = report(&fresh);
        assert!(!report.contains("1970") && report.contains("rien n’a encore été passé en revue"));
        // Before anything was read at all, the line is left out.
        fresh.backup.cursor = None;
        assert!(!self::report(&fresh).contains("Journal : "));
    }

    // ---- the problem list ----

    fn with_backup(change: impl FnOnce(&mut BackupLine)) -> Snapshot {
        let mut s = snapshot();
        change(&mut s.backup);
        s
    }

    fn with_server(index: usize, change: impl FnOnce(&mut ServerLine)) -> Snapshot {
        let mut s = snapshot();
        change(&mut s.servers[index]);
        s
    }

    #[test]
    fn nothing_is_flagged_when_everything_works() {
        assert_eq!(find_problems(&snapshot()), Vec::<String>::new());
        let off = with_backup(|b| {
            b.enabled = false;
            b.phase = "error".to_owned();
            b.gave_up = 9;
            b.permission = "refusé".to_owned();
        });
        assert_eq!(
            find_problems(&off),
            Vec::<String>::new(),
            "a backup that is off is not a problem"
        );
    }

    #[test]
    fn a_server_that_is_down_or_that_fails_its_test_is_flagged_one_never_set_up_is_not() {
        let down = with_server(0, |s| {
            s.state = ServerState::Down;
            s.status = "déconnecté".to_owned();
        });
        assert_eq!(find_problems(&down), ["Navidrome : déconnecté."]);
        let refused = with_server(0, |s| {
            s.state = ServerState::Down;
            s.status = "erreur".to_owned();
            s.detail = Some("Identifiants invalides".to_owned());
        });
        assert_eq!(
            find_problems(&refused),
            ["Navidrome : Identifiants invalides."]
        );
        let silent = with_server(1, |s| {
            s.latency = Latency::Failed;
            s.detail = Some("le serveur ne répond pas".to_owned());
        });
        assert!(find_problems(&silent)[0].starts_with("FileBrowser ne répond pas au test"));
        let expired = with_server(1, |s| {
            s.latency = Latency::Ms(40);
            s.detail = Some("la session n'est plus valide".to_owned());
        });
        assert_eq!(
            find_problems(&expired),
            ["FileBrowser : la session n'est plus valide."]
        );
        let never = with_server(2, |s| s.state = ServerState::Off);
        assert_eq!(find_problems(&never), Vec::<String>::new());
    }

    #[test]
    fn the_backup_problems_are_named() {
        let named = |snapshot: Snapshot, needle: &str| {
            let problems = find_problems(&snapshot);
            assert!(
                problems.iter().any(|p| p.contains(needle)),
                "{needle} not in {problems:?}"
            );
        };
        named(
            with_backup(|b| {
                b.phase = "no-permission".to_owned();
                b.permission = "refusé".to_owned();
            }),
            "n'a pas accès aux photos",
        );
        named(
            with_backup(|b| b.permission = "limité".to_owned()),
            "limité",
        );
        named(
            with_backup(|b| {
                b.phase = "no-server".to_owned();
                b.error = Some("timeout".to_owned());
            }),
            "ne joint pas FileBrowser (timeout)",
        );
        named(
            with_backup(|b| {
                b.phase = "error".to_owned();
                b.error = Some("disque plein".to_owned());
            }),
            "interrompue : disque plein",
        );
        let starts = |gave_up: u32, text: &str| {
            let problems = find_problems(&with_backup(|b| b.gave_up = gave_up));
            assert!(
                problems.iter().any(|p| p.starts_with(text)),
                "{text} not in {problems:?}"
            );
        };
        starts(2, "2 fichiers que le serveur refuse");
        starts(1, "1 fichier que le serveur refuse");
    }

    #[test]
    fn files_waiting_for_days_with_nothing_sent_are_flagged_a_busy_or_fresh_backup_is_not() {
        let day = 24 * 3_600_000;
        let stalled = with_backup(|b| {
            b.pending = Some(40);
            b.last_success_at = Some(now() - 4 * day);
        });
        assert!(
            find_problems(&stalled)
                .iter()
                .any(|p| p.contains("40 fichiers attendent depuis plus de 3 jours"))
        );
        let one = with_backup(|b| {
            b.pending = Some(1);
            b.last_success_at = Some(now() - 4 * day);
        });
        assert!(
            find_problems(&one)
                .iter()
                .any(|p| p.contains("1 fichier attend depuis plus de 3 jours"))
        );
        let fresh = with_backup(|b| {
            b.pending = Some(40);
            b.last_success_at = Some(now() - 3_600_000);
        });
        assert_eq!(find_problems(&fresh), Vec::<String>::new());
        let busy = with_backup(|b| {
            b.pending = Some(40);
            b.phase = "running".to_owned();
            b.last_success_at = Some(now() - 4 * day);
        });
        assert_eq!(find_problems(&busy), Vec::<String>::new());
    }

    #[test]
    fn a_remote_control_that_failed_is_flagged_one_that_is_just_not_connected_or_turned_off_is_not()
    {
        let remote = |change: &dyn Fn(&mut RemoteLine)| {
            let mut s = snapshot();
            change(&mut s.remote);
            find_problems(&s)
        };
        assert_eq!(
            remote(&|r| {
                r.status = "erreur".to_owned();
                r.failed = true;
                r.error = Some("code refusé".to_owned());
            }),
            ["Contrôle à distance : code refusé."]
        );
        assert!(remote(&|r| r.status = "non connecté".to_owned()).is_empty());
        assert!(
            remote(&|r| {
                r.enabled = false;
                r.status = "désactivé".to_owned();
                r.failed = true;
            })
            .is_empty()
        );
    }

    #[test]
    fn a_recent_crash_is_flagged_an_old_one_is_not() {
        let with_entries = |entries: Vec<LogEntry>| Snapshot {
            entries,
            ..snapshot()
        };
        let crash = |t: i64, scope: LogScope, message: &str| {
            with_entries(vec![entry(t, scope, LogLevel::Error, message)])
        };
        let recent = crash(minutes_ago(90), LogScope::App, "Erreur fatale : x");
        assert!(
            find_problems(&recent)
                .iter()
                .any(|p| p.starts_with("Un plantage a été enregistré il y a"))
        );
        let old = crash(
            now() - 5 * 24 * 3_600_000,
            LogScope::App,
            "Erreur fatale : x",
        );
        assert!(find_problems(&old).is_empty());
        let other = crash(minutes_ago(5), LogScope::Backup, "Erreur inattendue");
        assert!(
            find_problems(&other).is_empty(),
            "only crashes of the app itself"
        );
    }

    // ---- words and times ----

    #[test]
    fn times_delays_and_phases_are_worded_for_the_screen() {
        let tz = paris();
        let now = now();
        assert_eq!(format_stamp(now - 1000, now, &tz), "11:59:59");
        assert_eq!(format_stamp(now - 86_400_000, now, &tz), "01/10 12:00");
        assert_eq!(ago(None, now), "jamais");
        assert_eq!(ago(Some(now - 20_000), now), "à l'instant");
        assert_eq!(ago(Some(now - 5 * 60_000), now), "il y a 5 min");
        assert_eq!(ago(Some(now - 3 * 3_600_000), now), "il y a 3 h");
        assert_eq!(ago(Some(now - 2 * 86_400_000), now), "il y a 2 j");
        assert_eq!(describe_phase("waiting-wifi"), "attend le Wi-Fi");
        assert_eq!(describe_phase("something-new"), "something-new");
        assert_eq!(
            format_date_time(at(2026, 1, 5, 9, 3, 7), &tz),
            "05/01/2026 09:03:07"
        );
    }

    #[test]
    fn a_time_in_the_future_counts_as_now() {
        assert_eq!(ago(Some(now() + 3_600_000), now()), "à l'instant");
        // Rounded half up: 90 s is 2 min, 29 s is now.
        assert_eq!(ago(Some(now() - 90_000), now()), "il y a 2 min");
        assert_eq!(ago(Some(now() - 29_000), now()), "à l'instant");
    }
}
