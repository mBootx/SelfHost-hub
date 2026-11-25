//! Names and paths on the file server: always "/"-separated, whatever the device is.
//!
//! Port of `mobile/src/services/fileNames.ts` and the path helpers of the FileBrowser clients.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// The last part of a path: "/a/b/c.jpg" gives "c.jpg".
pub fn base_name(path: &str) -> &str {
    path.split('/').rfind(|p| !p.is_empty()).unwrap_or_default()
}

/// The folder a path sits in: "/a/b/c.jpg" gives "/a/b", and "/c.jpg" gives "/".
pub fn parent_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    format!("/{}", parts[..parts.len().saturating_sub(1)].join("/"))
}

/// Whether two paths name the same place, ignoring doubled and trailing slashes.
pub fn same_path(a: &str, b: &str) -> bool {
    a.split('/')
        .filter(|p| !p.is_empty())
        .eq(b.split('/').filter(|p| !p.is_empty()))
}

/// A folder and a name made into a path, with no doubled slashes.
pub fn child_path(dir: &str, name: &str) -> String {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    parts.push(name);
    format!("/{}", parts.join("/"))
}

/// Doubled slashes collapsed and the trailing one dropped, the root kept as "/".
pub fn normalize_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if !(c == '/' && out.ends_with('/')) {
            out.push(c);
        }
    }
    if out.len() > 1 {
        while out.ends_with('/') {
            out.pop();
        }
    }
    out
}

/// A name put in a folder, as the FileBrowser client joins them.
pub fn join_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        normalize_path(&format!("/{name}"))
    } else {
        normalize_path(&format!("{dir}/{name}"))
    }
}

/// The first free name when `name` is taken: "photo.jpg" becomes "photo (2).jpg", then "photo (3).jpg".
/// `taken` holds the names already in the folder; a name that is not in it comes back unchanged.
pub fn free_name(name: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(name) {
        return name.to_owned();
    }
    let (stem, extension) = split_extension(name);
    for i in 2..10_000 {
        let candidate = format!("{stem} ({i}){extension}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("{stem}-{now}{extension}")
}

/// "a.tar.gz" gives ("a.tar", ".gz"); a leading dot is not an extension (".env" gives (".env", "")).
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    }
}

/// A name that can be used for a file on the device: the characters file systems refuse become "_", and a name
/// that would climb out of its folder ("", ".", "..") becomes "fichier".
pub fn safe_file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    if clean.is_empty() || clean == "." || clean == ".." {
        "fichier".to_owned()
    } else {
        clean
    }
}

// Ported from mobile/tests/uploads.test.js (the name helpers) and mobile/tests/filebrowser.test.js (cache names).
#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn free_name_numbers_a_taken_name_and_keeps_the_extension() {
        assert_eq!(free_name("a.jpg", &set(&[])), "a.jpg");
        assert_eq!(free_name("a.jpg", &set(&["a.jpg"])), "a (2).jpg");
        assert_eq!(
            free_name("a.jpg", &set(&["a.jpg", "a (2).jpg", "a (3).jpg"])),
            "a (4).jpg"
        );
        assert_eq!(
            free_name("archive.tar.gz", &set(&["archive.tar.gz"])),
            "archive.tar (2).gz"
        );
        assert_eq!(free_name(".env", &set(&[".env"])), ".env (2)");
        assert_eq!(free_name("noext", &set(&["noext"])), "noext (2)");
    }

    #[test]
    fn path_parts() {
        assert_eq!(base_name("/a/b/c.jpg"), "c.jpg");
        assert_eq!(base_name("/"), "");
        assert_eq!(parent_path("/a/b/c.jpg"), "/a/b");
        assert_eq!(parent_path("/c.jpg"), "/");
        assert_eq!(child_path("/", "x"), "/x");
        assert_eq!(child_path("/a//b/", "x"), "/a/b/x");
        assert!(same_path("/a//b/", "a/b"));
        assert!(!same_path("/a/b", "/a/c"));
    }

    #[test]
    fn paths_are_normalized_and_joined_as_the_filebrowser_client_does() {
        assert_eq!(normalize_path("//a///b//"), "/a/b");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path("///"), "/");
        assert_eq!(join_path("/", "x"), "/x");
        assert_eq!(join_path("/Photos", "a.jpg"), "/Photos/a.jpg");
        assert_eq!(join_path("/Photos/", "a.jpg"), "/Photos/a.jpg");
    }

    #[test]
    fn a_name_that_would_climb_out_of_its_folder_is_not_used_as_it_is() {
        assert_eq!(safe_file_name("a b.jpg"), "a b.jpg");
        assert_eq!(safe_file_name(".."), "fichier");
        assert_eq!(safe_file_name(""), "fichier");
        assert_eq!(safe_file_name("a/b.jpg"), "a_b.jpg");
        assert_eq!(safe_file_name(r#"a:b*c?"d<e>f|g"#), "a_b_c__d_e_f_g");
    }
}
