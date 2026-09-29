//! The fixed set of calls the bundled window may make. Each one runs off the main thread
//! (desktop-cli / doctor can take seconds) and returns JSON or an error string.

use crate::{cli, env::RunError, tray, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let inst = app.state::<AppState>().install();
        Ok(json!({ "install": inst, "zh": crate::i18n::is_zh(), "version": app.package_info().version.to_string() }))
    })
    .await
}

#[tauri::command]
pub async fn status(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let r = tray::refresh(&app);
        tray::apply(&app, &r);
        r
    })
    .await
}

/// `deps` / `doctor` only — the window can't pick an arbitrary desktop-cli subcommand.
#[tauri::command]
pub async fn check(app: AppHandle, kind: String) -> Result<Value, String> {
    if kind != "deps" && kind != "doctor" {
        return Err(format!("unknown check: {kind}"));
    }
    blocking(move || cli::desktop_cli(&app.state::<AppState>().install(), &kind)).await
}

#[tauri::command]
pub async fn probe_tools(app: AppHandle) -> Result<Value, String> {
    blocking(move || Ok(cli::probe_tools(&app.state::<AppState>().install()))).await
}

/// Shared by the menu and the window. Refused while another restart runs or settles; desktop-cli
/// itself refuses during an auto-update. The gate is held by a guard, so it is released however
/// this returns; the tray is refreshed after the guard drops, to pick up the grey settle state.
pub fn restart_now(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let inst = state.install();
    let raw = {
        let mut guard = state.begin_restart()?;
        let raw = cli::desktop_cli_raw(&inst, "restart");
        guard.kicked = kick_attempted(&raw);
        raw
    };
    let status = tray::refresh(app);
    tray::apply(app, &status);
    raw.map_err(String::from).and_then(cli::check_error)
}

/// Did kickstart (maybe only partly) run? `results` present = yes; a JSON refusal without it
/// (auto-update running) or a desktop-cli that never started (bun missing) = no, the light stays
/// as is. Started but no JSON (timeout, crash) = unknown, so settle grey: a false "healthy" right
/// after a half-done restart is the worse mistake.
fn kick_attempted(raw: &Result<Value, RunError>) -> bool {
    match raw {
        Ok(v) => v["results"].is_array(),
        Err(RunError::NotStarted(_)) => false,
        Err(RunError::Started(_)) => true,
    }
}

#[tauri::command]
pub async fn restart(app: AppHandle) -> Result<Value, String> {
    blocking(move || restart_now(&app)).await
}

#[tauri::command]
pub async fn open_web(app: AppHandle) -> Result<(), String> {
    blocking(move || cli::open_web(app.state::<AppState>().last_str("webUrl").as_deref())).await
}

#[tauri::command]
pub async fn open_logs(app: AppHandle) -> Result<(), String> {
    blocking(move || cli::open_logs(app.state::<AppState>().last_str("logDir").as_deref())).await
}

#[tauri::command]
pub async fn launch_setup(app: AppHandle) -> Result<String, String> {
    blocking(move || cli::launch_setup(&app.state::<AppState>().install())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kick_attempted_only_when_kickstart_may_have_run() {
        assert!(kick_attempted(&Ok(json!({ "ok": false, "results": [], "error": "x" }))));
        assert!(!kick_attempted(&Ok(json!({ "ok": false, "error": "auto-update running" }))));
        assert!(kick_attempted(&Err(RunError::Started("timed out after 90s".into()))), "unknown outcome settles grey");
        assert!(!kick_attempted(&Err(RunError::NotStarted("not set up".into()))), "no checkout");
    }

    #[test]
    fn restart_with_a_missing_bun_does_not_grey_out() {
        let inst = crate::env::Install {
            repo: std::env::temp_dir(),
            bun: "/nonexistent/t18b/bun".into(),
            path: String::new(),
            daemons_installed: true,
            has_checkout: true,
            cli_available: true,
        };
        let raw = cli::desktop_cli_raw(&inst, "restart");
        assert!(matches!(raw, Err(RunError::NotStarted(_))), "{raw:?}");
        assert!(!kick_attempted(&raw));
    }
}
