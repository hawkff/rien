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
use ratatui_image::{picker::Picker, protocol::StatefulProtocol};
use serde_json::{Value, json};

pub use self::{
    keys::{Action, Keys},
    theme::Theme,
};
use crate::{
    items::Item,
    query,
    rien::{Method, Rien},
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
    pub title: String,
    pub rows: Vec<Row>,
    pub selected: usize,
    pub playlist_id: Option<String>,
    /// The token for the next page of a search or playlist, and the path it
    /// goes with
    pub continuation: Option<String>,
    more: Option<String>,
    loading: bool,
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
            title,
            rows,
            selected,
            playlist_id,
            continuation: None,
            more: None,
            loading: false,
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
    pub filter: Filter,
    pub pages: Vec<Page>,
    pub set: Vec<Item>,
    /// The songs the site plays after the set while autoplay is on
    pub encore: Vec<Item>,
    pub current: Option<usize>,
    /// Over the set, then the encore
    pub set_selected: usize,
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
    /// Puts a song into the set, waits until it is there, then skips to it
    /// if asked: Rien answers before the page has added the song
    Queue {
        video_id: String,
        up_next: bool,
        then_next: bool,
    },
}

pub enum Event {
    Key(KeyEvent),
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
            filter: Filter::All,
            pages: Vec::new(),
            set: Vec::new(),
            encore: Vec::new(),
            current: None,
            set_selected: 0,
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
                    "album" | "artist" | "playlist" => {
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
                let mut page = Page::new(title, rows, list);
                if kind == "playlist" {
                    let continuation = answer["continuation"].as_str().map(str::to_owned);
                    page = page.with_more(
                        continuation,
                        format!("/api/v1/browse/playlist/{}?", query(&id)),
                    );
                }
                self.pages.push(page);
            }
            Job::Action => self.refresh(jobs),
            // The worker answers covers with Event::Cover
            Job::Cover | Job::Queue { .. } | Job::Edit { .. } => {}
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

pub fn run(
    rien: Rien,
    feed: Rien,
    theme_path: &Path,
    key_table: &HashMap<String, String>,
) -> Result<()> {
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
        Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks())
    };
    let mut cover: Option<StatefulProtocol> = None;

    // Two workers, so a slow search or cover can't hold up the player's keys
    let (player_tx, player_requests) = mpsc::channel();
    let (browse_tx, browse_requests) = mpsc::channel();
    let browse_rien = rien.clone();
    let to_screen = events_tx.clone();
    thread::spawn(move || worker(rien, player_requests, to_screen));
    let to_screen = events_tx.clone();
    thread::spawn(move || worker(browse_rien, browse_requests, to_screen));
    thread::spawn(move || {
        for request in requests {
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
    let mut set_checked = Instant::now();
    let result = (|| -> Result<()> {
        loop {
            let size = terminal.size()?;
            terminal.draw(|frame| view::draw(frame, &app, &theme, &mut cover))?;
            match events.recv_timeout(Duration::from_millis(500)) {
                Ok(Event::Key(key)) => app.key(key, &jobs, view::list_rows(size.height) as isize),
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
