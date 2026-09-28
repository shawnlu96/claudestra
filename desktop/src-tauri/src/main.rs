//! Claudestra menu-bar app (experimental). A thin shell: tray + one bundled window; every
//! decision is made by the repo's `src/desktop-cli.ts`. Chat stays in the bridge-hosted web app.

mod cli;
mod commands;
mod env;
mod i18n;
mod tray;

use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

pub struct AppState {
    install: Mutex<env::Install>,
    pub tray: Mutex<Option<tray::TrayHandles>>,
    pub last_status: Mutex<Option<Value>>,
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

    pub fn last_str(&self, key: &str) -> Option<String> {
        self.last_status.lock().unwrap().as_ref()?.get(key)?.as_str().map(String::from)
    }
}

/// Bring the window forward on a tab (`status` / `doctor` / `setup`).
fn show_window(app: &AppHandle, tab: &str) {
    if let Some(w) = app.get_webview_window("main") {
        // show/focus/eval only fail while the window is being destroyed at quit
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval(format!("window.__claudestraNav && window.__claudestraNav({tab:?})"));
    }
}

pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open-web" => {
            let url = app.state::<AppState>().last_str("webUrl");
            if let Err(e) = cli::open_web(url.as_deref()) {
                eprintln!("open web: {e}");
            }
        }
        "open-logs" => {
            if let Err(e) = cli::open_logs(app.state::<AppState>().last_str("logDir").as_deref()) {
                eprintln!("open logs: {e}");
                show_window(app, "status");
            }
        }
        "show-doctor" => show_window(app, "doctor"),
        "show-setup" => show_window(app, "setup"),
        "restart" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = commands::restart_now(&app) {
                    eprintln!("restart: {e}");
                    show_window(&app, "status");
                }
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
