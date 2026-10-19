#!/usr/bin/env node
/* Keep the desktop shell's version in lockstep with package.json (the single
 * source of truth). Rewrites ONLY the version fields of
 * src-tauri/tauri.conf.json and src-tauri/Cargo.toml; no-op when in sync.
 * Called from scripts/build.mjs, also runnable on its own: `npm run version:sync`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver } from '../src/proplan-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Pure: new file text with the version replaced (first match only). */
export function setConfVersion(text, version) {
  return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}
export function setCargoVersion(text, version) {
  // Only the [package] table's own version line (before the next [section]).
  return text.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/, `$1${version}$2`);
}

/** Cargo.lock pins the root crate's own version too. */
export function setCargoLockVersion(text, version) {
  return text.replace(/(\nname = "proplan"\nversion = ")[^"]*(")/, `$1${version}$2`);
}

export function syncVersion(root = ROOT) {
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  if (!parseSemver(version)) throw new Error(`package.json version is not semver: ${version}`);
  const changed = [];
  for (const [rel, fn] of [
    ['src-tauri/tauri.conf.json', setConfVersion],
    ['src-tauri/Cargo.toml', setCargoVersion],
    ['src-tauri/Cargo.lock', setCargoLockVersion],
  ]) {
    const p = resolve(root, rel);
    let before;
    try { before = readFileSync(p, 'utf8'); } catch { continue; }
    const after = fn(before, version);
    if (after !== before) { writeFileSync(p, after); changed.push(rel); }
  }
  return { version, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, changed } = syncVersion();
  console.log(changed.length ? `✓ Version ${version} → ${changed.join(', ')}` : `✓ Version ${version} already in sync`);
}
