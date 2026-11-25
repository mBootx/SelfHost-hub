//! The weekly recap ("Wrapped"): what was listened to on this device, week by week (Monday to Sunday, local time),
//! and the summary shown every Monday from 10:00 for the week just ended.
//!
//! Port of `mobile/src/services/wrapped.ts` and the popup rules of `mobile/src/store/wrappedStore.ts`. Weeks are
//! counted in the device's time zone, passed in, so a change of clock never splits or merges a week.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use jiff::Timestamp;
use jiff::ToSpan;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde_json::{Map, Value, json};

use crate::song::SongInfo;
use crate::text::fold;

/// One song's listening in one week.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SongStat {
    pub song: SongInfo,
    /// Seconds actually heard: pauses and seeks are left out.
    pub seconds: f64,
    /// Times it was heard long enough to count (the scrobble rule).
    pub plays: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WeekLog {
    /// The week's Monday, yyyy-mm-dd, local time.
    pub week: String,
    /// Seconds heard on each day of the week, Monday first.
    pub days: [f64; 7],
    /// In the order first heard.
    pub songs: Vec<SongStat>,
}

impl WeekLog {
    fn new(week: &str) -> Self {
        Self {
            week: week.to_owned(),
            days: [0.0; 7],
            songs: Vec::new(),
        }
    }

    pub fn song(&self, id: &str) -> Option<&SongStat> {
        self.songs.iter().find(|s| s.song.id == id)
    }

    pub fn total_seconds(&self) -> f64 {
        self.days.iter().sum()
    }
}

/// Every week kept, by its Monday (yyyy-mm-dd).
pub type Ledger = BTreeMap<String, WeekLog>;

#[derive(Debug, Clone, PartialEq)]
pub struct ArtistStat {
    pub name: String,
    pub artist_id: Option<String>,
    pub seconds: f64,
    pub plays: u32,
    /// The cover of the artist's most heard song of the week, for the picture.
    pub cover_art: Option<String>,
    pub album_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WeeklyWrapped {
    pub week: String,
    /// Monday 00:00 and the next Monday 00:00, local time, in ms since the epoch.
    pub start_ms: i64,
    pub end_ms: i64,
    pub minutes: i64,
    /// The week before's minutes, when it was recorded.
    pub previous_minutes: Option<i64>,
    /// Minutes on each day, Monday first.
    pub days: [i64; 7],
    /// The day with the most listening (0 = Monday), `None` for an empty week.
    pub busiest_day: Option<usize>,
    pub top_songs: Vec<SongStat>,
    pub top_artists: Vec<ArtistStat>,
    pub song_count: usize,
    pub artist_count: usize,
    pub plays: u32,
}

/// The recap of the week before pops up from this hour on Mondays.
pub const WRAPPED_HOUR: i8 = 10;
/// Weeks kept: enough to look back a season.
pub const KEEP_WEEKS: i64 = 26;
/// Below this much listening a week has nothing worth popping up for.
pub const MIN_WRAPPED_SECONDS: f64 = 5.0 * 60.0;
const TOP: usize = 5;
/// An artist heard for less than this in a week (a skipped song) is not one of its top artists.
const MIN_ARTIST_SECONDS: f64 = 30.0;

pub const DAY_NAMES: [&str; 7] = [
    "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
];
pub const DAY_LETTERS: [&str; 7] = ["L", "M", "M", "J", "V", "S", "D"];
const MONTHS: [&str; 12] = [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
];

// --- Weeks ---

fn date_of(time_ms: i64, tz: &TimeZone) -> Date {
    Timestamp::from_millisecond(time_ms)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned_datetime(tz.clone())
        .date()
}

fn key_of(date: Date) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

fn parse_key(key: &str) -> Option<Date> {
    let mut parts = key.split('-');
    let (y, m, d) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    Date::new(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?).ok()
}

/// The Monday of the week `time_ms` falls in, local time.
pub fn monday_of(time_ms: i64, tz: &TimeZone) -> Date {
    let date = date_of(time_ms, tz);
    let back = i64::from(date.weekday().to_monday_zero_offset());
    date.checked_sub(back.days()).unwrap_or(date)
}

/// The key of the week `time_ms` falls in.
pub fn week_key(time_ms: i64, tz: &TimeZone) -> String {
    key_of(monday_of(time_ms, tz))
}

/// Midnight of a week's Monday, local time, in ms since the epoch.
pub fn week_start_ms(key: &str, tz: &TimeZone) -> Option<i64> {
    let zoned = parse_key(key)?.to_zoned_datetime(tz.clone()).ok()?;
    Some(zoned.timestamp().as_millisecond())
}

/// The key of the week `weeks` after (or before, if negative). Days are counted, so a change of clock does not matter.
pub fn shift_week(key: &str, weeks: i64) -> String {
    parse_key(key)
        .and_then(|d| d.checked_add((weeks * 7).days()).ok())
        .map_or_else(|| key.to_owned(), key_of)
}

/// 0 for Monday to 6 for Sunday.
pub fn day_index(time_ms: i64, tz: &TimeZone) -> usize {
    date_of(time_ms, tz).weekday().to_monday_zero_offset() as usize
}

/// "6 – 12 octobre", "29 septembre – 5 octobre", "29 décembre 2025 – 4 janvier 2026".
pub fn week_label(key: &str) -> String {
    let Some(start) = parse_key(key) else {
        return key.to_owned();
    };
    let end = start.checked_add(6.days()).unwrap_or(start);
    let month = |d: Date| MONTHS[(d.month() - 1) as usize];
    let same_month = start.month() == end.month() && start.year() == end.year();
    let same_year = start.year() == end.year();
    let first = if same_month {
        start.day().to_string()
    } else if same_year {
        format!("{} {}", start.day(), month(start))
    } else {
        format!("{} {} {}", start.day(), month(start), start.year())
    };
    let last = if same_year {
        format!("{} {}", end.day(), month(end))
    } else {
        format!("{} {} {}", end.day(), month(end), end.year())
    };
    format!("{first} – {last}")
}

/// "12 h 22 min", "45 min", "2 h", "moins d'une minute".
pub fn duration_label(minutes: i64) -> String {
    if minutes < 1 {
        return "moins d'une minute".into();
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    match (hours, rest) {
        (0, _) => format!("{rest} min"),
        (_, 0) => format!("{hours} h"),
        _ => format!("{hours} h {rest:02} min"),
    }
}

// --- Recording ---

fn week_for<'a>(ledger: &'a mut Ledger, time_ms: i64, tz: &TimeZone) -> &'a mut WeekLog {
    let key = week_key(time_ms, tz);
    ledger
        .entry(key.clone())
        .or_insert_with(|| WeekLog::new(&key))
}

fn stat_for<'a>(week: &'a mut WeekLog, song: &SongInfo) -> &'a mut SongStat {
    let position = match week.songs.iter().position(|s| s.song.id == song.id) {
        Some(i) => {
            // The song's details as last seen (a tag fixed on the server since).
            week.songs[i].song = song.clone();
            i
        }
        None => {
            week.songs.push(SongStat {
                song: song.clone(),
                seconds: 0.0,
                plays: 0,
            });
            week.songs.len() - 1
        }
    };
    &mut week.songs[position]
}

/// `seconds` of `song` heard just now (at `time_ms`): counted in that day of that week.
pub fn add_listening(
    ledger: &mut Ledger,
    song: &SongInfo,
    seconds: f64,
    time_ms: i64,
    tz: &TimeZone,
) {
    if seconds.is_nan() || seconds <= 0.0 {
        return;
    }
    let day = day_index(time_ms, tz);
    let week = week_for(ledger, time_ms, tz);
    week.days[day] += seconds;
    stat_for(week, song).seconds += seconds;
}

/// `song` was heard long enough to count as a play (at `time_ms`).
pub fn add_play(ledger: &mut Ledger, song: &SongInfo, time_ms: i64, tz: &TimeZone) {
    stat_for(week_for(ledger, time_ms, tz), song).plays += 1;
}

/// Forgets the weeks older than the `keep` most recent ones (counting the week of `now_ms`); returns them.
pub fn prune(ledger: &mut Ledger, now_ms: i64, tz: &TimeZone, keep: i64) -> Vec<String> {
    let oldest = shift_week(&week_key(now_ms, tz), -(keep - 1));
    let removed: Vec<String> = ledger
        .keys()
        .filter(|k| k.as_str() < oldest.as_str())
        .cloned()
        .collect();
    for key in &removed {
        ledger.remove(key);
    }
    removed
}

/// Adds what `extra` holds to `into` (the weeks read back from storage, and what was heard before they were).
pub fn merge_ledgers(mut into: Ledger, extra: Ledger) -> Ledger {
    for (key, week) in extra {
        let Some(target) = into.get_mut(&key) else {
            into.insert(key, week);
            continue;
        };
        for (day, seconds) in week.days.iter().enumerate() {
            target.days[day] += seconds;
        }
        for stat in week.songs {
            match target.songs.iter_mut().find(|s| s.song.id == stat.song.id) {
                Some(known) => {
                    known.seconds += stat.seconds;
                    known.plays += stat.plays;
                }
                None => target.songs.push(stat),
            }
        }
    }
    into
}

// --- Storage: the same JSON the TypeScript app saved, one entry per week ---

/// A week as saved (`listening.week.<yyyy-mm-dd>`).
pub fn week_to_json(week: &WeekLog) -> Value {
    let mut songs = Map::new();
    for stat in &week.songs {
        let s = &stat.song;
        let mut obj = Map::new();
        obj.insert("id".into(), s.id.clone().into());
        obj.insert("title".into(), s.title.clone().into());
        obj.insert("artist".into(), s.artist.clone().into());
        for (key, value) in [
            ("artistId", &s.artist_id),
            ("album", &s.album),
            ("albumId", &s.album_id),
            ("coverArt", &s.cover_art),
        ] {
            if let Some(v) = value {
                obj.insert(key.into(), v.clone().into());
            }
        }
        obj.insert("duration".into(), json!(s.duration));
        obj.insert("seconds".into(), json!(stat.seconds));
        obj.insert("plays".into(), json!(stat.plays));
        songs.insert(s.id.clone(), Value::Object(obj));
    }
    json!({ "week": week.week, "days": week.days, "songs": songs })
}

/// A week read back from storage, with anything malformed left out; `None` when the week itself is unusable.
pub fn week_from_json(key: &str, value: &Value) -> Option<WeekLog> {
    parse_key(key)?;
    let days = value.get("days")?.as_array()?;
    if days.len() != 7 {
        return None;
    }
    let mut week = WeekLog::new(key);
    for (i, d) in days.iter().enumerate() {
        week.days[i] = d.as_f64().filter(|v| v.is_finite()).unwrap_or(0.0);
    }
    for (id, song) in value.get("songs")?.as_object()? {
        let text = |k: &str| song.get(k).and_then(Value::as_str).map(str::to_owned);
        let (Some(title), Some(seconds), Some(plays)) = (
            text("title"),
            song.get("seconds")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite()),
            song.get("plays")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite()),
        ) else {
            continue;
        };
        week.songs.push(SongStat {
            song: SongInfo {
                id: id.clone(),
                title,
                artist: text("artist").unwrap_or_default(),
                artist_id: text("artistId"),
                album: text("album"),
                album_id: text("albumId"),
                cover_art: text("coverArt"),
                duration: song.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
            },
            seconds,
            plays: plays.max(0.0) as u32,
        });
    }
    Some(week)
}

// --- The summary ---

pub fn total_seconds(week: Option<&WeekLog>) -> f64 {
    week.map_or(0.0, WeekLog::total_seconds)
}

/// French reading order: case and accents first set aside, then used to break ties.
fn by_name(a: &str, b: &str) -> Ordering {
    fold(a).cmp(&fold(b)).then_with(|| a.cmp(b))
}

/// JavaScript's `Math.round`: halves go up.
fn round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn artist_key(song: &SongInfo) -> String {
    song.artist_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| song.artist.trim().to_lowercase())
}

/// The recap of `week`, or `None` when nothing was recorded that week.
pub fn summarize(ledger: &Ledger, week: &str, tz: &TimeZone) -> Option<WeeklyWrapped> {
    let log = ledger.get(week)?;
    let previous = ledger.get(&shift_week(week, -1));

    // Songs: the most played first, then the most heard. A song only skipped through was not one of the week's.
    let mut top_songs: Vec<SongStat> = log.songs.iter().filter(|s| s.plays > 0).cloned().collect();
    top_songs.sort_by(|a, b| {
        b.plays
            .cmp(&a.plays)
            .then(b.seconds.total_cmp(&a.seconds))
            .then_with(|| by_name(&a.song.title, &b.song.title))
    });
    top_songs.truncate(TOP);

    // Artists: by time heard, which says more than a count of songs of very different lengths.
    let mut artists: Vec<(String, ArtistStat, f64)> = Vec::new();
    for stat in &log.songs {
        let key = artist_key(&stat.song);
        match artists.iter_mut().find(|(k, _, _)| *k == key) {
            None => artists.push((
                key,
                ArtistStat {
                    name: stat.song.artist.clone(),
                    artist_id: stat.song.artist_id.clone(),
                    seconds: stat.seconds,
                    plays: stat.plays,
                    cover_art: stat.song.cover_art.clone(),
                    album_id: stat.song.album_id.clone(),
                },
                stat.seconds,
            )),
            Some((_, artist, best)) => {
                artist.seconds += stat.seconds;
                artist.plays += stat.plays;
                if stat.seconds > *best {
                    *best = stat.seconds;
                    artist.cover_art = stat.song.cover_art.clone();
                    artist.album_id = stat.song.album_id.clone();
                }
            }
        }
    }
    let artist_count = artists
        .iter()
        .filter(|(_, a, _)| a.seconds >= MIN_ARTIST_SECONDS)
        .count();
    let mut top_artists: Vec<ArtistStat> = artists
        .into_iter()
        .map(|(_, a, _)| a)
        .filter(|a| a.seconds >= MIN_ARTIST_SECONDS)
        .collect();
    top_artists.sort_by(|a, b| {
        b.seconds
            .total_cmp(&a.seconds)
            .then(b.plays.cmp(&a.plays))
            .then_with(|| by_name(&a.name, &b.name))
    });
    top_artists.truncate(TOP);

    let most = log.days.iter().copied().fold(0.0, f64::max);
    Some(WeeklyWrapped {
        week: week.to_owned(),
        start_ms: week_start_ms(week, tz)?,
        end_ms: week_start_ms(&shift_week(week, 1), tz)?,
        minutes: round(log.total_seconds() / 60.0),
        previous_minutes: previous.map(|p| round(p.total_seconds() / 60.0)),
        days: log.days.map(|s| round(s / 60.0)),
        busiest_day: (most > 0.0)
            .then(|| log.days.iter().position(|d| *d == most))
            .flatten(),
        top_songs,
        top_artists,
        song_count: log
            .songs
            .iter()
            .filter(|s| s.seconds >= MIN_ARTIST_SECONDS || s.plays > 0)
            .count(),
        artist_count,
        plays: log.songs.iter().map(|s| s.plays).sum(),
    })
}

/// "+18 % par rapport à la semaine d'avant", "−40 % …", or `None` when there is nothing to compare with.
pub fn change_label(minutes: i64, previous_minutes: Option<i64>) -> Option<String> {
    let previous = previous_minutes.filter(|p| *p > 0)?;
    let change = round((minutes - previous) as f64 / previous as f64 * 100.0);
    Some(if change == 0 {
        "autant que la semaine d'avant".into()
    } else {
        format!(
            "{}{} % par rapport à la semaine d'avant",
            if change > 0 { '+' } else { '−' },
            change.abs()
        )
    })
}

// --- When it pops up ---

/// The week whose recap should pop up at `now_ms`: from Monday 10:00, the week that just ended, until it has been
/// shown (on Tuesday too, then, if the app was not opened on Monday). `None` when it was already shown, or when
/// that week had too little listening to be worth it.
pub fn due_week(
    ledger: &Ledger,
    now_ms: i64,
    last_shown: Option<&str>,
    tz: &TimeZone,
) -> Option<String> {
    let monday = monday_of(now_ms, tz);
    let release = monday
        .at(WRAPPED_HOUR, 0, 0, 0)
        .to_zoned_datetime(tz.clone())
        .ok()?
        .timestamp()
        .as_millisecond();
    if now_ms < release {
        return None;
    }
    let ended = shift_week(&key_of(monday), -1);
    if last_shown.is_some_and(|shown| shown >= ended.as_str()) {
        return None;
    }
    if total_seconds(ledger.get(&ended)) < MIN_WRAPPED_SECONDS {
        return None;
    }
    Some(ended)
}

/// The week to open from Settings: the last one that ended, if it was listened to, else the one under way.
pub fn latest_week(ledger: &Ledger, now_ms: i64, tz: &TimeZone) -> String {
    let current = week_key(now_ms, tz);
    let ended = shift_week(&current, -1);
    if total_seconds(ledger.get(&ended)) > 0.0 {
        ended
    } else {
        current
    }
}

/// The weeks one can go back and forth between: the oldest recorded up to the current one.
pub fn week_range(ledger: &Ledger, now_ms: i64, tz: &TimeZone) -> (String, String) {
    let last = week_key(now_ms, tz);
    let first = ledger
        .keys()
        .find(|k| k.as_str() < last.as_str())
        .cloned()
        .unwrap_or_else(|| last.clone());
    (first, last)
}

/// Whether the recap is on screen and which week, and which one was last shown by itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WrappedPopup {
    /// The week on screen, or `None` when closed.
    pub week: Option<String>,
    /// The week whose recap was last shown by itself (or seen while it was due). The app saves it.
    pub last_shown: Option<String>,
    /// The week that was due when it opened: it counts as seen once closed.
    due_on_open: Option<String>,
}

impl WrappedPopup {
    pub fn new(last_shown: Option<String>) -> Self {
        Self {
            last_shown,
            ..Default::default()
        }
    }

    /// Opens it by itself when it is due. Call once the listening is loaded and saved, on return to the app and
    /// every minute while it is open.
    pub fn check(&mut self, ledger: &Ledger, now_ms: i64, tz: &TimeZone) {
        if self.week.is_some() {
            return;
        }
        if let Some(due) = due_week(ledger, now_ms, self.last_shown.as_deref(), tz) {
            self.week = Some(due.clone());
            self.due_on_open = Some(due);
        }
    }

    /// Opens it from Settings, on the last week that ended (or the one under way if that one is empty).
    pub fn open(&mut self, ledger: &Ledger, now_ms: i64, tz: &TimeZone) {
        self.week = Some(latest_week(ledger, now_ms, tz));
        self.due_on_open = due_week(ledger, now_ms, self.last_shown.as_deref(), tz);
    }

    /// Goes to another week.
    pub fn show(&mut self, week: &str) {
        self.week = Some(week.to_owned());
    }

    /// Closes it; returns the new `last_shown` when it changed, for the app to save.
    pub fn close(&mut self) -> Option<String> {
        self.week = None;
        let due = self.due_on_open.take()?;
        if self.last_shown.as_ref().is_none_or(|shown| due > *shown) {
            self.last_shown = Some(due.clone());
            return Some(due);
        }
        None
    }
}

// Ported from mobile/tests/wrapped.test.js (weeks, summary, popup); the recording tests are in listening.rs.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn paris() -> TimeZone {
        TimeZone::get("Europe/Paris").expect("the time zone database has Europe/Paris")
    }

    /// A local time in Paris, in ms.
    pub(crate) fn at(y: i16, mo: i8, d: i8, h: i8, mi: i8, s: i8) -> i64 {
        jiff::civil::date(y, mo, d)
            .at(h, mi, s, 0)
            .to_zoned_datetime(paris())
            .unwrap()
            .timestamp()
            .as_millisecond()
    }

    pub(crate) fn song(id: &str) -> SongInfo {
        SongInfo {
            id: id.into(),
            title: format!("Titre {id}"),
            artist: format!("Artiste {id}"),
            artist_id: Some(format!("ar-{id}")),
            album: Some(format!("Album {id}")),
            album_id: Some(format!("al-{id}")),
            cover_art: Some(format!("al-{id}")),
            duration: 200.0,
        }
    }

    struct Stat {
        id: &'static str,
        plays: u32,
        seconds: f64,
        day: usize,
        artist: Option<(&'static str, Option<&'static str>)>,
        cover: Option<&'static str>,
    }

    fn stat(id: &'static str, plays: u32, seconds: f64) -> Stat {
        Stat {
            id,
            plays,
            seconds,
            day: 0,
            artist: None,
            cover: None,
        }
    }

    fn ledger_of(weeks: Vec<(&str, Vec<Stat>)>) -> Ledger {
        let mut ledger = Ledger::new();
        for (key, stats) in weeks {
            let mut week = WeekLog::new(key);
            for s in stats {
                let mut info = song(s.id);
                if let Some((name, id)) = s.artist {
                    info.artist = name.into();
                    info.artist_id = id.map(Into::into);
                }
                if let Some(cover) = s.cover {
                    info.cover_art = Some(cover.into());
                }
                week.days[s.day] += s.seconds;
                week.songs.push(SongStat {
                    song: info,
                    seconds: s.seconds,
                    plays: s.plays,
                });
            }
            ledger.insert(key.into(), week);
        }
        ledger
    }

    #[test]
    fn a_week_runs_from_monday_to_sunday_local_time() {
        let tz = paris();
        assert_eq!(week_key(at(2026, 10, 12, 0, 0, 0), &tz), "2026-10-12");
        assert_eq!(week_key(at(2026, 10, 11, 23, 59, 59), &tz), "2026-10-05");
        assert_eq!(week_key(at(2026, 10, 14, 12, 0, 0), &tz), "2026-10-12");
        assert_eq!(day_index(at(2026, 10, 12, 12, 0, 0), &tz), 0);
        assert_eq!(day_index(at(2026, 10, 18, 12, 0, 0), &tz), 6);
    }

    #[test]
    fn weeks_across_a_change_of_clock_stay_whole() {
        let tz = paris();
        assert_eq!(week_key(at(2026, 10, 25, 23, 30, 0), &tz), "2026-10-19");
        assert_eq!(shift_week("2026-10-19", 1), "2026-10-26");
        assert_eq!(shift_week("2026-03-30", -1), "2026-03-23");
        assert_eq!(week_key(at(2026, 3, 29, 3, 30, 0), &tz), "2026-03-23");
        let start = week_start_ms("2026-10-26", &tz).unwrap();
        assert_eq!(start, at(2026, 10, 26, 0, 0, 0), "midnight, local time");
    }

    #[test]
    fn the_week_reads_as_dates_in_french() {
        assert_eq!(week_label("2026-10-05"), "5 – 11 octobre");
        assert_eq!(week_label("2026-09-28"), "28 septembre – 4 octobre");
        assert_eq!(
            week_label("2025-12-29"),
            "29 décembre 2025 – 4 janvier 2026"
        );
        assert_eq!(duration_label(0), "moins d'une minute");
        assert_eq!(duration_label(45), "45 min");
        assert_eq!(duration_label(742), "12 h 22 min");
        assert_eq!(duration_label(120), "2 h");
    }

    #[test]
    fn top_songs_most_played_then_most_heard_and_never_a_skipped_one() {
        let ledger = ledger_of(vec![(
            "2026-10-05",
            vec![
                stat("a", 3, 500.0),
                stat("b", 5, 400.0),
                stat("c", 3, 900.0),
                stat("skipped", 0, 2000.0),
            ],
        )]);
        let wrapped = summarize(&ledger, "2026-10-05", &paris()).unwrap();
        let ids: Vec<&str> = wrapped
            .top_songs
            .iter()
            .map(|s| s.song.id.as_str())
            .collect();
        assert_eq!(ids, ["b", "c", "a"]);
        assert_eq!(wrapped.plays, 11);
        assert_eq!(wrapped.minutes, round(3800.0 / 60.0));
    }

    #[test]
    fn top_artists_by_time_heard_with_their_most_heard_cover() {
        let a = |id,
                 plays,
                 seconds,
                 name,
                 artist_id: Option<&'static str>,
                 cover: Option<&'static str>| Stat {
            artist: Some((name, artist_id)),
            cover,
            ..stat(id, plays, seconds)
        };
        let ledger = ledger_of(vec![(
            "2026-10-05",
            vec![
                a("x1", 1, 300.0, "Xena", Some("ar-x"), Some("cover-x1")),
                a("x2", 1, 600.0, "Xena", Some("ar-x"), Some("cover-x2")),
                a("y", 4, 800.0, "Yann", Some("ar-y"), None),
                a("z", 0, 20.0, "Zoé", Some("ar-z"), None),
                a("w", 1, 100.0, "Wil", None, None),
                a("w2", 1, 100.0, " wil ", None, None),
            ],
        )]);
        let wrapped = summarize(&ledger, "2026-10-05", &paris()).unwrap();
        let top: Vec<(&str, f64, u32)> = wrapped
            .top_artists
            .iter()
            .map(|a| (a.name.as_str(), a.seconds, a.plays))
            .collect();
        assert_eq!(
            top,
            [("Xena", 900.0, 2), ("Yann", 800.0, 4), ("Wil", 200.0, 2)]
        );
        assert_eq!(
            wrapped.top_artists[0].cover_art.as_deref(),
            Some("cover-x2")
        );
        assert_eq!(wrapped.artist_count, 3, "Zoé, heard 20 s, is not counted");
    }

    #[test]
    fn the_days_the_busiest_one_and_the_change_from_the_week_before() {
        let ledger = ledger_of(vec![
            ("2026-09-28", vec![stat("p", 2, 3000.0)]),
            (
                "2026-10-05",
                vec![
                    Stat {
                        day: 3,
                        ..stat("a", 2, 1200.0)
                    },
                    Stat {
                        day: 5,
                        ..stat("b", 1, 2400.0)
                    },
                ],
            ),
        ]);
        let wrapped = summarize(&ledger, "2026-10-05", &paris()).unwrap();
        assert_eq!(wrapped.days, [0, 0, 0, 20, 0, 40, 0]);
        assert_eq!(wrapped.busiest_day, Some(5));
        assert_eq!(wrapped.previous_minutes, Some(50));
        assert_eq!(
            change_label(wrapped.minutes, wrapped.previous_minutes).unwrap(),
            "+20 % par rapport à la semaine d'avant"
        );
        assert_eq!(
            change_label(30, Some(60)).unwrap(),
            "−50 % par rapport à la semaine d'avant"
        );
        assert_eq!(
            change_label(60, Some(60)).unwrap(),
            "autant que la semaine d'avant"
        );
        assert_eq!(change_label(30, None), None);
        assert_eq!(summarize(&ledger, "2026-10-12", &paris()), None);
    }

    #[test]
    fn it_is_due_from_monday_10_for_the_week_just_ended_until_shown() {
        let tz = paris();
        let ledger = ledger_of(vec![("2026-10-05", vec![stat("a", 3, 900.0)])]);
        assert_eq!(
            due_week(&ledger, at(2026, 10, 12, 9, 59, 0), None, &tz),
            None
        );
        assert_eq!(
            due_week(&ledger, at(2026, 10, 12, 10, 0, 0), None, &tz).as_deref(),
            Some("2026-10-05")
        );
        assert_eq!(
            due_week(&ledger, at(2026, 10, 14, 8, 0, 0), None, &tz).as_deref(),
            Some("2026-10-05"),
            "missed on Monday"
        );
        assert_eq!(
            due_week(&ledger, at(2026, 10, 12, 18, 0, 0), Some("2026-10-05"), &tz),
            None
        );
        assert_eq!(
            due_week(&ledger, at(2026, 10, 19, 11, 0, 0), Some("2026-10-05"), &tz),
            None,
            "the next week had nothing"
        );
        let short = ledger_of(vec![("2026-10-05", vec![stat("a", 1, 200.0)])]);
        assert_eq!(
            due_week(&short, at(2026, 10, 12, 11, 0, 0), None, &tz),
            None,
            "under five minutes"
        );
    }

    #[test]
    fn the_popup_opens_once_and_settings_opening_does_not_use_it_up() {
        let tz = paris();
        let ledger = ledger_of(vec![("2026-10-12", vec![stat("fav", 2, 600.0)])]);
        let mut popup = WrappedPopup::new(None);
        popup.check(&ledger, at(2026, 10, 19, 9, 59, 0), &tz);
        assert_eq!(popup.week, None, "not before 10:00");
        popup.check(&ledger, at(2026, 10, 19, 10, 0, 0), &tz);
        assert_eq!(popup.week.as_deref(), Some("2026-10-12"));
        popup.show("2026-10-05");
        popup.check(&ledger, at(2026, 10, 19, 10, 1, 0), &tz);
        assert_eq!(
            popup.week.as_deref(),
            Some("2026-10-05"),
            "browsing is left alone"
        );
        assert_eq!(
            popup.close().as_deref(),
            Some("2026-10-12"),
            "saved as shown"
        );
        popup.check(&ledger, at(2026, 10, 19, 11, 0, 0), &tz);
        assert_eq!(popup.week, None, "shown once");

        // From Settings during the week under way: it does not count as the popup.
        let ledger = ledger_of(vec![("2026-11-02", vec![stat("s", 1, 400.0)])]);
        let mut popup = WrappedPopup::new(None);
        popup.open(&ledger, at(2026, 11, 4, 20, 0, 0), &tz);
        assert_eq!(popup.week.as_deref(), Some("2026-11-02"));
        assert_eq!(popup.close(), None);
        popup.check(&ledger, at(2026, 11, 9, 10, 5, 0), &tz);
        assert_eq!(
            popup.week.as_deref(),
            Some("2026-11-02"),
            "it still pops up on Monday"
        );
        popup.close();

        // From Settings while it is due: it counts as seen.
        let mut popup = WrappedPopup::new(None);
        popup.open(&ledger, at(2026, 11, 9, 11, 0, 0), &tz);
        popup.show("2026-11-09");
        assert_eq!(popup.close().as_deref(), Some("2026-11-02"));
    }

    #[test]
    fn the_weeks_one_can_browse() {
        let tz = paris();
        let ledger = ledger_of(vec![
            ("2026-09-14", vec![stat("a", 1, 100.0)]),
            ("2026-10-05", vec![stat("b", 1, 100.0)]),
        ]);
        assert_eq!(
            week_range(&ledger, at(2026, 10, 14, 12, 0, 0), &tz),
            ("2026-09-14".into(), "2026-10-12".into())
        );
        assert_eq!(
            week_range(&Ledger::new(), at(2026, 10, 14, 12, 0, 0), &tz),
            ("2026-10-12".into(), "2026-10-12".into())
        );
        assert_eq!(
            latest_week(&ledger, at(2026, 10, 14, 12, 0, 0), &tz),
            "2026-10-05"
        );
        assert_eq!(
            latest_week(&ledger, at(2026, 10, 21, 12, 0, 0), &tz),
            "2026-10-19",
            "the week before is empty"
        );
    }

    #[test]
    fn a_week_is_saved_and_read_back_and_malformed_parts_are_left_out() {
        let ledger = ledger_of(vec![("2026-10-05", vec![stat("a", 2, 300.0)])]);
        let saved = week_to_json(&ledger["2026-10-05"]);
        assert_eq!(
            week_from_json("2026-10-05", &saved).as_ref(),
            ledger.get("2026-10-05")
        );
        let mut broken = saved.clone();
        broken["songs"]["bad"] = json!({ "title": 5, "seconds": 1, "plays": 1 });
        broken["days"][2] = json!("x");
        let read = week_from_json("2026-10-05", &broken).unwrap();
        assert_eq!(read.songs.len(), 1);
        assert_eq!(read.days[2], 0.0);
        assert_eq!(week_from_json("2026-10", &saved), None);
        assert_eq!(
            week_from_json("2026-10-05", &json!({ "days": [1, 2] })),
            None
        );
    }

    #[test]
    fn weeks_older_than_half_a_year_are_forgotten() {
        let tz = paris();
        let old = shift_week("2026-10-12", -30);
        let mut ledger = ledger_of(vec![
            (old.as_str(), vec![stat("o", 1, 100.0)]),
            ("2026-10-12", vec![stat("n", 1, 100.0)]),
        ]);
        assert_eq!(
            prune(&mut ledger, at(2026, 10, 14, 12, 0, 0), &tz, KEEP_WEEKS),
            [old]
        );
        assert_eq!(ledger.len(), 1);
    }
}
