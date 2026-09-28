//! Everything the app runs. Decisions (what counts as healthy, which daemons, which port) live in
//! the repo's `src/desktop-cli.ts`; this file only spawns it and hands back its JSON.

use crate::env::{home, run_with_timeout, sh_quote, Install};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::Duration;

const INSTALL_SH: &str = "https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh";
/// Shown in the wizard before bun exists; the full check (claude login, versions) is desktop-cli's.
const TOOLS: &[&str] = &["git", "tmux", "node", "bun", "claude"];
const FALLBACK_WEB: &str = "http://127.0.0.1:3847";

fn timeout_for(sub: &str) -> Duration {
    match sub {
        "status" => Duration::from_secs(10),
        _ => Duration::from_secs(90),
    }
}

/// `bun src/desktop-cli.ts <sub>` in the checkout; the last stdout line is the JSON result.
pub fn desktop_cli(inst: &Install, sub: &str) -> Result<Value, String> {
    if !inst.cli_available {
        return Err(format!("{} has no src/desktop-cli.ts (not installed, or older than this app)", inst.repo.display()));
    }
    let mut cmd = Command::new(&inst.bun);
    cmd.arg("src/desktop-cli.ts")
        .arg(sub)
        .current_dir(&inst.repo)
        .env("PATH", &inst.path)
        // an app launched from an agent's shell would otherwise hand its channel id to anything doctor spawns
        .env_remove("DISCORD_CHANNEL_ID");
    let (_, out, err) = run_with_timeout(&mut cmd, timeout_for(sub))?;
    let line = out.lines().rev().find(|l| l.trim_start().starts_with('{'));
    match line {
        Some(l) => serde_json::from_str(l).map_err(|e| format!("bad JSON from desktop-cli: {e}")),
        None => Err(format!("desktop-cli printed nothing: {}", err.trim())),
    }
}

/// `<tool> --version` for the wizard's dependency list; works before bun or the repo exist.
pub fn probe_tools(inst: &Install) -> Value {
    let rows: Vec<Value> = TOOLS
        .iter()
        .map(|tool| {
            let mut cmd = Command::new(tool);
            cmd.arg("--version").env("PATH", &inst.path);
            match run_with_timeout(&mut cmd, Duration::from_secs(10)) {
                Ok((true, out, _)) => json!({ "name": tool, "found": true, "version": out.lines().next().unwrap_or("").trim() }),
                Ok((false, _, err)) => json!({ "name": tool, "found": false, "error": err.lines().next().unwrap_or("").trim() }),
                Err(e) => json!({ "name": tool, "found": false, "error": e }),
            }
        })
        .collect();
    json!({ "tools": rows })
}

fn open(target: &str) -> Result<(), String> {
    let status = Command::new("/usr/bin/open").arg(target).status().map_err(|e| e.to_string())?;
    status.success().then_some(()).ok_or_else(|| format!("open {target} failed"))
}

/// `http://127.0.0.1:<digits>` and nothing else — a bare prefix check would let `…:1@host` through.
fn is_loopback_url(u: &str) -> bool {
    u.strip_prefix("http://127.0.0.1:")
        .is_some_and(|port| !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()))
}

/// Only ever a loopback bridge URL: the value comes from desktop-cli, but the app never opens anything else.
pub fn open_web(url: Option<&str>) -> Result<(), String> {
    let url = url.filter(|u| is_loopback_url(u)).unwrap_or(FALLBACK_WEB);
    open(url)
}

pub fn open_logs(dir: Option<&str>) -> Result<(), String> {
    let fallback = home().join(".claude-orchestrator/logs");
    let dir = dir.map(std::path::PathBuf::from).filter(|d| d.is_dir()).unwrap_or(fallback);
    if !dir.is_dir() {
        return Err(format!("{} does not exist yet (nothing installed?)", dir.display()));
    }
    open(&dir.to_string_lossy())
}

/// The setup wizard is interactive and needs a real terminal (it reads /dev/tty), so we hand it
/// to Terminal.app via a generated `.command` file — that needs no Automation permission, unlike
/// AppleScript. No checkout yet → run install.sh, which clones and then offers setup itself.
pub fn launch_setup(inst: &Install) -> Result<String, String> {
    let repo = sh_quote(&inst.repo.to_string_lossy());
    let body = if inst.has_checkout {
        format!("cd {repo} || exit 1\nexec {} run setup\n", sh_quote(&inst.bun))
    } else {
        format!("export CLAUDESTRA_DIR={repo}\ncurl -fsSL {INSTALL_SH} | bash\n")
    };
    let script = format!("#!/bin/zsh -l\nclear\n{body}");
    let file = std::env::temp_dir().join("claudestra-setup.command");
    std::fs::write(&file, script).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let status = Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(&file)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("could not open Terminal".into());
    }
    Ok(if inst.has_checkout { "setup".into() } else { "install".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_url_must_be_plain_loopback_port() {
        assert!(is_loopback_url("http://127.0.0.1:3847"));
        assert!(!is_loopback_url("http://127.0.0.1:3847@evil.example"));
        assert!(!is_loopback_url("http://127.0.0.1:/x"));
        assert!(!is_loopback_url("https://127.0.0.1:3847"));
        assert!(!is_loopback_url("file:///etc/passwd"));
    }

    /// Live check of the spawn path, not run by default: it kickstarts whatever labels
    /// CLAUDESTRA_DESKTOP_LABELS names, so it refuses to run without that override.
    #[test]
    #[ignore]
    fn restart_via_desktop_cli() {
        assert!(std::env::var("CLAUDESTRA_DESKTOP_LABELS").is_ok_and(|v| !v.is_empty()), "set a throwaway label");
        let inst = crate::env::locate();
        let before = desktop_cli(&inst, "status").expect("status");
        let r = desktop_cli(&inst, "restart").expect("restart");
        assert_eq!(r["ok"], true, "{r}");
        std::thread::sleep(std::time::Duration::from_millis(500));
        let after = desktop_cli(&inst, "status").expect("status");
        assert_ne!(before["daemons"][0]["pid"], after["daemons"][0]["pid"]);
    }
}
