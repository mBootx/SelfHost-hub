//! The colours of the Now Playing screen for one cover, worked out from a small copy of it.
//!
//! Port of `wear/core/.../CoverPalette.kt`, which follows the phone's `mobile/src/services/coverColor.ts`: the
//! controls take another colourful colour of the cover when it has one, else its own most vivid colour, lifted
//! until it stands out on the dark screen; a black and white cover gets white controls. Also how dark the veil over
//! the blurred cover behind must be for white text to stay readable.
//!
//! Colours are ARGB `u32`s (`0xAARRGGBB`).

const HUE_BINS: usize = 24;
const MIN_COLOURED: f64 = 0.06;
const MIN_ACCENT: f64 = 0.02;
const OTHER_ACCENT_VIVID: f64 = 0.35;
const HUE_GAP: f64 = 45.0;

/// What the controls stand out against: the veiled cover, at its darkest about this.
const BACKDROP: u32 = rgb(20, 20, 20);
const WHITE: u32 = rgb(255, 255, 255);
const BLACK: u32 = rgb(0, 0, 0);
const GREY_ACCENT: u32 = rgb(242, 242, 242);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CoverColors {
    /// The controls: play button, seek bar, what is switched on.
    pub accent: u32,
    /// Icons on the accent: black or white, whichever reads better.
    pub on_accent: u32,
    /// True for a cover with no colour to speak of.
    pub grey: bool,
    /// How opaque (0 to 1) the black veil over the cover behind must be: the brighter the cover's bright parts,
    /// the darker.
    pub veil: f32,
}

#[derive(Debug, Clone, Copy)]
struct Group {
    share: f64,
    vivid: f64,
    colour: u32,
    hue: f64,
}

impl Group {
    fn striking(&self) -> f64 {
        self.vivid * self.share.sqrt()
    }
}

/// The colours for a cover from its pixels (ARGB; a 32 by 32 copy is plenty); `None` for no pixels.
pub fn cover_colors(pixels: &[u32]) -> Option<CoverColors> {
    if pixels.is_empty() {
        return None;
    }
    let mut count = [0.0f64; HUE_BINS];
    let mut weight = [0.0f64; HUE_BINS];
    let mut red = [0.0f64; HUE_BINS];
    let mut green = [0.0f64; HUE_BINS];
    let mut blue = [0.0f64; HUE_BINS];
    let mut vivid = [0.0f64; HUE_BINS];
    let mut coloured = 0usize;
    for &pixel in pixels {
        let (r, g, b) = channels(pixel);
        let hi = f64::from(r.max(g).max(b)) / 255.0;
        let lo = f64::from(r.min(g).min(b)) / 255.0;
        let saturation = if hi == 0.0 { 0.0 } else { (hi - lo) / hi };
        if saturation < 0.2 || hi < 0.15 {
            continue;
        }
        coloured += 1;
        let bin = ((hsl(pixel).0 / (360.0 / HUE_BINS as f64)).floor() as i64)
            .rem_euclid(HUE_BINS as i64) as usize;
        let w = 0.05 + saturation * hi;
        count[bin] += 1.0;
        weight[bin] += w;
        red[bin] += f64::from(r) * w;
        green[bin] += f64::from(g) * w;
        blue[bin] += f64::from(b) * w;
        vivid[bin] += saturation * hi;
    }
    let total = pixels.len() as f64;
    let veil = veil_for(bright_luminance(pixels));

    // Each hue with its two neighbours: one colour often straddles two bins.
    let groups: Vec<Group> = (0..HUE_BINS)
        .map(|i| {
            let prev = (i + HUE_BINS - 1) % HUE_BINS;
            let next = (i + 1) % HUE_BINS;
            let n = count[prev] + count[i] + count[next];
            let w = weight[prev] + weight[i] + weight[next];
            let colour = if w > 0.0 {
                rgb_clamped(
                    ((red[prev] + red[i] + red[next]) / w) as i64,
                    ((green[prev] + green[i] + green[next]) / w) as i64,
                    ((blue[prev] + blue[i] + blue[next]) / w) as i64,
                )
            } else {
                BLACK
            };
            let v = vivid[prev] + vivid[i] + vivid[next];
            Group {
                share: n / total,
                vivid: if n > 0.0 { v / n } else { 0.0 },
                colour,
                hue: hsl(colour).0,
            }
        })
        .collect();

    let most_striking = first_max_by(
        groups.iter().filter(|g| g.share >= MIN_ACCENT),
        Group::striking,
    );

    if (coloured as f64) / total < MIN_COLOURED {
        let accent = most_striking.map_or(GREY_ACCENT, |g| lifted(g.colour));
        return Some(CoverColors {
            accent,
            on_accent: on_colour(accent),
            grey: true,
            veil,
        });
    }
    let base = first_max_by(groups.iter(), |g| g.share * (0.25 + g.vivid))
        .expect("there are always 24 groups");
    let other = first_max_by(
        groups.iter().filter(|g| {
            g.share >= MIN_ACCENT
                && g.vivid >= OTHER_ACCENT_VIVID
                && hue_distance(g.hue, base.hue) >= HUE_GAP
        }),
        Group::striking,
    );
    let accent = lifted(other.or(most_striking).unwrap_or(base).colour);
    Some(CoverColors {
        accent,
        on_accent: on_colour(accent),
        grey: false,
        veil,
    })
}

/// The item with the largest key, the first one on a tie (as Kotlin's `maxBy`, unlike `Iterator::max_by`).
fn first_max_by<'a, T>(
    items: impl Iterator<Item = &'a T>,
    key: impl Fn(&T) -> f64,
) -> Option<&'a T> {
    let mut best: Option<(&T, f64)> = None;
    for item in items {
        let k = key(item);
        if best.is_none_or(|(_, b)| k > b) {
            best = Some((item, k));
        }
    }
    best.map(|(item, _)| item)
}

/// The colour made vivid and light enough to stand out (3:1) on the dark screen, its hue kept.
pub fn lifted(colour: u32) -> u32 {
    let (h, s, _) = hsl(colour);
    if s < 0.15 {
        return GREY_ACCENT;
    }
    let saturation = s.clamp(0.5, 0.95);
    let mut lightness = 0.6;
    let mut result = from_hsl(h, saturation, lightness);
    while contrast(result, BACKDROP) < 3.1 && lightness < 0.85 {
        lightness += 0.03;
        result = from_hsl(h, saturation, lightness);
    }
    result
}

/// Black or white, whichever reads better on `colour`.
pub fn on_colour(colour: u32) -> u32 {
    if contrast(colour, BLACK) >= contrast(colour, WHITE) {
        BLACK
    } else {
        WHITE
    }
}

/// How opaque the black veil over a cover this bright (see [`bright_luminance`]) must be for white text on it to
/// keep 4.5:1: never under half (the cover stays a backdrop, not the subject), never over 90 % (it must still show).
pub fn veil_for(luminance: f64) -> f32 {
    // White on (1 - a) * L needs 1.05 / ((1 - a) * L + 0.05) >= 4.5, so (1 - a) * L <= 0.1833.
    let needed = if luminance <= 0.0 {
        0.0
    } else {
        1.0 - 0.1833 / luminance
    };
    needed.clamp(0.5, 0.9) as f32
}

/// How bright the bright parts of a cover are: the luminance 90 % of its pixels stay under. The text sits on any
/// part of it, so the average is not enough; the brightest tenth is left out, so that a small white logo does not
/// darken the whole screen.
pub fn bright_luminance(pixels: &[u32]) -> f64 {
    if pixels.is_empty() {
        return 0.0;
    }
    let mut lums: Vec<f64> = pixels.iter().map(|&p| luminance(p)).collect();
    lums.sort_by(f64::total_cmp);
    lums[((lums.len() - 1) as f64 * 0.9) as usize]
}

// --- Colour maths ---

/// An opaque colour.
pub const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    0xFF00_0000 | (r as u32) << 16 | (g as u32) << 8 | b as u32
}

/// An opaque colour from channels clamped to 0..=255.
fn rgb_clamped(r: i64, g: i64, b: i64) -> u32 {
    let c = |v: i64| v.clamp(0, 255) as u8;
    rgb(c(r), c(g), c(b))
}

fn channels(colour: u32) -> (u8, u8, u8) {
    ((colour >> 16) as u8, (colour >> 8) as u8, colour as u8)
}

/// Relative luminance, as WCAG defines it.
pub fn luminance(colour: u32) -> f64 {
    let channel = |c: u8| {
        let v = f64::from(c) / 255.0;
        if v <= 0.03928 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = channels(colour);
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// WCAG contrast ratio, from 1 to 21.
pub fn contrast(a: u32, b: u32) -> f64 {
    let la = luminance(a);
    let lb = luminance(b);
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// Degrees between two hues, 0 to 180.
pub fn hue_distance(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

/// Hue in degrees, saturation and lightness from 0 to 1.
pub fn hsl(colour: u32) -> (f64, f64, f64) {
    let (r, g, b) = channels(colour);
    let (r, g, b) = (
        f64::from(r) / 255.0,
        f64::from(g) / 255.0,
        f64::from(b) / 255.0,
    );
    let hi = r.max(g).max(b);
    let lo = r.min(g).min(b);
    let l = (hi + lo) / 2.0;
    if hi == lo {
        return (0.0, 0.0, l);
    }
    let d = hi - lo;
    let s = if l > 0.5 {
        d / (2.0 - hi - lo)
    } else {
        d / (hi + lo)
    };
    let h = if hi == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if hi == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

pub fn from_hsl(h: f64, s: f64, l: f64) -> u32 {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = if h < 60.0 {
        (c, x, 0.0)
    } else if h < 120.0 {
        (x, c, 0.0)
    } else if h < 180.0 {
        (0.0, c, x)
    } else if h < 240.0 {
        (0.0, x, c)
    } else if h < 300.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    // Java's Math.round: half up.
    let round = |v: f64| ((v + m) * 255.0 + 0.5).floor() as i64;
    rgb_clamped(round(r), round(g), round(b))
}

// Ported from wear/core/src/test/kotlin/com/selfhosthub/wear/core/CoverPaletteTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    /// A 32 by 32 cover made of colours in the given shares.
    fn cover(parts: &[(u32, f64)]) -> Vec<u32> {
        let total = 32 * 32;
        let mut out = Vec::with_capacity(total);
        for (i, &(colour, share)) in parts.iter().enumerate() {
            let n = if i == parts.len() - 1 {
                total - out.len()
            } else {
                (total as f64 * share + 0.5).floor() as usize
            };
            out.extend(std::iter::repeat_n(colour, n));
        }
        out
    }

    fn hue_of(colour: u32) -> f64 {
        hsl(colour).0
    }

    const RED: u32 = rgb(200, 30, 40);
    const TEAL: u32 = rgb(31, 138, 158);
    const YELLOW: u32 = rgb(242, 209, 107);
    const BROWN: u32 = rgb(90, 70, 60);
    const NEAR_BLACK: u32 = rgb(8, 8, 10);
    const NEAR_WHITE: u32 = rgb(245, 245, 245);

    #[test]
    fn a_red_cover_gets_red_controls() {
        let c = cover_colors(&cover(&[(RED, 0.8), (NEAR_BLACK, 0.1), (NEAR_WHITE, 0.1)])).unwrap();
        assert!(hue_distance(hue_of(c.accent), 356.0) < 12.0);
        assert!(!c.grey);
    }

    #[test]
    fn a_teal_cover_with_a_yellow_sun_gets_yellow_controls() {
        let c = cover_colors(&cover(&[(TEAL, 0.65), (YELLOW, 0.3), (NEAR_WHITE, 0.05)])).unwrap();
        assert!(
            hue_distance(hue_of(c.accent), hue_of(YELLOW)) < 12.0,
            "accent {:08x}",
            c.accent
        );
    }

    #[test]
    fn a_dull_second_colour_does_not_take_the_controls() {
        let c = cover_colors(&cover(&[(TEAL, 0.6), (BROWN, 0.35), (NEAR_WHITE, 0.05)])).unwrap();
        assert!(hue_distance(hue_of(c.accent), hue_of(TEAL)) < 12.0);
    }

    #[test]
    fn black_and_white_is_grey_with_near_white_controls_and_black_icons() {
        let c = cover_colors(&cover(&[(NEAR_BLACK, 0.6), (NEAR_WHITE, 0.4)])).unwrap();
        assert!(c.grey);
        assert_eq!(c.accent, rgb(242, 242, 242));
        assert_eq!(c.on_accent, rgb(0, 0, 0));
    }

    #[test]
    fn a_dark_cover_with_a_small_red_logo_stays_grey_but_takes_the_logo_colour() {
        let c = cover_colors(&cover(&[(NEAR_BLACK, 0.96), (RED, 0.04)])).unwrap();
        assert!(c.grey);
        assert!(hue_distance(hue_of(c.accent), 356.0) < 12.0);
    }

    #[test]
    fn no_pixels_no_colours() {
        assert_eq!(cover_colors(&[]), None);
    }

    #[test]
    fn whatever_the_cover_the_controls_stand_out_and_their_icons_on_them() {
        // A small xorshift generator: fixed seed, so a failure can be replayed.
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        };
        for _ in 0..400 {
            let mut colour = || rgb(next(), next(), next());
            let c =
                cover_colors(&cover(&[(colour(), 0.5), (colour(), 0.3), (colour(), 0.2)])).unwrap();
            assert!(
                contrast(c.accent, BACKDROP) >= 3.0,
                "accent {:08x}",
                c.accent
            );
            assert!(
                contrast(c.on_accent, c.accent) >= 4.5,
                "icons on {:08x}",
                c.accent
            );
        }
    }

    #[test]
    fn the_veil_keeps_white_text_readable_and_the_cover_still_shows() {
        for luminance in [0.0, 0.05, 0.2, 0.4, 0.7, 1.0] {
            let veil = veil_for(luminance);
            assert!((0.5..=0.9).contains(&veil));
            let behind = (1.0 - f64::from(veil)) * luminance;
            assert!(
                1.05 / (behind + 0.05) >= 4.5 || veil == 0.9,
                "luminance {luminance} veil {veil}"
            );
        }
        assert_eq!(veil_for(0.1), 0.5);
        assert!(veil_for(1.0) > veil_for(0.4));
    }

    #[test]
    fn a_white_cover_gets_the_darkest_veil_a_black_one_the_lightest() {
        let white = cover_colors(&cover(&[(rgb(255, 255, 255), 1.0)])).unwrap();
        let black = cover_colors(&cover(&[(rgb(0, 0, 0), 1.0)])).unwrap();
        // Pure white needs about 82 % for 4.5:1, which is the darkest any cover needs.
        assert!((white.veil - 0.8167).abs() < 0.001, "{}", white.veil);
        assert_eq!(black.veil, 0.5);
    }

    #[test]
    fn a_bright_sun_darkens_the_veil_a_small_white_logo_does_not() {
        let sun = cover_colors(&cover(&[(TEAL, 0.65), (YELLOW, 0.35)])).unwrap();
        let sky = cover_colors(&cover(&[(TEAL, 1.0)])).unwrap();
        assert!(
            sun.veil > sky.veil + 0.1,
            "sun {} vs sky {}",
            sun.veil,
            sky.veil
        );
        // White text over the sun itself, veiled: still 4.5:1.
        let behind = (1.0 - f64::from(sun.veil)) * luminance(YELLOW);
        assert!(1.05 / (behind + 0.05) >= 4.5);
        let logo = cover_colors(&cover(&[(TEAL, 0.95), (rgb(255, 255, 255), 0.05)])).unwrap();
        assert!((sky.veil - logo.veil).abs() < 0.001);
    }

    #[test]
    fn lifting_keeps_the_hue_and_reaches_3_to_1() {
        for colour in [
            rgb(20, 10, 90),
            rgb(90, 10, 10),
            rgb(10, 60, 10),
            rgb(240, 220, 40),
        ] {
            let up = lifted(colour);
            assert!(hue_distance(hue_of(up), hue_of(colour)) < 10.0);
            assert!(contrast(up, BACKDROP) >= 3.0);
        }
    }

    #[test]
    fn ties_go_to_the_first_like_kotlin() {
        let items = [1.0, 3.0, 3.0, 2.0];
        let best = first_max_by(items.iter(), |v| *v).unwrap();
        assert!(std::ptr::eq(best, &items[1]));
    }
}
