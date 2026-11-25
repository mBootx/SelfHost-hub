//! Song lyrics: LRC parsing, the line to highlight, and what a lyrics lookup found.
//!
//! Port of the pure parts of `mobile/src/services/lyrics.ts` (the desktop's copy is the same).

#[derive(Debug, Clone, PartialEq)]
pub struct LyricLine {
    /// Seconds from the start of the song.
    pub time: f64,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LyricsSource {
    Lrclib,
    Navidrome,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LyricsResult {
    /// Timestamped lines, when the provider had a synced version.
    pub synced: Option<Vec<LyricLine>>,
    pub plain: Option<String>,
    pub source: LyricsSource,
}

/// What is shown for an instrumental.
pub const INSTRUMENTAL: &str = "♪ Instrumental ♪";

/// Parses LRC timestamps `[mm:ss]`, `[mm:ss.xx]` or `[mm:ss:xx]`. A line can carry several stamps
/// (`[00:12.34][01:40.00] text`) when a phrase repeats, and blank lines are kept so the highlight still advances
/// through instrumental gaps. Lines without a stamp (tags such as `[ar:...]`) are left out.
pub fn parse_lrc(lrc: &str) -> Vec<LyricLine> {
    let mut lines = Vec::new();
    for raw in lrc.split('\n') {
        let stamps = stamps_in(raw);
        if stamps.is_empty() {
            continue;
        }
        let text = without_brackets(raw).trim().to_owned();
        lines.extend(stamps.into_iter().map(|time| LyricLine {
            time,
            text: text.clone(),
        }));
    }
    // Stable, like JavaScript's sort: lines at the same time keep their order.
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));
    lines
}

/// Every `[m:ss(.fff)]` stamp of a line, in seconds (1 to 3 digits of minutes, 1 to 3 of fraction).
fn stamps_in(line: &str) -> Vec<f64> {
    let bytes = line.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'['
            && let Some((time, len)) = stamp_at(&bytes[i + 1..])
        {
            found.push(time);
            i += 1 + len;
            continue;
        }
        i += 1;
    }
    found
}

/// A stamp at the start of `s` (just after its `[`): its time and how many bytes it takes, `]` included.
fn stamp_at(s: &[u8]) -> Option<(f64, usize)> {
    let digits = |from: usize, max: usize| {
        s[from..]
            .iter()
            .take(max)
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    let minutes_len = digits(0, 3);
    if minutes_len == 0 || s.get(minutes_len) != Some(&b':') {
        return None;
    }
    let sec_start = minutes_len + 1;
    if digits(sec_start, 2) != 2 {
        return None;
    }
    let mut end = sec_start + 2;
    let mut fraction = 0.0;
    if matches!(s.get(end), Some(b'.' | b':')) {
        let frac_len = digits(end + 1, 3);
        if frac_len > 0 {
            let text = std::str::from_utf8(&s[end + 1..end + 1 + frac_len]).ok()?;
            // "5" is 500 ms, "05" is 50 ms: padded to three digits.
            fraction = format!("{text:0<3}").parse::<f64>().ok()? / 1000.0;
            end += 1 + frac_len;
        }
    }
    if s.get(end) != Some(&b']') {
        return None;
    }
    let minutes: f64 = std::str::from_utf8(&s[..minutes_len]).ok()?.parse().ok()?;
    let seconds: f64 = std::str::from_utf8(&s[sec_start..sec_start + 2])
        .ok()?
        .parse()
        .ok()?;
    Some((minutes * 60.0 + seconds + fraction, end + 1))
}

/// The line with every `[...]` taken out.
fn without_brackets(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        match rest[open..].find(']') {
            Some(close) => rest = &rest[open + close + 1..],
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The line to highlight at `time`: the last one that has started, `None` before the first.
pub fn active_line_index(lines: &[LyricLine], time: f64) -> Option<usize> {
    lines
        .iter()
        .take_while(|l| l.time <= time)
        .count()
        .checked_sub(1)
}

/// What an LRCLIB record holds, or `None` when it has neither synced nor plain lyrics.
pub fn from_lrclib(
    synced: Option<&str>,
    plain: Option<&str>,
    instrumental: bool,
) -> Option<LyricsResult> {
    if instrumental {
        return Some(LyricsResult {
            synced: None,
            plain: Some(INSTRUMENTAL.into()),
            source: LyricsSource::Lrclib,
        });
    }
    let synced = synced
        .filter(|s| !s.is_empty())
        .map(parse_lrc)
        .filter(|lines| !lines.is_empty());
    let plain = plain
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(Into::into);
    if synced.is_none() && plain.is_none() {
        return None;
    }
    Some(LyricsResult {
        synced,
        plain,
        source: LyricsSource::Lrclib,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn times(lines: &[LyricLine]) -> Vec<f64> {
        lines.iter().map(|l| l.time).collect()
    }

    #[test]
    fn stamps_in_their_three_forms() {
        let lines = parse_lrc("[00:12.34]Un\n[01:05]Deux\n[02:03:5]Trois\n[123:00.001]Long");
        assert_eq!(times(&lines), [12.34, 65.0, 123.5, 7380.001]);
        assert_eq!(lines[0].text, "Un");
    }

    #[test]
    fn a_line_with_several_stamps_repeats_and_everything_is_in_time_order() {
        let lines = parse_lrc("[01:40.00][00:12.00] Refrain \n[00:30.00]Couplet");
        let summary: Vec<(f64, &str)> = lines.iter().map(|l| (l.time, l.text.as_str())).collect();
        assert_eq!(
            summary,
            [(12.0, "Refrain"), (30.0, "Couplet"), (100.0, "Refrain")]
        );
    }

    #[test]
    fn blank_stamped_lines_stay_and_tags_without_time_go() {
        let lines =
            parse_lrc("[ar:alt-J]\n[ti:Breezeblocks]\n[00:01.00]\n[00:02.00]Do you know\nno stamp");
        let summary: Vec<(f64, &str)> = lines.iter().map(|l| (l.time, l.text.as_str())).collect();
        assert_eq!(summary, [(1.0, ""), (2.0, "Do you know")]);
    }

    #[test]
    fn windows_line_ends_and_broken_stamps() {
        let lines = parse_lrc(
            "[00:01.00]Un\r\n[0:2.00]Pas un stamp\n[00:03.5x]Non plus\n[00:04]Quatre [note]",
        );
        let summary: Vec<(f64, &str)> = lines.iter().map(|l| (l.time, l.text.as_str())).collect();
        assert_eq!(summary, [(1.0, "Un"), (4.0, "Quatre")]);
    }

    #[test]
    fn the_active_line_is_the_last_one_started() {
        let lines = parse_lrc("[00:10]A\n[00:20]B\n[00:30]C");
        assert_eq!(active_line_index(&lines, 5.0), None);
        assert_eq!(active_line_index(&lines, 10.0), Some(0));
        assert_eq!(active_line_index(&lines, 25.0), Some(1));
        assert_eq!(active_line_index(&lines, 99.0), Some(2));
        assert_eq!(active_line_index(&[], 1.0), None);
    }

    #[test]
    fn an_lrclib_record_is_read_or_found_empty() {
        let instrumental = from_lrclib(None, None, true).unwrap();
        assert_eq!(instrumental.plain.as_deref(), Some(INSTRUMENTAL));
        assert_eq!(from_lrclib(Some(""), Some("  "), false), None);
        let both = from_lrclib(Some("[00:01]A"), Some(" A \n"), false).unwrap();
        assert_eq!(both.synced.unwrap().len(), 1);
        assert_eq!(both.plain.as_deref(), Some("A"));
        let no_stamps = from_lrclib(Some("A"), Some("A"), false).unwrap();
        assert_eq!(
            no_stamps.synced, None,
            "synced text with no stamp in it counts as none"
        );
    }
}
