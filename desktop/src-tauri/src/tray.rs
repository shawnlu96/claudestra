//! Menu-bar icon + dropdown. Status comes from `desktop-cli status` (launchctl only, ~70 ms),
//! polled every few seconds; the full doctor run is on demand from the window.

use crate::{cli, i18n::tr, AppState};
use serde_json::Value;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

const POLL: Duration = Duration::from_secs(8);
const ICON_PX: u32 = 44; // 22 pt at 2x

pub struct TrayHandles {
    pub icon: TrayIcon,
    menu: Menu<Wry>,
    pub summary: MenuItem<Wry>,
    /// one row per daemon, (name, item); built from the first status result, not hard-coded here
    daemons: Vec<(String, MenuItem<Wry>)>,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Light {
    Unknown,
    Ok,
    Warn,
    Fail,
}

impl Light {
    pub fn from_status(s: &str) -> Light {
        match s {
            "ok" => Light::Ok,
            "warn" => Light::Warn,
            "fail" => Light::Fail,
            _ => Light::Unknown,
        }
    }
}

/// Ring with a gap + centre dot. Healthy/unknown is a template image (follows the menu bar's
/// light/dark tint); warn/fail are coloured so they stand out — which is the point of the light.
pub fn render_icon(light: Light) -> (Image<'static>, bool) {
    let (rgb, alpha_scale, template) = match light {
        Light::Ok => ([0, 0, 0], 1.0, true),
        Light::Unknown => ([0, 0, 0], 0.45, true),
        Light::Warn => ([0xF5, 0xA5, 0x24], 1.0, false),
        Light::Fail => ([0xE5, 0x48, 0x4D], 1.0, false),
    };
    let n = ICON_PX as f32;
    let c = n / 2.0;
    let mut px = vec![0u8; (ICON_PX * ICON_PX * 4) as usize];
    for y in 0..ICON_PX {
        for x in 0..ICON_PX {
            let (dx, dy) = (x as f32 + 0.5 - c, y as f32 + 0.5 - c);
            let d = (dx * dx + dy * dy).sqrt();
            let angle = dy.atan2(dx).to_degrees().abs(); // 0° = pointing right
            let ring = (1.6 - (d - 15.0).abs()).clamp(0.0, 1.0) * if angle < 38.0 { 0.0 } else { 1.0 };
            let dot = (5.2 - d).clamp(0.0, 1.0);
            let a = ring.max(dot) * alpha_scale;
            let i = ((y * ICON_PX + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], (a * 255.0) as u8]);
        }
    }
    (Image::new_owned(px, ICON_PX, ICON_PX), template)
}

pub fn build(app: &AppHandle) -> tauri::Result<TrayHandles> {
    let summary = MenuItem::with_id(app, "summary", tr("正在读取状态…", "Reading status…"), false, None::<&str>)?;
    let restart_confirm = MenuItem::with_id(
        app,
        "restart",
        tr("确定重启（会打断正在推送的消息）", "Restart now (interrupts messages being streamed)"),
        true,
        None::<&str>,
    )?;
    let restart = Submenu::with_items(app, tr("重启服务", "Restart services"), true, &[&restart_confirm])?;
    let sep = || PredefinedMenuItem::separator(app);
    let item = |id: &str, zh: &str, en: &str| MenuItem::with_id(app, id, tr(zh, en), true, None::<&str>);

    let menu = Menu::new(app)?;
    menu.append(&summary)?;
    menu.append(&sep()?)?;
    menu.append(&item("open-web", "打开 Claudestra 网页", "Open Claudestra")?)?;
    menu.append(&item("show-doctor", "体检…", "Health check…")?)?;
    menu.append(&item("show-setup", "安装向导…", "Setup…")?)?;
    menu.append(&restart)?;
    menu.append(&item("open-logs", "打开日志目录", "Open log folder")?)?;
    menu.append(&sep()?)?;
    menu.append(&item("quit", "退出（服务继续运行）", "Quit (services keep running)")?)?;

    let (img, template) = render_icon(Light::Unknown);
    let icon = TrayIconBuilder::with_id("main")
        .icon(img)
        .icon_as_template(template)
        .tooltip("Claudestra")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, ev| crate::on_menu(app, ev.id().as_ref()))
        .build(app)?;
    Ok(TrayHandles { icon, menu, summary, daemons: Vec::new() })
}

fn daemon_line(name: &str, status: Option<&str>, detail: &str) -> String {
    let mark = match status {
        Some("ok") => "●",
        Some("warn") => "▲",
        _ => "○",
    };
    format!("{mark}  {name}  —  {detail}")
}

/// Keep one menu row per daemon in the status result, right under the summary line.
fn sync_rows(app: &AppHandle, h: &mut TrayHandles, list: &[Value]) {
    let names: Vec<String> = list.iter().map(|d| d["name"].as_str().unwrap_or("?").to_string()).collect();
    if h.daemons.iter().map(|(n, _)| n).ne(names.iter()) {
        for (_, row) in h.daemons.drain(..) {
            // remove only fails if the row is already gone, which is the goal
            let _ = h.menu.remove(&row);
        }
        for (i, name) in names.iter().enumerate() {
            if let Ok(row) = MenuItem::with_id(app, format!("d-{name}"), name, false, None::<&str>) {
                if h.menu.insert(&row, i + 1).is_ok() {
                    h.daemons.push((name.clone(), row));
                }
            }
        }
    }
    for ((name, row), d) in h.daemons.iter().zip(list) {
        // set_text only fails if the menu is gone (app quitting); nothing to update then
        let _ = row.set_text(daemon_line(name, d["status"].as_str(), d["detail"].as_str().unwrap_or("")));
    }
}

/// First line, bounded: the menu is not the place for a stack of stderr.
fn short(e: &str) -> String {
    let line = e.lines().next().unwrap_or("");
    let cut: String = line.chars().take(70).collect();
    if cut.len() < line.len() { format!("{cut}…") } else { cut }
}

/// Push one status result into the menu and icon. Called from the poll thread and after restart.
/// While a restart settles, the light stays grey: right after kickstart every daemon briefly looks
/// healthy (new pid, exit -15) before it has actually come up.
pub fn apply(app: &AppHandle, status: &Result<Value, String>) {
    let state = app.state::<AppState>();
    let restarting = state.restarting();
    let mut guard = state.tray.lock().unwrap();
    let Some(h) = guard.as_mut() else { return };
    let (light, summary) = match status {
        Ok(v) => {
            if let Some(list) = v["daemons"].as_array() {
                sync_rows(app, h, list);
            }
            let light = Light::from_status(v["overall"].as_str().unwrap_or(""));
            let text = match light {
                Light::Ok => tr("Claudestra 运行正常", "Claudestra is running"),
                Light::Warn => tr("Claudestra 有警告", "Claudestra has warnings"),
                _ => tr("Claudestra 有服务没在运行", "A Claudestra service is down"),
            };
            (light, text)
        }
        Err(e) => {
            // the last known pids are stale now; keep the rows but stop claiming anything about them
            for (name, row) in &h.daemons {
                let _ = row.set_text(daemon_line(name, None, "?"));
            }
            (Light::Unknown, short(e))
        }
    };
    let (light, summary) = if restarting { (Light::Unknown, tr("正在重启…", "Restarting…")) } else { (light, summary) };
    let _ = h.summary.set_text(summary);
    let (img, template) = render_icon(light);
    // icon updates only fail while the tray is being torn down at quit
    let _ = h.icon.set_icon(Some(img));
    let _ = h.icon.set_icon_as_template(template);
}

/// Re-locate the install each round until the daemons exist, so finishing setup in Terminal
/// lights the menu up without restarting the app.
pub fn refresh(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let inst = state.install();
    let mut result = cli::desktop_cli(&inst, "status");
    match &mut result {
        Ok(v) => {
            v["restarting"] = Value::Bool(state.restarting());
            *state.last_status.lock().unwrap() = Some(v.clone());
        }
        Err(_) => *state.last_status.lock().unwrap() = None,
    }
    result
}

pub fn start_polling(app: AppHandle) {
    std::thread::spawn(move || loop {
        let status = refresh(&app);
        apply(&app, &status);
        std::thread::sleep(POLL);
    });
}
