//! "1 titre", "12 titres": French takes the singular for 0 and 1.
//!
//! Port of `mobile/src/services/plural.ts`. Not in `text.rs` (which only compares names); `gallery.rs` and
//! `camera_backup.rs` keep small private helpers of their own, with other signatures, that are left alone.

/// The narrow no-break space `fr-FR` puts between groups of three digits (`toLocaleString('fr-FR')`).
const GROUP_SEPARATOR: char = '\u{202f}';

/// The count as `toLocaleString('fr-FR')` writes a whole number: "12", "1 234", "1 234 567" (groups separated by a
/// narrow no-break space).
pub fn group_digits(count: i64) -> String {
    let digits = count.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if count < 0 {
        out.push('-');
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(GROUP_SEPARATOR);
        }
        out.push(c);
    }
    out
}

/// "1 titre", "12 titres": the count with its word.
pub fn plural(count: i64, one: &str, many: &str) -> String {
    format!("{} {}", group_digits(count), plural_word(count, one, many))
}

/// Just the word, for sentences that put the number elsewhere.
pub fn plural_word<'a>(count: i64, one: &'a str, many: &'a str) -> &'a str {
    if count.unsigned_abs() > 1 { many } else { one }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn french_takes_the_singular_for_0_and_1() {
        assert_eq!(plural(0, "titre", "titres"), "0 titre");
        assert_eq!(plural(1, "titre", "titres"), "1 titre");
        assert_eq!(plural(2, "titre", "titres"), "2 titres");
        assert_eq!(plural(12, "titre", "titres"), "12 titres");
    }

    #[test]
    fn a_negative_count_is_judged_by_its_size() {
        assert_eq!(plural_word(-1, "titre", "titres"), "titre");
        assert_eq!(plural_word(-5, "titre", "titres"), "titres");
        assert_eq!(plural(-5, "titre", "titres"), "-5 titres");
    }

    #[test]
    fn just_the_word_for_sentences_that_put_the_number_elsewhere() {
        assert_eq!(plural_word(0, "album", "albums"), "album");
        assert_eq!(plural_word(3, "album", "albums"), "albums");
    }

    #[test]
    fn big_counts_are_grouped_by_thousands_with_a_narrow_no_break_space() {
        assert_eq!(group_digits(999), "999");
        assert_eq!(group_digits(1_000), "1\u{202f}000");
        assert_eq!(group_digits(1_234_567), "1\u{202f}234\u{202f}567");
        assert_eq!(group_digits(-12_345), "-12\u{202f}345");
        assert_eq!(plural(12_345, "titre", "titres"), "12\u{202f}345 titres");
    }
}
