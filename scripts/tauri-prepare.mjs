#!/usr/bin/env node
/* Stages "Carpati Timeline.html" — the single canonical app file — as
 * dist-tauri/index.html so the Tauri shell has a plain `index.html` to
 * serve. This is a copy, not a build step: the HTML is already final
 * (run `npm run build` first if src/proplan-core.mjs changed). Runs
 * automatically before `tauri dev` / `tauri build` via tauri.conf.json's
 * beforeDevCommand / beforeBuildCommand.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SRC = resolve(ROOT, 'Carpati Timeline.html');
const OUT_DIR = resolve(ROOT, 'dist-tauri');
const OUT_FILE = resolve(OUT_DIR, 'index.html');

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, readFileSync(SRC));
console.log(`[tauri-prepare] Copied "Carpati Timeline.html" -> dist-tauri/index.html`);
