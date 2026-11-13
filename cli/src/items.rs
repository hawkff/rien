// What the API's browse routes give, and how ytmpc prints it.
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct Ref {
    pub name: String,
}

#[derive(Deserialize)]
pub struct Item {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub artists: Vec<Ref>,
    pub album: Option<Ref>,
    pub duration: Option<u64>,
    /// The song's place in Rien's queue, which stays its own when others move
    #[serde(default)]
    pub slot: Option<String>,
    pub available: bool,
}

/// Text from Rien for the terminal. Control characters, which could move the
/// cursor or reach the terminal's settings, become U+FFFD; line breaks stay.
pub fn clean(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() && c != '\n' {
                '\u{FFFD}'
            } else {
                c
            }
        })
        .collect()
}

pub fn say(text: &str) {
    println!("{}", clean(text));
}

pub fn time(seconds: u64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// One numbered line: title, artists and album (or the site's own line), the
/// length, then the kind and ID to pass to other commands.
pub fn line(number: usize, item: &Item, marker: &str) -> String {
    let mut parts = vec![item.title.clone()];
    if item.artists.is_empty() {
        if !item.subtitle.is_empty() {
            parts.push(item.subtitle.clone());
        }
    } else {
        parts.push(
            item.artists
                .iter()
                .map(|artist| artist.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        );
        if let Some(album) = &item.album {
            parts.push(album.name.clone());
        }
    }
    let length = item.duration.map(time).unwrap_or_default();
    let unavailable = if item.available { "" } else { " (unavailable)" };
    format!(
        "{marker:1}{number:>3}  {}  {length}  {} {}{unavailable}",
        parts.join(" · "),
        item.kind,
        item.id
    )
}

pub fn items(value: &Value) -> Vec<Item> {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

pub fn print_items(value: &Value, current: Option<usize>) {
    for (index, item) in items(value).iter().enumerate() {
        let marker = if current == Some(index) { "→" } else { "" };
        say(&line(index + 1, item, marker));
    }
}

/// The line for Rien's move to another proxy exit, from the live feed
pub fn exit_change(value: &Value) -> String {
    let why = match value["reason"].as_str() {
        Some("bot-check") => "YouTube asked the last one to confirm it isn't a bot",
        Some("refused") => "YouTube kept refusing the last one",
        _ => "switched in Rien",
    };
    format!(
        "Exit {} of {} now: {why}",
        value["exit"].as_u64().unwrap_or(0),
        value["of"].as_u64().unwrap_or(0)
    )
}

/// The song line of `status`, from GET /song
pub fn song(value: &Value) -> String {
    let text = |key: &str| value[key].as_str().unwrap_or_default();
    let mut parts = vec![text("title"), text("artist")];
    if !text("album").is_empty() {
        parts.push(text("album"));
    }
    let state = if value["isPaused"].as_bool().unwrap_or(false) {
        "⏸"
    } else {
        "▶"
    };
    let elapsed = value["elapsedSeconds"].as_u64().unwrap_or(0);
    let length = value["songDuration"].as_u64().unwrap_or(0);
    format!(
        "{state} {}  {} / {}",
        parts.join(" · "),
        time(elapsed),
        time(length)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_characters_are_shown_not_run() {
        assert_eq!(
            clean("a\u{1b}]52;c;eA==\u{7}b\r\nc"),
            "a\u{FFFD}]52;c;eA==\u{FFFD}b\u{FFFD}\nc"
        );
    }

    #[test]
    fn times() {
        assert_eq!(time(0), "0:00");
        assert_eq!(time(192), "3:12");
        assert_eq!(time(3723), "1:02:03");
    }

    #[test]
    fn lines() {
        let item: Item = serde_json::from_value(serde_json::json!({
            "type": "song", "id": "Nh4T_4DJX4M", "title": "Faint (Demo 2002)",
            "subtitle": "Linkin Park • Meteora 20th Anniversary Edition • 3:12",
            "artists": [{ "id": "UCxgN32UVVztKAQd2HkXzBtw", "name": "Linkin Park" }],
            "album": { "id": "MPREb_DOhy8PyMH41", "name": "Meteora 20th Anniversary Edition" },
            "duration": 192, "thumbnail": null, "playlistId": null, "slot": null, "available": true
        }))
        .unwrap();
        assert_eq!(
            line(1, &item, "→"),
            "→  1  Faint (Demo 2002) · Linkin Park · Meteora 20th Anniversary Edition  3:12  song Nh4T_4DJX4M"
        );
    }

    #[test]
    fn exit_lines() {
        let change = serde_json::json!({ "type": "EXIT_CHANGED", "exit": 2, "of": 5, "proxy": "socks5://b:1080", "reason": "bot-check" });
        assert_eq!(
            exit_change(&change),
            "Exit 2 of 5 now: YouTube asked the last one to confirm it isn't a bot"
        );
    }

    #[test]
    fn song_lines() {
        let song = serde_json::json!({
            "title": "Somewhere I Belong", "artist": "Linkin Park", "album": "Meteora",
            "isPaused": false, "elapsedSeconds": 11, "songDuration": 226
        });
        assert_eq!(
            super::song(&song),
            "▶ Somewhere I Belong · Linkin Park · Meteora  0:11 / 3:46"
        );
    }
}
