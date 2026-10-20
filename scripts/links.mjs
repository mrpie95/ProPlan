#!/usr/bin/env node
/* Prints links you can paste straight into a browser / Finder after a build.
 *
 *   npm run build      → prints the browser link (file:// URL of ProPlan.html)
 *   npm run app:build  → also prints where the Mac app and the .dmg landed
 *   npm run link       → just print them again
 *
 * ProPlan.html is fully self-contained (core + xlsx inlined), so that file://
 * link opens the real app in any browser — no server needed. (PNG/PDF export
 * loads two scripts from a CDN, so those need internet.) */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function browserLink() {
  return pathToFileURL(resolve(ROOT, 'ProPlan.html')).href;   // percent-encodes anything odd in the path
}

export function printLinks({ app = false } = {}) {
  const out = ['', '  Open in your browser (paste this link):', `    ${browserLink()}`];
  if (app) {
    const bundle = resolve(ROOT, 'src-tauri/target/release/bundle');
    const appPath = resolve(bundle, 'macos/ProPlan.app');
    const dmgDir = resolve(bundle, 'dmg');
    const dmg = existsSync(dmgDir) ? readdirSync(dmgDir).filter(f => f.endsWith('.dmg')).sort().pop() : null;
    if (existsSync(appPath)) out.push('', '  Mac app:', `    ${appPath}`, `    open "${appPath}"`);
    if (dmg) out.push('', '  Installer:', `    ${resolve(dmgDir, dmg)}`, `    open "${resolve(dmgDir, dmg)}"`);
  }
  out.push('');
  console.log(out.join('\n'));
}

// Run directly (`npm run link`, or the tail of `npm run app:build`): print everything.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) printLinks({ app: true });
