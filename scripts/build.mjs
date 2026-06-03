#!/usr/bin/env node
/* Re-inline src/proplan-core.mjs into Carpati Timeline.html.
 *
 * Workflow:
 *   1. Edit src/proplan-core.mjs (logic) and/or Carpati Timeline.html (UI).
 *   2. Run `npm run build`.
 *   3. The HTML's inlined module block is replaced with a fresh build.
 *
 * The canonical HTML is the inlined one — it runs from file:// without a
 * server. The .mjs is the source of truth for testing.
 *
 * The block to be replaced is delimited by these markers:
 *
 *   // === BEGIN INLINED proplan-core.mjs ===
 *   ... module body ...
 *   const Core = { ... };
 *   // === END INLINED proplan-core.mjs ===
 *
 * On a fresh dev HTML that still has `import * as Core from './src/proplan-core.mjs';`
 * we replace THAT line with the marker block. Subsequent runs replace
 * everything between the markers.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const HTML_PATH = resolve(ROOT, 'Carpati Timeline.html');
const MODULE_PATH = resolve(ROOT, 'src', 'proplan-core.mjs');

const BEGIN = '// === BEGIN INLINED proplan-core.mjs ===';
const END = '// === END INLINED proplan-core.mjs ===';

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

let html = readFileSync(HTML_PATH, 'utf8');
const moduleSrc = readFileSync(MODULE_PATH, 'utf8');

// Strip `export ` keywords so the module body becomes valid in a non-module
// <script>. We don't have top-level `import` statements in the module.
const stripped = moduleSrc.replace(/^export\s+/gm, '').trimEnd();

const block = [
  BEGIN,
  stripped,
  `const Core = { ${EXPORT_NAMES.join(', ')} };`,
  END,
].join('\n');

const hasMarkers = html.includes(BEGIN) && html.includes(END);
const moduleImportLine = "import * as Core from './src/proplan-core.mjs';";

if (hasMarkers) {
  const before = html.slice(0, html.indexOf(BEGIN));
  const after = html.slice(html.indexOf(END) + END.length);
  html = before + block + after;
  console.log('✓ Replaced existing inlined block.');
} else if (html.includes(moduleImportLine)) {
  html = html.replace(moduleImportLine, block);
  // Switch the script tag from module → regular so the inlined body works
  // in a top-level scope.
  html = html.replace('<script type="module">', '<script>');
  console.log('✓ Converted dev HTML (module import) to inlined form.');
} else {
  console.error('✗ Could not find inlined-block markers OR the module import line.');
  console.error(`  Expected one of:`);
  console.error(`    ${BEGIN}\n    ${END}`);
  console.error(`  or:`);
  console.error(`    ${moduleImportLine}`);
  process.exit(1);
}

writeFileSync(HTML_PATH, html);
const sizeMb = (html.length / 1024 / 1024).toFixed(2);
console.log(`✓ Wrote ${HTML_PATH} (${sizeMb} MB)`);
