//! Language detection for the lyrics romanizers.

use whatlang::Lang;

/// The ISO 639-1 code of the detected language when a romanizer handles it.
/// Returns None for unreliable guesses, which the renderer handles by script.
pub fn detect(text: &str) -> Option<&'static str> {
    let info = whatlang::detect(text)?;
    if !info.is_reliable() {
        return None;
    }
    match info.lang() {
        Lang::Jpn => Some("ja"),
        Lang::Kor => Some("ko"),
        Lang::Cmn => Some("zh"),
        Lang::Tha => Some("th"),
        Lang::Ben => Some("bn"),
        Lang::Hin => Some("hi"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::detect;

    #[test]
    fn detects_handled_languages() {
        assert_eq!(detect("今日はいい天気ですね"), Some("ja"));
        assert_eq!(detect("我们一起去银行"), Some("zh"));
        assert_eq!(detect("사랑해요 여러분"), Some("ko"));
        assert_eq!(detect("สวัสดีครับ"), Some("th"));
        assert_eq!(detect("Hello there, how are you"), None);
        // A few kana among many kanji is not a reliable guess either way.
        assert_eq!(
            detect("東京都庁前駅北口広場周辺地域再開発計画会議議事録の"),
            None
        );
    }
}
