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

/// One restart in flight. Dropping it ends the gate, so an early return or a panic can't leave
/// `in_flight` stuck (which would refuse every later restart until the app is quit).
pub struct RestartGuard<'a> {
    gate: &'a Mutex<RestartGate>,
    /// kickstart ran (even partly): the daemons are coming back up, so the light settles grey
    pub kicked: bool,
}

impl<'a> RestartGuard<'a> {
    fn acquire(gate: &'a Mutex<RestartGate>, now: Instant) -> Option<Self> {
        // lazily, and after the lock is released: a guard built for a refused begin would be
        // dropped here and end the restart that is actually running
        let began = lock(gate).begin(now);
        began.then(|| RestartGuard { gate, kicked: false })
    }
}

impl Drop for RestartGuard<'_> {
    fn drop(&mut self) {
        lock(self.gate).end(Instant::now(), self.kicked);
    }
}

/// The gate's data stays valid even if some holder panicked; `unwrap` here would turn one panic
/// into a second one inside `Drop` (an abort) and lock the gate for good.
fn lock(gate: &Mutex<RestartGate>) -> std::sync::MutexGuard<'_, RestartGate> {
    gate.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct AppState {
    install: Mutex<env::Install>,
    pub tray: Mutex<Option<tray::TrayHandles>>,
    pub last_status: Mutex<Option<Value>>,
    restart: Mutex<RestartGate>,
}

impl AppState {
    pub fn install(&self) -> env::Install {
        self.install_with(env::locate)
    }

    /// Cached once everything is in place and the PATH is a real one; before that, look again on
    /// each call (setup may have just finished, or the background login-shell read just landed).
    /// Freezing a `Default` PATH would hide the user's tool dirs until the app is restarted.
    fn install_with(&self, locate: impl FnOnce() -> env::Install) -> env::Install {
        let mut cur = self.install.lock().unwrap();
        if !(cur.daemons_installed && cur.cli_available && cur.path_source != env::PathSource::Default) {
            *cur = locate();
        }
        cur.clone()
    }

    /// One restart at a time, and none while the previous one is still settling.
    pub fn begin_restart(&self) -> Result<RestartGuard<'_>, String> {
        RestartGuard::acquire(&self.restart, Instant::now())
            .ok_or_else(|| i18n::tr("正在重启，稍等再试", "A restart is already in progress"))
    }

    pub fn restarting(&self) -> bool {
        lock(&self.restart).busy(Instant::now())
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
        show_window(app, "status", Some(&format!("{what}{}{e}", i18n::tr("：", ": "))));
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
    use std::path::PathBuf;

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
    fn guard_ends_the_gate_on_drop() {
        let gate = Mutex::new(RestartGate::default());
        let g = RestartGuard::acquire(&gate, Instant::now()).expect("free");
        assert!(RestartGuard::acquire(&gate, Instant::now()).is_none(), "second restart while the first runs");
        drop(g); // kicked stays false: nothing to settle
        assert!(RestartGuard::acquire(&gate, Instant::now()).is_some());
    }

    #[test]
    fn guard_releases_the_gate_when_the_restart_panics() {
        let gate = Mutex::new(RestartGate::default());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut g = RestartGuard::acquire(&gate, Instant::now()).expect("free");
            g.kicked = true;
            panic!("restart blew up");
        }));
        assert!(r.is_err());
        let t = Instant::now();
        assert!(lock(&gate).busy(t), "kicked before the panic: still settles grey");
        assert!(!lock(&gate).busy(t + RESTART_SETTLE), "but never stays stuck");
    }

    /// A checkout with the desktop entry point, and a bridge plist whose `EnvironmentVariables`
    /// are `env_xml` (empty = no PATH at all). Lives under the test's own temp dir.
    fn fake_install(name: &str, env_xml: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("t18b-{name}-{}", std::process::id()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        for f in ["src/setup.ts", "src/desktop-cli.ts"] {
            std::fs::write(repo.join(f), "").unwrap();
        }
        let plist = dir.join("bridge.plist");
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>Label</key><string>{}</string>\
             <key>WorkingDirectory</key><string>{}</string>{env_xml}</dict></plist>\n",
            env::BRIDGE_LABEL,
            repo.display()
        );
        std::fs::write(&plist, body).unwrap();
        (dir, plist)
    }

    fn state_with(install: env::Install) -> AppState {
        AppState {
            install: Mutex::new(install),
            tray: Mutex::new(None),
            last_status: Mutex::new(None),
            restart: Mutex::new(RestartGate::default()),
        }
    }

    #[test]
    fn default_path_is_replaced_once_the_login_shell_read_lands() {
        let (dir, plist) = fake_install("appstate", "");
        let cache = Mutex::new(env::LoginPathCache::new());
        let login = || cache.lock().unwrap().poll(Instant::now()).0;
        let calls = std::cell::Cell::new(0);
        let relocate = || {
            calls.set(calls.get() + 1);
            env::locate_with(&plist, login)
        };
        let state = state_with(relocate());
        let first = state.install_with(relocate);
        assert!(first.daemons_installed && first.cli_available, "installed: the old code froze here");
        assert_eq!(first.path_source, env::PathSource::Default, "read still in flight");
        cache.lock().unwrap().finish(Instant::now(), Some("/t18b-custom-bin:/usr/bin".into()));
        let got = state.install_with(relocate);
        assert_eq!(got.path_source, env::PathSource::LoginShell);
        assert!(got.path.starts_with("/t18b-custom-bin:"), "{}", got.path);
        assert_eq!(calls.get(), 3);
        let kept = state.install_with(|| panic!("a real PATH is cached, no more lookups"));
        assert_eq!(kept.path, got.path);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn plist_path_wins_and_skips_the_login_shell() {
        let env_xml = "<key>EnvironmentVariables</key><dict><key>PATH</key><string>/t18b-plist-bin</string></dict>";
        let (dir, plist) = fake_install("plist", env_xml);
        let inst = env::locate_with(&plist, || panic!("plist has a PATH"));
        assert_eq!(inst.path_source, env::PathSource::Plist);
        assert!(inst.path.starts_with("/t18b-plist-bin:"), "{}", inst.path);
        let missing = env::locate_with(&dir.join("absent.plist"), || None);
        assert_eq!((missing.daemons_installed, missing.path_source), (false, env::PathSource::Default));
        std::fs::remove_dir_all(dir).unwrap();
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
