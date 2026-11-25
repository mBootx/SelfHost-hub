//! Whether a server's address is one only the home network can reach.
//!
//! Port of `wear/core/.../PrivateAddress.kt`. It decides which connection the watch uses for Navidrome: a watch
//! often reaches the internet through the phone over Bluetooth, and a socket opened that way may never reach
//! `192.168.x.x`, so for home addresses the watch binds its connection to its own Wi-Fi.
//!
//! Not the same rule as [`crate::pairing::is_private_address`], which vets the peers of the PC's hub: this one
//! takes host names, and counts dotless names and home suffixes as home, but not loopback.

const HOME_SUFFIXES: [&str; 5] = [".local", ".lan", ".home", ".home.arpa", ".internal"];

/// A private IPv4 address, a link-local or unique-local IPv6 one, a name without a dot or ending in `.local`,
/// `.lan`, `.home` and the like.
pub fn is_home_host(host: &str) -> bool {
    let trimmed = host.trim();
    let unbracketed = trimmed.strip_prefix('[').unwrap_or(trimmed);
    let unbracketed = unbracketed.strip_suffix(']').unwrap_or(unbracketed);
    let name = unbracketed.to_lowercase();
    if name.is_empty() {
        return false;
    }
    if let Some((a, b)) = ipv4_first_two(&name) {
        return a == 10
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 169 && b == 254);
    }
    if name.contains(':') {
        return name.starts_with("fc") || name.starts_with("fd") || name.starts_with("fe80");
    }
    !name.contains('.') || HOME_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// The first two numbers of a dotted IPv4 address, or `None` when `text` is not one.
fn ipv4_first_two(text: &str) -> Option<(i32, i32)> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut numbers = [0i32; 4];
    for (slot, part) in numbers.iter_mut().zip(&parts) {
        *slot = part.parse().ok().filter(|n| (0..=255).contains(n))?;
    }
    Some((numbers[0], numbers[1]))
}

// Ported from PrivateAddressTest in wear/core/src/test/kotlin/com/selfhosthub/wear/core/SetupAndNetworkTest.kt.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_network_addresses_are_private() {
        for host in [
            "192.168.1.20",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.254",
            "169.254.3.4",
            "[fd12:3456::1]",
            "fe80::1",
            "navidrome",
            "nas.local",
            "musique.lan",
            "box.home.arpa",
        ] {
            assert!(is_home_host(host), "{host}");
        }
    }

    #[test]
    fn addresses_of_the_internet_are_not() {
        for host in [
            "music.example.org",
            "8.8.8.8",
            "172.32.0.1",
            "172.15.0.1",
            "192.169.1.1",
            "11.0.0.1",
            "100.64.0.1",
            "2001:db8::1",
            "example.com",
        ] {
            assert!(!is_home_host(host), "{host}");
        }
    }

    #[test]
    fn nothing_is_not_an_address() {
        assert!(!is_home_host(""));
        assert!(!is_home_host("  "));
    }

    #[test]
    fn numbers_that_are_not_an_ipv4_address_do_not_pass_for_one() {
        assert!(!is_home_host("192.168.1.300.example.org"));
        assert!(!is_home_host("10.0.0.256.com"));
    }
}
