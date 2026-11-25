//! TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s step) for the admin terminal, plus the QR code of the setup.

use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;

pub const STEP_SECS: u64 = 30;
pub const DIGITS: u32 = 6;
pub const SECRET_BYTES: usize = 20;
const ISSUER: &str = "SelfHost Hub";

/// HOTP (RFC 4226) with `digits` digits.
pub fn hotp(key: &[u8], counter: u64, digits: u32) -> u32 {
    let mut mac = <Hmac<Sha1> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let off = (h[h.len() - 1] & 0x0f) as usize;
    let bin = u32::from_be_bytes([h[off] & 0x7f, h[off + 1], h[off + 2], h[off + 3]]);
    bin % 10u32.pow(digits)
}

/// RFC 6238 code at unix time `t` for a step of `step` seconds.
pub fn totp_at(key: &[u8], t: u64, step: u64, digits: u32) -> u32 {
    hotp(key, t / step, digits)
}

pub fn new_secret() -> [u8; SECRET_BYTES] {
    let mut s = [0u8; SECRET_BYTES];
    getrandom::fill(&mut s).expect("system randomness");
    s
}

pub fn encode_secret(secret: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(secret)
}

pub fn decode_secret(text: &str) -> Option<Vec<u8>> {
    data_encoding::BASE32_NOPAD.decode(text.trim().to_ascii_uppercase().as_bytes()).ok()
}

/// "123 456" and "123456" are both fine; anything but six digits is not a code.
pub fn parse_code(text: &str) -> Option<u32> {
    let digits: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if digits.len() == DIGITS as usize && digits.bytes().all(|b| b.is_ascii_digit()) { digits.parse().ok() } else { None }
}

/// The time step of `code` within +-1 step of `now` (unix seconds), if it matches. Does not look at reuse:
/// the caller refuses a step that is not newer than the last accepted one.
pub fn verify(secret: &[u8], code: u32, now: u64) -> Option<u64> {
    let current = now / STEP_SECS;
    let mut found = None;
    // No early exit: every candidate is computed whatever the code is.
    for step in current.saturating_sub(1)..=current + 1 {
        let expected = hotp(secret, step, DIGITS);
        if (expected ^ code) == 0 && found.is_none() {
            found = Some(step);
        }
    }
    found
}

fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `otpauth://totp/SelfHost%20Hub:<user>?secret=..&issuer=SelfHost%20Hub`
pub fn otpauth_uri(user: &str, secret_b32: &str) -> String {
    let issuer = pct(ISSUER);
    format!("otpauth://totp/{issuer}:{}?secret={secret_b32}&issuer={issuer}", pct(user))
}

/// The QR code of `text` as a standalone SVG document, or `None` when it does not fit.
pub fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    // Drop the XML declaration so the string is just the <svg> element.
    Some(svg.find("<svg").map_or(svg.clone(), |i| svg[i..].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 appendix B: the SHA-1 secret is "12345678901234567890"; the RFC lists 8 digits.
    const SECRET: &[u8] = b"12345678901234567890";

    #[test]
    fn rfc_6238_vectors() {
        for (t, code) in [
            (59u64, 94287082u32),
            (1111111109, 7081804),
            (1111111111, 14050471),
            (1234567890, 89005924),
            (2000000000, 69279037),
            (20000000000, 65353130),
        ] {
            assert_eq!(totp_at(SECRET, t, 30, 8), code, "t={t}");
            // The 6 digit code is the last 6 digits of the 8 digit one.
            assert_eq!(totp_at(SECRET, t, 30, 6), code % 1_000_000, "t={t} (6 digits)");
        }
    }

    #[test]
    fn rfc_4226_vectors() {
        let expected = [755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489];
        for (i, e) in expected.iter().enumerate() {
            assert_eq!(hotp(SECRET, i as u64, 6), *e);
        }
    }

    #[test]
    fn verify_window_is_one_step_each_side() {
        let now = 1_700_000_015;
        let step = now / 30;
        for (s, ok) in [(step - 2, false), (step - 1, true), (step, true), (step + 1, true), (step + 2, false)] {
            let code = hotp(SECRET, s, 6);
            assert_eq!(verify(SECRET, code, now), ok.then_some(s), "step offset {}", s as i64 - step as i64);
        }
        assert_eq!(verify(SECRET, (hotp(SECRET, step, 6) + 1) % 1_000_000, now), None);
    }

    #[test]
    fn code_parsing() {
        assert_eq!(parse_code("012345"), Some(12345));
        assert_eq!(parse_code(" 123 456 "), Some(123456));
        for bad in ["", "12345", "1234567", "12345a", "+12345", "١٢٣٤٥٦"] {
            assert_eq!(parse_code(bad), None, "{bad}");
        }
    }

    #[test]
    fn secret_round_trip_and_uri() {
        let s = new_secret();
        let b32 = encode_secret(&s);
        assert_eq!(b32.len(), 32);
        assert_eq!(decode_secret(&b32).unwrap(), s);
        assert_eq!(decode_secret(&b32.to_ascii_lowercase()).unwrap(), s);
        assert_eq!(
            otpauth_uri("max b", "ABC"),
            "otpauth://totp/SelfHost%20Hub:max%20b?secret=ABC&issuer=SelfHost%20Hub"
        );
    }

    #[test]
    fn qr_is_an_svg() {
        let svg = qr_svg(&otpauth_uri("root", &encode_secret(&new_secret()))).unwrap();
        assert!(svg.starts_with("<svg") && svg.contains("</svg>"));
    }
}
