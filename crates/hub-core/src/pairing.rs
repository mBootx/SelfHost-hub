//! How a phone proves to the PC's remote-control hub that it belongs to its owner.
//!
//! Port of `src/main/pairing.ts` (the PC's side) and of `proofFor` in `mobile/src/services/remoteControl.ts`
//! (the phone's side). The PC makes a random pairing code once and shows it in its settings; the code is typed
//! once on the phone. After that the phone never sends the code: it answers each fresh challenge with a keyed
//! hash, so someone watching the network learns nothing they could reuse, and a PC that is not the right one
//! learns nothing either.

use std::collections::HashMap;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// No I, O, 0 or 1: nobody should have to guess which one is on the screen.
pub const CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Ten characters of 32: about 50 bits.
pub const CODE_LENGTH: usize = 10;

/// A new random pairing code.
pub fn generate_code() -> String {
    let mut bytes = [0u8; CODE_LENGTH];
    fill_random(&mut bytes);
    code_from_bytes(&bytes)
}

/// The code for these random bytes. 256 is a multiple of the alphabet's 32 letters, so every letter is as likely.
pub fn code_from_bytes(bytes: &[u8; CODE_LENGTH]) -> String {
    let alphabet = CODE_ALPHABET.as_bytes();
    bytes
        .iter()
        .map(|b| alphabet[usize::from(*b) % alphabet.len()] as char)
        .collect()
}

/// "ABCDEFGHJK" as shown to the user: "ABCDE-FGHJK".
pub fn format_code(code: &str) -> String {
    let half = CODE_LENGTH / 2;
    let first: String = code.chars().take(half).collect();
    let rest: String = code.chars().skip(half).collect();
    format!("{first}-{rest}")
}

/// What was typed, reduced to the code's own alphabet: case, spaces and dashes don't matter.
pub fn normalize_code(input: &str) -> String {
    input
        .to_uppercase()
        .chars()
        .filter(|c| CODE_ALPHABET.contains(*c))
        .collect()
}

/// The answer to a challenge: HMAC-SHA256 keyed with the code over `"<nonce>|<device id>"`, in lowercase hex.
pub fn proof_for(code: &str, nonce: &str, device_id: &str) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(code.as_bytes())
        .expect("HMAC accepts keys of any length");
    mac.update(nonce.as_bytes());
    mac.update(b"|");
    mac.update(device_id.as_bytes());
    to_hex(&mac.finalize().into_bytes())
}

/// Whether `proof` answers the challenge, compared in constant time.
pub fn proof_matches(code: &str, nonce: &str, device_id: &str, proof: &str) -> bool {
    let expected = proof_for(code, nonce, device_id);
    expected.as_bytes().ct_eq(proof.as_bytes()).into()
}

/// A fresh challenge: 16 random bytes in hex.
pub fn new_nonce() -> String {
    let mut bytes = [0u8; 16];
    fill_random(&mut bytes);
    to_hex(&bytes)
}

/// Names a PC to the phones paired with it (not a secret): 12 random bytes in hex.
pub fn new_hub_id() -> String {
    let mut bytes = [0u8; 12];
    fill_random(&mut bytes);
    to_hex(&bytes)
}

/// Home-network addresses only: private ranges, link-local and loopback. Anything else is the internet.
///
/// Takes the address as the socket layer prints it, IPv4-mapped IPv6 (`::ffff:192.168.0.5`) included.
pub fn is_private_address(address: &str) -> bool {
    if address.is_empty() {
        return false;
    }
    let lower = address.to_lowercase();
    let ip = lower.strip_prefix("::ffff:").unwrap_or(&lower);

    if let Some([a, b]) = ipv4_first_two(ip) {
        return a == 10
            || a == 127
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 169 && b == 254);
    }
    if ip == "::1" {
        return true;
    }
    // Unique local fc00::/7 and link-local fe80::/10, as the first group of four hex digits.
    let bytes = ip.as_bytes();
    let hex = |c: u8| c.is_ascii_hexdigit();
    let unique_local = bytes.len() >= 5
        && bytes[0] == b'f'
        && matches!(bytes[1], b'c' | b'd')
        && hex(bytes[2])
        && hex(bytes[3])
        && bytes[4] == b':';
    let link_local = bytes.len() >= 5
        && bytes[0] == b'f'
        && bytes[1] == b'e'
        && matches!(bytes[2], b'8' | b'9' | b'a' | b'b')
        && hex(bytes[3])
        && bytes[4] == b':';
    unique_local || link_local
}

/// The first two numbers of a dotted IPv4 address of four groups of one to three digits.
/// Like the TypeScript original, the groups are not checked against 255.
fn ipv4_first_two(ip: &str) -> Option<[u32; 2]> {
    let groups: Vec<&str> = ip.split('.').collect();
    if groups.len() != 4
        || groups
            .iter()
            .any(|g| g.is_empty() || g.len() > 3 || !g.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some([groups[0].parse().ok()?, groups[1].parse().ok()?])
}

#[derive(Debug, Clone, Copy)]
struct AttemptRecord {
    failures: u32,
    since_ms: u64,
    blocked_until_ms: u64,
}

/// Keeps someone from guessing the code: after too many wrong proofs from one address, that address is ignored
/// for a while. A right proof clears its record. Times are milliseconds on any steady clock.
#[derive(Debug, Clone)]
pub struct AttemptLimiter {
    max_failures: u32,
    window_ms: u64,
    block_ms: u64,
    records: HashMap<String, AttemptRecord>,
}

impl Default for AttemptLimiter {
    /// Five wrong proofs within ten minutes block the address for ten minutes.
    fn default() -> Self {
        Self::new(5, 10 * 60_000, 10 * 60_000)
    }
}

impl AttemptLimiter {
    pub fn new(max_failures: u32, window_ms: u64, block_ms: u64) -> Self {
        Self {
            max_failures,
            window_ms,
            block_ms,
            records: HashMap::new(),
        }
    }

    pub fn is_blocked(&self, address: &str, now_ms: u64) -> bool {
        self.records
            .get(address)
            .is_some_and(|r| r.blocked_until_ms > now_ms)
    }

    pub fn record_failure(&mut self, address: &str, now_ms: u64) {
        let fresh = AttemptRecord {
            failures: 0,
            since_ms: now_ms,
            blocked_until_ms: 0,
        };
        let mut record = match self.records.get(address) {
            Some(r) if now_ms.saturating_sub(r.since_ms) <= self.window_ms => *r,
            _ => fresh,
        };
        record.failures += 1;
        if record.failures >= self.max_failures {
            record.blocked_until_ms = now_ms + self.block_ms;
        }
        self.records.insert(address.to_owned(), record);
    }

    pub fn record_success(&mut self, address: &str) {
        self.records.remove(address);
    }
}

fn fill_random(bytes: &mut [u8]) {
    getrandom::fill(bytes).expect("the operating system's random generator is unavailable");
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

// Ported from mobile/tests/remote.test.js (the pairing helpers; the socket tests move with the hub server).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_use_the_safe_alphabet_read_well_and_forgive_typing() {
        let code = generate_code();
        assert_eq!(code.len(), CODE_LENGTH);
        assert!(code.chars().all(|c| CODE_ALPHABET.contains(c)), "{code}");
        assert_ne!(generate_code(), generate_code());
        assert_eq!(format_code("ABCDEFGHJK"), "ABCDE-FGHJK");
        assert_eq!(normalize_code(" abcde-fghjk "), "ABCDEFGHJK");
        assert_eq!(
            normalize_code("0O1Iabc"),
            "ABC",
            "lookalikes that are not in the alphabet are dropped"
        );
    }

    #[test]
    fn every_letter_of_the_alphabet_can_come_out() {
        let mut bytes = [0u8; CODE_LENGTH];
        let mut seen = String::new();
        for start in (0u8..32).step_by(CODE_LENGTH) {
            for (i, b) in bytes.iter_mut().enumerate() {
                *b = start + i as u8 + 32 * 3;
            }
            seen.push_str(&code_from_bytes(&bytes));
        }
        assert!(CODE_ALPHABET.chars().all(|c| seen.contains(c)), "{seen}");
    }

    #[test]
    fn the_proof_is_standard_hmac_sha256() {
        // Computed independently with .NET's HMACSHA256: key "ABCDEFGHJK", message "n0nce|dev-1".
        assert_eq!(
            proof_for("ABCDEFGHJK", "n0nce", "dev-1"),
            "600074a13c4af0411239f60e31cbfd59255ce825ceafc136a270f88e89de1387"
        );
    }

    #[test]
    fn a_proof_is_bound_to_its_nonce_and_device() {
        let code = "ABCDEFGHJK";
        assert_ne!(
            proof_for(code, "n0nce", "dev-1"),
            proof_for(code, "other", "dev-1")
        );
        assert_ne!(
            proof_for(code, "n0nce", "dev-1"),
            proof_for(code, "n0nce", "dev-2")
        );
        assert!(proof_matches(code, "n", "d", &proof_for(code, "n", "d")));
        assert!(!proof_matches(code, "n", "d", "nope"));
        assert!(!proof_matches(code, "n", "d", ""));
    }

    #[test]
    fn nonces_and_hub_ids_are_fresh_hex() {
        let nonce = new_nonce();
        assert_eq!(nonce.len(), 32);
        assert!(nonce.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(new_nonce(), nonce);
        assert_eq!(new_hub_id().len(), 24);
    }

    #[test]
    fn home_network_addresses_are_allowed_the_internet_is_not() {
        for ok in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.9",
            "172.31.255.1",
            "192.168.1.42",
            "169.254.3.4",
            "::1",
            "::ffff:192.168.0.5",
            "fd12:3456::1",
            "fe80::1",
        ] {
            assert!(is_private_address(ok), "{ok}");
        }
        for bad in [
            "8.8.8.8",
            "172.32.0.1",
            "172.15.0.1",
            "192.169.0.1",
            "2001:db8::1",
            "::ffff:8.8.8.8",
            "",
            "garbage",
        ] {
            assert!(!is_private_address(bad), "{bad}");
        }
    }

    #[test]
    fn the_limiter_blocks_after_five_wrong_guesses_and_forgives_after_a_while() {
        let mut limiter = AttemptLimiter::new(5, 600_000, 600_000);
        let t = 1_000_000;
        for i in 0..4 {
            limiter.record_failure("10.0.0.9", t + i);
        }
        assert!(!limiter.is_blocked("10.0.0.9", t + 10));
        limiter.record_failure("10.0.0.9", t + 5);
        assert!(limiter.is_blocked("10.0.0.9", t + 6));
        assert!(
            !limiter.is_blocked("10.0.0.8", t + 6),
            "other addresses are not affected"
        );
        assert!(
            !limiter.is_blocked("10.0.0.9", t + 600_006),
            "the block ends"
        );
        limiter.record_failure("10.0.0.7", t);
        limiter.record_success("10.0.0.7");
        for i in 0..4 {
            limiter.record_failure("10.0.0.7", t + i);
        }
        assert!(
            !limiter.is_blocked("10.0.0.7", t + 5),
            "a success starts the count again"
        );
    }

    #[test]
    fn old_failures_outside_the_window_do_not_count() {
        let mut limiter = AttemptLimiter::new(2, 1_000, 5_000);
        limiter.record_failure("10.0.0.1", 0);
        limiter.record_failure("10.0.0.1", 2_000);
        assert!(!limiter.is_blocked("10.0.0.1", 2_001));
    }
}
