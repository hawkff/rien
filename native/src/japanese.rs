//! Japanese to romaji, ported from kuroshiro's `spaced` romaji mode. lindera
//! segments the text with IPADIC, the dictionary kuromoji uses.

use std::borrow::Cow;
use std::sync::LazyLock;

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;

use crate::romaji::to_romaji;

static SEGMENTER: LazyLock<Result<Segmenter, String>> = LazyLock::new(|| {
    let dictionary = load_dictionary("embedded://ipadic").map_err(|error| error.to_string())?;
    Ok(Segmenter::new(Mode::Normal, dictionary, None))
});

struct Token {
    surface: String,
    pos: Option<String>,
    reading: Option<String>,
    pronunciation: Option<String>,
}

fn is_hiragana(ch: char) -> bool {
    ('\u{3040}'..='\u{309f}').contains(&ch)
}

fn is_kana(ch: char) -> bool {
    is_hiragana(ch) || ('\u{30a0}'..='\u{30ff}').contains(&ch)
}

fn is_kanji(ch: char) -> bool {
    ('\u{4e00}'..='\u{9fcf}').contains(&ch)
        || ('\u{f900}'..='\u{faff}').contains(&ch)
        || ('\u{3400}'..='\u{4dbf}').contains(&ch)
}

fn has_japanese(text: &str) -> bool {
    text.chars().any(|ch| is_kana(ch) || is_kanji(ch))
}

fn to_katakana(text: &str) -> String {
    text.chars()
        .map(|ch| match ch {
            '\u{3041}'..='\u{3096}' => char::from_u32(ch as u32 + 0x60).unwrap_or(ch),
            _ => ch,
        })
        .collect()
}

fn tokenize(text: &str) -> Result<Vec<Token>, String> {
    let segmenter = SEGMENTER.as_ref().map_err(Clone::clone)?;
    let mut tokens = segmenter
        .segment(Cow::Borrowed(text))
        .map_err(|error| error.to_string())?;
    Ok(tokens
        .iter_mut()
        .map(|token| {
            let surface = token.surface.to_string();
            let details = token.details();
            // IPADIC fields: part of speech first, reading 8th, pronunciation 9th.
            let field = |index: usize| {
                details
                    .get(index)
                    .filter(|value| !value.is_empty() && **value != "*")
                    .map(|value| value.to_string())
            };
            Token {
                pos: field(0),
                reading: field(7),
                pronunciation: field(8),
                surface,
            }
        })
        .collect())
}

/// kuroshiro's `patchTokens`.
fn patch_tokens(mut tokens: Vec<Token>) -> Vec<Token> {
    for token in &mut tokens {
        if !has_japanese(&token.surface) {
            token.reading = Some(token.surface.clone());
            continue;
        }
        match &token.reading {
            None if token.surface.chars().all(is_kana) => {
                token.reading = Some(to_katakana(&token.surface));
            }
            None => token.reading = Some(token.surface.clone()),
            Some(reading) if reading.chars().any(is_hiragana) => {
                token.reading = Some(to_katakana(reading));
            }
            Some(_) => {}
        }
    }

    // The auxiliary verb う joins the verb before it as a long vowel.
    let mut index = 0;
    while index < tokens.len() {
        let is_auxiliary_u = tokens[index].pos.as_deref() == Some("助動詞")
            && matches!(tokens[index].surface.as_str(), "う" | "ウ");
        if is_auxiliary_u && index > 0 && tokens[index - 1].pos.as_deref() == Some("動詞") {
            let verb = &mut tokens[index - 1];
            verb.surface.push('う');
            let reading = verb.reading.take().unwrap_or_default();
            verb.pronunciation = Some(match verb.pronunciation.take() {
                Some(pronunciation) => pronunciation + "ー",
                None => format!("{reading}ー"),
            });
            verb.reading = Some(reading + "ウ");
            tokens.remove(index);
            continue;
        }
        index += 1;
    }

    // A verb or adjective ending in っ joins the token after it.
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        let joins_next = matches!(token.pos.as_deref(), Some("動詞" | "形容詞"))
            && token.surface.chars().count() > 1
            && token.surface.ends_with(['っ', 'ッ'])
            && index + 1 < tokens.len();
        if joins_next {
            let next = tokens.remove(index + 1);
            let token = &mut tokens[index];
            let reading = token.reading.take().unwrap_or_default();
            let next_reading = next.reading.unwrap_or_default();
            token.surface.push_str(&next.surface);
            token.pronunciation = Some(match token.pronunciation.take() {
                Some(pronunciation) => {
                    pronunciation + next.pronunciation.as_deref().unwrap_or(&next_reading)
                }
                None => format!("{reading}{next_reading}"),
            });
            token.reading = Some(reading + &next_reading);
            continue;
        }
        index += 1;
    }
    tokens
}

pub fn romanize(text: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    let words: Vec<String> = patch_tokens(tokenize(text)?)
        .iter()
        .map(|token| {
            let kana = if has_japanese(&token.surface) {
                token.pronunciation.as_deref().or(token.reading.as_deref())
            } else {
                None
            };
            to_romaji(kana.unwrap_or(&token.surface))
        })
        .collect();
    Ok(words.join(" "))
}

#[cfg(test)]
mod tests {
    use super::romanize;

    // Output of kuroshiro 1.2.1 with kuromoji, `{ to: 'romaji', mode: 'spaced' }`.
    #[test]
    fn matches_kuroshiro() {
        assert_eq!(
            romanize("今日はいい天気ですね").unwrap(),
            "kyō wa ii tenki desu ne"
        );
        assert_eq!(
            romanize("君の名は。東京の空").unwrap(),
            "kimi no na wa . tōkyō no sora"
        );
        assert_eq!(romanize("夢を見ていた").unwrap(), "yume o mi te i ta");
    }

    #[test]
    fn returns_blank_input_empty() {
        assert_eq!(romanize("  ").unwrap(), "");
    }
}
