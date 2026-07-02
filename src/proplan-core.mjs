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

/* Track model (v5).
   Each track is a user-managed entry in state.tracks:
     {
       id,         // stable string id (system or user-generated)
       label,      // display name
       kind,       // "product" — phase-bound (PRS/DP/DO/FP),
                   // "continuous" — free-form, not phase-bound (PLE, Exploration)
       color: { bar, border },
       enabled,    // bool — whether the track is currently in use for this project
       activePhase // only for kind === "product": null | "PRS" | "DP" | "DO" | "FP" | "_closed"
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
      ? "Phase-bound product development (PRS → DP → DO → FP)."
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
    }
  }
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
export function computePhaseRanges(state, productId) {
  const ranges = {};
  for (const lane of state.lanes || []) {
    for (const b of lane.bars || []) {
      if (!b.phase || !PHASE_ORDER.hasOwnProperty(b.phase)) continue;
      if (b.type === "milestone") continue;
      // When productId is passed, count bars whose effective track LIST
      // includes that product (multi-product tagging: a single bar may
      // belong to several products and contribute to each of their phases).
      // Omitting productId = legacy behaviour (count every phase-tagged
      // bar, regardless of track — single-product view).
      if (productId && !barTracks(b, lane).includes(productId)) continue;
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
  const out = [];
  for (const t of products) {
    const ranges = computePhaseRanges(state, t.id);
    const present = ["PRS", "DP", "DO", "FP"].filter(c => ranges[c]);
    for (const g of computePhaseGates(ranges, present)) {
      g._productId = t.id;
      out.push(g);
    }
  }
  return out;
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
  for (const phase of PHASE_CODES_IN_ORDER) {
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
                           && PHASE_ORDER.hasOwnProperty(b.phaseEnd)
                           && PHASE_ORDER[b.phaseEnd] > PHASE_ORDER[b.phase])
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
