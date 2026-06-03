/* ProPlan core — pure logic extracted from Carpati Timeline.html.
 *
 * Everything in this module is DOM-free, localStorage-free, and side-effect
 * free (with one obvious exception: the autoSequence + enforcePhaseOrder +
 * renumberWPs family mutate the `state` object you pass in — that's their
 * job).
 *
 * The HTML app loads this via <script type="module"> and re-attaches the
 * exports to window so the rest of the inline script can keep referencing
 * them as globals. Tests import them natively.
 *
 * The single-file release inlines the contents of this file back into the
 * HTML via scripts/build.mjs.
 */

/* ====================== Constants ====================== */

export const WEEKS_PER_MONTH = 4;
export const PHASE_ORDER = { PRS: 0, DP: 1, DO: 2, FP: 3 };
export const PHASE_CODES_IN_ORDER = ["PRS", "DP", "DO", "FP"];
export const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const PROPOSAL_HOURS_PER_WEEK = 40;

export const TYPES = {
  work:      { label: "Work",      bar: "#bfdbfe", border: "#1d4ed8" },
  buffer:    { label: "Buffer",    bar: "#fde68a", border: "#b45309" },
  leadtime:  { label: "Lead Time", bar: "#ddd6fe", border: "#6d28d9" },
  review:    { label: "Review",    bar: "#bbf7d0", border: "#15803d" },
  milestone: { label: "Milestone", bar: "#fbbf24", border: "#b45309" },
};

/* ====================== ID generators ====================== */

export function lid() { return "l" + Math.random().toString(36).slice(2, 9); }
export function bid() { return "b" + Math.random().toString(36).slice(2, 9); }

/* ====================== Date / duration ====================== */

/* Parse either "YYYY-MM" (legacy) or "YYYY-MM-DD" into {y, m, d}.
   Defaults the day to 1 if absent. Defensive against empty / null input. */
export function parseYM(s) {
  const parts = String(s || "").split("-").map(Number);
  return { y: parts[0], m: parts[1], d: parts[2] || 1 };
}

/* Normalise a "YYYY-MM" string to "YYYY-MM-DD" for native <input type="date">. */
export function toDateInputValue(s) {
  if (!s) return "";
  const p = parseYM(s);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/* Inclusive list of {y, m} between startStr and endStr. Returns [] if endStr
   precedes startStr — callers can rely on .length to detect empty ranges. */
export function monthsBetween(startStr, endStr) {
  const s = parseYM(startStr), e = parseYM(endStr);
  const out = [];
  let y = s.y, m = s.m;
  while (y < e.y || (y === e.y && m <= e.m)) {
    out.push({ y, m });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* Effective duration in WEEKS = raw span × (1 + buffer/100). Milestones = 0. */
export function effSpan(b) {
  return b && b.type === "milestone" ? 0 : ((b && b.span) || 0) * (1 + ((b && b.buffer) || 0) / 100);
}

export function rnd1(n) { return Math.round(n * 10) / 10; }

export function fmtDur(wk) {
  const w = Math.round(wk * 10) / 10;
  const mo = Math.round(wk / WEEKS_PER_MONTH * 10) / 10;
  return `${w} wk · ≈${mo} mo`;
}

export function laneEffWeeks(lane) {
  return (lane.bars || []).reduce((sum, b) => sum + effSpan(b), 0);
}

/* ====================== WP / lane code ====================== */

/* Strip the "WP <n> — " prefix from a lane code, returning just the name. */
export function wpNameOnly(code) {
  const s = (code || "").trim();
  const m = s.match(/^WP\s*\d+\s*(?:[—\-:]\s*)?(.*)$/i);
  return (m ? m[1] : s).trim();
}

/* Mutate every lane.code so they read "WP 1 — Name", "WP 2 — Name", … in
   display order. Preserves whatever follows the existing prefix. */
export function renumberWPs(state) {
  if (!state || !Array.isArray(state.lanes)) return;
  state.lanes.forEach((lane, i) => {
    const n = i + 1;
    const name = wpNameOnly(lane.code) || "New work package";
    lane.code = `WP ${n} — ${name}`;
  });
}

/* ====================== State helpers ====================== */

/* Fill in missing fields after load/import. Tolerates partial data. */
export function normaliseState(state) {
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) {
      if (!Array.isArray(bar.dependsOn)) bar.dependsOn = [];
      if (typeof bar.buffer !== "number" || bar.buffer < 0) bar.buffer = 10;
    }
  }
  if (state.activePhase === undefined) state.activePhase = null;
}

/* v3 → v4 migration: spans were measured in months; v4 measures in weeks. */
export function spansToWeeks(state) {
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) {
      if (bar.type === "milestone") { bar.span = 0; continue; }
      bar.span = Math.max(1, Math.round((bar.span || 1) * WEEKS_PER_MONTH));
    }
  }
}

/* Build a barId → {laneIdx, lane, bar} lookup map. O(n+m). */
export function buildBarMap(state) {
  const map = {};
  (state.lanes || []).forEach((lane, laneIdx) => {
    (lane.bars || []).forEach(bar => { map[bar.id] = { laneIdx, lane, bar }; });
  });
  return map;
}

/* ====================== Phase logic ====================== */

/* A "bleeding" task starts in one phase and extends into a later one
   (declared via phaseEnd). */
export function isBleedingBar(bar) {
  return !!(bar && bar.phase && bar.phaseEnd
            && PHASE_ORDER.hasOwnProperty(bar.phase)
            && PHASE_ORDER.hasOwnProperty(bar.phaseEnd)
            && PHASE_ORDER[bar.phaseEnd] > PHASE_ORDER[bar.phase]);
}

/* All phase codes a bar covers, in order. Untagged bar → []. */
export function phaseSpanCodes(bar) {
  if (!bar || !bar.phase || !PHASE_ORDER.hasOwnProperty(bar.phase)) return [];
  const sIdx = PHASE_ORDER[bar.phase];
  const endCode = (bar.phaseEnd && PHASE_ORDER.hasOwnProperty(bar.phaseEnd) && PHASE_ORDER[bar.phaseEnd] >= sIdx)
    ? bar.phaseEnd : bar.phase;
  const eIdx = PHASE_ORDER[endCode];
  return PHASE_CODES_IN_ORDER.slice(sIdx, eIdx + 1);
}

/* Visual start..end range of each phase across the whole project.
 * Rules:
 *  - Milestones are EXCLUDED (point markers don't drag the range out).
 *  - Bleeding tasks: start contributes only to start-phase, end only to phaseEnd.
 *  - Untagged tasks ignored.
 *  - extendsPhase bars contribute their START to b.phase only (their end is exempted from the gate).
 *    Implemented here by NOT skipping them — same as the original. The end-gate
 *    exemption is enforced in enforcePhaseOrder.
 */
export function computePhaseRanges(state) {
  const ranges = {};
  for (const lane of state.lanes || []) {
    for (const b of lane.bars || []) {
      if (!b.phase || !PHASE_ORDER.hasOwnProperty(b.phase)) continue;
      if (b.type === "milestone") continue;
      const start = b.startIdx;
      const end = b.startIdx + effSpan(b) / WEEKS_PER_MONTH;
      const gatePhase = isBleedingBar(b) ? b.phaseEnd : b.phase;
      const rS = ranges[b.phase] || (ranges[b.phase] = {});
      if (rS.start === undefined || start < rS.start) rS.start = start;
      const rE = ranges[gatePhase] || (ranges[gatePhase] = {});
      if (rE.end === undefined || end > rE.end) rE.end = end;
    }
  }
  for (const code of Object.keys(ranges)) {
    const r = ranges[code];
    if (r.start === undefined) r.start = r.end;
    if (r.end === undefined) r.end = r.start;
  }
  return ranges;
}

/* Phase-closure gate at the END of every phase. Returned objects have no
   colour — callers (the HTML renderer) enrich them with sopPhase()-derived
   accent/bg colours before drawing. The final phase gets a "Project close"
   gate labelled "END". */
export function computePhaseGates(phaseRanges, presentPhases) {
  const gates = [];
  for (let i = 0; i < presentPhases.length; i++) {
    const code = presentPhases[i];
    const r = phaseRanges[code];
    if (!r || r.end === undefined) continue;
    const isLast = (i === presentPhases.length - 1);
    gates.push({
      id: `_gate_${code}`,
      type: "gate",
      startIdx: r.end,
      span: 0,
      label: isLast ? "Project close" : `${code} closure`,
      _gateCode: isLast ? "END" : code,
    });
  }
  return gates;
}

/* Strict cross-phase ordering. Two passes:
 *   - START-SNAP: a bar starts no earlier than the previous phase's gate.
 *     The bar's STARTING phase (b.phase) drives this — a bleeding DP→DO
 *     task is held by PRS's gate, not DP's.
 *   - END-GATE: the cumulativeMaxEnd that the NEXT phase respects.
 *     - Plain task: contributes to b.phase.
 *     - Bleed (phase=X, phaseEnd=Y): contributes to Y (so the bleed's tail
 *       formally lives in Y, not X — Y is the gate that hangs on it).
 *     - extendsPhase: never contributes (long-running tail exempt from gating).
 * Mutates state.lanes[*].bars[*].startIdx.
 */
export function enforcePhaseOrder(state) {
  let cumulativeMaxEnd = 0;
  for (const phase of PHASE_CODES_IN_ORDER) {
    let phaseMaxEnd = cumulativeMaxEnd;
    for (const lane of state.lanes || []) {
      for (const b of lane.bars || []) {
        if (b.phase === phase && b.startIdx < cumulativeMaxEnd) {
          b.startIdx = Math.ceil(cumulativeMaxEnd * WEEKS_PER_MONTH) / WEEKS_PER_MONTH;
        }
        if (b.extendsPhase) continue;
        const gatePhase = (b.phaseEnd
                           && PHASE_ORDER.hasOwnProperty(b.phaseEnd)
                           && PHASE_ORDER[b.phaseEnd] > PHASE_ORDER[b.phase])
                          ? b.phaseEnd : b.phase;
        if (gatePhase !== phase) continue;
        const end = b.startIdx + (b.type === "milestone" ? 0 : effSpan(b) / WEEKS_PER_MONTH);
        if (end > phaseMaxEnd) phaseMaxEnd = end;
      }
    }
    cumulativeMaxEnd = phaseMaxEnd;
  }
}

/* ====================== Dependency / sequence ====================== */

/* Kahn's algorithm. Returns barIds in topological order or null on cycle. */
export function topoOrder(map) {
  const ids = Object.keys(map);
  const inDeg = {}; const succ = {};
  for (const id of ids) { inDeg[id] = 0; succ[id] = []; }
  for (const id of ids) {
    for (const pred of (map[id].bar.dependsOn || [])) {
      if (!(pred in inDeg)) continue;
      inDeg[id]++; succ[pred].push(id);
    }
  }
  const queue = ids.filter(i => inDeg[i] === 0);
  const out = [];
  while (queue.length) {
    const cur = queue.shift(); out.push(cur);
    for (const s of succ[cur]) { inDeg[s]--; if (inDeg[s] === 0) queue.push(s); }
  }
  if (out.length !== ids.length) return null;
  return out;
}

/* Would adding predId → targetId create a cycle? Walks targetId's ancestor
   chain via map[*].bar.dependsOn and checks for predId. */
export function createsCycle(targetId, predId, map) {
  const visited = new Set(); const stack = [predId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === targetId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const entry = map[cur]; if (!entry) continue;
    for (const p of (entry.bar.dependsOn || [])) stack.push(p);
  }
  return false;
}

/* Auto-sequence: place every bar at its earliest legal position given its
 * predecessors and phase-gate constraints.
 *
 * Algorithm: fixpoint loop of (topoPass + enforcePhaseOrder).
 *   - First pass (ratchet=false): reset each bar to max(pred end) — gives
 *     tightest layout from scratch.
 *   - Subsequent passes (ratchet=true): bars can only move FORWARD. Needed
 *     because enforcePhaseOrder pushes some predecessors forward to clear an
 *     earlier phase's gate, and their successors must then re-place against
 *     the new (later) end. Without ratchet, a non-ratchet pass would revert
 *     the predecessor to its raw pred-end and successors would oscillate.
 *
 * Returns { ok, iterations, error? }. Mutates state on success.
 *
 * NOTE: deliberately does NOT call any renderer or alert(). Caller handles UI.
 */
export function autoSequence(state) {
  const map = buildBarMap(state);
  const order = topoOrder(map);
  if (!order) return { ok: false, iterations: 0, error: "Dependency cycle detected — cannot auto-sequence." };

  const topoPass = (ratchet) => {
    for (const barId of order) {
      const entry = map[barId]; if (!entry) continue;
      const bar = entry.bar;
      let earliest = ratchet ? bar.startIdx : 0;
      for (const predId of (bar.dependsOn || [])) {
        const p = map[predId]; if (!p) continue;
        const pe = p.bar.type === "milestone"
          ? p.bar.startIdx
          : p.bar.startIdx + effSpan(p.bar) / WEEKS_PER_MONTH;
        if (pe > earliest) earliest = pe;
      }
      bar.startIdx = earliest;
      if (bar.type !== "milestone" && (!bar.span || bar.span <= 0)) bar.span = 1;
    }
  };
  const snapshot = () => order.map(id => map[id] && map[id].bar.startIdx).join(",");

  topoPass(false);
  enforcePhaseOrder(state);
  let prev = snapshot();
  let iter = 0;
  for (; iter < 16; iter++) {
    topoPass(true);
    enforcePhaseOrder(state);
    const cur = snapshot();
    if (cur === prev) break;
    prev = cur;
  }
  return { ok: true, iterations: iter + 1 };
}

/* ====================== Bar packing ====================== */

/* Greedy first-fit row packing for stacking overlapping bars.
 * - `colW` (px-per-month) lets the packer reserve horizontal room for the
 *   external label of bars that are too narrow to contain their own label
 *   text. Pass 0 to skip label-aware packing.
 * - `opts.milestonesAtBottom`: when true, pack non-milestone bars into top
 *   rows, then milestones below them.
 * Returns { rowByBarId, totalRows }.
 */
export function packLaneRows(bars, colW = 0, opts = {}) {
  const charW = 6.5;
  const milestonesAtBottom = !!opts.milestonesAtBottom;

  const makeItem = (b) => {
    const label = b.label || "";
    const start = b.startIdx;
    let dur, labelExtPx;
    if (b.type === "milestone" || b.type === "gate") {
      dur = 0;
      const isGate = b.type === "gate";
      labelExtPx = (isGate ? 11 : 10) + 6 + label.length * charW + 8;
    } else {
      dur = Math.max(0.25, effSpan(b) / WEEKS_PER_MONTH);
      const barWidthPx = dur * colW;
      const estLabelW = label.length * charW + 24;
      labelExtPx = (colW > 0 && barWidthPx < estLabelW) ? (8 + label.length * charW + 8) : 0;
    }
    const labelExtMonths = colW > 0 ? labelExtPx / colW : 0;
    return { id: b.id, type: b.type, start, end: start + dur + labelExtMonths };
  };
  const sortFn = (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start);

  const rowByBarId = {};
  let totalRows = 0;

  function packInto(items, startingRow) {
    const rows = [];
    for (const it of items) {
      let r = 0;
      while (r < rows.length && rows[r].some(s => s.start < it.end && it.start < s.end)) r++;
      if (r === rows.length) rows.push([]);
      rows[r].push({ start: it.start, end: it.end });
      rowByBarId[it.id] = startingRow + r;
    }
    return rows.length;
  }

  if (milestonesAtBottom) {
    const barItems = bars.filter(b => b.type !== "milestone").map(makeItem).sort(sortFn);
    const msItems  = bars.filter(b => b.type === "milestone").map(makeItem).sort(sortFn);
    const barRows = packInto(barItems, 0);
    const msRows  = packInto(msItems, barRows);
    totalRows = barRows + msRows;
  } else {
    const items = bars.map(makeItem).sort(sortFn);
    totalRows = packInto(items, 0);
  }
  return { rowByBarId, totalRows: Math.max(1, totalRows) };
}

/* ====================== Proposal hours ====================== */

/* Should this bar contribute hours to the Proposal Timeline rollup?
 * - Milestones never contribute.
 * - Leadtime contributes only when includeLeadtime is true.
 * - Everything else contributes.
 */
export function proposalBarCountsForHours(b, { includeLeadtime = true } = {}) {
  if (!b || b.type === "milestone") return false;
  if (b.type === "leadtime" && !includeLeadtime) return false;
  return true;
}

/* Distribute a bar's hours across calendar months.
 * Returns an Array(numMonths) of hour values.
 *
 * Inputs:
 *   - b: the bar
 *   - opts.numMonths: total month columns in the rollup
 *   - opts.startMonthOffset: how many calendar months separate the project
 *     start from the rollup's month-0 (default 0 — rollup starts at project
 *     start). When the rollup pads with year-prefix months, pass the offset
 *     in WHOLE months: e.g. project starts in May year1 but rollup column 0
 *     is Jan year1 → startMonthOffset = 4.
 *   - opts.hoursPerWeek (default 40)
 *   - opts.includeLeadtime (default true)
 *
 * The bar's startIdx is in PROJECT months (1 month = 4 weeks in the data
 * model). We add startMonthOffset to map it onto the rollup's column space.
 * Time within each month is prorated by fractional overlap.
 */
export function barHoursDist(b, {
  numMonths,
  startMonthOffset = 0,
  hoursPerWeek = PROPOSAL_HOURS_PER_WEEK,
  includeLeadtime = true,
} = {}) {
  const dist = new Array(numMonths).fill(0);
  if (!proposalBarCountsForHours(b, { includeLeadtime })) return dist;
  const effMonths = effSpan(b) / WEEKS_PER_MONTH;
  const cs = b.startIdx + startMonthOffset;
  const ce = cs + effMonths;
  const firstM = Math.max(0, Math.floor(cs));
  const lastM = Math.min(numMonths - 1, Math.ceil(ce) - 1);
  for (let m = firstM; m <= lastM; m++) {
    const len = Math.max(0, Math.min(m + 1, ce) - Math.max(m, cs));
    const h = len * WEEKS_PER_MONTH * hoursPerWeek;
    if (h > 0) dist[m] += h;
  }
  return dist;
}
