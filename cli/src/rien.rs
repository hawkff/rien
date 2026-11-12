// Rien's API server: requests with the saved token, pairing, and the live feed.
use std::{
    fs,
    io::{ErrorKind, Write},
    path::PathBuf,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use tungstenite::{Message, protocol::frame::coding::CloseCode};
use ureq::{Agent, Body, http::Response};

const CLIENT_ID: &str = "ytmpc";

pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

#[derive(Clone)]
pub struct Rien {
    address: String,
    agent: Agent,
    token: Option<String>,
    token_path: PathBuf,
    /// No notes on stderr, which would cut into a full-screen client
    quiet: bool,
}

fn agent(timeout: Duration) -> Agent {
    Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

impl Rien {
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The same client without notes on stderr
    pub fn quiet(mut self) -> Self {
        self.quiet = true;
        self
    }

    pub fn new(address: String, dir: PathBuf) -> Self {
        let token_path = dir.join("token");
        let token = fs::read_to_string(&token_path)
            .ok()
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty());
        Self {
            address,
            agent: agent(Duration::from_secs(30)),
            token,
            token_path,
            quiet: false,
        }
    }

    fn unreachable(&self, error: ureq::Error) -> anyhow::Error {
        let refused = matches!(&error, ureq::Error::Io(io) if io.kind() == ErrorKind::ConnectionRefused)
            || matches!(&error, ureq::Error::ConnectionFailed);
        if refused {
            anyhow!(
                "Can't reach Rien at {}. Start Rien and turn on Plugins > Other apps and services > API Server.",
                self.address
            )
        } else {
            anyhow!(error).context(format!("Rien at {} didn't answer", self.address))
        }
    }

    fn send(&self, method: &Method, path: &str, body: Option<&Value>) -> Result<Response<Body>> {
        let url = format!("http://{}{path}", self.address);
        let auth = format!("Bearer {}", self.token.as_deref().unwrap_or_default());
        let empty = Value::Object(Default::default());
        let result = match method {
            Method::Get => self
                .agent
                .get(url.as_str())
                .header("Authorization", &auth)
                .call(),
            Method::Delete => self
                .agent
                .delete(url.as_str())
                .header("Authorization", &auth)
                .call(),
            Method::Post => self
                .agent
                .post(url.as_str())
                .header("Authorization", &auth)
                .send_json(body.unwrap_or(&empty)),
            Method::Patch => self
                .agent
                .patch(url.as_str())
                .header("Authorization", &auth)
                .send_json(body.unwrap_or(&empty)),
        };
        result.map_err(|error| self.unreachable(error))
    }

    /// Sends a request and gives the answer of a successful one. Without a
    /// token, or with one Rien no longer accepts, it pairs first.
    fn answered(
        &mut self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Response<Body>> {
        if self.token.is_none() {
            self.pair()?;
        }
        let mut response = self.send(&method, path, body)?;
        if response.status() == 401 {
            self.pair()?;
            response = self.send(&method, path, body)?;
        }
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(response);
        }
        let text = response.body_mut().read_to_string().unwrap_or_default();
        // The API's own errors carry a message; validation errors carry Zod's
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json["error"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| json["error"]["message"].as_str().map(str::to_owned))
            })
            .unwrap_or(text);
        bail!("Rien answered {status}: {message}")
    }

    /// Sends a request and gives its JSON answer, or None for an empty one.
    pub fn request(
        &mut self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Option<Value>> {
        let mut response = self.answered(method, path, body)?;
        let text = response
            .body_mut()
            .read_to_string()
            .context("Couldn't read Rien's answer")?;
        if text.trim().is_empty() {
            Ok(None)
        } else {
            Ok(Some(
                serde_json::from_str(&text).context("Rien's answer isn't JSON")?,
            ))
        }
    }

    /// Gets a binary answer, such as a cover, or None for an empty one.
    pub fn bytes(&mut self, path: &str) -> Result<Option<Vec<u8>>> {
        let mut response = self.answered(Method::Get, path, None)?;
        let bytes = response
            .body_mut()
            .with_config()
            .limit(32 * 1024 * 1024)
            .read_to_vec()
            .context("Couldn't read Rien's answer")?;
        Ok(if bytes.is_empty() { None } else { Some(bytes) })
    }

    /// Whether anything answers HTTP at the address, token or not
    pub fn reachable(&self) -> bool {
        agent(Duration::from_secs(3))
            .get(format!("http://{}/api/v1/song", self.address).as_str())
            .call()
            .is_ok()
    }

    /// Asks Rien for a token; Rien asks its user to allow ytmpc.
    pub fn pair(&mut self) -> Result<()> {
        if !self.quiet {
            eprintln!("Asking Rien for access. Allow ytmpc in the dialog Rien shows.");
        }
        let mut response = agent(Duration::from_secs(300))
            .post(format!("http://{}/auth/{CLIENT_ID}", self.address).as_str())
            .send_empty()
            .map_err(|error| self.unreachable(error))?;
        match response.status().as_u16() {
            200 => {}
            403 => bail!("Rien didn't allow ytmpc."),
            status => bail!("Rien answered {status} when asked for access."),
        }
        let answer: Value = response.body_mut().read_json()?;
        let token = answer["accessToken"]
            .as_str()
            .context("Rien's answer has no token")?
            .to_owned();
        self.save_token(&token)?;
        self.token = Some(token);
        Ok(())
    }

    fn save_token(&self, token: &str) -> Result<()> {
        if let Some(dir) = self.token_path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        // Only this user can read it: it gives control of the player
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options
            .open(&self.token_path)
            .with_context(|| format!("Can't save the token to {}", self.token_path.display()))?;
        // A file that was there before keeps its mode otherwise
        #[cfg(unix)]
        file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        file.write_all(token.as_bytes())?;
        Ok(())
    }

    /// Calls `on_event` with each event of Rien's live feed until it closes.
    pub fn watch(&mut self, mut on_event: impl FnMut(Value) -> Result<()>) -> Result<()> {
        if self.token.is_none() {
            self.pair()?;
        }
        let mut paired_again = false;
        loop {
            let url = format!(
                "ws://{}/api/v1/ws?token={}",
                self.address,
                self.token.as_deref().unwrap_or_default()
            );
            let (mut socket, _) =
                tungstenite::connect(url.as_str()).map_err(|error| match error {
                    // The URL carries the token, so the error is told without it
                    tungstenite::Error::Url(_) | tungstenite::Error::Io(_) => anyhow!(
                        "Can't reach Rien at {}. Start Rien and turn on Plugins > Other apps and services > API Server.",
                        self.address
                    ),
                    tungstenite::Error::Http(response) => {
                        anyhow!("Rien's live feed didn't open: {}", response.status())
                    }
                    _ => anyhow!("Rien's live feed didn't open"),
                })?;
            loop {
                match socket.read() {
                    Ok(Message::Text(text)) => on_event(serde_json::from_str(&text)?)?,
                    Ok(Message::Close(frame)) => {
                        // Rien closes the feed at once for a token it no longer accepts
                        if frame.is_some_and(|frame| frame.code == CloseCode::Policy)
                            && !paired_again
                        {
                            paired_again = true;
                            self.pair()?;
                            break;
                        }
                        return Ok(());
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::ConnectionClosed) => return Ok(()),
                    Err(error) => return Err(anyhow!(error).context("Rien's live feed broke off")),
                }
            }
        }
    }
}
