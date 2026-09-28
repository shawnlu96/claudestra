// Declaring the command list makes each one a permission (`allow-<command>`) that the window's
// capability must grant explicitly; without it every registered command is open to every window.
const COMMANDS: &[&str] = &[
    "app_info",
    "status",
    "check",
    "probe_tools",
    "restart",
    "open_web",
    "open_logs",
    "launch_setup",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build script failed");
}
