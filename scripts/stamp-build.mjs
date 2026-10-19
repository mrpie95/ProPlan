/* Build tracking, used by scripts/build.mjs.
 *
 * stampBuild(html) -> html with a fresh `const BUILD_INFO = {...}` block
 * between the BUILD_INFO marker comments (inserted right after the END
 * INLINED proplan-core.mjs marker the first time), and appends the build to
 * the committed build-info.json ({lastBuild, history[]}, capped).
 * package.json "version" is the single source of truth; the Tauri files are
 * synced from it first (scripts/sync-version.mjs).
 *
 *   BUILD_TESTS=1 npm run build   also records the passing-test count.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { makeBuildEntry, appendBuildHistory, nextBuildNumber, formatCommit } from '../src/proplan-core.mjs';
import { syncVersion } from './sync-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INFO_PATH = resolve(ROOT, 'build-info.json');
export const BI_BEGIN = '// === BEGIN BUILD_INFO ===';
export const BI_END = '// === END BUILD_INFO ===';
const CORE_END = '// === END INLINED proplan-core.mjs ===';

const git = (args) => { try { return execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };

function readInfo() {
  try { return JSON.parse(readFileSync(INFO_PATH, 'utf8')); } catch { return { lastBuild: 0, history: [] }; }
}
function countPassingTests() {
  const r = spawnSync('npx', ['vitest', 'run', '--reporter=json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).numPassedTests; } catch { return undefined; }
}

export function stampBuild(html) {
  const { version } = syncVersion(ROOT);
  const info = readInfo();
  // Dirty = anything uncommitted other than build-info.json itself.
  const dirty = git('status --porcelain').split('\n').some(l => l.trim() && !l.endsWith('build-info.json'));
  const entry = makeBuildEntry({
    build: nextBuildNumber(info),
    version,
    date: new Date().toISOString(),
    commit: git('rev-parse --short HEAD'),
    dirty,
    branch: git('rev-parse --abbrev-ref HEAD'),
    testsPassing: process.env.BUILD_TESTS ? countPassingTests() : undefined,
  });
  const history = appendBuildHistory(info.history, entry);
  writeFileSync(INFO_PATH, JSON.stringify({ lastBuild: entry.build, history }, null, 2) + '\n');

  // Embed the newest builds (the About dialog shows ~10) alongside the current one.
  const recent = history.slice(-10).reverse();
  const block = [
    BI_BEGIN,
    `const BUILD_INFO = ${JSON.stringify({ ...entry, recent })};`,
    BI_END,
  ].join('\n');
  const a = html.indexOf(BI_BEGIN), b = html.indexOf(BI_END);
  if (a >= 0 && b > a) html = html.slice(0, a) + block + html.slice(b + BI_END.length);
  else if (html.includes(CORE_END)) html = html.replace(CORE_END, CORE_END + '\n' + block);
  else throw new Error('stampBuild: no BUILD_INFO markers and no inlined-core END marker');
  console.log(`✓ Stamped build #${entry.build} — v${version} @ ${formatCommit(entry.commit, entry.dirty)} (${entry.branch})`);
  return html;
}
