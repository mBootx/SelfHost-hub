//! The pure side of FileBrowser share links: the lifetimes offered when making one, and how long a link has left, in
//! words.
//!
//! Port of `mobile/src/services/shareLinks.ts`. The link itself (creating, listing, its URLs and its expiry date) is
//! in `hub-net::filebrowser`, which depends on this crate; so a preset here carries its own [`ShareUnit`] and the
//! caller turns it into `hub_net::filebrowser::ShareDuration` (same value, same unit names).
//! No test in `mobile/tests` covers these functions; the tests below follow the TypeScript.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareUnit {
    Minutes,
    Hours,
    Days,
}

/// A lifetime for a share link: `value` times `unit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lifetime {
    pub value: u32,
    pub unit: ShareUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharePreset {
    pub label: &'static str,
    /// `None` for a link that never expires.
    pub duration: Option<Lifetime>,
}

const fn lasting(label: &'static str, value: u32, unit: ShareUnit) -> SharePreset {
    SharePreset {
        label,
        duration: Some(Lifetime { value, unit }),
    }
}

/// The lifetimes offered when making a share link.
pub const SHARE_DURATIONS: [SharePreset; 5] = [
    lasting("1 heure", 1, ShareUnit::Hours),
    lasting("1 jour", 1, ShareUnit::Days),
    lasting("7 jours", 7, ShareUnit::Days),
    lasting("30 jours", 30, ShareUnit::Days),
    SharePreset {
        label: "Sans limite",
        duration: None,
    },
];

/// How long a link has left, in words: "expire dans 3 j", "sans limite de durée", "expiré". Times are ms since the
/// epoch; `expires_at` is `None` for a link that never expires. Each unit rounds up, so a link never claims less time
/// than it has.
pub fn describe_expiry(expires_at: Option<i64>, now: i64) -> String {
    let Some(expires_at) = expires_at else {
        return "sans limite de durée".to_string();
    };
    let left = expires_at - now;
    if left <= 0 {
        return "expiré".to_string();
    }
    let minutes = left.unsigned_abs().div_ceil(60_000);
    if minutes < 60 {
        return format!("expire dans {minutes} min");
    }
    let hours = minutes.div_ceil(60);
    if hours < 24 {
        return format!("expire dans {hours} h");
    }
    format!("expire dans {} j", hours.div_ceil(24))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;
    const MINUTE: i64 = 60_000;
    const HOUR: i64 = 60 * MINUTE;
    const DAY: i64 = 24 * HOUR;

    #[test]
    fn the_lifetimes_offered_when_making_a_share_link() {
        let labels: Vec<_> = SHARE_DURATIONS.iter().map(|p| p.label).collect();
        assert_eq!(
            labels,
            ["1 heure", "1 jour", "7 jours", "30 jours", "Sans limite"]
        );
        assert_eq!(
            SHARE_DURATIONS[0].duration,
            Some(Lifetime {
                value: 1,
                unit: ShareUnit::Hours
            })
        );
        assert_eq!(
            SHARE_DURATIONS[3].duration,
            Some(Lifetime {
                value: 30,
                unit: ShareUnit::Days
            })
        );
        assert_eq!(SHARE_DURATIONS[4].duration, None);
    }

    #[test]
    fn a_link_with_no_expiry_has_no_limit_of_time() {
        assert_eq!(describe_expiry(None, NOW), "sans limite de durée");
    }

    #[test]
    fn a_link_past_its_date_or_on_it_is_expired() {
        assert_eq!(describe_expiry(Some(NOW), NOW), "expiré");
        assert_eq!(describe_expiry(Some(NOW - DAY), NOW), "expiré");
    }

    #[test]
    fn under_an_hour_it_counts_minutes_rounded_up() {
        assert_eq!(describe_expiry(Some(NOW + 1), NOW), "expire dans 1 min");
        assert_eq!(
            describe_expiry(Some(NOW + MINUTE), NOW),
            "expire dans 1 min"
        );
        assert_eq!(
            describe_expiry(Some(NOW + MINUTE + 1), NOW),
            "expire dans 2 min"
        );
        assert_eq!(
            describe_expiry(Some(NOW + 59 * MINUTE), NOW),
            "expire dans 59 min"
        );
    }

    #[test]
    fn under_a_day_it_counts_hours_rounded_up() {
        assert_eq!(describe_expiry(Some(NOW + HOUR), NOW), "expire dans 1 h");
        assert_eq!(
            describe_expiry(Some(NOW + HOUR + MINUTE), NOW),
            "expire dans 2 h"
        );
        assert_eq!(
            describe_expiry(Some(NOW + 23 * HOUR), NOW),
            "expire dans 23 h"
        );
    }

    #[test]
    fn from_a_day_on_it_counts_days_rounded_up() {
        assert_eq!(describe_expiry(Some(NOW + DAY), NOW), "expire dans 1 j");
        assert_eq!(describe_expiry(Some(NOW + DAY + 1), NOW), "expire dans 2 j");
        assert_eq!(describe_expiry(Some(NOW + 3 * DAY), NOW), "expire dans 3 j");
        assert_eq!(
            describe_expiry(Some(NOW + 30 * DAY), NOW),
            "expire dans 30 j"
        );
    }
}
