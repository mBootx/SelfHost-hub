//! Sorting, filtering and laying out the photo gallery and its bin. Port of `mobile/src/services/photoLayout.ts`.

use std::cmp::Ordering;
use std::collections::HashMap;

use jiff::civil::Date;
use unicode_normalization::UnicodeNormalization;

use crate::text::compare_numeric;
use crate::vault::{MediaKind, Photo, TRASH_DAYS, TrashedPhoto, days_in_bin};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Newest,
    Oldest,
    NameAsc,
    NameDesc,
    Largest,
    Smallest,
}

impl SortKey {
    pub const ALL: [Self; 6] = [
        Self::Newest,
        Self::Oldest,
        Self::NameAsc,
        Self::NameDesc,
        Self::Largest,
        Self::Smallest,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Newest => "Plus récentes",
            Self::Oldest => "Plus anciennes",
            Self::NameAsc => "Nom (A → Z)",
            Self::NameDesc => "Nom (Z → A)",
            Self::Largest => "Plus volumineuses",
            Self::Smallest => "Plus légères",
        }
    }

    /// The name the phone app saves the choice under.
    pub fn id(self) -> &'static str {
        match self {
            Self::Newest => "newest",
            Self::Oldest => "oldest",
            Self::NameAsc => "name-asc",
            Self::NameDesc => "name-desc",
            Self::Largest => "largest",
            Self::Smallest => "smallest",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|key| key.id() == id)
    }

    /// Sorted by date, the grid is grouped under a header per month.
    pub fn is_by_date(self) -> bool {
        matches!(self, Self::Newest | Self::Oldest)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindFilter {
    All,
    Photo,
    Video,
}

impl KindFilter {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "Tout",
            Self::Photo => "Photos",
            Self::Video => "Vidéos",
        }
    }
}

pub fn filter_by_kind(photos: &[Photo], kind: KindFilter) -> Vec<Photo> {
    let wanted = match kind {
        KindFilter::All => return photos.to_vec(),
        KindFilter::Photo => MediaKind::Photo,
        KindFilter::Video => MediaKind::Video,
    };
    photos
        .iter()
        .filter(|photo| photo.kind == wanted)
        .cloned()
        .collect()
}

/// Every album.
pub const ALL_ALBUMS: &str = "*";
/// The camera's own photos, which sit in no album folder.
pub const CAMERA_ALBUM: &str = "";

fn album_id(photo: &Photo) -> &str {
    photo.album.as_deref().unwrap_or(CAMERA_ALBUM)
}

pub fn filter_by_album(photos: &[Photo], album: &str) -> Vec<Photo> {
    if album == ALL_ALBUMS {
        return photos.to_vec();
    }
    photos
        .iter()
        .filter(|photo| album_id(photo) == album)
        .cloned()
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumChip {
    /// [`ALL_ALBUMS`], [`CAMERA_ALBUM`] or the album's folder name.
    pub id: String,
    pub label: String,
    pub count: usize,
}

/// The albums to offer as filters: all of them, the camera, then the others by name. Nothing is offered while
/// everything is in one place: a filter that changes nothing is only noise.
pub fn album_chips(photos: &[Photo]) -> Vec<AlbumChip> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for photo in photos {
        *counts.entry(album_id(photo)).or_default() += 1;
    }
    if counts.len() < 2 {
        return Vec::new();
    }
    let mut others: Vec<&str> = counts
        .keys()
        .copied()
        .filter(|id| *id != CAMERA_ALBUM)
        .collect();
    others.sort_by(|a, b| compare_numeric(a, b));
    let mut chips = vec![AlbumChip {
        id: ALL_ALBUMS.into(),
        label: "Tous les albums".into(),
        count: photos.len(),
    }];
    if let Some(&count) = counts.get(CAMERA_ALBUM) {
        chips.push(AlbumChip {
            id: CAMERA_ALBUM.into(),
            label: "Appareil photo".into(),
            count,
        });
    }
    for id in others {
        chips.push(AlbumChip {
            id: id.into(),
            label: id.into(),
            count: counts[id],
        });
    }
    chips
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count > 1 { many } else { one })
}

/// "12 photos · 3 vidéos", leaving out what there is none of.
pub fn count_label(photos: &[Photo]) -> String {
    let videos = photos
        .iter()
        .filter(|photo| photo.kind == MediaKind::Video)
        .count();
    let pictures = photos.len() - videos;
    let mut parts = Vec::new();
    if pictures > 0 || videos == 0 {
        parts.push(plural(pictures, "photo", "photos"));
    }
    if videos > 0 {
        parts.push(plural(videos, "vidéo", "vidéos"));
    }
    parts.join(" · ")
}

/// Year and month of the folder a photo is filed in, as one number; photos outside year/month folders sort last.
fn month_key(photo: &Photo) -> i64 {
    match photo.year {
        None => -1,
        Some(year) => i64::from(year) * 100 + i64::from(photo.month.unwrap_or(0)),
    }
}

/// JavaScript's `localeCompare` for the paths that break ties between photos of the same name.
fn compare_paths(a: &str, b: &str) -> Ordering {
    compare_numeric(a, b).then_with(|| a.cmp(b))
}

fn newest_first(a: &Photo, b: &Photo) -> Ordering {
    month_key(b)
        .cmp(&month_key(a))
        .then(b.modified.cmp(&a.modified))
        .then_with(|| compare_numeric(&b.name, &a.name))
}

/// A sorted copy. By date it follows the year/month folders, then when the server last saw the file, then the name.
pub fn sort_photos(photos: &[Photo], key: SortKey) -> Vec<Photo> {
    let mut sorted = photos.to_vec();
    match key {
        SortKey::Newest => sorted.sort_by(newest_first),
        SortKey::Oldest => sorted.sort_by(|a, b| newest_first(b, a)),
        SortKey::NameAsc => sorted.sort_by(|a, b| {
            compare_numeric(&a.name, &b.name).then_with(|| compare_paths(&a.path, &b.path))
        }),
        SortKey::NameDesc => sorted.sort_by(|a, b| {
            compare_numeric(&b.name, &a.name).then_with(|| compare_paths(&b.path, &a.path))
        }),
        SortKey::Largest => {
            sorted.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| newest_first(a, b)))
        }
        SortKey::Smallest => {
            sorted.sort_by(|a, b| a.size.cmp(&b.size).then_with(|| newest_first(a, b)))
        }
    }
    sorted
}

/// What JavaScript's `trim()` takes off.
fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// Lowercased with its accents dropped, so "é" matches "e": the decomposed accents are the combining marks U+0300
/// to U+036F.
fn fold(text: &str) -> String {
    let plain: String = text
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect();
    plain.to_lowercase().trim_matches(is_js_space).to_owned()
}

/// Photos whose name contains every word typed, ignoring case and accents.
pub fn filter_photos(photos: &[Photo], query: &str) -> Vec<Photo> {
    let query = fold(query);
    let words: Vec<&str> = query.split(' ').filter(|word| !word.is_empty()).collect();
    if words.is_empty() {
        return photos.to_vec();
    }
    photos
        .iter()
        .filter(|photo| {
            let name = fold(&photo.name);
            words.iter().all(|word| name.contains(word))
        })
        .cloned()
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GridRow<'a> {
    Header {
        key: String,
        title: String,
        count: usize,
    },
    /// `first_index` is the position in the list of the row's first photo, so a tap can open the viewer there.
    Photos {
        key: String,
        photos: &'a [Photo],
        first_index: usize,
    },
}

const MONTHS: [&str; 12] = [
    "Janvier",
    "Février",
    "Mars",
    "Avril",
    "Mai",
    "Juin",
    "Juillet",
    "Août",
    "Septembre",
    "Octobre",
    "Novembre",
    "Décembre",
];

pub fn month_title(year: Option<i32>, month: Option<u32>) -> String {
    let Some(year) = year else {
        return "Autres photos".into();
    };
    match month.and_then(|month| MONTHS.get((month as usize).wrapping_sub(1))) {
        Some(name) => format!("{name} {year}"),
        None => year.to_string(),
    }
}

/// Rows for the grid, `columns` photos to a row. Sorted by date the photos are grouped under a header per month;
/// any other order is one plain run.
pub fn build_rows<'a>(photos: &'a [Photo], columns: usize, grouped: bool) -> Vec<GridRow<'a>> {
    let columns = columns.max(1);
    let mut rows = Vec::new();
    let push_run = |rows: &mut Vec<GridRow<'a>>, start: usize, end: usize, group: &str| {
        let mut i = start;
        while i < end {
            let stop = (i + columns).min(end);
            rows.push(GridRow::Photos {
                key: format!("{group}:{i}"),
                photos: &photos[i..stop],
                first_index: i,
            });
            i = stop;
        }
    };
    if !grouped {
        push_run(&mut rows, 0, photos.len(), "all");
        return rows;
    }
    let mut start = 0;
    while start < photos.len() {
        let key = month_key(&photos[start]);
        let end = start
            + photos[start..]
                .iter()
                .take_while(|photo| month_key(photo) == key)
                .count();
        rows.push(GridRow::Header {
            key: format!("h:{key}"),
            title: month_title(photos[start].year, photos[start].month),
            count: end - start,
        });
        push_run(&mut rows, start, end, &format!("m:{key}"));
        start = end;
    }
    rows
}

/// "512 o", "2.0 Ko", "5.3 Mo"; "-" for nothing.
pub fn format_size(bytes: u64) -> String {
    if bytes == 0 {
        return "-".into();
    }
    const UNITS: [&str; 4] = ["o", "Ko", "Mo", "Go"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        return format!("{bytes} o");
    }
    // Rounded half up, as JavaScript's toFixed does.
    format!("{:.1} {}", (value * 10.0 + 0.5).floor() / 10.0, UNITS[unit])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrashRow<'a> {
    Header {
        key: String,
        day: String,
        count: usize,
    },
    Items {
        key: String,
        items: &'a [TrashedPhoto],
        first_index: usize,
    },
}

/// Rows for the bin's grid: a header per day it was deleted on, then that day's files, `columns` to a row. Items
/// must already be sorted by day.
pub fn build_trash_rows(items: &[TrashedPhoto], columns: usize) -> Vec<TrashRow<'_>> {
    let columns = columns.max(1);
    let mut rows = Vec::new();
    let mut start = 0;
    while start < items.len() {
        let day = &items[start].trashed_on;
        let end = start
            + items[start..]
                .iter()
                .take_while(|item| item.trashed_on == *day)
                .count();
        rows.push(TrashRow::Header {
            key: format!("h:{day}"),
            day: day.clone(),
            count: end - start,
        });
        let mut i = start;
        while i < end {
            let stop = (i + columns).min(end);
            rows.push(TrashRow::Items {
                key: format!("d:{day}:{i}"),
                items: &items[i..stop],
                first_index: i,
            });
            i = stop;
        }
        start = end;
    }
    rows
}

/// "02/10/2026" from a bin day folder's name.
pub fn format_bin_day(day: &str) -> String {
    let mut parts = day.split('-');
    let (year, month, date) = (
        parts.next().unwrap_or(""),
        parts.next().unwrap_or(""),
        parts.next().unwrap_or(""),
    );
    format!("{date}/{month}/{year}")
}

/// How long a day's files stay in the bin: "il reste 28 jours".
pub fn bin_time_left(day: &str, today: Date) -> String {
    let Some(age) = days_in_bin(day, today) else {
        return String::new();
    };
    match TRASH_DAYS - age {
        left if left <= 0 => "sera supprimé très bientôt".into(),
        1 => "il reste 1 jour".into(),
        left => format!("il reste {left} jours"),
    }
}

// Ported from mobile/tests/vault/t-layout.js, t-filters.js and the sorting case of t-albums.js.
#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::date;

    fn photo(name: &str, year: Option<i32>, month: Option<u32>, size: u64, modified: i64) -> Photo {
        Photo {
            path: format!("/r/{name}"),
            name: name.into(),
            kind: MediaKind::Photo,
            size,
            modified,
            year,
            month,
            album: None,
            relative: String::new(),
            has_preview: None,
        }
    }

    fn names(photos: &[Photo]) -> Vec<&str> {
        photos.iter().map(|photo| photo.name.as_str()).collect()
    }

    fn sample() -> Vec<Photo> {
        vec![
            photo("b.jpg", Some(2026), Some(8), 300, 5),
            photo("a.jpg", Some(2026), Some(9), 100, 1),
            photo("c.jpg", Some(2025), Some(12), 200, 9),
            photo("d.jpg", Some(2026), Some(9), 500, 7),
            photo("stray.jpg", None, None, 50, 99),
        ]
    }

    #[test]
    fn newest_first_follows_the_month_folders_then_time_and_puts_strays_last() {
        let sorted = sort_photos(&sample(), SortKey::Newest);
        assert_eq!(
            names(&sorted),
            ["d.jpg", "a.jpg", "b.jpg", "c.jpg", "stray.jpg"]
        );
    }

    #[test]
    fn oldest_first_is_the_exact_reverse() {
        let sorted = sort_photos(&sample(), SortKey::Oldest);
        assert_eq!(
            names(&sorted),
            ["stray.jpg", "c.jpg", "b.jpg", "a.jpg", "d.jpg"]
        );
    }

    #[test]
    fn names_sort_the_way_people_count() {
        let list: Vec<Photo> = [
            "IMG_10.jpg",
            "IMG_2.jpg",
            "img_1.jpg",
            "Ébène.jpg",
            "zèbre.jpg",
        ]
        .into_iter()
        .map(|name| photo(name, Some(2026), Some(1), 100, 0))
        .collect();
        let ascending = sort_photos(&list, SortKey::NameAsc);
        assert_eq!(
            names(&ascending),
            [
                "Ébène.jpg",
                "img_1.jpg",
                "IMG_2.jpg",
                "IMG_10.jpg",
                "zèbre.jpg"
            ]
        );
        let sorted = sort_photos(&list, SortKey::NameDesc);
        let mut descending = names(&sorted);
        descending.reverse();
        assert_eq!(descending, names(&ascending));
    }

    #[test]
    fn by_size_both_ways_and_the_input_is_left_alone() {
        let input = sample();
        let before = names(&input).join(",");
        assert_eq!(
            names(&sort_photos(&input, SortKey::Largest))[..2],
            ["d.jpg", "b.jpg"]
        );
        assert_eq!(
            names(&sort_photos(&input, SortKey::Smallest))[..2],
            ["stray.jpg", "a.jpg"]
        );
        assert_eq!(names(&input).join(","), before);
    }

    #[test]
    fn search_matches_every_word_ignoring_case_and_accents() {
        let list: Vec<Photo> = [
            "Été_plage.jpg",
            "ete_montagne.jpg",
            "hiver_plage.jpg",
            "IMG_0001.jpg",
        ]
        .into_iter()
        .map(|name| photo(name, Some(2026), Some(1), 100, 0))
        .collect();
        assert_eq!(
            names(&filter_photos(&list, "ete")),
            ["Été_plage.jpg", "ete_montagne.jpg"]
        );
        assert_eq!(names(&filter_photos(&list, "PLAGE ÉTÉ")), ["Été_plage.jpg"]);
        assert!(filter_photos(&list, "nothing").is_empty());
        assert_eq!(filter_photos(&list, "   "), list);
    }

    #[test]
    fn the_grid_groups_by_month_under_headers_three_to_a_row() {
        let mut photos = sample();
        photos.push(photo("e.jpg", Some(2026), Some(9), 100, 0));
        photos.push(photo("f.jpg", Some(2026), Some(9), 100, 0));
        let list = sort_photos(&photos, SortKey::Newest);
        let rows = build_rows(&list, 3, true);
        let summary: Vec<String> = rows
            .iter()
            .map(|row| match row {
                GridRow::Header { title, count, .. } => format!("{title} ({count})"),
                GridRow::Photos {
                    photos,
                    first_index,
                    ..
                } => format!("{}@{first_index}", photos.len()),
            })
            .collect();
        assert_eq!(
            summary,
            [
                "Septembre 2026 (4)",
                "3@0",
                "1@3",
                "Août 2026 (1)",
                "1@4",
                "Décembre 2025 (1)",
                "1@5",
                "Autres photos (1)",
                "1@6"
            ]
        );
        let keys: std::collections::HashSet<&String> = rows
            .iter()
            .map(|row| match row {
                GridRow::Header { key, .. } | GridRow::Photos { key, .. } => key,
            })
            .collect();
        assert_eq!(keys.len(), rows.len(), "row keys must be unique");
    }

    #[test]
    fn any_other_order_is_one_plain_run_with_no_headers() {
        let list = sort_photos(&sample(), SortKey::NameAsc);
        let rows = build_rows(&list, 2, false);
        let runs: Vec<(usize, usize)> = rows
            .iter()
            .map(|row| match row {
                GridRow::Photos {
                    photos,
                    first_index,
                    ..
                } => (photos.len(), *first_index),
                GridRow::Header { .. } => panic!("a header in a plain run"),
            })
            .collect();
        assert_eq!(runs, [(2, 0), (2, 2), (1, 4)]);
        assert!(build_rows(&[], 3, true).is_empty());
    }

    #[test]
    fn sizes_are_readable() {
        assert_eq!(format_size(0), "-");
        assert_eq!(format_size(512), "512 o");
        assert_eq!(format_size(2048), "2.0 Ko");
        assert_eq!(format_size(5 * 1024 * 1024 + 300_000), "5.3 Mo");
        // 1.25 Ko: toFixed rounds the half up.
        assert_eq!(format_size(1280), "1.3 Ko");
    }

    fn in_album(name: &str, album: Option<&str>, kind: MediaKind) -> Photo {
        Photo {
            path: format!("/r/{}/{name}", album.unwrap_or("")),
            album: album.map(str::to_owned),
            kind,
            ..photo(name, Some(2026), Some(9), 1, 1)
        }
    }

    fn all() -> Vec<Photo> {
        vec![
            in_album("a.jpg", None, MediaKind::Photo),
            in_album("b.jpg", None, MediaKind::Photo),
            in_album("c.mp4", None, MediaKind::Video),
            in_album("s.png", Some("Screenshots"), MediaKind::Photo),
            in_album("w.jpg", Some("WhatsApp Images"), MediaKind::Photo),
            in_album("r.mp4", Some("Screenshots"), MediaKind::Video),
        ]
    }

    #[test]
    fn filters_photos_videos_or_both() {
        assert_eq!(filter_by_kind(&all(), KindFilter::All).len(), 6);
        assert_eq!(
            names(&filter_by_kind(&all(), KindFilter::Photo)),
            ["a.jpg", "b.jpg", "s.png", "w.jpg"]
        );
        assert_eq!(
            names(&filter_by_kind(&all(), KindFilter::Video)),
            ["c.mp4", "r.mp4"]
        );
    }

    #[test]
    fn filters_one_album_the_camera_alone_or_all() {
        assert_eq!(filter_by_album(&all(), ALL_ALBUMS).len(), 6);
        assert_eq!(
            names(&filter_by_album(&all(), CAMERA_ALBUM)),
            ["a.jpg", "b.jpg", "c.mp4"]
        );
        assert_eq!(
            names(&filter_by_album(&all(), "Screenshots")),
            ["s.png", "r.mp4"]
        );
        assert!(filter_by_album(&all(), "Nothing").is_empty());
    }

    #[test]
    fn album_chips_list_the_camera_first_and_the_others_by_name_with_their_counts() {
        let chips = album_chips(&all());
        let summary: Vec<(&str, &str, usize)> = chips
            .iter()
            .map(|chip| (chip.id.as_str(), chip.label.as_str(), chip.count))
            .collect();
        assert_eq!(
            summary,
            [
                (ALL_ALBUMS, "Tous les albums", 6),
                (CAMERA_ALBUM, "Appareil photo", 3),
                ("Screenshots", "Screenshots", 2),
                ("WhatsApp Images", "WhatsApp Images", 1)
            ]
        );
    }

    #[test]
    fn no_album_chips_while_everything_is_in_one_place() {
        let only = |keep: fn(&Photo) -> bool| all().into_iter().filter(keep).collect::<Vec<_>>();
        assert!(album_chips(&only(|photo| photo.album.is_none())).is_empty());
        assert!(
            album_chips(&only(|photo| photo.album.as_deref() == Some("Screenshots"))).is_empty()
        );
        assert!(album_chips(&[]).is_empty());
        // An account that only backs up albums (no camera photos) still gets chips, without a camera chip.
        let chips = album_chips(&only(|photo| photo.album.is_some()));
        let labels: Vec<&str> = chips.iter().map(|chip| chip.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Tous les albums", "Screenshots", "WhatsApp Images"]
        );
    }

    #[test]
    fn the_count_says_photos_and_videos_leaving_out_what_there_is_none_of() {
        let all = all();
        assert_eq!(count_label(&all), "4 photos · 2 vidéos");
        assert_eq!(count_label(&all[..1]), "1 photo");
        assert_eq!(count_label(&all[2..3]), "1 vidéo");
        assert_eq!(
            count_label(&filter_by_kind(&all, KindFilter::Video)),
            "2 vidéos"
        );
        assert_eq!(count_label(&[]), "0 photo");
        assert_eq!(
            count_label(&[all[0].clone(), all[2].clone(), all[5].clone()]),
            "1 photo · 2 vidéos"
        );
    }

    #[test]
    fn the_search_still_works_on_top_of_the_others() {
        let found = filter_photos(&filter_by_kind(&all(), KindFilter::Video), "R.MP4");
        assert_eq!(names(&found), ["r.mp4"]);
    }

    #[test]
    fn sorting_by_date_keeps_the_camera_and_the_albums_in_one_timeline() {
        let photos = [
            Photo {
                path: "/r/2026/09/a.jpg".into(),
                ..photo("a.jpg", Some(2026), Some(9), 1, 1)
            },
            Photo {
                path: "/r/S/2026/09/s.png".into(),
                album: Some("S".into()),
                ..photo("s.png", Some(2026), Some(9), 1, 2)
            },
            Photo {
                path: "/r/S/2025/01/old.jpg".into(),
                album: Some("S".into()),
                ..photo("old.jpg", Some(2025), Some(1), 1, 1)
            },
        ];
        assert_eq!(
            names(&sort_photos(&photos, SortKey::Newest)),
            ["s.png", "a.jpg", "old.jpg"]
        );
    }

    fn trashed(name: &str, day: &str) -> TrashedPhoto {
        TrashedPhoto {
            path: format!("/b/{day}/{name}"),
            name: name.into(),
            kind: MediaKind::Photo,
            size: 1,
            modified: 1,
            has_preview: None,
            trashed_on: day.into(),
            original_path: format!("/r/{name}"),
        }
    }

    #[test]
    fn bin_grid_a_header_per_day_then_its_files_in_rows() {
        let items = [
            trashed("a", "2026-10-01"),
            trashed("b", "2026-10-01"),
            trashed("c", "2026-10-01"),
            trashed("d", "2026-09-20"),
        ];
        let rows = build_trash_rows(&items, 2);
        let mut headers = Vec::new();
        let mut runs = Vec::new();
        let mut keys = std::collections::HashSet::new();
        for row in &rows {
            match row {
                TrashRow::Header { key, day, count } => {
                    keys.insert(key.clone());
                    headers.push((day.as_str(), *count));
                }
                TrashRow::Items {
                    key,
                    items,
                    first_index,
                } => {
                    keys.insert(key.clone());
                    runs.push((
                        *first_index,
                        items
                            .iter()
                            .map(|item| item.name.as_str())
                            .collect::<Vec<_>>(),
                    ));
                }
            }
        }
        assert_eq!(headers, [("2026-10-01", 3), ("2026-09-20", 1)]);
        assert_eq!(runs, [(0, vec!["a", "b"]), (2, vec!["c"]), (3, vec!["d"])]);
        assert_eq!(keys.len(), rows.len(), "row keys are unique");
        assert!(build_trash_rows(&[], 3).is_empty());
    }

    #[test]
    fn bin_grid_days_are_written_and_counted_down_for_the_user() {
        let today = date(2026, 10, 2);
        assert_eq!(format_bin_day("2026-10-01"), "01/10/2026");
        assert_eq!(bin_time_left("2026-10-02", today), "il reste 30 jours");
        assert_eq!(bin_time_left("2026-09-04", today), "il reste 2 jours");
        assert_eq!(bin_time_left("2026-09-03", today), "il reste 1 jour");
        assert_eq!(
            bin_time_left("2026-09-02", today),
            "sera supprimé très bientôt"
        );
        assert_eq!(
            bin_time_left("2026-01-01", today),
            "sera supprimé très bientôt"
        );
        assert_eq!(bin_time_left("garbage", today), "");
    }
}
