//! Where Claudestra lives on this machine, and which PATH to run it with.
//!
//! An app started from Finder gets launchd's bare PATH (/usr/bin:/bin:…), so bun / claude / tmux
//! are invisible to it. We take the PATH the bridge daemon itself runs with (its plist), falling
//! back to the user's login shell — the same view `install-cli` wrote, so what the app sees is
//! what the daemons see.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

pub const BRIDGE_LABEL: &str = "com.claudestra.bridge";
/// install.sh's default clone target; used before anything is installed.
const DEFAULT_REPO: &str = "repos/claudestra";
/// Dev override: point the app at a checkout other than the one launchd runs (e.g. a worktree).
const REPO_ENV: &str = "CLAUDESTRA_DESKTOP_REPO";
const EXTRA_PATH: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

#[derive(Clone, Debug, serde::Serialize)]
pub struct Install {
    pub repo: PathBuf,
    pub bun: String,
    pub path: String,
    pub path_source: PathSource,
    /// launchd plist for the bridge exists (install-cli has run at least once)
    pub daemons_installed: bool,
    /// a Claudestra checkout exists at `repo` (setup can run; otherwise the wizard runs install.sh)
    pub has_checkout: bool,
    /// the checkout has the desktop entry point, so status/doctor/restart can run
    pub cli_available: bool,
}

/// Where `Install.path` came from. `Default` is a stand-in while the login shell is still being
/// read (or keeps failing), so AppState must not cache an Install that carries it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathSource {
    Plist,
    LoginShell,
    Default,
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn bridge_plist() -> PathBuf {
    home().join("Library/LaunchAgents").join(format!("{BRIDGE_LABEL}.plist"))
}

/// `plutil -extract <key> raw` — None when the key or the file is missing.
fn plist_value(plist: &Path, key: &str) -> Option<String> {
    let out = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !v.is_empty()).then_some(v)
}

/// Read a pipe to EOF on its own thread and send `(slot, text)`; the caller decides how long to
/// wait. A send after the caller gave up fails, which is fine: nobody wants that text any more.
fn drain<R: Read + Send + 'static>(r: Option<R>, slot: usize, tx: mpsc::Sender<(usize, String)>) {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            // a read error just truncates the captured text; the exit status still tells success
            let _ = r.read_to_end(&mut buf);
        }
        let _ = tx.send((slot, String::from_utf8_lossy(&buf).to_string()));
    });
}

/// SIGKILL the child's whole session/group. Only called while the leader is still unreaped: its
/// pid (= the group id) can't be reused until we wait() on it, so the signal can't hit a stranger.
fn kill_group(pgid: u32) {
    #[cfg(test)]
    tests::KILLPG_CALLS.with(|c| c.set(c.get() + 1));
    // SAFETY: plain syscall with a pid we spawned and have not reaped; no memory is touched.
    unsafe { libc::killpg(pgid as libc::pid_t, libc::SIGKILL) };
}

/// Why a run produced no exit status. The split matters to restart: a child that never started
/// kicked nothing, while one that timed out may have done part of its work.
#[derive(Debug)]
pub enum RunError {
    NotStarted(String),
    Started(String),
}

impl From<RunError> for String {
    fn from(e: RunError) -> String {
        match e {
            RunError::NotStarted(m) | RunError::Started(m) => m,
        }
    }
}

/// Run a command with a deadline; returns (exit ok, stdout, stderr). The deadline covers both
/// the child's exit and draining its pipes: a descendant it left behind (an rc file's background
/// job) keeps the pipes open after the child exits, and waiting on that would hang the caller
/// while it holds a lock or the restart gate. Still running at the deadline → kill its group.
/// Already reaped → never signal (its group id may belong to someone else by now): abandon the
/// pipes, whose reader threads end whenever the stray descendant closes them. tests: env::tests.
pub fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<(bool, String, String), RunError> {
    // Own session = own process group (so kill_group reaches its descendants) and no controlling
    // terminal, which is also what a Finder-launched app gives the login shell.
    // SAFETY: setsid is async-signal-safe and touches no memory of the parent.
    unsafe { cmd.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }) };
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunError::NotStarted(e.to_string()))?;
    let pgid = child.id();
    let deadline = Instant::now() + timeout;
    let timed_out = || RunError::Started(format!("timed out after {:.1}s", timeout.as_secs_f32()));
    let (tx, rx) = mpsc::channel();
    drain(child.stdout.take(), 0, tx.clone());
    drain(child.stderr.take(), 1, tx);
    let status = loop {
        match child.try_wait().map_err(|e| RunError::Started(e.to_string()))? {
            Some(s) => break s,
            None if Instant::now() >= deadline => {
                kill_group(pgid); // try_wait just said it is running, so not reaped yet
                // reaps the killed child; fails only if it is already reaped
                let _ = child.wait();
                return Err(timed_out());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let mut text = [String::new(), String::new()];
    for _ in 0..2 {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok((slot, t)) => text[slot] = t,
            // leader already reaped above: no signal, just stop listening
            Err(_) => return Err(timed_out()),
        }
    }
    let [out, err] = text;
    Ok((status.success(), out, err))
}

/// After a failed read, wait this long before starting another login shell.
const LOGIN_PATH_RETRY: Duration = Duration::from_secs(60);

/// Only a successful read is kept. Reads run on a background thread; callers never wait for one.
pub(crate) struct LoginPathCache {
    value: Option<String>,
    failed_at: Option<Instant>,
    reading: bool,
}

impl LoginPathCache {
    /// The PATH if known, and whether the caller should start a read now: none in flight, and not
    /// within LOGIN_PATH_RETRY of a failure (before setup this runs on every 8 s poll, and an
    /// interactive shell each time would re-run the user's whole rc stack).
    pub(crate) fn poll(&mut self, now: Instant) -> (Option<String>, bool) {
        let start = self.value.is_none()
            && !self.reading
            && self.failed_at.map_or(true, |t| now.duration_since(t) >= LOGIN_PATH_RETRY);
        self.reading |= start;
        (self.value.clone(), start)
    }

    pub(crate) fn finish(&mut self, now: Instant, got: Option<String>) {
        self.reading = false;
        self.failed_at = got.is_none().then_some(now);
        if got.is_some() {
            self.value = got;
        }
    }

    pub(crate) const fn new() -> Self {
        LoginPathCache { value: None, failed_at: None, reading: false }
    }
}

static LOGIN_PATH: Mutex<LoginPathCache> = Mutex::new(LoginPathCache::new());

/// PATH from an interactive login shell (bun's installer writes to .zshrc, not .zprofile), or None
/// while it isn't known yet: the caller goes on with the default dirs and a later poll picks the
/// value up (AppState keeps re-locating while the PATH is `Default`). The read itself is bounded
/// by run_with_timeout's 5 s.
fn login_shell_path() -> Option<String> {
    // the cache's fields are updated together, so a poisoned lock still holds a usable value
    let lock = || LOGIN_PATH.lock().unwrap_or_else(|e| e.into_inner());
    let (value, start) = lock().poll(Instant::now());
    if start {
        std::thread::spawn(move || {
            // a panic must still clear `reading`, or no read would ever start again
            let got = std::panic::catch_unwind(read_login_shell_path).ok().flatten();
            lock().finish(Instant::now(), got);
        });
    }
    value
}

fn read_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", "printf '\\n__CSPATH__%s__CSPATH__\\n' \"$PATH\""]);
    login_path_from(run_with_timeout(&mut cmd, Duration::from_secs(5)))
}

/// A non-zero exit is a failure even when the markers were printed: an rc error or exit trap can
/// fire after the printf, and the PATH it saw may be half-built. Caching that would stick for good.
fn login_path_from(run: Result<(bool, String, String), RunError>) -> Option<String> {
    let (ok, out, _) = run.ok()?;
    if !ok {
        return None;
    }
    let start = out.find("__CSPATH__")? + "__CSPATH__".len();
    let len = out[start..].find("__CSPATH__")?;
    Some(out[start..start + len].to_string())
}

fn with_extra_dirs(path: &str) -> String {
    let mut parts: Vec<String> = path.split(':').filter(|p| !p.is_empty()).map(String::from).collect();
    for extra in [home().join(".bun/bin").to_string_lossy().to_string()]
        .into_iter()
        .chain(EXTRA_PATH.iter().map(|s| s.to_string()))
    {
        if !parts.contains(&extra) {
            parts.push(extra);
        }
    }
    parts.join(":")
}

pub fn locate() -> Install {
    locate_with(&bridge_plist(), login_shell_path)
}

/// `locate` with the plist and the login-shell lookup passed in, so tests need neither a real
/// LaunchAgent nor the process-wide LOGIN_PATH cache.
pub(crate) fn locate_with(plist: &Path, login_path: impl FnOnce() -> Option<String>) -> Install {
    let daemons_installed = plist.exists();
    let repo = std::env::var(REPO_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| plist_value(plist, "WorkingDirectory").map(PathBuf::from))
        .unwrap_or_else(|| home().join(DEFAULT_REPO));
    let (path, path_source) = match plist_value(plist, "EnvironmentVariables.PATH") {
        Some(p) => (p, PathSource::Plist),
        None => login_path().map_or((String::new(), PathSource::Default), |p| (p, PathSource::LoginShell)),
    };
    let bun = plist_value(plist, "ProgramArguments.0").unwrap_or_else(|| "bun".into());
    let has_checkout = repo.join("src/setup.ts").exists();
    let cli_available = repo.join("src/desktop-cli.ts").exists();
    Install { repo, bun, path: with_extra_dirs(&path), path_source, daemons_installed, has_checkout, cli_available }
}

/// POSIX single-quote a value for the generated .command script.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
#[path = "env_tests.rs"]
mod tests;
