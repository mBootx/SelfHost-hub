//! Picking files whose names are already in the folder: which ones clash, and what to send once the user has
//! chosen what to do about them.
//!
//! Port of `mobile/src/services/uploadConflicts.ts`. The numbering of a taken name ("a (2).jpg") is not repeated
//! here: it is [`free_name`] of the `paths` module, which already ports `fileNames.ts`.

use std::collections::HashSet;

use crate::paths::free_name;

/// What to do with a picked file whose name is already taken in the folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictChoice {
    Replace,
    KeepBoth,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedUpload {
    /// Position of the file in the picked list.
    pub index: usize,
    /// The name to send it under.
    pub name: String,
    /// Replace what is on the server under that name.
    pub override_existing: bool,
}

/// The picked files, by position, whose names are already taken in the folder.
pub fn find_conflicts(names: &[String], taken: &HashSet<String>) -> Vec<usize> {
    names
        .iter()
        .enumerate()
        .filter(|(_, name)| taken.contains(*name))
        .map(|(index, _)| index)
        .collect()
}

/// What to send once the user has said what to do about the clashing names. A file that clashes with one
/// picked just before it always gets a new name, whatever the choice: replacing one picked file with another
/// is never what anyone means.
pub fn plan_uploads(
    names: &[String],
    taken: &HashSet<String>,
    choice: ConflictChoice,
) -> Vec<PlannedUpload> {
    // `used` is every name that is, or will be, in the folder; `picked` the names given to files earlier in the list.
    let mut used = taken.clone();
    let mut picked: HashSet<String> = HashSet::new();
    let mut plan = Vec::new();
    for (index, name) in names.iter().enumerate() {
        if picked.contains(name) {
            let renamed = free_name(name, &used);
            used.insert(renamed.clone());
            picked.insert(renamed.clone());
            plan.push(keep(index, renamed));
            continue;
        }
        picked.insert(name.clone());
        if !taken.contains(name) {
            used.insert(name.clone());
            plan.push(keep(index, name.clone()));
            continue;
        }
        match choice {
            ConflictChoice::Skip => {}
            ConflictChoice::Replace => plan.push(PlannedUpload {
                index,
                name: name.clone(),
                override_existing: true,
            }),
            ConflictChoice::KeepBoth => {
                let renamed = free_name(name, &used);
                used.insert(renamed.clone());
                picked.insert(renamed.clone());
                plan.push(keep(index, renamed));
            }
        }
    }
    plan
}

/// A file sent under `name` without touching what the server already has.
fn keep(index: usize, name: String) -> PlannedUpload {
    PlannedUpload {
        index,
        name,
        override_existing: false,
    }
}

// Ported from mobile/tests/uploads.test.js (the uploadConflicts cases; the name helpers are tested in `paths`, and
// the upload queue belongs to the store).
#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    fn list(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    fn up(index: usize, name: &str, override_existing: bool) -> PlannedUpload {
        PlannedUpload {
            index,
            name: name.to_owned(),
            override_existing,
        }
    }

    #[test]
    fn find_conflicts_names_the_picked_files_whose_name_is_taken() {
        assert_eq!(
            find_conflicts(&list(&["a", "b", "c"]), &set(&["b", "z"])),
            vec![1]
        );
        assert!(find_conflicts(&list(&["a"]), &set(&[])).is_empty());
    }

    #[test]
    fn with_no_clash_every_file_goes_as_it_is_replacing_nothing() {
        assert_eq!(
            plan_uploads(&list(&["a", "b"]), &set(&["z"]), ConflictChoice::Replace),
            vec![up(0, "a", false), up(1, "b", false)]
        );
    }

    #[test]
    fn replace_sends_the_clashing_file_under_its_own_name_and_allows_overwriting() {
        assert_eq!(
            plan_uploads(
                &list(&["a.txt", "b.txt"]),
                &set(&["a.txt"]),
                ConflictChoice::Replace
            ),
            vec![up(0, "a.txt", true), up(1, "b.txt", false)]
        );
    }

    #[test]
    fn keep_both_gives_the_clashing_file_a_free_name() {
        assert_eq!(
            plan_uploads(
                &list(&["a.txt", "b.txt"]),
                &set(&["a.txt", "a (2).txt"]),
                ConflictChoice::KeepBoth
            ),
            vec![up(0, "a (3).txt", false), up(1, "b.txt", false)]
        );
    }

    #[test]
    fn skip_leaves_out_the_clashing_files_only() {
        assert_eq!(
            plan_uploads(
                &list(&["a.txt", "b.txt"]),
                &set(&["a.txt"]),
                ConflictChoice::Skip
            ),
            vec![up(1, "b.txt", false)]
        );
    }

    #[test]
    fn two_picked_files_with_one_name_never_replace_each_other() {
        for choice in [
            ConflictChoice::Replace,
            ConflictChoice::KeepBoth,
            ConflictChoice::Skip,
        ] {
            let plan = plan_uploads(&list(&["x.jpg", "x.jpg"]), &set(&[]), choice);
            assert_eq!(
                plan,
                vec![up(0, "x.jpg", false), up(1, "x (2).jpg", false)],
                "{choice:?}"
            );
        }
        // and a renamed copy cannot land on a name the folder already has
        let plan = plan_uploads(
            &list(&["x.jpg", "x.jpg"]),
            &set(&["x (2).jpg"]),
            ConflictChoice::KeepBoth,
        );
        let names: Vec<&str> = plan.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["x.jpg", "x (3).jpg"]);
    }
}
