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

/* Names that the HTML defines its own thin wrapper for (passing the global
   `state` etc.). When inlined into the same scope, the wrapper's function
   declaration would be hoisted and OVERRIDE the module's same-name
   declaration. The Core namespace would then capture the wrapper instead of
   the pure function, and any wrapper that calls `Core.xxx(state)` would
   stack-overflow.
   Fix: rename ALL references to these inside the module body to a `_core_`
   prefix, then build the Core namespace using shorthand-with-rename. */
const CONFLICTS = [
  'renumberWPs',
  'autoSequence',
  'buildBarMap',
  'enforcePhaseOrder',
  'computePhaseRanges',
  'computePhaseGates',
  'proposalBarCountsForHours',
];

let html = readFileSync(HTML_PATH, 'utf8');
const moduleSrc = readFileSync(MODULE_PATH, 'utf8');

// Strip `export ` keywords so the module body becomes valid in a non-module
// <script>. We don't have top-level `import` statements in the module.
let stripped = moduleSrc.replace(/^export\s+/gm, '').trimEnd();

// Prefix every reference to a CONFLICTS name with `_core_` so they don't
// collide with the HTML's wrapper functions of the same name. \b ensures we
// don't rename substrings of unrelated identifiers.
for (const name of CONFLICTS) {
  stripped = stripped.replace(new RegExp(`\\b${name}\\b`, 'g'), `_core_${name}`);
}

// Build the Core namespace. Conflicting names use shorthand-with-rename so
// callers can still do `Core.renumberWPs(state)` and reach the renamed impl.
const namespaceEntries = EXPORT_NAMES.map(name =>
  CONFLICTS.includes(name) ? `${name}: _core_${name}` : name
);
const block = [
  BEGIN,
  stripped,
  `const Core = { ${namespaceEntries.join(', ')} };`,
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
  // The dev HTML destructures Core into bare names with `const { ... } = Core;`.
  // After inlining, those names ARE already top-level consts (from the module
  // body), so the destructure would re-declare them → SyntaxError. Strip it.
  html = html.replace(/const \{[^}]*\} = Core;\n?/, '');
  // The dev HTML also does `Object.assign(window, Core)` to expose every
  // export on window. AFTER inlining that overwrites the hoisted wrapper
  // functions on window with the renamed module impls, so bare-name calls
  // skip the wrappers and pass no state — crash on `state.lanes`. Swap it
  // for an inert assignment that still exposes Core for debugging.
  html = html.replace(/Object\.assign\(window, Core\);/, 'window.Core = Core;');
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
