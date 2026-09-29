//! Where Claudestra lives on this machine, and which PATH to run it with.
//!
//! An app started from Finder gets launchd's bare PATH (/usr/bin:/bin:…), so bun / claude / tmux
//! are invisible to it. We take the PATH the bridge daemon itself runs with (its plist), falling
//! back to the user's login shell — the same view `install-cli` wrote, so what the app sees is
//! what the daemons see.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
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
    /// launchd plist for the bridge exists (install-cli has run at least once)
    pub daemons_installed: bool,
    /// a Claudestra checkout exists at `repo` (setup can run; otherwise the wizard runs install.sh)
    pub has_checkout: bool,
    /// the checkout has the desktop entry point, so status/doctor/restart can run
    pub cli_available: bool,
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

fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            // a read error just truncates the captured text; the exit status still tells success
            let _ = r.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).to_string()
    })
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

/// Run a command with a deadline; returns (exit ok, stdout, stderr). A hung child is killed.
/// Output is drained on threads so a child writing more than the pipe buffer can't stall.
pub fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<(bool, String, String), RunError> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunError::NotStarted(e.to_string()))?;
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| RunError::Started(e.to_string()))? {
            Some(s) => break s,
            None if started.elapsed() > timeout => {
                // kill() only fails when the child already exited, which is the outcome we want anyway
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Started(format!("timed out after {}s", timeout.as_secs())));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    Ok((status.success(), out, err))
}

/// After a failed read, wait this long before starting another login shell.
const LOGIN_PATH_RETRY: Duration = Duration::from_secs(60);

/// Keeps a successful read for good; a failure (rc error, 5 s timeout) is retried, but not on
/// every call: before setup `locate()` runs on each 8 s poll, and an interactive shell each time
/// would re-run the user's whole rc stack.
struct LoginPathCache {
    value: Option<String>,
    failed_at: Option<Instant>,
}

impl LoginPathCache {
    fn get(&mut self, now: Instant, read: impl FnOnce() -> Option<String>) -> Option<String> {
        if self.value.is_none() && self.failed_at.map_or(true, |t| now.duration_since(t) >= LOGIN_PATH_RETRY) {
            self.value = read();
            self.failed_at = self.value.is_none().then_some(now);
        }
        self.value.clone()
    }
}

/// PATH from an interactive login shell (bun's installer writes to .zshrc, not .zprofile).
/// Markers keep rc-file chatter out of the value. Held under the lock so two polls never start
/// two shells at once.
fn login_shell_path() -> Option<String> {
    static CACHE: Mutex<LoginPathCache> = Mutex::new(LoginPathCache { value: None, failed_at: None });
    // a panic inside read() leaves the cache itself consistent (at worst still empty)
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.get(Instant::now(), read_login_shell_path)
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
    let plist = bridge_plist();
    let daemons_installed = plist.exists();
    let repo = std::env::var(REPO_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| plist_value(&plist, "WorkingDirectory").map(PathBuf::from))
        .unwrap_or_else(|| home().join(DEFAULT_REPO));
    let path = plist_value(&plist, "EnvironmentVariables.PATH")
        .or_else(login_shell_path)
        .unwrap_or_default();
    let bun = plist_value(&plist, "ProgramArguments.0").unwrap_or_else(|| "bun".into());
    let has_checkout = repo.join("src/setup.ts").exists();
    let cli_available = repo.join("src/desktop-cli.ts").exists();
    Install { repo, bun, path: with_extra_dirs(&path), daemons_installed, has_checkout, cli_available }
}

/// POSIX single-quote a value for the generated .command script.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(sh_quote("/a b/it's"), "'/a b/it'\\''s'");
    }

    #[test]
    fn login_path_failure_is_retried_later_success_is_kept() {
        let t0 = Instant::now();
        let mut c = LoginPathCache { value: None, failed_at: None };
        assert_eq!(c.get(t0, || None), None);
        assert_eq!(c.get(t0 + Duration::from_secs(10), || panic!("retried too soon")), None);
        assert_eq!(c.get(t0 + LOGIN_PATH_RETRY, || Some("/a:/b".into())).as_deref(), Some("/a:/b"));
        assert_eq!(c.get(t0 + LOGIN_PATH_RETRY * 5, || panic!("success is cached")).as_deref(), Some("/a:/b"));
    }

    #[test]
    fn login_path_needs_a_clean_exit_and_both_markers() {
        let out = "motd\n__CSPATH__/bad/path__CSPATH__\n".to_string();
        assert_eq!(login_path_from(Ok((true, out.clone(), String::new()))).as_deref(), Some("/bad/path"));
        assert_eq!(login_path_from(Ok((false, out, "rc error".into()))), None, "markers printed, then exit 7");
        assert_eq!(login_path_from(Ok((true, "__CSPATH__/cut".into(), String::new()))), None);
        assert_eq!(login_path_from(Err(RunError::Started("timed out after 5s".into()))), None);
    }

    #[test]
    fn failed_login_shell_exit_is_not_cached() {
        let t0 = Instant::now();
        let mut c = LoginPathCache { value: None, failed_at: None };
        let marked = || "__CSPATH__/half:/built__CSPATH__".to_string();
        assert_eq!(c.get(t0, || login_path_from(Ok((false, marked(), String::new())))), None);
        let good = c.get(t0 + LOGIN_PATH_RETRY, || login_path_from(Ok((true, marked(), String::new()))));
        assert_eq!(good.as_deref(), Some("/half:/built"), "retried after the back-off");
    }

    /// Through a real child process: a throwaway script stands in for the login shell (setting
    /// SHELL would race other tests), so the exit status really comes from run_with_timeout.
    #[test]
    fn real_shell_printing_markers_then_failing_is_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cs-t18b-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sh = dir.join("fake-shell");
        std::fs::write(&sh, "#!/bin/sh\nprintf '\\n__CSPATH__/bad/path__CSPATH__\\n'\nexit 7\n").unwrap();
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o700)).unwrap();
        let r = run_with_timeout(&mut Command::new(&sh), Duration::from_secs(5));
        // best-effort: a leftover dir in the per-user temp folder is harmless
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(&r, Ok((false, out, _)) if out.contains("__CSPATH__/bad/path")), "{r:?}");
        assert_eq!(login_path_from(r), None);
    }

    #[test]
    fn extra_dirs_are_appended_once() {
        let p = with_extra_dirs("/opt/homebrew/bin:/x");
        assert_eq!(p.matches("/opt/homebrew/bin").count(), 1);
        assert!(p.starts_with("/opt/homebrew/bin:/x:"));
    }
}
