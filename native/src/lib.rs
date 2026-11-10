//! Native helpers that the main process loads from
//! dist/native/<arch>/pear-native.node.

mod downloader;
mod hepburn;
mod japanese;
mod language;
mod romaji;

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
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

/// Runs a downloader conversion on a libuv worker thread.
pub struct DownloadTask(Option<Box<dyn FnOnce() -> downloader::Result<Vec<u8>> + Send>>);

impl Task for DownloadTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Vec<u8>> {
        let job = self
            .0
            .take()
            .ok_or_else(|| napi::Error::from_reason("The task already ran"))?;
        job().map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Vec<u8>) -> napi::Result<Buffer> {
        Ok(output.into())
    }
}

/// Decodes the AAC track of an MP4 download and encodes it as 256 kbps MP3.
#[napi]
pub fn convert_to_mp3(input: Buffer) -> AsyncTask<DownloadTask> {
    let input = input.to_vec();
    AsyncTask::new(DownloadTask(Some(Box::new(move || {
        downloader::mp4_to_mp3(input)
    }))))
}

#[napi(object)]
pub struct Mp4Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<u32>,
    /// PNG image
    pub cover: Option<Buffer>,
}

/// Writes tags to an MP4 download.
#[napi]
pub fn tag_mp4(input: Buffer, tags: Mp4Tags) -> AsyncTask<DownloadTask> {
    let input = input.to_vec();
    let tags = downloader::Mp4Tags {
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        track: tags.track.and_then(|track| u16::try_from(track).ok()),
        cover_png: tags.cover.map(|cover| cover.to_vec()),
    };
    AsyncTask::new(DownloadTask(Some(Box::new(move || {
        downloader::tag_mp4(input, tags)
    }))))
}
