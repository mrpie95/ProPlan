// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// ProPlan is a pure single-file HTML/JS app (Carpati Timeline.html, staged
// as dist-tauri/index.html by scripts/tauri-prepare.mjs). This shell just
// hosts it in a native window — no custom Rust commands needed.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running ProPlan");
}
