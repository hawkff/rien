// The account's library through Rien's API: listings, an export, and changes.
// A change is a dry run unless applied. An applied batch first saves a
// snapshot of the library, then logs the calls that undo it.
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{
    items::{Item, line, say},
    rien::{Method, Rien},
    saved,
};

/// The library's lists, as `ytmpc library KIND` takes them
pub const KINDS: [&str; 7] = [
    "songs",
    "albums",
    "artists",
    "subscriptions",
    "playlists",
    "likes",
    "history",
];

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// Every page of a list: `key` holds the items of each page
pub fn all(rien: &mut Rien, path: &str, key: &str) -> Result<Vec<Value>> {
    let mut found = Vec::new();
    let mut next: Option<String> = None;
    // A guard against a list whose pages never end
    for _ in 0..500 {
        let url = match &next {
            Some(token) => format!("{path}?continuation={}", crate::query(token)),
            None => path.to_owned(),
        };
        let answer = rien.request(Method::Get, &url, None)?.unwrap_or_default();
        found.extend(answer[key].as_array().cloned().unwrap_or_default());
        next = answer["continuation"].as_str().map(str::to_owned);
        if next.is_none() {
            return Ok(found);
        }
    }
    bail!("{path} has more pages than ytmpc follows")
}

fn library(rien: &mut Rien, kind: &str) -> Result<Vec<Value>> {
    all(rien, &format!("/api/v1/library/{kind}"), "items")
}

fn playlist(rien: &mut Rien, id: &str) -> Result<Vec<Value>> {
    all(
        rien,
        &format!("/api/v1/browse/playlist/{}", crate::query(id)),
        "tracks",
    )
}

fn parsed(values: &[Value]) -> Vec<Item> {
    crate::items::items(&Value::Array(values.to_vec()))
}

/// The library as one JSON value: its lists (but the history) and each
/// playlist's songs
pub fn export(rien: &mut Rien) -> Result<Value> {
    let mut lists = Map::new();
    for kind in KINDS.iter().filter(|kind| **kind != "history") {
        lists.insert(kind.to_string(), Value::Array(library(rien, kind)?));
    }
    let mut songs = Map::new();
    let ids: Vec<String> = lists["playlists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        // Liked songs are a list of their own already
        .filter(|id| id != "VLLM")
        .collect();
    for id in ids {
        songs.insert(id.clone(), Value::Array(playlist(rien, &id)?));
    }
    lists.insert("playlistSongs".into(), Value::Object(songs));
    Ok(json!({ "exportedAt": now(), "library": lists }))
}

/// Writes an export, by default to $XDG_DATA_HOME/ytmpc/`folder`
pub fn write_export(value: &Value, file: Option<&str>, folder: &str) -> Result<PathBuf> {
    let path = match file {
        Some(file) => PathBuf::from(file),
        None => saved::data_dir().join(folder).join(format!(
            "library-{}-{}.json",
            now(),
            std::process::id()
        )),
    };
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    saved::write_file(&path, &serde_json::to_string_pretty(value)?)?;
    Ok(path)
}

/// A request to Rien, kept in the undo log as it goes out
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Call {
    method: String,
    path: String,
    body: Value,
}

fn post(path: &str, body: Value) -> Call {
    Call {
        method: "POST".into(),
        path: path.into(),
        body,
    }
}

fn rate(target: (&str, &str), status: &str) -> Call {
    let mut body = json!({ "status": status });
    body[target.0] = json!(target.1);
    post("/api/v1/library/rate", body)
}

impl Call {
    fn send(&self, rien: &mut Rien) -> Result<Option<Value>> {
        let method = match self.method.as_str() {
            "DELETE" => Method::Delete,
            "PATCH" => Method::Patch,
            "GET" => Method::Get,
            _ => Method::Post,
        };
        let body = (!self.body.is_null()).then_some(&self.body);
        rien.request(method, &self.path, body)
    }
}

/// A deleted playlist comes back as a new one with the same songs
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Recreate {
    title: String,
    songs: Vec<String>,
}

/// A change: what it does, the items it touches, and its calls, each with
/// the one that undoes it, if any
pub struct Change {
    pub what: String,
    pub items: Vec<Item>,
    steps: Vec<(Call, Option<Call>)>,
    recreate: Option<Recreate>,
}

/// One applied batch in the undo log
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct Batch {
    at: u64,
    what: String,
    /// The Rien it changed, which alone may take it back
    #[serde(default)]
    address: String,
    undo: Vec<Call>,
    #[serde(default)]
    recreate: Option<Recreate>,
}

fn log_path() -> PathBuf {
    saved::data_dir().join("undo.jsonl")
}

fn read_log(path: &Path) -> Result<Vec<Batch>> {
    match fs::read_to_string(path) {
        Ok(text) => text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).context("The undo log has an error"))
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("Can't read {}", path.display())),
    }
}

fn write_log(path: &Path, batches: &[Batch]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = String::new();
    for batch in batches {
        text.push_str(&serde_json::to_string(batch)?);
        text.push('\n');
    }
    saved::write_file(path, &text)
}

// shortcut: two ytmpc that change the library at the same moment can each
// rewrite the log and lose the other's batch; add a lock file if that happens
fn push(path: &Path, batch: Batch) -> Result<()> {
    let mut batches = read_log(path)?;
    batches.push(batch);
    write_log(path, &batches)
}

/// Rewrites the newest batch, as a change or an undo makes progress
fn replace_last(path: &Path, batch: Batch) -> Result<()> {
    let mut batches = read_log(path)?;
    batches.pop();
    batches.push(batch);
    write_log(path, &batches)
}

/// Shows a change, or applies it: a snapshot of the library first, then the
/// calls in order, logging the undo of each one that went through
pub fn run(rien: &mut Rien, change: Change, apply: bool, as_json: bool) -> Result<()> {
    let ids: Vec<&str> = change.items.iter().map(|item| item.id.as_str()).collect();
    if change.items.is_empty() {
        if as_json {
            println!(
                "{}",
                json!({ "applied": false, "what": change.what, "changes": [] })
            );
        } else {
            say("Nothing to change.");
        }
        return Ok(());
    }
    if !as_json {
        say(&format!("{}:", change.what));
        for (index, item) in change.items.iter().enumerate() {
            say(&line(index + 1, item, ""));
        }
    }
    if !apply {
        if as_json {
            println!(
                "{}",
                json!({ "applied": false, "what": change.what, "changes": ids })
            );
        } else {
            say("Dry run: nothing changed. Add --apply to do it; ytmpc undo takes it back.");
        }
        return Ok(());
    }
    // A log that can't be read or written stops the change before anything changes
    let log = log_path();
    write_log(&log, &read_log(&log)?)?;
    if !as_json {
        eprintln!("Saving a snapshot of the library first…");
    }
    let snapshot = write_export(&export(rien)?, None, "snapshots")?;
    // The log learns of each call that went through before the next goes out
    let mut batch = Batch {
        at: now(),
        what: change.what.clone(),
        address: rien.address().to_owned(),
        undo: Vec::new(),
        recreate: None,
    };
    for (index, (call, back)) in change.steps.iter().enumerate() {
        let sent = call.send(rien);
        // Rien says when a change may have gone through without an answer;
        // its undo is logged then too, to be used after a look
        let uncertain = sent
            .as_ref()
            .is_err_and(|error| format!("{error:#}").contains("may have gone through"));
        let mut failure = sent
            .as_ref()
            .err()
            .map(|error| anyhow::anyhow!("{error:#}"));
        if sent.is_ok() || uncertain {
            let answer = sent.ok().flatten();
            let (back, refused) = taken(back.clone(), answer.as_ref());
            batch.undo.extend(back);
            if index + 1 == change.steps.len() {
                batch.recreate = change.recreate.clone();
            }
            if uncertain {
                batch.what = format!("{} (may not have gone through)", change.what);
            }
            if index == 0 {
                push(&log, batch.clone())?;
            } else {
                replace_last(&log, batch.clone())?;
            }
            if refused > 0 && failure.is_none() {
                failure = Some(anyhow::anyhow!(
                    "The site refused {}",
                    count(refused, "item")
                ));
            }
        }
        if let Some(error) = failure {
            return Err(error.context(if index > 0 || sent_any(&batch) {
                "Not all of it went through; ytmpc undo takes back what did"
            } else {
                "Nothing changed"
            }));
        }
    }
    if as_json {
        println!(
            "{}",
            json!({ "applied": true, "what": change.what, "changes": ids, "snapshot": snapshot })
        );
    } else {
        say(&format!(
            "Done. The library before it: {}. ytmpc undo takes it back.",
            snapshot.display()
        ));
    }
    Ok(())
}

/// The undo of a call that went out, narrowed to the tokens the site took
/// when it answers for each token, and how many it refused
fn taken(back: Option<Call>, answer: Option<&Value>) -> (Option<Call>, usize) {
    let flags: Vec<bool> = answer
        .and_then(|answer| answer["processed"].as_array())
        .map(|flags| {
            flags
                .iter()
                .map(|flag| flag.as_bool() == Some(true))
                .collect()
        })
        .unwrap_or_default();
    let Some(mut back) = back else {
        return (None, 0);
    };
    let refused = flags.iter().filter(|flag| !**flag).count();
    if flags.is_empty() || refused == 0 {
        return (Some(back), 0);
    }
    let tokens: Vec<Value> = back.body["tokens"]
        .as_array()
        .into_iter()
        .flatten()
        .zip(&flags)
        .filter(|(_, took)| **took)
        .map(|(token, _)| token.clone())
        .collect();
    if tokens.is_empty() {
        return (None, refused);
    }
    back.body["tokens"] = json!(tokens);
    (Some(back), refused)
}

fn sent_any(batch: &Batch) -> bool {
    !batch.undo.is_empty() || batch.recreate.is_some()
}

/// Takes back the last applied batch, or lists the batches
pub fn undo(rien: &mut Rien, list: bool, as_json: bool) -> Result<()> {
    let path = log_path();
    let mut batches = read_log(&path)?;
    if list {
        if as_json {
            println!("{}", serde_json::to_value(&batches)?);
        } else if batches.is_empty() {
            say("Nothing to undo.");
        }
        for (index, batch) in batches.iter().enumerate().filter(|_| !as_json) {
            let minutes = now().saturating_sub(batch.at) / 60;
            say(&format!(
                "{:>3}  {}  ({minutes} min ago)",
                index + 1,
                batch.what
            ));
        }
        return Ok(());
    }
    let Some(mut batch) = batches.pop() else {
        bail!("Nothing to undo");
    };
    if !batch.address.is_empty() && batch.address != rien.address() {
        bail!(
            "The last change went to the Rien at {}, not {}",
            batch.address,
            rien.address()
        );
    }
    // Each call that goes through leaves the log, so a second try goes on
    // where the first stopped; a log that can't be written stops it first
    replace_last(&path, batch.clone())?;
    loop {
        if let Some(call) = batch.undo.first().cloned() {
            let answer = call.send(rien)?;
            // Tokens the site didn't take stay for the next try
            let flags: Vec<bool> = answer
                .as_ref()
                .and_then(|answer| answer["processed"].as_array())
                .map(|flags| {
                    flags
                        .iter()
                        .map(|flag| flag.as_bool() == Some(true))
                        .collect()
                })
                .unwrap_or_default();
            if flags.iter().any(|took| !took) {
                let left: Vec<Value> = call.body["tokens"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .zip(&flags)
                    .filter(|(_, took)| !**took)
                    .map(|(token, _)| token.clone())
                    .collect();
                batch.undo[0].body["tokens"] = json!(left);
                replace_last(&path, batch.clone())?;
                bail!(
                    "The site didn't take {} back; ytmpc undo tries those again",
                    count(flags.iter().filter(|took| !**took).count(), "item")
                );
            }
            batch.undo.remove(0);
        } else if let Some(recreate) = batch.recreate.take() {
            let (first, rest) = recreate.songs.split_at(recreate.songs.len().min(200));
            let made = post(
                "/api/v1/playlists",
                json!({ "title": recreate.title, "videoIds": first }),
            )
            .send(rien)?
            .unwrap_or_default();
            let id = made["id"].as_str().context("Rien made no playlist")?;
            // The rest of its songs go in as calls of their own
            batch.undo = rest
                .chunks(200)
                .map(|chunk| {
                    post(
                        &format!("/api/v1/playlists/{}/add", crate::query(id)),
                        json!({ "videoIds": chunk, "duplicates": true }),
                    )
                })
                .collect();
        } else {
            break;
        }
        replace_last(&path, batch.clone())?;
    }
    write_log(&path, &batches)?;
    if as_json {
        println!("{}", json!({ "undone": batch.what }));
    } else {
        say(&format!("Took back: {}", batch.what));
    }
    Ok(())
}

fn token(item: &Value, key: &str) -> Option<String> {
    item["library"][key].as_str().map(str::to_owned)
}

/// Removes songs (by video ID) and albums (by browse or playlist ID) from the library
pub fn remove_from_library(ids: &[String], songs: &[Value], albums: &[Value]) -> Result<Change> {
    let (mut items, mut removes, mut adds, mut steps) = (vec![], vec![], vec![], vec![]);
    let mut missing = vec![];
    for id in ids {
        if let Some(song) = songs.iter().find(|song| song["id"] == json!(id)) {
            match (token(song, "remove"), token(song, "add")) {
                (Some(remove), Some(add)) => {
                    removes.push(remove);
                    adds.push(add);
                    items.extend(parsed(std::slice::from_ref(song)));
                }
                _ => bail!("Rien gives no library tokens for {id}"),
            }
        } else if let Some(album) = albums
            .iter()
            .find(|album| album["id"] == json!(id) || album["playlistId"] == json!(id))
        {
            let list = album["playlistId"]
                .as_str()
                .with_context(|| format!("Rien gives no playlist for the album {id}"))?;
            steps.push((
                rate(("playlistId", list), "INDIFFERENT"),
                Some(rate(("playlistId", list), "LIKE")),
            ));
            items.extend(parsed(std::slice::from_ref(album)));
        } else {
            missing.push(id.as_str());
        }
    }
    if !missing.is_empty() {
        bail!(
            "Not in the library's songs or albums: {}",
            missing.join(", ")
        );
    }
    // Rien takes 200 tokens a request
    let feedback: Vec<_> = removes
        .chunks(200)
        .zip(adds.chunks(200))
        .map(|(removes, adds)| {
            (
                post("/api/v1/library/feedback", json!({ "tokens": removes })),
                Some(post("/api/v1/library/feedback", json!({ "tokens": adds }))),
            )
        })
        .collect();
    steps.splice(0..0, feedback);
    Ok(Change {
        what: format!("Remove {} from the library", count(items.len(), "item")),
        items,
        steps,
        recreate: None,
    })
}

/// Unlikes songs that are among the liked ones
pub fn unlike(ids: &[String], likes: &[Value]) -> Result<Change> {
    let mut items = vec![];
    let mut steps = vec![];
    let mut missing = vec![];
    for id in ids {
        match likes.iter().find(|song| song["id"] == json!(id)) {
            Some(song) => {
                items.extend(parsed(std::slice::from_ref(song)));
                steps.push((
                    rate(("videoId", id), "INDIFFERENT"),
                    Some(rate(("videoId", id), "LIKE")),
                ));
            }
            None => missing.push(id.as_str()),
        }
    }
    if !missing.is_empty() {
        bail!("Not among the liked songs: {}", missing.join(", "));
    }
    Ok(Change {
        what: format!("Unlike {}", count(items.len(), "song")),
        items,
        steps,
        recreate: None,
    })
}

/// Removes songs from a playlist by slot, or every slot of a video ID
pub fn remove_from_playlist(
    playlist_id: &str,
    picks: &[String],
    tracks: &[Value],
) -> Result<Change> {
    let mut chosen: Vec<&Value> = vec![];
    for pick in picks {
        let found: Vec<&Value> = tracks
            .iter()
            .filter(|track| track["slot"] == json!(pick) || track["id"] == json!(pick))
            .collect();
        if found.is_empty() {
            bail!("Not in the playlist: {pick}");
        }
        for track in found {
            if !chosen.iter().any(|known| known["slot"] == track["slot"]) {
                chosen.push(track);
            }
        }
    }
    let mut steps = vec![];
    for chunk in chosen.chunks(200) {
        let items: Vec<Value> = chunk
            .iter()
            .map(|track| json!({ "videoId": track["id"], "slot": track["slot"] }))
            .collect();
        let ids: Vec<&Value> = chunk.iter().map(|track| &track["id"]).collect();
        let path = format!("/api/v1/playlists/{}", crate::query(playlist_id));
        steps.push((
            post(&format!("{path}/remove"), json!({ "items": items })),
            // Back at the end of the playlist: the site can't put songs back in their places
            Some(post(
                &format!("{path}/add"),
                json!({ "videoIds": ids, "duplicates": true }),
            )),
        ));
    }
    let values: Vec<Value> = chosen.into_iter().cloned().collect();
    let items = parsed(&values);
    Ok(Change {
        what: format!("Remove {} from the playlist", count(items.len(), "song")),
        items,
        steps,
        recreate: None,
    })
}

/// Deletes a playlist; undo makes a new one with the same title and songs
pub fn delete_playlist(playlist_id: &str, title: &str, tracks: &[Value]) -> Change {
    let songs: Vec<String> = tracks
        .iter()
        .filter_map(|track| track["id"].as_str().map(str::to_owned))
        .collect();
    let item: Item = serde_json::from_value(json!({
        "type": "playlist", "id": playlist_id, "title": title,
        "subtitle": count(songs.len(), "song"), "artists": [], "album": null,
        "duration": null, "available": true
    }))
    .expect("a playlist item");
    Change {
        what: format!("Delete the playlist \"{title}\""),
        items: vec![item],
        // The new playlist that takes it back comes from `recreate`
        steps: vec![(
            Call {
                method: "DELETE".into(),
                path: format!("/api/v1/playlists/{}", crate::query(playlist_id)),
                body: Value::Null,
            },
            None,
        )],
        recreate: Some(Recreate {
            title: title.to_owned(),
            songs,
        }),
    }
}

/// Removes the duplicates of a list: from the library's songs, from the liked
/// songs (by unliking them) or from a playlist (by slot)
pub fn dedupe(list: &str, values: &[Value]) -> Result<Change> {
    let items: Vec<Item> = values
        .iter()
        .map(|value| serde_json::from_value(value.clone()))
        .collect::<Result<_, _>>()
        .context("Rien's list has an item ytmpc can't read")?;
    let extra = duplicates(&items);
    let pick = |key: &str| -> Vec<String> {
        extra
            .iter()
            .filter_map(|index| values[*index][key].as_str().map(str::to_owned))
            .collect()
    };
    let mut change = match list {
        "songs" => remove_from_library(&pick("id"), values, &[])?,
        "likes" => unlike(&pick("id"), values)?,
        // A video twice is removed by its later slots, not by its ID
        playlist => remove_from_playlist(playlist, &pick("slot"), values)?,
    };
    change.what = format!(
        "Remove {} (the first of each stays)",
        count(change.items.len(), "duplicate")
    );
    Ok(change)
}

fn count(number: usize, noun: &str) -> String {
    format!("{number} {noun}{}", if number == 1 { "" } else { "s" })
}

/// A song's title in lower case, letters and digits only
fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The duplicates in a list: a video twice, or one song as several videos
/// (the same title and first artist, lengths within 2 s). The first of each
/// stays; the indexes of the others come back.
pub fn duplicates(items: &[Item]) -> Vec<usize> {
    let mut ids = std::collections::HashSet::new();
    // The lengths of the songs kept, by title and first artist
    let mut kept: std::collections::HashMap<(String, String), Vec<u64>> = Default::default();
    let mut extra = vec![];
    for (index, item) in items.iter().enumerate() {
        if !matches!(item.kind.as_str(), "song" | "video" | "episode") {
            continue;
        }
        let title = plain(&item.title);
        let artist = item.artists.first().map(|artist| plain(&artist.name));
        // Without a title and an artist, only the same video counts
        let key = artist
            .filter(|artist| !artist.is_empty() && !title.is_empty())
            .map(|artist| (title, artist));
        let same_song = key.as_ref().is_some_and(|key| {
            kept.get(key).is_some_and(|lengths| {
                item.duration
                    .is_some_and(|length| lengths.iter().any(|other| other.abs_diff(length) <= 2))
            })
        });
        if !ids.insert(item.id.clone()) || same_song {
            extra.push(index);
        } else if let (Some(key), Some(length)) = (key, item.duration) {
            kept.entry(key).or_default().push(length);
        }
    }
    extra
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str, title: &str, artist: &str, seconds: u64, slot: &str) -> Value {
        json!({
            "type": "song", "id": id, "title": title, "subtitle": "",
            "artists": [{ "id": null, "name": artist }], "album": null,
            "duration": seconds, "available": true, "slot": slot,
            "library": { "saved": true, "add": format!("add-{id}"), "remove": format!("remove-{id}") },
            "like": "LIKE"
        })
    }

    #[test]
    fn duplicates_keep_the_first() {
        let list = [
            song("aaaaaaaaaaa", "Numb", "Linkin Park", 185, "S1"),
            song("bbbbbbbbbbb", "Numb!", "linkin park", 186, "S2"),
            song("aaaaaaaaaaa", "Numb", "Linkin Park", 185, "S3"),
            song("ccccccccccc", "Numb", "Linkin Park", 240, "S4"),
            song("ddddddddddd", "Numb", "Another", 185, "S5"),
            // Without an artist, a title and a length are not enough
            song("eeeeeeeeeee", "Intro", "", 30, "S6"),
            song("fffffffffff", "Intro", "", 31, "S7"),
        ];
        assert_eq!(duplicates(&parsed(&list)), vec![1, 2]);
    }

    #[test]
    fn library_removals_undo_with_the_add_tokens() {
        let songs = [song("aaaaaaaaaaa", "A", "X", 1, "")];
        let albums = [json!({
            "type": "album", "id": "MPREb_x", "title": "B", "subtitle": "", "artists": [],
            "album": null, "duration": null, "available": true, "playlistId": "OLAK5uy_x"
        })];
        let change =
            remove_from_library(&["aaaaaaaaaaa".into(), "MPREb_x".into()], &songs, &albums)
                .unwrap();
        assert_eq!(change.items.len(), 2);
        assert_eq!(
            change.steps[0],
            (
                post(
                    "/api/v1/library/feedback",
                    json!({ "tokens": ["remove-aaaaaaaaaaa"] })
                ),
                Some(post(
                    "/api/v1/library/feedback",
                    json!({ "tokens": ["add-aaaaaaaaaaa"] })
                )),
            )
        );
        assert_eq!(
            change.steps[1].0.body,
            json!({ "status": "INDIFFERENT", "playlistId": "OLAK5uy_x" })
        );
        assert_eq!(change.steps[1].1.as_ref().unwrap().body["status"], "LIKE");
        assert!(remove_from_library(&["zzzzzzzzzzz".into()], &songs, &albums).is_err());
    }

    #[test]
    fn playlist_removals_go_by_slot_and_come_back_at_the_end() {
        let tracks = [
            song("aaaaaaaaaaa", "A", "X", 1, "S1"),
            song("bbbbbbbbbbb", "B", "X", 1, "S2"),
            song("aaaaaaaaaaa", "A", "X", 1, "S3"),
        ];
        // A video ID picks all of its slots; a slot picked twice counts once
        let change =
            remove_from_playlist("PLx", &["aaaaaaaaaaa".into(), "S1".into()], &tracks).unwrap();
        assert_eq!(change.items.len(), 2);
        assert_eq!(
            change.steps[0].0.body,
            json!({ "items": [
                { "videoId": "aaaaaaaaaaa", "slot": "S1" },
                { "videoId": "aaaaaaaaaaa", "slot": "S3" },
            ] })
        );
        assert_eq!(
            change.steps[0].1,
            Some(post(
                "/api/v1/playlists/PLx/add",
                json!({ "videoIds": ["aaaaaaaaaaa", "aaaaaaaaaaa"], "duplicates": true })
            ))
        );
        assert!(remove_from_playlist("PLx", &["S9".into()], &tracks).is_err());
    }

    #[test]
    fn dedupe_removes_later_slots_from_playlists() {
        let tracks = [
            song("aaaaaaaaaaa", "A", "X", 100, "S1"),
            song("aaaaaaaaaaa", "A", "X", 100, "S2"),
        ];
        let change = dedupe("PLx", &tracks).unwrap();
        assert_eq!(change.items.len(), 1);
        assert_eq!(
            change.steps[0].0.body,
            json!({ "items": [{ "videoId": "aaaaaaaaaaa", "slot": "S2" }] })
        );
        let songs = [
            song("aaaaaaaaaaa", "A", "X", 100, ""),
            song("bbbbbbbbbbb", "A", "X", 101, ""),
        ];
        let change = dedupe("songs", &songs).unwrap();
        assert_eq!(
            change.steps[0].0.body,
            json!({ "tokens": ["remove-bbbbbbbbbbb"] })
        );
    }

    #[test]
    fn deleted_playlists_come_back_as_new_ones() {
        let tracks = [song("aaaaaaaaaaa", "A", "X", 1, "S1")];
        let change = delete_playlist("PLx", "Mine", &tracks);
        assert_eq!(change.steps[0].0.method, "DELETE");
        assert_eq!(change.steps[0].1, None);
        assert_eq!(
            change.recreate,
            Some(Recreate {
                title: "Mine".into(),
                songs: vec!["aaaaaaaaaaa".into()]
            })
        );
    }

    #[test]
    fn refused_tokens_stay_out_of_the_undo() {
        let back = post(
            "/api/v1/library/feedback",
            json!({ "tokens": ["a", "b", "c"] }),
        );
        let (kept, refused) = taken(
            Some(back.clone()),
            Some(&json!({ "processed": [true, false, true] })),
        );
        assert_eq!(refused, 1);
        assert_eq!(kept.unwrap().body, json!({ "tokens": ["a", "c"] }));
        assert_eq!(taken(Some(back.clone()), None), (Some(back.clone()), 0));
        assert_eq!(
            taken(
                Some(back),
                Some(&json!({ "processed": [false, false, false] }))
            ),
            (None, 3)
        );
    }

    #[test]
    fn library_removals_go_in_requests_of_200_tokens() {
        let songs: Vec<Value> = (0..201)
            .map(|n| song(&format!("{n:011}"), "A", "X", 1, ""))
            .collect();
        let ids: Vec<String> = (0..201).map(|n| format!("{n:011}")).collect();
        let change = remove_from_library(&ids, &songs, &[]).unwrap();
        assert_eq!(change.steps.len(), 2);
        assert_eq!(
            change.steps[0].0.body["tokens"].as_array().unwrap().len(),
            200
        );
        assert_eq!(
            change.steps[1].1.as_ref().unwrap().body["tokens"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unlikes_only_liked_songs() {
        let likes = [song("aaaaaaaaaaa", "A", "X", 1, "")];
        let change = unlike(&["aaaaaaaaaaa".into()], &likes).unwrap();
        assert_eq!(
            change.steps[0].0.body,
            json!({ "status": "INDIFFERENT", "videoId": "aaaaaaaaaaa" })
        );
        assert!(unlike(&["bbbbbbbbbbb".into()], &likes).is_err());
    }

    #[test]
    fn the_undo_log_keeps_batches_in_order() {
        let path = std::env::temp_dir()
            .join(format!("ytmpc-undo-{}", std::process::id()))
            .join("undo.jsonl");
        let batch = |what: &str| Batch {
            at: 1,
            what: what.into(),
            address: "127.0.0.1:26538".into(),
            undo: vec![post("/api/v1/library/feedback", json!({ "tokens": ["t"] }))],
            recreate: None,
        };
        push(&path, batch("first")).unwrap();
        push(&path, batch("second")).unwrap();
        let mut batches = read_log(&path).unwrap();
        assert_eq!(batches.pop().unwrap().what, "second");
        write_log(&path, &batches).unwrap();
        assert_eq!(read_log(&path).unwrap(), vec![batch("first")]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
