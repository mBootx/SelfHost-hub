//! Comparing names as a French reader does.

use std::cmp::Ordering;

/// `name` lowercased with its accents taken off, for comparing names whatever their case and accents (what
/// JavaScript's `localeCompare(…, 'fr', { sensitivity: 'base' })` does).
pub fn fold(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
            'ç' | 'ć' | 'č' => 'c',
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => 'e',
            'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
            'ñ' | 'ń' | 'ň' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => 'o',
            'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' => 'u',
            'ý' | 'ÿ' => 'y',
            'ś' | 'š' => 's',
            'ź' | 'ż' | 'ž' => 'z',
            'ł' => 'l',
            'ř' => 'r',
            'ť' => 't',
            'ď' => 'd',
            other => other,
        })
        .collect()
}

/// Orders names whatever their case and accents.
pub fn compare_names(a: &str, b: &str) -> Ordering {
    fold(a).cmp(&fold(b))
}

/// One step of a name as a collator weighs it. The variants are in the order a collator sorts them: spaces, then
/// punctuation, symbols, numbers, and letters last.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Weight {
    Space(char),
    Punctuation(char),
    Symbol(char),
    /// A run of ASCII digits, by value: its length without leading zeros, then the digits themselves.
    Number(usize, String),
    OtherNumber(char),
    Letter(char),
}

fn weights(text: &str) -> Vec<Weight> {
    use unicode_normalization::UnicodeNormalization;
    use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

    fn flush(digits: &mut String, out: &mut Vec<Weight>) {
        if digits.is_empty() {
            return;
        }
        let value = digits.trim_start_matches('0');
        let value = if value.is_empty() { "0" } else { value };
        out.push(Weight::Number(value.len(), value.to_owned()));
        digits.clear();
    }

    let mut out = Vec::new();
    let mut digits = String::new();
    for c in text.nfd().flat_map(char::to_lowercase) {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        flush(&mut digits, &mut out);
        out.push(match c.general_category_group() {
            GeneralCategoryGroup::Separator => Weight::Space(c),
            GeneralCategoryGroup::Punctuation => Weight::Punctuation(c),
            GeneralCategoryGroup::Symbol => Weight::Symbol(c),
            GeneralCategoryGroup::Number => Weight::OtherNumber(c),
            GeneralCategoryGroup::Letter => Weight::Letter(c),
            // Accents (split off by the decomposition) and control characters weigh nothing.
            _ => continue,
        });
    }
    flush(&mut digits, &mut out);
    out
}

/// Orders names the way people count, whatever their case and accents: "IMG_2" before "IMG_10", "Ébène" before
/// "zèbre" (what JavaScript's `Intl.Collator('fr', { numeric: true, sensitivity: 'base' })` does).
pub fn compare_numeric(a: &str, b: &str) -> Ordering {
    weights(a).cmp(&weights(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_and_accents_do_not_change_the_order() {
        let mut names = vec!["Électro", "rock", "Ambient", "éclectique", "Rap"];
        names.sort_by(|a, b| compare_names(a, b));
        assert_eq!(names, ["Ambient", "éclectique", "Électro", "Rap", "rock"]);
        assert_eq!(compare_names("Björk", "bjork"), Ordering::Equal);
    }

    #[test]
    fn numbers_in_names_are_compared_by_value() {
        let mut names = vec![
            "IMG_10.jpg",
            "IMG_2.jpg",
            "img_1.jpg",
            "Ébène.jpg",
            "zèbre.jpg",
        ];
        names.sort_by(|a, b| compare_numeric(a, b));
        assert_eq!(
            names,
            [
                "Ébène.jpg",
                "img_1.jpg",
                "IMG_2.jpg",
                "IMG_10.jpg",
                "zèbre.jpg"
            ]
        );
        assert_eq!(compare_numeric("Été", "ete"), Ordering::Equal);
        assert_eq!(compare_numeric("a007", "a7"), Ordering::Equal);
        assert_eq!(compare_numeric("a", "ab"), Ordering::Less);
        // Punctuation sorts before digits, and digits before letters.
        assert_eq!(compare_numeric("a_", "a1"), Ordering::Less);
        assert_eq!(compare_numeric("a1", "ab"), Ordering::Less);
    }
}
