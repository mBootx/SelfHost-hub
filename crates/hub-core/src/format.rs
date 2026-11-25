//! Times, sizes and progress as the apps show them. Port of `wear/core/.../Formatting.kt`.

/// "3:07", or "1:02:03" past an hour. Negative and non-finite values show as 0:00.
pub fn format_clock(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds >= 0.0 {
        seconds as u64
    } else {
        0
    };
    let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

/// A size the way the apps write it, in French: "12,4 Mo".
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} o");
    }
    const UNITS: [&str; 3] = ["Ko", "Mo", "Go"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    // Rounded half up, like Java's String.format, then written with a decimal comma.
    let number = if value >= 100.0 {
        format!("{}", (value + 0.5).floor())
    } else {
        format!("{:.1}", (value * 10.0 + 0.5).floor() / 10.0).replace('.', ",")
    };
    format!("{number} {}", UNITS[unit])
}

/// The progress of a song as a fraction of its length, for a bar: 0 when the length is unknown.
pub fn progress_fraction(position: f64, duration: f64) -> f32 {
    if duration <= 0.0 || position.is_nan() || duration.is_nan() {
        return 0.0;
    }
    (position / duration).clamp(0.0, 1.0) as f32
}

// Ported from FormattingTest in wear/core/src/test/kotlin/com/selfhosthub/wear/core/SetupAndNetworkTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_times() {
        assert_eq!(format_clock(0.0), "0:00");
        assert_eq!(format_clock(9.9), "0:09");
        assert_eq!(format_clock(187.0), "3:07");
        assert_eq!(format_clock(3723.0), "1:02:03");
        assert_eq!(format_clock(-4.0), "0:00");
        assert_eq!(format_clock(f64::NAN), "0:00");
        assert_eq!(format_clock(f64::INFINITY), "0:00");
    }

    #[test]
    fn sizes_are_written_in_french() {
        assert_eq!(format_bytes(512), "512 o");
        assert_eq!(format_bytes(1536), "1,5 Ko");
        assert_eq!(format_bytes((12.4 * 1024.0 * 1024.0) as u64), "12,4 Mo");
        assert_eq!(format_bytes(120 * 1024 * 1024), "120 Mo");
        assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2,0 Go");
    }

    #[test]
    fn halves_round_up_as_in_the_kotlin_app() {
        // 1.25 Ko: Java's %.1f gives "1,3"; Rust's own formatting would give "1.2".
        assert_eq!(format_bytes(1280), "1,3 Ko");
    }

    #[test]
    fn progress_is_a_fraction_between_0_and_1() {
        assert_eq!(progress_fraction(10.0, 0.0), 0.0);
        assert_eq!(progress_fraction(50.0, 100.0), 0.5);
        assert_eq!(progress_fraction(150.0, 100.0), 1.0);
        assert_eq!(progress_fraction(-5.0, 100.0), 0.0);
        assert_eq!(progress_fraction(f64::NAN, 100.0), 0.0);
    }
}
