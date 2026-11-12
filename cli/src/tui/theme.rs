// Colors by role. The bundled theme is cyberlulz on the terminal's own
// background; ~/.config/ytmpc/theme.toml can set any role.
use std::{fs, path::Path};

use anyhow::{Context, Result, bail};
use ratatui::style::Color;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Theme {
    /// Painted behind everything; Reset leaves the terminal's own
    pub background: Color,
    pub text: Color,
    /// Steps of the text toward the background, for less important lines
    pub dim: Color,
    pub faint: Color,
    /// Only what is live: the current song's arrow and NOW
    pub accent: Color,
    /// The strip behind the selected row
    pub selection: Color,
    pub rule: Color,
    /// Songs of the set that have played
    pub played: Color,
    pub warning: Color,
    pub error: Color,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Roles {
    background: Option<String>,
    text: Option<String>,
    text_dim: Option<String>,
    text_faint: Option<String>,
    accent: Option<String>,
    selection: Option<String>,
    rule: Option<String>,
    played: Option<String>,
    warning: Option<String>,
    error: Option<String>,
}

type Rgb = (u8, u8, u8);

fn hex(value: &str) -> Option<Rgb> {
    let digits = value.strip_prefix('#')?;
    if digits.len() != 6 || !digits.is_ascii() {
        return None;
    }
    let part = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some((part(0)?, part(2)?, part(4)?))
}

fn mix((r1, g1, b1): Rgb, (r2, g2, b2): Rgb, share: f32) -> Rgb {
    let blend = |a: u8, b: u8| (a as f32 * share + b as f32 * (1.0 - share)).round() as u8;
    (blend(r1, r2), blend(g1, g2), blend(b1, b2))
}

const fn rgb((r, g, b): Rgb) -> Color {
    Color::Rgb(r, g, b)
}

// cyberlulz, a Telegram theme: cyan text, magenta accent, purple selection,
// deep blue rules on near-black
const BASE: Rgb = (0x00, 0x0b, 0x1e);
const TEXT: Rgb = (0x0a, 0xbd, 0xc6);

impl Default for Theme {
    fn default() -> Self {
        Self {
            background: Color::Reset,
            text: rgb(TEXT),
            dim: rgb(mix(TEXT, BASE, 0.62)),
            faint: rgb(mix(TEXT, BASE, 0.38)),
            accent: rgb((0xea, 0x00, 0xd9)),
            selection: rgb((0x71, 0x1c, 0x91)),
            rule: rgb((0x13, 0x3e, 0x7c)),
            played: rgb((0x13, 0x3e, 0x7c)),
            warning: rgb((0xff, 0x91, 0x00)),
            error: rgb((0xb2, 0x07, 0x5e)),
        }
    }
}

impl Theme {
    /// The bundled theme with the roles a theme file sets. The dim steps
    /// follow the text and background unless the file names them.
    pub fn load(path: &Path) -> Result<Self> {
        let Ok(text) = fs::read_to_string(path) else {
            return Ok(Self::default());
        };
        Self::parse(&text).with_context(|| format!("{} has an error", path.display()))
    }

    pub fn parse(text: &str) -> Result<Self> {
        let roles: Roles = toml::from_str(text)?;
        let color = |name: &str, value: &Option<String>| -> Result<Option<Rgb>> {
            match value.as_deref() {
                None | Some("none") => Ok(None),
                Some(value) => match hex(value) {
                    Some(rgb) => Ok(Some(rgb)),
                    None => bail!("{name} = \"{value}\": use #rrggbb or \"none\""),
                },
            }
        };
        let mut theme = Self::default();
        let background = color("background", &roles.background)?;
        theme.background = background.map(rgb).unwrap_or(Color::Reset);
        let text = color("text", &roles.text)?.unwrap_or(TEXT);
        let base = background.unwrap_or(BASE);
        theme.text = rgb(text);
        theme.dim = rgb(color("text_dim", &roles.text_dim)?.unwrap_or(mix(text, base, 0.62)));
        theme.faint = rgb(color("text_faint", &roles.text_faint)?.unwrap_or(mix(text, base, 0.38)));
        let set = |field: &mut Color, name: &str, value: &Option<String>| -> Result<()> {
            if let Some(found) = color(name, value)? {
                *field = rgb(found);
            }
            Ok(())
        };
        set(&mut theme.accent, "accent", &roles.accent)?;
        set(&mut theme.selection, "selection", &roles.selection)?;
        set(&mut theme.rule, "rule", &roles.rule)?;
        theme.played = theme.rule;
        set(&mut theme.played, "played", &roles.played)?;
        set(&mut theme.warning, "warning", &roles.warning)?;
        set(&mut theme.error, "error", &roles.error)?;
        Ok(theme)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_is_cyberlulz() {
        assert_eq!(Theme::parse("").unwrap(), Theme::default());
        assert_eq!(Theme::default().background, Color::Reset);
    }

    #[test]
    fn roles_override_and_dims_follow_the_text() {
        let theme =
            Theme::parse("text = \"#ffffff\"\nbackground = \"#000000\"\naccent = \"#ff0000\"")
                .unwrap();
        assert_eq!(theme.text, Color::Rgb(255, 255, 255));
        assert_eq!(theme.dim, Color::Rgb(158, 158, 158));
        assert_eq!(theme.accent, Color::Rgb(255, 0, 0));
        assert_eq!(theme.background, Color::Rgb(0, 0, 0));
    }

    #[test]
    fn bad_values_say_what_to_write() {
        let error = Theme::parse("accent = \"red\"").unwrap_err().to_string();
        assert!(error.contains("#rrggbb"), "{error}");
        assert!(Theme::parse("colour = \"#ffffff\"").is_err());
    }
}
