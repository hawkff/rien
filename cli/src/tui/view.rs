// The setlist look: numbered rows, played songs struck through, the live song
// marked → in the accent, the selection as a strip, times right-aligned, and
// hierarchy by brightness steps of one hue.
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};
use ratatui_image::{Resize, StatefulImage, protocol::StatefulProtocol};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::{Action, App, Pane, Row, Theme};
use crate::items::{Item, clean, time};

/// Where the rows of the lists were drawn, for the mouse: the row's line,
/// its pane and its index there
#[derive(Default)]
pub struct Hits {
    pub rows: Vec<(Rect, Pane, usize)>,
}

impl Hits {
    pub fn at(&self, column: u16, row: u16) -> Option<(Pane, usize)> {
        self.rows
            .iter()
            .find(|(area, _, _)| area.y == row && column >= area.x && column < area.x + area.width)
            .map(|&(_, pane, index)| (pane, index))
    }

    /// The pane whose rows span this column
    pub fn pane(&self, column: u16) -> Option<Pane> {
        self.rows
            .iter()
            .find(|(area, _, _)| column >= area.x && column < area.x + area.width)
            .map(|&(_, pane, _)| pane)
    }
}

/// The layout switches to three panes from this width
pub const WIDE: u16 = 120;

/// Rows a list gets: all but the search line, the rules, the pane heading and
/// the three lines at the bottom
pub fn list_rows(height: u16) -> u16 {
    height.saturating_sub(7)
}

/// Cuts text to a width in cells, ending with … when it had to cut
fn fit(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = c.width().unwrap_or(0);
        if used + w + 1 > width {
            break;
        }
        out.push(c);
        used += w;
    }
    if width > 0 {
        out.push('…');
    }
    out
}

/// A line with `left` spans and `right` text at the right edge, the left cut
/// to leave room
fn spread(left: Vec<Span<'static>>, right: Span<'static>, width: u16) -> Line<'static> {
    let width = width as usize;
    let room = width.saturating_sub(right.width() + if right.width() > 0 { 2 } else { 0 });
    let mut used = 0;
    let mut spans = Vec::new();
    for span in left {
        let w = span.width();
        if used + w <= room {
            used += w;
            spans.push(span);
        } else {
            let cut = fit(&span.content, room - used);
            used += cut.width();
            spans.push(Span::styled(cut, span.style));
            break;
        }
    }
    spans.push(Span::raw(
        " ".repeat(width.saturating_sub(used + right.width())),
    ));
    spans.push(right);
    Line::from(spans)
}

fn rule(theme: &Theme, width: u16) -> Line<'static> {
    Line::styled("─".repeat(width as usize), Style::new().fg(theme.rule))
}

fn names(item: &Item) -> String {
    let mut parts: Vec<String> = Vec::new();
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
    }
    if let Some(album) = &item.album {
        parts.push(album.name.clone());
    }
    clean(&parts.join(" · "))
}

enum Mark {
    Plain,
    Played,
    Live,
    /// The site's autoplay songs after the set
    Encore,
}

/// One numbered row: number, title, artists and album, then the length or the
/// kind at the right edge
fn item_row(
    number: usize,
    item: &Item,
    mark: Mark,
    selected: bool,
    theme: &Theme,
    width: u16,
) -> Line<'static> {
    let (text, dim) = match mark {
        Mark::Played => (theme.played, theme.played),
        Mark::Encore => (theme.dim, theme.faint),
        _ if !item.available => (theme.faint, theme.faint),
        _ => (theme.text, theme.dim),
    };
    let struck = if matches!(mark, Mark::Played) {
        Modifier::CROSSED_OUT
    } else {
        Modifier::empty()
    };
    let arrow = match mark {
        Mark::Live => Span::styled(
            "→",
            Style::new().fg(theme.accent).add_modifier(Modifier::BOLD),
        ),
        _ => Span::raw(" "),
    };
    let names = names(item);
    let mut left = vec![
        arrow,
        Span::styled(
            format!("{number:>3}  "),
            Style::new().fg(dim).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            clean(&item.title),
            Style::new().fg(text).add_modifier(struck),
        ),
    ];
    if !names.is_empty() {
        left.push(Span::styled(
            format!(" · {names}"),
            Style::new().fg(dim).add_modifier(struck),
        ));
    }
    let right = match (item.kind.as_str(), item.duration) {
        ("song" | "video" | "episode" | "saved", Some(seconds)) => time(seconds),
        ("song" | "video" | "episode" | "saved", None) => String::new(),
        // The LIBRARY page's lists need no label
        ("library", _) => String::new(),
        (kind, _) => kind.to_owned(),
    };
    let mut line = spread(left, Span::styled(right, Style::new().fg(dim)), width);
    if selected {
        line = line.style(Style::new().bg(theme.selection));
    }
    line
}

/// The rows that fit, from the first one shown before, moved only as far as
/// it takes to keep `selected` in view: rows stay put under the pointer
fn stable(
    count: usize,
    selected: usize,
    height: usize,
    offset: &std::cell::Cell<usize>,
) -> std::ops::Range<usize> {
    if count <= height {
        offset.set(0);
        return 0..count;
    }
    let mut top = offset.get().min(count - height);
    if selected < top {
        top = selected;
    } else if selected >= top + height {
        top = selected + 1 - height;
    }
    offset.set(top);
    top..top + height
}

/// The rows that fit, scrolled so `focus` stays near the middle
fn window(count: usize, focus: usize, height: usize) -> std::ops::Range<usize> {
    if count <= height {
        return 0..count;
    }
    let start = focus.saturating_sub(height / 2).min(count - height);
    start..start + height
}

fn heading(label: &str, info: &str, focused: bool, theme: &Theme, width: u16) -> Line<'static> {
    let label = if focused {
        format!("[{label}]")
    } else {
        format!(" {label} ")
    };
    let style = Style::new()
        .fg(if focused { theme.text } else { theme.dim })
        .add_modifier(Modifier::BOLD);
    spread(
        vec![Span::styled(label, style)],
        Span::styled(info.to_owned(), Style::new().fg(theme.dim)),
        width,
    )
}

fn results(frame: &mut Frame, area: Rect, app: &App, theme: &Theme, hits: &mut Hits) {
    let focused = app.pane == Pane::Results && !app.editing;
    let mut lines = Vec::new();
    match app.page() {
        None => {
            lines.push(heading(
                "SEARCH",
                app.filter.name(),
                focused,
                theme,
                area.width,
            ));
            lines.push(Line::styled(
                "  Type to search; Enter looks it up.",
                Style::new().fg(theme.faint),
            ));
        }
        Some(page) => {
            let count = page
                .rows
                .iter()
                .filter(|row| matches!(row, Row::Item(_)))
                .count();
            lines.push(heading(
                &clean(&page.title),
                // + when more rows load at the end
                &format!(
                    "{count}{}",
                    if page.continuation.is_some() { "+" } else { "" }
                ),
                focused,
                theme,
                area.width,
            ));
            let height = area.height.saturating_sub(1) as usize;
            let mut number = 0;
            let numbers: Vec<usize> = page
                .rows
                .iter()
                .map(|row| {
                    if matches!(row, Row::Item(_)) {
                        number += 1;
                    }
                    number
                })
                .collect();
            for at in stable(page.rows.len(), page.selected, height, &page.offset) {
                if matches!(page.rows[at], Row::Item(_)) {
                    let line = Rect {
                        y: area.y + lines.len() as u16,
                        height: 1,
                        ..area
                    };
                    hits.rows.push((line, Pane::Results, at));
                }
                lines.push(match &page.rows[at] {
                    Row::Heading(title) => Line::styled(
                        format!("  {}", clean(title)),
                        Style::new().fg(theme.dim).add_modifier(Modifier::BOLD),
                    ),
                    Row::Item(item) => item_row(
                        numbers[at],
                        item,
                        Mark::Plain,
                        focused && at == page.selected,
                        theme,
                        area.width,
                    ),
                });
            }
        }
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// A line of the set pane: a song of the set, the ENCORE rule, or one of the
/// site's autoplay songs after it
enum SetLine {
    Set(usize),
    Encore(usize),
    Rule,
}

fn set(frame: &mut Frame, area: Rect, app: &App, theme: &Theme, hits: &mut Hits) {
    let focused = app.pane == Pane::Set && !app.editing;
    let total: u64 = app.set.iter().filter_map(|item| item.duration).sum();
    let info = format!("{} · {}", app.set.len(), time(total));
    let mut lines = vec![heading("SET", &info, focused, theme, area.width)];
    let mut rows: Vec<SetLine> = (0..app.set.len()).map(SetLine::Set).collect();
    if !app.encore.is_empty() {
        rows.push(SetLine::Rule);
        rows.extend((0..app.encore.len()).map(SetLine::Encore));
    }
    // The rule sits between the set and the encore
    let selected_row = if app.set_selected < app.set.len() {
        app.set_selected
    } else {
        app.set_selected + 1
    };
    let focus = if focused {
        selected_row
    } else {
        app.current.unwrap_or(0)
    };
    let height = area.height.saturating_sub(1) as usize;
    // The focused set stays put under the pointer; otherwise it follows the
    // playing song
    let shown = if focused {
        stable(rows.len(), focus, height, &app.set_offset)
    } else {
        let shown = window(rows.len(), focus, height);
        app.set_offset.set(shown.start);
        shown
    };
    for at in shown {
        let line = Rect {
            y: area.y + lines.len() as u16,
            height: 1,
            ..area
        };
        match rows[at] {
            SetLine::Set(index) => hits.rows.push((line, Pane::Set, index)),
            SetLine::Encore(index) => hits.rows.push((line, Pane::Set, app.set.len() + index)),
            SetLine::Rule => {}
        }
        lines.push(match rows[at] {
            SetLine::Set(index) => {
                let mark = match app.current {
                    Some(current) if index < current => Mark::Played,
                    Some(current) if index == current => Mark::Live,
                    _ => Mark::Plain,
                };
                item_row(
                    index + 1,
                    &app.set[index],
                    mark,
                    focused && index == app.set_selected,
                    theme,
                    area.width,
                )
            }
            SetLine::Rule => {
                let label = " ENCORE ";
                let rest = (area.width as usize).saturating_sub(label.width() + 3);
                Line::from(vec![
                    Span::styled("───", Style::new().fg(theme.rule)),
                    Span::styled(
                        label,
                        Style::new().fg(theme.dim).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled("─".repeat(rest), Style::new().fg(theme.rule)),
                ])
            }
            SetLine::Encore(index) => {
                let row = app.set.len() + index;
                item_row(
                    row + 1,
                    &app.encore[index],
                    Mark::Encore,
                    focused && row == app.set_selected,
                    theme,
                    area.width,
                )
            }
        });
    }
    if app.set.is_empty() {
        lines.push(Line::styled(
            "  Nothing in the set yet.",
            Style::new().fg(theme.faint),
        ));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// The key list, over the middle of the screen, in two columns when one is
/// taller than the screen
fn help(frame: &mut Frame, app: &App, theme: &Theme) {
    let area = frame.area();
    let list = app.keys.list();
    let keys_width = list.iter().map(|(keys, _)| keys.width()).max().unwrap_or(0);
    let text_width = list.iter().map(|(_, text)| text.width()).max().unwrap_or(0);
    let entry_width = keys_width + 3 + text_width;
    let columns = if list.len() + 2 <= area.height.saturating_sub(2) as usize {
        1
    } else {
        2
    };
    let rows = list.len().div_ceil(columns);
    let entry = |(keys, text): &(String, &'static str)| {
        vec![
            Span::styled(
                format!(" {keys:>keys_width$}  "),
                Style::new().fg(theme.dim).add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("{text:<text_width$}"), Style::new().fg(theme.text)),
        ]
    };
    let lines: Vec<Line> = (0..rows)
        .map(|row| {
            let mut spans = entry(&list[row]);
            if let Some(second) = list.get(row + rows).filter(|_| columns == 2) {
                spans.push(Span::raw("  "));
                spans.extend(entry(second));
            }
            Line::from(spans)
        })
        .collect();
    let width = ((entry_width + 2) * columns + 2).min(area.width as usize) as u16;
    let height = (rows as u16 + 2).min(area.height);
    let rect = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    };
    let block = Block::bordered()
        .border_style(Style::new().fg(theme.rule))
        .title(Span::styled(
            " KEYS ",
            Style::new().fg(theme.text).add_modifier(Modifier::BOLD),
        ));
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .style(Style::new().bg(theme.background)),
        rect,
    );
}

fn lyrics(frame: &mut Frame, area: Rect, app: &App, theme: &Theme) {
    let focused = app.pane == Pane::Lyrics && !app.editing;
    let title = app
        .song
        .as_ref()
        .map(|song| clean(&song.title))
        .unwrap_or_default();
    let mut lines = vec![heading("LYRICS", &title, focused, theme, area.width)];
    match &app.lyrics {
        None => lines.push(Line::styled("  Asking Rien…", Style::new().fg(theme.faint))),
        Some(Err(reason)) => lines.push(Line::styled(
            format!("  {reason}"),
            Style::new().fg(theme.faint),
        )),
        Some(Ok(rows)) => {
            let elapsed_ms = app
                .song
                .as_ref()
                .map(|song| song.elapsed * 1000)
                .unwrap_or(0);
            let current = rows
                .iter()
                .rposition(|row| row.at_ms != u64::MAX && row.at_ms <= elapsed_ms);
            let height = area.height.saturating_sub(1) as usize;
            // Synced lyrics follow the song; plain ones scroll with the keys
            let shown = match current {
                Some(now) => window(rows.len(), now, height),
                None => {
                    let start = app.lyrics_offset.min(rows.len().saturating_sub(height));
                    start..rows.len().min(start + height)
                }
            };
            for at in shown {
                let (marker, style) = match current {
                    Some(now) if at == now => (
                        Span::styled(
                            "→ ",
                            Style::new().fg(theme.accent).add_modifier(Modifier::BOLD),
                        ),
                        Style::new().fg(theme.text).add_modifier(Modifier::BOLD),
                    ),
                    Some(now) if at < now => (Span::raw("  "), Style::new().fg(theme.faint)),
                    _ => (Span::raw("  "), Style::new().fg(theme.dim)),
                };
                let text = fit(
                    &clean(&rows[at].text),
                    area.width.saturating_sub(2) as usize,
                );
                lines.push(Line::from(vec![marker, Span::styled(text, style)]));
            }
        }
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// The views on the left of the wide layout: the search and what was opened
/// from it, and the lyrics
fn sections(frame: &mut Frame, area: Rect, app: &App, theme: &Theme) {
    let mut lines = vec![Line::raw("")];
    let on = |active: bool| {
        Style::new()
            .fg(if active { theme.text } else { theme.dim })
            .add_modifier(if active {
                Modifier::BOLD
            } else {
                Modifier::empty()
            })
    };
    let results = app.pane != Pane::Lyrics;
    let last = app.pages.len().saturating_sub(1);
    // The first page is a search, or a page opened before any (LIBRARY, SAVED SETS)
    let first = app
        .pages
        .first()
        .map(|page| page.title.as_str())
        .filter(|title| !title.starts_with("SEARCH"))
        .map_or_else(
            || " SEARCH".to_owned(),
            |title| format!(" {}", clean(title)),
        );
    lines.push(Line::styled(first, on(results && app.pages.len() <= 1)));
    for (at, page) in app.pages.iter().enumerate().skip(1) {
        let name = fit(&clean(&page.title), area.width.saturating_sub(3) as usize);
        lines.push(Line::styled(
            format!(" › {name}"),
            on(results && at == last),
        ));
    }
    lines.push(Line::styled(" LYRICS", on(!results)));
    frame.render_widget(Paragraph::new(lines), area);
}

fn search_line(app: &App, theme: &Theme, width: u16) -> Line<'static> {
    if let Some(name) = &app.saving {
        let left = vec![
            Span::styled("save the set as: ", Style::new().fg(theme.dim)),
            Span::styled(clean(name), Style::new().fg(theme.text)),
            Span::styled("▏", Style::new().fg(theme.text)),
        ];
        let label = Span::styled(
            "SAVE",
            Style::new().fg(theme.dim).add_modifier(Modifier::BOLD),
        );
        return spread(left, label, width);
    }
    let mut left = vec![Span::styled("/ ", Style::new().fg(theme.dim))];
    if app.query.is_empty() && !app.editing {
        left.push(Span::styled("search", Style::new().fg(theme.faint)));
    } else {
        left.push(Span::styled(clean(&app.query), Style::new().fg(theme.text)));
    }
    if app.editing {
        left.push(Span::styled("▏", Style::new().fg(theme.text)));
    }
    // The filter the next search uses, with its key
    let key = app.keys.first(Action::Filter).unwrap_or_default();
    let label = format!("{key} {}", app.filter.name().to_uppercase())
        .trim_start()
        .to_owned();
    spread(
        left,
        Span::styled(
            label,
            Style::new().fg(theme.dim).add_modifier(Modifier::BOLD),
        ),
        width,
    )
}

fn now_playing(app: &App, theme: &Theme, width: u16) -> Line<'static> {
    let Some(song) = &app.song else {
        return Line::styled("NOW  nothing plays", Style::new().fg(theme.faint));
    };
    let number = match app.current {
        Some(at) => format!("{:>3}  ", at + 1),
        None => "  ".to_owned(),
    };
    let mut left = vec![
        Span::styled(
            "NOW",
            Style::new().fg(theme.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            number,
            Style::new().fg(theme.dim).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            clean(&song.title),
            Style::new().fg(theme.text).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" · {}", clean(&song.artist)),
            Style::new().fg(theme.dim),
        ),
    ];
    if !song.album.is_empty() {
        left.push(Span::styled(
            format!(" · {}", clean(&song.album)),
            Style::new().fg(theme.faint),
        ));
    }
    // The names come first; the progress rule takes what they leave, 8 to 40 cells
    let times = format!(
        " {} / {}{}",
        time(song.elapsed),
        time(song.duration),
        if song.paused { "  ⏸" } else { "" }
    );
    let names: usize = left.iter().map(Span::width).sum();
    let room = (width as usize).saturating_sub(names + times.width() + 2);
    let bar_width = room.clamp(8, 40);
    let filled = (song.elapsed.min(song.duration) * bar_width as u64)
        .checked_div(song.duration)
        .unwrap_or(0) as usize;
    let right = vec![
        Span::styled("━".repeat(filled), Style::new().fg(theme.text)),
        Span::styled("─".repeat(bar_width - filled), Style::new().fg(theme.rule)),
        Span::styled(times, Style::new().fg(theme.dim)),
    ];
    let right_width: usize = right.iter().map(Span::width).sum();
    let mut line = spread(left, Span::raw(" ".repeat(right_width)), width);
    // The placeholder made room; the coloured parts take its place
    line.spans.pop();
    line.spans.extend(right);
    line
}

fn next_line(app: &App, theme: &Theme, width: u16) -> Line<'static> {
    // After the set's last song comes the encore's first
    let next = app.current.and_then(|at| match app.set.get(at + 1) {
        Some(item) => Some((at + 2, item)),
        None => app.encore.first().map(|item| (app.set.len() + 1, item)),
    });
    match next {
        None => Line::styled("NEXT", Style::new().fg(theme.faint)),
        Some((number, item)) => {
            // NEXT (4 cells) takes the arrow's cell and three more
            let mut line = item_row(
                number,
                item,
                Mark::Plain,
                false,
                theme,
                width.saturating_sub(3),
            );
            line.spans.insert(
                0,
                Span::styled(
                    "NEXT",
                    Style::new().fg(theme.dim).add_modifier(Modifier::BOLD),
                ),
            );
            line.spans.remove(1);
            line
        }
    }
}

fn hints(app: &App, theme: &Theme, width: u16) -> Line<'static> {
    if let Some((question, _, _)) = &app.confirm {
        return Line::styled(
            fit(
                &format!("y yes   any other key no   {}", clean(question)),
                width as usize,
            ),
            Style::new().fg(theme.warning),
        );
    }
    if let Some((message, _)) = &app.message {
        let error = message.starts_with("Rien answered")
            || message.starts_with("Can't reach")
            || message.contains("didn't");
        let color = if error { theme.error } else { theme.dim };
        return Line::styled(fit(&clean(message), width as usize), Style::new().fg(color));
    }
    if app.saving.is_some() {
        return Line::styled(
            fit("⏎ save   esc cancel", width as usize),
            Style::new().fg(theme.faint),
        );
    }
    if app.editing {
        return Line::styled(
            fit("⏎ search   esc done   ^u clear", width as usize),
            Style::new().fg(theme.faint),
        );
    }
    // The keys as bound now, so a changed key shows here too
    let removes = app.page().is_some_and(|page| {
        page.editable
            || page
                .library
                .as_deref()
                .is_some_and(|list| matches!(list, "songs" | "albums" | "likes"))
    });
    let pairs: &[(&[Action], &str)] = match app.pane {
        Pane::Results if removes => &[
            (&[Action::Enter], "play/open"),
            (&[Action::Add], "add"),
            (&[Action::Remove], "remove"),
            (&[Action::Undo], "undo"),
            (&[Action::NextPane], "set"),
            (&[Action::Back], "back"),
            (&[Action::Pause], "pause"),
            (&[Action::Help], "keys"),
            (&[Action::Quit], "quit"),
        ],
        Pane::Results => &[
            (&[Action::Enter], "play/open"),
            (&[Action::Add], "add"),
            (&[Action::AddNext], "next"),
            (&[Action::NextPane], "set"),
            (&[Action::Library], "library"),
            (&[Action::Search], "search"),
            (&[Action::Filter], "filter"),
            (&[Action::Back], "back"),
            (&[Action::Pause], "pause"),
            (&[Action::Previous, Action::Next], "skip"),
            (&[Action::Help], "keys"),
            (&[Action::Quit], "quit"),
        ],
        Pane::Set => &[
            (&[Action::Enter], "play"),
            (&[Action::Remove], "remove"),
            (&[Action::NextPane], "lyrics"),
            (&[Action::Pause], "pause"),
            (&[Action::SeekBack, Action::SeekForward], "seek"),
            (&[Action::Previous, Action::Next], "skip"),
            (&[Action::VolumeDown, Action::VolumeUp], "volume"),
            (&[Action::Help], "keys"),
            (&[Action::Quit], "quit"),
        ],
        Pane::Lyrics => &[
            (&[Action::NextPane], "search"),
            (&[Action::Back], "back"),
            (&[Action::Pause], "pause"),
            (&[Action::SeekBack, Action::SeekForward], "seek"),
            (&[Action::Previous, Action::Next], "skip"),
            (&[Action::Help], "keys"),
            (&[Action::Quit], "quit"),
        ],
    };
    let keys: Vec<String> = pairs
        .iter()
        .filter_map(|(actions, label)| {
            let bound: Vec<String> = actions
                .iter()
                .filter_map(|action| app.keys.first(*action))
                .collect();
            (!bound.is_empty()).then(|| format!("{} {label}", bound.join(" ")))
        })
        .collect();
    Line::styled(
        fit(&keys.join("   "), width as usize),
        Style::new().fg(theme.faint),
    )
}

pub fn draw(
    frame: &mut Frame,
    app: &App,
    theme: &Theme,
    cover: &mut Option<StatefulProtocol>,
    hits: &mut Hits,
) {
    let area = frame.area();
    frame.render_widget(Block::new().style(Style::new().bg(theme.background)), area);
    let [top, top_rule, middle, bottom_rule, now, next, keys] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(area);
    frame.render_widget(Paragraph::new(search_line(app, theme, area.width)), top);
    frame.render_widget(Paragraph::new(rule(theme, area.width)), top_rule);
    frame.render_widget(Paragraph::new(rule(theme, area.width)), bottom_rule);
    frame.render_widget(Paragraph::new(now_playing(app, theme, area.width)), now);
    frame.render_widget(Paragraph::new(next_line(app, theme, area.width)), next);
    frame.render_widget(Paragraph::new(hints(app, theme, area.width)), keys);

    if area.width >= WIDE {
        let [left, gap_one, center, gap_two, right] = Layout::horizontal([
            Constraint::Length(18),
            Constraint::Length(1),
            Constraint::Fill(3),
            Constraint::Length(2),
            Constraint::Fill(2),
        ])
        .areas(middle);
        sections(frame, left, app, theme);
        let divider = |frame: &mut Frame, area: Rect| {
            let lines: Vec<Line> = (0..area.height)
                .map(|_| Line::styled("│", Style::new().fg(theme.rule)))
                .collect();
            frame.render_widget(Paragraph::new(lines), area);
        };
        divider(frame, gap_one);
        divider(
            frame,
            Rect {
                x: gap_two.x,
                width: 1,
                ..gap_two
            },
        );
        if app.pane == Pane::Lyrics {
            lyrics(frame, center, app, theme);
        } else {
            results(frame, center, app, theme, hits);
        }
        // The cover sits above the set, sized for a square; a wide one fits in
        // at its own height
        match cover {
            Some(cover) => {
                let height = (right.width / 2 + 1).min(middle.height * 2 / 5);
                let [art, _, rest] = Layout::vertical([
                    Constraint::Length(height),
                    Constraint::Length(1),
                    Constraint::Fill(1),
                ])
                .areas(right);
                let art = Rect {
                    x: art.x + 1,
                    width: art.width.saturating_sub(1),
                    ..art
                };
                frame.render_stateful_widget(
                    StatefulImage::new().resize(Resize::Fit(None)),
                    art,
                    cover,
                );
                set(frame, rest, app, theme, hits);
            }
            None => set(frame, right, app, theme, hits),
        }
    } else {
        match app.pane {
            Pane::Results => results(frame, middle, app, theme, hits),
            Pane::Set => set(frame, middle, app, theme, hits),
            Pane::Lyrics => lyrics(frame, middle, app, theme),
        }
    }
    if app.help {
        help(frame, app, theme);
    }
}

#[cfg(test)]
mod tests {
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    use super::*;
    use crate::tui::{Page, Song};

    fn item(kind: &str, title: &str, seconds: u64) -> Item {
        serde_json::from_value(json!({
            "type": kind, "id": "x", "title": title, "subtitle": "", "artists": [{ "id": null, "name": "Linkin Park" }],
            "album": null, "duration": seconds, "thumbnail": null, "playlistId": null, "slot": null, "available": true
        }))
        .unwrap()
    }

    fn screen(app: &App, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    app,
                    &Theme::default(),
                    &mut None,
                    &mut Hits::default(),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_owned())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    fn app() -> App {
        let mut app = App::new(crate::tui::Keys::new(&Default::default()).unwrap());
        app.editing = false;
        app.set = vec![
            item("song", "Foreword", 14),
            item("song", "Don't Stay", 188),
            item("song", "Somewhere I Belong", 214),
        ];
        app.current = Some(1);
        app.song = Some(Song {
            title: "Don't Stay".into(),
            artist: "Linkin Park".into(),
            album: "Meteora".into(),
            elapsed: 94,
            duration: 188,
            paused: false,
        });
        app.pages = vec![Page::new(
            "SEARCH · ALL".into(),
            vec![Row::Item(item("album", "Meteora", 0))],
            None,
        )];
        app
    }

    #[test]
    fn the_hints_show_the_keys_as_bound() {
        let mut app = app();
        app.keys = crate::tui::Keys::new(&std::collections::HashMap::from([
            ("x".to_owned(), "quit".to_owned()),
            ("q".to_owned(), String::new()),
        ]))
        .unwrap();
        let lines = screen(&app, 200, 12);
        assert!(
            lines[11].contains("x quit") && !lines[11].contains("q quit"),
            "{}",
            lines[11]
        );
        assert!(
            lines[11].contains("⏎ play/open") && lines[11].contains("< > skip"),
            "{}",
            lines[11]
        );
    }

    #[test]
    fn next_runs_into_the_encore_after_the_last_song() {
        let mut app = app();
        app.current = Some(2);
        app.encore = vec![item("song", "In the End", 216)];
        let lines = screen(&app, 70, 12);
        assert!(
            lines[10].starts_with("NEXT  4  In the End"),
            "{}",
            lines[10]
        );
    }

    #[test]
    fn scrolling_moves_only_as_far_as_needed() {
        let offset = std::cell::Cell::new(0);
        assert_eq!(stable(30, 0, 10, &offset), 0..10);
        // A selection inside the shown rows doesn't move them
        assert_eq!(stable(30, 8, 10, &offset), 0..10);
        assert_eq!(stable(30, 12, 10, &offset), 3..13);
        assert_eq!(stable(30, 5, 10, &offset), 3..13);
        assert_eq!(stable(30, 1, 10, &offset), 1..11);
        assert_eq!(stable(5, 4, 10, &offset), 0..5);
    }

    #[test]
    fn fit_cuts_with_an_ellipsis() {
        assert_eq!(fit("Somewhere I Belong", 10), "Somewhere…");
        assert_eq!(fit("short", 10), "short");
    }

    #[test]
    fn the_narrow_set_marks_played_live_and_next() {
        let mut app = app();
        app.pane = Pane::Set;
        let lines = screen(&app, 70, 12);
        assert!(
            lines[2].starts_with("[SET]") && lines[2].ends_with("3 · 6:56"),
            "{}",
            lines[2]
        );
        assert!(
            lines[3].contains("1  Foreword · Linkin Park") && lines[3].ends_with("0:14"),
            "{}",
            lines[3]
        );
        assert!(lines[4].starts_with("→  2  Don't Stay"), "{}", lines[4]);
        assert!(
            lines[9].starts_with("NOW  2  Don't Stay · Linkin Park"),
            "{}",
            lines[9]
        );
        assert!(lines[9].ends_with("1:34 / 3:08"), "{}", lines[9]);
        assert!(
            lines[10].starts_with("NEXT  3  Somewhere I Belong"),
            "{}",
            lines[10]
        );
    }

    #[test]
    fn the_wide_layout_shows_search_and_set_side_by_side() {
        let lines = screen(&app(), 140, 12);
        assert!(
            lines[3].contains("SEARCH")
                && lines[3].contains("Meteora")
                && lines[3].contains("album"),
            "{}",
            lines[3]
        );
        assert!(lines[2].contains(" SET "), "{}", lines[2]);
    }
}
