//! The phone's Now Playing screen dressed in the colours of the song's cover: its palette (the colour it is mostly
//! about, its most vivid one, a second colour of its own) read from a small copy of the cover, then turned into
//! colours white text and the controls stay readable on.
//!
//! Port of the pure parts of `mobile/src/services/coverColor.ts`. The watch's simpler reading is
//! [`crate::palette`]; the two differ on purpose (the phone also has a background gradient, a card and a glow).

/// A colour as three channels from 0 to 255, kept unrounded until it is written as `#rrggbb`.
pub type Rgb = [f64; 3];

#[derive(Debug, Clone, PartialEq)]
pub struct Palette {
    /// What the cover is mostly about: the background.
    pub base: Rgb,
    /// The controls' colour: another colourful colour of the cover if it has one, else its most vivid colour that
    /// covers enough of it to count; `None` when it has none.
    pub accent: Option<Rgb>,
    /// A second colour of its own, well apart in hue from the base, or `None` when the cover is one colour.
    pub second: Option<Rgb>,
    /// No colour to speak of: black and white, greys.
    pub grey: bool,
}

/// The colours of the Now Playing screen for one cover, as `#rrggbb`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Look {
    /// The background gradient, from the top down; the bottom stays in the cover's colour too.
    pub top: String,
    pub middle: String,
    pub bottom: String,
    /// The cover's second colour, glowing from the top corner.
    pub glow: Option<String>,
    /// The lyrics card and the full lyrics page.
    pub card: String,
    /// The controls: seek bar, play button, the heart, whatever is switched on.
    pub accent: String,
    /// Icons and text on the accent: black or white, whichever reads better.
    pub on_accent: String,
}

/// The app's own colours, for a song without a cover: the theme's surfaces and its accent.
pub fn plain_look(elevated: &str, raised: &str, base: &str, accent: &str) -> Look {
    Look {
        top: elevated.into(),
        middle: raised.into(),
        bottom: base.into(),
        glow: None,
        card: elevated.into(),
        accent: accent.into(),
        on_accent: "#000000".into(),
    }
}

// --- Colour maths ---

pub fn parse_hex(hex: &str) -> Option<Rgb> {
    let digits = hex.trim();
    let digits = digits.strip_prefix('#').unwrap_or(digits);
    if digits.len() != 6 || !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(digits, 16).ok()?;
    Some([
        f64::from((n >> 16) & 255),
        f64::from((n >> 8) & 255),
        f64::from(n & 255),
    ])
}

/// `#rrggbb`, each channel rounded half up and kept within 0..=255.
pub fn to_hex(rgb: Rgb) -> String {
    let c = |v: f64| (v.clamp(0.0, 255.0) + 0.5).floor() as u8;
    format!("#{:02x}{:02x}{:02x}", c(rgb[0]), c(rgb[1]), c(rgb[2]))
}

/// Hue in degrees, saturation and lightness from 0 to 1.
pub fn to_hsl([r, g, b]: Rgb) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

fn from_hsl(h: f64, s: f64, l: f64) -> Rgb {
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
    [(r + m) * 255.0, (g + m) * 255.0, (b + m) * 255.0]
}

fn luminance([r, g, b]: Rgb) -> f64 {
    let channel = |c: f64| {
        let v = c / 255.0;
        if v <= 0.03928 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// WCAG contrast ratio between two colours.
pub fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// Contrast between two `#rrggbb` colours (an unreadable one counts as black).
pub fn contrast_hex(a: &str, b: &str) -> f64 {
    contrast(
        parse_hex(a).unwrap_or_default(),
        parse_hex(b).unwrap_or_default(),
    )
}

/// How far apart two hues are, in degrees (0 to 180).
pub fn hue_distance(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

// --- The palette ---

const HUE_BINS: usize = 24;
/// Under this share of coloured pixels, a cover counts as black and white.
const MIN_COLOURED: f64 = 0.06;
/// The accent must cover at least this much of the cover: a speck of colour is not its colour.
const MIN_ACCENT: f64 = 0.02;
/// A second colour must cover this much, and be this far in hue from the base.
const MIN_SECOND: f64 = 0.05;
const SECOND_HUE_GAP: f64 = 45.0;
/// Another colour takes the controls only if it is this colourful (saturation times brightness, on average).
const OTHER_ACCENT_VIVID: f64 = 0.35;

#[derive(Debug, Clone, Copy, Default)]
struct Bin {
    count: f64,
    weight: f64,
    r: f64,
    g: f64,
    b: f64,
    vivid: f64,
}

#[derive(Debug, Clone, Copy)]
struct Group {
    share: f64,
    vivid: f64,
    rgb: Rgb,
    hue: f64,
}

/// The item with the largest key, the first on a tie (as JavaScript's `reduce` with a strict `>`).
fn first_max_by<'a>(
    items: impl Iterator<Item = &'a Group>,
    key: impl Fn(&Group) -> f64,
) -> Option<&'a Group> {
    let mut best: Option<&Group> = None;
    for g in items {
        if best.is_none_or(|b| key(g) > key(b)) {
            best = Some(g);
        }
    }
    best
}

/// The palette of a cover from its pixels (r, g, b, r, g, b, ...: a 32 by 32 copy is plenty). Coloured pixels are
/// grouped by hue; the base is the group that is both large and colourful, the accent the most vivid group that is
/// not a speck, the second colour the strongest group well away from the base in hue. `None` for no pixels.
pub fn palette_from(pixels: &[u8]) -> Option<Palette> {
    let total = pixels.len() / 3;
    if total == 0 {
        return None;
    }
    let mut bins = [Bin::default(); HUE_BINS];
    let mut coloured = 0usize;
    let mut grey_sum = [0.0f64; 3];
    let (whole, _) = pixels.as_chunks::<3>();
    for px in whole {
        let rgb = [f64::from(px[0]), f64::from(px[1]), f64::from(px[2])];
        let max = rgb[0].max(rgb[1]).max(rgb[2]) / 255.0;
        let min = rgb[0].min(rgb[1]).min(rgb[2]) / 255.0;
        // HSV: how coloured (saturation) and how bright (value) the pixel is.
        let value = max;
        let saturation = if max == 0.0 { 0.0 } else { (max - min) / max };
        if saturation < 0.2 || value < 0.15 {
            for (sum, c) in grey_sum.iter_mut().zip(rgb) {
                *sum += c;
            }
            continue;
        }
        coloured += 1;
        let bin =
            &mut bins[((to_hsl(rgb).0 / (360.0 / HUE_BINS as f64)).floor() as usize) % HUE_BINS];
        let w = 0.05 + saturation * value;
        bin.count += 1.0;
        bin.weight += w;
        bin.r += rgb[0] * w;
        bin.g += rgb[1] * w;
        bin.b += rgb[2] * w;
        bin.vivid += saturation * value;
    }
    let greys = (total - coloured).max(1) as f64;
    let grey = grey_sum.map(|s| s / greys);

    // Each hue with its two neighbours: one colour often straddles two bins.
    let groups: Vec<Group> = (0..HUE_BINS)
        .map(|i| {
            let near = [
                bins[(i + HUE_BINS - 1) % HUE_BINS],
                bins[i],
                bins[(i + 1) % HUE_BINS],
            ];
            let sum = |f: fn(&Bin) -> f64| near.iter().map(f).sum::<f64>();
            let (count, weight) = (sum(|b| b.count), sum(|b| b.weight));
            let rgb = if weight > 0.0 {
                [
                    sum(|b| b.r) / weight,
                    sum(|b| b.g) / weight,
                    sum(|b| b.b) / weight,
                ]
            } else {
                [0.0; 3]
            };
            Group {
                share: count / total as f64,
                vivid: if count > 0.0 {
                    sum(|b| b.vivid) / count
                } else {
                    0.0
                },
                rgb,
                hue: to_hsl(rgb).0,
            }
        })
        .collect();

    let striking = |g: &Group| g.vivid * g.share.sqrt();
    let accent_group = first_max_by(groups.iter().filter(|g| g.share >= MIN_ACCENT), striking);

    if (coloured as f64) / (total as f64) < MIN_COLOURED {
        return Some(Palette {
            base: grey,
            accent: accent_group.map(|g| g.rgb),
            second: None,
            grey: true,
        });
    }

    let score = |g: &Group| g.share * (0.25 + g.vivid);
    let base = first_max_by(groups.iter(), score).expect("there are always 24 groups");
    let second = first_max_by(
        groups
            .iter()
            .filter(|g| g.share >= MIN_SECOND && hue_distance(g.hue, base.hue) >= SECOND_HUE_GAP),
        score,
    );
    // The controls stand out in another of the cover's colours when it has a colourful one (a yellow sun on a teal
    // sky makes yellow buttons on teal), and in its own colour otherwise.
    let other = first_max_by(
        groups.iter().filter(|g| {
            g.share >= MIN_ACCENT
                && g.vivid >= OTHER_ACCENT_VIVID
                && hue_distance(g.hue, base.hue) >= SECOND_HUE_GAP
        }),
        striking,
    );
    let accent = other.or(accent_group).unwrap_or(base);
    Some(Palette {
        base: base.rgb,
        accent: Some(accent.rgb),
        second: second.map(|g| g.rgb),
        grey: false,
    })
}

/// A palette from the one colour an older build gives ("#rrggbb"): no second colour, the accent the base itself.
pub fn palette_from_color(hex: Option<&str>) -> Option<Palette> {
    let rgb = parse_hex(hex?)?;
    let grey = to_hsl(rgb).1 < 0.1;
    Some(Palette {
        base: rgb,
        accent: (!grey).then_some(rgb),
        second: None,
        grey,
    })
}

// --- The screen's colours ---

/// The top of the backdrop is never brighter than this (relative luminance): white text and the controls need room.
const MAX_TOP_LUMINANCE: f64 = 0.1;
const WHITE: Rgb = [255.0, 255.0, 255.0];
const BLACK: Rgb = [0.0, 0.0, 0.0];

/// Turns a palette into the screen's colours. The hues are the cover's; the saturation is held in a band and the
/// lightness is set: a dark gradient white text reads on, a lyrics card lifted just far enough to stay readable,
/// and an accent bright enough to stand out against the backdrop. A black and white cover gets greys and white
/// controls. No palette: `plain`.
pub fn look_for(palette: Option<&Palette>, plain: &Look) -> Look {
    let Some(palette) = palette else {
        return plain.clone();
    };
    let (h, s, _) = to_hsl(palette.base);
    let sat = if palette.grey {
        0.0
    } else {
        s.clamp(0.3, 0.75)
    };

    let mut card_lightness = 0.38;
    let mut card = from_hsl(h, sat * 0.8, card_lightness);
    while contrast(card, WHITE) < 4.6 && card_lightness > 0.14 {
        card_lightness -= 0.02;
        card = from_hsl(h, sat * 0.8, card_lightness);
    }

    // Yellows and greens are bright at any lightness: those go darker, so the title and controls still stand out.
    let mut top_lightness = 0.3;
    let mut top = from_hsl(h, sat * 0.9, top_lightness);
    while luminance(top) > MAX_TOP_LUMINANCE && top_lightness > 0.16 {
        top_lightness -= 0.02;
        top = from_hsl(h, sat * 0.9, top_lightness);
    }

    let glow = palette.second.filter(|_| !palette.grey).map(|second| {
        let (h2, s2, _) = to_hsl(second);
        to_hex(from_hsl(h2, s2.clamp(0.35, 0.8), 0.42))
    });

    let accent = match palette.accent {
        Some(a) if to_hsl(a).1 >= 0.15 => {
            let (ha, sa, _) = to_hsl(a);
            let saturation = sa.clamp(0.5, 0.95);
            let mut lightness = 0.6;
            let mut accent = from_hsl(ha, saturation, lightness);
            // It must stand out against the top of the backdrop (3:1, with a little to spare for the rounding).
            while contrast(accent, top) < 3.1 && lightness < 0.85 {
                lightness += 0.03;
                accent = from_hsl(ha, saturation, lightness);
            }
            accent
        }
        _ => [242.0, 242.0, 242.0],
    };
    let on_accent = if contrast(accent, BLACK) >= contrast(accent, WHITE) {
        "#000000"
    } else {
        "#ffffff"
    };

    Look {
        top: to_hex(top),
        middle: to_hex(from_hsl(h, sat * 0.75, 0.16)),
        bottom: to_hex(from_hsl(h, sat * 0.6, 0.075)),
        glow,
        card: to_hex(card),
        accent: to_hex(accent),
        on_accent: on_accent.into(),
    }
}

// Ported from mobile/tests/palette.test.js (the palette and the screen's colours; reading covers is the app's).
#[cfg(test)]
mod tests {
    use super::*;

    /// A 32 by 32 cover made of colours in the given shares, as the native side sends it.
    fn cover(parts: &[([u8; 3], f64)]) -> Vec<u8> {
        let total = 32 * 32;
        let mut out = Vec::new();
        let mut used = 0;
        for (i, (rgb, share)) in parts.iter().enumerate() {
            let n = if i == parts.len() - 1 {
                total - used
            } else {
                (total as f64 * share + 0.5).floor() as usize
            };
            used += n;
            for _ in 0..n {
                out.extend_from_slice(rgb);
            }
        }
        out
    }

    fn rgb(c: [u8; 3]) -> Rgb {
        c.map(f64::from)
    }

    fn hue(c: Rgb) -> f64 {
        to_hsl(c).0
    }

    fn hex_hsl(hex: &str) -> (f64, f64, f64) {
        to_hsl(parse_hex(hex).unwrap())
    }

    fn near(a: f64, b: f64, tolerance: f64) -> bool {
        hue_distance(a, b) <= tolerance
    }

    const RED: [u8; 3] = [200, 30, 40];
    const TEAL: [u8; 3] = [31, 138, 158];
    const YELLOW: [u8; 3] = [242, 209, 107];
    const BLACK8: [u8; 3] = [8, 8, 10];
    const WHITE8: [u8; 3] = [245, 245, 245];
    const GREY8: [u8; 3] = [120, 120, 122];

    fn plain() -> Look {
        plain_look("#181818", "#121212", "#0a0a0a", "#1DB954")
    }

    #[test]
    fn a_red_cover_is_red_with_no_second_colour() {
        let p = palette_from(&cover(&[(RED, 0.8), (BLACK8, 0.1), (WHITE8, 0.1)])).unwrap();
        assert!(!p.grey);
        assert!(near(hue(p.base), 355.0, 12.0));
        assert!(near(hue(p.accent.unwrap()), 355.0, 12.0));
        assert_eq!(p.second, None);
    }

    #[test]
    fn a_teal_cover_with_a_yellow_sun_has_yellow_controls_and_second_colour() {
        let p = palette_from(&cover(&[(TEAL, 0.65), (YELLOW, 0.3), (WHITE8, 0.05)])).unwrap();
        assert!(near(hue(p.base), hue(rgb(TEAL)), 12.0));
        assert!(near(hue(p.second.unwrap()), hue(rgb(YELLOW)), 12.0));
        assert!(near(hue(p.accent.unwrap()), hue(rgb(YELLOW)), 12.0));
    }

    #[test]
    fn a_dull_second_colour_does_not_take_the_controls() {
        let brown = [90, 70, 60];
        let p = palette_from(&cover(&[(TEAL, 0.6), (brown, 0.35), (WHITE8, 0.05)])).unwrap();
        assert!(near(hue(p.second.unwrap()), hue(rgb(brown)), 15.0));
        assert!(near(hue(p.accent.unwrap()), hue(rgb(TEAL)), 12.0));
    }

    #[test]
    fn a_dull_cover_with_a_bright_patch_has_the_bright_one_as_controls() {
        let (olive, magenta) = ([100, 104, 70], [235, 30, 200]);
        let p = palette_from(&cover(&[(olive, 0.75), (magenta, 0.12), (BLACK8, 0.13)])).unwrap();
        assert!(near(hue(p.base), hue(rgb(olive)), 15.0));
        assert!(near(hue(p.accent.unwrap()), hue(rgb(magenta)), 12.0));
        assert!(near(hue(p.second.unwrap()), hue(rgb(magenta)), 12.0));
    }

    #[test]
    fn a_gradient_in_two_shades_is_one_colour_and_reds_across_the_top_of_the_wheel_too() {
        let (sky, deep, orange) = ([40, 130, 220], [40, 60, 210], [230, 120, 30]);
        assert_ne!(
            (hue(rgb(sky)) / 15.0).floor(),
            (hue(rgb(deep)) / 15.0).floor()
        );
        let p = palette_from(&cover(&[(sky, 0.3), (deep, 0.3), (orange, 0.4)])).unwrap();
        assert!(near(hue(p.base), 220.0, 15.0));
        assert!(near(hue(p.second.unwrap()), hue(rgb(orange)), 12.0));
        let (crimson, vermilion) = ([210, 20, 60], [215, 50, 15]);
        let p = palette_from(&cover(&[(crimson, 0.45), (vermilion, 0.45), (BLACK8, 0.1)])).unwrap();
        assert_eq!(p.second, None);
    }

    #[test]
    fn a_speck_is_not_the_accent_and_black_and_white_is_grey() {
        let (blue, green) = ([30, 60, 200], [20, 230, 40]);
        let p = palette_from(&cover(&[(blue, 0.9), (green, 0.01), (BLACK8, 0.09)])).unwrap();
        assert!(near(hue(p.accent.unwrap()), hue(rgb(blue)), 12.0));
        assert_eq!(p.second, None);
        let p = palette_from(&cover(&[(BLACK8, 0.5), (WHITE8, 0.3), (GREY8, 0.2)])).unwrap();
        assert!(p.grey && p.accent.is_none() && p.second.is_none());
        let p = palette_from(&cover(&[(BLACK8, 0.96), (RED, 0.04)])).unwrap();
        assert!(p.grey);
        assert!(p.base.iter().all(|c| *c < 40.0));
        assert!(near(hue(p.accent.unwrap()), 355.0, 12.0));
        assert_eq!(palette_from(&[]), None);
        assert_eq!(palette_from(&[1, 2]), None);
    }

    #[test]
    fn the_one_colour_of_an_older_build_makes_a_palette() {
        assert_eq!(
            palette_from_color(Some("#c81e28")),
            Some(Palette {
                base: [200.0, 30.0, 40.0],
                accent: Some([200.0, 30.0, 40.0]),
                second: None,
                grey: false
            })
        );
        let grey = palette_from_color(Some("#7a7a7a")).unwrap();
        assert!(grey.grey && grey.accent.is_none());
        assert_eq!(palette_from_color(None), None);
        assert_eq!(palette_from_color(Some("nonsense")), None);
    }

    #[test]
    fn the_screen_keeps_the_cover_hues() {
        let p = palette_from(&cover(&[(TEAL, 0.65), (YELLOW, 0.3), (WHITE8, 0.05)])).unwrap();
        let look = look_for(Some(&p), &plain());
        for c in [&look.top, &look.middle, &look.bottom, &look.card] {
            assert!(near(hex_hsl(c).0, hue(p.base), 8.0), "{c}");
        }
        assert!(near(
            hex_hsl(look.glow.as_ref().unwrap()).0,
            hue(p.second.unwrap()),
            8.0
        ));
        assert!(near(hex_hsl(&look.accent).0, hue(p.accent.unwrap()), 8.0));
    }

    #[test]
    fn a_faint_colour_still_tints_and_a_garish_one_is_toned_down() {
        let faint = palette_from(&cover(&[([150, 120, 110], 1.0)])).unwrap();
        assert!(!faint.grey && to_hsl(faint.base).1 < 0.2);
        assert!(hex_hsl(&look_for(Some(&faint), &plain()).top).1 >= 0.25);
        let garish = look_for(
            Some(&palette_from(&cover(&[([255, 0, 0], 1.0)])).unwrap()),
            &plain(),
        );
        assert!(hex_hsl(&garish.top).1 <= 0.7);
    }

    #[test]
    fn the_backdrop_darkens_from_the_top_and_stays_tinted() {
        let look = look_for(
            Some(&palette_from(&cover(&[(RED, 0.9), (BLACK8, 0.1)])).unwrap()),
            &plain(),
        );
        let l = |c: &str| hex_hsl(c).2;
        assert!(l(&look.top) > l(&look.middle) && l(&look.middle) > l(&look.bottom));
        assert!(hex_hsl(&look.bottom).1 > 0.2);
    }

    #[test]
    fn whatever_the_cover_text_and_controls_stay_readable() {
        let mut seed: u64 = 7;
        let mut random = || {
            seed = (seed * 16807) % 2_147_483_647;
            seed as f64 / 2_147_483_647.0
        };
        for _ in 0..400 {
            let mut colour = || {
                [
                    (random() * 256.0) as u8,
                    (random() * 256.0) as u8,
                    (random() * 256.0) as u8,
                ]
            };
            let p = palette_from(&cover(&[(colour(), 0.5), (colour(), 0.3), (colour(), 0.2)]));
            let look = look_for(p.as_ref(), &plain());
            let white = "#ffffff";
            assert!(
                contrast_hex(white, &look.top) >= 3.0,
                "title on {}",
                look.top
            );
            assert!(hex_hsl(&look.top).2 <= 0.31, "dark top {}", look.top);
            assert!(
                contrast_hex(white, &look.middle) >= 7.0,
                "text on {}",
                look.middle
            );
            assert!(
                contrast_hex(white, &look.card) >= 4.5,
                "lyrics on {}",
                look.card
            );
            assert!(
                contrast_hex(&look.accent, &look.top) >= 3.0,
                "{} on {}",
                look.accent,
                look.top
            );
            assert!(contrast_hex(&look.on_accent, &look.accent) >= 4.5);
        }
    }

    #[test]
    fn black_and_white_gets_greys_and_white_controls_a_red_logo_red_ones() {
        let look = look_for(
            Some(&palette_from(&cover(&[(BLACK8, 0.6), (WHITE8, 0.4)])).unwrap()),
            &plain(),
        );
        for c in [&look.top, &look.middle, &look.bottom, &look.card] {
            assert!(hex_hsl(c).1 < 0.02, "{c}");
        }
        assert_eq!(
            (look.glow, look.accent.as_str(), look.on_accent.as_str()),
            (None, "#f2f2f2", "#000000")
        );
        let logo = look_for(
            Some(&palette_from(&cover(&[(BLACK8, 0.96), (RED, 0.04)])).unwrap()),
            &plain(),
        );
        assert!(hex_hsl(&logo.top).1 < 0.02);
        assert!(near(hex_hsl(&logo.accent).0, 355.0, 12.0) && hex_hsl(&logo.accent).1 > 0.4);
        assert_eq!(look_for(None, &plain()), plain());
    }
}
