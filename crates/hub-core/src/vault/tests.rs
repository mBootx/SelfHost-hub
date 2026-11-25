// Ported from mobile/tests/vault (t-guard, t-load, t-older, t-delete, t-trash, t-migrate, t-migrate2, t-peers,
// t-albums), run against the in-memory FileBrowser in `fake.rs`.

use std::cell::{Cell, RefCell};

use jiff::civil::{Date, date};
use serde_json::{Map, Value, json};

use super::fake::{Fake, Node, Op};
use super::*;
use crate::tests_support::block_on;

const ROOT: &str = "/backups/photos/alice";
const LEGACY: &str = "/Appareil photo";
const OLD: &str = "/Appareil photo";
const BIN: &str = "/backups/photos/alice/Corbeille";
const DAY: &str = "2026-10-02";
const NO_FOLDERS: &[&str] = &[];

fn today() -> Date {
    date(2026, 10, 2)
}

/// Alice's backups, and next to them Bob's: the files the gallery must never reach.
fn vault_tree() -> Value {
    json!({
        "backups": {
            "photos": {
                "alice": {
                    "2026": { "09": { "a.jpg": 100, "b.HEIC": 200, "c.mp4": 999, "notes.txt": 5 }, "08": { "d.png": 300 } },
                    "2025": { "12": { "e.jpg": 50 } },
                    "stray.jpg": 10,
                    "deep": { "x": { "y": { "w": { "z.jpg": 1 } } } }
                },
                "bob": { "2026": { "09": { "secret.jpg": 777 } } }
            }
        }
    })
}

/// An old backup folder (year/month), next to an account folder that already holds a clashing photo.
fn legacy_tree() -> Value {
    json!({
        "Appareil photo": {
            "2026": { "08": { "a.jpg": 10, "v.mp4": 20 }, "09": { "b.jpg": 30, "notes.txt": 1 } },
            "2025": { "12": { "old.jpg": 40 } }
        },
        "backups": {
            "photos": {
                "alice": { "2026": { "09": { "b.jpg": 99, "z.jpg": 5 } } },
                "bob": { "2026": { "09": { "secret.jpg": 777 } } }
            }
        }
    })
}

/// Alice's account folder, plus the old single folder the app used before backups were kept per account.
fn older_tree() -> Value {
    let mut tree = vault_tree();
    tree["Appareil photo"] = json!({
        "2026": { "09": { "a.jpg": 100, "old1.jpg": 111, "clip.mp4": 5000 }, "07": { "old2.jpg": 222 } },
        "2025": { "12": { "e.jpg": 51 } },
        "readme.txt": 3
    });
    tree
}

/// Alice's camera photos plus what other phone albums put in their own folders.
fn album_tree() -> Value {
    let mut tree = vault_tree();
    let alice = &mut tree["backups"]["photos"]["alice"];
    alice["Screenshots"] = json!({ "2026": { "09": { "shot.png": 40, "recording.mp4": 900 } } });
    alice["WhatsApp Images"] = json!({ "2026": { "08": { "wa.jpg": 60 } }, "loose.jpg": 7 });
    alice["Corbeille"] = json!({ "2026-10-01": { "2026": { "09": { "binned.jpg": 5 } } } });
    tree
}

fn tree_with_album() -> Value {
    let mut tree = vault_tree();
    tree["backups"]["photos"]["alice"]["Screenshots"] =
        json!({ "2026": { "09": { "shot.png": 40 } } });
    tree
}

fn with_bin(bin: Value) -> Value {
    let mut tree = vault_tree();
    tree["backups"]["photos"]["alice"]["Corbeille"] = bin;
    tree
}

fn load(fake: &Fake) -> Result<VaultListing, VaultError> {
    block_on(load_photos(fake, ROOT, NO_FOLDERS, || false, |_| {}))
}

fn load_with_old(fake: &Fake) -> Result<VaultListing, VaultError> {
    block_on(load_photos(fake, ROOT, &[OLD], || false, |_| {}))
}

fn photo<'a>(listing: &'a VaultListing, name: &str) -> &'a Photo {
    listing
        .photos
        .iter()
        .find(|photo| photo.name == name)
        .unwrap_or_else(|| panic!("{name} is not in the gallery"))
}

fn has(listing: &VaultListing, name: &str) -> bool {
    listing.photos.iter().any(|photo| photo.name == name)
}

fn delete(fake: &Fake, roots: &[&str], paths: &[&str]) -> DeleteReport {
    block_on(delete_photos(fake, roots, paths, |_, _| {})).unwrap()
}

fn trash(fake: &Fake, roots: &[&str], paths: &[&str]) -> TrashReport {
    block_on(trash_photos(fake, roots, paths, today(), |_, _| {})).unwrap()
}

fn trash_listing(fake: &Fake) -> Result<TrashListing, VaultError> {
    block_on(load_trash(fake, ROOT, || false))
}

fn restore(fake: &Fake, paths: &[&str]) -> RestoreReport {
    block_on(restore_trashed(fake, ROOT, paths, |_, _| {})).unwrap()
}

fn migrate(fake: &Fake, from: &str, to: &str) -> Result<MigrationReport, VaultError> {
    block_on(migrate_backups(fake, from, to, || false, |_, _| {}))
}

fn refused<T: fmt::Debug>(result: Result<T, VaultError>) {
    match result {
        Ok(value) => panic!("was accepted: {value:?}"),
        Err(err) => assert_eq!(
            err.code,
            VaultErrorCode::ForbiddenPath,
            "wrong error: {}",
            err.message
        ),
    }
}

fn inside_bin(path: &str) -> String {
    format!("{BIN}/{DAY}/{path}")
}

// ---- t-guard ----

#[test]
fn ordinary_account_names_are_left_alone() {
    for (raw, clean) in [
        ("alice", "alice"),
        ("john.doe", "john.doe"),
        ("Jean Dupont", "Jean Dupont"),
        ("marie-claire_2@mail.fr", "marie-claire_2@mail.fr"),
        ("Éloïse", "Éloïse"),
        ("日本語", "日本語"),
        ("  alice  ", "alice"),
    ] {
        assert_eq!(sanitize_username(raw).unwrap(), clean);
    }
}

#[test]
fn hostile_account_names_cannot_become_a_path_component_that_escapes() {
    for name in [
        "..",
        ".",
        "../bob",
        "a/b",
        "a\\b",
        ".hidden",
        "trailing.",
        " ",
        "~",
        "a~b",
        "x\0y",
        "/etc/passwd",
        "😀",
    ] {
        let cleaned = match sanitize_username(name) {
            Ok(cleaned) => cleaned,
            Err(err) => {
                assert_eq!(err.code, VaultErrorCode::ForbiddenPath);
                continue;
            }
        };
        assert!(
            cleaned != "." && cleaned != ".." && !cleaned.is_empty(),
            "dot name from {name:?}"
        );
        assert!(
            !cleaned.contains('/') && !cleaned.contains('\\') && !cleaned.contains('\0'),
            "separator left in {cleaned:?}"
        );
        assert!(!cleaned.starts_with('.'), "hidden folder from {name:?}");
    }
    refused(sanitize_username(""));
    refused(sanitize_username(&"x".repeat(200)));
}

#[test]
fn two_different_accounts_never_share_a_folder() {
    let mut seen = HashMap::new();
    for name in [
        "a/b",
        "a_b",
        "a~2f~b",
        "a.b",
        "a b",
        "A/B",
        "../x",
        "~2e~~2e~/x",
    ] {
        let cleaned = sanitize_username(name).unwrap();
        if let Some(other) = seen.insert(cleaned, name) {
            panic!("{name:?} collides with {other:?}");
        }
    }
}

#[test]
fn the_backup_folder_is_built_from_the_setting_and_the_account() {
    assert_eq!(
        vault_root_for(DEFAULT_BACKUP_FOLDER, "alice").unwrap(),
        "/backups/photos/alice"
    );
    assert_eq!(
        vault_root_for("/Sauvegardes/{user}/photos", "bob").unwrap(),
        "/Sauvegardes/bob/photos"
    );
    assert_eq!(
        vault_root_for("/Appareil photo", "bob").unwrap(),
        "/Appareil photo"
    );
    assert_eq!(
        vault_root_for("backups//photos/{user}/", "alice").unwrap(),
        "/backups/photos/alice"
    );
    // A hostile account name stays one folder inside the central one.
    let root = vault_root_for(DEFAULT_BACKUP_FOLDER, "../bob").unwrap();
    assert!(
        is_inside("/backups/photos", &root) && root.split('/').count() == 4,
        "{root}"
    );
}

#[test]
fn a_setting_that_tries_to_leave_is_refused() {
    refused(vault_root_for("/backups/../etc/{user}", "alice"));
    refused(vault_root_for("/backups\\photos/{user}", "alice"));
    refused(vault_root_for("/backups/%2e%2e/{user}", "alice"));
    refused(vault_root_for("/backups/photos/{user}\0", "alice"));
}

#[test]
fn the_central_folder_is_only_known_when_the_setting_is_organised_by_account() {
    assert_eq!(
        central_folder_of(DEFAULT_BACKUP_FOLDER).unwrap().as_deref(),
        Some("/backups/photos")
    );
    assert_eq!(
        central_folder_of("/a/{user}").unwrap().as_deref(),
        Some("/a")
    );
    assert_eq!(central_folder_of("/{user}").unwrap(), None);
    assert_eq!(central_folder_of("/Appareil photo").unwrap(), None);
    assert_eq!(central_folder_of("/a/{user}/b").unwrap(), None);
}

#[test]
fn paths_inside_the_folder_are_accepted_and_cleaned() {
    assert_eq!(resolve_inside(ROOT, ROOT).unwrap(), ROOT);
    assert_eq!(
        resolve_inside(ROOT, &format!("{ROOT}/2026/09/IMG_1.jpg")).unwrap(),
        format!("{ROOT}/2026/09/IMG_1.jpg")
    );
    assert_eq!(
        resolve_inside(ROOT, "//backups//photos/alice/./2026/").unwrap(),
        format!("{ROOT}/2026")
    );
    assert_eq!(
        resolve_inside("/", "/anything/at/all").unwrap(),
        "/anything/at/all"
    );
}

#[test]
fn every_way_out_of_the_folder_is_refused() {
    let attempts = [
        format!("{ROOT}/../bob/2026/x.jpg"),
        format!("{ROOT}/2026/../../bob/x.jpg"),
        "/backups/photos/bob/x.jpg".to_owned(),
        "/backups/photos".to_owned(),
        "/backups/photos/alicebob/x.jpg".to_owned(),
        "/backups/photos/alice2".to_owned(),
        "/backups/photos/ALICE/x.jpg".to_owned(),
        "/etc/passwd".to_owned(),
        "/".to_owned(),
        format!("{ROOT}/%2e%2e/bob"),
        format!("{ROOT}/%2E%2E/bob"),
        format!("{ROOT}/..%2fbob"),
        format!("{ROOT}/2026%2f..%2f..%2fbob"),
        format!("{ROOT}/%2e%2e%2fbob"),
        "/backups/photos/alice%2f..%2fbob/x.jpg".to_owned(),
        format!("{ROOT}/2026\\..\\bob"),
        format!("{ROOT}\\..\\bob"),
        format!("{ROOT}/x\0.jpg"),
        format!("{ROOT}/line\nbreak.jpg"),
        format!("{ROOT}/{}", "a".repeat(300)),
    ];
    for attempt in &attempts {
        match resolve_inside(ROOT, attempt) {
            Ok(resolved) => panic!("accepted {attempt:?} as {resolved}"),
            Err(err) => assert_eq!(
                err.code,
                VaultErrorCode::ForbiddenPath,
                "{attempt:?} -> {}",
                err.message
            ),
        }
    }
    assert!(!is_inside(ROOT, "/backups/photos/bob"));
    assert!(is_inside(ROOT, &format!("{ROOT}/2026/x.jpg")));
}

#[test]
fn photo_and_video_extensions() {
    for name in [
        "a.jpg", "A.JPG", "b.jpeg", "c.png", "d.webp", "e.heic", "f.HEIF", "g.gif", "h.avif",
        "i.bmp",
    ] {
        assert!(is_photo_name(name), "{name}");
    }
    for name in ["a.mp4", "b.MOV", "c.3gp", "d.webm"] {
        assert!(is_video_name(name) && !is_photo_name(name), "{name}");
    }
    for name in ["notes.txt", "noext", ".jpg", "jpg", "a.jpg.exe", "a.pdf"] {
        assert!(!is_photo_name(name) && !is_video_name(name), "{name}");
    }
}

// ---- t-load ----

#[test]
fn lists_the_photos_of_the_account_with_their_year_and_month() {
    let listing = load(&Fake::new(&vault_tree())).unwrap();
    let mut names: Vec<&str> = listing
        .photos
        .iter()
        .map(|photo| photo.name.as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        ["a.jpg", "b.HEIC", "c.mp4", "d.png", "e.jpg", "stray.jpg"]
    );
    assert_eq!(
        [
            photo(&listing, "c.mp4").kind,
            photo(&listing, "a.jpg").kind,
            photo(&listing, "b.HEIC").kind
        ],
        [MediaKind::Video, MediaKind::Photo, MediaKind::Photo]
    );
    assert!(!listing.incomplete);
    let place = |name| (photo(&listing, name).year, photo(&listing, name).month);
    assert_eq!(place("a.jpg"), (Some(2026), Some(9)));
    assert_eq!(place("d.png"), (Some(2026), Some(8)));
    assert_eq!(place("e.jpg"), (Some(2025), Some(12)));
    assert_eq!(place("stray.jpg"), (None, None));
    assert_eq!(photo(&listing, "b.HEIC").size, 200);
    assert_eq!(
        photo(&listing, "a.jpg").path,
        format!("{ROOT}/2026/09/a.jpg")
    );
    assert!(photo(&listing, "a.jpg").modified > 0);
}

#[test]
fn never_asks_the_server_about_anything_outside_the_account_folder() {
    let fake = Fake::new(&vault_tree());
    load(&fake).unwrap();
    let calls = fake.calls();
    assert!(calls.len() > 3);
    for call in calls {
        assert_eq!(call.op, Op::List);
        assert!(is_inside(ROOT, &call.path), "asked for {}", call.path);
    }
}

#[test]
fn reads_at_most_four_folders_at_once_newest_first() {
    let mut alice = Map::new();
    for year in 2015..=2026 {
        let mut months = Map::new();
        for month in 1..=12 {
            let mut files = Map::new();
            files.insert(format!("p{year}{month}.jpg"), json!(10));
            months.insert(format!("{month:02}"), Value::Object(files));
        }
        alice.insert(year.to_string(), Value::Object(months));
    }
    let fake = Fake::new(&json!({ "backups": { "photos": { "alice": alice } } }));
    let listing = load(&fake).unwrap();
    assert_eq!(listing.photos.len(), 144);
    assert!(fake.peak() <= 4, "peak {}", fake.peak());
    assert!(fake.peak() > 1, "no parallelism at all");
    assert_eq!(
        fake.calls()[1].path,
        format!("{ROOT}/2026"),
        "the newest year should be read first"
    );
}

#[test]
fn reports_what_it_has_found_as_it_goes() {
    let fake = Fake::new(&vault_tree());
    let mut seen = Vec::new();
    let listing = block_on(load_photos(
        &fake,
        ROOT,
        NO_FOLDERS,
        || false,
        |photos| seen.push(photos.len()),
    ))
    .unwrap();
    assert!(seen.len() >= 3);
    assert!(seen.is_sorted(), "{seen:?}");
    assert_eq!(seen.last(), Some(&listing.photos.len()));
}

#[test]
fn an_account_with_no_backup_folder_yet_has_an_empty_gallery() {
    let fake = Fake::new(&json!({ "backups": { "photos": {} } }));
    assert_eq!(load(&fake).unwrap(), VaultListing::default());
}

#[test]
fn server_answers_are_mapped_to_errors_the_screen_can_explain() {
    for (status, code) in [
        (401, VaultErrorCode::Unauthorized),
        (403, VaultErrorCode::Denied),
        (0, VaultErrorCode::Offline),
        (500, VaultErrorCode::Failed),
    ] {
        let fake = Fake::new(&vault_tree());
        fake.fail(Op::List, ROOT, status);
        let err = load(&fake).expect_err("did not fail");
        assert_eq!(err.code, code, "{status}");
    }
}

#[test]
fn a_folder_that_cannot_be_read_marks_the_list_incomplete_but_keeps_the_rest() {
    let fake = Fake::new(&vault_tree());
    fake.fail(Op::List, &format!("{ROOT}/2026/08"), 500);
    let listing = load(&fake).unwrap();
    assert!(listing.incomplete);
    assert!(has(&listing, "a.jpg"));
    assert!(!has(&listing, "d.png"));
}

#[test]
fn names_the_server_sends_that_lead_out_of_the_folder_are_ignored() {
    let mut tree = vault_tree();
    let alice = &mut tree["backups"]["photos"]["alice"];
    alice[".."] = json!({ "loot.jpg": 1 });
    alice["x/../y.jpg"] = json!(1);
    alice["a\\b.jpg"] = json!(1);
    alice["."] = json!({ "dot.jpg": 1 });
    let fake = Fake::new(&tree);
    let listing = load(&fake).unwrap();
    assert!(!listing.photos.iter().any(|photo| {
        photo.name.contains("..")
            || photo.name.contains('/')
            || photo.name == "loot.jpg"
            || photo.name == "dot.jpg"
    }));
    for call in fake.calls() {
        assert!(!call.path.contains(".."), "asked for {}", call.path);
    }
}

#[test]
fn stops_reading_when_told_to() {
    let fake = Fake::new(&vault_tree());
    let listing = block_on(load_photos(&fake, ROOT, NO_FOLDERS, || true, |_| {})).unwrap();
    assert!(listing.photos.is_empty());
    assert!(fake.calls().is_empty());
}

// ---- t-older ----

#[test]
fn older_folders_photos_are_listed_with_the_accounts_own() {
    let listing = load_with_old(&Fake::new(&older_tree())).unwrap();
    let paths: Vec<&str> = listing
        .photos
        .iter()
        .map(|photo| photo.path.as_str())
        .collect();
    assert!(
        paths.contains(&"/Appareil photo/2026/09/old1.jpg"),
        "{paths:?}"
    );
    assert!(paths.contains(&"/Appareil photo/2026/07/old2.jpg"));
    assert!(paths.contains(&"/backups/photos/alice/2026/08/d.png"));
    let videos = listing
        .photos
        .iter()
        .filter(|photo| photo.kind == MediaKind::Video)
        .count();
    assert_eq!(videos, 2, "the clip in each folder");
}

#[test]
fn older_folders_the_same_photo_in_both_is_shown_once_the_accounts_copy_first() {
    let listing = load_with_old(&Fake::new(&older_tree())).unwrap();
    let a: Vec<&Photo> = listing
        .photos
        .iter()
        .filter(|photo| photo.name == "a.jpg")
        .collect();
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].path, "/backups/photos/alice/2026/09/a.jpg");
    // e.jpg is 50 bytes in the account's folder and 51 in the old one: different files, both kept.
    assert_eq!(
        listing
            .photos
            .iter()
            .filter(|photo| photo.name == "e.jpg")
            .count(),
        2
    );
}

#[test]
fn older_folders_year_month_and_relative_path_come_from_each_folders_own_layout() {
    let listing = load_with_old(&Fake::new(&older_tree())).unwrap();
    let old2 = photo(&listing, "old2.jpg");
    assert_eq!(
        (old2.year, old2.month, old2.relative.as_str()),
        (Some(2026), Some(7), "2026/07/old2.jpg")
    );
}

#[test]
fn older_folders_a_missing_or_unreadable_one_never_breaks_the_gallery() {
    let fake = Fake::new(&vault_tree());
    let missing = block_on(load_photos(
        &fake,
        ROOT,
        &["/does/not/exist"],
        || false,
        |_| {},
    ))
    .unwrap();
    assert!(!missing.incomplete);
    assert!(!missing.photos.is_empty());
    let broken = Fake::new(&older_tree());
    broken.fail(Op::List, OLD, 500);
    let listing = load_with_old(&broken).unwrap();
    assert!(listing.incomplete, "the list says it may be missing photos");
    assert!(has(&listing, "d.png"));
}

#[test]
fn older_folders_only_the_account_folder_missing_is_still_a_gallery_of_the_old_photos() {
    let fake = Fake::new(&json!({ "Appareil photo": older_tree()["Appareil photo"] }));
    let listing = load_with_old(&fake).unwrap();
    assert!(has(&listing, "old1.jpg"));
    assert!(!listing.incomplete);
}

#[test]
fn older_folders_a_fatal_error_on_the_account_folder_still_fails() {
    let fake = Fake::new(&older_tree());
    fake.fail(Op::List, ROOT, 403);
    assert_eq!(
        load_with_old(&fake).unwrap_err().code,
        VaultErrorCode::Denied
    );
}

#[test]
fn older_folders_nested_in_around_or_equal_to_the_account_folder_are_ignored() {
    let plain = load(&Fake::new(&older_tree())).unwrap();
    let nested = format!("{ROOT}/2026");
    for bad in [
        ROOT,
        nested.as_str(),
        "/backups/photos",
        "/backups",
        "/",
        "",
        "/backups/../etc",
    ] {
        let listing = block_on(load_photos(
            &Fake::new(&older_tree()),
            ROOT,
            &[bad],
            || false,
            |_| {},
        ))
        .unwrap();
        assert_eq!(listing.photos.len(), plain.photos.len(), "folder {bad:?}");
    }
}

#[test]
fn older_folders_never_lists_anything_outside_the_two_folders() {
    let fake = Fake::new(&older_tree());
    load_with_old(&fake).unwrap();
    let outside: Vec<String> = fake
        .calls()
        .into_iter()
        .map(|call| call.path)
        .filter(|path| !(path.starts_with(ROOT) || path.starts_with(OLD)))
        .collect();
    assert!(outside.is_empty(), "{outside:?}");
    assert!(
        fake.peak() <= 4,
        "at most four folders at once, even for two roots: {}",
        fake.peak()
    );
}

#[test]
fn older_folders_the_partial_results_already_contain_both_folders() {
    let fake = Fake::new(&older_tree());
    let mut seen = Vec::new();
    block_on(load_photos(
        &fake,
        ROOT,
        &[OLD],
        || false,
        |photos| seen.push(photos.len()),
    ))
    .unwrap();
    assert!(seen.len() >= 2);
    assert!(seen.is_sorted(), "only grows: {seen:?}");
}

#[test]
fn delete_a_photo_in_the_old_folder_can_be_deleted_when_that_folder_is_one_of_the_roots() {
    let fake = Fake::new(&older_tree());
    let report = delete(
        &fake,
        &[ROOT, OLD],
        &[
            "/Appareil photo/2026/07/old2.jpg",
            "/backups/photos/alice/2026/08/d.png",
        ],
    );
    let mut deleted = report.deleted.clone();
    deleted.sort();
    assert_eq!(
        deleted,
        [
            "/Appareil photo/2026/07/old2.jpg",
            "/backups/photos/alice/2026/08/d.png"
        ]
    );
    assert_eq!(fake.find("/Appareil photo/2026/07/old2.jpg"), None);
}

#[test]
fn delete_with_only_the_account_folder_as_root_the_old_folder_stays_out_of_reach() {
    let fake = Fake::new(&older_tree());
    let report = delete(&fake, &[ROOT], &["/Appareil photo/2026/07/old2.jpg"]);
    assert!(report.deleted.is_empty());
    assert_eq!(report.failed.len(), 1);
    assert!(fake.find("/Appareil photo/2026/07/old2.jpg").is_some());
}

#[test]
fn delete_other_accounts_and_traversal_stay_refused_with_several_roots() {
    let fake = Fake::new(&older_tree());
    let report = delete(
        &fake,
        &[ROOT, OLD],
        &[
            "/backups/photos/bob/2026/09/secret.jpg",
            "/Appareil photo/../backups/photos/bob/2026/09/secret.jpg",
            "/Appareil photo",
            "/backups/photos/alice",
            "/Appareil photo/readme.txt",
        ],
    );
    assert!(report.deleted.is_empty(), "{:?}", report.deleted);
    assert_eq!(report.failed.len(), 5);
    assert!(
        fake.find("/backups/photos/bob/2026/09/secret.jpg")
            .is_some()
    );
    assert!(fake.find("/Appareil photo/readme.txt").is_some());
    assert_eq!(fake.count(Op::Remove), 0);
}

// ---- t-delete ----

#[test]
fn deletes_photos_from_the_folder_and_nothing_else() {
    let fake = Fake::new(&vault_tree());
    let (a, e) = (
        format!("{ROOT}/2026/09/a.jpg"),
        format!("{ROOT}/2025/12/e.jpg"),
    );
    let report = delete(&fake, &[ROOT], &[&a, &e]);
    assert_eq!(report.deleted, [a.clone(), e.clone()]);
    assert!(report.failed.is_empty());
    let left = fake.dump();
    assert!(!left.contains(&a) && !left.contains(&e));
    assert!(left.contains(&format!("{ROOT}/2026/09/b.HEIC")));
    assert!(left.contains(&"/backups/photos/bob/2026/09/secret.jpg".to_owned()));
}

#[test]
fn refuses_another_accounts_photos_folders_other_files_and_the_folder_itself() {
    let fake = Fake::new(&vault_tree());
    let targets = [
        "/backups/photos/bob/2026/09/secret.jpg".to_owned(),
        format!("{ROOT}/../bob/2026/09/secret.jpg"),
        format!("{ROOT}/%2e%2e/bob/2026/09/secret.jpg"),
        format!("{ROOT}/2026"),
        format!("{ROOT}/2026/09/notes.txt"),
        ROOT.to_owned(),
        "/backups/photos".to_owned(),
        "/".to_owned(),
    ];
    let before = fake.dump();
    let report = block_on(delete_photos(&fake, &[ROOT], &targets, |_, _| {})).unwrap();
    assert!(report.deleted.is_empty());
    assert_eq!(report.failed.len(), targets.len());
    assert_eq!(fake.dump(), before);
    assert_eq!(fake.count(Op::Remove), 0, "a delete reached the server");
}

#[test]
fn a_lost_session_stops_a_delete_run_a_missing_file_does_not() {
    let fake = Fake::new(&vault_tree());
    fake.fail(Op::Remove, &format!("{ROOT}/2026/09/b.HEIC"), 401);
    let targets = [
        format!("{ROOT}/2026/09/ghost.jpg"),
        format!("{ROOT}/2026/09/b.HEIC"),
        format!("{ROOT}/2026/08/d.png"),
        format!("{ROOT}/2025/12/e.jpg"),
    ];
    let report = block_on(delete_photos(&fake, &[ROOT], &targets, |_, _| {})).unwrap();
    assert!(report.deleted.is_empty());
    assert_eq!(report.failed.len(), 4);
    assert_eq!(fake.count(Op::Remove), 2, "should stop after the 401");
    assert!(fake.dump().contains(&format!("{ROOT}/2026/08/d.png")));
}

#[test]
fn a_missing_file_is_reported_and_the_rest_still_goes() {
    let fake = Fake::new(&vault_tree());
    let d = format!("{ROOT}/2026/08/d.png");
    let report = delete(&fake, &[ROOT], &[&format!("{ROOT}/2026/09/ghost.jpg"), &d]);
    assert_eq!(report.deleted, [d]);
    assert_eq!(report.failed.len(), 1);
}

#[test]
fn delete_reports_progress() {
    let fake = Fake::new(&vault_tree());
    let mut steps = Vec::new();
    let targets = [
        format!("{ROOT}/2026/09/a.jpg"),
        format!("{ROOT}/2026/08/d.png"),
    ];
    block_on(delete_photos(&fake, &[ROOT], &targets, |done, total| {
        steps.push(format!("{done}/{total}"))
    }))
    .unwrap();
    assert_eq!(steps, ["1/2", "2/2"]);
}

// ---- t-trash ----

#[test]
fn bin_a_deleted_photo_moves_into_a_day_folder_keeping_its_place_in_year_month() {
    let fake = Fake::new(&vault_tree());
    let (a, e) = (
        format!("{ROOT}/2026/09/a.jpg"),
        format!("{ROOT}/2025/12/e.jpg"),
    );
    let report = trash(&fake, &[ROOT], &[&a, &e]);
    assert_eq!(
        report.moved,
        [
            Moved {
                from: a.clone(),
                to: inside_bin("2026/09/a.jpg")
            },
            Moved {
                from: e,
                to: inside_bin("2025/12/e.jpg")
            },
        ]
    );
    assert!(report.failed.is_empty());
    let left = fake.dump();
    assert!(!left.contains(&a) && left.contains(&inside_bin("2026/09/a.jpg")));
    assert!(
        left.contains(&format!("{ROOT}/2026/09/b.HEIC")),
        "the others stay"
    );
    assert_eq!(fake.count(Op::Remove), 0, "nothing is deleted for good");
}

#[test]
fn bin_photos_of_an_album_keep_their_album_folder_in_the_bin() {
    let fake = Fake::new(&tree_with_album());
    let report = trash(
        &fake,
        &[ROOT],
        &[&format!("{ROOT}/Screenshots/2026/09/shot.png")],
    );
    assert_eq!(
        report.moved[0].to,
        inside_bin("Screenshots/2026/09/shot.png")
    );
}

#[test]
fn bin_a_name_already_in_the_bin_that_day_is_not_overwritten() {
    let fake = Fake::new(&with_bin(
        json!({ DAY: { "2026": { "09": { "a.jpg": 1 } } } }),
    ));
    let report = trash(&fake, &[ROOT], &[&format!("{ROOT}/2026/09/a.jpg")]);
    assert_eq!(report.moved[0].to, inside_bin("2026/09/a (2).jpg"));
    assert!(
        fake.dump().contains(&inside_bin("2026/09/a.jpg")),
        "the first one is still there"
    );
}

#[test]
fn bin_two_photos_with_the_same_name_from_one_folder_do_not_clash_either() {
    let mut tree = vault_tree();
    // Same relative path in the account's folder and in an older folder.
    tree["Appareil photo"] = json!({ "2026": { "09": { "a.jpg": 11 } } });
    let fake = Fake::new(&tree);
    let report = trash(
        &fake,
        &[ROOT, OLD],
        &[
            &format!("{ROOT}/2026/09/a.jpg"),
            "/Appareil photo/2026/09/a.jpg",
        ],
    );
    let to: Vec<&str> = report.moved.iter().map(|moved| moved.to.as_str()).collect();
    assert_eq!(
        to,
        [inside_bin("2026/09/a.jpg"), inside_bin("2026/09/a (2).jpg")]
    );
    assert!(report.failed.is_empty());
}

#[test]
fn bin_refuses_other_accounts_folders_other_files_the_folder_itself_and_what_is_already_in_the_bin()
{
    let fake = Fake::new(&with_bin(json!({ DAY: { "binned.jpg": 1 } })));
    let targets = [
        "/backups/photos/bob/2026/09/secret.jpg".to_owned(),
        format!("{ROOT}/../bob/2026/09/secret.jpg"),
        format!("{ROOT}/2026"),
        format!("{ROOT}/2026/09/notes.txt"),
        ROOT.to_owned(),
        "/".to_owned(),
        inside_bin("binned.jpg"),
    ];
    let before = fake.dump();
    let report = block_on(trash_photos(&fake, &[ROOT], &targets, today(), |_, _| {})).unwrap();
    assert!(report.moved.is_empty());
    assert_eq!(report.failed.len(), targets.len());
    assert_eq!(fake.dump(), before);
    assert_eq!(fake.count(Op::Rename), 0, "a move reached the server");
}

#[test]
fn bin_a_lost_session_stops_the_run_a_missing_file_does_not() {
    let fake = Fake::new(&vault_tree());
    fake.fail(Op::Rename, &format!("{ROOT}/2026/09/b.HEIC"), 401);
    let (ghost, heic, d) = (
        format!("{ROOT}/2026/09/ghost.jpg"),
        format!("{ROOT}/2026/09/b.HEIC"),
        format!("{ROOT}/2026/08/d.png"),
    );
    let report = trash(&fake, &[ROOT], &[&ghost, &heic, &d]);
    assert!(report.moved.is_empty());
    assert_eq!(report.failed.len(), 3);
    assert_eq!(fake.count(Op::Rename), 2, "stops after the 401");
    let fine = Fake::new(&vault_tree());
    let ok = trash(&fine, &[ROOT], &[&ghost, &d]);
    assert_eq!(
        ok.moved
            .iter()
            .map(|moved| moved.from.as_str())
            .collect::<Vec<_>>(),
        [d.as_str()]
    );
    assert_eq!(ok.failed.len(), 1);
}

#[test]
fn bin_progress_is_reported() {
    let fake = Fake::new(&vault_tree());
    let mut steps = Vec::new();
    let targets = [
        format!("{ROOT}/2026/09/a.jpg"),
        format!("{ROOT}/2026/08/d.png"),
    ];
    block_on(trash_photos(
        &fake,
        &[ROOT],
        &targets,
        today(),
        |done, total| steps.push(format!("{done}/{total}")),
    ))
    .unwrap();
    assert_eq!(steps, ["1/2", "2/2"]);
}

#[test]
fn bin_lists_what_was_deleted_newest_day_first_with_where_each_photo_came_from() {
    let fake = Fake::new(&with_bin(json!({
        "2026-09-20": { "2026": { "09": { "old.jpg": 3, "clip.mp4": 4 } } },
        "2026-10-01": { "Screenshots": { "2026": { "09": { "shot.png": 5 } } } },
        "notes.txt": 1,
        "misc": { "stray.jpg": 1 }
    })));
    let listing = trash_listing(&fake).unwrap();
    let summary: Vec<String> = listing
        .items
        .iter()
        .map(|item| format!("{} {}", item.trashed_on, item.name))
        .collect();
    assert_eq!(
        summary,
        [
            "2026-10-01 shot.png",
            "2026-09-20 clip.mp4",
            "2026-09-20 old.jpg"
        ]
    );
    let shot = &listing.items[0];
    assert_eq!(
        shot.original_path,
        format!("{ROOT}/Screenshots/2026/09/shot.png")
    );
    assert_eq!(
        shot.path,
        format!("{BIN}/2026-10-01/Screenshots/2026/09/shot.png")
    );
    let kinds: Vec<MediaKind> = listing.items.iter().map(|item| item.kind).collect();
    assert_eq!(
        kinds,
        [MediaKind::Photo, MediaKind::Video, MediaKind::Photo]
    );
    assert!(!listing.incomplete);
}

#[test]
fn bin_no_bin_yet_is_an_empty_bin_a_lost_session_is_an_error() {
    assert_eq!(
        trash_listing(&Fake::new(&vault_tree())).unwrap(),
        TrashListing::default()
    );
    let fake = Fake::new(&vault_tree());
    fake.fail(Op::List, BIN, 401);
    assert_eq!(
        trash_listing(&fake).unwrap_err().code,
        VaultErrorCode::Unauthorized
    );
}

#[test]
fn bin_a_day_folder_that_cannot_be_read_marks_the_list_incomplete() {
    let fake = Fake::new(&with_bin(
        json!({ "2026-09-20": { "a.jpg": 1 }, "2026-10-01": { "b.jpg": 1 } }),
    ));
    fake.fail(Op::List, &format!("{BIN}/2026-09-20"), 500);
    let listing = trash_listing(&fake).unwrap();
    assert!(listing.incomplete);
    assert_eq!(
        listing
            .items
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        ["b.jpg"]
    );
}

#[test]
fn bin_restoring_puts_a_photo_back_making_its_folders_again_if_they_are_gone() {
    let fake = Fake::new(&vault_tree());
    let e = format!("{ROOT}/2025/12/e.jpg");
    let trashed = trash(&fake, &[ROOT], &[&e]);
    // The year folder went when its last photo did.
    block_on(fake.remove(&format!("{ROOT}/2025"))).unwrap();
    let report = restore(&fake, &[&trashed.moved[0].to]);
    assert_eq!(
        report.restored,
        [Moved {
            from: trashed.moved[0].to.clone(),
            to: e.clone()
        }]
    );
    assert!(fake.dump().contains(&e));
    assert!(!fake.dump().contains(&inside_bin("2025/12/e.jpg")));
}

#[test]
fn bin_a_restored_photo_never_replaces_one_that_took_its_name_meanwhile() {
    let fake = Fake::new(&vault_tree());
    let a = format!("{ROOT}/2026/09/a.jpg");
    let trashed = trash(&fake, &[ROOT], &[&a]);
    fake.set(
        &a,
        Node::File {
            size: 555,
            modified: "2026-09-30T10:00:00Z".into(),
        },
    );
    let report = restore(&fake, &[&trashed.moved[0].to]);
    assert_eq!(report.restored[0].to, format!("{ROOT}/2026/09/a (2).jpg"));
    assert_eq!(
        fake.find(&a).and_then(|node| node.size()),
        Some(555),
        "the newer file is untouched"
    );
}

#[test]
fn bin_only_files_of_the_bin_can_be_restored() {
    let fake = Fake::new(&with_bin(json!({ DAY: { "a.jpg": 1 }, "loose.jpg": 1 })));
    let before = fake.dump();
    let targets = [
        format!("{ROOT}/2026/09/a.jpg"),
        format!("{BIN}/loose.jpg"),
        format!("{BIN}/{DAY}"),
        format!("{BIN}/not-a-day/x.jpg"),
        "/backups/photos/bob/2026/09/secret.jpg".to_owned(),
        format!("{BIN}/{DAY}/../../2026/09/a.jpg"),
        BIN.to_owned(),
    ];
    let report = block_on(restore_trashed(&fake, ROOT, &targets, |_, _| {})).unwrap();
    assert!(report.restored.is_empty());
    assert_eq!(report.failed.len(), targets.len());
    assert_eq!(fake.dump(), before);
}

#[test]
fn bin_trash_then_restore_leaves_every_photo_where_it_was() {
    let fake = Fake::new(&tree_with_album());
    let sorted_paths = |listing: VaultListing| {
        let mut paths: Vec<String> = listing.photos.into_iter().map(|photo| photo.path).collect();
        paths.sort();
        paths
    };
    let names = sorted_paths(load(&fake).unwrap());
    let trashed = block_on(trash_photos(&fake, &[ROOT], &names, today(), |_, _| {})).unwrap();
    assert!(trashed.failed.is_empty());
    assert!(
        load(&fake).unwrap().photos.is_empty(),
        "the gallery is empty"
    );
    let in_bin = trash_listing(&fake).unwrap();
    assert_eq!(in_bin.items.len(), names.len());
    let paths: Vec<&str> = in_bin.items.iter().map(|item| item.path.as_str()).collect();
    let restored = restore(&fake, &paths);
    assert!(restored.failed.is_empty());
    assert_eq!(sorted_paths(load(&fake).unwrap()), names);
}

#[test]
fn bin_emptying_deletes_the_day_folders_and_nothing_else_in_the_bin() {
    let fake = Fake::new(&with_bin(json!({
        "2026-09-01": { "a.jpg": 1 },
        "2026-10-01": { "b.jpg": 1 },
        "keep.txt": 1,
        "not-a-day": { "c.jpg": 1 }
    })));
    let result = block_on(empty_trash(&fake, ROOT, None, today())).unwrap();
    assert_eq!(
        result,
        EmptiedTrash {
            removed: 2,
            failed: 0
        }
    );
    let left = fake.dump();
    assert!(
        left.contains(&format!("{BIN}/keep.txt"))
            && left.contains(&format!("{BIN}/not-a-day/c.jpg"))
    );
    assert!(
        !left
            .iter()
            .any(|path| path.starts_with(&format!("{BIN}/2026-")))
    );
    assert!(
        left.contains(&format!("{ROOT}/2026/09/a.jpg")),
        "live photos are not touched"
    );
    let none = block_on(empty_trash(&Fake::new(&vault_tree()), ROOT, None, today())).unwrap();
    assert_eq!(none, EmptiedTrash::default(), "no bin, nothing to do");
}

#[test]
fn bin_photos_are_deleted_for_good_only_after_30_days() {
    let fake = Fake::new(&with_bin(json!({
        "2026-09-02": { "exactly30.jpg": 1 },
        "2026-09-03": { "day29.jpg": 1 },
        "2026-08-01": { "older.jpg": 1 },
        "2026-10-02": { "today.jpg": 1 },
        // A clock that was wrong: never purged early.
        "2026-11-15": { "future.jpg": 1 }
    })));
    let result = block_on(purge_expired_trash(&fake, ROOT, today())).unwrap();
    assert_eq!(
        result,
        EmptiedTrash {
            removed: 2,
            failed: 0
        }
    );
    let mut left: Vec<String> = trash_listing(&fake)
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.name)
        .collect();
    left.sort();
    assert_eq!(left, ["day29.jpg", "future.jpg", "today.jpg"]);
}

#[test]
fn bin_a_failing_delete_is_counted_and_a_lost_session_stops_the_purge() {
    let tree = with_bin(json!({
        "2026-07-01": { "a.jpg": 1 },
        "2026-07-02": { "b.jpg": 1 },
        "2026-07-03": { "c.jpg": 1 }
    }));
    let fake = Fake::new(&tree);
    fake.fail(Op::Remove, &format!("{BIN}/2026-07-01"), 500);
    let result = block_on(purge_expired_trash(&fake, ROOT, today())).unwrap();
    assert_eq!(
        result,
        EmptiedTrash {
            removed: 2,
            failed: 1
        }
    );
    let stopped = Fake::new(&tree);
    stopped.fail(Op::Remove, &format!("{BIN}/2026-07-02"), 401);
    let second = block_on(purge_expired_trash(&stopped, ROOT, today())).unwrap();
    assert_eq!(
        second,
        EmptiedTrash {
            removed: 1,
            failed: 1
        }
    );
    assert_eq!(stopped.count(Op::Remove), 2, "stops after the 401");
}

#[test]
fn bin_day_stamps_and_ages() {
    assert_eq!(day_stamp(date(2026, 1, 5)), "2026-01-05");
    assert_eq!(day_stamp(today()), DAY);
    assert_eq!(days_in_bin("2026-10-02", today()), Some(0));
    assert_eq!(days_in_bin("2026-09-02", today()), Some(30));
    assert_eq!(days_in_bin("2025-10-02", today()), Some(365));
    assert_eq!(days_in_bin("2026-10-05", today()), Some(-3));
    assert_eq!(days_in_bin("hello", today()), None);
    assert_eq!(days_in_bin("2026-1-2", today()), None);
    assert_eq!(TRASH_DAYS, 30);
}

// ---- t-migrate ----

#[test]
fn moves_old_backups_into_the_account_folder_merging_with_what_is_there() {
    let fake = Fake::new(&legacy_tree());
    let report = migrate(&fake, LEGACY, ROOT).unwrap();
    assert_eq!(
        (
            report.total,
            report.moved,
            report.skipped,
            report.failed,
            report.cancelled
        ),
        (4, 3, 1, 0, false)
    );
    let tree = fake.dump();
    let has = |path: &str| tree.iter().any(|entry| entry == path);
    for moved in ["/2026/08/a.jpg", "/2026/08/v.mp4", "/2025/12/old.jpg"] {
        assert!(has(&format!("{ROOT}{moved}")), "missing {moved}");
    }
    assert!(
        has(&format!("{ROOT}/2026/09/z.jpg")),
        "what was already there is gone"
    );
    // The clashing photo stays where it was, and so does the file that is not a photo.
    assert!(has(&format!("{LEGACY}/2026/09/b.jpg")) && has(&format!("{LEGACY}/2026/09/notes.txt")));
    assert_eq!(
        fake.find(&format!("{ROOT}/2026/09/b.jpg"))
            .and_then(|node| node.size()),
        Some(99),
        "the file already there was overwritten"
    );
    // Emptied folders go, the rest stays.
    assert!(
        !has(&format!("{LEGACY}/2026/08/"))
            && !has(&format!("{LEGACY}/2025/12/"))
            && !has(&format!("{LEGACY}/2025/"))
    );
    assert!(has(&format!("{LEGACY}/2026/")) && has(&format!("{LEGACY}/")));
    assert_eq!(report.removed_folders, 3);
    assert!(has("/backups/photos/bob/2026/09/secret.jpg"));
}

#[test]
fn migration_only_ever_touches_the_old_folder_and_the_account_folder() {
    let fake = Fake::new(&legacy_tree());
    migrate(&fake, LEGACY, ROOT).unwrap();
    for call in fake.calls() {
        let a = &call.path;
        if call.op == Op::Rename {
            let b = call.to.as_deref().unwrap_or("");
            assert!(
                is_inside(LEGACY, a) && is_inside(ROOT, b),
                "rename {a} -> {b}"
            );
        } else {
            assert!(
                is_inside(LEGACY, a)
                    || is_inside(ROOT, a)
                    || a == "/backups"
                    || a == "/backups/photos",
                "{:?} {a}",
                call.op
            );
        }
    }
}

#[test]
fn migration_can_be_run_again_nothing_moves_twice_nothing_is_lost() {
    let fake = Fake::new(&legacy_tree());
    migrate(&fake, LEGACY, ROOT).unwrap();
    let before = fake.dump();
    let again = migrate(&fake, LEGACY, ROOT).unwrap();
    assert_eq!(
        (again.moved, again.skipped, again.removed_folders),
        (0, 1, 0)
    );
    assert_eq!(fake.dump(), before);
}

#[test]
fn migration_creates_the_account_folder_when_it_does_not_exist_yet() {
    let fake = Fake::new(&json!({ "Appareil photo": { "2026": { "05": { "p.jpg": 1 } } } }));
    let report = migrate(&fake, LEGACY, ROOT).unwrap();
    assert_eq!(report.moved, 1);
    assert!(fake.dump().contains(&format!("{ROOT}/2026/05/p.jpg")));
}

#[test]
fn migration_reports_progress() {
    let fake = Fake::new(&legacy_tree());
    let mut steps = Vec::new();
    block_on(migrate_backups(
        &fake,
        LEGACY,
        ROOT,
        || false,
        |done, total| steps.push(format!("{done}/{total}")),
    ))
    .unwrap();
    assert_eq!(steps, ["1/4", "2/4", "3/4", "4/4"]);
}

// ---- t-migrate2 ----

#[test]
fn stopping_a_migration_part_way_leaves_everything_consistent_and_cleans_nothing_up() {
    let fake = Fake::new(&legacy_tree());
    let moves = Cell::new(0);
    let report = block_on(migrate_backups(
        &fake,
        LEGACY,
        ROOT,
        || moves.get() >= 1,
        |_, _| moves.set(moves.get() + 1),
    ))
    .unwrap();
    assert!(report.cancelled);
    assert_eq!(report.moved, 1);
    assert_eq!(fake.count(Op::Remove), 0);
    let finished = migrate(&fake, LEGACY, ROOT).unwrap();
    assert_eq!(finished.moved + 1, 3);
}

#[test]
fn one_file_failing_does_not_stop_the_others() {
    let fake = Fake::new(&legacy_tree());
    fake.fail(Op::Rename, &format!("{LEGACY}/2026/08/a.jpg"), 500);
    let report = migrate(&fake, LEGACY, ROOT).unwrap();
    assert_eq!(report.failed, 1);
    assert_eq!(report.moved, 2);
    assert!(report.errors[0].contains("a.jpg"), "{:?}", report.errors);
    assert!(
        fake.dump().contains(&format!("{LEGACY}/2026/08/a.jpg")),
        "the file that failed must stay where it was"
    );
}

#[test]
fn a_lost_session_stops_the_migration_and_removes_nothing() {
    let fake = Fake::new(&legacy_tree());
    for path in [
        "/2026/08/a.jpg",
        "/2026/08/v.mp4",
        "/2026/09/b.jpg",
        "/2025/12/old.jpg",
    ] {
        fake.fail(Op::Rename, &format!("{LEGACY}{path}"), 401);
    }
    let report = migrate(&fake, LEGACY, ROOT).unwrap();
    assert!(report.failed >= 1 && report.moved == 0);
    assert_eq!(fake.count(Op::Rename), 1, "should stop at the first 401");
    assert_eq!(fake.count(Op::Remove), 0);
}

#[test]
fn folders_that_overlap_are_refused_before_anything_is_touched() {
    let new = format!("{LEGACY}/new");
    let escape = format!("{LEGACY}/../x");
    for (from, to) in [
        ("/", ROOT),
        (LEGACY, LEGACY),
        ("/backups", ROOT),
        (LEGACY, new.as_str()),
        (LEGACY, escape.as_str()),
    ] {
        let fake = Fake::new(&legacy_tree());
        let before = fake.dump();
        match migrate(&fake, from, to) {
            Ok(_) => panic!("accepted {from} -> {to}"),
            Err(err) => assert_eq!(
                err.code,
                VaultErrorCode::ForbiddenPath,
                "{from} -> {to}: {}",
                err.message
            ),
        }
        assert_eq!(fake.dump(), before);
        assert!(fake.calls().is_empty());
    }
}

#[test]
fn an_old_folder_that_is_not_there_is_nothing_to_do() {
    let fake = Fake::new(&json!({ "backups": { "photos": { "alice": {} } } }));
    let report = migrate(&fake, LEGACY, ROOT).unwrap();
    assert_eq!((report.total, report.moved, report.failed), (0, 0, 0));
}

#[test]
fn names_that_lead_out_of_the_old_folder_are_never_followed() {
    let mut tree = legacy_tree();
    tree["Appareil photo"][".."] = json!({ "loot.jpg": 1 });
    tree["Appareil photo"]["a/b.jpg"] = json!(1);
    let fake = Fake::new(&tree);
    let report = migrate(&fake, LEGACY, ROOT).unwrap();
    assert_eq!(report.total, 4);
    for call in fake.calls() {
        assert!(
            !call.path.contains("..") && !call.to.as_deref().unwrap_or("").contains(".."),
            "asked for {}",
            call.path
        );
    }
}

#[test]
fn finds_out_whether_an_old_folder_has_backups_in_it() {
    assert!(block_on(has_backups(&Fake::new(&legacy_tree()), LEGACY)));
    assert!(!block_on(has_backups(&Fake::new(&json!({})), LEGACY)));
    assert!(!block_on(has_backups(
        &Fake::new(&json!({ "Appareil photo": {} })),
        LEGACY
    )));
    let broken = Fake::new(&legacy_tree());
    broken.fail(Op::List, LEGACY, 500);
    assert!(!block_on(has_backups(&broken, LEGACY)));
}

// ---- t-peers ----

fn peer_items() -> Vec<VaultItem> {
    let folder = |name: &str| VaultItem {
        name: name.into(),
        is_dir: true,
        ..VaultItem::default()
    };
    vec![
        folder("alice"),
        folder("bob"),
        folder("carol"),
        VaultItem {
            name: "readme.txt".into(),
            size: 3,
            ..VaultItem::default()
        },
    ]
}

fn names_of(items: &[VaultItem]) -> Vec<&str> {
    items.iter().map(|item| item.name.as_str()).collect()
}

#[test]
fn inside_the_central_folder_an_account_sees_only_its_own_folder() {
    let alice = hide_peer_folders(
        peer_items(),
        "/backups/photos",
        DEFAULT_BACKUP_FOLDER,
        "alice",
    );
    assert_eq!(names_of(&alice), ["alice", "readme.txt"]);
    let bob = hide_peer_folders(
        peer_items(),
        "/backups/photos/",
        DEFAULT_BACKUP_FOLDER,
        "bob",
    );
    assert_eq!(names_of(&bob), ["bob", "readme.txt"]);
}

#[test]
fn nothing_is_hidden_anywhere_else() {
    for (dir, template) in [
        ("/backups", DEFAULT_BACKUP_FOLDER),
        ("/backups/photos/alice", DEFAULT_BACKUP_FOLDER),
        ("/backups/photos", "/Appareil photo"),
        ("/", "/{user}"),
    ] {
        assert_eq!(
            hide_peer_folders(peer_items(), dir, template, "alice"),
            peer_items(),
            "{dir} {template}"
        );
    }
}

#[test]
fn a_name_that_cannot_be_a_folder_hides_nothing_and_breaks_nothing() {
    assert_eq!(
        hide_peer_folders(peer_items(), "/backups/photos", DEFAULT_BACKUP_FOLDER, ""),
        peer_items()
    );
    assert_eq!(
        hide_peer_folders(peer_items(), "/backups/photos", "/a/../{user}", "alice"),
        peer_items()
    );
}

// ---- t-albums ----

#[test]
fn album_folder_names_keep_the_album_readable_and_cannot_lead_out_of_the_account_folder() {
    for (title, folder) in [
        ("Screenshots", "Screenshots"),
        ("WhatsApp Images", "WhatsApp Images"),
        ("Événements été", "Événements été"),
        ("a/b", "a~2f~b"),
        ("..", "~2e~~2e~"),
        (".hidden", "~2e~hidden"),
        // Would be taken for a year, or for the bin.
        ("2024", "2024 (album)"),
        ("Corbeille", "Corbeille (album)"),
        ("corbeille", "corbeille (album)"),
    ] {
        assert_eq!(album_folder_name(title).unwrap(), folder, "{title}");
    }
    assert!(album_folder_name("   ").is_err());
    assert!(album_folder_name(&"x".repeat(300)).is_err());
    for title in ["Screenshots", "../../bob", "a/../b", "x y", "2024"] {
        let folder = album_folder_name(title).unwrap();
        assert!(
            is_inside(ROOT, &format!("{ROOT}/{folder}/2026/09/p.jpg")),
            "{title}"
        );
    }
}

#[test]
fn albums_the_gallery_knows_which_album_each_photo_came_from() {
    let listing = load(&Fake::new(&album_tree())).unwrap();
    let place = |name| {
        let photo = photo(&listing, name);
        (photo.album.as_deref(), photo.year, photo.month)
    };
    assert_eq!(
        place("a.jpg").0,
        None,
        "camera photos sit straight in year/month folders"
    );
    assert_eq!(
        place("shot.png"),
        (Some("Screenshots"), Some(2026), Some(9))
    );
    assert_eq!(
        photo(&listing, "shot.png").path,
        format!("{ROOT}/Screenshots/2026/09/shot.png")
    );
    assert_eq!(
        photo(&listing, "shot.png").relative,
        "Screenshots/2026/09/shot.png"
    );
    assert_eq!(
        place("wa.jpg"),
        (Some("WhatsApp Images"), Some(2026), Some(8))
    );
    assert_eq!(place("loose.jpg"), (Some("WhatsApp Images"), None, None));
    assert_eq!(photo(&listing, "recording.mp4").kind, MediaKind::Video);
    assert_eq!(photo(&listing, "shot.png").kind, MediaKind::Photo);
}

#[test]
fn albums_the_bin_is_not_part_of_the_gallery_and_is_not_even_read() {
    let fake = Fake::new(&album_tree());
    let listing = load(&fake).unwrap();
    assert!(!has(&listing, "binned.jpg"));
    assert!(
        !fake
            .calls()
            .iter()
            .any(|call| call.path.contains("Corbeille")),
        "the bin was listed"
    );
}

#[test]
fn albums_an_album_folder_named_like_the_bin_deeper_down_is_still_read() {
    let mut tree = album_tree();
    tree["backups"]["photos"]["alice"]["Screenshots"]["Corbeille"] = json!({ "inner.png": 3 });
    assert!(has(&load(&Fake::new(&tree)).unwrap(), "inner.png"));
}

#[test]
fn albums_reading_goes_down_to_album_year_month_and_no_further() {
    let fake = Fake::new(&album_tree());
    let listing = load(&fake).unwrap();
    assert!(has(&listing, "shot.png"), "album/year/month is read");
    assert!(!has(&listing, "z.jpg"), "a fifth level is not");
    assert!(!fake.calls().iter().any(|call| call.path.ends_with("/w")));
}

#[test]
fn modified_times_are_read_as_javascript_reads_them() {
    assert_eq!(parse_time("2026-09-15T10:00:00Z"), 1_789_466_400_000);
    assert_eq!(parse_time("2026-09-15T12:00:00+02:00"), 1_789_466_400_000);
    assert_eq!(parse_time("2026-09-15"), 1_789_430_400_000);
    assert_eq!(parse_time(""), 0);
    assert_eq!(parse_time("yesterday"), 0);
}

#[test]
fn the_folder_walk_never_runs_more_than_four_listings_and_hands_slots_on() {
    // Every folder at one level: the walk keeps four in flight until the queue runs dry.
    let mut alice = Map::new();
    for i in 0..10 {
        alice.insert(format!("{:04}", 2000 + i), json!({ "p.jpg": 1 }));
    }
    let fake = Fake::new(&json!({ "backups": { "photos": { "alice": alice } } }));
    let order = RefCell::new(Vec::new());
    let listing = block_on(load_photos(
        &fake,
        ROOT,
        NO_FOLDERS,
        || false,
        |photos| order.borrow_mut().push(photos.len()),
    ))
    .unwrap();
    assert_eq!(listing.photos.len(), 10);
    assert_eq!(fake.peak(), 4);
    assert_eq!(*order.borrow(), (1..=10).collect::<Vec<_>>());
}
