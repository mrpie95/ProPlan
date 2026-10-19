#!/usr/bin/env node
/* `npm run release:patch|minor|major` — bump package.json "version", add a
 * CHANGELOG.md entry stub, then run the build (which syncs the Tauri files
 * and stamps the new version + build number into the HTML).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bumpVersion, changelogStub, insertChangelogEntry } from '../src/proplan-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kind = process.argv[2];
if (!['major', 'minor', 'patch'].includes(kind)) {
  console.error('Usage: node scripts/release.mjs <major|minor|patch>');
  process.exit(1);
}
const pkgPath = resolve(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const next = bumpVersion(pkg.version, kind);
writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`));

const clPath = resolve(ROOT, 'CHANGELOG.md');
let cl = '';
try { cl = readFileSync(clPath, 'utf8'); } catch {}
const day = new Date().toISOString().slice(0, 10);
writeFileSync(clPath, insertChangelogEntry(cl || '# Changelog\n', next, changelogStub(next, day)));
console.log(`✓ ${pkg.version} → ${next}; CHANGELOG.md entry added (fill it in)`);

const r = spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
