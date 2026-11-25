//! Which file of a GitHub release the phone installs: its own APK, never the watch's. Also the version comparison
//! that decides whether a release is news.
//!
//! Port of `mobile/src/services/updateAsset.ts`.

pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/mBootx/SelfHost-hub/releases/latest";
pub const RELEASES_PAGE_URL: &str = "https://github.com/mBootx/SelfHost-hub/releases/latest";

/// What JavaScript's `parseInt(n, 10) || 0` makes of a version part: the integer the text starts with, and 0 when
/// there is none ("beta", "") so a malformed part never blocks the comparison.
fn js_int(part: &str) -> i64 {
    let s = part.trim_start();
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    // Past i64 the number is saturated: no real version part is that long.
    let n = digits[..end]
        .parse::<i64>()
        .unwrap_or(if end == 0 { 0 } else { i64::MAX });
    if negative { -n } else { n }
}

fn version_parts(version: &str) -> Vec<i64> {
    let version = match version.chars().next() {
        Some('v' | 'V') => &version[1..],
        _ => version,
    };
    version.split('.').map(js_int).collect()
}

/// Whether `candidate` is a later version than `current` (both "major.minor.patch", a leading "v" allowed).
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let a = version_parts(candidate);
    let b = version_parts(current);
    for i in 0..a.len().max(b.len()) {
        let diff = a.get(i).copied().unwrap_or(0) - b.get(i).copied().unwrap_or(0);
        if diff != 0 {
            return diff > 0;
        }
    }
    false
}

/// The name a release gives the phone's APK.
pub fn phone_apk_name(version: &str) -> String {
    format!("SelfHost-Hub-{version}.apk")
}

/// The name a release gives the watch app's APK.
pub fn watch_apk_name(version: &str) -> String {
    format!("SelfHost-Hub-Watch-{version}.apk")
}

/// The phone's own APK among a release's files. A release also carries the watch app's APK (SelfHost-Hub-Watch-X.apk),
/// which must never be installed on a phone: the one named for this version comes first, then any other APK that is
/// not a watch's. Versions before 2.5.0 took the first APK of the list, which is why the phone's is uploaded first.
/// `assets` can be anything that shows its file name, such as the release's asset records.
pub fn pick_phone_apk<'a, T: AsRef<str>>(assets: &'a [T], version: &str) -> Option<&'a T> {
    let wanted = phone_apk_name(version);
    assets.iter().find(|a| a.as_ref() == wanted).or_else(|| {
        assets.iter().find(|a| {
            let name = a.as_ref();
            let lower = name.to_lowercase();
            name.ends_with(".apk") && !lower.contains("watch") && !lower.contains("wear")
        })
    })
}

/// The watch app's APK among a release's files: only the one named for the version, never a phone's.
pub fn pick_watch_apk<'a, T: AsRef<str>>(assets: &'a [T], version: &str) -> Option<&'a T> {
    let wanted = watch_apk_name(version);
    assets.iter().find(|a| a.as_ref() == wanted)
}

// Ported from mobile/tests/updateasset.test.js.
#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| (*n).to_owned()).collect()
    }

    fn phone(list: &[&str], version: &str) -> Option<String> {
        pick_phone_apk(&names(list), version).cloned()
    }

    #[test]
    fn the_phone_apk_named_for_the_version_is_the_one_picked_wherever_it_stands_in_the_list() {
        let assets = names(&[
            "SelfHost-Hub-Watch-2.5.0.apk",
            "latest.yml",
            "SelfHost-Hub-2.5.0.apk",
            "SelfHost-Hub-Setup-2.5.0.exe",
        ]);
        assert_eq!(
            pick_phone_apk(&assets, "2.5.0").map(String::as_str),
            Some("SelfHost-Hub-2.5.0.apk")
        );
    }

    #[test]
    fn an_apk_that_is_not_the_watchs_is_the_fallback_when_the_name_is_not_the_usual_one() {
        assert_eq!(
            phone(&["app-release.apk"], "2.5.0").as_deref(),
            Some("app-release.apk")
        );
        assert_eq!(
            phone(&["SelfHost-Hub-Watch-2.5.0.apk", "other.apk"], "2.5.0").as_deref(),
            Some("other.apk")
        );
    }

    #[test]
    fn a_release_with_only_the_watch_apk_offers_the_phone_nothing() {
        assert_eq!(phone(&["SelfHost-Hub-Watch-2.5.0.apk"], "2.5.0"), None);
        assert_eq!(phone(&["SelfHost-Hub-Wear-2.5.0.apk"], "2.5.0"), None);
        assert_eq!(phone(&["latest.yml"], "2.5.0"), None);
        assert_eq!(phone(&[], "2.5.0"), None);
    }

    #[test]
    fn the_watch_apk_is_the_one_named_for_the_version_and_nothing_else_is_taken_for_it() {
        let assets = names(&[
            "SelfHost-Hub-2.5.2.apk",
            "SelfHost-Hub-Watch-2.5.1.apk",
            "SelfHost-Hub-Watch-2.5.2.apk",
            "latest.yml",
        ]);
        assert_eq!(
            pick_watch_apk(&assets, "2.5.2").map(String::as_str),
            Some("SelfHost-Hub-Watch-2.5.2.apk")
        );
        // a phone APK is never the one of the watch
        assert_eq!(
            pick_watch_apk(&names(&["SelfHost-Hub-2.5.2.apk", "other.apk"]), "2.5.2"),
            None
        );
        // nor another version
        assert_eq!(
            pick_watch_apk(&names(&["SelfHost-Hub-Watch-2.5.1.apk"]), "2.5.2"),
            None
        );
        assert_eq!(pick_watch_apk(&names(&[]), "2.5.2"), None);
    }

    #[test]
    fn the_name_a_release_gives_the_watch_apk() {
        assert_eq!(watch_apk_name("2.5.2"), "SelfHost-Hub-Watch-2.5.2.apk");
    }

    #[test]
    fn versions_are_compared_part_by_part_and_a_leading_v_does_not_matter() {
        assert!(is_newer("2.5.2", "2.5.0"));
        assert!(is_newer("v2.5.2", "2.5.1"));
        assert!(is_newer("2.10.0", "2.9.9"), "ten is more than nine");
        assert!(!is_newer("2.5.0", "2.5.0"));
        assert!(!is_newer("2.4.9", "2.5.0"));
        assert!(is_newer("3", "2.9.9"));
        assert!(!is_newer("2.5", "2.5.0"));
    }

    #[test]
    fn the_name_a_release_gives_the_phone_apk() {
        assert_eq!(phone_apk_name("2.5.0"), "SelfHost-Hub-2.5.0.apk");
    }
}
