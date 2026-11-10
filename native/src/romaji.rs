//! Kana to Hepburn romaji, ported from kuroshiro's `toRawRomaji`.

use std::collections::HashMap;
use std::sync::LazyLock;

use crate::hepburn::HEPBURN;

static TABLE: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| HEPBURN.iter().copied().collect());

/// Kana that take an apostrophe after ん, as in "kan'i".
const APOSTROPHE_AFTER_N: &str = "あいうえおアイウエオぁぃぅぇぉァィゥェォやゆよヤユヨゃゅょャュョ";
const DOUBLED_CONSONANTS: &str = "bcdfghijklmnopqrstuvwyz";

fn is_sokuon(ch: char) -> bool {
    ch == 'っ' || ch == 'ッ'
}

pub fn to_romaji(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut marked = Vec::with_capacity(chars.len());
    for (index, &ch) in chars.iter().enumerate() {
        marked.push(ch);
        let before_vowel = chars
            .get(index + 1)
            .is_some_and(|next| APOSTROPHE_AFTER_N.contains(*next));
        if (ch == 'ん' || ch == 'ン') && before_vowel {
            marked.push('\'');
        }
    }

    // Two-kana combinations such as きょ win over single kana.
    let mut converted = String::with_capacity(text.len() * 2);
    let mut index = 0;
    while index < marked.len() {
        if index + 1 < marked.len() {
            let pair: String = marked[index..index + 2].iter().collect();
            if let Some(romaji) = TABLE.get(pair.as_str()) {
                converted.push_str(romaji);
                index += 2;
                continue;
            }
        }
        let single = marked[index].to_string();
        converted.push_str(TABLE.get(single.as_str()).copied().unwrap_or(&single));
        index += 1;
    }

    // っ doubles the consonant that follows it, and becomes t before ch.
    let converted: Vec<char> = converted.chars().collect();
    let mut doubled = String::with_capacity(converted.len());
    for (index, &ch) in converted.iter().enumerate() {
        match converted.get(index + 1) {
            Some('c') if is_sokuon(ch) => doubled.push('t'),
            Some(&next) if is_sokuon(ch) && DOUBLED_CONSONANTS.contains(next) => doubled.push(next),
            _ => doubled.push(ch),
        }
    }

    doubled
        .replace(['っ', 'ッ'], "tsu")
        .replace("aー", "ā")
        .replace("iー", "ī")
        .replace("uー", "ū")
        .replace("eー", "ē")
        .replace("oー", "ō")
}

#[cfg(test)]
mod tests {
    use super::to_romaji;

    #[test]
    fn converts_kana() {
        assert_eq!(to_romaji("キョー"), "kyō");
        assert_eq!(to_romaji("トーキョー"), "tōkyō");
        assert_eq!(to_romaji("しゃしん"), "shashin");
    }

    #[test]
    fn marks_n_before_vowels() {
        assert_eq!(to_romaji("かんい"), "kan'i");
        assert_eq!(to_romaji("ほんや"), "hon'ya");
    }

    #[test]
    fn doubles_consonants_after_sokuon() {
        assert_eq!(to_romaji("きって"), "kitte");
        assert_eq!(to_romaji("まっちゃ"), "matcha");
        assert_eq!(to_romaji("あっ"), "atsu");
    }

    #[test]
    fn keeps_other_characters() {
        assert_eq!(to_romaji("ABC 123"), "ABC 123");
        assert_eq!(to_romaji("account"), "account");
        assert_eq!(to_romaji("。"), ".");
    }
}
