// ytmpc: Rien's terminal client. One-shot commands over Rien's API server.
mod items;
mod library;
mod rien;
mod saved;
mod tui;

use std::{
    env, fs,
    io::IsTerminal,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    items::{clean, print_items, say, song, time},
    rien::{Method, Rien},
};

const HELP: &str = "\
ytmpc: Rien's terminal client

Usage: ytmpc [command] [--json]

  (no command)               the full-screen client, in a terminal
  status                     what plays (the default outside a terminal)
  watch                      print changes as they happen
  play [ID] [--list LIST]    resume, or play a song, an album or a playlist
                             (from one of its songs with --list)
  toggle | next | previous   play or pause, skip, go back
  search QUERY [--filter KIND] [--next TOKEN]
                             KIND: all, songs, videos, albums, artists, playlists
  album ID | artist ID | playlist ID [--next TOKEN]
  queue                      the queue, the playing song marked
  queue add ID [--up-next] | queue go N | queue rm N | queue clear
  queue save NAME | queue load NAME [--append] | queue saved | queue forget NAME
                             sets kept in ~/.local/share/ytmpc/sets
  library [KIND] [--all] [--next TOKEN]
                             the signed-in library; KIND: songs (default),
                             albums, artists, subscriptions, playlists, likes,
                             history
  library export [FILE]      all of it as JSON, playlists' songs included
  library remove ID...       songs or albums out of the library
  library dedupe [songs | likes | PLAYLIST]
                             a video twice, or one song as several, out
  unlike ID...               songs out of the liked ones
  playlist remove ID SLOT... | playlist delete ID
  undo [--list]              take back the last applied change
                             Changes are dry runs until --apply, which saves a
                             snapshot of the library first
  lyrics                     the current song's lyrics, from Synced Lyrics
  download [ID]              download the current song, or ID
  pair                       ask Rien for access again

--json prints Rien's answer as JSON, for scripts and agents.
Rien's API server must be on (Plugins > Other apps and services > API Server),
without HTTPS: ytmpc talks to it over plain HTTP on this computer.
Settings, in ~/.config/ytmpc:
  config.toml   address = \"127.0.0.1:26538\"
                mouse = true      the wheel and clicks in the full-screen client
                [keys]            key = action, with mpv's key names; \"\" unbinds
                                  (? in the full-screen client lists them)
  theme.toml    background, text, text_dim, text_faint, accent, selection,
                rule, played, warning, error = \"#rrggbb\" (background \"none\":
                the terminal's own)
";

#[derive(Deserialize, Default)]
struct Config {
    address: Option<String>,
    /// Key name to action for the full-screen client, mpv style
    #[serde(default)]
    keys: std::collections::HashMap<String, String>,
    /// The wheel and clicks in the full-screen client
    #[serde(default)]
    mouse: bool,
}

fn config_dir() -> PathBuf {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_default()
        .join("ytmpc")
}

/// Removes `name` from the arguments and tells whether it was there.
fn flag(args: &mut Vec<String>, name: &str) -> bool {
    let before = args.len();
    args.retain(|arg| arg != name);
    args.len() != before
}

/// Removes `name` and the value after it from the arguments.
fn option(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    let Some(at) = args.iter().position(|arg| arg == name) else {
        return Ok(None);
    };
    if at + 1 >= args.len() {
        bail!("{name} needs a value");
    }
    let value = args.remove(at + 1);
    args.remove(at);
    Ok(Some(value))
}

/// What `play` gets: a video ID is 11 characters; an album's browse ID starts
/// with MPRE; anything else is a playlist ID, with or without VL.
enum Target {
    Song(String),
    Album(String),
    List(String),
}

fn target(id: &str) -> Target {
    if id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Target::Song(id.to_owned())
    } else if id.starts_with("MPRE") {
        Target::Album(id.to_owned())
    } else {
        Target::List(id.strip_prefix("VL").unwrap_or(id).to_owned())
    }
}

/// A JSON object of the fields that have a value: the API refuses null for an
/// optional field.
fn fields(pairs: &[(&str, Option<&str>)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .filter_map(|(key, value)| value.map(|value| (key.to_string(), json!(value))))
            .collect(),
    )
}

fn number(value: Option<&String>) -> Result<usize> {
    value
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|number| *number > 0)
        .context("needs a position: 1 is the first song")
}

pub(crate) fn query(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A playlist's title; an error when Rien finds no such playlist
fn playlist_title(rien: &mut Rien, id: &str) -> Result<String> {
    let path = format!("/api/v1/browse/playlist/{}", query(id));
    let first = rien.request(Method::Get, &path, None)?.unwrap_or_default();
    match first["playlist"]["title"].as_str() {
        Some(title) if !title.is_empty() => Ok(title.to_owned()),
        _ => bail!("Rien found no playlist {id}"),
    }
}

/// Opens Rien (on macOS through Launch Services, elsewhere from PATH) and
/// waits for its API server
fn start_rien(rien: &Rien, address: &str) -> Result<()> {
    eprintln!("Starting Rien…");
    let mut command = if cfg!(target_os = "macos") {
        let mut open = Command::new("open");
        open.args(["-g", "-a", "Rien"]);
        open
    } else {
        Command::new("rien")
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Err(error) = command.spawn() {
        bail!("Can't start Rien ({error}). Start it, then run ytmpc again.");
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if rien.reachable() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }
    bail!(
        "Rien didn't answer at {address}. If it runs, turn on Plugins > Other apps and services > API Server."
    )
}

fn main() {
    if let Err(error) = run() {
        eprintln!("ytmpc: {}", items::clean(&format!("{error:#}")));
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if flag(&mut args, "--help")
        || flag(&mut args, "-h")
        || args.first().is_some_and(|arg| arg == "help")
    {
        print!("{HELP}");
        return Ok(());
    }
    let as_json = flag(&mut args, "--json");
    let apply = flag(&mut args, "--apply");
    let every_page = flag(&mut args, "--all");
    // `undo --list` takes no value, unlike `play --list LIST`
    let undo_list = args.first().is_some_and(|arg| arg == "undo") && flag(&mut args, "--list");
    let up_next = flag(&mut args, "--up-next");
    let append = flag(&mut args, "--append");
    let filter = option(&mut args, "--filter")?;
    let next = option(&mut args, "--next")?;
    let list = option(&mut args, "--list")?;

    let dir = config_dir();
    let config: Config = match fs::read_to_string(dir.join("config.toml")) {
        Ok(text) => toml::from_str(&text).context("~/.config/ytmpc/config.toml has an error")?,
        Err(_) => Config::default(),
    };
    let address = config.address.unwrap_or_else(|| "127.0.0.1:26538".into());
    let mut rien = Rien::new(address.clone(), dir.clone());

    // No command in a terminal opens the full-screen client, which starts
    // Rien when it doesn't answer; commands never do
    if args.is_empty() && std::io::stdout().is_terminal() && !as_json {
        if !rien.reachable() {
            start_rien(&rien, &address)?;
        }
        // Asks for access before the screen changes, so the prompt shows
        rien.request(Method::Get, "/api/v1/song", None)?;
        let feed = Rien::new(address, dir.clone()).quiet();
        let state = env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
            .unwrap_or_default()
            .join("ytmpc");
        let options = tui::Options {
            theme: &dir.join("theme.toml"),
            keys: &config.keys,
            mouse: config.mouse,
            state: &state,
        };
        return tui::run(rien.quiet(), feed, options);
    }

    // Prints JSON as is, or hands it to the human printer
    let show = |answer: Option<Value>, human: &dyn Fn(&Value)| match (answer, as_json) {
        (Some(answer), true) => println!("{answer}"),
        (Some(answer), false) => human(&answer),
        (None, true) => println!("null"),
        (None, false) => {}
    };
    let continuation = |next: &Option<String>| {
        next.as_deref()
            .map(|token| format!("continuation={}", query(token)))
            .unwrap_or_default()
    };
    // Commands that change something print Rien's answer only as JSON
    let act = |answer: Option<Value>| {
        if as_json {
            println!("{}", answer.unwrap_or(Value::Null));
        }
    };
    let print_next = |answer: &Value| {
        if let Some(token) = answer["continuation"].as_str() {
            say(&format!("more: --next {token}"));
        }
    };

    let command = args.first().cloned().unwrap_or_else(|| "status".into());
    let rest = &args[1.min(args.len())..];
    match command.as_str() {
        "status" => {
            let answer = rien.request(Method::Get, "/api/v1/song", None)?;
            if answer.is_none() && !as_json {
                println!("Nothing plays.");
            }
            show(answer, &|song_info| say(&song(song_info)));
        }
        "watch" => rien.watch(|event| {
            if as_json {
                println!("{event}");
            } else if let Some(info) = event.get("song").filter(|info| info.is_object()) {
                say(&song(info));
            } else if let Some(playing) = event["isPlaying"].as_bool() {
                println!("{}", if playing { "▶" } else { "⏸" });
            }
            Ok(())
        })?,
        "play" => match rest.first().map(|id| target(id)) {
            None if list.is_none() => {
                act(rien.request(Method::Post, "/api/v1/play", None)?);
            }
            None => {
                let body = fields(&[("playlistId", list.as_deref())]);
                act(rien.request(Method::Post, "/api/v1/play-now", Some(&body))?);
            }
            Some(Target::Song(video_id)) => {
                let body = fields(&[
                    ("videoId", Some(&video_id)),
                    ("playlistId", list.as_deref()),
                ]);
                act(rien.request(Method::Post, "/api/v1/play-now", Some(&body))?);
            }
            Some(Target::List(playlist_id)) => {
                act(rien.request(
                    Method::Post,
                    "/api/v1/play-now",
                    Some(&json!({ "playlistId": playlist_id })),
                )?);
            }
            Some(Target::Album(album_id)) => {
                let album = rien
                    .request(
                        Method::Get,
                        &format!("/api/v1/browse/album/{album_id}"),
                        None,
                    )?
                    .unwrap_or_default();
                let playlist_id = album["album"]["playlistId"]
                    .as_str()
                    .context("Rien found no list to play for this album")?
                    .to_owned();
                act(rien.request(
                    Method::Post,
                    "/api/v1/play-now",
                    Some(&json!({ "playlistId": playlist_id })),
                )?);
            }
        },
        "toggle" => {
            act(rien.request(Method::Post, "/api/v1/toggle-play", None)?);
        }
        "next" => {
            act(rien.request(Method::Post, "/api/v1/next", None)?);
        }
        "previous" | "prev" => {
            act(rien.request(Method::Post, "/api/v1/previous", None)?);
        }
        "search" => {
            if rest.is_empty() {
                bail!("search needs words to look for");
            }
            let path = format!(
                "/api/v1/browse/search?q={}&filter={}&{}",
                query(&rest.join(" ")),
                query(filter.as_deref().unwrap_or("all")),
                continuation(&next)
            );
            show(rien.request(Method::Get, &path, None)?, &|answer| {
                print_items(&answer["items"], None);
                print_next(answer);
            });
        }
        "playlist" if rest.first().is_some_and(|arg| arg == "remove") => {
            let id = rest.get(1).context("playlist remove needs a playlist ID")?;
            if rest.len() < 3 {
                bail!("playlist remove needs the slots or video IDs to remove");
            }
            playlist_title(&mut rien, id)?;
            let tracks = library::all(
                &mut rien,
                &format!("/api/v1/browse/playlist/{}", query(id)),
                "tracks",
            )?;
            let change = library::remove_from_playlist(id, &rest[2..], &tracks)?;
            library::run(&mut rien, change, apply, as_json)?;
        }
        "playlist" if rest.first().is_some_and(|arg| arg == "delete") => {
            let id = rest.get(1).context("playlist delete needs a playlist ID")?;
            let title = playlist_title(&mut rien, id)?;
            let path = format!("/api/v1/browse/playlist/{}", query(id));
            let tracks = library::all(&mut rien, &path, "tracks")?;
            let change = library::delete_playlist(id, &title, &tracks);
            library::run(&mut rien, change, apply, as_json)?;
        }
        "library" => match rest.first().map(String::as_str) {
            Some("export") => {
                let value = library::export(&mut rien)?;
                let file =
                    library::write_export(&value, rest.get(1).map(String::as_str), "exports")?;
                if as_json {
                    println!("{}", json!({ "file": file }));
                } else {
                    say(&format!("Saved the library to {}", file.display()));
                }
            }
            Some("remove") => {
                if rest.len() < 2 {
                    bail!("library remove needs the IDs of songs or albums");
                }
                let songs = library::all(&mut rien, "/api/v1/library/songs", "items")?;
                let albums = library::all(&mut rien, "/api/v1/library/albums", "items")?;
                let change = library::remove_from_library(&rest[1..], &songs, &albums)?;
                library::run(&mut rien, change, apply, as_json)?;
            }
            Some("dedupe") => {
                let list = rest.get(1).map_or("songs", String::as_str);
                let path = match list {
                    "songs" | "likes" => format!("/api/v1/library/{list}"),
                    id => {
                        playlist_title(&mut rien, id)?;
                        format!("/api/v1/browse/playlist/{}", query(id))
                    }
                };
                let key = if matches!(list, "songs" | "likes") {
                    "items"
                } else {
                    "tracks"
                };
                let values = library::all(&mut rien, &path, key)?;
                let change = library::dedupe(list, &values)?;
                library::run(&mut rien, change, apply, as_json)?;
            }
            kind => {
                let kind = kind.unwrap_or("songs");
                if !library::KINDS.contains(&kind) {
                    bail!("unknown library list: {kind} (see ytmpc help)");
                }
                let path = format!("/api/v1/library/{kind}");
                if every_page {
                    let items = Value::Array(library::all(&mut rien, &path, "items")?);
                    show(
                        Some(json!({ "items": items, "continuation": null })),
                        &|answer| {
                            print_items(&answer["items"], None);
                        },
                    );
                } else {
                    let path = format!("{path}?{}", continuation(&next));
                    show(rien.request(Method::Get, &path, None)?, &|answer| {
                        print_items(&answer["items"], None);
                        print_next(answer);
                    });
                }
            }
        },
        "unlike" => {
            if rest.is_empty() {
                bail!("unlike needs the video IDs of liked songs");
            }
            let likes = library::all(&mut rien, "/api/v1/library/likes", "items")?;
            let change = library::unlike(rest, &likes)?;
            library::run(&mut rien, change, apply, as_json)?;
        }
        "undo" => library::undo(&mut rien, undo_list, as_json)?,
        "album" | "artist" | "playlist" => {
            let id = rest.first().context("needs an ID")?;
            let path = format!(
                "/api/v1/browse/{command}/{}?{}",
                query(id),
                continuation(&next)
            );
            show(
                rien.request(Method::Get, &path, None)?,
                &|answer| match command.as_str() {
                    "album" => {
                        let album = &answer["album"];
                        say(&format!(
                            "{} · {}",
                            album["title"].as_str().unwrap_or_default(),
                            album["subtitle"].as_str().unwrap_or_default()
                        ));
                        say(album["stats"].as_str().unwrap_or_default());
                        print_items(&answer["tracks"], None);
                    }
                    "artist" => {
                        let artist = &answer["artist"];
                        say(&format!(
                            "{} · {}",
                            artist["name"].as_str().unwrap_or_default(),
                            artist["stats"].as_str().unwrap_or_default()
                        ));
                        for section in answer["sections"].as_array().into_iter().flatten() {
                            say(&format!(
                                "\n{}",
                                section["title"].as_str().unwrap_or_default()
                            ));
                            print_items(&section["items"], None);
                            if let Some(more) = section["more"].as_str() {
                                say(&format!("all: {more}"));
                            }
                        }
                    }
                    _ => {
                        if let Some(playlist) = answer["playlist"].as_object() {
                            let text = |key: &str| {
                                playlist
                                    .get(key)
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                            };
                            say(&format!("{} · {}", text("title"), text("subtitle")));
                            say(text("stats"));
                        }
                        print_items(&answer["tracks"], None);
                        print_next(answer);
                    }
                },
            );
        }
        "queue" => match rest.first().map(String::as_str) {
            None => show(
                rien.request(Method::Get, "/api/v1/queue/items", None)?,
                &|answer| {
                    let current = answer["current"].as_u64().map(|index| index as usize);
                    print_items(&answer["items"], current);
                },
            ),
            Some("add") => {
                let id = rest.get(1).context("queue add needs a video ID")?;
                let position = if up_next {
                    "INSERT_AFTER_CURRENT_VIDEO"
                } else {
                    "INSERT_AT_END"
                };
                let body = json!({ "videoId": id, "insertPosition": position });
                act(rien.request(Method::Post, "/api/v1/queue", Some(&body))?);
            }
            Some("go") => {
                let index = number(rest.get(1))? - 1;
                act(rien.request(
                    Method::Patch,
                    "/api/v1/queue",
                    Some(&json!({ "index": index })),
                )?);
            }
            Some("rm") => {
                let index = number(rest.get(1))? - 1;
                act(rien.request(Method::Delete, &format!("/api/v1/queue/{index}"), None)?);
            }
            Some("clear") => {
                act(rien.request(Method::Delete, "/api/v1/queue", None)?);
            }
            Some("save") => {
                let name = rest[1..].join(" ");
                let set = rien
                    .request(Method::Get, "/api/v1/queue/items", None)?
                    .unwrap_or_default();
                let count = saved::save(&name, &items::items(&set["items"]))?;
                if as_json {
                    println!("null");
                } else {
                    say(&format!("Saved {count} songs as \"{name}\"."));
                }
            }
            Some("load") => {
                let name = rest[1..].join(" ");
                let songs = saved::load(&name)?;
                saved::play(&mut rien, &songs, append)?;
                if as_json {
                    println!("null");
                } else {
                    say(&if append {
                        format!("Added \"{name}\", {} songs, to the set.", songs.len())
                    } else {
                        format!("Playing \"{name}\", {} songs.", songs.len())
                    });
                }
            }
            Some("saved") => {
                let (sets, broken) = saved::list()?;
                for path in &broken {
                    eprintln!("ytmpc: {} can't be read as a saved set", clean(path));
                }
                if as_json {
                    let list: Vec<Value> = sets
                        .iter()
                        .map(|(name, songs)| json!({ "name": name, "songs": songs }))
                        .collect();
                    println!("{}", Value::Array(list));
                } else if sets.is_empty() {
                    println!("No saved sets yet: ytmpc queue save NAME");
                }
                for (name, songs) in sets.iter().filter(|_| !as_json) {
                    let total: u64 = songs.iter().filter_map(|song| song.duration).sum();
                    say(&format!("{name}  {} songs  {}", songs.len(), time(total)));
                }
            }
            Some("forget") => {
                let name = rest[1..].join(" ");
                saved::forget(&name)?;
                if as_json {
                    println!("null");
                } else {
                    say(&format!("Forgot \"{name}\"."));
                }
            }
            Some(other) => bail!("unknown queue command: {other} (see ytmpc help)"),
        },
        "lyrics" => {
            let answer = rien.request(Method::Get, "/api/v1/lyrics", None)?;
            if answer.is_none() && !as_json {
                println!("No lyrics for this song yet.");
            }
            show(answer, &|lyrics| match lyrics["lines"].as_array() {
                Some(lines) => {
                    for line in lines {
                        let at = line["timeMs"].as_u64().unwrap_or(0) / 1000;
                        say(&format!(
                            "[{}] {}",
                            time(at),
                            line["text"].as_str().unwrap_or_default()
                        ));
                    }
                }
                None => say(lyrics["plain"].as_str().unwrap_or_default()),
            });
        }
        "download" => {
            let body = fields(&[("videoId", rest.first().map(String::as_str))]);
            act(rien.request(Method::Post, "/api/v1/download", Some(&body))?);
            if !as_json {
                println!("Downloading in Rien.");
            }
        }
        "pair" => rien.pair()?,
        other => bail!("unknown command: {other} (see ytmpc help)"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn flags_and_options_leave_the_rest() {
        let mut args = strings(&["search", "--filter", "songs", "linkin", "--json", "park"]);
        assert!(flag(&mut args, "--json"));
        assert_eq!(
            option(&mut args, "--filter").unwrap().as_deref(),
            Some("songs")
        );
        assert_eq!(args, strings(&["search", "linkin", "park"]));
        assert!(option(&mut strings(&["album", "--next"]), "--next").is_err());
    }

    #[test]
    fn play_targets() {
        assert!(matches!(target("BLZWkjBXfN8"), Target::Song(_)));
        assert!(matches!(target("MPREb_qMlbe7gLeuH"), Target::Album(_)));
        assert!(
            matches!(target("VLPLd9p7ZJWGPtmbjHzxJm7dGQKy-QV0Q4xJ"), Target::List(id) if id == "PLd9p7ZJWGPtmbjHzxJm7dGQKy-QV0Q4xJ")
        );
        assert!(matches!(
            target("OLAK5uy_nE-SkwNA6lYF99wd-MHzJVqThnUIJGe3I"),
            Target::List(_)
        ));
    }

    #[test]
    fn queries_are_escaped() {
        assert_eq!(
            query("linkin park & co/é"),
            "linkin%20park%20%26%20co%2F%C3%A9"
        );
    }

    #[test]
    fn fields_leave_out_missing_values() {
        assert_eq!(
            fields(&[("videoId", Some("x")), ("playlistId", None)]),
            json!({ "videoId": "x" })
        );
    }

    #[test]
    fn positions_start_at_one() {
        assert_eq!(number(Some(&"2".to_string())).unwrap(), 2);
        assert!(number(Some(&"0".to_string())).is_err());
        assert!(number(None).is_err());
    }
}
