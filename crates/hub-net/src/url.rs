//! The little URL handling the clients need, without a URL crate.

/// A query string component, percent-encoded: only `A-Z a-z 0-9 - . _ ~` are left as they are.
pub(crate) fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// JavaScript's `encodeURIComponent`: also leaves `! * ' ( )` as they are. Used where a server decodes exactly
/// what the TypeScript apps sent (FileBrowser's `X-Password` header, share tokens).
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'.' | b'_' | b'~' | b'!' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// JavaScript's `decodeURIComponent`, lenient: a broken escape is kept as it is.
pub(crate) fn decode_uri_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"),
                16,
            )
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `key=value&key=value`, every part encoded.
pub(crate) fn query(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .map(|(k, v)| format!("{}={}", encode_component(k), encode_component(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Whether `url` is an http or https address with a host.
pub(crate) fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"));
    rest.is_some_and(|r| !r.is_empty() && !r.starts_with('/') && !r.starts_with(':'))
}

/// The host of an http(s) address: no user, no port, IPv6 brackets kept off.
pub(crate) fn host_of(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://")?.1;
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if let Some(rest) = host_port.strip_prefix('[') {
        return rest.split_once(']').map(|(h, _)| h);
    }
    Some(host_port.split(':').next().unwrap_or(host_port)).filter(|h| !h.is_empty())
}

#[cfg(test)]
pub(crate) fn decode_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_are_encoded_and_decoded_back() {
        let text = "Björk & Sigur Rós/2=3 ?";
        let encoded = encode_component(text);
        assert_eq!(encoded, "Bj%C3%B6rk%20%26%20Sigur%20R%C3%B3s%2F2%3D3%20%3F");
        assert_eq!(decode_component(&encoded), text);
    }

    #[test]
    fn only_http_addresses_with_a_host_pass() {
        assert!(is_http_url("https://music.example.org"));
        assert!(is_http_url("HTTP://nas:4533"));
        assert!(!is_http_url("ftp://a.b"));
        assert!(!is_http_url("https://"));
        assert!(!is_http_url("https://:4533"));
        assert!(!is_http_url("music.example.org"));
    }

    #[test]
    fn the_host_is_found_without_user_port_or_path() {
        assert_eq!(
            host_of("https://music.example.org/rest/ping.view?u=x"),
            Some("music.example.org")
        );
        assert_eq!(host_of("http://localhost:4533"), Some("localhost"));
        assert_eq!(host_of("http://me:pw@nas.local:80/x"), Some("nas.local"));
        assert_eq!(host_of("http://[fd12::1]:4533/x"), Some("fd12::1"));
        assert_eq!(host_of("no scheme"), None);
    }
}
