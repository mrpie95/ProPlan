# Changelog

All notable changes to ProPlan. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). `package.json` "version" is the single source of
truth — `npm run release:patch|minor|major` bumps it, syncs the Tauri files and adds the stub below.
Per-build detail (build number, commit, date) lives in `build-info.json` and the About dialog.

## [0.2.0] - 2026-10-19

### Added
- **Processes** — each project runs a phase model (SOP-18, Stage-Gate or none); switching maps phase tags with a dry-run preview, a "before switching" snapshot and Undo. Custom processes can be registered and travel with project exports.
- **Progress tab** — completion checklist per WP with task checkboxes and dates, status notes, burn-up chart and a recent-activity feed; completion mutations always go through core so dates and the log stay consistent.
- **Summary tab**, multiple independent **projects** with their own snapshots, full-backup export/restore.
- **Dark-mode tokens** — theme variables replace hard-coded colours so every view works in dark mode.
- **Tab bar and native macOS menu** (Tauri) sharing one command dispatcher; in-app dialogs replace native `confirm`/`prompt`/`alert`.
- **About dialog** and build tracking: version + build number + commit stamped into the HTML on every `npm run build`, build history in `build-info.json`, release scripts.

### Changed
- The app version now has one source (`package.json`); `src-tauri/tauri.conf.json` and `Cargo.toml` are synced from it.

## [0.1.0] - 2026-08-24

### Added
- Baseline single-file planner (`Carpati Timeline.html`): Plan and Timeline views, dependencies with auto-sequence, phase view, milestones, workload, tracks, undo/redo, snapshots, xlsx/JSON import-export, PNG/PDF export.
- Pure logic extracted to `src/proplan-core.mjs` with a vitest suite and inlining build script.
- macOS desktop shell (Tauri) with download handling and app icon.
