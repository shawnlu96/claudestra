//! Claudestra menu-bar app (experimental). A thin shell: tray + one bundled window; every
//! decision is made by the repo's `src/desktop-cli.ts`. Chat stays in the bridge-hosted web app.

mod cli;
mod commands;
mod env;
mod i18n;
mod tray;

use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// How long the light stays grey after a restart: kickstart returns at once, the daemons need a
/// few seconds to actually come up (bridge reloads registry, reconnects agents).
const RESTART_SETTLE: Duration = Duration::from_secs(15);

#[derive(Default)]
struct RestartGate {
    in_flight: bool,
    settle_until: Option<Instant>,
}

impl RestartGate {
    fn busy(&self, now: Instant) -> bool {
        self.in_flight || self.settle_until.is_some_and(|t| now < t)
    }

    fn begin(&mut self, now: Instant) -> bool {
        if self.busy(now) {
            return false;
        }
        self.in_flight = true;
        true
    }

    fn end(&mut self, now: Instant, kicked: bool) {
        self.in_flight = false;
        self.settle_until = kicked.then(|| now + RESTART_SETTLE);
    }
}

pub struct AppState {
    install: Mutex<env::Install>,
    pub tray: Mutex<Option<tray::TrayHandles>>,
    pub last_status: Mutex<Option<Value>>,
    restart: Mutex<RestartGate>,
}

impl AppState {
    /// Cached until everything is in place; before that, look again (setup may have just finished).
    pub fn install(&self) -> env::Install {
        let mut cur = self.install.lock().unwrap();
        if !(cur.daemons_installed && cur.cli_available) {
            *cur = env::locate();
        }
        cur.clone()
    }

    /// One restart at a time, and none while the previous one is still settling.
    pub fn begin_restart(&self) -> Result<(), String> {
        if self.restart.lock().unwrap().begin(Instant::now()) {
            Ok(())
        } else {
            Err(i18n::tr("正在重启，稍等再试", "A restart is already in progress"))
        }
    }

    /// `kicked`: kickstart ran (even partly), so the daemons are coming back up.
    pub fn end_restart(&self, kicked: bool) {
        self.restart.lock().unwrap().end(Instant::now(), kicked);
    }

    pub fn restarting(&self) -> bool {
        self.restart.lock().unwrap().busy(Instant::now())
    }

    pub fn last_str(&self, key: &str) -> Option<String> {
        self.last_status.lock().unwrap().as_ref()?.get(key)?.as_str().map(String::from)
    }
}

/// Bring the window forward on a tab (`status` / `doctor` / `setup`), optionally with a notice.
fn show_window(app: &AppHandle, tab: &str, notice: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        // show/focus/eval only fail while the window is being destroyed at quit
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval(format!("window.__claudestraNav && window.__claudestraNav({tab:?})"));
        if let Some(msg) = notice {
            let js = serde_json::to_string(msg).unwrap_or_default();
            let _ = w.eval(format!("window.__claudestraNotice && window.__claudestraNotice({js})"));
        }
    }
}

/// Menu actions have no UI of their own; a failure opens the window with the reason.
fn report(app: &AppHandle, what: &str, r: Result<(), String>) {
    if let Err(e) = r {
        show_window(app, "status", Some(&format!("{what}：{e}")));
    }
}

pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open-web" => {
            let url = app.state::<AppState>().last_str("webUrl");
            report(app, &i18n::tr("打开网页失败", "Could not open the web app"), cli::open_web(url.as_deref()));
        }
        "open-logs" => {
            let dir = app.state::<AppState>().last_str("logDir");
            report(app, &i18n::tr("打开日志目录失败", "Could not open the log folder"), cli::open_logs(dir.as_deref()));
        }
        "show-doctor" => show_window(app, "doctor", None),
        "show-setup" => show_window(app, "setup", None),
        "restart" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let r = commands::restart_now(&app).map(|_| ());
                report(&app, &i18n::tr("重启失败", "Restart failed"), r);
            });
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(AppState {
            install: Mutex::new(env::locate()),
            tray: Mutex::new(None),
            last_status: Mutex::new(None),
            restart: Mutex::new(RestartGate::default()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::status,
            commands::check,
            commands::probe_tools,
            commands::restart,
            commands::open_web,
            commands::open_logs,
            commands::launch_setup,
        ])
        .setup(|app| {
            // menu-bar app: no Dock icon, no app menu
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handles = tray::build(app.handle())?;
            *app.state::<AppState>().tray.lock().unwrap() = Some(handles);
            tray::start_polling(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the window only hides it; the app lives in the menu bar until "Quit"
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Claudestra menu-bar app");

    app.run(|_app, event| {
        // keep running with zero windows; only the menu's Quit (exit code set) ends the app
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_gate_blocks_reentry_and_settles() {
        let t0 = Instant::now();
        let mut g = RestartGate::default();
        assert!(g.begin(t0));
        assert!(!g.begin(t0), "second restart while the first runs");
        g.end(t0, true);
        assert!(g.busy(t0 + Duration::from_secs(14)), "still settling");
        assert!(!g.begin(t0 + Duration::from_secs(14)));
        assert!(!g.busy(t0 + RESTART_SETTLE));
        assert!(g.begin(t0 + RESTART_SETTLE));
    }

    #[test]
    fn refused_restart_does_not_grey_out() {
        let t0 = Instant::now();
        let mut g = RestartGate::default();
        assert!(g.begin(t0));
        g.end(t0, false); // e.g. refused during an auto-update: nothing was kicked
        assert!(!g.busy(t0));
    }
}
