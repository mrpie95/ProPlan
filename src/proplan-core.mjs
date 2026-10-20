/* ProPlan core — pure logic extracted from ProPlan.html.
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

/* ====================== Processes ======================
   A Process describes the phase model a project runs: ordered phases (code,
   name, colour, optional reference content), gate semantics, and the
   reference doc the Process tab renders. Each project picks one via
   state.processId; every phase function reads it through getProcess(state).

   Built-ins: "sop18" (PRS → DP → DO → FP), "stagegate" (SCP → DEV → LCH) and
   "none" (zero phases — phase tags are ignored, not deleted). User-defined
   processes go through registerProcess() and persist via
   serializeCustomProcesses() / loadCustomProcesses() (the HTML stores them
   under localStorage "proplan.processes"; there is no editor UI yet).

   A bar/lane/track phase code the active process doesn't know is DORMANT:
   every phase function treats it like an untagged bar, but the tag stays in
   state so switching back restores it. */

export const DEFAULT_PROCESS_ID = "sop18";

const PHASE_CODE_RE = /^[A-Za-z0-9_-]{1,8}$/;
const PROCESS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_PHASE_CODES = new Set(["END", "_closed", "_none"]);
const DEFAULT_GATES = Object.freeze({ enforce: true, label: "{code} closure", finalLabel: "Project close", finalCode: "END" });
/* Fallback colours (cycled by index) for custom phases that omit `color`. */
const DEFAULT_PHASE_COLORS = [
  { bg: "#fee2e2", accent: "#ef4444", text: "#7f1d1d" },
  { bg: "#dcfce7", accent: "#22c55e", text: "#14532d" },
  { bg: "#dbeafe", accent: "#3b82f6", text: "#1e3a8a" },
  { bg: "#f3e8ff", accent: "#a855f7", text: "#581c87" },
  { bg: "#fef3c7", accent: "#d97706", text: "#78350f" },
  { bg: "#cffafe", accent: "#0891b2", text: "#164e63" },
];

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isStr(v) { return typeof v === "string"; }
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const optStr = (v) => (isStr(v) ? v : "");
const strList = (v) => (Array.isArray(v) ? v.filter(isStr) : []);

/* Validate + normalise a process definition. Returns { ok, errors, process }
   (process only when ok). `opts.builtin` allows a zero-phase process and the
   built-in ids. Never throws on bad input. */
export function validateProcessDef(def, opts = {}) {
  const errors = [];
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    return { ok: false, errors: ["Process definition must be an object."] };
  }
  if (!isStr(def.id) || !PROCESS_ID_RE.test(def.id)) errors.push("id must be 1–32 chars: lowercase letters, digits, - or _ (starting with a letter/digit).");
  if (!isStr(def.name) || !def.name.trim()) errors.push("name is required.");
  if (!Array.isArray(def.phases)) errors.push("phases must be an array.");
  else if (!opts.builtin && def.phases.length === 0) errors.push("a process needs at least one phase.");

  const phases = [];
  const seen = new Set();
  (Array.isArray(def.phases) ? def.phases : []).forEach((p, i) => {
    const at = `phases[${i}]`;
    if (!p || typeof p !== "object") { errors.push(`${at} must be an object.`); return; }
    if (!isStr(p.code) || !PHASE_CODE_RE.test(p.code)) { errors.push(`${at}.code must be 1–8 chars of letters, digits, - or _.`); return; }
    if (RESERVED_PHASE_CODES.has(p.code)) errors.push(`${at}.code "${p.code}" is reserved.`);
    if (seen.has(p.code)) errors.push(`${at}.code "${p.code}" is duplicated.`);
    seen.add(p.code);
    if (!isStr(p.name) || !p.name.trim()) errors.push(`${at}.name is required.`);
    let color = DEFAULT_PHASE_COLORS[i % DEFAULT_PHASE_COLORS.length];
    if (p.color !== undefined) {
      const c = p.color;
      if (c && isStr(c.bg) && isStr(c.accent) && isStr(c.text)) color = { bg: c.bg, accent: c.accent, text: c.text };
      else errors.push(`${at}.color must be { bg, accent, text } strings.`);
    }
    const tasks = Array.isArray(p.tasks)
      ? p.tasks.filter(t => t && isStr(t.text)).map(t => ({
          num: t.num === undefined ? "" : String(t.num), text: t.text,
          ...(isStr(t.milestone) ? { milestone: t.milestone } : {}),
          ...(t.gate ? { gate: true } : {}), ...(t.review ? { review: true } : {}),
        }))
      : [];
    phases.push({
      code: p.code, name: optStr(p.name), summary: optStr(p.summary),
      num: p.num === undefined ? "" : String(p.num),
      color, purpose: optStr(p.purpose), deliverables: strList(p.deliverables), tasks,
    });
  });

  let gates = { ...DEFAULT_GATES };
  if (def.gates !== undefined) {
    const g = def.gates;
    if (!g || typeof g !== "object") errors.push("gates must be an object.");
    else {
      if (g.enforce !== undefined) { if (typeof g.enforce === "boolean") gates.enforce = g.enforce; else errors.push("gates.enforce must be boolean."); }
      for (const k of ["label", "finalLabel", "finalCode"]) {
        if (g[k] !== undefined) { if (isStr(g[k]) && g[k]) gates[k] = g[k]; else errors.push(`gates.${k} must be a non-empty string.`); }
      }
    }
  }
  let entry = null;
  if (def.entry != null) {
    if (isStr(def.entry.label)) entry = { label: def.entry.label, stages: strList(def.entry.stages) };
    else errors.push("entry must be { label, stages[] } or null.");
  }
  const exit = isStr(def.exit) && def.exit ? def.exit : null;
  const commonDeliverables = Array.isArray(def.commonDeliverables)
    ? def.commonDeliverables.filter(d => d && isStr(d.name)).map(d => ({ name: d.name, desc: optStr(d.desc) })) : [];
  const roles = Array.isArray(def.roles)
    ? def.roles.filter(r => r && isStr(r.code)).map(r => ({ code: r.code, desc: optStr(r.desc) })) : [];

  if (errors.length) return { ok: false, errors };
  const order = {};
  phases.forEach((p, i) => { order[p.code] = i; });
  const process = deepFreeze({
    id: def.id, name: def.name.trim(), description: optStr(def.description),
    builtin: !!opts.builtin, doc: optStr(def.doc), owner: optStr(def.owner), intro: optStr(def.intro),
    phases, codes: phases.map(p => p.code), order,
    gates, entry, exit, commonDeliverables, roles,
  });
  return { ok: true, errors: [], process };
}

const SOP18_DEF = {
  id: "sop18",
  name: "SOP-18 Product Development",
  description: "DEC's 4-phase gated hardware development process (PRS → DP → DO → FP). R&D drives; Quality signs each gate.",
  doc: "SOP-18 · v2 · 07-2025",
  owner: "MPI",
  intro: "DEC's 4-phase gated product development process. Every Cat. 3 New Hardware Product follows this. R&D drives; Quality signs each gate.",
  phases: [
    { code: "PRS", num: "100", name: "Product Requirements & Specifications",
      summary: "Requirements & specifications",
      color: { bg: "#fee2e2", accent: "#ef4444", text: "#7f1d1d" },
      purpose: "Establish a robust foundation by gathering and analysing user requirements; transform them into official product requirements and technical specifications. A gate blocks technical-spec work until user requirements are signed off.",
      deliverables: ["Project Plan", "General Product Description", "List of Applicable Standards", "WBSO Journal", "Risk Management Plan", "Product Specification", "Verification Plan", "Manufacturing Process Chain Requirements"],
      tasks: [
        { num: "101", text: "Kick-off — approved project proposal passed to the PL.", milestone: "Kick-off meeting successfully done" },
        { num: "110", text: "Define User Needs and Requirements." },
        { num: "120", text: "Gate — blocks technical specifications until user requirements are signed off.", gate: true },
        { num: "130", text: "Develop Technical Specification (measurable engineering specs)." },
        { num: "140", text: "Phase Review — all deliverables signed off.", milestone: "Project ready for Design Process phase", review: true }
      ]
    },
    { code: "DP", num: "200", name: "Design Process",
      summary: "Design, prototyping & testing",
      color: { bg: "#dcfce7", accent: "#22c55e", text: "#14532d" },
      purpose: "Iterative development and refinement of the product to meet defined specifications through prototyping, testing, analysis and continuous improvement.",
      deliverables: ["Material Safety Assessment", "List of Applicable Standards (updated)", "Bill of Materials", "Registration Plan", "Manufacturing Process Chain Validation Plan", "Manufacturing Process Chain Requirements (updated)", "ETI Testing Report"],
      tasks: [
        { num: "201", text: "Start Design Process — triggered by closure of PRS." },
        { num: "210", text: "Develop detailed designs/drawings." },
        { num: "220", text: "Design Manufacturing Process Chain." },
        { num: "230", text: "Pre-development Technical Review.", milestone: "Technical review of initial designs complete", review: true },
        { num: "240", text: "Iterative Development Activities." },
        { num: "250", text: "Introduce Manufacturing Process and Service Steps." },
        { num: "260", text: "Final Technical Review.", milestone: "Technical review of final designs complete", review: true },
        { num: "270", text: "Phase Review — all deliverables signed off.", review: true }
      ]
    },
    { code: "DO", num: "300", name: "Design Output",
      summary: "Verification & regulatory compliance",
      color: { bg: "#dbeafe", accent: "#3b82f6", text: "#1e3a8a" },
      purpose: "Finalise product design; verify against PRS specs and check regulatory compliance. Includes feedback loop back to PRS for validation.",
      deliverables: ["OQ Report", "Bill of Materials (final)", "Regulatory and Standards Documentation", "Verification Report"],
      tasks: [
        { num: "301", text: "Start Design Output — triggered by DP closure.", milestone: "Signed-off Production-Ready Documentation" },
        { num: "310", text: "Verify & Debug Component.", milestone: "Completion of Verification Report" },
        { num: "320", text: "Qualify Manufacturing Process Chain (OQ).", milestone: "Completed OQ Batch Report" },
        { num: "330", text: "Finalize Product — regulatory compliance checked; logged in SAP." },
        { num: "340", text: "Phase Review — all deliverables signed off.", milestone: "Project ready for Final Product phase", review: true }
      ]
    },
    { code: "FP", num: "400", name: "Final Product",
      summary: "Validation, launch & surveillance",
      color: { bg: "#f3e8ff", accent: "#a855f7", text: "#581c87" },
      purpose: "Validate equipment, processes, marketing material and final production batches; ready the product for launch and 3–6 month surveillance (QAT). Ownership transfers to Sales & Marketing during QAT.",
      deliverables: ["Market Readiness Documentation", "PQ Validation Report", "PDR Overview Report"],
      tasks: [
        { num: "401", text: "Start Final Product — triggered by DO closure." },
        { num: "405", text: "Validate Product Design.", milestone: "Product validated against Product Requirements" },
        { num: "410", text: "Validate Manufacturing & Service Process Chain (IQ/OQ/PQ)." },
        { num: "420", text: "Technical File Review." },
        { num: "425", text: "Finalize Marketing Authorization activities." },
        { num: "430", text: "Prepare deliverables for Qualification Ramp-up Review (QRR)." },
        { num: "435", text: "QRR — transfer ownership to Operations.", milestone: "Transfer to Operations achieved. Production started" },
        { num: "440", text: "Pre-Launch Review (PLR).", milestone: "Green-light for product shipment", review: true },
        { num: "450", text: "Phase Review — all deliverables signed off.", milestone: "Project ready for QAT step", review: true },
        { num: "460", text: "3–6 Month Product Surveillance (QAT) — monitor for issues post-launch." },
        { num: "499", text: "Close project.", milestone: "Project closed" }
      ]
    }
  ],
  gates: { enforce: true, label: "{code} closure", finalLabel: "Project close", finalCode: "END" },
  entry: { label: "Project Proposal", stages: ["Strategic Planning", "Feasibility"] },
  exit: "Release",
  commonDeliverables: [
    { name: "Project Diary", desc: "Preliminary info needed to define user needs and technical specs." },
    { name: "List of Deliverables (LoD)", desc: "All relevant project deliverables." },
    { name: "Phase Review Report", desc: "Approval of all deliverables in a phase." }
  ],
  roles: [
    { code: "PL", desc: "Project Lead — overall responsibility and authority. Drives the procedure." },
    { code: "PM", desc: "Product Manager — overall accountability." },
    { code: "QM", desc: "Quality Manager / Expert — trained in R&D processes; participates in Phase Review closure." },
    { code: "SME", desc: "Subject Matter Expert — domain knowledge for assigned tasks." },
    { code: "ME", desc: "Manufacturing Engineering — develops the manufacturing process." }
  ]
};

const STAGEGATE_DEF = {
  id: "stagegate",
  name: "Stage-Gate (3 phases)",
  description: "A lightweight three-stage gated process: Scope → Develop → Launch, with a go/no-go review at the end of each stage.",
  doc: "Stage-Gate · 3 phases",
  intro: "A generic stage-gate flow. Work in a stage is planned freely; the next stage only starts once the previous stage's gate review has passed.",
  phases: [
    { code: "SCP", num: "1", name: "Scope", summary: "Define the problem, case and plan",
      color: { bg: "#fef3c7", accent: "#d97706", text: "#78350f" },
      purpose: "Understand the need, size the opportunity and agree what will be built, by whom and by when.",
      deliverables: ["Business case", "Requirements brief", "Project plan and budget", "Risk log"],
      tasks: [
        { num: "1.1", text: "Kick-off — sponsor approves starting the project." },
        { num: "1.2", text: "Capture needs and success criteria." },
        { num: "1.3", text: "Draft scope, plan and budget." },
        { num: "1.4", text: "Gate 1 — go / no-go to Develop.", milestone: "Scope approved", gate: true, review: true }
      ] },
    { code: "DEV", num: "2", name: "Develop", summary: "Design, build and test",
      color: { bg: "#dbeafe", accent: "#2563eb", text: "#1e3a8a" },
      purpose: "Design and build the solution, test it against the agreed requirements and prepare for launch.",
      deliverables: ["Design / build artefacts", "Test report", "Launch readiness plan"],
      tasks: [
        { num: "2.1", text: "Design and build." },
        { num: "2.2", text: "Test against requirements." },
        { num: "2.3", text: "Prepare launch." },
        { num: "2.4", text: "Gate 2 — go / no-go to Launch.", milestone: "Solution ready to launch", gate: true, review: true }
      ] },
    { code: "LCH", num: "3", name: "Launch", summary: "Release and hand over",
      color: { bg: "#dcfce7", accent: "#16a34a", text: "#14532d" },
      purpose: "Release the result, hand it over to the owners and close the project with lessons learned.",
      deliverables: ["Release notes", "Handover documentation", "Post-project review"],
      tasks: [
        { num: "3.1", text: "Release." },
        { num: "3.2", text: "Hand over to operations." },
        { num: "3.3", text: "Close project.", milestone: "Project closed", review: true }
      ] }
  ],
  gates: { enforce: true, label: "{name} gate", finalLabel: "Project close", finalCode: "END" },
  entry: { label: "Idea", stages: ["Ideation"] },
  exit: "Operate",
  commonDeliverables: [
    { name: "Business case", desc: "Kept current at every gate." },
    { name: "Risk log", desc: "Reviewed at every gate." }
  ],
  roles: [
    { code: "Sponsor", desc: "Funds the project and decides at each gate." },
    { code: "Lead", desc: "Plans and drives the work between gates." }
  ]
};

const NO_PROCESS_DEF = {
  id: "none",
  name: "No process",
  description: "Free-form planning: no phases, gates or ordering rules. Existing phase tags are kept (dormant) so choosing a process again restores them.",
  phases: [],
  gates: { enforce: false, label: "{code} closure", finalLabel: "Project close", finalCode: "END" },
};

const PROCESS_REGISTRY = new Map();
function defineBuiltin(def) {
  const v = validateProcessDef(def, { builtin: true });
  if (!v.ok) throw new Error(`Invalid built-in process ${def && def.id}: ${v.errors.join("; ")}`);
  PROCESS_REGISTRY.set(v.process.id, v.process);
  return v.process;
}
export const SOP18_PROCESS = defineBuiltin(SOP18_DEF);
export const STAGE_GATE_PROCESS = defineBuiltin(STAGEGATE_DEF);
export const NO_PROCESS = defineBuiltin(NO_PROCESS_DEF);
const BUILTIN_PROCESS_IDS = new Set([SOP18_PROCESS.id, STAGE_GATE_PROCESS.id, NO_PROCESS.id]);

/* Register (or replace) a user-defined process. Built-in ids are protected. */
export function registerProcess(def) {
  const v = validateProcessDef(def);
  if (!v.ok) return v;
  if (BUILTIN_PROCESS_IDS.has(v.process.id)) {
    return { ok: false, errors: [`"${v.process.id}" is a built-in process id.`] };
  }
  PROCESS_REGISTRY.set(v.process.id, v.process);
  return v;
}
export function unregisterProcess(id) {
  if (BUILTIN_PROCESS_IDS.has(id)) return false;
  return PROCESS_REGISTRY.delete(id);
}
export function getProcessById(id) { return PROCESS_REGISTRY.get(id) || null; }
/* All processes, built-ins first (sop18, stagegate, none), then custom ones. */
export function listProcesses() {
  const all = [...PROCESS_REGISTRY.values()];
  const rank = (p) => (p.builtin ? 0 : 1);
  return all.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p);
}
/* Plain-JSON copy of a process definition (drops derived fields) — for
   persistence and for embedding in a project export (state.processDef). */
export function exportProcessDef(proc) {
  const p = getProcess(proc);
  return JSON.parse(JSON.stringify({
    id: p.id, name: p.name, description: p.description, doc: p.doc, owner: p.owner, intro: p.intro,
    phases: p.phases, gates: p.gates, entry: p.entry, exit: p.exit,
    commonDeliverables: p.commonDeliverables, roles: p.roles,
  }));
}
export function serializeCustomProcesses() {
  return listProcesses().filter(p => !p.builtin).map(exportProcessDef);
}
/* Register every valid def in an array (e.g. parsed from localStorage).
   Returns { loaded: [ids], rejected: [{ id, errors }] }; never throws. */
export function loadCustomProcesses(defs) {
  const out = { loaded: [], rejected: [] };
  if (!Array.isArray(defs)) return out;
  for (const d of defs) {
    const r = registerProcess(d);
    if (r.ok) out.loaded.push(r.process.id);
    else out.rejected.push({ id: d && d.id, errors: r.errors });
  }
  return out;
}

/* Resolve "the process" from whatever the caller has:
 *  - a Process object      → itself
 *  - a project state       → registry lookup of state.processId
 *                            (missing id → SOP-18; unknown id → NO_PROCESS)
 *  - undefined / anything  → SOP-18 (the historical behaviour) */
export function getProcess(x) {
  if (x && typeof x === "object") {
    if (Array.isArray(x.codes) && x.order && Array.isArray(x.phases)) return x;
    if (isStr(x.processId) && x.processId) return PROCESS_REGISTRY.get(x.processId) || NO_PROCESS;
  }
  return SOP18_PROCESS;
}
/* False when the state names a process this install doesn't know. */
export function isProcessResolved(state) {
  return !(state && isStr(state.processId) && state.processId && !PROCESS_REGISTRY.has(state.processId));
}
export function processPhase(proc, code) {
  const p = getProcess(proc);
  return hasOwn(p.order, code) ? p.phases[p.order[code]] : null;
}
export function processPhaseIndex(proc, code) {
  const p = getProcess(proc);
  return hasOwn(p.order, code) ? p.order[code] : -1;
}
/* Gate label from the process template. Tokens: {code}, {name}. */
export function gateLabel(proc, code, isLast) {
  const p = getProcess(proc);
  if (isLast) return p.gates.finalLabel;
  const ph = processPhase(p, code);
  return p.gates.label.replace(/\{code\}/g, code).replace(/\{name\}/g, ph ? ph.name : code);
}


export const TYPES = {
  work:      { label: "Work",      bar: "#bfdbfe", border: "#1d4ed8" },
  buffer:    { label: "Buffer",    bar: "#fde68a", border: "#b45309" },
  leadtime:  { label: "Lead Time", bar: "#ddd6fe", border: "#6d28d9" },
  review:    { label: "Review",    bar: "#bbf7d0", border: "#15803d" },
  ongoing:   { label: "Ongoing",   bar: "#cffafe", border: "#0891b2" },
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

/* Total project duration in WEEKS, derived from state.start..state.end.
   Used for "ongoing" bars (project lead, PM, etc.) that auto-span the whole
   project. */
export function projectSpanWeeks(state) {
  if (!state || !state.start || !state.end) return 0;
  return monthsBetween(state.start, state.end).length * WEEKS_PER_MONTH;
}

/* Force every "ongoing" bar to span from project start (startIdx=0) to the
   end of the LAST non-ongoing bar in the project. This matches the intent —
   the project lead / PM / continuous role runs until the actual work
   finishes, not until the manually-set state.end (which may be a calendar
   marker further out than where the real schedule lands).
   Falls back to projectSpanWeeks(state) when there are no real bars yet.
   Called from saveState() so the data stays in sync as the user edits.
   Idempotent. */
export function syncOngoingBars(state) {
  if (!state || !Array.isArray(state.lanes)) return;
  // Find the last bar end across all non-ongoing bars (months from start).
  let lastEndMonths = 0;
  for (const lane of state.lanes) {
    for (const bar of lane.bars || []) {
      if (bar.type === "ongoing") continue;
      const end = (bar.startIdx || 0) + (bar.type === "milestone"
        ? 0
        : effSpan(bar) / WEEKS_PER_MONTH);
      if (end > lastEndMonths) lastEndMonths = end;
    }
  }
  const spanWeeks = lastEndMonths > 0
    ? lastEndMonths * WEEKS_PER_MONTH
    : projectSpanWeeks(state);
  for (const lane of state.lanes) {
    for (const bar of lane.bars || []) {
      if (bar.type === "ongoing") {
        bar.startIdx = 0;
        bar.span = spanWeeks;
      }
    }
  }
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

/* Effective CALENDAR duration in weeks = raw span × (1 + buffer/100).
   Milestones = 0. Ongoing bars use their stored span verbatim (it's already
   the full project span; a buffer on top would push them past project end).
   This is what the Timeline uses for layout — alloc% does NOT affect the
   calendar window, only the hours rollup. */
export function effSpan(b) {
  if (!b) return 0;
  if (b.type === "milestone") return 0;
  if (b.type === "ongoing") return b.span || 0;
  return (b.span || 0) * (1 + (b.buffer || 0) / 100);
}

/* Read a bar's time-allocation percentage. Defaults to 100 (full-time on the
   task during its calendar window). Clamped to [0, 100]. */
export function barAllocPct(b) {
  const a = b && b.alloc;
  if (typeof a !== "number" || a < 0) return 100;
  if (a > 100) return 100;
  return a;
}

/* Effective EFFORT in weeks = calendar weeks × alloc/100. This is what the
   Proposal Timeline hours rollup multiplies by 40 h/week. */
export function effortWeeks(b) {
  return effSpan(b) * barAllocPct(b) / 100;
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
  // Drop "(6 of 15)" / "6 of 15 tasks here" suffixes: older builds baked the split-WP note into the saved name when the legacy header was edited.
  return (m ? m[1] : s).replace(/(?:\s*\(?\d+ of \d+(?: tasks here)?\)?)+\s*$/i, "").trim();
}

/* Display form of a lane code: "WP 1 — Name" -> "WP1 — Name" (one WP format everywhere; stored code untouched). */
export function wpLabel(code) {
  return String(code || "").replace(/^\s*WP\s*(\d+)/i, "WP$1");
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

/* Track model (v5).
   Each track is a user-managed entry in state.tracks:
     {
       id,         // stable string id (system or user-generated)
       label,      // display name
       kind,       // "product" — phase-bound (the project's process phases),
                   // "continuous" — free-form, not phase-bound (PLE, Exploration)
       color: { bar, border },
       enabled,    // bool — whether the track is currently in use for this project
       activePhase // only for kind === "product": null | <phase code of state.processId> | "_closed"
     }

   System seeds (always present after migration, may be renamed/removed by user):
     - id "product"     → kind "product",     label "Product"
     - id "ple"         → kind "continuous",  label "PLE"
     - id "exploration" → kind "continuous",  label "Exploration"

   v4 had a fixed 3-track model and a single global state.activePhase. The v5
   migration enriches each existing track with kind/label/color and moves
   state.activePhase into the "product" track's activePhase. */

/* Built-in system track seeds. Used for fresh state + as fallback metadata
   when a track's fields are partially missing. The legacy "product",
   "exploration", "ple" ids are preserved so old data renders identically. */
export const SYSTEM_TRACK_SEEDS = [
  { id: "product",     label: "Product",     kind: "product",    color: { bar: "#e0f2fe", border: "#0369a1" }, enabled: true,  activePhase: null },
  { id: "exploration", label: "Exploration", kind: "continuous", color: { bar: "#fef3c7", border: "#b45309" }, enabled: false },
  { id: "ple",         label: "PLE",         kind: "continuous", color: { bar: "#f3e8ff", border: "#6b21a8" }, enabled: false },
];

/* Colour palette for new user-added product tracks. picked in order, then
   cycles. The first six are visually distinct on white. */
export const NEW_PRODUCT_COLOR_PALETTE = [
  { bar: "#e0f2fe", border: "#0369a1" },  // sky blue
  { bar: "#dcfce7", border: "#15803d" },  // green
  { bar: "#fee2e2", border: "#b91c1c" },  // red
  { bar: "#fef3c7", border: "#b45309" },  // amber
  { bar: "#ede9fe", border: "#6d28d9" },  // violet
  { bar: "#cffafe", border: "#0e7490" },  // teal
  { bar: "#fce7f3", border: "#be185d" },  // pink
  { bar: "#fee4d3", border: "#c2410c" },  // orange
];

/* ── Legacy compatibility shims ─────────────────────────────────────────
   The old TRACK_DEFAULTS / LANE_TRACKS constants are still imported by
   some call sites in the inlined HTML. Synthesize compatible views from
   the new model so existing code keeps working until those sites are
   migrated. */
export const LANE_TRACKS = SYSTEM_TRACK_SEEDS.map(t => t.id);
export const TRACK_DEFAULTS = Object.fromEntries(
  SYSTEM_TRACK_SEEDS.map(t => [t.id, {
    label: t.label,
    description: t.kind === "product"
      ? "Phase-bound product development (follows the project's process)."
      : "Continuous work — not phase-bound.",
    color: t.color,
    phaseBound: t.kind === "product",
    enabledByDefault: t.enabled,
  }])
);

/* ── Track lookups / queries ────────────────────────────────────────── */

/* List of track ids that are currently enabled for `state`. Falls back to
   ["product"] if state.tracks is missing/empty. */
export function enabledTracks(state) {
  if (!state || !Array.isArray(state.tracks)) return ["product"];
  const list = state.tracks.filter(t => t && t.enabled).map(t => t.id);
  return list.length ? list : ["product"];
}

/* Is `trackId` enabled for `state`? Always true for "product" when state has
   no track config (safe default for legacy data). */
export function isTrackEnabled(state, trackId) {
  if (!state || !Array.isArray(state.tracks)) return trackId === "product";
  const t = state.tracks.find(x => x && x.id === trackId);
  return t ? !!t.enabled : false;
}

/* All enabled product-kind tracks. Each has its own phase axis and own
   activePhase. */
export function getProductTracks(state) {
  if (!state || !Array.isArray(state.tracks)) return [];
  return state.tracks.filter(t => t && t.enabled && t.kind === "product");
}

/* All enabled continuous-kind tracks (PLE, Exploration, etc.). Not phase-bound. */
export function getContinuousTracks(state) {
  if (!state || !Array.isArray(state.tracks)) return [];
  return state.tracks.filter(t => t && t.enabled && t.kind === "continuous");
}

/* Full track record by id (whether enabled or not). null if not found. */
export function getTrackById(state, id) {
  if (!state || !Array.isArray(state.tracks) || !id) return null;
  return state.tracks.find(t => t && t.id === id) || null;
}

/* Read a product track's current activePhase. Returns null if the track
   doesn't exist or isn't a product. */
export function getTrackActivePhase(state, trackId) {
  const t = getTrackById(state, trackId);
  if (!t || t.kind !== "product") return null;
  return t.activePhase === undefined ? null : t.activePhase;
}

/* Set a product track's activePhase in place. No-op for non-product tracks. */
export function setTrackActivePhase(state, trackId, phase) {
  const t = getTrackById(state, trackId);
  if (!t || t.kind !== "product") return;
  t.activePhase = phase;
}

/* Pick a colour for a new user-added product. Walks NEW_PRODUCT_COLOR_PALETTE
   and returns the first entry whose border isn't already in use by an
   existing track. Falls back to a deterministic palette cycle. */
export function defaultColorForNewTrack(state) {
  const used = new Set(
    (state && Array.isArray(state.tracks) ? state.tracks : [])
      .map(t => t && t.color && t.color.border).filter(Boolean)
  );
  for (const c of NEW_PRODUCT_COLOR_PALETTE) {
    if (!used.has(c.border)) return { ...c };
  }
  const i = ((state && state.tracks ? state.tracks.length : 0)) % NEW_PRODUCT_COLOR_PALETTE.length;
  return { ...NEW_PRODUCT_COLOR_PALETTE[i] };
}

/* ── Track CRUD ─────────────────────────────────────────────────────── */

/* Generate a stable-ish id for a user-added track from its label, with a
   suffix to avoid collisions. */
function genTrackId(state, label) {
  const slug = String(label || "product").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "product";
  const existing = new Set((state.tracks || []).map(t => t && t.id));
  if (!existing.has(slug)) return slug;
  let n = 2;
  while (existing.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

/* Add a new product track. Returns the created track record. */
export function addProduct(state, { label = "New product", color } = {}) {
  if (!Array.isArray(state.tracks)) state.tracks = [];
  const track = {
    id: genTrackId(state, label),
    label,
    kind: "product",
    color: color || defaultColorForNewTrack(state),
    enabled: true,
    activePhase: null,
  };
  state.tracks.push(track);
  return track;
}

/* Remove a track. Any lanes/bars pointing at it have their .track field
   cleared (they fall back to inheritance). If the id matches a system seed,
   also record it in state.dismissedTrackSeeds so normaliseState doesn't
   re-add it on next load. Returns true if removed. */
export function removeTrack(state, id) {
  if (!Array.isArray(state.tracks)) return false;
  const idx = state.tracks.findIndex(t => t && t.id === id);
  if (idx === -1) return false;
  state.tracks.splice(idx, 1);
  // Suppress future re-seeding for system ids.
  if (SYSTEM_TRACK_SEEDS.some(s => s.id === id)) {
    if (!Array.isArray(state.dismissedTrackSeeds)) state.dismissedTrackSeeds = [];
    if (!state.dismissedTrackSeeds.includes(id)) state.dismissedTrackSeeds.push(id);
  }
  for (const lane of state.lanes || []) {
    if (lane.track === id) {
      // Reassign to the first remaining enabled product, or undefined.
      const fallback = (getProductTracks(state)[0] || {}).id;
      lane.track = fallback || undefined;
    }
    for (const bar of lane.bars || []) {
      if (bar.track === id) delete bar.track;
      if (Array.isArray(bar.tracks)) {
        const filtered = bar.tracks.filter(t => t !== id);
        if (filtered.length) bar.tracks = filtered;
        else delete bar.tracks;
      }
    }
  }
  return true;
}

/* Rename a track's label (id stays stable for data integrity). */
export function renameTrack(state, id, newLabel) {
  const t = getTrackById(state, id);
  if (!t) return false;
  t.label = String(newLabel || "").trim() || t.label;
  return true;
}

/* ── Disciplines ──────────────────────────────────────────────────────
   Disciplines tag the KIND of work (Acoustics, Mechanical, Electronics,
   Quality, Marketing, etc.) — an axis orthogonal to tracks (which tag
   the PROGRAMME the work belongs to). The same bar can be in product
   "Hearing aid v2", phase "DP", discipline "Acoustics".

   Schema:
     state.disciplines = [{ id, label, color }]
     bar.discipline    = "<discipline-id>" | undefined
     lane.discipline   = "<discipline-id>" | undefined  // default for the WP

   Effective discipline for a bar: bar.discipline ?? lane.discipline ?? null.
   Unlike tracks, there's no default — bars can be "uncategorised". */

export const NEW_DISCIPLINE_COLOR_PALETTE = [
  "#7c3aed",  // violet — Acoustics
  "#0369a1",  // sky    — Mechanical
  "#15803d",  // green  — Electronics
  "#b45309",  // amber  — Quality / Regulatory
  "#be185d",  // pink   — Marketing
  "#0e7490",  // teal   — Software
  "#c2410c",  // orange — Manufacturing
  "#4f46e5",  // indigo — Project Management
  "#65a30d",  // lime
  "#9333ea",  // purple
];

export function getDisciplines(state) {
  if (!state || !Array.isArray(state.disciplines)) return [];
  return state.disciplines.filter(d => d && typeof d.id === "string");
}

export function getDisciplineById(state, id) {
  if (!state || !Array.isArray(state.disciplines) || !id) return null;
  return state.disciplines.find(d => d && d.id === id) || null;
}

/* Pick a colour for a new discipline. Walks the palette, returns the first
   unused; cycles when all are taken. */
export function defaultColorForNewDiscipline(state) {
  const used = new Set(getDisciplines(state).map(d => d.color).filter(Boolean));
  for (const c of NEW_DISCIPLINE_COLOR_PALETTE) {
    if (!used.has(c)) return c;
  }
  const n = getDisciplines(state).length;
  return NEW_DISCIPLINE_COLOR_PALETTE[n % NEW_DISCIPLINE_COLOR_PALETTE.length];
}

function genDisciplineId(state, label) {
  const slug = String(label || "discipline").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "discipline";
  const existing = new Set(getDisciplines(state).map(d => d.id));
  if (!existing.has(slug)) return slug;
  let n = 2;
  while (existing.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

export function addDiscipline(state, { label = "New discipline", color } = {}) {
  if (!Array.isArray(state.disciplines)) state.disciplines = [];
  const d = {
    id: genDisciplineId(state, label),
    label,
    color: color || defaultColorForNewDiscipline(state),
  };
  state.disciplines.push(d);
  return d;
}

/* Remove a discipline. Any bar or lane pointing at it has its .discipline
   cleared (falls back to inheritance from the WP, then to null). */
export function removeDiscipline(state, id) {
  if (!Array.isArray(state.disciplines)) return false;
  const idx = state.disciplines.findIndex(d => d && d.id === id);
  if (idx === -1) return false;
  state.disciplines.splice(idx, 1);
  for (const lane of state.lanes || []) {
    if (lane.discipline === id) delete lane.discipline;
    for (const bar of lane.bars || []) {
      if (bar.discipline === id) delete bar.discipline;
    }
  }
  return true;
}

export function renameDiscipline(state, id, newLabel) {
  const d = getDisciplineById(state, id);
  if (!d) return false;
  d.label = String(newLabel || "").trim() || d.label;
  return true;
}

/* Effective discipline for a bar: per-bar override beats per-WP default.
   Returns null if neither set — bars are allowed to be uncategorised.

   Sentinel "_none" on bar.discipline means "explicitly no discipline" — the
   bar opts OUT of the WP's default. Picker UI sets this when the user
   chooses "No discipline" in the dropdown. */
export function barDiscipline(bar, lane) {
  if (bar && typeof bar.discipline === "string") {
    if (bar.discipline === "_none") return null;
    if (bar.discipline) return bar.discipline;
  }
  if (lane && typeof lane.discipline === "string" && lane.discipline) return lane.discipline;
  return null;
}

/* ── State normalisation + migration ───────────────────────────────── */

/* Fill in missing fields after load/import. Tolerates partial data.
   Migrates v4 schemas (3 fixed tracks + global activePhase) up to v5
   (extensible tracks each with kind/colour/activePhase). */
export function normaliseState(state) {
  // Optional target launch day (set in the Plan's "Project dates" card).
  if ("launch" in state && !isDay(state.launch)) delete state.launch;
  // Process: every project has one. Old data (and exports without the field)
  // loads as SOP-18. An embedded custom definition (state.processDef, written
  // by applyProcessSwitch) is adopted so exports/backups stay self-contained.
  if (state.processDef !== undefined) {
    const d = state.processDef;
    const embedded = d && validateProcessDef(d);
    if (!embedded || !embedded.ok || BUILTIN_PROCESS_IDS.has(embedded.process.id)) {
      delete state.processDef;
    } else if (!PROCESS_REGISTRY.has(embedded.process.id)) {
      registerProcess(d);
    }
  }
  if (!isStr(state.processId) || !state.processId.trim()) {
    state.processId = (state.processDef && isStr(state.processDef.id)) ? state.processDef.id : DEFAULT_PROCESS_ID;
  }
  if (!Array.isArray(state.tracks)) state.tracks = [];

  // Step 1: enrich each existing track entry with v5 fields (kind, label,
  // color, activePhase for products). Tracks missing those fields are
  // either pre-v5 or hand-edited imports — seed from SYSTEM_TRACK_SEEDS
  // when the id matches a known system seed.
  const seedById = Object.fromEntries(SYSTEM_TRACK_SEEDS.map(s => [s.id, s]));
  const seen = new Set();
  state.tracks = state.tracks.filter(t => {
    if (!t || typeof t.id !== "string" || seen.has(t.id)) return false;
    seen.add(t.id);
    const seed = seedById[t.id];
    // Default missing fields from the seed (if it's a system id) or sensible defaults.
    if (typeof t.kind !== "string") t.kind = seed ? seed.kind : "product";
    if (typeof t.label !== "string" || !t.label) t.label = seed ? seed.label : t.id;
    if (!t.color || typeof t.color !== "object") t.color = seed ? { ...seed.color } : defaultColorForNewTrack(state);
    if (typeof t.enabled !== "boolean") t.enabled = seed ? seed.enabled : true;
    if (t.kind === "product") {
      if (t.activePhase === undefined) t.activePhase = null;
    } else {
      // Clear activePhase on continuous tracks (it's meaningless there).
      if (t.activePhase !== undefined) delete t.activePhase;
    }
    return true;
  });
  // Ensure the three system seeds exist UNLESS the user has explicitly
  // dismissed them (via removeTrack). state.dismissedTrackSeeds is a list
  // of seed ids the user has deleted; we honour it so deleted seeds don't
  // reappear on next load. Continuous seeds (PLE, Exploration) are normally
  // not deletable from the UI, only disable-able, but that's a UI policy —
  // the data layer allows full deletion if a hand-edited state opts in.
  if (!Array.isArray(state.dismissedTrackSeeds)) state.dismissedTrackSeeds = [];
  const dismissed = new Set(state.dismissedTrackSeeds);
  for (const seed of SYSTEM_TRACK_SEEDS) {
    if (!seen.has(seed.id) && !dismissed.has(seed.id)) {
      state.tracks.push({ ...seed, color: { ...seed.color } });
    }
  }

  // Per-product target launch day (Plan ▸ Project dates); junk is dropped.
  for (const t of state.tracks) if ("launch" in t && (t.kind !== "product" || !isDay(t.launch))) delete t.launch;
  // Step 2: migrate legacy global state.activePhase into the first product
  // track. We use the "product" system seed if it exists; otherwise the
  // first product-kind track. Only runs when the legacy field is set AND
  // the target product hasn't been advanced past null yet (so re-loading
  // a v5 state with an active product phase doesn't get clobbered).
  if (state.activePhase !== undefined && state.activePhase !== null) {
    const target = getTrackById(state, "product") || getProductTracks(state)[0];
    if (target && target.kind === "product" && (target.activePhase == null)) {
      target.activePhase = state.activePhase;
    }
  }
  // Keep state.activePhase around as a legacy mirror of the first product's
  // phase. Older code paths that haven't been migrated to per-product still
  // read it; the renderer + tests sync it back. Set to null if no product.
  if (state.activePhase === undefined) state.activePhase = null;

  // Step 3: disciplines list. Optional axis orthogonal to tracks — empty
  // by default, user adds them from the Structure tab. Filter out malformed
  // entries; ensure each has a colour (palette-picked if missing).
  if (!Array.isArray(state.disciplines)) state.disciplines = [];
  const dSeen = new Set();
  state.disciplines = state.disciplines.filter(d => {
    if (!d || typeof d.id !== "string" || dSeen.has(d.id)) return false;
    dSeen.add(d.id);
    if (typeof d.label !== "string" || !d.label) d.label = d.id;
    if (typeof d.color !== "string" || !d.color) d.color = defaultColorForNewDiscipline(state);
    return true;
  });
  const validDisciplineIds = new Set(state.disciplines.map(d => d.id));

  // Step 4: lane + bar sanity.
  const validTrackIds = new Set(state.tracks.map(t => t.id));
  const fallbackProduct = (getProductTracks(state)[0] || { id: "product" }).id;
  for (const lane of state.lanes || []) {
    // Default missing/invalid lane track to the first enabled product
    // (was: hardcoded "product"). Preserves the single-product-flow
    // assumption for legacy data while letting renamed products carry it.
    if (typeof lane.track !== "string" || !validTrackIds.has(lane.track)) {
      lane.track = fallbackProduct;
    }
    // Lane-level discipline default. Drop if it points to nothing.
    if (lane.discipline !== undefined && !validDisciplineIds.has(lane.discipline)) {
      delete lane.discipline;
    }
    for (const bar of lane.bars || []) {
      if (!Array.isArray(bar.dependsOn)) bar.dependsOn = [];
      if (typeof bar.buffer !== "number" || bar.buffer < 0) bar.buffer = 10;
      // alloc: time-allocation %, defaulting to 100 (full-time on the task).
      if (typeof bar.alloc !== "number" || bar.alloc < 0 || bar.alloc > 100) bar.alloc = 100;
      // bar.track: legacy single-tag override of lane.track. undefined =
      // inherit. Drop if it points to a non-existent track id.
      if (bar.track !== undefined && !validTrackIds.has(bar.track)) bar.track = undefined;
      // bar.tracks: optional multi-tag override (array of track ids). When
      // set, takes precedence over bar.track. Drops dangling ids; if the
      // array ends up empty, clears the field so inheritance kicks in.
      if (bar.tracks !== undefined) {
        if (Array.isArray(bar.tracks)) {
          const dedup = [];
          const seenT = new Set();
          for (const id of bar.tracks) {
            if (typeof id === "string" && validTrackIds.has(id) && !seenT.has(id)) {
              dedup.push(id); seenT.add(id);
            }
          }
          if (dedup.length) bar.tracks = dedup;
          else delete bar.tracks;
        } else {
          delete bar.tracks;
        }
      }
      // bar.discipline: optional per-bar override of lane.discipline. The
      // "_none" sentinel is a valid value (= explicit "no discipline"
      // override of the WP default). Anything else that isn't a known id
      // gets dropped.
      if (bar.discipline !== undefined
          && bar.discipline !== "_none"
          && !validDisciplineIds.has(bar.discipline)) {
        delete bar.discipline;
      }
      // bar.followsEndOf: a companion (typically milestone) pointed at
      // another bar by id. The target's existence is verified in a second
      // pass below (after all bars are visible). Drop here if obviously
      // not a string.
      if (bar.followsEndOf !== undefined && typeof bar.followsEndOf !== "string") {
        delete bar.followsEndOf;
      }
      // Completion: done is a boolean; doneAt only means something while
      // done and must be a YYYY-MM-DD day (old data ticks have none).
      if (bar.done !== undefined && typeof bar.done !== "boolean") bar.done = !!bar.done;
      if (bar.doneAt !== undefined && (!bar.done || !isDay(bar.doneAt))) delete bar.doneAt;
      // Status: only "doing" is stored, and never together with done / on a milestone.
      if (bar.status !== undefined && (bar.status !== "doing" || bar.done || bar.type === "milestone")) delete bar.status;
    }
    if (lane.note !== undefined && (!isStr(lane.note) || !lane.note.trim())) delete lane.note;
  }
  // Activity log: keep well-formed entries only, newest ACTIVITY_LOG_CAP.
  state.log = (Array.isArray(state.log) ? state.log : [])
    .filter(e => e && isDay(e.day) && ACTIVITY_ACTIONS.has(e.action) && isStr(e.laneId))
    .map(e => ({
      at: isStr(e.at) ? e.at : "", day: e.day, action: e.action, laneId: e.laneId,
      barId: isStr(e.barId) ? e.barId : null,
      label: isStr(e.label) ? e.label : "", lane: isStr(e.lane) ? e.lane : "",
    }))
    .slice(-ACTIVITY_LOG_CAP);
  // Second pass: drop followsEndOf refs that point at non-existent bars,
  // then sync starts so companions begin at their target's end.
  const allBarIds = new Set();
  for (const lane of state.lanes || []) for (const b of lane.bars || []) allBarIds.add(b.id);
  for (const lane of state.lanes || []) {
    for (const b of lane.bars || []) {
      if (b.followsEndOf && !allBarIds.has(b.followsEndOf)) delete b.followsEndOf;
    }
  }
  syncFollowsEndOf(state);
}

/* Live "follow-end-of" sync. A bar with bar.followsEndOf = <targetId> is a
   companion (typically a milestone) that should always sit at the END of
   its target's calendar window. Each render / save call this once and the
   companion's startIdx is updated to match — so dragging or resizing the
   target automatically slides the companion.
   - Companion type is preserved (we never change it).
   - Cycles (a follows b, b follows a) are guarded against: each bar's
     startIdx is computed once per call from its target's CURRENT end,
     not iteratively, so the second bar's recompute uses the first's
     already-synced value (deterministic, no oscillation).
   - Dangling refs (target removed) clear the field; companion stops being
     tied. */
export function syncFollowsEndOf(state) {
  // Build a quick id → {bar, lane} index.
  const byId = {};
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) byId[bar.id] = { bar, lane };
  }
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) {
      if (!bar.followsEndOf) continue;
      const target = byId[bar.followsEndOf];
      if (!target) { delete bar.followsEndOf; continue; }
      // Compute target's end in months-from-project-start.
      const t = target.bar;
      const end = (t.type === "milestone")
        ? (t.startIdx || 0)
        : (t.startIdx || 0) + effSpan(t) / WEEKS_PER_MONTH;
      bar.startIdx = end;
    }
  }
}

/* The effective track LIST for a bar (multi-product tagging).
   - If bar.tracks is a non-empty array, use it (per-bar multi-tag override).
   - Else if bar.track is a non-empty string, treat as a single-element list
     (legacy single-tag override; still supported for v5-pre-multi data).
   - Else fall back to the lane's track as a single-element list.
   - Final fallback: ["product"] for legacy normalised data.
   No allowlist validation — normaliseState already scrubbed dangling ids. */
export function barTracks(bar, lane) {
  if (bar && Array.isArray(bar.tracks)) {
    const list = bar.tracks.filter(t => typeof t === "string" && t);
    if (list.length) return list;
  }
  if (bar && typeof bar.track === "string" && bar.track) return [bar.track];
  if (lane && typeof lane.track === "string" && lane.track) return [lane.track];
  return ["product"];
}

/* Backward-compatible single-track lookup: returns the FIRST effective track.
   Kept so legacy call sites that need exactly one id keep working. New
   call sites should use barTracks() and check membership. */
export function barTrack(bar, lane) {
  return barTracks(bar, lane)[0] || "product";
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
export function isBleedingBar(bar, proc) {
  const o = getProcess(proc).order;
  return !!(bar && bar.phase && bar.phaseEnd
            && hasOwn(o, bar.phase) && hasOwn(o, bar.phaseEnd)
            && o[bar.phaseEnd] > o[bar.phase]);
}

/* All phase codes a bar covers, in order. Untagged (or dormant) bar → [].
   `proc` is a Process or a project state; omitted = SOP-18. */
export function phaseSpanCodes(bar, proc) {
  const p = getProcess(proc);
  if (!bar || !bar.phase || !hasOwn(p.order, bar.phase)) return [];
  const sIdx = p.order[bar.phase];
  const endCode = (bar.phaseEnd && hasOwn(p.order, bar.phaseEnd) && p.order[bar.phaseEnd] >= sIdx)
    ? bar.phaseEnd : bar.phase;
  const eIdx = p.order[endCode];
  return p.codes.slice(sIdx, eIdx + 1);
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
export function computePhaseRanges(state, productId) {
  const proc = getProcess(state);
  const ranges = {};
  for (const lane of state.lanes || []) {
    for (const b of lane.bars || []) {
      if (!b.phase || !hasOwn(proc.order, b.phase)) continue;
      if (b.type === "milestone") continue;
      // When productId is passed, count bars whose effective track LIST
      // includes that product (multi-product tagging: a single bar may
      // belong to several products and contribute to each of their phases).
      // Omitting productId = legacy behaviour (count every phase-tagged
      // bar, regardless of track — single-product view).
      if (productId && !barTracks(b, lane).includes(productId)) continue;
      const start = b.startIdx;
      const end = b.startIdx + effSpan(b) / WEEKS_PER_MONTH;
      const gatePhase = isBleedingBar(b, proc) ? b.phaseEnd : b.phase;
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

/* All enabled product tracks → their individual phase range maps. Each
   product's ranges come ONLY from bars tagged with that product (via
   lane.track or per-bar override). Used by the multi-product stacked
   renderer in viewA. Returns an object keyed by productId, in the order
   products appear in state.tracks. */
export function computeAllProductPhaseRanges(state) {
  const out = {};
  const products = getProductTracks(state);
  for (const t of products) {
    out[t.id] = computePhaseRanges(state, t.id);
  }
  return out;
}

/* Phase-closure gates per product. Each returned gate carries _productId
   so the renderer can call isGateOpen with the right activePhase. Returns
   a flat array of gates across all products (callers can group by
   _productId for stacked rendering). */
export function computeAllProductPhaseGates(state) {
  const products = getProductTracks(state);
  const proc = getProcess(state);
  const out = [];
  for (const t of products) {
    const ranges = computePhaseRanges(state, t.id);
    const present = proc.codes.filter(c => ranges[c]);
    for (const g of computePhaseGates(ranges, present, proc)) {
      g._productId = t.id;
      out.push(g);
    }
  }
  return out;
}

/* Phase-closure gate at the END of every phase. Returned objects have no
   colour — callers (the HTML renderer) enrich them with the process phase's
   accent/bg colours before drawing. The final phase gets the process's
   final gate (default "Project close", code "END"). Labels come from the
   process's gate template. `proc` = Process or state; omitted = SOP-18. */
export function computePhaseGates(phaseRanges, presentPhases, proc) {
  const p = getProcess(proc);
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
      label: gateLabel(p, code, isLast),
      _gateCode: isLast ? p.gates.finalCode : code,
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
  const proc = getProcess(state);
  // Soft-gate processes (gates.enforce === false) and the zero-phase process
  // draw gates but never move bars.
  if (!proc.gates.enforce || proc.codes.length === 0) return;
  // Per-track phase axis. Each track (Product, Product 2, etc.) maintains
  // its own cumulativeMaxEnd — a Product 2 DO bar is gated only by
  // Product 2's own DP end, not by Product's. Multi-tagged bars
  // (bar.tracks = ["a", "b"]) are snapped by the MAX of their tracks'
  // gates (the more restrictive one) and contribute to EACH track's gate.
  //
  // v4 used a single global cumulativeMaxEnd, which incorrectly held
  // Product 2 bars behind Product's longer phases (the "Launch 1 stuck
  // behind WP3 Tooling Validation" bug).
  const cumByTrack = new Map();           // trackId -> cumulativeMaxEnd
  const trackEnd = (tid) => cumByTrack.get(tid) || 0;
  for (const phase of proc.codes) {
    // Pass 1: snap bars in this phase to the max(prev gates) across their tracks.
    for (const lane of state.lanes || []) {
      for (const b of lane.bars || []) {
        if (b.phase !== phase || b.locked) continue;
        // Compute the latest gate this bar must clear (its phase-start gate).
        // = max of its tracks' cumulativeMaxEnd accumulated through the
        // PREVIOUS phase. For a multi-product bar, every track's gate
        // applies; we use the latest.
        const tags = barTracks(b, lane);
        let maxPrev = 0;
        for (const tid of tags) {
          const prev = trackEnd(tid);
          if (prev > maxPrev) maxPrev = prev;
        }
        if (b.startIdx < maxPrev) {
          b.startIdx = Math.ceil(maxPrev * WEEKS_PER_MONTH) / WEEKS_PER_MONTH;
        }
      }
    }
    // Pass 2: contribute each gate-eligible bar's end to ALL its tracks'
    // phaseMaxEnd for this phase. extendsPhase bars are exempt.
    const phaseMaxByTrack = new Map();
    for (const lane of state.lanes || []) {
      for (const b of lane.bars || []) {
        if (b.extendsPhase) continue;
        const gatePhase = (b.phaseEnd
                           && hasOwn(proc.order, b.phaseEnd)
                           && proc.order[b.phaseEnd] > proc.order[b.phase])
                          ? b.phaseEnd : b.phase;
        if (gatePhase !== phase) continue;
        const end = b.startIdx + (b.type === "milestone" ? 0 : effSpan(b) / WEEKS_PER_MONTH);
        for (const tid of barTracks(b, lane)) {
          const cur = phaseMaxByTrack.get(tid);
          if (cur === undefined || end > cur) phaseMaxByTrack.set(tid, end);
        }
      }
    }
    // Pass 3: roll forward each track's cumulativeMaxEnd. A track with no
    // bars in this phase keeps its previous cumulative (it just doesn't
    // gain a new gate this round).
    for (const [tid, end] of phaseMaxByTrack) {
      const cur = trackEnd(tid);
      if (end > cur) cumByTrack.set(tid, end);
    }
  }
}

/* ====================== Switching a project's process ======================
   Policy (documented in CLAUDE.md):
   - A phase code the NEW process also has keeps its code.
   - Otherwise a code of the OLD process maps by relative position, first
     phase → first phase, last → last, the rest spread evenly:
       newIdx = round(oldIdx * (m-1) / (n-1))   (n, m = phase counts)
     e.g. SOP-18 → Stage-Gate: PRS → SCP · DP,DO → DEV · FP → LCH. Lossy when
     n > m, so the UI must show the plan and confirm first.
   - Codes the OLD process doesn't know (already dormant) are never touched.
   - Switching to a zero-phase process ("none") changes NO tags — they go
     dormant and a later switch back restores them exactly.
   - A bleed (phaseEnd) that no longer ends after its start phase is dropped.
   - Dates are never moved — the user runs Auto-sequence afterwards. */
export function mapPhaseCode(code, fromProc, toProc) {
  const from = getProcess(fromProc), to = getProcess(toProc);
  if (!isStr(code) || !to.codes.length) return code;     // dormant target: keep
  if (!hasOwn(from.order, code)) return code;              // unknown to old: keep
  if (hasOwn(to.order, code)) return code;                 // shared code: keep
  const n = from.codes.length, m = to.codes.length;
  return to.codes[n <= 1 ? 0 : Math.round(from.order[code] * (m - 1) / (n - 1))];
}

function walkSwitch(state, from, to, apply) {
  const rows = new Map();   // "from→to" -> { from, to, bars, lanes, tracks }
  const row = (a, b) => {
    const k = `${a}→${b}`;
    if (!rows.has(k)) rows.set(k, { from: a, to: b, bars: 0, lanes: 0, tracks: 0 });
    return rows.get(k);
  };
  let retaggedBars = 0, bleedsDropped = 0, taggedBars = 0;
  for (const lane of state.lanes || []) {
    if (isStr(lane.phase) && lane.phase) {
      const t = mapPhaseCode(lane.phase, from, to);
      row(lane.phase, t).lanes++;
      if (apply && t !== lane.phase) lane.phase = t;
    }
    for (const b of lane.bars || []) {
      if (!isStr(b.phase) || !b.phase) continue;
      taggedBars++;
      const t = mapPhaseCode(b.phase, from, to);
      row(b.phase, t).bars++;
      let changed = t !== b.phase;
      let end = b.phaseEnd;
      if (isStr(end) && end) {
        const te = mapPhaseCode(end, from, to);
        if (te !== end) changed = true;
        if (hasOwn(to.order, t) && hasOwn(to.order, te) && to.order[te] <= to.order[t]) {
          // Bleed collapsed onto/before its start phase.
          bleedsDropped++; changed = true;
          if (apply) delete b.phaseEnd;
        } else if (apply && te !== end) b.phaseEnd = te;
      }
      if (changed) retaggedBars++;
      if (apply && t !== b.phase) b.phase = t;
    }
  }
  const mapActive = (ap) => (ap && ap !== "_closed") ? mapPhaseCode(ap, from, to) : ap;
  for (const t of state.tracks || []) {
    if (t.kind === "product" && t.activePhase && t.activePhase !== "_closed") {
      const m = mapActive(t.activePhase);
      row(t.activePhase, m).tracks++;
      if (apply) t.activePhase = m;
    }
  }
  if (apply && state.activePhase) state.activePhase = mapActive(state.activePhase);
  // Stable, readable order: by the old process's phase order, then target.
  const idx = (c) => (hasOwn(from.order, c) ? from.order[c] : from.codes.length);
  const mapping = [...rows.values()]
    .sort((a, b) => idx(a.from) - idx(b.from) || String(a.to).localeCompare(String(b.to)))
    .map(r => ({ ...r, changed: r.from !== r.to }));
  return { mapping, retaggedBars, bleedsDropped, taggedBars };
}

function describeProc(p) { return { id: p.id, name: p.name, phases: p.codes.slice() }; }

/* Dry run. Returns
 *   { ok:false, error }                                    unknown target
 *   { ok:true, noop, dormant, from, to, mapping[], retaggedBars, bleedsDropped,
 *     taggedBars, dormantBars }
 * `dormant` = target has no phases (tags are kept but ignored);
 * `dormantBars` = tagged bars that will be ignored by the target process. */
export function planProcessSwitch(state, newId) {
  const to = getProcessById(newId);
  if (!to) return { ok: false, error: `Unknown process "${newId}".` };
  const from = getProcess(state);
  const sameId = (isStr(state.processId) && state.processId ? state.processId : DEFAULT_PROCESS_ID) === to.id;
  const w = walkSwitch(state, from, to, false);
  let dormantBars = 0;
  for (const lane of state.lanes || []) for (const b of lane.bars || []) {
    if (!b.phase) continue;
    const t = mapPhaseCode(b.phase, from, to);
    if (!hasOwn(to.order, t)) dormantBars++;
  }
  return {
    ok: true, noop: sameId, dormant: to.codes.length === 0,
    from: describeProc(from), to: describeProc(to),
    mapping: w.mapping, retaggedBars: w.retaggedBars, bleedsDropped: w.bleedsDropped,
    taggedBars: w.taggedBars, dormantBars,
  };
}

/* Apply the switch in place (same policy as planProcessSwitch). Sets
   state.processId (+ state.processDef for custom processes so exports carry
   the definition). Returns the plan. */
export function applyProcessSwitch(state, newId) {
  const plan = planProcessSwitch(state, newId);
  if (!plan.ok || plan.noop) return plan;
  const to = getProcessById(newId);
  walkSwitch(state, getProcess(state), to, true);
  state.processId = to.id;
  if (to.builtin) delete state.processDef;
  else state.processDef = exportProcessDef(to);
  return plan;
}

/* ====================== Navigation & menu bar ======================
   Pure tables behind the header: the in-page menu bar (Project / Edit / View /
   Export & backup / Beta / Help) and the three nav groups under it. The HTML
   renders both from here, and every menu id is dispatched by runCommand() —
   the same ids the native macOS menu (src-tauri/src/main.rs) emits.
   Grouping rule: EDITORS are the views you change data in; VIEWS are
   read-only / presentation / reference / history; SUMMARY is the lone home page. */
export const NAV_VIEWS = Object.freeze({
  summary:       { label: "Summary",           desc: "Project overview — details and a summary of everything in this project" },
  structure:     { label: "Structure",         desc: "Products, tracks and disciplines" },
  progress:      { label: "Progress",          desc: "Tick off work packages and tasks, see what has been happening" },
  plan:          { label: "Plan",              desc: "Work packages as cards — add and edit tasks" },
  altTimeline:   { label: "Timeline",          desc: "Timeline editor — tool rail, inspector, drag bars, link dependencies" },
  viewA:         { label: "Legacy timeline",   desc: "The original Gantt timeline — drag bars, link dependencies" },
  roadmap:       { label: "Simple timeline",   desc: "Compressed timeline for management — phases + headline activities" },
  phaseTimeline: { label: "Phase timeline",    desc: "Per-product phase strips + launches, nothing else" },
  milestones:    { label: "Milestones",        desc: "Every milestone in one sortable table" },
  proposal:      { label: "Proposal timeline", desc: "Hours-per-month rollup, printable for proposals" },
  phase:         { label: "Phase status",      desc: "Phase-focused project status" },
  process:       { label: "Process",           desc: "Phase model & reference" },
  snapshots:     { label: "Snapshots",         desc: "Save and restore named versions" },
});
/** kind: "single" = one standalone button, "tabs" = always-visible segmented pills,
 *  "menu" = one button opening a dropdown (optionally sectioned). */
export const NAV_LAYOUT = Object.freeze([
  { id: "summary", label: "Summary", kind: "single", views: ["summary"] },
  { id: "editors", label: "Editors", kind: "tabs",   views: ["structure", "plan", "progress", "altTimeline"] },
  { id: "views",   label: "Views",   kind: "menu",   views: ["roadmap", "phaseTimeline", "milestones", "proposal", "phase", "process", "snapshots", "viewA"],
    sections: [
      { label: "Present",             views: ["roadmap", "phaseTimeline", "milestones", "proposal"] },
      { label: "Reference & history", views: ["phase", "process", "snapshots"] },
      { label: "Legacy",              views: ["viewA"] },
    ] },
]);
/** Every built-in view id reachable from the nav bar (beta views are separate). */
export function navViewIds() { return NAV_LAYOUT.flatMap(g => g.views); }
/** Which nav group owns `view`: "summary" | "editors" | "views" | "beta" (a registered beta view) | null. */
export function navGroupOfView(view, betaIds = []) {
  for (const g of NAV_LAYOUT) if (g.views.includes(view)) return g.id;
  return betaIds.includes(view) ? "beta" : null;
}
/** Validate the window.BETA_VIEWS registry: keeps entries with a string id + label,
 *  drops duplicates and ids that clash with a built-in view. `ready` = has a render function. */
export function normalizeBetaViews(list) {
  const seen = new Set(navViewIds()), out = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (!v || typeof v.id !== "string" || !v.id || typeof v.label !== "string" || !v.label || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push({ id: v.id, label: v.label, desc: typeof v.desc === "string" ? v.desc : "", ready: typeof v.render === "function" });
  }
  return out;
}

/** Menu bar. Items: {id,label,icon?,accel?,danger?} = command (id goes to runCommand);
 *  {t:"sep"} {t:"section",label} {t:"sub",label,items} and dynamic fills
 *  {t:"projects"} (project list) / {t:"beta"} (Beta views registry). */
export const MENU_BAR = Object.freeze([
  { id: "file", label: "File", items: [
    { id: "newProject",       label: "New project…",       icon: "＋" },
    { t: "sub", label: "Open project", items: [
      { t: "projects" },
      { t: "sep", desktop: true },
      { id: "openProjectFile", label: "Open from file…", icon: "📂", desktop: true },
    ] },
    { t: "sep" },
    { id: "duplicateProject", label: "Duplicate project…", icon: "⧉" },
    { id: "renameProject",    label: "Rename project…",    icon: "✎" },
    { id: "deleteProject",    label: "Delete project…",    icon: "🗑", danger: true },
    { t: "sep" },
    { id: "saveProjectCopy",  label: "Save a copy as…",    icon: "⎘", desktop: true },
    { t: "sub", label: "Import", items: [
      { id: "importAsProject", label: "JSON as new project…", icon: "⬆" },
      { id: "importXlsx",      label: "Excel (.xlsx)…",       icon: "⬆" },
      { id: "importBackup",    label: "Restore backup…",      icon: "⬆" },
    ] },
    { t: "sub", label: "Export", items: [
      { id: "json",         label: "Project as JSON",                 icon: "⬇", accel: "⌘E" },
      { id: "png",          label: "Timeline as PNG",                 icon: "🖼" },
      { id: "pdf",          label: "Timeline as PDF",                 icon: "📄" },
      { id: "html",         label: "Page as HTML",                    icon: "🌐" },
      { id: "timelineHtml", label: "Timeline as HTML (Confluence)…",  icon: "🧩" },
    ] },
    { id: "exportAll",        label: "Back up all projects…", icon: "⬇", accel: "⇧⌘E" },
    { t: "sep", desktop: true },
    { t: "filestatus", desktop: true },
    { id: "showProjectFile",   label: "Show project file in Finder", icon: "🔍", desktop: true },
    { id: "openProjectFolder", label: "Open project folder",         icon: "📁", desktop: true },
    { id: "toggleFileSave",    label: "Autosave to project file",    icon: "💾", desktop: true },
  ] },
  { id: "edit", label: "Edit", items: [
    { id: "undo",         label: "Undo",          icon: "↶", accel: "⌘Z" },
    { id: "redo",         label: "Redo",          icon: "↷", accel: "⇧⌘Z" },
    { t: "sep" },
    { id: "toggleEdit",   label: "Edit mode",     icon: "✎" },
    { id: "autoSequence", label: "Auto-sequence", icon: "⇢" },
  ] },
  { id: "view", label: "View", items: [
    { id: "view:summary",     label: "Summary" },
    { t: "sep" },
    { id: "view:structure",   label: "Structure" },
    { id: "view:plan",        label: "Plan" },
    { id: "view:progress",    label: "Progress" },
    { id: "view:altTimeline", label: "Timeline" },
    { t: "sep" },
    { t: "sub", label: "More views", items: [
      { t: "section", label: "Present" },
      { id: "view:roadmap",       label: "Simple timeline" },
      { id: "view:phaseTimeline", label: "Phase timeline" },
      { id: "view:milestones",    label: "Milestones" },
      { id: "view:proposal",      label: "Proposal timeline" },
      { t: "section", label: "Reference & history" },
      { id: "view:phase",         label: "Phase status" },
      { id: "view:process",       label: "Process" },
      { id: "view:snapshots",     label: "Snapshots" },
      { t: "section", label: "Legacy" },
      { id: "view:viewA",         label: "Legacy timeline" },
    ] },
    { t: "sub", label: "Beta views", items: [{ t: "beta" }] },
    { t: "sep" },
    { id: "toggleTheme", label: "Dark mode", icon: "🌙", accel: "⇧⌘L" },
    { id: "focusMode",   label: "Focus mode", icon: "⛶" },
  ] },
  { id: "project", label: "Project", items: [
    { id: "changeProcess", label: "Process…",         icon: "⚑" },
    { t: "sep" },
    { id: "saveSnapshot",  label: "Save snapshot…",   icon: "📸" },
    { id: "view:snapshots", label: "Snapshots…",      icon: "🕘" },
    { t: "sep" },
    { id: "import",        label: "Replace plan from JSON…", icon: "⬆", danger: true },
    { id: "loadDemo",      label: "Load demo plan…" },
    { id: "clear",         label: "Clear timeline…", danger: true },
  ] },
  { id: "help", label: "Help", items: [
    { id: "about", label: "About ProPlan…", icon: "ℹ" },
  ] },
]);
/** Every command id used in the menu bar (excludes separators/sections/dynamic fills). */
export function menuCommandIds(menus = MENU_BAR) {
  const ids = [];
  const walk = (items) => { for (const it of items) { if (it.items) walk(it.items); if (it.id) ids.push(it.id); } };
  for (const m of menus) walk(m.items);
  return ids;
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
      // Locked bars keep their startIdx — auto-sequence never moves them. They
      // still contribute their end position to downstream successors, so the
      // rest of the chain re-flows around them.
      if (bar.locked) continue;
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
  // Allocation %: how much of the calendar window's hours actually count as
  // effort. 100 = full time. 33 = ~1/3 of the calendar slot's hours.
  const allocFactor = barAllocPct(b) / 100;
  const cs = b.startIdx + startMonthOffset;
  const ce = cs + effMonths;
  const firstM = Math.max(0, Math.floor(cs));
  const lastM = Math.min(numMonths - 1, Math.ceil(ce) - 1);
  for (let m = firstM; m <= lastM; m++) {
    const len = Math.max(0, Math.min(m + 1, ce) - Math.max(m, cs));
    const h = len * WEEKS_PER_MONTH * hoursPerWeek * allocFactor;
    if (h > 0) dist[m] += h;
  }
  return dist;
}

/* ── Progress / completion tracking ────────────────────────────────────
   A task bar is complete when bar.done is true; bar.doneAt ("YYYY-MM-DD",
   local day) records WHEN it was ticked (absent on data ticked before this
   existed → "undated"). A work package (lane) is complete when it has at
   least one task bar and all of them are done — derived, never stored.
   lane.note is an optional free-text status note per WP.

   state.log is a capped append-only activity feed of completions:
     { at: ISO datetime, day: "YYYY-MM-DD", action, laneId, barId|null,
       label, lane }
   action ∈ done | reopen | wp-done | wp-reopen. label/lane are snapshots
   so the feed still reads sensibly after a bar or WP is deleted.
   Milestones are not tasks: they never count towards WP progress. */

export const ACTIVITY_LOG_CAP = 500;
const ACTIVITY_ACTIONS = new Set(["done", "reopen", "wp-done", "wp-reopen"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(s) {
  return isStr(s) && DAY_RE.test(s) && !isNaN(new Date(s + "T00:00:00").getTime());
}

/* Local calendar day as YYYY-MM-DD (not UTC — a tick at 23:30 belongs to
   today for the user). */
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(day, n) {
  const d = new Date(day + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/* Every bar counts toward progress — milestones are tickable (done / pending) like tasks. */
function isTaskBar(bar) { return !!bar; }

/* Per-WP progress. status: empty (no tasks) | not-started | in-progress |
   complete. doneAt (complete only) = latest task completion day, if any
   task is dated. lastActivity = latest completion day of any done task. */
export function laneProgress(lane) {
  const tasks = (lane.bars || []).filter(isTaskBar);
  const done = tasks.filter(b => b.done);
  const total = tasks.length;
  const days = done.map(b => b.doneAt).filter(isDay).sort();
  const lastActivity = days.length ? days[days.length - 1] : null;
  const doing = tasks.filter(b => !b.done && b.status === "doing").length;
  const status = total === 0 ? "empty"
    : done.length === total ? "complete"
    : (done.length > 0 || doing > 0) ? "in-progress" : "not-started";
  return {
    total, done: done.length, doing,
    pct: total ? Math.round(done.length / total * 100) : 0,
    status,
    doneAt: status === "complete" ? lastActivity : null,
    lastActivity,
    note: isStr(lane.note) ? lane.note : "",
  };
}

/* Whole-project rollup: task + WP counts. */
export function projectProgress(state) {
  let tasks = 0, done = 0, doing = 0, wps = 0, wpsComplete = 0;
  for (const lane of state.lanes || []) {
    const p = laneProgress(lane);
    tasks += p.total; done += p.done; doing += p.doing;
    if (p.status !== "empty") { wps++; if (p.status === "complete") wpsComplete++; }
  }
  return { tasks, done, doing, pct: tasks ? Math.round(done / tasks * 100) : 0, wps, wpsComplete };
}

function pushLog(state, entry) {
  if (!Array.isArray(state.log)) state.log = [];
  state.log.push(entry);
  if (state.log.length > ACTIVITY_LOG_CAP) state.log.splice(0, state.log.length - ACTIVITY_LOG_CAP);
}

function logEntry(now, day, action, lane, bar) {
  return {
    at: now.toISOString(), day, action,
    laneId: lane.id, barId: bar ? bar.id : null,
    label: bar ? (bar.label || "") : "",
    lane: lane.code || "",
  };
}

/* Flip one bar's done flag without touching the WP-level log entries. */
function applyDone(state, lane, bar, want, day, now) {
  bar.done = want;
  delete bar.status;                    // done / reopened tasks are no longer in progress
  if (want) bar.doneAt = day; else delete bar.doneAt;
  pushLog(state, logEntry(now, day, want ? "done" : "reopen", lane, bar));
}

function logWpTransition(state, lane, before, after, day, now) {
  if (before !== "complete" && after === "complete") pushLog(state, logEntry(now, day, "wp-done", lane, null));
  else if (before === "complete" && after !== "complete") pushLog(state, logEntry(now, day, "wp-reopen", lane, null));
}

/* Tick / untick one bar. opts.now (Date, default new Date()) and opts.date
   (YYYY-MM-DD backdate for the tick; default today). Ticking an already-done
   bar with a different opts.date just re-dates it (its latest log entry moves to that day).
   Returns null when the bar doesn't exist, else
   { changed, redated?, wpComplete }. */
/* Task status: pending (default) · doing (in progress) · done. `done` stays the source of truth for
   completion (bar.done / doneAt / log); only "doing" is stored as bar.status. Milestones have no status.
   Returns null for an unknown bar, else { changed, status, wpComplete }. */
export const BAR_STATUSES = Object.freeze(["pending", "doing", "done"]);
export function barStatus(bar) {
  if (!bar) return null;
  return bar.done ? "done" : (bar.status === "doing" && bar.type !== "milestone") ? "doing" : "pending";
}
export function setBarStatus(state, barId, status, opts = {}) {
  if (!BAR_STATUSES.includes(status)) return null;
  for (const lane of state.lanes || []) {
    const bar = (lane.bars || []).find(b => b.id === barId);
    if (!bar) continue;
    if (bar.type === "milestone" && status === "doing") return { changed: false, status: barStatus(bar), wpComplete: false };   // milestones: pending / done only
    const before = barStatus(bar);
    if (status === "done") {
      const r = setBarDone(state, barId, true, opts);
      return { changed: r.changed, status, wpComplete: r.wpComplete };
    }
    if (bar.done) setBarDone(state, barId, false, opts);
    if (status === "doing") bar.status = "doing"; else delete bar.status;
    return { changed: before !== status, status, wpComplete: laneProgress(lane).status === "complete" };
  }
  return null;
}

export function setBarDone(state, barId, done, { now = new Date(), date } = {}) {
  for (const lane of state.lanes || []) {
    const bar = (lane.bars || []).find(b => b.id === barId);
    if (!bar) continue;
    const want = !!done;
    const day = isDay(date) ? date : localDay(now);
    if (!!bar.done === want) {
      if (want && isDay(date) && bar.doneAt !== date) {
        bar.doneAt = date;
        // Keep the feed truthful: move this bar's latest "done" entry to the new day.
        const entry = (state.log || []).findLast(e => e.barId === barId && e.action === "done");
        if (entry) entry.day = date;
        return { changed: true, redated: true, wpComplete: laneProgress(lane).status === "complete" };
      }
      return { changed: false, wpComplete: laneProgress(lane).status === "complete" };
    }
    const before = laneProgress(lane).status;
    applyDone(state, lane, bar, want, day, now);
    const after = laneProgress(lane).status;
    logWpTransition(state, lane, before, after, day, now);
    return { changed: true, wpComplete: after === "complete" };
  }
  return null;
}

/* Tick / untick every task in a WP at once ("mark WP complete"). Bars that
   already match are left alone (their original doneAt is kept). Returns
   null for an unknown lane, else { changed: <bars flipped>, wpComplete }. */
export function setLaneDone(state, laneId, done, { now = new Date(), date } = {}) {
  const lane = (state.lanes || []).find(l => l.id === laneId);
  if (!lane) return null;
  const want = !!done;
  const day = isDay(date) ? date : localDay(now);
  const before = laneProgress(lane).status;
  let changed = 0;
  for (const bar of lane.bars || []) {
    if (!isTaskBar(bar) || !!bar.done === want) continue;
    applyDone(state, lane, bar, want, day, now);
    changed++;
  }
  const after = laneProgress(lane).status;
  logWpTransition(state, lane, before, after, day, now);
  return { changed, wpComplete: after === "complete" };
}

/* Set or clear a WP's free-text note. Returns false for an unknown lane. */
export function setLaneNote(state, laneId, text) {
  const lane = (state.lanes || []).find(l => l.id === laneId);
  if (!lane) return false;
  const t = isStr(text) ? text.trim() : "";
  if (t) lane.note = t; else delete lane.note;
  return true;
}

/* Activity feed, newest first: the logged events plus synthetic "done"
   events for tasks that are done and dated but have no log entry (ticked
   before logging existed, or imported). opts: days (window, default 14,
   0/Infinity = all), now, limit (default 100). */
export function recentActivity(state, { days = 14, now = new Date(), limit = 100 } = {}) {
  const events = (Array.isArray(state.log) ? state.log : []).filter(e => e && isDay(e.day));
  const logged = new Set(events.filter(e => e.action === "done").map(e => e.barId));
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) {
      if (!isTaskBar(bar) || !bar.done || !isDay(bar.doneAt) || logged.has(bar.id)) continue;
      events.push({ at: "", day: bar.doneAt, action: "done", laneId: lane.id, barId: bar.id,
        label: bar.label || "", lane: lane.code || "" });
    }
  }
  const cutoff = days && isFinite(days) ? addDays(localDay(now), -days) : null;
  // Newest first: by day, then timestamp, then log position (so a wp-done
  // stamped in the same instant as the tick that caused it reads above it).
  return events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !cutoff || e.day >= cutoff)
    .sort((x, y) => (x.e.day === y.e.day
      ? (x.e.at === y.e.at ? y.i - x.i : (x.e.at < y.e.at ? 1 : -1))
      : (x.e.day < y.e.day ? 1 : -1)))
    .slice(0, limit)
    .map(({ e }) => e);
}

/* Group an events array (as returned by recentActivity) into
   [{ day, events }] preserving order. */
export function groupActivityByDay(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last.day === e.day) last.events.push(e);
    else out.push({ day: e.day, events: [e] });
  }
  return out;
}

/* "What got finished lately", derived from the CURRENT done flags (so it
   stays right even after the capped log rolls over): tasks and WPs whose
   completion day falls in the last `days` days (default 7), plus how many
   done tasks have no date. */
export function completionSummary(state, { days = 7, now = new Date() } = {}) {
  const cutoff = addDays(localDay(now), -days);
  let tasks = 0, wps = 0, undated = 0;
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) {
      if (!isTaskBar(bar) || !bar.done) continue;
      if (!isDay(bar.doneAt)) undated++;
      else if (bar.doneAt >= cutoff) tasks++;
    }
    const p = laneProgress(lane);
    if (p.status === "complete" && p.doneAt && p.doneAt >= cutoff) wps++;
  }
  return { days, tasks, wps, undated };
}

/* Burn-up series of dated completions: [{ day, count, cumulative }] in
   ascending day order, from the currently-done tasks. */
export function completionSeries(state) {
  const byDay = {};
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) {
      if (isTaskBar(bar) && bar.done && isDay(bar.doneAt)) byDay[bar.doneAt] = (byDay[bar.doneAt] || 0) + 1;
    }
  }
  let cumulative = 0;
  return Object.keys(byDay).sort().map(day => {
    cumulative += byDay[day];
    return { day, count: byDay[day], cumulative };
  });
}


/* ====================== Burndown ======================
   Remaining work over time, with the IDEAL line built from the plan itself: a staircase that drops by a
   task's weight on the day that task is due (its planned end), so it follows the order the plan puts the
   tasks in rather than a straight diagonal. ACTUAL drops on each task's `doneAt`.
   Weight: "tasks" (1 each, milestones count) or "effort" (effortWeeks; milestones weigh 0). Ongoing bars
   (project lead etc.) are never counted. Days are ISO strings; all date maths is UTC-midnight so it can't
   drift with the local zone. Every name starts with burndown because the build inlines this file globally. */

const BURNDOWN_MS = 86400000;
function burndownMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
function burndownIso(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function burndownAddDays(day, n) { return burndownIso(burndownMs(day) + n * BURNDOWN_MS); }
export function burndownDaysBetween(a, b) { return Math.round((burndownMs(b) - burndownMs(a)) / BURNDOWN_MS); }
/* Project start as an ISO day (state.start may be YYYY-MM or YYYY-MM-DD). */
export function burndownStartDay(state) {
  const p = parseYM(state.start);
  return burndownIso(Date.UTC(p.y, p.m - 1, p.d || 1));
}
/* 1-based project week of a day (for "Project weeks" labels). */
export function burndownWeekOf(state, day) {
  return Math.floor(burndownDaysBetween(burndownStartDay(state), day) / 7) + 1;
}
/* Value of a step series [{day, remaining}] on a day (the last point at or before it). */
export function burndownValueAt(points, day) {
  let v = points && points.length ? points[0].remaining : 0;
  for (const p of points || []) { if (p.day <= day) v = p.remaining; else break; }
  return v;
}
/* Scope string → include(bar, lane) predicate: "all" | "track:<id>" | "wp:<laneId>". */
export function burndownInclude(scope) {
  const s = String(scope || "all");
  if (s.startsWith("track:")) { const id = s.slice(6); return (bar, lane) => barTracks(bar, lane).includes(id); }
  if (s.startsWith("wp:")) { const id = s.slice(3); return (bar, lane) => lane.id === id; }
  return null;
}

/* The countable bars with their weight, planned dates and completion. */
export function burndownTasks(state, opts = {}) {
  const effort = opts.weight === "effort";
  const include = typeof opts.include === "function" ? opts.include : null;
  const codes = altTaskCodes(state);
  const out = [];
  (state.lanes || []).forEach((lane, laneIdx) => {
    for (const bar of lane.bars || []) {
      if (!bar || bar.type === "ongoing") continue;
      if (include && !include(bar, lane, laneIdx)) continue;
      const d = altBarDates(state, bar), c = codes[bar.id] || {};
      out.push({
        id: bar.id, code: c.code || "", short: c.short || "", laneId: lane.id, laneIdx, label: bar.label || "",
        milestone: bar.type === "milestone", weight: effort ? effortWeeks(bar) : 1,
        plannedStart: d.start, plannedEnd: d.end,
        done: !!bar.done, doneAt: bar.done && isDay(bar.doneAt) ? bar.doneAt : null, status: barStatus(bar),
      });
    }
  });
  return out;
}

/* Where the plan says you should be if you're `remaining` behind on day `today`: how many days late (>0),
   early (<0) or on plan (0). Behind = the first day the plan expected LESS than `remaining` left (the
   earliest overdue work); ahead = the day the plan will reach `remaining`. */
export function burndownForecast(ideal, remaining, today, planFinish) {
  if (!ideal || !ideal.length) return null;
  const EPS = 1e-9;
  if (remaining <= EPS) return { done: true, slipDays: 0, finish: null, behind: false, ahead: false };
  const idealNow = burndownValueAt(ideal, today);
  let slip = 0;
  if (remaining > idealNow + EPS) {
    const step = ideal.find(p => p.remaining < remaining - EPS);
    slip = step ? Math.max(0, burndownDaysBetween(step.day, today)) : 0;
  } else if (remaining < idealNow - EPS) {
    const step = ideal.find(p => p.remaining <= remaining + EPS);
    slip = step ? Math.min(0, burndownDaysBetween(step.day, today)) : 0;
  }
  return { done: false, slipDays: slip, finish: planFinish ? burndownAddDays(planFinish, slip) : null, behind: slip > 0, ahead: slip < 0 };
}

/* The whole chart model. opts: {weight: "tasks"|"effort", include, baseline (a state — e.g. a snapshot's — the
   plan/ideal comes from, matched by bar id; ACTUAL always comes from the live state), today}. */
export function burndownSeries(state, opts = {}) {
  const unit = opts.weight === "effort" ? "effort" : "tasks";
  const today = isDay(opts.today) ? opts.today : localDay();
  const live = burndownTasks(state, { weight: unit, include: opts.include });
  const base = opts.baseline ? burndownTasks(opts.baseline, { weight: unit, include: opts.include }) : null;
  const plan = base || live;
  const sum = (a) => a.reduce((t, x) => t + x.weight, 0);
  const total = sum(live), planTotal = sum(plan);

  const projectStart = burndownStartDay(state);
  let start = projectStart;
  for (const t of plan) if (t.plannedStart < start) start = t.plannedStart;
  for (const t of live) if (t.doneAt && t.doneAt < start) start = t.doneAt;

  // IDEAL: staircase of the plan, one drop per due day.
  const dueBy = {};
  for (const t of plan) if (t.weight) dueBy[t.plannedEnd] = (dueBy[t.plannedEnd] || 0) + t.weight;
  const ideal = [{ day: start, remaining: planTotal }];
  let left = planTotal;
  for (const day of Object.keys(dueBy).sort()) {
    left -= dueBy[day];
    if (day === ideal[ideal.length - 1].day) ideal[ideal.length - 1].remaining = left; else ideal.push({ day, remaining: left });
  }
  const planFinish = plan.length ? plan.reduce((m, t) => (t.plannedEnd > m ? t.plannedEnd : m), plan[0].plannedEnd) : null;

  // ACTUAL: drops on each task's completion day. Done-but-undated work is counted done from the start.
  const undated = { count: 0, weight: 0 };
  const doneBy = {};
  let doneWeight = 0, doneCount = 0;
  for (const t of live) {
    if (!t.done) continue;
    doneCount++; doneWeight += t.weight;
    if (t.doneAt) doneBy[t.doneAt] = (doneBy[t.doneAt] || 0) + t.weight;
    else { undated.count++; undated.weight += t.weight; }
  }
  let rem = total - undated.weight;
  const actual = [{ day: start, remaining: rem }];
  for (const day of Object.keys(doneBy).sort()) {
    rem -= doneBy[day];
    if (day === actual[actual.length - 1].day) actual[actual.length - 1].remaining = rem; else actual.push({ day, remaining: rem });
  }
  if (today > actual[actual.length - 1].day) actual.push({ day: today, remaining: rem });

  const remaining = total - doneWeight;
  // With a baseline, work added/removed since then is scope, not slip — compare like with like.
  const scopeDelta = base ? total - planTotal : 0;
  const forecast = live.length ? burndownForecast(ideal, Math.max(0, remaining - scopeDelta), today, planFinish) : null;
  let scope = null;
  if (base) {
    const liveIds = new Set(live.map(t => t.id)), baseIds = new Set(base.map(t => t.id));
    const addedIds = live.filter(t => !baseIds.has(t.id)).map(t => t.id);
    const removedIds = base.filter(t => !liveIds.has(t.id)).map(t => t.id);
    scope = { added: addedIds.length, removed: removedIds.length, addedIds, removedIds, delta: scopeDelta };
  }
  let end = planFinish && planFinish > today ? planFinish : today;
  if (forecast && forecast.finish && forecast.finish > end) end = forecast.finish;
  return {
    unit, total, planTotal, start, end, today, planFinish, ideal, actual, undated, scope, forecast,
    remaining, doneCount, doneWeight, taskCount: live.length,
    idealNow: burndownValueAt(ideal, today),
    delta: remaining - burndownValueAt(ideal, today) - scopeDelta,   // >0 behind plan, <0 ahead (in the chart's unit)
  };
}

/* The tasks in the order the plan says they will happen, each with where it sits on the remaining-work staircase and how
   it is going. Order = planned end, then dependency (topological) order, then WP / task position — never the task code
   alone (a later WP can finish first). `before` / `after` = work remaining before / after this task completes if the plan
   is followed in order (so each task is a step of height `weight`). opts: {weight, include, baseline, today} like
   burndownSeries; with a baseline the order and planned dates come from it (matched by bar id), the rest from the live
   plan; tasks added since are flagged `added`, removed ones are dropped.
   status: done | doing | overdue | upcoming.  late = finished after its planned end.  outOfOrder = done while an earlier
   task is still open (or finished before an earlier task did). */
export function burndownSequence(state, opts = {}) {
  const unit = opts.weight === "effort" ? "effort" : "tasks";
  const today = isDay(opts.today) ? opts.today : localDay();
  const live = burndownTasks(state, { weight: unit, include: opts.include });
  const base = opts.baseline ? burndownTasks(opts.baseline, { weight: unit, include: opts.include }) : null;
  const liveById = new Map(live.map(t => [t.id, t]));
  let rows;
  if (base) {
    const baseIds = new Set(base.map(t => t.id));
    rows = [];
    for (const b of base) { const l = liveById.get(b.id); if (l) rows.push({ ...l, plannedStart: b.plannedStart, plannedEnd: b.plannedEnd }); }
    for (const l of live) if (!baseIds.has(l.id)) rows.push({ ...l, added: true });
  } else rows = live.map(t => ({ ...t }));

  const topoIdx = {};
  try { const order = topoOrder(buildBarMap(state)); if (order) order.forEach((id, i) => { topoIdx[id] = i; }); } catch { /* cycle: fall back to position */ }
  const big = 1e9;
  rows.sort((a, b) =>
    (a.plannedEnd < b.plannedEnd ? -1 : a.plannedEnd > b.plannedEnd ? 1 : 0)
    || ((topoIdx[a.id] ?? big) - (topoIdx[b.id] ?? big))
    || (a.laneIdx - b.laneIdx)
    || String(a.short).localeCompare(String(b.short), undefined, { numeric: true }));

  const total = rows.reduce((t, x) => t + x.weight, 0);
  let running = total, plannedToday = 0;
  const items = rows.map((t, i) => {
    const before = running; running -= t.weight;
    const late = !!(t.done && t.doneAt && t.doneAt > t.plannedEnd);
    const status = t.done ? "done" : t.status === "doing" ? "doing" : (t.plannedEnd < today ? "overdue" : "upcoming");
    if (t.plannedEnd <= today) plannedToday += t.weight;
    return { ...t, rank: i + 1, before, after: running, status, late };
  });
  // out of order: done while an earlier task is still open, or done before an earlier task was
  items.forEach((x, i) => {
    x.outOfOrder = false;
    if (!x.done) return;
    for (let k = 0; k < i; k++) {
      const y = items[k];
      if (!y.done || (y.doneAt && x.doneAt && y.doneAt > x.doneAt)) { x.outOfOrder = true; break; }
    }
  });
  const doneWeight = items.reduce((t, x) => t + (x.done ? x.weight : 0), 0);
  const nextUp = items.find(x => !x.done) || null;
  return {
    unit, today, total, items,
    remaining: total - doneWeight, doneCount: items.filter(x => x.done).length,
    plannedRemainingNow: total - plannedToday,
    planTodayIndex: items.filter(x => x.plannedEnd <= today).length,        // how many tasks the plan says are finished by today
    lateCount: items.filter(x => x.late).length,
    overdueCount: items.filter(x => x.status === "overdue").length,
    outOfOrderCount: items.filter(x => x.outOfOrder).length,
    nextUp, scope: base ? { added: items.filter(x => x.added).length, removed: base.filter(b => !liveById.has(b.id)).length } : null,
  };
}

/* ====================== Alt timeline (tool-rail editor) ======================
   Pure logic behind the Beta "Alt timeline view" (renderAltTimeline in the HTML):
   the Photoshop-style tool table, geometry + hit-testing, snapping, marquee
   selection, the gesture decision table and the state operations the tools
   run. No DOM, no localStorage. Everything that mutates takes `state` and
   returns a small result object; the UI calls saveState() once per gesture.
   Units match the rest of the app: startIdx = months (a week = 0.25), span =
   weeks, buffer = %, calendar length = effSpan(bar) weeks.
   Every top-level name here starts with alt or ALT_ because the build inlines
   this file into the HTML's global scope. */

export const ALT_ROW_H = 22;          // task row height (px)
export const ALT_MS_ROW_H = ALT_ROW_H;  // milestones use the same row height as tasks (one consistent rhythm; was a slimmer 16)
export const ALT_LANE_H = 24;         // WP header row height (px)
export const ALT_BAR_H = 18;
export const ALT_EDGE_PX = 6;         // resize hot-zone at each end of a bar
export const ALT_MIN_EFF_WEEKS = 1;   // shortest bar a resize may produce
export const ALT_GRIDS = { off: 0, week: 1, "2week": 2, month: 4 };

/* edit:true tools change the plan and are disabled in view-only mode. Select,
   Mark done, Hand and Zoom stay usable (status updates / navigation). */
export const ALT_TOOLS = [
  { id: "select",    key: "v", label: "Select / Move",   edit: false, hint: "Click to select, drag to move, drag empty space to marquee-select" },
  { id: "resize",    key: "r", label: "Resize / Trim",   edit: true,  hint: "Drag a bar's left or right half to trim that edge" },
  { id: "draw",      key: "b", label: "Draw bar",        edit: true,  hint: "Drag across a row to draw a new bar of the chosen type" },
  { id: "milestone", key: "m", label: "Milestone",       edit: true,  hint: "Click a row to drop a milestone, or a bar to add one at its end" },
  { id: "link",      key: "l", label: "Link dependency", edit: true,  hint: "Drag from one bar to another (predecessor → successor)" },
  { id: "split",     key: "c", label: "Split / Cut",     edit: true,  hint: "Click a bar to cut it in two at that week" },
  { id: "lock",      key: "k", label: "Lock",            edit: true,  hint: "Click a bar to lock/unlock it (locked bars never move)" },
  { id: "done",      key: "d", label: "Mark done",       edit: false, hint: "Click a task to tick or untick it" },
  { id: "hand",      key: "h", label: "Hand",            edit: false, hint: "Drag to pan (hold Space from any tool)" },
  { id: "zoom",      key: "z", label: "Zoom",            edit: false, hint: "Click or drag a rectangle to zoom in, Alt-click to zoom out" },
];
export const ALT_TYPE_DIGITS = { "1": "work", "2": "buffer", "3": "leadtime", "4": "review", "5": "milestone" };

export function altToolById(id) { return ALT_TOOLS.find(t => t.id === id) || null; }
export function altToolForKey(key) {
  const k = String(key || "").toLowerCase();
  return ALT_TOOLS.find(t => t.key === k) || null;
}
export function altToolAllowed(toolId, editMode) {
  const t = altToolById(toolId);
  return !!t && (!t.edit || !!editMode);
}
/* The tool that is effectively active: holding Space turns any tool into Hand. */
export function altResolveTool(active, { space = false } = {}) {
  return space ? "hand" : (altToolById(active) ? active : "select");
}
/* Keyboard tool switch. Returns { tool, blocked } — blocked is "view-only"
   when the key names an edit tool while editing is off (tool stays as is). */
export function altSwitchTool(current, key, { editMode = false } = {}) {
  const t = altToolForKey(key);
  if (!t) return { tool: current, blocked: null, changed: false };
  if (!altToolAllowed(t.id, editMode)) return { tool: current, blocked: "view-only", changed: false };
  return { tool: t.id, blocked: null, changed: t.id !== current };
}

/* ---------- Geometry ---------- */

/* Pixel rectangle for one bar. rowY = top of its row. A stand-alone milestone
   sits half a column in (matches the Timeline view); a followsEndOf milestone
   sits exactly at its target's end. */
/* Packed milestones (beta) carry their WP tag INSIDE a wider, flatter diamond (a rhombus ALT_MS_WIDE_W × ALT_MS_WIDE_H) instead of a small diamond. */
export const ALT_MS_WIDE_W = 34, ALT_MS_WIDE_H = 20;
export function altBarRect(bar, colW, rowY, laneId, rowH = ALT_ROW_H, { wide = false, tagW = ALT_MS_WIDE_W } = {}) {
  const flags = {
    barId: bar.id, laneId, type: bar.type,
    locked: !!bar.locked, done: !!bar.done,
    linked: !!bar.followsEndOf, ongoing: bar.type === "ongoing",
  };
  if (bar.type === "milestone") {
    const cx = bar.followsEndOf ? bar.startIdx * colW : bar.startIdx * colW + colW / 2;
    // Wide (packed) milestone: a hexagon tag whose LEFT tip sits on the date (px), the tag extends to the right; cx/hw describe its centre/half-width like any other marker.
    if (wide) return { ...flags, milestone: true, wide: true, hw: tagW / 2, px: cx, x: cx, y: rowY + (rowH - ALT_MS_WIDE_H) / 2, w: tagW, h: ALT_MS_WIDE_H, cx: cx + tagW / 2 };
    const s = rowH < ALT_ROW_H ? 13 : 18;
    return { ...flags, milestone: true, hw: 9, x: cx - s / 2, y: rowY + (rowH - s) / 2, w: s, h: s, cx };
  }
  const x = bar.startIdx * colW;
  const w = Math.max(0.25, effSpan(bar) / WEEKS_PER_MONTH) * colW;
  return { ...flags, milestone: false, x, y: rowY + (ALT_ROW_H - ALT_BAR_H) / 2, w, h: ALT_BAR_H, cx: x + w / 2 };
}

/* Rows + bar rectangles for the whole canvas. Collapsed WPs show only their
   header row (their bars get no rect, so they can't be hit or linked). */
export function altLayout(state, colW, { collapsed = new Set(), laneFilter = null, barFilter = null, laneHeaders = true, milestonesAtBottom = false, milestonesPacked = false, msLabelW = null, msTagW = null } = {}) {
  const rows = []; const rects = []; const rectById = {};
  const msTail = [];     // milestonesAtBottom: collected here, laid out under a "Milestones" section at the end
  let y = 0;
  if (milestonesPacked) milestonesAtBottom = true;   // packed is a layout of the bottom section
  (state.lanes || []).forEach((lane, laneIdx) => {
    if (typeof laneFilter === "function" ? !laneFilter(lane) : (laneFilter && lane.id !== laneFilter)) return;
    const allBars = lane.bars || [];
    const shown = barFilter ? allBars.filter(b => barFilter(b, lane)) : allBars;
    if (barFilter && allBars.length && !shown.length) return;   // every task filtered out → hide the WP
    const isCollapsed = collapsed.has(lane.id);
    let bars = shown;
    if (milestonesAtBottom) {
      for (const b of shown) if (b.type === "milestone" && !isCollapsed) msTail.push({ bar: b, lane, laneIdx });
      const tasks = shown.filter(b => b.type !== "milestone");
      if (!tasks.length && shown.length) return;      // a WP of only milestones: they all live in the bottom section
      bars = tasks;
    }
    // laneHeaders:false drops the WP header row of expanded WPs that have tasks (collapsed and empty WPs keep one).
    if (laneHeaders || isCollapsed || !bars.length) {
      rows.push({ kind: "lane", laneId: lane.id, laneIdx, y, h: ALT_LANE_H, collapsed: isCollapsed });
      y += ALT_LANE_H;
    }
    if (isCollapsed) return;
    if (!bars.length) {
      rows.push({ kind: "empty", laneId: lane.id, laneIdx, y, h: ALT_ROW_H });
      y += ALT_ROW_H;
      return;
    }
    for (const bar of bars) {
      const rh = bar.type === "milestone" ? ALT_MS_ROW_H : ALT_ROW_H;
      rows.push({ kind: "bar", laneId: lane.id, laneIdx, barId: bar.id, y, h: rh });
      const r = altBarRect(bar, colW, y, lane.id, rh);
      rects.push(r); rectById[bar.id] = r;
      y += rh;
    }
    // Without a header row a WP with a single task would be too short for its name strip: give it the height of two task rows (the extra room goes below the task).
    if (!laneHeaders) {
      const last = rows[rows.length - 1], first = rows.find(r => r.kind === "bar" && r.laneId === lane.id);
      const used = last.y + last.h - first.y, min = 2 * ALT_ROW_H;
      if (used < min) { last.h += min - used; y += min - used; }
    }
  });
  if (msTail.length) {
    rows.push({ kind: "section", laneId: null, laneIdx: -1, y, h: ALT_LANE_H, title: "Milestones" });
    y += ALT_LANE_H;
    msTail.sort((a, b) => (a.bar.startIdx - b.bar.startIdx) || (a.laneIdx - b.laneIdx));
    if (milestonesPacked) {
      // Beta "Packed": milestones are points, so share rows. Each takes its diamond + its "WPn · name" label (msLabelW(bar, laneIdx) px) and goes on the first row where that span is free.
      const labW = typeof msLabelW === "function" ? msLabelW : ((b) => String(b.label || "").length * 6.4 + 36);
      const packRows = [];   // [{ end, items: [{bar,lane,laneIdx}] }]
      for (const it of msTail) {
        const tw = typeof msTagW === "function" ? msTagW(it.bar) : ALT_MS_WIDE_W;
        const rr = altBarRect(it.bar, colW, 0, it.lane.id, ALT_ROW_H, { wide: true, tagW: tw });
        const x0 = rr.x - 3, x1 = rr.x + rr.w + 8 + labW(it.bar, it.laneIdx);
        let row = packRows.find(r => r.end + 6 <= x0);
        if (!row) { row = { end: -Infinity, items: [] }; packRows.push(row); }
        row.items.push(it); row.end = x1;
      }
      for (const pr of packRows) {
        rows.push({ kind: "mspack", laneId: null, laneIdx: -1, barIds: pr.items.map(i => i.bar.id), y, h: ALT_ROW_H, tail: true });
        for (const { bar, lane } of pr.items) { const r = altBarRect(bar, colW, y, lane.id, ALT_ROW_H, { wide: true, tagW: typeof msTagW === "function" ? msTagW(bar) : ALT_MS_WIDE_W }); rects.push(r); rectById[bar.id] = r; }
        y += ALT_ROW_H;
      }
    } else
    for (const { bar, lane, laneIdx } of msTail) {
      rows.push({ kind: "bar", laneId: lane.id, laneIdx, barId: bar.id, y, h: ALT_ROW_H, tail: true });
      const r = altBarRect(bar, colW, y, lane.id);
      rects.push(r); rectById[bar.id] = r;
      y += ALT_ROW_H;
    }
  }
  const numMonths = monthsBetween(state.start, state.end).length;
  return { rows, rects, rectById, width: numMonths * colW, height: y, numMonths };
}

export function altRowAt(rows, y) {
  for (const r of rows) if (y >= r.y && y < r.y + r.h) return r;
  return null;
}
export function altWeekAt(x, colW) { return x / colW * WEEKS_PER_MONTH; }

/* Which bar (and which part of it) is under (x, y)? Returns null or
   { barId, laneId, zone: "l" | "r" | "body" | "ms", rel (0..1 across the bar),
     locked, milestone, linked, ongoing, done }. Edge zones shrink to a third of
   a narrow bar so the body stays grabbable. */
export function altHitTest(rects, x, y, { edgePx = ALT_EDGE_PX, slop = 2 } = {}) {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    const pad = r.milestone ? slop + 2 : 0;
    if (x < r.x - pad || x > r.x + r.w + pad || y < r.y - slop || y > r.y + r.h + slop) continue;
    const out = {
      barId: r.barId, laneId: r.laneId, locked: r.locked, milestone: r.milestone,
      linked: r.linked, ongoing: r.ongoing, done: r.done,
      rel: r.w > 0 ? Math.max(0, Math.min(1, (x - r.x) / r.w)) : 0.5,
    };
    if (r.milestone) return { ...out, zone: "ms" };
    const edge = Math.min(edgePx, r.w / 3);
    if (x - r.x <= edge) return { ...out, zone: "l" };
    if (r.x + r.w - x <= edge) return { ...out, zone: "r" };
    return { ...out, zone: "body" };
  }
  return null;
}

export function altNormBox(x0, y0, x1, y1) {
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

/* Marquee: ids of bars whose rectangle intersects the box. mode "replace"
   returns just the hits; "add" unions with `current`; "toggle" XORs. */
export function altMarqueeSelect(rects, box, mode = "replace", current = []) {
  const b = altNormBox(box.x0, box.y0, box.x1, box.y1);
  const hits = rects.filter(r => r.x <= b.x1 && r.x + r.w >= b.x0 && r.y <= b.y1 && r.y + r.h >= b.y0).map(r => r.barId);
  if (mode === "add") return [...new Set([...current, ...hits])];
  if (mode === "toggle") {
    const cur = new Set(current);
    for (const id of hits) { if (cur.has(id)) cur.delete(id); else cur.add(id); }
    return [...cur];
  }
  return hits;
}

/* Click selection: plain = just this one; shift = add; cmd/ctrl = toggle. */
export function altSelectClick(selection, id, { shift = false, meta = false } = {}) {
  const sel = Array.isArray(selection) ? selection : [];
  if (shift) return sel.includes(id) ? sel : [...sel, id];
  if (meta) return sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id];
  return [id];
}

/* ---------- Snapping ---------- */

export function altSnapGrid(weeks, grid) {
  const g = ALT_GRIDS[grid] === undefined ? 1 : ALT_GRIDS[grid];
  return g ? Math.round(weeks / g) * g : weeks;
}

/* Start/end positions (in weeks from project start) of every bar except
   `exclude` — the magnets for edge snapping. */
export function altEdgeWeeks(state, exclude = new Set()) {
  const out = new Set();
  for (const lane of state.lanes || []) {
    for (const b of lane.bars || []) {
      if (exclude.has(b.id)) continue;
      const s = (b.startIdx || 0) * WEEKS_PER_MONTH;
      out.add(s);
      if (b.type !== "milestone") out.add(s + effSpan(b));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/* Snap a single position (weeks): nearest edge within thresholdW wins,
   otherwise the grid. */
export function altSnapPoint(weeks, { grid = "week", edges = [], thresholdW = 0.5, disable = false } = {}) {
  if (disable) return { weeks, kind: null };
  let best = null;
  for (const e of edges) {
    const d = Math.abs(e - weeks);
    if (d <= thresholdW && (best === null || d < best.d)) best = { d, e };
  }
  if (best) return { weeks: best.e, kind: "edge" };
  const g = altSnapGrid(weeks, grid);
  return { weeks: g, kind: g === weeks ? null : "grid" };
}

/* Snap a drag that moves a bar of calendar length effW from startW by dW:
   try both its start and its end against the edges, else grid-snap the start.
   Returns { dW, kind, atW } (atW = the snapped guide position, for drawing). */
export function altSnapMove({ startW, effW }, dW, opts = {}) {
  if (opts.disable) return { dW, kind: null, atW: null };
  const raw = startW + dW;
  let best = null;
  for (const e of opts.edges || []) {
    for (const off of [0, effW]) {
      const d = Math.abs(raw + off - e);
      if (d <= (opts.thresholdW ?? 0.5) && (best === null || d < best.d)) best = { d, shift: e - (raw + off), at: e };
    }
  }
  if (best) return { dW: dW + best.shift, kind: "edge", atW: best.at };
  const g = altSnapGrid(raw, opts.grid || "week");
  return { dW: g - startW, kind: g === raw ? null : "grid", atW: null };
}

/* ---------- Zoom ---------- */

export const ALT_ZOOM_MIN = 15, ALT_ZOOM_MAX = 400;
export function altZoomColW(colW, dir, factor = 1.25) {
  const next = dir === "out" ? colW / factor : colW * factor;
  return Math.max(ALT_ZOOM_MIN, Math.min(ALT_ZOOM_MAX, Math.round(next)));
}
/* Column width that makes the x-range [x0, x1] (in current canvas px) fill viewportW. */
export function altZoomToRange(colW, x0, x1, viewportW) {
  const span = Math.abs(x1 - x0);
  if (span < 8) return { colW, scrollLeft: null };
  const next = Math.max(ALT_ZOOM_MIN, Math.min(ALT_ZOOM_MAX, Math.round(colW * viewportW / span)));
  return { colW: next, scrollLeft: Math.min(x0, x1) * (next / colW) };
}

/* ---------- View presets (Alt timeline View card) ---------- */

/* The view settings a preset can drive. Keys: months (0 = whole project), deps ('all'|'routed'|'markers'), names (task names in the left list),
   msBottom (milestones in a bottom section), today / arrows / compact / weeks (Display toggles). */
export const VIEW_DEFAULTS = Object.freeze({ months: 0, deps: 'all', names: false, msBottom: false, today: true, arrows: true, compact: false, weeks: false });
/* A preset lists only the keys it cares about; the others are left alone when applying and ignored when matching. */
export const VIEW_PRESETS = Object.freeze([
  Object.freeze({ id: 'planning', label: 'Planning', desc: '12 months, curved links, task names shown, today line on', settings: Object.freeze({ months: 12, deps: 'all', names: true, today: true, arrows: true }) }),
  Object.freeze({ id: 'review', label: 'Review', desc: '24 months, jump markers, names hidden, milestones at the bottom', settings: Object.freeze({ months: 24, deps: 'markers', names: false, msBottom: true }) }),
  Object.freeze({ id: 'presentation', label: 'Presentation', desc: 'Whole project, no arrows, compact labels, names hidden, week numbers off', settings: Object.freeze({ months: 0, arrows: false, compact: true, names: false, weeks: false }) }),
]);
export function viewPresetById(id) { return VIEW_PRESETS.find(p => p.id === id) || null; }
/* Which preset do these settings match? The one with the most keys wins a tie between overlapping presets; 'custom' when none. */
export function matchViewPreset(settings) {
  const s = settings || {};
  let best = null;
  for (const p of VIEW_PRESETS) {
    const keys = Object.keys(p.settings);
    if (!keys.every(k => s[k] === p.settings[k])) continue;
    if (!best || keys.length > Object.keys(best.settings).length) best = p;
  }
  return best ? best.id : 'custom';
}
/* The settings to change (only keys that differ from `current`) to apply a preset; null for an unknown id. */
export function viewPresetPatch(id, current) {
  const p = viewPresetById(id); if (!p) return null;
  const cur = current || {}, out = {};
  for (const k of Object.keys(p.settings)) if (cur[k] !== p.settings[k]) out[k] = p.settings[k];
  return out;
}
/* ---------- Months shown (Alt timeline zoom) ----------
   The Alt canvas does not store a px/month zoom: the user picks how many MONTHS are visible (0 = whole project) and the
   column width is derived so exactly that many fill the plot. */
export const ALT_MONTHS_MIN = 1, ALT_MONTHS_MAX = 60;
export const ALT_MONTHS_LADDER = Object.freeze([1, 2, 3, 4, 6, 9, 12, 18, 24, 36, 48, 60]);
export const ALT_COLW_MIN = 6;
/* Integer 1..60, or 0 (= whole project) for 0 / negative / non-numeric input. */
export function altClampMonths(n) {
  const v = typeof n === 'number' ? n : parseFloat(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.max(ALT_MONTHS_MIN, Math.min(ALT_MONTHS_MAX, Math.round(v)));
}
/* The months actually shown: 0 or >= the project length means the whole project. */
export function altEffMonths(n, projectMonths) {
  const pm = Math.max(1, Math.floor(projectMonths) || 1), c = altClampMonths(n);
  return c === 0 || c >= pm ? pm : c;
}
/* Column width (px per month) that makes n months exactly fill viewportPx (the visible plot width). */
export function altColWForMonths(viewportPx, n, minW = ALT_COLW_MIN) {
  const m = Math.max(1, Math.round(n) || 1);
  return Math.max(minW, Math.floor((Number(viewportPx) || 0) / m));
}
/* One step on the ladder: 'in' = fewer months, 'out' = more (past the project length = 0, the whole project). */
export function altMonthsStep(n, dir, projectMonths = 0) {
  const pm = Math.max(0, Math.floor(projectMonths) || 0);
  const cur = altClampMonths(n) || pm || ALT_MONTHS_MAX;
  if (dir === 'in') {
    const lower = ALT_MONTHS_LADDER.filter(x => x < cur);
    return lower.length ? lower[lower.length - 1] : ALT_MONTHS_MIN;
  }
  if (altClampMonths(n) === 0) return 0;
  const higher = ALT_MONTHS_LADDER.find(x => x > cur);
  if (higher === undefined) return pm && pm <= ALT_MONTHS_MAX ? 0 : ALT_MONTHS_MAX;
  return pm && higher >= pm ? 0 : higher;
}
/* Months covered by a dragged span of spanPx at the current column width (>= 1). */
export function altMonthsForSpan(spanPx, colW) { return altClampMonths(Math.max(1, Math.round(Math.abs(spanPx) / Math.max(1, colW)))); }
/* Text from the months field: "all" / "0" -> 0, a number -> clamped 1..60, anything else -> null. */
export function altParseMonths(text) {
  const t = String(text == null ? '' : text).trim().toLowerCase();
  if (t === 'all' || t === 'fit') return 0;
  if (!/^\d+([.,]\d+)?$/.test(t)) return null;
  return altClampMonths(parseFloat(t.replace(',', '.')));
}
/* "Fit": how many months to show so the plan fits with one month to spare — the month the last task ends in,
   plus one. `include(bar, lane)` limits it to what is shown (filters). Ongoing bars (they span the whole project)
   are ignored. Returns 0 (= whole project) when there is nothing to fit. Examples: last task ends 10.3 months in
   (month 11) -> 12; ends exactly at month 10 -> 11. */
export function altFitMonths(state, include = null) {
  let end = 0;
  for (const lane of state.lanes || []) {
    for (const bar of lane.bars || []) {
      if (!bar || bar.type === 'ongoing') continue;
      if (typeof include === 'function' && !include(bar, lane)) continue;
      const e = (bar.startIdx || 0) + (bar.type === 'milestone' ? 0 : effSpan(bar) / WEEKS_PER_MONTH);
      if (e > end) end = e;
    }
  }
  if (end <= 0) return 0;
  return altClampMonths(Math.max(1, Math.ceil(end - 1e-9)) + 1);
}
/* Quick presets shown under the stepper (0 = All). */
export const VIEW_MONTH_PRESETS = Object.freeze([
  Object.freeze({ id: 'm3', label: '3', months: 3 }), Object.freeze({ id: 'm6', label: '6', months: 6 }),
  Object.freeze({ id: 'm12', label: '12', months: 12 }), Object.freeze({ id: 'm24', label: '24', months: 24 }),
  Object.freeze({ id: 'all', label: 'All', months: 0 }),
]);

/* ---------- Gesture decision table ---------- */

/* What does pressing the mouse do, given the active tool, what is under the
   cursor (altHitTest result or null), the row under it (altRowAt or null) and
   modifier keys? Returns { kind, ... }:
     none | blocked{why} | select{drag:false?, why?} | move | resize-l | resize-r |
     marquee{mode} | draw{laneId, afterBarId} | milestone-drop{laneId, afterBarId} |
     milestone-at-end{barId} | link{fromId} | split{barId} | toggle-lock{barId} |
     toggle-done{barId} | pan | zoom-rect | zoom-out
   `select` with drag:false means "click selects but the bar can't be dragged"
   (why: locked | auto | linked | view-only). */
export function altBeginGesture(toolId, hit, mods = {}, row = null, { editMode = false } = {}) {
  const tool = altToolById(toolId) || altToolById("select");
  if (tool.edit && !editMode) return { kind: "blocked", why: "view-only" };
  const marqueeMode = mods.shift ? "add" : (mods.meta || mods.ctrl) ? "toggle" : "replace";
  const frozen = (h) => h.locked ? "locked" : h.ongoing ? "auto" : (h.milestone && h.linked) ? "linked" : null;
  switch (tool.id) {
    case "hand": return { kind: "pan" };
    case "zoom": return { kind: mods.alt ? "zoom-out" : "zoom-rect" };
    case "done":
      if (!hit) return { kind: "none" };
      return { kind: "toggle-done", barId: hit.barId };
    case "select": {
      if (!hit) return { kind: "marquee", mode: marqueeMode };
      if (!editMode) return { kind: "select", drag: false, why: "view-only" };
      const why = frozen(hit);
      if (why) return { kind: "select", drag: false, why };
      if (!hit.milestone && hit.zone === "l") return { kind: "resize-l" };
      if (!hit.milestone && hit.zone === "r") return { kind: "resize-r" };
      return { kind: "move" };
    }
    case "resize": {
      if (!hit || hit.milestone) return { kind: "none" };
      const why = frozen(hit);
      if (why) return { kind: "blocked", why };
      return { kind: hit.rel < 0.5 ? "resize-l" : "resize-r" };
    }
    case "draw":
      if (hit) return { kind: "select", drag: false };
      if (!row) return { kind: "none" };
      return { kind: "draw", laneId: row.laneId, afterBarId: row.barId || null };
    case "milestone":
      if (hit && hit.milestone) return { kind: "select", drag: false };
      if (hit) return { kind: "milestone-at-end", barId: hit.barId };
      if (!row) return { kind: "none" };
      return { kind: "milestone-drop", laneId: row.laneId, afterBarId: row.barId || null };
    case "link":
      return hit ? { kind: "link", fromId: hit.barId } : { kind: "none" };
    case "split": {
      if (!hit || hit.milestone) return { kind: "none" };
      const why = frozen(hit);
      return why ? { kind: "blocked", why } : { kind: "split", barId: hit.barId };
    }
    case "lock":
      if (!hit) return { kind: "none" };
      return { kind: "toggle-lock", barId: hit.barId };
  }
  return { kind: "none" };
}

export const ALT_CURSORS = {
  select: "default", move: "grab", "resize-l": "ew-resize", "resize-r": "ew-resize",
  marquee: "crosshair", draw: "crosshair", "milestone-drop": "copy", "milestone-at-end": "copy",
  link: "alias", split: "col-resize", "toggle-lock": "pointer", "toggle-done": "pointer",
  pan: "grab", "zoom-rect": "zoom-in", "zoom-out": "zoom-out", blocked: "not-allowed", none: "default",
};

/* ---------- Operations ---------- */

/* Why a bar can't be dragged/trimmed/cut/deleted, or null if it can. */
export function altFrozenReason(bar) {
  if (!bar) return "missing";
  if (bar.locked) return "locked";
  if (bar.type === "ongoing") return "auto";
  if (bar.followsEndOf) return "linked";
  return null;
}

/* Capture the pre-gesture geometry of the given bars. */
export function altSnapshot(state, ids) {
  const map = buildBarMap(state);
  const snap = {};
  for (const id of ids) {
    const e = map[id]; if (!e) continue;
    snap[id] = { startIdx: e.bar.startIdx || 0, span: e.bar.span || 0, buffer: e.bar.buffer || 0 };
  }
  return snap;
}

/* Move every unfrozen bar in `snap` by dWeeks from its snapshot position. The
   group is clamped as one so relative offsets survive (can't push anything
   before the project start / past the last month). */
export function altMoveBars(state, snap, dWeeks, { numMonths = null } = {}) {
  const map = buildBarMap(state);
  const movers = []; const blocked = [];
  for (const id of Object.keys(snap)) {
    const e = map[id]; if (!e) continue;
    const why = altFrozenReason(e.bar);
    if (why) blocked.push({ id, reason: why }); else movers.push(id);
  }
  let lo = -Infinity, hi = Infinity;
  for (const id of movers) {
    const s0 = snap[id].startIdx * WEEKS_PER_MONTH;
    const b = map[id].bar;
    const e0 = s0 + (b.type === "milestone" ? 0 : effSpan({ ...b, span: snap[id].span, buffer: snap[id].buffer }));
    lo = Math.max(lo, -s0);
    if (numMonths != null) hi = Math.min(hi, numMonths * WEEKS_PER_MONTH - e0);
  }
  const d = movers.length ? Math.max(lo, Math.min(hi, dWeeks)) : 0;
  for (const id of movers) map[id].bar.startIdx = snap[id].startIdx + d / WEEKS_PER_MONTH;
  return { moved: movers, blocked, dWeeks: d };
}

/* Drag one edge of a bar. `dWeeks` is in CALENDAR (effective) weeks; the raw
   span is derived through the bar's buffer so the visual edge follows the pointer. */
export function altResizeBar(state, snap, id, edge, dWeeks, { numMonths = null } = {}) {
  const e = buildBarMap(state)[id];
  if (!e) return { ok: false, reason: "missing" };
  const bar = e.bar;
  if (bar.type === "milestone") return { ok: false, reason: "milestone" };
  const why = altFrozenReason(bar);
  if (why) return { ok: false, reason: why };
  const o = snap[id] || { startIdx: bar.startIdx, span: bar.span, buffer: bar.buffer };
  const f = 1 + (o.buffer || 0) / 100;
  const s0 = o.startIdx * WEEKS_PER_MONTH;
  const eff0 = o.span * f;
  if (edge === "r") {
    let eff = Math.max(ALT_MIN_EFF_WEEKS, eff0 + dWeeks);
    if (numMonths != null) eff = Math.max(ALT_MIN_EFF_WEEKS, Math.min(eff, numMonths * WEEKS_PER_MONTH - s0));
    bar.span = eff / f;
    return { ok: true, startIdx: bar.startIdx, effWeeks: eff };
  }
  const d = Math.max(-s0, Math.min(eff0 - ALT_MIN_EFF_WEEKS, dWeeks));
  bar.startIdx = (s0 + d) / WEEKS_PER_MONTH;
  bar.span = (eff0 - d) / f;
  return { ok: true, startIdx: bar.startIdx, effWeeks: eff0 - d };
}

function altValidTrack(state, id) { return !!getTrackById(state, id); }

/* New bar in `laneId` (after `afterBarId` when given, else at the end).
   opts: type (not "ongoing"), startIdx, span (weeks), label, buffer, alloc,
   phase, track, discipline. Returns the bar, or null for an unknown lane. */
export function altCreateBar(state, laneId, opts = {}) {
  const lane = (state.lanes || []).find(l => l.id === laneId);
  if (!lane) return null;
  const type = (TYPES[opts.type] && opts.type !== "ongoing") ? opts.type : "work";
  const ms = type === "milestone";
  const bar = {
    id: bid(), type,
    startIdx: Math.max(0, Number.isFinite(opts.startIdx) ? opts.startIdx : 0),
    span: ms ? 0 : Math.max(ALT_MIN_EFF_WEEKS / 2, Number.isFinite(opts.span) ? opts.span : WEEKS_PER_MONTH),
    label: typeof opts.label === "string" && opts.label.trim() ? opts.label.trim() : (ms ? "New milestone" : "New task"),
    dependsOn: [],
    buffer: ms ? 0 : (Number.isFinite(opts.buffer) && opts.buffer >= 0 ? opts.buffer : 10),
    alloc: Number.isFinite(opts.alloc) && opts.alloc >= 0 && opts.alloc <= 100 ? opts.alloc : 100,
  };
  const procCodes = getProcess(state).codes;
  const phase = opts.phase !== undefined ? opts.phase : lane.phase;
  if (phase && procCodes.includes(phase)) bar.phase = phase;
  if (opts.track && altValidTrack(state, opts.track)) bar.track = opts.track;
  if (opts.discipline && (opts.discipline === "_none" || getDisciplineById(state, opts.discipline))) bar.discipline = opts.discipline;
  const idx = opts.afterBarId ? lane.bars.findIndex(b => b.id === opts.afterBarId) : -1;
  if (idx >= 0) lane.bars.splice(idx + 1, 0, bar); else lane.bars.push(bar);
  return bar;
}

/* Milestone glued to the end of `barId` (same mechanism as the context menu's
   "Add milestone at end": followsEndOf, no dependency arrow). */
export function altAddEndMilestone(state, barId) {
  const e = buildBarMap(state)[barId];
  if (!e || e.bar.type === "milestone") return null;
  const ms = altCreateBar(state, e.lane.id, {
    type: "milestone", label: `${e.bar.label || "Activity"} — Done`,
    phase: e.bar.phase || null, afterBarId: barId,
  });
  if (!ms) return null;
  ms.followsEndOf = barId;
  if (Array.isArray(e.bar.tracks) && e.bar.tracks.length) ms.tracks = e.bar.tracks.slice();
  else if (e.bar.track) ms.track = e.bar.track;
  syncFollowsEndOf(state);
  return ms;
}

/* Cut a bar in two at `atWeeks` (calendar weeks from the bar's own start).
   The second half becomes a new bar right after it ("<label> — part 2") that
   depends on the first; successors and follow-end milestones move to the
   second half. Returns { ok, newId } or { ok:false, error }. */
export function altSplitBar(state, barId, atWeeks, { gapWeeks = 0 } = {}) {
  const map = buildBarMap(state);
  const e = map[barId];
  if (!e) return { ok: false, error: "missing" };
  const bar = e.bar;
  if (bar.type === "milestone") return { ok: false, error: "milestone" };
  const why = altFrozenReason(bar);
  if (why) return { ok: false, error: why };
  const eff = effSpan(bar);
  const cut = Math.round(atWeeks * 2) / 2;
  if (!(cut >= ALT_MIN_EFF_WEEKS && cut <= eff - ALT_MIN_EFF_WEEKS)) return { ok: false, error: "too-short" };
  const f = eff / bar.span;                    // raw -> calendar factor (1 + buffer/100)
  const rawFirst = cut / f;
  const rawSecond = bar.span - rawFirst;
  const second = {
    ...bar,
    id: bid(),
    label: `${bar.label || "Task"} — part 2`,
    startIdx: bar.startIdx + (cut + Math.max(0, gapWeeks)) / WEEKS_PER_MONTH,
    span: rawSecond,
    dependsOn: [bar.id],
  };
  delete second.done; delete second.doneAt; delete second.status; delete second.locked; delete second.followsEndOf; delete second.phaseEnd;
  bar.span = rawFirst;
  const i = e.lane.bars.indexOf(bar);
  e.lane.bars.splice(i + 1, 0, second);
  for (const lane of state.lanes) {
    for (const b of lane.bars) {
      if (b === second || b === bar) continue;
      if ((b.dependsOn || []).includes(bar.id)) b.dependsOn = b.dependsOn.map(d => d === bar.id ? second.id : d);
      if (b.followsEndOf === bar.id) b.followsEndOf = second.id;
    }
  }
  // A bleed (phaseEnd) belongs to the tail, not the head.
  if (bar.phaseEnd) { second.phaseEnd = bar.phaseEnd; delete bar.phaseEnd; }
  syncFollowsEndOf(state);
  return { ok: true, newId: second.id };
}

/* Add predecessor → successor. error: self | missing | exists | cycle. */
export function altLinkBars(state, predId, succId) {
  if (predId === succId) return { ok: false, error: "self" };
  const map = buildBarMap(state);
  const succ = map[succId]; const pred = map[predId];
  if (!succ || !pred) return { ok: false, error: "missing" };
  if (!Array.isArray(succ.bar.dependsOn)) succ.bar.dependsOn = [];
  if (succ.bar.dependsOn.includes(predId)) return { ok: false, error: "exists" };
  if (createsCycle(succId, predId, map)) return { ok: false, error: "cycle" };
  succ.bar.dependsOn.push(predId);
  return { ok: true };
}
export function altUnlinkBars(state, predId, succId) {
  const e = buildBarMap(state)[succId];
  if (!e || !(e.bar.dependsOn || []).includes(predId)) return { ok: false };
  e.bar.dependsOn = e.bar.dependsOn.filter(d => d !== predId);
  return { ok: true };
}

/* Delete bars (locked ones are protected) and scrub every reference to them.
   Returns { removed: [ids], skipped: [{id, reason}] }. */
export function altDeleteBars(state, ids) {
  const map = buildBarMap(state);
  const want = new Set(ids); const removed = new Set(); const skipped = [];
  for (const id of want) {
    const e = map[id]; if (!e) continue;
    if (e.bar.locked) { skipped.push({ id, reason: "locked" }); continue; }
    removed.add(id);
  }
  if (!removed.size) return { removed: [], skipped };
  for (const lane of state.lanes) {
    lane.bars = lane.bars.filter(b => !removed.has(b.id));
    for (const b of lane.bars) {
      if (b.dependsOn) b.dependsOn = b.dependsOn.filter(d => !removed.has(d));
      if (b.followsEndOf && removed.has(b.followsEndOf)) delete b.followsEndOf;
    }
  }
  return { removed: [...removed], skipped };
}

/* Copy bars next to their originals (same lane, right after), shifted later by
   `offsetWeeks` (default: their own length). Copies are never locked/done and
   keep their predecessors. Returns the new ids. */
export function altDuplicateBars(state, ids, { offsetWeeks = null } = {}) {
  const map = buildBarMap(state);
  const out = [];
  for (const id of ids) {
    const e = map[id]; if (!e) continue;
    const b = e.bar;
    if (b.type === "ongoing") continue;
    const shift = offsetWeeks != null ? offsetWeeks : Math.max(1, effSpan(b));
    const copy = {
      ...b, id: bid(), dependsOn: [...(b.dependsOn || [])],
      startIdx: (b.startIdx || 0) + shift / WEEKS_PER_MONTH,
    };
    delete copy.done; delete copy.doneAt; delete copy.status; delete copy.locked; delete copy.followsEndOf;
    if (b.tracks) copy.tracks = b.tracks.slice();
    e.lane.bars.splice(e.lane.bars.indexOf(b) + 1, 0, copy);
    out.push(copy.id);
  }
  return out;
}

/* Fields the options bar / inspector can bulk-apply. */
export const ALT_BULK_FIELDS = ["type", "span", "buffer", "alloc", "phase", "track", "discipline", "locked"];

/* Apply `patch` to every bar in `ids`. Only keys present in the patch are
   touched, and invalid values are ignored (counted in `invalid`). Locked bars
   accept only the `locked` field. Fields that make no sense for a bar (span /
   buffer / alloc on a milestone) are skipped. Returns
   { changed, skippedLocked, invalid }. */
export function altBulkEdit(state, ids, patch) {
  const map = buildBarMap(state);
  const codes = getProcess(state).codes;
  let changed = 0, skippedLocked = 0, invalid = 0;
  for (const id of ids) {
    const e = map[id]; if (!e) continue;
    const b = e.bar;
    let touched = false;
    const only = b.locked ? { locked: patch.locked } : patch;
    if (b.locked && Object.keys(patch).some(k => k !== "locked")) skippedLocked++;
    for (const [k, v] of Object.entries(only)) {
      if (v === undefined) continue;
      const ms = b.type === "milestone";
      if (k === "type") {
        if (!TYPES[v] || v === "ongoing" || b.type === "ongoing" || v === b.type) { if (v !== b.type) invalid++; continue; }
        b.type = v;
        if (v === "milestone") { b.span = 0; } else if (!(b.span > 0)) { b.span = WEEKS_PER_MONTH; }
        touched = true;
      } else if (k === "span") {
        if (ms || b.type === "ongoing") continue;
        if (!(Number.isFinite(v) && v >= ALT_MIN_EFF_WEEKS / 2)) { invalid++; continue; }
        if (b.span !== v) { b.span = v; touched = true; }
      } else if (k === "buffer") {
        if (ms || b.type === "ongoing") continue;
        if (!(Number.isFinite(v) && v >= 0)) { invalid++; continue; }
        if (b.buffer !== v) { b.buffer = v; touched = true; }
      } else if (k === "alloc") {
        if (ms) continue;
        if (!(Number.isFinite(v) && v >= 0 && v <= 100)) { invalid++; continue; }
        if (b.alloc !== v) { b.alloc = v; touched = true; }
      } else if (k === "phase") {
        if (v !== "" && v !== null && !codes.includes(v)) { invalid++; continue; }
        const nv = v || undefined;
        if (b.phase !== nv) { if (nv) b.phase = nv; else { delete b.phase; delete b.phaseEnd; } touched = true; }
      } else if (k === "track") {
        if (v && !altValidTrack(state, v)) { invalid++; continue; }
        if (v) { b.track = v; delete b.tracks; } else { delete b.track; delete b.tracks; }
        touched = true;
      } else if (k === "discipline") {
        if (v && v !== "_none" && !getDisciplineById(state, v)) { invalid++; continue; }
        if (v) b.discipline = v; else delete b.discipline;
        touched = true;
      } else if (k === "locked") {
        const nv = !!v;
        if (!!b.locked !== nv) { if (nv) b.locked = true; else delete b.locked; touched = true; }
      }
    }
    if (touched) changed++;
  }
  return { changed, skippedLocked, invalid };
}

/* Align the selection's unfrozen bars to its earliest start ("start") or
   latest end ("end"). Returns the ids that moved. */
export function altAlignBars(state, ids, mode) {
  const map = buildBarMap(state);
  const bars = ids.map(id => map[id] && map[id].bar).filter(Boolean);
  if (bars.length < 2) return [];
  const startOf = (b) => (b.startIdx || 0) * WEEKS_PER_MONTH;
  const endOf = (b) => startOf(b) + (b.type === "milestone" ? 0 : effSpan(b));
  const moved = [];
  if (mode === "end") {
    const target = Math.max(...bars.map(endOf));
    for (const b of bars) {
      if (altFrozenReason(b)) continue;
      const ns = (target - (b.type === "milestone" ? 0 : effSpan(b))) / WEEKS_PER_MONTH;
      if (ns !== b.startIdx) { b.startIdx = ns; moved.push(b.id); }
    }
  } else {
    const target = Math.min(...bars.map(startOf)) / WEEKS_PER_MONTH;
    for (const b of bars) {
      if (altFrozenReason(b)) continue;
      if (target !== b.startIdx) { b.startIdx = target; moved.push(b.id); }
    }
  }
  return moved;
}

/* Inspector / options-bar read side: for a selection, each bulk field's value
   or { mixed: true } when the bars disagree. */
export function altSelectionSummary(state, ids) {
  const map = buildBarMap(state);
  const bars = ids.map(id => map[id] && map[id].bar).filter(Boolean);
  const fieldVal = {
    type: b => b.type, span: b => b.span || 0, buffer: b => b.buffer || 0,
    alloc: b => (typeof b.alloc === "number" ? b.alloc : 100),
    phase: b => b.phase || "",
    track: b => (Array.isArray(b.tracks) && b.tracks.length ? b.tracks.join(",") : (b.track || "")),
    discipline: b => b.discipline || "",
    locked: b => !!b.locked, done: b => !!b.done,
  };
  const values = {};
  for (const [k, fn] of Object.entries(fieldVal)) {
    const set = new Set(bars.map(fn));
    values[k] = set.size <= 1 ? { value: bars.length ? [...set][0] : null, mixed: false } : { value: null, mixed: true };
  }
  let effWeeks = 0, startW = Infinity, endW = -Infinity;
  for (const b of bars) {
    const s = (b.startIdx || 0) * WEEKS_PER_MONTH;
    const e = s + (b.type === "milestone" ? 0 : effSpan(b));
    if (b.type !== "milestone") effWeeks += effSpan(b);
    startW = Math.min(startW, s); endW = Math.max(endW, e);
  }
  return {
    count: bars.length,
    lanes: new Set(ids.map(id => map[id] && map[id].lane.id).filter(Boolean)).size,
    effWeeks, startW: bars.length ? startW : null, endW: bars.length ? endW : null,
    values,
  };
}

/* ISO start/end date of a bar (UTC date strings) from the project start; a
   fractional month counts in 7-day weeks (0.25 month = 1 week). */
export function altBarDates(state, bar) {
  const p = parseYM(state.start);
  const idx = bar.startIdx || 0;
  const wholeM = Math.floor(idx);
  const weeks = Math.round((idx - wholeM) * WEEKS_PER_MONTH);
  const start = new Date(Date.UTC(p.y, p.m - 1 + wholeM, p.d || 1) + weeks * 7 * 86400000);
  const end = new Date(start.getTime() + (bar.type === "milestone" ? 0 : Math.round(effSpan(bar) * 7) * 86400000));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}
/* Inverse for the date picker: ISO day -> startIdx (months, whole-week quantised). */
/* The calendar day a position `idx` (months from the project start, fractional) falls on: the month's first day + the fraction of that month's length. */
export function altDateAtIdx(state, idx) {
  const p = parseYM(state.start);
  const whole = Math.floor(idx), frac = idx - whole;
  const first = Date.UTC(p.y, p.m - 1 + whole, 1);
  const dim = new Date(Date.UTC(p.y, p.m + whole, 0)).getUTCDate();
  return new Date(first + Math.floor(frac * dim + 1e-9) * 86400000).toISOString().slice(0, 10);
}
/* The day a milestone is DRAWN on. Stand-alone milestones sit at the centre of their start-month column (+½ month, an app-wide convention); linked ones
   (followsEndOf) sit exactly at their activity's end. Use this — not altBarDates().start, which is the raw startIdx — wherever a milestone's date is shown next to where it is drawn. */
export function altMilestoneDate(state, bar) {
  return altDateAtIdx(state, (bar.startIdx || 0) + (bar.followsEndOf ? 0 : 0.5));
}
export function altStartIdxFromDate(state, isoDay) {
  const p = parseYM(state.start);
  const m = String(isoDay || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  let whole = (y - p.y) * 12 + (mo - p.m);
  const monthStart = Date.UTC(p.y, p.m - 1 + whole, p.d || 1);
  let days = (Date.UTC(y, mo - 1, d) - monthStart) / 86400000;
  // Day-of-month beyond the project start's day: fall back to week arithmetic.
  const weeks = Math.round(days / 7);
  return Math.max(0, whole + weeks / WEEKS_PER_MONTH);
}

/* ============================================================================
 * Versions & build tracking
 * package.json "version" is the single source of truth (semver). Every
 * `npm run build` stamps a BUILD_INFO object into the HTML and appends an
 * entry to build-info.json (scripts/build.mjs). These helpers are pure so
 * they can be unit-tested; the About dialog formats with the same code.
 * ========================================================================== */
export const BUILD_HISTORY_CAP = 50;

/** "1.2.3" or "1.2.3-beta.1" -> {major, minor, patch, pre}; null if invalid. */
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v == null ? "" : v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || "" };
}
/** Next version for kind "major" | "minor" | "patch". Throws on a bad version/kind. */
export function bumpVersion(version, kind) {
  const p = parseSemver(version);
  if (!p) throw new Error(`Not a semver version: ${version}`);
  if (kind === "major") return `${p.major + 1}.0.0`;
  if (kind === "minor") return `${p.major}.${p.minor + 1}.0`;
  if (kind === "patch") return `${p.major}.${p.minor}.${p.patch + 1}`;
  throw new Error(`Unknown bump kind: ${kind} (use major|minor|patch)`);
}
/** Negative / 0 / positive like a - b; invalid versions sort lowest. */
export function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
/** Short git label: "abc1234", "abc1234+dirty", or "unknown". */
export function formatCommit(commit, dirty) {
  const c = String(commit || "").trim();
  if (!c) return "unknown";
  return dirty ? `${c}+dirty` : c;
}
/** A history entry as stored in build-info.json. */
export function makeBuildEntry({ build, version, date, commit, dirty, branch, testsPassing } = {}) {
  const e = {
    build: Math.max(0, Math.floor(+build || 0)),
    version: String(version || ""),
    date: String(date || ""),
    commit: String(commit || ""),
    dirty: !!dirty,
    branch: String(branch || ""),
  };
  if (typeof testsPassing === "number" && isFinite(testsPassing)) e.testsPassing = testsPassing;
  return e;
}
/** Append an entry and keep only the newest `cap` (oldest dropped). Never mutates. */
export function appendBuildHistory(history, entry, cap = BUILD_HISTORY_CAP) {
  const list = Array.isArray(history) ? history.slice() : [];
  list.push(entry);
  const n = Math.max(1, Math.floor(cap) || BUILD_HISTORY_CAP);
  return list.length > n ? list.slice(list.length - n) : list;
}
/** Next build number given the persisted file ({lastBuild, history}). */
export function nextBuildNumber(info) {
  const last = info && Number.isFinite(+info.lastBuild) ? Math.floor(+info.lastBuild) : 0;
  const hist = info && Array.isArray(info.history) ? info.history.reduce((m, h) => Math.max(m, +h.build || 0), 0) : 0;
  return Math.max(last, hist) + 1;
}
/** "0.2.0 (build 7)" */
export function formatVersionLabel(info) {
  if (!info || !info.version) return "dev";
  return info.build ? `${info.version} (build ${info.build})` : String(info.version);
}
/** Multi-line plain text for the About dialog's "Copy build info". */
export function formatBuildInfo(info, appName = "ProPlan") {
  const i = info || {};
  const lines = [`${appName} ${i.version || "dev"}${i.build ? ` (build ${i.build})` : ""}`];
  if (i.date) lines.push(`Built: ${i.date}`);
  if (i.commit) lines.push(`Commit: ${formatCommit(i.commit, i.dirty)}${i.branch ? ` on ${i.branch}` : ""}`);
  else if (i.branch) lines.push(`Branch: ${i.branch}`);
  if (typeof i.testsPassing === "number") lines.push(`Tests passing: ${i.testsPassing}`);
  return lines.join("\n");
}
/** Keep-a-Changelog stub inserted by `npm run release:*`. */
export function changelogStub(version, day) {
  return `## [${version}] - ${day}\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n`;
}
/** Insert `entry` above the first "## [" heading (or append); idempotent per version. */
export function insertChangelogEntry(text, version, entry) {
  const src = String(text || "");
  if (src.includes(`## [${version}]`)) return src;
  const at = src.search(/^## \[/m);
  if (at < 0) return src.replace(/\s*$/, "\n\n") + entry + "\n";
  return src.slice(0, at) + entry + "\n" + src.slice(at);
}

/* =====================================================================
   Timeline controls (shared View bar)
   The .hdr-tier2 row (Start/End, Zoom, Track, Display, …) is shared by the
   classic Timeline (viewA) and the Alt timeline. "view" controls change what
   you look at and live in that one bar; "edit" controls change the plan and
   live in the bar on the classic Timeline but in the Alt options bar on the
   Alt timeline, so no control is ever shown twice. DOM ids are in `dom`.
   ===================================================================== */
export const TIMELINE_CONTROLS = Object.freeze([
  { id: "zoom",        group: "view", dom: "zoom",                low: false },
  { id: "fit",         group: "view", dom: "fitBtn",              low: false },
  { id: "exportImage", group: "view", dom: "exportImgBtn",        low: true  },
  { id: "collapseAll", group: "view", dom: "collapseAllBtn",      low: true  },
  { id: "display",     group: "view", dom: "displayMenu",         low: false },
  { id: "track",       group: "view", dom: "trackFilterControl",  low: false },
  { id: "disciplines", group: "view", dom: "disciplineFilterMenu", low: false },
  { id: "layout",      group: "view", dom: "layoutModeControl",   low: true  },
  { id: "focusWp",     group: "view", dom: "wpFocusSelect",       low: false },
  { id: "autoSeq",     group: "edit", dom: "autoSeq",             low: false, editOnly: true },
  { id: "undo",        group: "edit", dom: "undoBtn",             low: false, editOnly: true },
  { id: "redo",        group: "edit", dom: "redoBtn",             low: false, editOnly: true },
  { id: "editToggle",  group: "edit", dom: "viewOnlyToggle",      low: false },
  { id: "focusMode",   group: "view", dom: "focusModeToggle",     low: false },
]);
export const TIMELINE_CONTROL_VIEWS = Object.freeze(["viewA", "altTimeline"]);

/**
 * Where each control lives for a view.
 *   bar      — ids shown in the shared View bar, in display order
 *   overflow — (legacy) ids folded into the "⋯" menu; always empty now
 *   options  — ids rendered by the Alt options bar instead (edit controls)
 *   panel    — ids living in the Alt side panel's View card (all view-group controls; the Alt view never
 *              shows the .hdr-tier2 bar, so bar/overflow stay empty there)
 *   hidden   — ids not shown right now (edit-only controls while not editing)
 * The classic Timeline (viewA) is never reduced: every control stays in the
 * bar, narrow or not. Views other than the two timelines get empty lists.
 */
export function timelineControlsFor(view, { editing = false, narrow = false } = {}) {
  const out = { bar: [], overflow: [], options: [], hidden: [], panel: [] };
  if (!TIMELINE_CONTROL_VIEWS.includes(view)) return out;
  const alt = view === "altTimeline";
  for (const c of TIMELINE_CONTROLS) {
    if (alt && c.group === "edit") { out.options.push(c.id); continue; }
    if (alt) { out.panel.push(c.id); continue; }
    if (c.editOnly && !editing) { out.hidden.push(c.id); continue; }
    out.bar.push(c.id);
  }
  return out;
}

/* Launch markers for the timelines: one per product track with a target launch (track.launch),
   or the project-level state.launch when there are no products. `at` = months from state.start
   (fractional, so it lines up with bar startIdx); markers outside the project range are still returned
   (callers skip what they can't draw). Sorted by date. */
export function launchMarkers(state) {
  const out = [];
  const s = parseYM(state.start);
  const push = (id, label, day, color) => {
    if (!isDay(day)) return;
    const [y, m, d] = day.split("-").map(Number);
    const dim = new Date(y, m, 0).getDate();
    out.push({ id, label, day, color: color || null, at: (y - s.y) * 12 + (m - s.m) + (d - 1) / dim });
  };
  const prods = getProductTracks(state);
  if (prods.length) for (const t of prods) push(t.id, `${t.label} launch`, t.launch, t.color && t.color.accent);
  else push("project", "Launch", state.launch, null);
  return out.sort((a, b) => a.at - b.at);
}


/* ====================== Project files ======================
   One JSON file per project on disk (desktop app): <slug>.proplan.json =
   {format:"proplan-project", version:1, savedAt, app:{version,build}, name,
    state, snapshots}. Pure helpers only — the HTML does the I/O. */
export const PROJECT_FILE_FORMAT = "proplan-project";
export const PROJECT_FILE_VERSION = 1;
export const PROJECT_FILE_EXT = ".proplan.json";
const PROJECT_FILE_MAX_SNAPSHOTS = 200;

/** "My Plan: v2!" → "my-plan-v2" (never empty, max 60 chars). */
export function projectFileSlug(name) {
  const s = String(name == null ? "" : name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return s || "project";
}
/** True for a bare, safe file name inside the project folder. */
export function isSafeProjectFilename(name) {
  return typeof name === "string" && name.length > PROJECT_FILE_EXT.length && name.length <= 120 &&
    name.endsWith(PROJECT_FILE_EXT) && !/[\/\\\0:]/.test(name) && !name.startsWith(".") && !name.includes("..");
}
/** Slug + ".proplan.json", suffixed -2, -3… until it isn't in `taken` (case-insensitive). */
export function uniqueProjectFilename(name, taken = []) {
  const used = new Set((taken || []).map(t => String(t).toLowerCase()));
  const base = projectFileSlug(name);
  let n = 1, f = base + PROJECT_FILE_EXT;
  while (used.has(f.toLowerCase())) { n++; f = `${base}-${n}${PROJECT_FILE_EXT}`; }
  return f;
}
export function serializeProjectFile({ name, state, snapshots = [], app = {}, savedAt = Date.now() } = {}) {
  return JSON.stringify({
    format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION,
    savedAt: new Date(savedAt).toISOString(),
    app: { version: app.version || "dev", build: app.build || null },
    name: String(name || "Untitled project"), state, snapshots: Array.isArray(snapshots) ? snapshots : [],
  }, null, 2);
}
/** Parse + validate a project file. Never throws. → {ok:true,name,state,snapshots,savedAt,app} | {ok:false,error}.
 *  The state is deep-cloned and run through normaliseState; junk snapshots are dropped. */
export function parseProjectFile(text) {
  let o;
  try { o = JSON.parse(text); } catch { return { ok: false, error: "Not valid JSON." }; }
  if (!o || typeof o !== "object" || o.format !== PROJECT_FILE_FORMAT) return { ok: false, error: "Not a ProPlan project file." };
  if (typeof o.version !== "number" || o.version > PROJECT_FILE_VERSION) return { ok: false, error: "This file was saved by a newer ProPlan." };
  if (!o.state || typeof o.state !== "object" || Array.isArray(o.state) || !Array.isArray(o.state.lanes)) return { ok: false, error: "The file has no plan in it." };
  let state;
  try { state = JSON.parse(JSON.stringify(o.state)); normaliseState(state); } catch { return { ok: false, error: "The plan in this file is damaged." }; }
  const snapshots = (Array.isArray(o.snapshots) ? o.snapshots : []).filter(sn =>
    sn && typeof sn === "object" && typeof sn.id === "string" && sn.state && typeof sn.state === "object" && Array.isArray(sn.state.lanes)
  ).slice(0, PROJECT_FILE_MAX_SNAPSHOTS).map(sn => ({
    id: sn.id, name: typeof sn.name === "string" && sn.name ? sn.name : "Snapshot",
    createdAt: Number.isFinite(sn.createdAt) ? sn.createdAt : 0, state: sn.state,
  }));
  const t = Date.parse(o.savedAt);
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 120) : "Imported project";
  return { ok: true, name, state, snapshots, savedAt: Number.isFinite(t) ? t : 0, app: o.app && typeof o.app === "object" ? o.app : {} };
}
/** Is the disk copy newer than what this app last wrote/edited? (2 s slack for fs timestamp skew.) */
export function isFileNewerThanLocal(fileModifiedMs, { updatedAt = 0, fileSavedAt = 0 } = {}) {
  return Number.isFinite(fileModifiedMs) && fileModifiedMs > Math.max(updatedAt || 0, fileSavedAt || 0) + 2000;
}

/* ---------- Task + milestone codes ----------
   A task's position inside its work package: "WP1.3" = third task of the first WP. Milestones are numbered
   separately with an M: "WP1.M2" (short "M1.2") = second milestone of WP 1, so they never look like tasks.
   Derived on the fly, so it follows reordering. */
export function altTaskCodes(state) {
  const out = {};
  (state.lanes || []).forEach((lane, li) => {
    let t = 0, m = 0;
    (lane.bars || []).forEach((bar) => {
      if (bar.type === "milestone") { m++; out[bar.id] = { wp: li + 1, n: m, milestone: true, code: `WP${li + 1}.M${m}`, short: `M${li + 1}.${m}` }; }
      else { t++; out[bar.id] = { wp: li + 1, n: t, milestone: false, code: `WP${li + 1}.${t}`, short: `${li + 1}.${t}` }; }
    });
  });
  return out;
}

/* Dependency edges [{pred, succ, invalid}] for the visible bars only; `invalid` = the successor starts
   before the predecessor finishes (more than a week of overlap tolerance is 1/WEEKS_PER_MONTH month). */
export function altDepEdges(state, visibleIds = null) {
  const map = buildBarMap(state);
  const edges = [];
  for (const lane of state.lanes || []) for (const bar of lane.bars || []) for (const p of bar.dependsOn || []) {
    const pe = map[p]; if (!pe) continue;
    if (visibleIds && (!visibleIds.has(p) || !visibleIds.has(bar.id))) continue;
    const predEnd = pe.bar.startIdx + (pe.bar.type === "milestone" ? 0 : effSpan(pe.bar) / WEEKS_PER_MONTH);
    edges.push({ pred: p, succ: bar.id, invalid: (predEnd - bar.startIdx) > 1 / WEEKS_PER_MONTH });
  }
  return edges;
}


/* ====================== HTML export (Confluence) ======================
   exportTimelineHtml(state, opts) -> a self-contained, script-free, resource-free HTML string.
   Every element carries INLINE styles (Confluence strips <style> blocks in many contexts); the
   Gantt uses percentage-positioned absolute children inside fixed-height relative rows: tables
   can't place fractional month offsets, and the HTML macro (an iframe) keeps absolute layout intact.
   opts: { mode:"fragment"|"page", title, deps=true, showMilestones=true, compact=false, today:"YYYY-MM-DD",
           filterTrack:trackId, filterLane:laneId, shownBarIds:Iterable<barId> (e.g. the app's current filters) } */
function tlhEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function tlhColor(c, fallback) { return /^#[0-9a-fA-F]{3,8}$/.test(String(c || "")) ? c : fallback; }
function tlhDayAt(startYM, day) {
  if (!isDay(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  return (y - startYM.y) * 12 + (m - startYM.m) + (d - 1) / new Date(y, m, 0).getDate();
}
/* WP colours (accent of the app's 9-colour palette, by WP number) — only used for the thin rail on each WP strip. */
const TLH_WP_ACCENTS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#6366f1", "#a855f7", "#ec4899"];
const TLH_DEP_HUES = [205, 230, 255, 280, 310, 185];
/* Export range: o.range "planned" (first task start month → last task end month, after the other filters) or "custom" (o.rangeStart / o.rangeEnd, "YYYY-MM").
   Done by re-basing a COPY of the state onto the new first month (bars shifted by whole months, only in-range bars kept, task codes taken from the original)
   and exporting that — so every geometry rule of the normal export applies unchanged. */
function tlhRanged(state, o) {
  const s0 = state || {};
  const base = parseYM(s0.start);
  const idxOf = (ym) => { const p = parseYM(ym); return (p.y - base.y) * 12 + (p.m - base.m); };
  const ymAt = (i) => { const k = (base.m - 1) + i; return `${base.y + Math.floor(k / 12)}-${String(((k % 12) + 12) % 12 + 1).padStart(2, "0")}`; };
  const shown = o.shownBarIds ? new Set(o.shownBarIds) : null;
  const list = [];
  (s0.lanes || []).forEach(lane => {
    if (o.filterLane && lane.id !== o.filterLane) return;
    for (const b of lane.bars || []) {
      if (b.type === "milestone" && o.showMilestones === false) continue;
      if (shown && !shown.has(b.id)) continue;
      if (o.filterTrack && o.filterTrack !== "all" && !barTracks(b, lane).includes(o.filterTrack)) continue;
      const ms = b.type === "milestone", x0 = b.startIdx || 0;
      list.push({ b, ms, x0, x1: ms ? x0 : x0 + Math.max(effSpan(b) / WEEKS_PER_MONTH, 0.25) });
    }
  });
  const whole = Math.max(1, monthsBetween(s0.start, s0.end).length);
  let a = 0, z = whole - 1;
  if (o.range === "custom" && o.rangeStart && o.rangeEnd) { a = idxOf(o.rangeStart); z = idxOf(o.rangeEnd); }
  else if (o.range === "planned" && list.length) {
    a = Math.floor(Math.min(...list.map(i => i.x0)) + 1e-9);
    z = Math.max(...list.map(i => i.ms ? Math.floor(i.x0 + 1e-9) : Math.ceil(i.x1 - 1e-9) - 1));
  }
  if (!Number.isFinite(a) || !Number.isFinite(z)) { a = 0; z = whole - 1; }
  if (z < a) z = a;
  const inRange = list.filter(i => i.ms ? (i.x0 >= a && i.x0 < z + 1) : (i.x1 > a && i.x0 < z + 1)).map(i => i.b.id);
  const clone = Object.assign({}, s0, { start: ymAt(a), end: ymAt(z),
    lanes: (s0.lanes || []).map(l => Object.assign({}, l, { bars: (l.bars || []).map(b => Object.assign({}, b, { startIdx: (b.startIdx || 0) - a })) })) });
  return exportTimelineHtml(clone, Object.assign({}, o, { range: "project", shownBarIds: inRange, _codes: altTaskCodes(s0), _ranged: true }));
}

export function exportTimelineHtml(state, opts = {}) {
  const o0 = opts || {};
  if ((o0.range === "planned" || o0.range === "custom") && !o0._ranged) return tlhRanged(state, o0);
  const o = Object.assign({ mode: "fragment", deps: true, showMilestones: true, compact: false, names: false, hover: false, milestonesAtBottom: false, milestonesPacked: false, msNames: true, routes: false }, o0);
  if (o.milestonesPacked) o.milestonesAtBottom = true;   // packed is a layout of the bottom section
  const s = state || {};
  const months = monthsBetween(s.start, s.end);
  const total = Math.max(1, months.length);
  const codes = o._codes || altTaskCodes(s);
  const shown = o.shownBarIds ? new Set(o.shownBarIds) : null;
  // Geometry mirrors the Timeline tab: 22px rows, 18px blocks, a 112px WP strip + a 66px ID/status column.
  const ROW = o.compact ? 20 : 22, BAR = o.compact ? 14 : 18, STRIP = 112, IDW = o.names ? 250 : (o.milestonesAtBottom && !o.milestonesPacked ? 96 : 66), LABW = STRIP + IDW;
  const MIN_TRACK = 900 - LABW;
  // FIXED pixel geometry: the table is exactly LABW + TRACK px wide wherever it is pasted (a narrower page scrolls it, it is never squeezed), so every block, pill and label keeps its shape and the text-fit maths below is exact.
  const TRACK = Math.max(MIN_TRACK, total * 52);
  const r2 = (v) => Math.round(v * 100) / 100;
  const X = (v) => r2(Math.max(0, Math.min(total, v)) / total * TRACK);   // months from the start -> px
  const pct = (v) => `${X(v)}px`;
  const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
  // The app's light-theme tokens, flattened (Confluence has no CSS variables / color-mix).
  const C = { ink: "#0f172a", soft: "#334155", muted: "#64748b", line: "#e2e8f0", lineS: "#cbd5e1", surface: "#f8fafc", grid: "#eef2f6", alt: "#f6f8fa",
    accent: "#0a84ff", pendBg: "#b6daff", doneBg: "#afeac5", doneB: "#15803d", doingBg: "#fbd699", doingB: "#b45309" };
  const startYM = parseYM(s.start);
  const textW = (t) => Math.round(String(t).length * 6.4) + 4;   // ~11.5px / weight 550

  // Which bars/lanes to draw.
  const lanes = [], msTail = [];
  (s.lanes || []).forEach((lane, laneIdx) => {
    if (o.filterLane && lane.id !== o.filterLane) return;
    const bars = (lane.bars || []).filter(b => {
      if (b.type === "milestone" && !o.showMilestones) return false;
      if (shown && !shown.has(b.id)) return false;
      if (o.filterTrack && o.filterTrack !== "all" && !barTracks(b, lane).includes(o.filterTrack)) return false;
      return true;
    });
    if (o.milestonesAtBottom) {
      for (const b of bars) if (b.type === "milestone") msTail.push({ bar: b, laneIdx });
      const tasks = bars.filter(b => b.type !== "milestone");
      if (tasks.length) lanes.push({ lane, laneIdx, bars: tasks });
    } else if (bars.length) lanes.push({ lane, laneIdx, bars });
  });
  // Milestones at the bottom (like the Timeline tab's "Bottom section"): one "Milestones" block at the end, by date, each tagged with its WP.
  const tailWp = {};
  if (msTail.length) {
    msTail.sort((a, b) => ((a.bar.startIdx || 0) - (b.bar.startIdx || 0)) || (a.laneIdx - b.laneIdx));
    msTail.forEach(m => { tailWp[m.bar.id] = m.laneIdx + 1; });
    lanes.push({ lane: { code: "Milestones" }, laneIdx: -1, bars: msTail.map(m => m.bar), tail: true });
  }
  const visibleIds = new Set(); lanes.forEach(l => l.bars.forEach(b => visibleIds.add(b.id)));

  // One colour until a task is started; status recolours the whole block (same rule as the Timeline tab).
  const fillOf = (b) => { const st = barStatus(b); return st === "done" ? { bg: C.doneBg, b: C.doneB, w: 2 } : st === "doing" ? { bg: C.doingBg, b: C.doingB, w: 2 } : { bg: C.pendBg, b: C.accent, w: 1 }; };
  const statusIcon = (st) => st === "done"
    ? `<span style="display:inline-block;flex:none;box-sizing:border-box;width:15px;min-width:15px;height:15px;min-height:15px;border-radius:50%;background:#22c55e;border:1.5px solid ${C.doneB};color:#ffffff;font-size:9px;line-height:12px;text-align:center;font-weight:700;">&#10003;</span>`
    : st === "doing"
      ? `<span style="display:inline-block;flex:none;box-sizing:border-box;width:15px;min-width:15px;height:15px;min-height:15px;border-radius:50%;background:#fef3c7;border:1.5px solid ${C.doingB};color:#92400e;font-size:10px;line-height:12px;text-align:center;font-weight:700;">&#8635;</span>`
      : `<span style="display:inline-block;flex:none;box-sizing:border-box;width:15px;min-width:15px;height:15px;min-height:15px;border-radius:50%;background:#ffffff;border:1.5px solid ${C.lineS};vertical-align:top;"></span>`;

  // Dependency pills: one per predecessor, coloured per predecessor (cool hues), green once that predecessor is done.
  const allEdges = o.deps || o.routes ? altDepEdges(s, visibleIds) : [];
  const edges = o.deps && !o.compact ? allEdges : [];
  const colorOfPred = {}; let ci = 0;
  for (const e of allEdges) if (!(e.pred in colorOfPred)) { colorOfPred[e.pred] = `hsl(${TLH_DEP_HUES[ci % TLH_DEP_HUES.length]},34%,${ci % 12 >= 6 ? 30 : 38}%)`; ci++; }
  const predsOf = {}; for (const e of edges) (predsOf[e.succ] = predsOf[e.succ] || []).push(e);
  const barById = {}; (s.lanes || []).forEach(l => (l.bars || []).forEach(b => { barById[b.id] = b; }));
  const PILL = (txt) => Math.round(txt.length * 5.7 + 9);

  // Overlay lines: launches (coloured, solid) and today (neutral ink), each with a small pill label.
  const lines = [];
  for (const mk of launchMarkers(s)) if (mk.at >= 0 && mk.at <= total) lines.push({ at: mk.at, label: `\u{1F680} ${mk.label}`, color: tlhColor(mk.color, "#16a34a"), text: "#ffffff", w: 2 });
  const todayAt = o.today ? tlhDayAt(startYM, o.today) : null;
  if (todayAt != null && todayAt >= 0 && todayAt <= total) lines.push({ at: todayAt, label: `Today \u00B7 ${tlhEsc(String(o.today).slice(8))} ${MONTH_NAMES[Number(String(o.today).slice(5, 7)) - 1] || ""}`, color: "#db2777", text: "#ffffff", w: 2.5, today: true });

  const metaBits = [`Start: ${tlhEsc(s.start || "")}`, `End: ${tlhEsc(s.end || "")}`];
  for (const mk of launchMarkers(s)) metaBits.push(`${tlhEsc(mk.label)}: ${tlhEsc(mk.day)}`);
  const title = o.title != null ? o.title : "ProPlan";

  // Legend: the same language the Timeline tab uses.
  const swatch = (bg, border, w, text) => `<span style="display:inline-block;margin-right:14px;white-space:nowrap;"><span style="display:inline-block;box-sizing:border-box;width:16px;height:11px;vertical-align:middle;margin-right:5px;border-radius:3px;background:${bg};border:${w}px solid ${border};"></span>${tlhEsc(text)}</span>`;
  const legend = [
    swatch(C.pendBg, C.accent, 1, "Not started"), swatch(C.doingBg, C.doingB, 2, "In progress"), swatch(C.doneBg, C.doneB, 2, "Done"),
    `<span style="display:inline-block;margin-right:14px;white-space:nowrap;"><span style="display:inline-block;box-sizing:border-box;width:10px;height:10px;vertical-align:middle;margin-right:7px;transform:rotate(45deg);background:${C.pendBg};border:1.5px solid ${C.accent};"></span>Milestone</span>`,
    `<span style="display:inline-block;margin-right:14px;white-space:nowrap;"><span style="display:inline-block;box-sizing:border-box;width:16px;height:11px;vertical-align:middle;margin-right:5px;border:1px solid ${C.lineS};background:repeating-linear-gradient(135deg,rgba(15,23,42,0.22) 0,rgba(15,23,42,0.22) 3px,transparent 3px,transparent 6px);"></span>Buffer</span>`,
  ].join("");

  // Header: dark year bar + month row, over the track column; "WORK PACKAGE · ID" corner on the left.
  const yearCells = [];
  months.forEach(mm => { const last = yearCells[yearCells.length - 1]; if (last && last.y === mm.y) last.n++; else yearCells.push({ y: mm.y, n: 1 }); });
  const cellW = (n) => `${r2(n / total * TRACK)}px`;
  const initialsOnly = total > 18;
  const HEAD_H = 44;
  const head = `<div style="display:flex;height:${HEAD_H}px;border-bottom:1px solid ${C.lineS};">
<div style="flex:0 0 ${LABW}px;width:${LABW}px;box-sizing:border-box;padding:0 8px;background:${C.surface};border-right:1px solid ${C.lineS};font-size:10.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};line-height:${HEAD_H}px;white-space:nowrap;">Work package &middot; ID</div>
<div style="flex:0 0 ${TRACK}px;width:${TRACK}px;">
<div style="display:flex;height:22px;background:#0f172a;">${yearCells.map(y => `<span style="display:block;width:${cellW(y.n)};box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:2px 8px;font-size:11.5px;font-weight:600;line-height:18px;color:#ffffff;border-right:1px solid ${C.line};">${y.n >= 2 ? y.y : ""}</span>`).join("")}</div>
<div style="display:flex;height:22px;background:${C.surface};">${months.map(mm => `<span style="display:block;width:${cellW(1)};box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:3px 6px;font-size:11px;line-height:16px;color:${C.soft};border-right:1px solid ${C.grid};">${initialsOnly ? MONTH_NAMES[mm.m - 1][0] : MONTH_NAMES[mm.m - 1]}</span>`).join("")}</div>
</div></div>`;
  const gridBg = `background-image:linear-gradient(to right,${C.grid} 1px,transparent 1px);background-size:${r2(TRACK / total)}px 100%;`;

  const rows = [], geom = {};
  let stripe = 0;
  for (const { lane, laneIdx, bars, tail } of lanes) {
    const rail = tail ? C.muted : TLH_WP_ACCENTS[laneIdx % TLH_WP_ACCENTS.length];
    if (tail && o.milestonesPacked) {
      // Packed milestones: points share rows. Each is a hexagon TAG holding its milestone code ("M3.2"); the tag's left tip + a pin line and dot sit exactly on the date,
      // the tag extends to the right and the name (optional) goes beside it (to the left of the pin near the right edge).
      const items = bars.map(b => ({ b, x: (b.startIdx || 0) + (b.followsEndOf ? 0 : 0.5) }));   // same position as the Timeline: centre of the month unless linked
      const packRows = [];
      for (const it of items) {
        it.label = it.b.label || "(untitled)";
        it.code = (codes[it.b.id] || {}).short || "M?";
        it.tw = Math.max(38, Math.round(it.code.length * 6.1 + 20));
        it.lw = o.msNames ? textW(it.label) + 4 : 0;
        const px = X(it.x);
        it.flip = o.msNames && px + it.tw + 8 + it.lw > TRACK && px - 8 > it.lw;
        const a = it.flip ? px - 8 - it.lw : px - 3, b2 = it.flip ? px + it.tw : px + it.tw + 8 + it.lw;
        let row = packRows.find(r => r.spans.every(([p0, p1]) => b2 + 6 <= p0 || a >= p1 + 6));
        if (!row) { row = { spans: [], items: [] }; packRows.push(row); }
        row.items.push(it); row.spans.push([a, b2]);
      }
      const prow = packRows.map((pr, pi) => {
        const cells = pr.items.map(({ b, x, label, lw, flip, code, tw }) => {
          const f = fillOf(b), cd = codes[b.id] || {}, px = X(x);
          let dates = ""; try { dates = altMilestoneDate(s, b); } catch { /* ignore */ }
          const tip = tlhEsc(`${cd.code || ""} ${b.label || ""} (${dates})`);
          geom[b.id] = { row: stripe, x0: px, x1: px + tw, ms: true, hw: 1 };
          const name = o.msNames ? `<span style="position:absolute;top:0;height:${ROW}px;line-height:${ROW}px;${flip ? `right:${r2(TRACK - px + 8)}px;` : `left:${r2(px + tw + 8)}px;`}white-space:nowrap;font-size:11.5px;font-weight:550;color:${C.ink};text-shadow:0 0 2px #fff,0 0 3px #fff;">${tlhEsc(label)}</span>` : "";
          const hh = 20, k = 8;
          return `<div class="pp-b" title="${tip}" style="position:absolute;left:${r2(px)}px;top:${(ROW - hh) / 2}px;width:${tw}px;height:${hh}px;"><svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${hh}" viewBox="0 0 ${tw} ${hh}" style="position:absolute;left:0;top:-1px;display:block;overflow:visible;"><line x1="0.8" y1="-1.5" x2="0.8" y2="${hh + 1.5}" stroke="${f.b}" stroke-width="1.6" stroke-linecap="round"/><circle cx="0.8" cy="${hh / 2}" r="2.6" fill="${f.b}"/><polygon points="1.6,${hh / 2} ${k},1.3 ${tw - k},1.3 ${tw - 1.3},${hh / 2} ${tw - k},${hh - 1.3} ${k},${hh - 1.3}" fill="${f.bg}" stroke="${f.b}" stroke-width="${Math.max(1.5, f.w)}" stroke-linejoin="round"/></svg><span style="position:absolute;left:0;top:-1px;width:${tw}px;height:${hh}px;text-align:center;line-height:${hh}px;font-size:10px;font-weight:800;color:${C.ink};${MONO}">${tlhEsc(code)}</span></div>${name}`;
        }).join("");
        const lastRow = pi === packRows.length - 1;
        const rowBg = stripe++ % 2 ? "background-color:rgba(246,248,250,0.7);" : "";
        return `<div class="pp-row" style="display:flex;height:${ROW}px;">
<div style="flex:0 0 ${IDW}px;width:${IDW}px;box-sizing:border-box;border-right:1px solid ${C.lineS};border-bottom:1px solid ${lastRow ? C.lineS : C.grid};background:#ffffff;"></div>
<div class="pp-track" style="flex:0 0 ${TRACK}px;width:${TRACK}px;position:relative;overflow:hidden;box-sizing:border-box;border-bottom:1px solid ${C.grid};${rowBg}${gridBg}">${cells}</div></div>`;
      }).join("\n");
      rows.push(`<div class="pp-wp" style="display:flex;">
<div class="pp-wpstrip" title="Milestones from every work package" style="flex:0 0 ${STRIP}px;width:${STRIP}px;box-sizing:border-box;padding:5px 8px 5px 10px;background:${C.surface};border-left:4px solid ${rail};border-right:1px solid ${C.lineS};border-bottom:1px solid ${C.lineS};overflow:hidden;"><div style="font-size:11px;font-weight:800;letter-spacing:0.04em;line-height:15px;color:${C.ink};">Milestones</div><div style="font-size:11.5px;font-weight:600;line-height:14px;color:${C.soft};word-break:break-word;">${bars.length} across all WPs</div></div>
<div style="flex:0 0 ${IDW + TRACK}px;width:${IDW + TRACK}px;">
${prow}
</div></div>`);
      continue;
    }
    const wpName = wpNameOnly(lane.code || "");
    const taskRows = bars.map((b, bi) => {
      const lastRow = bi === bars.length - 1;
      const code = codes[b.id] || {};
      const st = barStatus(b), ms = b.type === "milestone", f = fillOf(b);
      const xr = (b.startIdx || 0) + (ms && !b.followsEndOf ? 0.5 : 0), w = ms ? 0 : Math.max(effSpan(b) / WEEKS_PER_MONTH, 0.25);
      const wEnd = Math.min(xr + w, total), x = Math.max(0, xr);   // a block that starts before the exported range is cut at its left edge
      let dates = "";
      try { const d = altBarDates(s, b); dates = ms ? altMilestoneDate(s, b) : `${d.start} → ${d.end}`; } catch { /* ignore */ }
      const tip = tlhEsc(`${code.code || ""} ${b.label || ""} (${dates})`);
      const label = (tail ? `WP${tailWp[b.id]} \u00B7 ` : "") + (b.label || "(untitled)");
      const wpx = ms ? 0 : (wEnd - x) / total * TRACK;
      const bufPx = (!ms && b.buffer > 0) ? wpx * (b.buffer / (100 + b.buffer)) : 0;
      const inside = !ms && !o.names && textW(label) + 20 + bufPx <= wpx;
      const preds = predsOf[b.id] || [];
      const pills = preds.map((e, k) => {
        const pd = barById[e.pred] || {}, done = barStatus(pd) === "done";
        const txt = (codes[e.pred] || {}).short || "";
        const off = 6 + preds.slice(0, k).reduce((a, q) => a + PILL((codes[q.pred] || {}).short || "") + 3, 0);
        return { html: `<span class="pp-pill" title="depends on ${tlhEsc(((codes[e.pred] || {}).code || "") + " " + (pd.label || ""))}" style="position:absolute;top:50%;margin-top:-7.5px;right:${r2(TRACK - x / total * TRACK + off)}px;height:15px;line-height:15px;padding:0 4.5px;box-sizing:border-box;border-radius:7.5px;background:${done ? C.doneB : colorOfPred[e.pred]};color:#ffffff;font-size:9.5px;font-weight:700;white-space:nowrap;${MONO}">${tlhEsc(txt)}</span>`, w: PILL(txt) + 3 };
      });
      const pillsW = pills.reduce((a, p) => a + p.w, 0);
      // Name outside the block (never ellipsised): to the right, or to the LEFT of the block + its pills near the right edge.
      let outside = "";
      if (!inside && !o.names) {
        const rightRoom = (total - wEnd) / total * TRACK, flip = rightRoom < textW(label) + 16 && x / total * TRACK > textW(label) + pillsW + 16;
        outside = flip
          ? `<span style="position:absolute;top:0;height:${ROW}px;line-height:${ROW}px;right:${r2(TRACK - x / total * TRACK + 8 + pillsW)}px;white-space:nowrap;font-size:11.5px;font-weight:550;color:${C.ink};text-shadow:0 0 2px #fff,0 0 3px #fff;">${tlhEsc(label)}</span>`
          : `<span style="position:absolute;top:0;height:${ROW}px;line-height:${ROW}px;left:${r2((ms ? x : wEnd) / total * TRACK + (ms ? 14 : 8))}px;white-space:nowrap;font-size:11.5px;font-weight:550;color:${C.ink};text-shadow:0 0 2px #fff,0 0 3px #fff;">${tlhEsc(label)}</span>`;
      }
      const buf = (!ms && b.buffer > 0) ? `<span style="position:absolute;right:0;top:0;bottom:0;width:${r2(bufPx)}px;border-left:1px dashed ${f.b};background:repeating-linear-gradient(135deg,rgba(15,23,42,0.22) 0,rgba(15,23,42,0.22) 3px,transparent 3px,transparent 6px);"></span>` : "";
      const mark = ms
        ? `<div class="pp-b" title="${tip}" style="position:absolute;left:${pct(x)};top:${(ROW - 18) / 2}px;width:18px;height:18px;margin-left:-9px;"><div style="position:absolute;left:2px;top:2px;right:2px;bottom:2px;box-sizing:border-box;transform:rotate(45deg);border-radius:2px;background:${f.bg};border:${Math.max(1.5, f.w)}px solid ${f.b};"></div></div>`
        : `<div class="pp-b" title="${tip}" style="position:absolute;left:${pct(x)};width:${pct(wEnd - x)};min-width:3px;top:${(ROW - BAR) / 2}px;height:${BAR}px;box-sizing:border-box;overflow:hidden;border-radius:5px;background:${f.bg};border:${f.w}px solid ${f.b};color:${C.ink};font-size:11.5px;font-weight:550;line-height:${BAR - 2 * f.w}px;padding:0 7px;white-space:nowrap;">${buf}${inside ? `<span style="position:relative;">${tlhEsc(label)}</span>` : ""}</div>`;
      geom[b.id] = { row: stripe, x0: X(x), x1: ms ? X(x) : X(wEnd), ms };
      const rowBg = stripe++ % 2 ? "background-color:rgba(246,248,250,0.7);" : "";
      return `<div class="pp-row" style="display:flex;height:${ROW}px;">
<div style="flex:0 0 ${IDW}px;width:${IDW}px;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:0 8px;border-right:1px solid ${C.lineS};border-bottom:1px solid ${lastRow ? C.lineS : C.grid};background:#ffffff;overflow:hidden;white-space:nowrap;">${tail ? `<span style="display:inline-block;flex:none;box-sizing:border-box;height:15px;line-height:13px;padding:0 4px;border:1px solid ${C.lineS};border-radius:7.5px;background:${C.surface};color:${C.soft};font-size:9px;font-weight:700;${MONO}">WP${tailWp[b.id]}</span>` : ""}<span style="${MONO}font-size:10px;font-weight:600;color:${C.muted};flex:none;min-width:24px;" title="${tlhEsc(code.code || "")}">${tlhEsc(code.short || code.code || "")}</span>${statusIcon(st)}${o.names ? `<span style="font-size:12px;color:${st === "done" ? C.muted : C.ink};overflow:hidden;text-overflow:ellipsis;">${tlhEsc(label)}</span>` : ""}</div>
<div class="pp-track" style="flex:0 0 ${TRACK}px;width:${TRACK}px;position:relative;overflow:hidden;box-sizing:border-box;border-bottom:1px solid ${C.grid};${rowBg}${gridBg}">${pills.map(p => p.html).join("")}${mark}${outside}</div></div>`;
    }).join("\n");
    rows.push(`<div class="pp-wp" style="display:flex;">
<div class="pp-wpstrip" title="${tlhEsc(wpLabel(lane.code || ""))}" style="flex:0 0 ${STRIP}px;width:${STRIP}px;box-sizing:border-box;padding:5px 8px 5px 10px;background:${C.surface};border-left:4px solid ${rail};border-right:1px solid ${C.lineS};border-bottom:1px solid ${C.lineS};overflow:hidden;"><div style="font-size:11px;font-weight:800;letter-spacing:0.04em;line-height:15px;color:${C.ink};">${tail ? "Milestones" : `WP${laneIdx + 1}`}</div><div style="font-size:11.5px;font-weight:600;line-height:14px;color:${C.soft};word-break:break-word;">${tail ? `${bars.length} across all WPs` : tlhEsc(wpName)}</div></div>
<div style="flex:0 0 ${IDW + TRACK}px;width:${IDW + TRACK}px;">
${taskRows}
</div></div>`);
  }
  if (!rows.length) rows.push(`<div style="padding:16px;font-size:13px;color:${C.muted};">No tasks to show.</div>`);

  // Dependency routes: orthogonal lines (one per link, coloured per predecessor, green once it is done) in an inline SVG laid over the track.
  let routes = "";
  if (o.routes && allEdges.length) {
    const cy = (g) => r2(g.row * ROW + ROW / 2);
    const paths = allEdges.map(e => {
      const a = geom[e.pred], b = geom[e.succ]; if (!a || !b) return "";
      const done = barStatus(barById[e.pred] || {}) === "done";
      const col = done ? C.doneB : (colorOfPred[e.pred] || C.muted);
      const x1 = a.x1 + (a.ms ? (a.hw || 6) : 0), y1 = cy(a), x2 = b.x0 - (b.ms ? (b.hw || 6) : 0), y2 = cy(b);
      const trunk = Math.min(x1 + 7, Math.max(x1 + 3, x2 - 7));
      const d = x2 >= x1 + 10 ? `M${x1} ${y1}H${trunk}V${y2}H${x2}` : `M${x1} ${y1}H${x1 + 6}V${r2((y1 + y2) / 2)}H${x2 - 6}V${y2}H${x2}`;
      const late = x2 < x1;   // starts before its predecessor ends: dashed
      return `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round"${late ? ' stroke-dasharray="3 2"' : ""} opacity="0.8"><title>${tlhEsc(((codes[e.pred] || {}).short || "") + " \u2192 " + ((codes[e.succ] || {}).short || ""))}</title></path><circle cx="${x1}" cy="${y1}" r="2" fill="${col}"/>`;
    }).join("");
    routes = `<svg xmlns="http://www.w3.org/2000/svg" width="${TRACK}" height="${stripe * ROW}" viewBox="0 0 ${TRACK} ${stripe * ROW}" style="position:absolute;left:${LABW}px;top:${HEAD_H}px;pointer-events:none;overflow:visible;">${paths}</svg>`;
  }
  const overlay = lines.length
    ? `<div style="position:absolute;top:${HEAD_H}px;bottom:0;left:${LABW}px;width:${TRACK}px;pointer-events:none;">${lines.map(l =>
      `${l.today ? `<div style="position:absolute;left:${pct(l.at)};top:0;bottom:0;width:${pct(7 / 30.4)};background:rgba(219,39,119,0.09);"></div>` : ""}<div style="position:absolute;left:${pct(l.at)};top:0;bottom:0;width:0;border-left:${l.w}px solid ${l.color};"><span style="position:absolute;top:4px;left:5px;padding:${l.today ? "2px 10px" : "1px 7px"};border-radius:999px;white-space:nowrap;font-size:${l.today ? 12 : 11}px;font-weight:${l.today ? 800 : 700};line-height:${l.today ? 16 : 15}px;color:${l.text};background:${l.color};">${l.today ? l.label : tlhEsc(l.label)}</span></div>`).join("")}</div>`
    : "";

  // Optional hover highlight. Pure CSS (no script) and it only ever ADDS emphasis: where a host strips <style> the export is identical, just without the hover.
  const hoverCss = o.hover ? `<style>
.pp-tl .pp-row:hover > div { background-color:#eef6ff !important; }
.pp-tl .pp-row:hover .pp-track { background-color:#e6f1ff !important; }
.pp-tl .pp-wp:hover > .pp-wpstrip { background-color:#eef2f7 !important; }
.pp-tl .pp-b { transition:box-shadow .12s, filter .12s; }
.pp-tl .pp-b:hover { box-shadow:0 0 0 2px #0a84ff, 0 2px 6px rgba(15,23,42,.25) !important; filter:brightness(.96); z-index:3; cursor:default; }
.pp-tl .pp-pill:hover { box-shadow:0 0 0 2px #0f172a; z-index:3; }
</style>
` : "";
  const fragment = `${hoverCss}<div class="pp-tl" style="${FONT}color:${C.ink};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
<div style="font-size:20px;font-weight:700;margin:0 0 2px;">${tlhEsc(title)}</div>
<div style="font-size:12px;color:${C.muted};margin:0 0 8px;">${metaBits.join(" &middot; ")}</div>
<div style="font-size:12px;margin:0 0 10px;">${legend}</div>
<div style="overflow-x:auto;max-width:100%;border:1px solid ${C.lineS};border-radius:8px;">
<div style="width:${LABW + TRACK}px;position:relative;background:#ffffff;">
${head}
${rows.join("\n")}
${routes}${overlay}
</div></div></div>`;

  if (o.mode !== "page") return fragment;
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${tlhEsc(title)}</title></head><body style="margin:16px;background:#ffffff;">\n${fragment}\n</body></html>\n`;
}
