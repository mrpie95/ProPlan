#!/usr/bin/env node
/* Single-file release builder.
 *
 * The dev HTML loads src/proplan-core.mjs via `<script type="module">`, which
 * needs a local server (CORS blocks file:// modules). For sharing or hosting
 * the HTML on its own, this script inlines the module into the script tag so
 * the result is a true single-file artifact that runs from file://.
 *
 * Usage:  node scripts/build.mjs
 * Output: dist/Carpati Timeline.html
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const HTML_IN = resolve(ROOT, 'Carpati Timeline.html');
const MODULE_IN = resolve(ROOT, 'src', 'proplan-core.mjs');
const DIST_DIR = resolve(ROOT, 'dist');
const HTML_OUT = resolve(DIST_DIR, 'Carpati Timeline.html');

if (!existsSync(HTML_IN)) {
  console.error(`Missing input HTML: ${HTML_IN}`);
  process.exit(1);
}
if (!existsSync(MODULE_IN)) {
  console.error(`Missing input module: ${MODULE_IN}`);
  process.exit(1);
}

const html = readFileSync(HTML_IN, 'utf8');
const moduleSrc = readFileSync(MODULE_IN, 'utf8');

// Strip top-level `export ` keywords. The module body is otherwise plain JS
// (no top-level imports, no dynamic export forms). If we ever add those,
// revisit this.
const inlined = moduleSrc.replace(/^export\s+/gm, '');

// In the bundled output the module is no longer a real ESM file: the inline
// script ran via `import * as Core` and then destructured Core. We need to:
//   1. Drop the `import` line.
//   2. Inline the module body so its top-level declarations are in scope.
//   3. Replace the `import * as Core from ...` + `const {...} = Core; Object.assign(window, Core)`
//      block with the inlined module followed by a hand-built Core namespace.
//
// The IDs of the exports must match what the inline script destructures.

const EXPORT_NAMES = [
  'WEEKS_PER_MONTH', 'PHASE_ORDER', 'PHASE_CODES_IN_ORDER', 'MONTH_NAMES',
  'PROPOSAL_HOURS_PER_WEEK', 'TYPES',
  'lid', 'bid',
  'parseYM', 'toDateInputValue', 'monthsBetween',
  'effSpan', 'rnd1', 'fmtDur', 'laneEffWeeks',
  'wpNameOnly', 'renumberWPs',
  'normaliseState', 'spansToWeeks', 'buildBarMap',
  'isBleedingBar', 'phaseSpanCodes',
  'computePhaseRanges', 'computePhaseGates', 'enforcePhaseOrder',
  'topoOrder', 'createsCycle', 'autoSequence',
  'packLaneRows',
  'proposalBarCountsForHours', 'barHoursDist',
];

const coreNamespace = `const Core = { ${EXPORT_NAMES.join(', ')} };`;

const moduleEntry = "import * as Core from './src/proplan-core.mjs';";
if (!html.includes(moduleEntry)) {
  console.error(`Couldn't find the module-import line in the HTML:\n  ${moduleEntry}`);
  process.exit(1);
}

const replacement = `${inlined}\n${coreNamespace}\n`;
let out = html.replace(moduleEntry, replacement);

// Also drop the `type="module"` from the script tag so the bundled HTML is a
// regular inline script with everything in one scope.
out = out.replace('<script type="module">', '<script>');

mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(HTML_OUT, out);

const sizeMb = (out.length / 1024 / 1024).toFixed(2);
console.log(`✓ Built ${HTML_OUT} (${sizeMb} MB)`);
