// Keys, named as in mpv's input.conf (j, G, SPACE, Shift+LEFT, Ctrl+d, g-g),
// bound to actions: mpv's keys for playback, vim's for lists. The [keys]
// table of config.toml binds a key to an action, or unbinds it with "".
use std::collections::HashMap;

use anyhow::{Result, bail};
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Action {
    Quit,
    Search,
    Filter,
    NextPane,
    Lyrics,
    Back,
    Down,
    Up,
    HalfDown,
    HalfUp,
    Top,
    Bottom,
    Enter,
    Add,
    AddNext,
    Remove,
    Pause,
    SeekForward,
    SeekBack,
    NudgeForward,
    NudgeBack,
    Next,
    Previous,
    VolumeDown,
    VolumeUp,
    VolumeDownMore,
    VolumeUpMore,
    Mute,
    Repeat,
    Help,
}

/// Each action's name in config.toml and its line in the key list
pub const ACTIONS: [(Action, &str, &str); 30] = [
    (Action::Quit, "quit", "quit"),
    (Action::Search, "search", "search"),
    (Action::Filter, "filter", "search filter"),
    (Action::NextPane, "next-pane", "next pane"),
    (Action::Lyrics, "lyrics", "lyrics"),
    (Action::Back, "back", "back"),
    (Action::Down, "down", "down"),
    (Action::Up, "up", "up"),
    (Action::HalfDown, "half-down", "half a page down"),
    (Action::HalfUp, "half-up", "half a page up"),
    (Action::Top, "top", "top"),
    (Action::Bottom, "bottom", "bottom"),
    (Action::Enter, "enter", "play or open"),
    (Action::Add, "add", "add to the set"),
    (Action::AddNext, "add-next", "play next"),
    (Action::Remove, "remove", "remove from the set"),
    (Action::Pause, "pause", "play or pause"),
    (Action::SeekForward, "seek-forward", "5 s forward"),
    (Action::SeekBack, "seek-back", "5 s back"),
    (Action::NudgeForward, "nudge-forward", "1 s forward"),
    (Action::NudgeBack, "nudge-back", "1 s back"),
    (Action::Next, "next", "next song"),
    (Action::Previous, "previous", "previous song"),
    (Action::VolumeDown, "volume-down", "volume -2"),
    (Action::VolumeUp, "volume-up", "volume +2"),
    (Action::VolumeDownMore, "volume-down-more", "volume -5"),
    (Action::VolumeUpMore, "volume-up-more", "volume +5"),
    (Action::Mute, "mute", "mute"),
    (Action::Repeat, "repeat", "repeat mode"),
    (Action::Help, "help", "this list"),
];

const DEFAULTS: &[(&str, Action)] = &[
    ("q", Action::Quit),
    ("/", Action::Search),
    ("\\", Action::Filter),
    ("TAB", Action::NextPane),
    ("l", Action::Lyrics),
    ("h", Action::Back),
    ("BS", Action::Back),
    ("ESC", Action::Back),
    ("j", Action::Down),
    ("DOWN", Action::Down),
    ("k", Action::Up),
    ("UP", Action::Up),
    ("Ctrl+d", Action::HalfDown),
    ("PGDWN", Action::HalfDown),
    ("Ctrl+u", Action::HalfUp),
    ("PGUP", Action::HalfUp),
    ("g-g", Action::Top),
    ("HOME", Action::Top),
    ("G", Action::Bottom),
    ("END", Action::Bottom),
    ("ENTER", Action::Enter),
    ("a", Action::Add),
    ("A", Action::AddNext),
    ("d", Action::Remove),
    ("SPACE", Action::Pause),
    ("p", Action::Pause),
    ("RIGHT", Action::SeekForward),
    ("LEFT", Action::SeekBack),
    ("Shift+RIGHT", Action::NudgeForward),
    ("Shift+LEFT", Action::NudgeBack),
    (">", Action::Next),
    ("<", Action::Previous),
    ("9", Action::VolumeDown),
    ("0", Action::VolumeUp),
    ("-", Action::VolumeDownMore),
    ("+", Action::VolumeUpMore),
    ("=", Action::VolumeUpMore),
    ("m", Action::Mute),
    ("L", Action::Repeat),
    ("?", Action::Help),
];

/// A key's name the way mpv writes it, or None for keys ytmpc doesn't name
pub fn name(key: &KeyEvent) -> Option<String> {
    let mut prefix = String::new();
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    if ctrl {
        prefix.push_str("Ctrl+");
    }
    if alt {
        prefix.push_str("Alt+");
    }
    let base = match key.code {
        // A shifted character arrives as itself: G, <, ?
        KeyCode::Char(' ') => "SPACE".to_owned(),
        KeyCode::Char(c) if ctrl || alt => c.to_ascii_lowercase().to_string(),
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "ENTER".into(),
        KeyCode::Tab => "TAB".into(),
        KeyCode::BackTab => return Some(format!("{prefix}Shift+TAB")),
        KeyCode::Backspace => "BS".into(),
        KeyCode::Esc => "ESC".into(),
        KeyCode::Delete => "DEL".into(),
        KeyCode::Left => "LEFT".into(),
        KeyCode::Right => "RIGHT".into(),
        KeyCode::Up => "UP".into(),
        KeyCode::Down => "DOWN".into(),
        KeyCode::Home => "HOME".into(),
        KeyCode::End => "END".into(),
        KeyCode::PageUp => "PGUP".into(),
        KeyCode::PageDown => "PGDWN".into(),
        KeyCode::F(n) => format!("F{n}"),
        _ => return None,
    };
    let named = matches!(key.code, KeyCode::Char(_)) && base.len() == 1;
    if shift && !named {
        prefix.push_str("Shift+");
    }
    Some(format!("{prefix}{base}"))
}

pub struct Keys {
    bound: HashMap<String, Action>,
}

impl Keys {
    /// The defaults with the [keys] table of config.toml on top
    pub fn new(table: &HashMap<String, String>) -> Result<Self> {
        let mut bound: HashMap<String, Action> = DEFAULTS
            .iter()
            .map(|&(key, action)| (key.to_owned(), action))
            .collect();
        for (key, action) in table {
            if action.is_empty() {
                bound.remove(key);
                continue;
            }
            let Some(&(found, _, _)) = ACTIONS.iter().find(|(_, name, _)| name == action) else {
                let names: Vec<&str> = ACTIONS.iter().map(|(_, name, _)| *name).collect();
                bail!(
                    "[keys] \"{key}\" = \"{action}\": no such action. Actions: {}",
                    names.join(", ")
                );
            };
            bound.insert(key.clone(), found);
        }
        Ok(Self { bound })
    }

    pub fn action(&self, key: &str) -> Option<Action> {
        self.bound.get(key).copied()
    }

    /// Whether `key` starts a sequence such as g-g
    pub fn starts(&self, key: &str) -> bool {
        let prefix = format!("{key}-");
        self.bound
            .keys()
            .any(|bound| bound.starts_with(&prefix) && bound.len() > prefix.len())
    }

    /// An action's first key in the defaults' order, as the hints show it
    pub fn first(&self, action: Action) -> Option<String> {
        let mut keys: Vec<&String> = self
            .bound
            .iter()
            .filter(|(_, bound)| **bound == action)
            .map(|(key, _)| key)
            .collect();
        keys.sort_by_key(|key| {
            (
                DEFAULTS
                    .iter()
                    .position(|(bound, _)| bound == key)
                    .unwrap_or(usize::MAX),
                key.to_string(),
            )
        });
        keys.first().map(|key| {
            match key.as_str() {
                "ENTER" => "⏎",
                "TAB" => "⇥",
                "SPACE" => "␣",
                "BS" => "⌫",
                "LEFT" => "←",
                "RIGHT" => "→",
                "UP" => "↑",
                "DOWN" => "↓",
                other => other,
            }
            .to_owned()
        })
    }

    /// The key list: each action with its keys, in the order of ACTIONS
    pub fn list(&self) -> Vec<(String, &'static str)> {
        ACTIONS
            .iter()
            .filter_map(|(action, _, text)| {
                let mut keys: Vec<&str> = self
                    .bound
                    .iter()
                    .filter(|(_, bound)| *bound == action)
                    .map(|(key, _)| key.as_str())
                    .collect();
                // The defaults' order first (mpv's or vim's key before the named ones),
                // then keys from config.toml
                keys.sort_by_key(|key| {
                    let default = DEFAULTS.iter().position(|(bound, _)| bound == key);
                    (default.unwrap_or(usize::MAX), key.to_string())
                });
                (!keys.is_empty()).then(|| (keys.join(" "), *text))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn names_follow_mpv() {
        assert_eq!(
            name(&key(KeyCode::Char('j'), KeyModifiers::NONE)).unwrap(),
            "j"
        );
        assert_eq!(
            name(&key(KeyCode::Char('G'), KeyModifiers::SHIFT)).unwrap(),
            "G"
        );
        assert_eq!(
            name(&key(KeyCode::Char('<'), KeyModifiers::SHIFT)).unwrap(),
            "<"
        );
        assert_eq!(
            name(&key(KeyCode::Char(' '), KeyModifiers::NONE)).unwrap(),
            "SPACE"
        );
        assert_eq!(
            name(&key(KeyCode::Char('d'), KeyModifiers::CONTROL)).unwrap(),
            "Ctrl+d"
        );
        assert_eq!(
            name(&key(KeyCode::Right, KeyModifiers::SHIFT)).unwrap(),
            "Shift+RIGHT"
        );
        assert_eq!(
            name(&key(KeyCode::Enter, KeyModifiers::NONE)).unwrap(),
            "ENTER"
        );
    }

    #[test]
    fn the_table_binds_and_unbinds() {
        let table = HashMap::from([
            ("x".to_owned(), "quit".to_owned()),
            ("q".to_owned(), String::new()),
        ]);
        let keys = Keys::new(&table).unwrap();
        assert_eq!(keys.action("x"), Some(Action::Quit));
        assert_eq!(keys.action("q"), None);
        assert_eq!(keys.action("SPACE"), Some(Action::Pause));
        assert!(keys.starts("g"));
        assert!(!keys.starts("j"));
        let error = Keys::new(&HashMap::from([("x".to_owned(), "fly".to_owned())]))
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("no such action"), "{error}");
    }

    #[test]
    fn the_list_gathers_keys_per_action() {
        let keys = Keys::new(&HashMap::new()).unwrap();
        let list = keys.list();
        assert!(
            list.contains(&("SPACE p".to_owned(), "play or pause")),
            "{list:?}"
        );
        assert!(list.contains(&("g-g HOME".to_owned(), "top")), "{list:?}");
    }
}
