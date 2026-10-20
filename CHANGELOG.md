# Changelog

All notable changes to ProPlan. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). `package.json` "version" is the single source of
truth — `npm run release:patch|minor|major` bumps it, syncs the Tauri files and adds the stub below.
Per-build detail (build number, commit, date) lives in `build-info.json` and the About dialog.

## [0.3.0] - 2026-10-20

### Added
- **Timeline tab** (ex-"Alt timeline") overhaul: View card property panel, one-colour status blocks, WP name strips, task/milestone codes (`1.3`, `M1.3`), Fit zoom, a hot-pink Today marker and quick-edit card on right-click.
- **Segmented block style (beta)**: a chain-link dependency icon on each block that expands to the left into the source codes (coloured by each dependency's status), highlights the route it comes from (dotted routes into each code, hover/click a code to isolate and pin it), plus the same icon beside short blocks and milestones. Hover reveals are browsing-only (off in Edit mode).
- **Packed milestones (beta)**: hexagon tags carrying the milestone code, pinned to their date, growing into a full tag on hover/select.
- **Burndown (beta view)**: by task order and by time, tasks/effort, scope and baseline, plan-shift forecast.
- **New Project wizard** (basics, process, products, start with, review).
- **Menus** rebuilt as File · Edit · View · Project · Help (native Mac menu matches); project switcher in File ▸ Open project.
- **Timeline as HTML (Confluence)** is now a full page with the Timeline's View-card style controls: zoom/range, trim to planned, milestones at the bottom or packed, dependency routes, hover highlight, fixed pixel geometry so it never squeezes.
- **Simplified Timeline View card**: no preset row, classic blocks, Jump markers, WP colours, Compact or milestone placement options — segmented blocks and packed milestones are the only styles; view actions moved to the toolbar.
- **Project files** mirrored to `~/Documents/ProPlan`, build links printed after each build.

### Changed
- App renamed to plain "ProPlan" everywhere (`Carpati Timeline.html` → `ProPlan.html`).
- Plan tab is compact with Essentials / All details and foldable WPs.
- Locked blocks and milestones no longer get dashed/thick borders or rings; the padlock says it.

### Fixed
- Legacy WP headers saved the "n of m tasks here" note into the WP name; names are cleaned on display and the note is no longer saved.
- Milestone dates shown next to a marker now match where it is drawn (stand-alone milestones sit mid-month); the Confluence export draws milestones at the same position as the Timeline.
- Confluence export status circles stay round (flex shrink) and WPs with a single task keep a two-row minimum height.

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
- Baseline single-file planner (`Carpati Timeline.html`, since renamed `ProPlan.html`): Plan and Timeline views, dependencies with auto-sequence, phase view, milestones, workload, tracks, undo/redo, snapshots, xlsx/JSON import-export, PNG/PDF export.
- Pure logic extracted to `src/proplan-core.mjs` with a vitest suite and inlining build script.
- macOS desktop shell (Tauri) with download handling and app icon.
