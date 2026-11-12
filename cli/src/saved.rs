// Saved sets: the songs of a set under a name, one JSON file each in
// $XDG_DATA_HOME/ytmpc/sets (~/.local/share/ytmpc/sets by default).
use std::{
    env, fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    items::Item,
    rien::{Method, Rien},
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Song {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub duration: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct File {
    name: String,
    songs: Vec<Song>,
}

/// $XDG_DATA_HOME/ytmpc, ~/.local/share/ytmpc by default
pub fn data_dir() -> PathBuf {
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_default()
        .join("ytmpc")
}

pub fn dir() -> PathBuf {
    data_dir().join("sets")
}

/// Writes a file beside it under a name of its own and renames it over it,
/// so a failed write keeps the old file and two writes at once don't mix
pub fn write_file(path: &std::path::Path, text: &str) -> Result<()> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let partial = path.with_extension(format!("{}-{nanos}.partial", std::process::id()));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .and_then(|mut out| std::io::Write::write_all(&mut out, text.as_bytes()))
        .and_then(|()| fs::rename(&partial, path));
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written.with_context(|| format!("Can't save {}", path.display()))
}

/// A name is a file name too: letters, digits, spaces, - _ and . only
pub fn check(name: &str) -> Result<()> {
    let fine = !name.trim().is_empty()
        && name.chars().count() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'));
    if !fine {
        bail!(
            "\"{name}\" can't be a set's name: use letters, digits, spaces, - _ and . (64 at most)"
        );
    }
    Ok(())
}

fn path(name: &str) -> Result<PathBuf> {
    check(name)?;
    Ok(dir().join(format!("{name}.json")))
}

/// Saves the songs of a set; songs only, since the rest can't be queued one by one
pub fn save(name: &str, items: &[Item]) -> Result<usize> {
    let songs: Vec<Song> = items
        .iter()
        .filter(|item| matches!(item.kind.as_str(), "song" | "video" | "episode"))
        .map(|item| Song {
            id: item.id.clone(),
            title: item.title.clone(),
            artists: item
                .artists
                .iter()
                .map(|artist| artist.name.clone())
                .collect(),
            duration: item.duration,
        })
        .collect();
    if songs.is_empty() {
        bail!("The set has no songs to save");
    }
    let path = path(name)?;
    fs::create_dir_all(dir())?;
    let file = File {
        name: name.to_owned(),
        songs,
    };
    write_file(&path, &serde_json::to_string_pretty(&file)?)?;
    Ok(file.songs.len())
}

pub fn load(name: &str) -> Result<Vec<Song>> {
    let path = path(name)?;
    let text =
        fs::read_to_string(&path).with_context(|| format!("No saved set called \"{name}\""))?;
    let file: File =
        serde_json::from_str(&text).with_context(|| format!("{} has an error", path.display()))?;
    Ok(file.songs)
}

/// A saved set's name and songs
pub type Set = (String, Vec<Song>);

/// The saved sets by name, and the files that can't be read as one
pub fn list() -> Result<(Vec<Set>, Vec<String>)> {
    let entries = match fs::read_dir(dir()) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(error) => return Err(error).with_context(|| format!("Can't read {}", dir().display())),
    };
    let (mut sets, mut broken) = (Vec::new(), Vec::new());
    for entry in entries {
        let path = entry?.path();
        let Some(name) = path
            .extension()
            .filter(|ext| *ext == "json")
            .and(path.file_stem())
            .and_then(|stem| stem.to_str())
        else {
            continue;
        };
        match load(name) {
            Ok(songs) => sets.push((name.to_owned(), songs)),
            Err(_) => broken.push(path.display().to_string()),
        }
    }
    sets.sort_by_key(|(name, _)| name.to_lowercase());
    Ok((sets, broken))
}

pub fn forget(name: &str) -> Result<()> {
    let path = path(name)?;
    fs::remove_file(&path).with_context(|| format!("No saved set called \"{name}\""))
}

/// The set's songs: their IDs and places in the queue
fn queue(rien: &mut Rien) -> Result<Vec<(String, String)>> {
    let set = rien
        .request(Method::Get, "/api/v1/queue/items", None)?
        .unwrap_or(Value::Null);
    Ok(set["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let field = |key: &str| item[key].as_str().unwrap_or_default().to_owned();
            (field("id"), field("slot"))
        })
        .collect())
}

/// Waits up to `seconds` for the set to pass `done`
fn wait(
    rien: &mut Rien,
    seconds: u64,
    what: &str,
    done: impl Fn(&[(String, String)]) -> bool,
) -> Result<()> {
    let started = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(250));
        if done(&queue(rien)?) {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(seconds) {
            bail!("Rien didn't {what} in time");
        }
    }
}

/// Plays a saved set: the first song now with the rest after it, or all of
/// them at the end of the set as it is
pub fn play(rien: &mut Rien, songs: &[Song], append: bool) -> Result<()> {
    let Some((first, rest)) = songs.split_first() else {
        bail!("The saved set is empty");
    };
    let mut queued: &[Song] = songs;
    if !append {
        // The page answers before it starts the new queue, which may begin
        // with the same song, so the wait looks for places the old one lacked
        let old: Vec<String> = queue(rien)?.into_iter().map(|(_, slot)| slot).collect();
        rien.request(
            Method::Post,
            "/api/v1/play-now",
            Some(&json!({ "videoId": first.id })),
        )?;
        wait(rien, 15, "start the set's first song", |set| {
            set.first().is_some_and(|(id, slot)| {
                *id == first.id && (slot.is_empty() || !old.contains(slot))
            })
        })?;
        queued = rest;
    }
    // Each batch lands before the next goes, so they keep their order
    for chunk in queued.chunks(200) {
        let before = queue(rien)?.len();
        let ids: Vec<&str> = chunk.iter().map(|song| song.id.as_str()).collect();
        let body = json!({ "videoIds": ids, "insertPosition": "INSERT_AT_END" });
        rien.request(Method::Post, "/api/v1/queue", Some(&body))?;
        wait(rien, 20, "add the set's songs", |set| {
            set.len() >= before + chunk.len()
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_file_names() {
        assert!(check("Late night").is_ok());
        assert!(check("Läufer-2_b.mix").is_ok());
        for bad in ["", " ", ".hidden", "a/b", "..", "x\\y", &"n".repeat(65)] {
            assert!(check(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn sets_save_load_list_and_go() {
        let data = std::env::temp_dir().join(format!("ytmpc-saved-{}", std::process::id()));
        // SAFETY: this test is the only one that reads XDG_DATA_HOME
        unsafe { env::set_var("XDG_DATA_HOME", &data) };
        let items: Vec<Item> = serde_json::from_value(json!([
            { "type": "song", "id": "a", "title": "A", "subtitle": "", "artists": [{ "name": "X" }], "album": null, "duration": 60, "available": true },
            { "type": "album", "id": "MPRE", "title": "B", "subtitle": "", "artists": [], "album": null, "duration": null, "available": true },
        ]))
        .unwrap();
        assert_eq!(save("Mix", &items).unwrap(), 1);
        assert_eq!(
            load("Mix").unwrap(),
            vec![Song {
                id: "a".into(),
                title: "A".into(),
                artists: vec!["X".into()],
                duration: Some(60)
            }]
        );
        fs::write(dir().join("Broken.json"), "{").unwrap();
        let (sets, broken) = list().unwrap();
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].0, "Mix");
        assert_eq!(broken.len(), 1);
        assert!(broken[0].ends_with("Broken.json"), "{broken:?}");
        forget("Mix").unwrap();
        assert!(load("Mix").is_err());
        fs::remove_dir_all(data).unwrap();
    }
}
