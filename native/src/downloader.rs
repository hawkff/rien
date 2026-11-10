//! Conversions for the downloader: the AAC track of an MP4 download to MP3,
//! and tags for MP4 downloads.

use std::error::Error;
use std::io::Cursor;

use mp3lame_encoder::{Bitrate, Builder, FlushGap, InterleavedPcm, MonoPcm};
use mp4ameta::{Img, Userdata};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub struct Mp4Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<u16>,
    pub cover_png: Option<Vec<u8>>,
}

/// Decodes the AAC track of an MP4 file and encodes it as 256 kbps MP3.
pub fn mp4_to_mp3(input: Vec<u8>) -> Result<Vec<u8>> {
    let source = MediaSourceStream::new(
        Box::new(Cursor::new(input)),
        MediaSourceStreamOptions::default(),
    );
    let mut format = symphonia::default::get_probe().probe(
        &Hint::new(),
        source,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("The download has no audio track")?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .ok_or("The download has no audio track")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())?;
    let sample_rate = params.sample_rate.ok_or("The audio has no sample rate")?;
    let channels = params
        .channels
        .as_ref()
        .map_or(0, |channels| channels.count());
    if !matches!(channels, 1 | 2) {
        return Err(format!("Unsupported number of audio channels: {channels}").into());
    }

    let mut builder = Builder::new().ok_or("Could not create the MP3 encoder")?;
    builder.set_num_channels(channels as u8)?;
    builder.set_sample_rate(sample_rate)?;
    builder.set_brate(Bitrate::Kbps256)?;
    builder.set_to_write_vbr_tag(true)?;
    let mut encoder = builder.build()?;

    let mut samples = Vec::<f32>::new();
    let mut output = Vec::new();
    while let Some(packet) = format.next_packet()? {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => decoded.copy_to_vec_interleaved(&mut samples),
            // Skip a damaged packet, as ffmpeg does.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(error) => return Err(error.into()),
        }
        output.reserve(mp3lame_encoder::max_required_buffer_size(
            samples.len() / channels,
        ));
        if channels == 1 {
            encoder.encode_to_vec(MonoPcm(samples.as_slice()), &mut output)?;
        } else {
            encoder.encode_to_vec(InterleavedPcm(samples.as_slice()), &mut output)?;
        }
    }
    output.reserve(7200);
    encoder.flush_to_vec::<FlushGap>(&mut output)?;

    // LAME starts the stream with an empty frame for its tag, which holds the
    // length, encoder delay and padding.
    let mut tag = Vec::with_capacity(encoder.lame_tag_size());
    if encoder.lame_tag_encode_to_vec(&mut tag).is_some() && tag.len() <= output.len() {
        output[..tag.len()].copy_from_slice(&tag);
    }
    Ok(output)
}

/// Writes title, artist, album, track number and cover tags to an MP4 file.
pub fn tag_mp4(input: Vec<u8>, tags: Mp4Tags) -> Result<Vec<u8>> {
    let mut userdata = Userdata::default();
    if let Some(title) = tags.title {
        userdata.set_title(title);
    }
    if let Some(artist) = tags.artist {
        userdata.set_artist(artist);
    }
    if let Some(album) = tags.album {
        userdata.set_album(album);
    }
    if let Some(track) = tags.track {
        userdata.set_track_number(track);
    }
    if let Some(cover) = tags.cover_png {
        userdata.set_artwork(Img::png(cover));
    }
    let mut file = Cursor::new(input);
    userdata.write_to(&mut file)?;
    Ok(file.into_inner())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use mp4ameta::Tag;
    use symphonia::core::codecs::audio::AudioDecoderOptions;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::{FormatOptions, TrackType};
    use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
    use symphonia::core::meta::MetadataOptions;

    use super::{Mp4Tags, mp4_to_mp3, tag_mp4};

    // One second of a tone sweep at half volume, as 44.1 kHz stereo AAC.
    const TONE: &[u8] = include_bytes!("../fixtures/tone.m4a");

    /// Returns the sample rate, channel count and interleaved samples of a file.
    fn decode(data: Vec<u8>) -> (u32, usize, Vec<f32>) {
        let source = MediaSourceStream::new(
            Box::new(Cursor::new(data)),
            MediaSourceStreamOptions::default(),
        );
        let mut format = symphonia::default::get_probe()
            .probe(
                &Hint::new(),
                source,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .unwrap();
        let track = format.default_track(TrackType::Audio).unwrap();
        let track_id = track.id;
        let params = track
            .codec_params
            .as_ref()
            .unwrap()
            .audio()
            .unwrap()
            .clone();
        let mut decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .unwrap();
        let mut samples = Vec::new();
        let mut chunk = Vec::<f32>::new();
        while let Some(packet) = format.next_packet().unwrap() {
            if packet.track_id == track_id {
                decoder
                    .decode(&packet)
                    .unwrap()
                    .copy_to_vec_interleaved(&mut chunk);
                samples.extend_from_slice(&chunk);
            }
        }
        let channels = params.channels.unwrap().count();
        (params.sample_rate.unwrap(), channels, samples)
    }

    #[test]
    fn converts_aac_to_mp3() {
        let mp3 = mp4_to_mp3(TONE.to_vec()).unwrap();
        assert!(mp3[..200].windows(4).any(|bytes| bytes == b"Info"));

        let (rate, channels, samples) = decode(mp3);
        assert_eq!((rate, channels), (44_100, 2));
        // One second plus the AAC priming samples and MP3 encoder delay and padding
        let frames = samples.len() / channels;
        assert!((44_100..50_000).contains(&frames), "{frames} frames");
        let rms = (samples.iter().map(|sample| sample * sample).sum::<f32>()
            / samples.len() as f32)
            .sqrt();
        assert!(rms > 0.2, "RMS {rms}");
    }

    #[test]
    fn tags_mp4() {
        let tags = Mp4Tags {
            title: Some("Title".into()),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            track: Some(3),
            cover_png: Some(b"\x89PNG".to_vec()),
        };
        let tagged = tag_mp4(TONE.to_vec(), tags).unwrap();

        let tag = Tag::read_from(&mut Cursor::new(tagged.as_slice())).unwrap();
        assert_eq!(tag.title(), Some("Title"));
        assert_eq!(tag.artist(), Some("Artist"));
        assert_eq!(tag.album(), Some("Album"));
        assert_eq!(tag.track_number(), Some(3));
        assert_eq!(tag.artwork().unwrap().data, b"\x89PNG");
        assert_eq!(decode(tagged).2, decode(TONE.to_vec()).2);
    }
}
