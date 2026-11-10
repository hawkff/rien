//! Native helpers that the main process loads from
//! dist/native/<arch>/pear-native.node.

mod hepburn;
mod japanese;
mod language;
mod romaji;

use napi_derive::napi;

/// Romanizes Japanese text like kuroshiro's `spaced` romaji mode.
#[napi]
pub fn romanize_japanese(text: String) -> napi::Result<String> {
    japanese::romanize(&text).map_err(napi::Error::from_reason)
}

/// The ISO 639-1 code of `text`'s language if a lyrics romanizer handles it.
#[napi]
pub fn detect_language(text: String) -> Option<String> {
    language::detect(&text).map(str::to_owned)
}
