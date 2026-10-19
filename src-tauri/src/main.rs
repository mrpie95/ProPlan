// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Emitter, Wry, WebviewUrl, WebviewWindowBuilder};

// ProPlan is a pure single-file HTML/JS app (Carpati Timeline.html, staged
// as dist-tauri/index.html by scripts/tauri-prepare.mjs). This shell hosts it
// in a native window and does three native things:
//
//  1. Downloads. WKWebView only honours <a download> (every export button)
//     when the host registers a download handler, so we register one: files
//     land in ~/Downloads (wry picks a non-colliding name) and the page is
//     told where via a "proplan-download" event so it can show a toast.
//  2. reveal_in_finder, so that toast can offer "Show in Finder".
//  3. The macOS menu bar. Items carry command ids ("newProject", "view:plan",
//     "json" …) that are forwarded to the page as a "proplan-menu" event and
//     run by the page's runCommand() — the same dispatcher as the in-page
//     Menu ▾ — so there is exactly one implementation of every command.
#[tauri::command]
fn reveal_in_finder(path: String) {
    let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
}


// ---- Project files ---------------------------------------------------------
// One JSON file per project in ~/Documents/ProPlan/. std::fs only. Every name
// coming from the page must be a bare "<something>.proplan.json" (no path
// separators / traversal); reads are additionally confined to the folder.
const PROJECT_EXT: &str = ".proplan.json";

fn project_dir_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let dir = std::path::PathBuf::from(home).join("Documents").join("ProPlan");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn safe_project_name(name: &str) -> Result<&str, String> {
    let ok = name.len() > PROJECT_EXT.len()
        && name.len() <= 120
        && name.ends_with(PROJECT_EXT)
        && !name.starts_with('.')
        && !name.contains("..")
        && !name.contains(|c: char| c == '/' || c == '\\' || c == '\0' || c == ':');
    if ok { Ok(name) } else { Err(format!("Invalid project file name: {name}")) }
}

#[tauri::command]
fn project_dir() -> Result<String, String> {
    Ok(project_dir_path()?.to_string_lossy().to_string())
}

/// Atomic write: temp file in the same folder, then rename over the target.
#[tauri::command]
fn write_project_file(name: String, contents: String) -> Result<String, String> {
    let dir = project_dir_path()?;
    let name = safe_project_name(&name)?;
    let target = dir.join(name);
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't save {}: {e}", target.display()));
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn read_project_file(path: String) -> Result<String, String> {
    let dir = project_dir_path()?.canonicalize().map_err(|e| e.to_string())?;
    let file = std::path::PathBuf::from(&path).canonicalize().map_err(|e| format!("Couldn't open {path}: {e}"))?;
    if file.parent() != Some(dir.as_path()) {
        return Err("That file is outside the ProPlan folder.".into());
    }
    let fname = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
    safe_project_name(fname)?;
    std::fs::read_to_string(&file).map_err(|e| format!("Couldn't read {}: {e}", file.display()))
}

#[tauri::command]
fn list_project_files() -> Result<Vec<serde_json::Value>, String> {
    let dir = project_dir_path()?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if safe_project_name(&name).is_err() { continue; }
        let meta = match entry.metadata() { Ok(m) if m.is_file() => m, _ => continue };
        let modified = meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64).unwrap_or(0);
        out.push(serde_json::json!({
            "path": entry.path().to_string_lossy().to_string(),
            "name": name,
            "modified": modified,
        }));
    }
    out.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Ok(out)
}

/// Renames a project file inside the folder; refuses to overwrite.
#[tauri::command]
fn rename_project_file(from: String, to: String) -> Result<String, String> {
    let dir = project_dir_path()?;
    let from = safe_project_name(&from)?;
    let to = safe_project_name(&to)?;
    let (a, b) = (dir.join(from), dir.join(to));
    if !a.is_file() { return Err(format!("{from} doesn't exist.")); }
    if b.exists() { return Err(format!("{to} already exists.")); }
    std::fs::rename(&a, &b).map_err(|e| e.to_string())?;
    Ok(b.to_string_lossy().to_string())
}

#[tauri::command]
fn open_project_folder() -> Result<(), String> {
    let dir = project_dir_path()?;
    std::process::Command::new("open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn cmd(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // ProPlan (app menu)
    // "About ProPlan" is the app's own dialog (version, build history), not
    // the stock macOS panel — it goes through the same runCommand("about").
    let app_menu = SubmenuBuilder::new(app, "ProPlan")
        .item(&cmd(app, "about", "About ProPlan", None)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // File: project lifecycle, snapshots, export/import
    let export = SubmenuBuilder::new(app, "Export")
        .item(&cmd(app, "json", "Project as JSON", Some("CmdOrCtrl+E"))?)
        .item(&cmd(app, "exportAll", "Back Up All Projects", Some("CmdOrCtrl+Shift+E"))?)
        .separator()
        .item(&cmd(app, "png", "Timeline as PNG", None)?)
        .item(&cmd(app, "pdf", "Timeline as PDF", None)?)
        .item(&cmd(app, "html", "Page as HTML", None)?)
        .item(&cmd(app, "timelineHtml", "Timeline as HTML (Confluence)…", None)?)
        .build()?;
    let import = SubmenuBuilder::new(app, "Import")
        .item(&cmd(app, "import", "JSON (Replace Current Plan)…", None)?)
        .item(&cmd(app, "importAsProject", "JSON as New Project…", None)?)
        .item(&cmd(app, "importBackup", "Restore Backup…", None)?)
        .item(&cmd(app, "importXlsx", "Excel (.xlsx)…", None)?)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&cmd(app, "newProject", "New Project…", Some("CmdOrCtrl+N"))?)
        .item(&cmd(app, "openProjectSwitcher", "Switch Project…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&cmd(app, "renameProject", "Rename Project…", None)?)
        .item(&cmd(app, "duplicateProject", "Duplicate Project…", None)?)
        .item(&cmd(app, "deleteProject", "Delete Project…", None)?)
        .separator()
        .item(&cmd(app, "saveSnapshot", "Save Snapshot…", Some("CmdOrCtrl+S"))?)
        .separator()
        .item(&export)
        .item(&import)
        .separator()
        .close_window()
        .build()?;

    // Edit: Cut/Copy/Paste/Select All are required for text fields to get
    // ⌘C/⌘V in WKWebView. Undo/Redo are the app's own (no accelerator here —
    // ⌘Z / ⇧⌘Z are handled by the page so text fields keep native undo).
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&cmd(app, "undo", "Undo", None)?)
        .item(&cmd(app, "redo", "Redo", None)?)
        .separator()
        .item(&cmd(app, "toggleEdit", "Edit Mode", Some("CmdOrCtrl+Shift+M"))?)
        .item(&cmd(app, "focusMode", "Focus Mode", None)?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // View: every view, mirroring the in-app nav bar — Summary · Editors
    // (Structure, Plan, Progress, Timeline) · Views (read-only/presentation).
    // ⌘1…⌘9 keep their earlier meaning; the rest use ⌘⌥.
    let view = SubmenuBuilder::new(app, "View")
        .item(&cmd(app, "view:summary", "Summary", Some("CmdOrCtrl+1"))?)
        .separator()
        .item(&cmd(app, "view:structure", "Structure", Some("CmdOrCtrl+8"))?)
        .item(&cmd(app, "view:plan", "Plan", Some("CmdOrCtrl+2"))?)
        .item(&cmd(app, "view:progress", "Progress", Some("CmdOrCtrl+Alt+3"))?)
        .item(&cmd(app, "view:altTimeline", "Timeline", Some("CmdOrCtrl+3"))?)
        .item(&cmd(app, "view:viewA", "Legacy Timeline", None)?)
        .separator()
        .item(&cmd(app, "view:roadmap", "Simple Timeline", Some("CmdOrCtrl+4"))?)
        .item(&cmd(app, "view:phaseTimeline", "Phase Timeline", Some("CmdOrCtrl+5"))?)
        .item(&cmd(app, "view:milestones", "Milestones", Some("CmdOrCtrl+6"))?)
        .item(&cmd(app, "view:proposal", "Proposal Timeline", Some("CmdOrCtrl+7"))?)
        .separator()
        .item(&cmd(app, "view:phase", "Phase Status", Some("CmdOrCtrl+Alt+1"))?)
        .item(&cmd(app, "view:process", "Process Reference", Some("CmdOrCtrl+Alt+2"))?)
        .item(&cmd(app, "view:snapshots", "Snapshots", Some("CmdOrCtrl+9"))?)
        .separator()
        .item(&cmd(app, "toggleTheme", "Toggle Dark Mode", Some("CmdOrCtrl+Shift+L"))?)
        .separator()
        .fullscreen()
        .build()?;

    // Process: the project's phase model (SOP-18 / Stage-Gate / none / custom).
    let process = SubmenuBuilder::new(app, "Process")
        .item(&cmd(app, "changeProcess", "Choose Process…", None)?)
        .item(&cmd(app, "view:process", "Process Reference", None)?)
        .build()?;

    // Beta: experimental views. Ids must match window.BETA_VIEWS in the page.
    let beta_views = SubmenuBuilder::new(app, "Beta Views")
        .item(&cmd(app, "view:altTimeline", "Alt Timeline View", None)?)
        .build()?;
    let beta = SubmenuBuilder::new(app, "Beta")
        .item(&beta_views)
        .build()?;

    let plan = SubmenuBuilder::new(app, "Plan")
        .item(&cmd(app, "loadDemo", "Load Demo Plan…", None)?)
        .item(&cmd(app, "clear", "Clear Timeline…", None)?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &process, &beta, &plan, &window])
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            reveal_in_finder,
            project_dir,
            write_project_file,
            read_project_file,
            list_project_files,
            rename_project_file,
            open_project_folder
        ])
        .on_menu_event(|app, event| {
            let _ = app.emit("proplan-menu", event.id().as_ref().to_string());
        })
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("ProPlan")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .on_download(move |_webview, event| {
                    if let DownloadEvent::Finished { path, success, .. } = event {
                        let _ = handle.emit(
                            "proplan-download",
                            serde_json::json!({
                                "path": path.map(|p| p.to_string_lossy().to_string()),
                                "success": success,
                            }),
                        );
                    }
                    true
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ProPlan");
}
