// The full-screen client: search, the set (Rien's queue) with the site's
// encore after it, what plays, its cover and its lyrics. Three threads feed
// one loop: keys, Rien's live feed, and a worker that makes the API calls, so
// the screen never waits on the network.
mod keys;
mod theme;
mod view;

use std::{
    collections::HashMap,
    path::Path,
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

use anyhow::Result;
use image::DynamicImage;
use ratatui::crossterm::event::{
    self, Event as TermEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use ratatui::crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use ratatui_image::{
    picker::{Capability, Picker, cap_parser::QueryStdioOptions},
    protocol::StatefulProtocol,
};
use serde_json::{Value, json};

pub use self::{
    keys::{Action, Keys},
    theme::Theme,
};
use crate::{
    items::Item,
    library, query,
    rien::{Method, Rien},
    saved,
};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Pane {
    Results,
    Set,
    Lyrics,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Filter {
    All,
    Songs,
    Videos,
    Albums,
    Artists,
    Playlists,
}

impl Filter {
    pub fn name(self) -> &'static str {
        match self {
            Filter::All => "all",
            Filter::Songs => "songs",
            Filter::Videos => "videos",
            Filter::Albums => "albums",
            Filter::Artists => "artists",
            Filter::Playlists => "playlists",
        }
    }

    fn next(self) -> Self {
        match self {
            Filter::All => Filter::Songs,
            Filter::Songs => Filter::Videos,
            Filter::Videos => Filter::Albums,
            Filter::Albums => Filter::Artists,
            Filter::Artists => Filter::Playlists,
            Filter::Playlists => Filter::All,
        }
    }
}

/// A row of a list: an item, or the title of an artist page's section
pub enum Row {
    Heading(String),
    Item(Item),
}

/// What the results pane shows: a search, or an album, artist or playlist
/// opened from it, with the list the album or playlist plays
pub struct Page {
    pub id: u64,
    /// The first row shown; it moves only to keep the selection in view
    pub offset: std::cell::Cell<usize>,
    pub title: String,
    pub rows: Vec<Row>,
    pub selected: usize,
    pub playlist_id: Option<String>,
    /// The token for the next page of a search or playlist, and the path it
    /// goes with
    pub continuation: Option<String>,
    more: Option<String>,
    loading: bool,
    /// The library list it shows (songs, likes…), where d removes from it
    pub library: Option<String>,
    /// A playlist, where d removes the song from it
    pub editable: bool,
}

static PAGES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Page {
    fn new(title: String, rows: Vec<Row>, playlist_id: Option<String>) -> Self {
        let selected = rows
            .iter()
            .position(|row| matches!(row, Row::Item(_)))
            .unwrap_or(0);
        Self {
            id: PAGES.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            offset: Default::default(),
            title,
            rows,
            selected,
            playlist_id,
            continuation: None,
            more: None,
            loading: false,
            library: None,
            editable: false,
        }
    }

    /// Gives the page a next page: `more` is the path the token goes after
    fn with_more(mut self, continuation: Option<String>, more: String) -> Self {
        self.continuation = continuation;
        self.more = Some(more);
        self
    }

    /// The request for the next page, once the selection nears the last row
    fn next_page(&mut self) -> Option<String> {
        let token = self.continuation.as_ref()?;
        let left = self.rows[self.selected.min(self.rows.len())..].len();
        if self.loading || left > 5 {
            return None;
        }
        self.loading = true;
        Some(format!(
            "{}continuation={}",
            self.more.as_deref()?,
            query(token)
        ))
    }

    pub fn item(&self) -> Option<&Item> {
        match self.rows.get(self.selected) {
            Some(Row::Item(item)) => Some(item),
            _ => None,
        }
    }

    /// Moves the selection by `by` items, skipping headings
    fn select(&mut self, by: isize) {
        let items: Vec<usize> = (0..self.rows.len())
            .filter(|&at| matches!(self.rows[at], Row::Item(_)))
            .collect();
        if items.is_empty() {
            return;
        }
        let now = items
            .iter()
            .position(|&at| at == self.selected)
            .unwrap_or(0);
        let to = (now as isize)
            .saturating_add(by)
            .clamp(0, items.len() as isize - 1) as usize;
        self.selected = items[to];
    }
}

pub struct Song {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub elapsed: u64,
    pub duration: u64,
    pub paused: bool,
}

pub struct Lyric {
    pub at_ms: u64,
    pub text: String,
}

pub struct App {
    pub query: String,
    pub editing: bool,
    /// The name being typed for the set to save
    pub saving: Option<String>,
    pub filter: Filter,
    pub pages: Vec<Page>,
    pub set: Vec<Item>,
    /// The songs the site plays after the set while autoplay is on
    pub encore: Vec<Item>,
    pub current: Option<usize>,
    /// Over the set, then the encore
    pub set_selected: usize,
    /// The set's first row shown while it has the focus
    pub set_offset: std::cell::Cell<usize>,
    pub song: Option<Song>,
    pub lyrics: Option<Result<Vec<Lyric>, String>>,
    pub pane: Pane,
    pub volume: Option<(u64, bool)>,
    pub message: Option<(String, Instant)>,
    pub help: bool,
    pub keys: Keys,
    /// The first line shown of lyrics without times
    pub lyrics_offset: usize,
    /// While Synced Lyrics still searches, the pane asks again a few times
    lyrics_tries: u8,
    lyrics_retry: Option<Instant>,
    feed_lost: bool,
    pending: Option<String>,
    /// A change to the library that waits for y
    pub confirm: Option<Confirm>,
    /// The row a library change took off the screen, back if the change fails
    taken: Option<(u64, usize, Row)>,
    /// A library change runs; the next waits for it
    changing: bool,
    quit: bool,
}

/// Work for the worker thread; the answer comes back with its tag
pub enum Job {
    Song,
    Set,
    Lyrics,
    Cover,
    Search {
        title: String,
        more: String,
    },
    More {
        page: u64,
    },
    Open {
        title: String,
        kind: String,
        id: String,
        /// The page it was opened from: an answer that comes after the user
        /// has left that page is dropped
        from: u64,
    },
    Action,
    /// Removes a song of the set, or plays it, found by its place rather
    /// than its row: the rows on screen can be older than the set
    Edit {
        remove: bool,
        index: usize,
        slot: Option<String>,
        video_id: String,
    },
    /// Plays a saved set, or adds it to the end of the set
    LoadSaved {
        name: String,
        append: bool,
    },
    /// Changes the library after a yes, as `ytmpc library …` with --apply
    /// does: a snapshot first, then the change, logged for undo. The answer
    /// is a line to show.
    Library(LibraryEdit),
    /// Puts a song into the set, waits until it is there, then skips to it
    /// if asked: Rien answers before the page has added the song
    Queue {
        video_id: String,
        up_next: bool,
        then_next: bool,
    },
}

/// The question of a change that waits for y, the change, and the row
/// (page and index) it takes away
pub type Confirm = (String, Job, Option<(u64, usize)>);

/// What the keys change in the library
#[derive(Debug, PartialEq)]
pub enum LibraryEdit {
    Remove(String),
    Unlike(String),
    FromPlaylist { playlist: String, slot: String },
    Undo,
}

/// The library's lists, with the names the LIBRARY page gives them
const LIBRARY: [(&str, &str); 7] = [
    ("songs", "Songs"),
    ("albums", "Albums"),
    ("artists", "Artists"),
    ("subscriptions", "Subscriptions"),
    ("playlists", "Playlists"),
    ("likes", "Liked songs"),
    ("history", "History"),
];

pub enum Event {
    Key(KeyEvent),
    Mouse(MouseEvent),
    Resize,
    Feed(Value),
    FeedLost(String),
    Answer(Job, Result<Option<Value>, String>),
    Cover(Option<DynamicImage>),
}

struct Request {
    job: Job,
    method: Method,
    path: String,
    body: Option<Value>,
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn items(value: &Value) -> Vec<Item> {
    crate::items::items(value)
}

impl App {
    fn new(keys: Keys) -> Self {
        Self {
            query: String::new(),
            editing: true,
            saving: None,
            filter: Filter::All,
            pages: Vec::new(),
            set: Vec::new(),
            encore: Vec::new(),
            current: None,
            set_selected: 0,
            set_offset: Default::default(),
            song: None,
            lyrics: None,
            pane: Pane::Results,
            volume: None,
            message: None,
            help: false,
            keys,
            lyrics_offset: 0,
            lyrics_tries: 0,
            lyrics_retry: None,
            feed_lost: false,
            pending: None,
            confirm: None,
            taken: None,
            changing: false,
            quit: false,
        }
    }

    fn say(&mut self, text: impl Into<String>) {
        self.message = Some((text.into(), Instant::now()));
    }

    pub fn page(&self) -> Option<&Page> {
        self.pages.last()
    }

    fn send(
        &self,
        jobs: &Sender<Request>,
        job: Job,
        method: Method,
        path: String,
        body: Option<Value>,
    ) {
        let _ = jobs.send(Request {
            job,
            method,
            path,
            body,
        });
    }

    fn act(&self, jobs: &Sender<Request>, method: Method, path: &str, body: Option<Value>) {
        self.send(jobs, Job::Action, method, path.to_owned(), body);
    }

    fn refresh(&self, jobs: &Sender<Request>) {
        self.send(jobs, Job::Song, Method::Get, "/api/v1/song".into(), None);
        self.send(
            jobs,
            Job::Set,
            Method::Get,
            "/api/v1/queue/items".into(),
            None,
        );
    }

    fn search(&mut self, jobs: &Sender<Request>) {
        if self.query.trim().is_empty() {
            return;
        }
        let more = format!(
            "/api/v1/browse/search?q={}&filter={}&",
            query(&self.query),
            self.filter.name()
        );
        let title = format!("SEARCH · {}", self.filter.name().to_uppercase());
        let path = more.trim_end_matches('&').to_owned();
        self.send(jobs, Job::Search { title, more }, Method::Get, path, None);
        self.say("Searching…");
    }

    fn lyrics(&mut self, jobs: &Sender<Request>) {
        self.pane = Pane::Lyrics;
        self.lyrics = None;
        self.lyrics_offset = 0;
        self.lyrics_tries = 0;
        self.lyrics_retry = None;
        self.ask_lyrics(jobs);
    }

    fn ask_lyrics(&self, jobs: &Sender<Request>) {
        self.send(
            jobs,
            Job::Lyrics,
            Method::Get,
            "/api/v1/lyrics".into(),
            None,
        );
    }

    /// Enter: plays a song (from the open album or playlist, if any), opens an
    /// album, artist or playlist, or goes to a song of the set
    fn enter(&mut self, jobs: &Sender<Request>) {
        match self.pane {
            Pane::Set => {
                let at = self.set_selected;
                if let Some(item) = self.set.get(at) {
                    let job = Job::Edit {
                        remove: false,
                        index: at,
                        slot: item.slot.clone(),
                        video_id: item.id.clone(),
                    };
                    self.send(jobs, job, Method::Patch, "/api/v1/queue".into(), None);
                } else if let Some(item) = self.encore.get(at - self.set.len()) {
                    // An encore song plays now, the rest of the set after it
                    let job = Job::Queue {
                        video_id: item.id.clone(),
                        up_next: true,
                        then_next: true,
                    };
                    self.send(jobs, job, Method::Post, "/api/v1/queue".into(), None);
                }
            }
            Pane::Lyrics => {}
            Pane::Results => {
                let Some(page) = self.page() else { return };
                let Some(item) = page.item() else { return };
                let (kind, id, title, list) = (
                    item.kind.clone(),
                    item.id.clone(),
                    item.title.clone(),
                    page.playlist_id.clone(),
                );
                match kind.as_str() {
                    "song" | "video" | "episode" => {
                        let mut body = json!({ "videoId": id });
                        if let Some(list) = list {
                            body["playlistId"] = json!(list);
                        }
                        self.act(jobs, Method::Post, "/api/v1/play-now", Some(body));
                    }
                    "saved" => {
                        self.send(
                            jobs,
                            Job::LoadSaved {
                                name: id,
                                append: false,
                            },
                            Method::Get,
                            String::new(),
                            None,
                        );
                        self.say(format!("Playing {title}"));
                    }
                    "library" => {
                        let from = self.page().map_or(0, |page| page.id);
                        let path = format!("/api/v1/library/{}", query(&id));
                        let job = Job::Open {
                            title: format!("LIBRARY · {}", title.to_uppercase()),
                            kind,
                            id,
                            from,
                        };
                        self.send(jobs, job, Method::Get, path, None);
                    }
                    "album" | "artist" | "playlist" => {
                        // An artist of the library's list opens as the artist
                        let id = match id.strip_prefix("MPLA") {
                            Some(channel) if kind == "artist" => channel.to_owned(),
                            _ => id,
                        };
                        let path = format!("/api/v1/browse/{kind}/{}", query(&id));
                        let from = self.page().map_or(0, |page| page.id);
                        let job = Job::Open {
                            title,
                            kind,
                            id,
                            from,
                        };
                        self.send(jobs, job, Method::Get, path, None);
                    }
                    _ => self.say("ytmpc can't open this kind yet"),
                }
            }
        }
    }

    fn add(&mut self, jobs: &Sender<Request>, up_next: bool) {
        let picked = match self.pane {
            Pane::Results => self.page().and_then(Page::item),
            Pane::Set => self
                .set_selected
                .checked_sub(self.set.len())
                .and_then(|at| self.encore.get(at)),
            Pane::Lyrics => None,
        };
        let Some(item) = picked else { return };
        let (kind, id, title) = (item.kind.clone(), item.id.clone(), item.title.clone());
        if kind == "saved" {
            self.send(
                jobs,
                Job::LoadSaved {
                    name: id,
                    append: true,
                },
                Method::Get,
                String::new(),
                None,
            );
            self.say(format!("Adding {title} to the set"));
            return;
        }
        if !matches!(kind.as_str(), "song" | "video" | "episode") {
            self.say("Only songs go into the set one by one; Enter plays a whole list");
            return;
        }
        let job = Job::Queue {
            video_id: id,
            up_next,
            then_next: false,
        };
        self.send(jobs, job, Method::Post, "/api/v1/queue".into(), None);
        self.say(format!(
            "{} {title}",
            if up_next { "Next:" } else { "Added:" }
        ));
    }

    /// d in a list: asks before it removes a song or album from the library,
    /// unlikes a liked song, or removes a song from a playlist
    fn ask_remove(&mut self) {
        if self.changing {
            return self.say("The last library change is still going");
        }
        let Some(page) = self.page() else { return };
        let Some(item) = page.item() else { return };
        let (title, id) = (item.title.clone(), item.id.clone());
        let edit = match page.library.as_deref() {
            Some("songs" | "albums") => Some((
                format!("Remove {title} from the library?"),
                LibraryEdit::Remove(id),
            )),
            Some("likes") => Some((format!("Unlike {title}?"), LibraryEdit::Unlike(id))),
            _ if page.editable => item.slot.clone().map(|slot| {
                (
                    format!("Remove {title} from this playlist?"),
                    LibraryEdit::FromPlaylist {
                        playlist: page.playlist_id.clone().unwrap_or_default(),
                        slot,
                    },
                )
            }),
            _ => None,
        };
        let row = (page.id, page.selected);
        match edit {
            Some((question, edit)) => {
                self.confirm = Some((question, Job::Library(edit), Some(row)));
            }
            None => self.say(
                "d removes from the set, the library's songs, albums and likes, and playlists",
            ),
        }
    }

    fn volume(&mut self, jobs: &Sender<Request>, by: i64) {
        let Some((volume, muted)) = self.volume else {
            return;
        };
        let volume = (volume as i64 + by).clamp(0, 100) as u64;
        self.volume = Some((volume, muted));
        self.act(
            jobs,
            Method::Post,
            "/api/v1/volume",
            Some(json!({ "volume": volume })),
        );
        self.say(format!("Volume {volume}"));
    }

    fn move_selection(&mut self, by: isize, jobs: &Sender<Request>) {
        match self.pane {
            Pane::Results => {
                let Some(page) = self.pages.last_mut() else {
                    return;
                };
                page.select(by);
                // Searches and playlists load their next page near the end
                if let Some(path) = page.next_page() {
                    let page = page.id;
                    self.send(jobs, Job::More { page }, Method::Get, path, None);
                }
            }
            Pane::Set => {
                let rows = self.set.len() + self.encore.len();
                if rows > 0 {
                    self.set_selected = (self.set_selected as isize)
                        .saturating_add(by)
                        .clamp(0, rows as isize - 1)
                        as usize;
                }
            }
            Pane::Lyrics => {
                let lines = match &self.lyrics {
                    Some(Ok(lines)) => lines.len(),
                    _ => 0,
                };
                self.lyrics_offset = (self.lyrics_offset as isize)
                    .saturating_add(by)
                    .clamp(0, lines.saturating_sub(1) as isize)
                    as usize;
            }
        }
    }

    fn perform(&mut self, action: Action, jobs: &Sender<Request>, page_rows: isize) {
        let seek = |forward: bool, seconds: u64| {
            let path = if forward {
                "/api/v1/go-forward"
            } else {
                "/api/v1/go-back"
            };
            (path, json!({ "seconds": seconds }))
        };
        match action {
            Action::Quit => self.quit = true,
            Action::Help => self.help = true,
            Action::SaveSet => self.saving = Some(String::new()),
            Action::Saved => {
                let rows = match saved::list() {
                    Ok((sets, broken)) => {
                        if !broken.is_empty() {
                            self.say(format!("Can't read as a saved set: {}", broken.join(", ")));
                        }
                        sets.into_iter()
                            .map(|(name, songs)| {
                                Row::Item(Item {
                                    kind: "saved".into(),
                                    id: name.clone(),
                                    title: name,
                                    subtitle: format!("{} songs", songs.len()),
                                    artists: Vec::new(),
                                    album: None,
                                    duration: Some(
                                        songs.iter().filter_map(|song| song.duration).sum(),
                                    ),
                                    slot: None,
                                    available: true,
                                })
                            })
                            .collect()
                    }
                    Err(error) => {
                        self.say(format!("{error:#}"));
                        return;
                    }
                };
                // Opening them again shows them again, not one more page
                if self.page().is_some_and(|page| page.title == "SAVED SETS") {
                    self.pages.pop();
                }
                self.pages.push(Page::new("SAVED SETS".into(), rows, None));
                self.pane = Pane::Results;
            }
            Action::Library => {
                let rows = LIBRARY
                    .iter()
                    .map(|(kind, name)| {
                        Row::Item(Item {
                            kind: "library".into(),
                            id: (*kind).into(),
                            title: (*name).into(),
                            subtitle: String::new(),
                            artists: Vec::new(),
                            album: None,
                            duration: None,
                            slot: None,
                            available: true,
                        })
                    })
                    .collect();
                if self.page().is_some_and(|page| page.title == "LIBRARY") {
                    self.pages.pop();
                }
                self.pages.push(Page::new("LIBRARY".into(), rows, None));
                self.pane = Pane::Results;
            }
            Action::Undo if self.changing => self.say("The last library change is still going"),
            Action::Undo => {
                self.confirm = Some((
                    "Take back the last library change?".into(),
                    Job::Library(LibraryEdit::Undo),
                    None,
                ));
            }
            Action::Search => {
                self.editing = true;
                self.query.clear();
            }
            Action::Filter => {
                self.filter = self.filter.next();
                self.search(jobs);
            }
            Action::NextPane => match self.pane {
                Pane::Results => {
                    self.pane = Pane::Set;
                    self.set_selected = self.current.unwrap_or(0);
                }
                Pane::Set => self.lyrics(jobs),
                Pane::Lyrics => self.pane = Pane::Results,
            },
            Action::Lyrics => self.lyrics(jobs),
            Action::Back => {
                if self.pane == Pane::Results && self.pages.len() > 1 {
                    self.pages.pop();
                } else {
                    self.pane = Pane::Results;
                }
            }
            Action::Down => self.move_selection(1, jobs),
            Action::Up => self.move_selection(-1, jobs),
            Action::HalfDown => self.move_selection(page_rows / 2, jobs),
            Action::HalfUp => self.move_selection(-page_rows / 2, jobs),
            Action::Top => self.move_selection(isize::MIN, jobs),
            Action::Bottom => self.move_selection(isize::MAX, jobs),
            Action::Enter => self.enter(jobs),
            Action::Add => self.add(jobs, false),
            Action::AddNext => self.add(jobs, true),
            Action::Remove if self.pane == Pane::Results => self.ask_remove(),
            Action::Remove => {
                if self.pane == Pane::Set && self.set_selected < self.set.len() {
                    // Gone from the screen at once, so the next key acts on
                    // the row that takes its place
                    let at = self.set_selected;
                    let item = self.set.remove(at);
                    self.current = match self.current {
                        Some(current) if at < current => Some(current - 1),
                        Some(current) if at == current => None,
                        current => current,
                    };
                    self.move_selection(0, jobs);
                    let job = Job::Edit {
                        remove: true,
                        index: at,
                        slot: item.slot,
                        video_id: item.id,
                    };
                    self.send(jobs, job, Method::Delete, "/api/v1/queue".into(), None);
                }
            }
            Action::Pause => self.act(jobs, Method::Post, "/api/v1/toggle-play", None),
            Action::SeekForward | Action::SeekBack | Action::NudgeForward | Action::NudgeBack => {
                let forward = matches!(action, Action::SeekForward | Action::NudgeForward);
                let seconds = if matches!(action, Action::NudgeForward | Action::NudgeBack) {
                    1
                } else {
                    5
                };
                let (path, body) = seek(forward, seconds);
                self.act(jobs, Method::Post, path, Some(body));
            }
            Action::Next => self.act(jobs, Method::Post, "/api/v1/next", None),
            Action::Previous => self.act(jobs, Method::Post, "/api/v1/previous", None),
            Action::VolumeDown => self.volume(jobs, -2),
            Action::VolumeUp => self.volume(jobs, 2),
            Action::VolumeDownMore => self.volume(jobs, -5),
            Action::VolumeUpMore => self.volume(jobs, 5),
            Action::Mute => self.act(jobs, Method::Post, "/api/v1/toggle-mute", None),
            Action::Repeat => self.act(
                jobs,
                Method::Post,
                "/api/v1/switch-repeat",
                Some(json!({ "iteration": 1 })),
            ),
        }
    }

    fn key(&mut self, key: KeyEvent, jobs: &Sender<Request>, page_rows: isize) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        // A change to the library goes ahead on y only
        if let Some((_, job, row)) = self.confirm.take() {
            // Only a plain y: Ctrl+y or Alt+y are other keys
            if key.code != KeyCode::Char('y') || !key.modifiers.is_empty() {
                self.say("Nothing changed");
                return;
            }
            if let Some((id, at)) = row
                && let Some(page) = self.pages.iter_mut().find(|found| found.id == id)
                && at < page.rows.len()
            {
                self.taken = Some((id, at, page.rows.remove(at)));
                page.selected = page.selected.min(page.rows.len().saturating_sub(1));
            }
            self.changing = true;
            self.send(jobs, job, Method::Get, String::new(), None);
            self.say("Saving a snapshot of the library, then changing it…");
            return;
        }
        if let Some(name) = self.saving.as_mut() {
            match key.code {
                KeyCode::Enter => {
                    let name = std::mem::take(name);
                    self.saving = None;
                    match saved::save(&name, &self.set) {
                        Ok(count) => self.say(format!("Saved {count} songs as {name}")),
                        Err(error) => self.say(format!("{error:#}")),
                    }
                }
                KeyCode::Esc => self.saving = None,
                KeyCode::Backspace => {
                    name.pop();
                }
                KeyCode::Char(c) if !ctrl => name.push(c),
                _ => {}
            }
            return;
        }
        if self.editing {
            match key.code {
                KeyCode::Enter => {
                    self.editing = false;
                    self.pane = Pane::Results;
                    self.search(jobs);
                }
                KeyCode::Esc => self.editing = false,
                KeyCode::Backspace => {
                    self.query.pop();
                }
                KeyCode::Char('u') if ctrl => self.query.clear(),
                KeyCode::Char(c) if !ctrl => self.query.push(c),
                _ => {}
            }
            return;
        }
        // Any key closes the key list
        if std::mem::take(&mut self.help) {
            return;
        }
        let Some(name) = keys::name(&key) else { return };
        if let Some(first) = self.pending.take()
            && let Some(action) = self.keys.action(&format!("{first}-{name}"))
        {
            return self.perform(action, jobs, page_rows);
        }
        match self.keys.action(&name) {
            Some(action) => self.perform(action, jobs, page_rows),
            None if self.keys.starts(&name) => self.pending = Some(name),
            None => {}
        }
    }

    /// With the mouse on: the wheel moves the selection of the pane under
    /// the pointer, a click selects a row, and a click on the selected row
    /// plays or opens it
    fn mouse(&mut self, event: MouseEvent, hits: &view::Hits, jobs: &Sender<Request>) {
        if self.editing || self.saving.is_some() || self.help {
            return;
        }
        match event.kind {
            MouseEventKind::ScrollDown | MouseEventKind::ScrollUp => {
                if let Some(pane) = hits.pane(event.column) {
                    self.pane = pane;
                }
                let by = if event.kind == MouseEventKind::ScrollDown {
                    3
                } else {
                    -3
                };
                self.move_selection(by, jobs);
            }
            MouseEventKind::Down(MouseButton::Left) => {
                let Some((pane, index)) = hits.at(event.column, event.row) else {
                    return;
                };
                let selected = match pane {
                    Pane::Results => self.page().map(|page| page.selected),
                    Pane::Set => Some(self.set_selected),
                    Pane::Lyrics => None,
                };
                if self.pane == pane && selected == Some(index) {
                    return self.enter(jobs);
                }
                self.pane = pane;
                match pane {
                    Pane::Results => {
                        if let Some(page) = self.pages.last_mut() {
                            page.selected = index;
                        }
                    }
                    Pane::Set => self.set_selected = index,
                    Pane::Lyrics => {}
                }
                // Near the end of a search or playlist, the next page loads
                self.move_selection(0, jobs);
            }
            _ => {}
        }
    }

    fn feed(&mut self, event: &Value, jobs: &Sender<Request>) {
        if let Some(volume) = event["volume"].as_u64() {
            let muted = event["muted"].as_bool().unwrap_or(false);
            self.volume = Some((volume, muted));
        }
        match event["type"].as_str() {
            Some("PLAYER_INFO") | Some("VIDEO_CHANGED") => {
                if std::mem::take(&mut self.feed_lost) {
                    self.say("Back in touch with Rien");
                }
                if event["song"].is_object() {
                    self.song = Some(song(&event["song"]));
                }
                self.refresh(jobs);
                self.send(
                    jobs,
                    Job::Cover,
                    Method::Get,
                    "/api/v1/song/cover".into(),
                    None,
                );
                if self.pane == Pane::Lyrics {
                    self.lyrics(jobs);
                }
            }
            Some("EXIT_CHANGED") => self.say(crate::items::exit_change(event)),
            Some("PLAYER_STATE_CHANGED") => {
                if let (Some(song), Some(playing)) =
                    (self.song.as_mut(), event["isPlaying"].as_bool())
                {
                    song.paused = !playing;
                }
            }
            _ => {}
        }
        if let (Some(song), Some(position)) = (self.song.as_mut(), event["position"].as_u64()) {
            song.elapsed = position;
        }
    }

    fn answer(&mut self, job: Job, answer: Result<Option<Value>, String>, jobs: &Sender<Request>) {
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => {
                match job {
                    // The pane says so instead of waiting for an answer
                    Job::Lyrics => self.lyrics = Some(Err(error.clone())),
                    Job::More { page } => {
                        if let Some(page) = self.pages.iter_mut().find(|found| found.id == page) {
                            page.loading = false;
                        }
                    }
                    // The row comes back: the change didn't take it away. A change
                    // that may have gone through leaves it out until the list opens again.
                    Job::Library(_) => {
                        self.changing = false;
                        if error.contains("may have gone through") {
                            self.taken = None;
                        } else if let Some((id, at, row)) = self.taken.take()
                            && let Some(page) = self.pages.iter_mut().find(|found| found.id == id)
                        {
                            page.rows.insert(at.min(page.rows.len()), row);
                        }
                    }
                    _ => {}
                }
                self.say(error);
                return;
            }
        };
        match job {
            Job::Song => self.song = answer.as_ref().map(song),
            Job::Set => {
                let answer = answer.unwrap_or_default();
                self.set = items(&answer["items"]);
                self.encore = items(&answer["encore"]);
                self.current = answer["current"].as_u64().map(|at| at as usize);
                self.set_selected = self
                    .set_selected
                    .min((self.set.len() + self.encore.len()).saturating_sub(1));
            }
            Job::Lyrics => {
                // Synced Lyrics may still be searching: up to five more tries,
                // two seconds apart
                if answer.is_none() && self.lyrics_tries < 5 {
                    self.lyrics_tries += 1;
                    self.lyrics_retry = Some(Instant::now() + Duration::from_secs(2));
                    self.lyrics = Some(Err("Looking for lyrics…".into()));
                    return;
                }
                self.lyrics = Some(match answer {
                    None => Err("No lyrics for this song yet.".into()),
                    Some(lyrics) => Ok(match lyrics["lines"].as_array() {
                        Some(lines) => lines
                            .iter()
                            .map(|line| Lyric {
                                at_ms: line["timeMs"].as_u64().unwrap_or(0),
                                text: text(line, "text"),
                            })
                            .collect(),
                        None => text(&lyrics, "plain")
                            .lines()
                            .map(|line| Lyric {
                                at_ms: u64::MAX,
                                text: line.to_owned(),
                            })
                            .collect(),
                    }),
                });
            }
            Job::Search { title, more } => {
                let answer = answer.unwrap_or_default();
                let rows = items(&answer["items"]).into_iter().map(Row::Item).collect();
                let continuation = answer["continuation"].as_str().map(str::to_owned);
                self.pages = vec![Page::new(title, rows, None).with_more(continuation, more)];
                self.message = None;
            }
            Job::More { page } => {
                let answer = answer.unwrap_or_default();
                // A search's next page has items, a playlist's has tracks
                let list = if answer["items"].is_array() {
                    &answer["items"]
                } else {
                    &answer["tracks"]
                };
                if let Some(page) = self.pages.iter_mut().find(|found| found.id == page) {
                    page.rows.extend(items(list).into_iter().map(Row::Item));
                    page.continuation = answer["continuation"].as_str().map(str::to_owned);
                    page.loading = false;
                }
            }
            Job::Open {
                title,
                kind,
                id,
                from,
            } => {
                if self.page().map_or(0, |page| page.id) != from {
                    return;
                }
                let answer = answer.unwrap_or_default();
                let (rows, list) = match kind.as_str() {
                    "library" => (
                        items(&answer["items"]).into_iter().map(Row::Item).collect(),
                        None,
                    ),
                    "album" => (
                        items(&answer["tracks"])
                            .into_iter()
                            .map(Row::Item)
                            .collect(),
                        answer["album"]["playlistId"].as_str().map(str::to_owned),
                    ),
                    "playlist" => (
                        items(&answer["tracks"])
                            .into_iter()
                            .map(Row::Item)
                            .collect(),
                        Some(id.strip_prefix("VL").unwrap_or(&id).to_owned()),
                    ),
                    _ => (
                        answer["sections"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .flat_map(|section| {
                                // A section's full list, when it is a playlist
                                let all = section["more"]
                                    .as_str()
                                    .filter(|more| more.starts_with("VL"))
                                    .map(|more| {
                                        Row::Item(Item {
                                            kind: "playlist".into(),
                                            id: more.to_owned(),
                                            title: format!("All of {}", text(section, "title")),
                                            subtitle: String::new(),
                                            artists: Vec::new(),
                                            album: None,
                                            duration: None,
                                            slot: None,
                                            available: true,
                                        })
                                    });
                                std::iter::once(Row::Heading(text(section, "title")))
                                    .chain(items(&section["items"]).into_iter().map(Row::Item))
                                    .chain(all)
                            })
                            .collect(),
                        None,
                    ),
                };
                let list = if kind == "library" && id == "likes" {
                    Some("LM".to_owned())
                } else {
                    list
                };
                let mut page = Page::new(title, rows, list);
                let continuation = answer["continuation"].as_str().map(str::to_owned);
                if kind == "playlist" {
                    page = page.with_more(
                        continuation,
                        format!("/api/v1/browse/playlist/{}?", query(&id)),
                    );
                    // Liked songs are unliked, other playlists edited by slot
                    if id == "VLLM" || id == "LM" {
                        page.library = Some("likes".into());
                    } else {
                        page.editable = true;
                    }
                } else if kind == "library" {
                    page = page.with_more(continuation, format!("/api/v1/library/{}?", query(&id)));
                    page.library = Some(id);
                }
                self.pages.push(page);
            }
            Job::Action => self.refresh(jobs),
            Job::Library(edit) => {
                self.taken = None;
                self.changing = false;
                if let Some(Value::String(text)) = answer {
                    let text = if edit == LibraryEdit::Undo {
                        // The open list still lacks what came back
                        format!("{text}; open the list again to see it")
                    } else {
                        match self.keys.first(Action::Undo) {
                            Some(key) => format!("{text}. {key} takes it back"),
                            None => text,
                        }
                    };
                    self.say(text);
                }
            }
            // The worker answers covers with Event::Cover
            Job::Cover | Job::Queue { .. } | Job::Edit { .. } | Job::LoadSaved { .. } => {}
        }
    }
}

fn song(value: &Value) -> Song {
    Song {
        title: text(value, "title"),
        artist: text(value, "artist"),
        album: text(value, "album"),
        elapsed: value["elapsedSeconds"].as_u64().unwrap_or(0),
        duration: value["songDuration"].as_u64().unwrap_or(0),
        paused: value["isPaused"].as_bool().unwrap_or(false),
    }
}

/// How many times the set holds a song
fn copies(rien: &mut Rien, video_id: &str) -> Result<(usize, Value), String> {
    let set = rien
        .request(Method::Get, "/api/v1/queue/items", None)
        .map_err(|error| format!("{error:#}"))?
        .unwrap_or_default();
    let count = set["items"].as_array().map_or(0, |items| {
        items.iter().filter(|item| item["id"] == video_id).count()
    });
    Ok((count, set))
}

/// The row of a song in the set: by its place when it has one, or else the
/// copy of its ID nearest the row it was on
fn place(items: &[Value], index: usize, slot: Option<&str>, video_id: &str) -> Option<usize> {
    match slot {
        Some(slot) => items.iter().position(|item| item["slot"] == slot),
        None => items
            .iter()
            .enumerate()
            .filter(|(_, item)| item["id"] == video_id)
            .min_by_key(|(at, _)| at.abs_diff(index))
            .map(|(at, _)| at),
    }
}

/// Finds a song of the set by its place, or else by its ID nearest the row it
/// was on, then removes it or plays it. Gives the set as it is then.
fn edit(
    rien: &mut Rien,
    remove: bool,
    index: usize,
    slot: Option<&str>,
    video_id: &str,
) -> Result<Option<Value>, String> {
    let set = rien
        .request(Method::Get, "/api/v1/queue/items", None)
        .map_err(|error| format!("{error:#}"))?
        .unwrap_or_default();
    let items = set["items"].as_array().cloned().unwrap_or_default();
    let found = place(&items, index, slot, video_id);
    let Some(at) = found else {
        return Err("That song isn't in the set anymore".into());
    };
    let result = if remove {
        rien.request(Method::Delete, &format!("/api/v1/queue/{at}"), None)
    } else {
        rien.request(
            Method::Patch,
            "/api/v1/queue",
            Some(&json!({ "index": at })),
        )
    };
    result.map_err(|error| format!("{error:#}"))?;
    rien.request(Method::Get, "/api/v1/queue/items", None)
        .map_err(|error| format!("{error:#}"))
}

/// Adds a song to the set and waits up to 3 s for the page to show it, then
/// skips to it if asked. Gives the set as it is then.
fn queue(
    rien: &mut Rien,
    video_id: &str,
    up_next: bool,
    then_next: bool,
) -> Result<Option<Value>, String> {
    let (before, _) = copies(rien, video_id)?;
    let position = if up_next {
        "INSERT_AFTER_CURRENT_VIDEO"
    } else {
        "INSERT_AT_END"
    };
    let body = json!({ "videoId": video_id, "insertPosition": position });
    rien.request(Method::Post, "/api/v1/queue", Some(&body))
        .map_err(|error| format!("{error:#}"))?;
    let started = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(150));
        let (now, set) = copies(rien, video_id)?;
        if now > before {
            if then_next {
                rien.request(Method::Post, "/api/v1/next", None)
                    .map_err(|error| format!("{error:#}"))?;
            }
            return Ok(Some(set));
        }
        if started.elapsed() > Duration::from_secs(3) {
            return Err("Rien took the song but the set doesn't show it yet".into());
        }
    }
}

/// Makes a library change the way `ytmpc … --apply` does, and says how it went
fn library_edit(rien: &mut Rien, edit: &LibraryEdit) -> Result<Option<Value>, String> {
    let done = |change: library::Change, rien: &mut Rien| {
        library::commit(rien, &change)?;
        Ok(format!("Done: {}", change.what))
    };
    let result: Result<String> = match edit {
        LibraryEdit::Remove(id) => (|| {
            let songs = library::all(rien, "/api/v1/library/songs", "items")?;
            let albums = library::all(rien, "/api/v1/library/albums", "items")?;
            done(
                library::remove_from_library(std::slice::from_ref(id), &songs, &albums)?,
                rien,
            )
        })(),
        LibraryEdit::Unlike(id) => (|| {
            let likes = library::all(rien, "/api/v1/library/likes", "items")?;
            done(library::unlike(std::slice::from_ref(id), &likes)?, rien)
        })(),
        LibraryEdit::FromPlaylist { playlist, slot } => (|| {
            let path = format!("/api/v1/browse/playlist/{}", query(playlist));
            let tracks = library::all(rien, &path, "tracks")?;
            done(
                library::remove_from_playlist(playlist, std::slice::from_ref(slot), &tracks)?,
                rien,
            )
        })(),
        LibraryEdit::Undo => library::take_back(rien).map(|what| format!("Took back: {what}")),
    };
    result
        .map(|text| Some(Value::String(text)))
        .map_err(|error| format!("{error:#}"))
}

fn load_saved(rien: &mut Rien, name: &str, append: bool) -> Result<Option<Value>, String> {
    saved::load(name)
        .and_then(|songs| saved::play(rien, &songs, append))
        .map(|()| None)
        .map_err(|error| format!("{error:#}"))
}

fn worker(mut rien: Rien, requests: Receiver<Request>, events: Sender<Event>) {
    for request in requests {
        let event = match request.job {
            // Decoded here, so a big cover doesn't hold up the screen
            Job::Cover => Event::Cover(
                rien.bytes(&request.path)
                    .ok()
                    .flatten()
                    .and_then(|bytes| image::load_from_memory(&bytes).ok()),
            ),
            Job::Queue {
                video_id,
                up_next,
                then_next,
            } => Event::Answer(Job::Set, queue(&mut rien, &video_id, up_next, then_next)),
            Job::LoadSaved { name, append } => {
                Event::Answer(Job::Action, load_saved(&mut rien, &name, append))
            }
            Job::Library(edit) => {
                let answer = library_edit(&mut rien, &edit);
                Event::Answer(Job::Library(edit), answer)
            }
            Job::Edit {
                remove,
                index,
                slot,
                video_id,
            } => Event::Answer(
                Job::Set,
                edit(&mut rien, remove, index, slot.as_deref(), &video_id),
            ),
            job => {
                let answer = rien
                    .request(request.method, &request.path, request.body.as_ref())
                    .map_err(|error| format!("{error:#}"));
                Event::Answer(job, answer)
            }
        };
        if events.send(event).is_err() {
            return;
        }
    }
}

/// Whether the terminal said its background is light (OSC 11)
fn light_background(capabilities: &[Capability]) -> bool {
    capabilities.iter().any(|capability| {
        matches!(capability, Capability::Background(r, g, b)
            if 0.2126 * *r as f32 + 0.7152 * *g as f32 + 0.0722 * *b as f32 > 150.0)
    })
}

/// Rien's address, the settings and where the client keeps its notes
pub struct Options<'a> {
    pub theme: &'a Path,
    pub keys: &'a HashMap<String, String>,
    pub mouse: bool,
    pub state: &'a Path,
}

pub fn run(rien: Rien, feed: Rien, options: Options) -> Result<()> {
    let (theme_path, key_table) = (options.theme, options.keys);
    let theme = Theme::load(theme_path)?;
    let keys = Keys::new(key_table)?;
    let (events_tx, events) = mpsc::channel();
    let (jobs, requests) = mpsc::channel::<Request>();

    let mut terminal = ratatui::init();
    // Asks the terminal how it shows images before anything reads its input.
    // Multiplexers don't answer, which would hold the first frame for 2 s and
    // eat the keys typed meanwhile, so the cover comes as text blocks there.
    let multiplexed = ["TMUX", "ZELLIJ", "STY", "HERDR_ENV"]
        .iter()
        .any(|name| std::env::var_os(name).is_some());
    let picker = if multiplexed {
        Picker::halfblocks()
    } else {
        let asking = QueryStdioOptions {
            terminal_background_color_osc: true,
            ..Default::default()
        };
        Picker::from_query_stdio_with_options(asking).unwrap_or_else(|_| Picker::halfblocks())
    };
    // The bundled colors are made for a dark background; a light one gets a
    // note, once
    let light = light_background(picker.capabilities());
    let noted = options.state.join("light-terminal-noted");
    let note_light = light && theme.background == ratatui::style::Color::Reset && !noted.exists();
    if note_light {
        let _ = std::fs::create_dir_all(options.state).and_then(|()| std::fs::write(&noted, ""));
    }
    if options.mouse
        && let Err(error) = ratatui::crossterm::execute!(
            std::io::stdout(),
            ratatui::crossterm::event::EnableMouseCapture
        )
    {
        ratatui::restore();
        return Err(error.into());
    }
    let mut cover: Option<StatefulProtocol> = None;

    // Two workers, so a slow search or cover can't hold up the player's keys
    let (player_tx, player_requests) = mpsc::channel();
    let (browse_tx, browse_requests) = mpsc::channel();
    let browse_rien = rien.clone();
    let (loads_tx, loads_requests) = mpsc::channel();
    let (load_rien, to_screen) = (rien.clone(), events_tx.clone());
    thread::spawn(move || worker(load_rien, loads_requests, to_screen));
    let to_screen = events_tx.clone();
    thread::spawn(move || worker(rien, player_requests, to_screen));
    let to_screen = events_tx.clone();
    thread::spawn(move || worker(browse_rien, browse_requests, to_screen));
    thread::spawn(move || {
        for request in requests {
            // A saved set can take a while to load: loads have a worker of their
            // own, one after another, so the player keeps its keys and two sets
            // don't mix
            if matches!(request.job, Job::LoadSaved { .. } | Job::Library(_)) {
                if loads_tx.send(request).is_err() {
                    return;
                }
                continue;
            }
            let browsing = matches!(
                request.job,
                Job::Search { .. } | Job::More { .. } | Job::Open { .. } | Job::Cover | Job::Lyrics
            );
            let sent = if browsing {
                browse_tx.send(request)
            } else {
                player_tx.send(request)
            };
            if sent.is_err() {
                return;
            }
        }
    });
    let to_screen = events_tx.clone();
    thread::spawn(move || {
        let mut feed = feed;
        let mut wait = Duration::from_secs(1);
        loop {
            let connected = Instant::now();
            let sender = to_screen.clone();
            let result = feed.watch(|event| {
                sender
                    .send(Event::Feed(event))
                    .map_err(|_| anyhow::anyhow!("closed"))
            });
            let reason = match result {
                Ok(()) => "Rien closed the live feed".to_owned(),
                Err(error) => format!("{error:#}"),
            };
            // The screen has closed
            if to_screen.send(Event::FeedLost(reason)).is_err() {
                return;
            }
            // Tries again, sooner after a feed that ran for a while
            if connected.elapsed() > Duration::from_secs(30) {
                wait = Duration::from_secs(1);
            }
            thread::sleep(wait);
            wait = (wait * 2).min(Duration::from_secs(10));
        }
    });
    let to_screen = events_tx;
    thread::spawn(move || {
        while let Ok(event) = event::read() {
            let event = match event {
                TermEvent::Key(key) => Event::Key(key),
                TermEvent::Mouse(mouse) => Event::Mouse(mouse),
                TermEvent::Resize(..) => Event::Resize,
                _ => continue,
            };
            if to_screen.send(event).is_err() {
                return;
            }
        }
    });

    let mut app = App::new(keys);
    app.refresh(&jobs);
    if note_light {
        app.say("This terminal looks light; ytmpc's colors are made for dark ones. theme.toml can set them all (see ytmpc help).");
    }
    let mut hits = view::Hits::default();
    let mut set_checked = Instant::now();
    let result = (|| -> Result<()> {
        loop {
            let size = terminal.size()?;
            terminal.draw(|frame| {
                hits = view::Hits::default();
                view::draw(frame, &app, &theme, &mut cover, &mut hits);
            })?;
            match events.recv_timeout(Duration::from_millis(500)) {
                Ok(Event::Key(key)) => app.key(key, &jobs, view::list_rows(size.height) as isize),
                Ok(Event::Mouse(mouse)) => app.mouse(mouse, &hits, &jobs),
                Ok(Event::Resize) => {}
                Ok(Event::Feed(event)) => app.feed(&event, &jobs),
                Ok(Event::FeedLost(reason)) => {
                    app.feed_lost = true;
                    app.say(format!("{}; trying again", reason.trim_end_matches('.')));
                }
                Ok(Event::Answer(job, answer)) => app.answer(job, answer, &jobs),
                Ok(Event::Cover(image)) => {
                    cover = image.map(|image| picker.new_resize_protocol(image))
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
            // The live feed has no event for the set, so changes made in Rien
            // or by other clients show within five seconds
            if set_checked.elapsed() > Duration::from_secs(5) {
                set_checked = Instant::now();
                app.send(
                    &jobs,
                    Job::Set,
                    Method::Get,
                    "/api/v1/queue/items".into(),
                    None,
                );
            }
            if app.lyrics_retry.is_some_and(|at| Instant::now() >= at) {
                app.lyrics_retry = None;
                if app.pane == Pane::Lyrics {
                    app.ask_lyrics(&jobs);
                }
            }
            if app
                .message
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(6))
            {
                app.message = None;
            }
            if app.quit {
                return Ok(());
            }
        }
    })();
    if options.mouse {
        let _ = ratatui::crossterm::execute!(
            std::io::stdout(),
            ratatui::crossterm::event::DisableMouseCapture
        );
    }
    ratatui::restore();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: &str, title: &str) -> Item {
        serde_json::from_value(json!({
            "type": kind, "id": title, "title": title, "subtitle": "", "artists": [],
            "album": null, "duration": 60, "thumbnail": null, "playlistId": null, "slot": null, "available": true
        }))
        .unwrap()
    }

    fn app() -> App {
        App::new(Keys::new(&HashMap::new()).unwrap())
    }

    #[test]
    fn pages_ask_for_more_near_the_end_once() {
        let rows = (0..8)
            .map(|at| Row::Item(item("song", &at.to_string())))
            .collect();
        let mut page =
            Page::new("x".into(), rows, None).with_more(Some("tok".into()), "/x?".into());
        assert_eq!(page.next_page(), None);
        page.select(3);
        assert_eq!(page.next_page().as_deref(), Some("/x?continuation=tok"));
        assert_eq!(page.next_page(), None);
    }

    #[test]
    fn missing_lyrics_are_asked_for_again_five_times() {
        let (jobs, _requests) = mpsc::channel();
        let mut app = app();
        app.pane = Pane::Lyrics;
        for _ in 0..5 {
            app.answer(Job::Lyrics, Ok(None), &jobs);
            assert!(app.lyrics_retry.is_some());
            assert!(matches!(&app.lyrics, Some(Err(reason)) if reason.starts_with("Looking")));
        }
        app.answer(Job::Lyrics, Ok(None), &jobs);
        assert!(matches!(&app.lyrics, Some(Err(reason)) if reason.starts_with("No lyrics")));
    }

    #[test]
    fn artist_sections_link_to_their_full_lists() {
        let (jobs, _requests) = mpsc::channel();
        let mut app = app();
        let artist = json!({ "sections": [
            { "title": "Top songs", "items": [], "more": "VLOLAK5uy_x" },
            { "title": "Albums", "items": [], "more": "MPADUCx" },
        ] });
        let job = Job::Open {
            title: "Linkin Park".into(),
            kind: "artist".into(),
            id: "UCx".into(),
            from: 0,
        };
        app.answer(job, Ok(Some(artist)), &jobs);
        let page = app.page().unwrap();
        let titles: Vec<String> = page
            .rows
            .iter()
            .map(|row| match row {
                Row::Heading(title) => format!("# {title}"),
                Row::Item(item) => format!("{} {}", item.kind, item.title),
            })
            .collect();
        assert_eq!(
            titles,
            ["# Top songs", "playlist All of Top songs", "# Albums"]
        );
    }

    #[test]
    fn edits_find_the_song_by_its_place() {
        let items = vec![
            json!({ "id": "a", "slot": "1" }),
            json!({ "id": "b", "slot": "2" }),
            json!({ "id": "b", "slot": "3" }),
        ];
        assert_eq!(place(&items, 0, Some("3"), "b"), Some(2));
        assert_eq!(place(&items, 9, Some("4"), "b"), None);
        assert_eq!(place(&items, 2, None, "b"), Some(2));
        assert_eq!(place(&items, 0, None, "b"), Some(1));
    }

    #[test]
    fn a_removed_song_leaves_the_screen_at_once() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        app.pane = Pane::Set;
        app.set = vec![item("song", "a"), item("song", "b"), item("song", "c")];
        app.current = Some(2);
        app.key(KeyEvent::from(KeyCode::Char('d')), &jobs, 10);
        app.key(KeyEvent::from(KeyCode::Char('d')), &jobs, 10);
        let titles: Vec<&str> = app.set.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(titles, ["c"]);
        assert_eq!(app.current, Some(0));
        let removed: Vec<String> = requests
            .try_iter()
            .filter_map(|request| match request.job {
                Job::Edit {
                    remove: true,
                    video_id,
                    ..
                } => Some(video_id),
                _ => None,
            })
            .collect();
        assert_eq!(removed, ["a", "b"]);
    }

    #[test]
    fn an_answer_for_a_page_left_behind_is_dropped() {
        let (jobs, _requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.pages = vec![Page::new("SEARCH · ALL".into(), Vec::new(), None)];
        let search = app.pages[0].id;
        let album = json!({ "album": { "playlistId": "OLAK" }, "tracks": [] });
        let opened = |from| Job::Open {
            title: "Meteora".into(),
            kind: "album".into(),
            id: "MPRE".into(),
            from,
        };
        app.answer(opened(search + 1000), Ok(Some(album.clone())), &jobs);
        assert_eq!(app.pages.len(), 1);
        app.answer(opened(search), Ok(Some(album)), &jobs);
        assert_eq!(app.pages.len(), 2);
    }

    #[test]
    fn w_asks_for_a_name_and_esc_lets_go() {
        let (jobs, _requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        app.key(KeyEvent::from(KeyCode::Char('w')), &jobs, 10);
        assert_eq!(app.saving.as_deref(), Some(""));
        for c in "Late q".chars() {
            app.key(KeyEvent::from(KeyCode::Char(c)), &jobs, 10);
        }
        assert_eq!(app.saving.as_deref(), Some("Late q"));
        assert!(!app.quit);
        app.key(KeyEvent::from(KeyCode::Esc), &jobs, 10);
        assert_eq!(app.saving, None);
    }

    #[test]
    fn a_click_selects_and_a_second_one_plays() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        app.set = vec![item("song", "a"), item("song", "b")];
        let line = |y| ratatui::layout::Rect {
            x: 50,
            y,
            width: 30,
            height: 1,
        };
        let hits = view::Hits {
            rows: vec![(line(3), Pane::Set, 0), (line(4), Pane::Set, 1)],
        };
        let click = |row| MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 60,
            row,
            modifiers: KeyModifiers::NONE,
        };
        app.mouse(click(4), &hits, &jobs);
        assert_eq!((app.pane, app.set_selected), (Pane::Set, 1));
        assert!(requests.try_recv().is_err());
        app.mouse(click(4), &hits, &jobs);
        assert!(matches!(
            requests.try_recv().unwrap().job,
            Job::Edit {
                remove: false,
                index: 1,
                ..
            }
        ));
        // Outside the rows nothing happens
        app.mouse(click(9), &hits, &jobs);
        assert_eq!(app.set_selected, 1);
    }

    #[test]
    fn b_opens_the_library_and_enter_opens_a_list() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        app.key(KeyEvent::from(KeyCode::Char('b')), &jobs, 10);
        app.key(KeyEvent::from(KeyCode::Char('b')), &jobs, 10);
        assert_eq!(app.pages.len(), 1);
        let page = app.page().unwrap();
        assert_eq!(page.title, "LIBRARY");
        assert_eq!(page.rows.len(), 7);
        app.key(KeyEvent::from(KeyCode::Enter), &jobs, 10);
        let request = requests.try_recv().unwrap();
        assert_eq!(request.path, "/api/v1/library/songs");
        assert!(
            matches!(&request.job, Job::Open { kind, id, .. } if kind == "library" && id == "songs")
        );
    }

    fn song_value() -> Value {
        json!({
            "type": "song", "id": "bbbbbbbbbbb", "title": "Faint", "subtitle": "", "artists": [],
            "album": null, "duration": 162, "available": true
        })
    }

    fn library_page(app: &mut App, jobs: &Sender<Request>, kind: &str, id: &str, answer: Value) {
        let from = app.page().map_or(0, |page| page.id);
        let job = Job::Open {
            title: "x".into(),
            kind: kind.into(),
            id: id.into(),
            from,
        };
        app.answer(job, Ok(Some(answer)), jobs);
    }

    #[test]
    fn d_asks_before_a_library_change_and_only_y_makes_it() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        let song = serde_json::to_value(json!({
            "type": "song", "id": "aaaaaaaaaaa", "title": "Numb", "subtitle": "", "artists": [],
            "album": null, "duration": 185, "available": true
        }))
        .unwrap();
        library_page(
            &mut app,
            &jobs,
            "library",
            "songs",
            json!({ "items": [song], "continuation": "tok" }),
        );
        let page = app.page().unwrap();
        assert_eq!(page.library.as_deref(), Some("songs"));
        assert_eq!(page.continuation.as_deref(), Some("tok"));
        app.key(KeyEvent::from(KeyCode::Char('d')), &jobs, 10);
        assert!(
            matches!(&app.confirm, Some((question, _, _)) if question == "Remove Numb from the library?")
        );
        app.key(KeyEvent::from(KeyCode::Char('n')), &jobs, 10);
        assert!(app.confirm.is_none());
        assert!(requests.try_recv().is_err());
        assert_eq!(app.page().unwrap().rows.len(), 1);
        app.key(KeyEvent::from(KeyCode::Char('d')), &jobs, 10);
        app.key(KeyEvent::from(KeyCode::Char('y')), &jobs, 10);
        assert!(matches!(
            requests.try_recv().unwrap().job,
            Job::Library(LibraryEdit::Remove(id)) if id == "aaaaaaaaaaa"
        ));
        assert!(app.page().unwrap().rows.is_empty());
        // A second change waits for the first
        library_page(
            &mut app,
            &jobs,
            "library",
            "songs",
            json!({ "items": [song_value()] }),
        );
        app.key(KeyEvent::from(KeyCode::Char('d')), &jobs, 10);
        assert!(app.confirm.is_none());
        app.pages.pop();
        // A change that may have gone through keeps the row out
        app.changing = true;
        app.taken = Some((app.page().unwrap().id, 0, Row::Item(item("song", "x"))));
        app.answer(
            Job::Library(LibraryEdit::Remove("x".into())),
            Err("Rien answered 503: The page didn't answer in time; the change may have gone through".into()),
            &jobs,
        );
        assert!(app.taken.is_none() && !app.changing);
        assert!(app.page().unwrap().rows.is_empty());
        // A change that fails puts the row back
        app.taken = Some((
            app.page().unwrap().id,
            0,
            Row::Item(item("song", "aaaaaaaaaaa")),
        ));
        app.answer(
            Job::Library(LibraryEdit::Remove("aaaaaaaaaaa".into())),
            Err("Rien answered 503".into()),
            &jobs,
        );
        assert_eq!(app.page().unwrap().rows.len(), 1);
    }

    #[test]
    fn d_unlikes_liked_songs_and_edits_other_playlists_by_slot() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        let track = json!({
            "type": "song", "id": "aaaaaaaaaaa", "title": "Numb", "subtitle": "", "artists": [],
            "album": null, "duration": 185, "available": true, "slot": "S1"
        });
        library_page(
            &mut app,
            &jobs,
            "playlist",
            "VLLM",
            json!({ "tracks": [track.clone()] }),
        );
        app.key(KeyEvent::from(KeyCode::Char('d')), &jobs, 10);
        app.key(KeyEvent::from(KeyCode::Char('y')), &jobs, 10);
        assert!(matches!(
            requests.try_recv().unwrap().job,
            Job::Library(LibraryEdit::Unlike(_))
        ));
        // The next change waits for this one's answer
        app.answer(
            Job::Library(LibraryEdit::Unlike("aaaaaaaaaaa".into())),
            Ok(Some(Value::String("Done".into()))),
            &jobs,
        );
        library_page(
            &mut app,
            &jobs,
            "playlist",
            "PLx",
            json!({ "tracks": [track] }),
        );
        assert!(app.page().unwrap().editable);
        app.key(KeyEvent::from(KeyCode::Char('d')), &jobs, 10);
        app.key(KeyEvent::from(KeyCode::Char('y')), &jobs, 10);
        assert_eq!(
            requests.try_recv().unwrap().job_edit(),
            Some(LibraryEdit::FromPlaylist {
                playlist: "PLx".into(),
                slot: "S1".into()
            })
        );
    }

    #[test]
    fn u_asks_before_taking_a_change_back() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        app.key(KeyEvent::from(KeyCode::Char('u')), &jobs, 10);
        app.key(KeyEvent::from(KeyCode::Char('y')), &jobs, 10);
        assert_eq!(
            requests.try_recv().unwrap().job_edit(),
            Some(LibraryEdit::Undo)
        );
    }

    impl Request {
        fn job_edit(self) -> Option<LibraryEdit> {
            match self.job {
                Job::Library(edit) => Some(edit),
                _ => None,
            }
        }
    }

    #[test]
    fn light_backgrounds_are_told_from_dark_ones() {
        assert!(light_background(&[Capability::Background(250, 250, 245)]));
        assert!(!light_background(&[Capability::Background(0, 11, 30)]));
        assert!(!light_background(&[]));
    }

    #[test]
    fn the_selection_skips_headings() {
        let rows = vec![
            Row::Heading("Top songs".into()),
            Row::Item(item("song", "a")),
            Row::Heading("Albums".into()),
            Row::Item(item("album", "b")),
        ];
        let mut page = Page::new("x".into(), rows, None);
        assert_eq!(page.selected, 1);
        page.select(1);
        assert_eq!(page.selected, 3);
        page.select(isize::MAX);
        assert_eq!(page.selected, 3);
        page.select(isize::MIN);
        assert_eq!(page.selected, 1);
    }

    #[test]
    fn typing_goes_to_the_search_line_until_enter() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        for c in "numb q".chars() {
            app.key(KeyEvent::from(KeyCode::Char(c)), &jobs, 10);
        }
        assert!(!app.quit);
        assert_eq!(app.query, "numb q");
        app.key(KeyEvent::from(KeyCode::Enter), &jobs, 10);
        assert!(!app.editing);
        let request = requests.try_recv().unwrap();
        assert_eq!(request.path, "/api/v1/browse/search?q=numb%20q&filter=all");
        app.key(KeyEvent::from(KeyCode::Char('q')), &jobs, 10);
        assert!(app.quit);
    }

    #[test]
    fn g_then_g_goes_to_the_top_and_the_set_runs_into_the_encore() {
        let (jobs, requests) = mpsc::channel::<Request>();
        let mut app = app();
        app.editing = false;
        app.pane = Pane::Set;
        app.set = vec![item("song", "a"), item("song", "b")];
        app.encore = vec![item("song", "c")];
        app.key(KeyEvent::from(KeyCode::Char('G')), &jobs, 10);
        assert_eq!(app.set_selected, 2);
        app.key(KeyEvent::from(KeyCode::Char('g')), &jobs, 10);
        app.key(KeyEvent::from(KeyCode::Char('g')), &jobs, 10);
        assert_eq!(app.set_selected, 0);
        // Enter on the encore song puts it next, then skips to it once the set has it
        app.set_selected = 2;
        app.key(KeyEvent::from(KeyCode::Enter), &jobs, 10);
        let sent: Vec<Request> = requests.try_iter().collect();
        assert_eq!(sent.len(), 1);
        assert!(matches!(
            &sent[0].job,
            Job::Queue { video_id, up_next: true, then_next: true } if video_id == "c"
        ));
    }
}
