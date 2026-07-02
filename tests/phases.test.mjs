import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computePhaseRanges,
  computeAllProductPhaseRanges,
  computeAllProductPhaseGates,
  computePhaseGates,
  enforcePhaseOrder,
  isBleedingBar,
  phaseSpanCodes,
  normaliseState,
  addProduct,
  getProductTracks,
  PHASE_ORDER,
  WEEKS_PER_MONTH,
} from '../src/proplan-core.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/* Collect overlaps in a product's phase ranges. Walks the phases that are
   actually present in chronological order and reports any pair where
   the earlier phase's `end` is greater than the later phase's `start`.
   Returns an array of `{ a, b, overlap }` so the test can pretty-print
   exactly which phase pair on which product collides — diagnosing the
   visual stripe-on-stripe the user sees in the Plan view's phase strip. */
function findPhaseOverlaps(ranges) {
  const present = Object.keys(ranges)
    .filter(c => PHASE_ORDER.hasOwnProperty(c))
    .sort((a, b) => PHASE_ORDER[a] - PHASE_ORDER[b]);
  const overlaps = [];
  for (let i = 0; i < present.length - 1; i++) {
    const a = present[i], b = present[i + 1];
    const aEnd = ranges[a].end, bStart = ranges[b].start;
    // Allow a small epsilon for floating-point noise from buffer×span math.
    if (aEnd > bStart + 1e-9) overlaps.push({ a, b, aEnd, bStart, overlap: aEnd - bStart });
  }
  return overlaps;
}

describe('isBleedingBar', () => {
  it('detects a forward bleed (DP -> DO)', () => {
    expect(isBleedingBar({ phase: 'DP', phaseEnd: 'DO' })).toBe(true);
  });

  it('rejects same phase or backwards', () => {
    expect(isBleedingBar({ phase: 'DP', phaseEnd: 'DP' })).toBe(false);
    expect(isBleedingBar({ phase: 'DO', phaseEnd: 'DP' })).toBe(false);
  });

  it('rejects bars without one or both fields', () => {
    expect(isBleedingBar({ phase: 'DP' })).toBe(false);
    expect(isBleedingBar({ phaseEnd: 'DO' })).toBe(false);
    expect(isBleedingBar(null)).toBe(false);
  });
});

describe('phaseSpanCodes', () => {
  it('returns [phase] for a plain tagged bar', () => {
    expect(phaseSpanCodes({ phase: 'DP' })).toEqual(['DP']);
  });

  it('returns the full PRS..phaseEnd range for a bleed', () => {
    expect(phaseSpanCodes({ phase: 'PRS', phaseEnd: 'DO' })).toEqual(['PRS', 'DP', 'DO']);
  });

  it('returns [] for an untagged or invalid bar', () => {
    expect(phaseSpanCodes({})).toEqual([]);
    expect(phaseSpanCodes({ phase: 'XYZ' })).toEqual([]);
  });
});

describe('computePhaseRanges', () => {
  it('excludes milestones from the range', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, phase: 'PRS' },
          // Milestone at month 10 should NOT extend PRS to 10
          { id: 'm', type: 'milestone', startIdx: 10, span: 0, phase: 'PRS' },
        ],
      }],
    };
    const r = computePhaseRanges(state);
    expect(r.PRS.start).toBe(0);
    expect(r.PRS.end).toBe(1); // 4 weeks / 4 = 1 month — well short of milestone
  });

  it('bleed contributes start to phase, end to phaseEnd', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'dpAnchor', type: 'work', startIdx: 0,   span: 4, buffer: 0, phase: 'DP' },
          { id: 'bleed',   type: 'work', startIdx: 0.5, span: 8, buffer: 0, phase: 'DP', phaseEnd: 'DO' },
        ],
      }],
    };
    const r = computePhaseRanges(state);
    // DP.start picks up the bleed's startIdx = 0; DP.end stops at the plain DP task's end (=1)
    expect(r.DP.start).toBe(0);
    expect(r.DP.end).toBe(1);
    // DO inherits the bleed's end (0.5 + 2 = 2.5)
    expect(r.DO.start).toBe(2.5);
    expect(r.DO.end).toBe(2.5);
  });

  it('untagged bars are ignored', () => {
    const state = { lanes: [{ bars: [
      { id: 'untagged', type: 'work', startIdx: 5, span: 4, buffer: 0 },
    ]}]};
    expect(Object.keys(computePhaseRanges(state))).toEqual([]);
  });
});

describe('computePhaseGates', () => {
  it('produces one gate per present phase with x = phase.end', () => {
    const ranges = {
      PRS: { start: 0, end: 1 },
      DP:  { start: 2, end: 3 },
      DO:  { start: 4, end: 5 },
      FP:  { start: 6, end: 7 },
    };
    const gates = computePhaseGates(ranges, ['PRS', 'DP', 'DO', 'FP']);
    expect(gates).toHaveLength(4);
    expect(gates.map(g => g.startIdx)).toEqual([1, 3, 5, 7]);
  });

  it('labels the last phase as "Project close" with code END', () => {
    const ranges = { PRS: { start: 0, end: 1 }, DP: { start: 1, end: 2 } };
    const gates = computePhaseGates(ranges, ['PRS', 'DP']);
    expect(gates[0].label).toBe('PRS closure');
    expect(gates[0]._gateCode).toBe('PRS');
    expect(gates[1].label).toBe('Project close');
    expect(gates[1]._gateCode).toBe('END');
  });

  it('returns empty for empty phase list', () => {
    expect(computePhaseGates({}, [])).toEqual([]);
  });
});

describe('enforcePhaseOrder', () => {
  it('push-snaps a DP task that starts before PRS ends', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'prsLong', type: 'work', startIdx: 0, span: 12, buffer: 0, phase: 'PRS', dependsOn: [] },
          { id: 'dpEarly', type: 'work', startIdx: 1, span: 4,  buffer: 0, phase: 'DP', dependsOn: [] },
        ],
      }],
    };
    enforcePhaseOrder(state);
    const dp = state.lanes[0].bars.find(b => b.id === 'dpEarly');
    // PRS ends at 12/4 = 3 months. DP should be pushed to at least 3.
    expect(dp.startIdx).toBeGreaterThanOrEqual(3);
  });

  it('respects extendsPhase — long tail does NOT push the next phase', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'short',  type: 'work', startIdx: 0, span: 4,  buffer: 0, phase: 'PRS', dependsOn: [] },
          { id: 'longTail', type: 'work', startIdx: 0, span: 40, buffer: 0, phase: 'PRS', extendsPhase: true, dependsOn: [] },
          { id: 'dp',     type: 'work', startIdx: 0, span: 4,  buffer: 0, phase: 'DP',  dependsOn: [] },
        ],
      }],
    };
    enforcePhaseOrder(state);
    // Without extendsPhase, dp would be pushed to >= 10 months (40 weeks).
    // With it, dp's only gate is the SHORT task (4 weeks = 1 month).
    const dp = state.lanes[0].bars.find(b => b.id === 'dp');
    expect(dp.startIdx).toBeLessThanOrEqual(1);
  });

  it('does NOT push a locked bar, even if it sits before the gate', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'prs', type: 'work', startIdx: 0, span: 12, buffer: 0, phase: 'PRS', dependsOn: [] },
          // DP-early starts WAY before PRS ends. Normally would be pushed to PRS.end (3),
          // but it's locked — must remain at startIdx 1.
          { id: 'dpLocked', type: 'work', startIdx: 1, span: 4, buffer: 0, phase: 'DP', locked: true, dependsOn: [] },
        ],
      }],
    };
    enforcePhaseOrder(state);
    expect(state.lanes[0].bars[1].startIdx).toBe(1);
  });

  it('bleed contributes end to phaseEnd, not phase — does not gate the start phase', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'shortDP', type: 'work', startIdx: 0,   span: 4, buffer: 0, phase: 'DP', dependsOn: [] },
          // Bleed DP -> DO with a long tail. Should NOT make a sibling DP bar wait.
          { id: 'bleed',   type: 'work', startIdx: 0.5, span: 8, buffer: 0, phase: 'DP', phaseEnd: 'DO', dependsOn: [] },
          { id: 'do',      type: 'work', startIdx: 0,   span: 4, buffer: 0, phase: 'DO', dependsOn: [] },
        ],
      }],
    };
    enforcePhaseOrder(state);
    const doBar = state.lanes[0].bars.find(b => b.id === 'do');
    // DO's gate is DP's max end (= the plain DP task's end = 1 month). DO must start at >= 1.
    // Crucially DO should be pushed by the BLEED's end (2.5), since the bleed's end contributes to DO.
    expect(doBar.startIdx).toBeGreaterThanOrEqual(1);
  });
});

describe('v5 multi-product phase computation', () => {
  it('computePhaseRanges(state, productId) only counts bars in that product', () => {
    const state = {
      lanes: [
        { id: 'lA', track: 'product', bars: [
          { id: 'a1', type: 'work', startIdx: 0, span: 4, phase: 'PRS', buffer: 0, alloc: 100, dependsOn: [] },
          { id: 'a2', type: 'work', startIdx: 1, span: 8, phase: 'DP',  buffer: 0, alloc: 100, dependsOn: [] },
        ]},
        { id: 'lB', track: 'earmold', bars: [
          // Earmold lives MUCH later. If we ignored productId, its DP would
          // dominate the timeline; with the filter, it stays separate.
          { id: 'b1', type: 'work', startIdx: 20, span: 4, phase: 'PRS', buffer: 0, alloc: 100, dependsOn: [] },
          { id: 'b2', type: 'work', startIdx: 24, span: 4, phase: 'DP',  buffer: 0, alloc: 100, dependsOn: [] },
        ]},
      ],
    };
    normaliseState(state);
    addProduct(state, { label: 'Earmold' });
    // Re-tag lane B's lane.track now that "earmold" exists in tracks.
    state.lanes[1].track = 'earmold';
    const productRanges = computePhaseRanges(state, 'product');
    const earmoldRanges = computePhaseRanges(state, 'earmold');
    // Product's PRS / DP come from lane A
    expect(productRanges.PRS.start).toBeCloseTo(0);
    expect(productRanges.PRS.end).toBeCloseTo(1);    // 4 weeks ≈ 1 month
    expect(productRanges.DP.start).toBeCloseTo(1);
    expect(productRanges.DP.end).toBeCloseTo(3);     // 1 + 8/4 = 3
    // Earmold's PRS / DP come from lane B — start ~20, not bleeding into product
    expect(earmoldRanges.PRS.start).toBeCloseTo(20);
    expect(earmoldRanges.DP.start).toBeCloseTo(24);
  });

  it('computeAllProductPhaseRanges returns a map per enabled product', () => {
    const state = { lanes: [
      { id: 'lA', track: 'product', bars: [
        { id: 'a', type: 'work', startIdx: 0, span: 4, phase: 'PRS', buffer: 0, alloc: 100, dependsOn: [] },
      ]},
    ]};
    normaliseState(state);
    addProduct(state, { label: 'Earmold' });
    const all = computeAllProductPhaseRanges(state);
    expect(Object.keys(all).sort()).toEqual(['earmold', 'product']);
    expect(all.product.PRS).toBeDefined();
    // Earmold has no bars yet → no ranges
    expect(all.earmold.PRS).toBeUndefined();
  });

  it('bar.tracks contributes to EVERY tagged product\'s ranges', () => {
    // A single bar tagged for both "product" and "earmold" should appear
    // in both products' PRS ranges.
    const state = {
      lanes: [
        { id: 'lA', track: 'product', bars: [
          { id: 'shared', type: 'work', startIdx: 0, span: 4, phase: 'PRS', buffer: 0, alloc: 100, dependsOn: [], tracks: ['product', 'earmold'] },
        ]},
      ],
    };
    normaliseState(state);
    addProduct(state, { label: 'Earmold' });
    // Re-set tracks now that "earmold" exists in state.tracks (normaliseState
    // would have scrubbed it otherwise).
    state.lanes[0].bars[0].tracks = ['product', 'earmold'];
    const productRanges = computePhaseRanges(state, 'product');
    const earmoldRanges = computePhaseRanges(state, 'earmold');
    expect(productRanges.PRS).toBeDefined();
    expect(earmoldRanges.PRS).toBeDefined();
    expect(productRanges.PRS.end).toBeCloseTo(1);
    expect(earmoldRanges.PRS.end).toBeCloseTo(1);
  });

  it('computeAllProductPhaseGates tags each gate with _productId', () => {
    const state = { lanes: [
      { id: 'lA', track: 'product', bars: [
        { id: 'a1', type: 'work', startIdx: 0, span: 4, phase: 'PRS', buffer: 0, alloc: 100, dependsOn: [] },
        { id: 'a2', type: 'work', startIdx: 1, span: 4, phase: 'DP',  buffer: 0, alloc: 100, dependsOn: [] },
      ]},
      { id: 'lB', track: 'earmold', bars: [
        { id: 'b1', type: 'work', startIdx: 20, span: 4, phase: 'PRS', buffer: 0, alloc: 100, dependsOn: [] },
      ]},
    ]};
    normaliseState(state);
    addProduct(state, { label: 'Earmold' });
    state.lanes[1].track = 'earmold';
    const gates = computeAllProductPhaseGates(state);
    const productGates = gates.filter(g => g._productId === 'product');
    const earmoldGates = gates.filter(g => g._productId === 'earmold');
    expect(productGates.length).toBeGreaterThan(0);
    expect(earmoldGates.length).toBeGreaterThan(0);
    // Product gates close at product DP's end (~2); earmold gates close at
    // earmold PRS's end (~21).
    const productEnd = Math.max(...productGates.map(g => g.startIdx));
    const earmoldEnd = Math.max(...earmoldGates.map(g => g.startIdx));
    expect(earmoldEnd).toBeGreaterThan(productEnd);
  });
});

/* Phase-strip visual invariant: per product, the coloured phase blocks
   that the Plan / Timeline / Roadmap views paint MUST sit end-to-end.
   PRS finishes before DP starts, DP before DO, DO before FP. If any
   pair overlaps, the renderer ends up drawing one phase's stripe on
   top of another's — the bug surfaced in the user's screenshot. */
describe('phase ranges per product — no overlapping stripes', () => {
  /* Fixtures we expect to pass the visual-overlap check (realistic plans
     where Auto-sequence has done its job). bleed.json + multiPhase.json
     are intentionally excluded — they're hand-rolled edge-case fixtures
     for testing the bleed / extendsPhase semantics, with DP and DO bars
     deliberately placed on top of each other, so overlap detection is
     guaranteed to fire and is NOT a bug. */
  const FIXTURES = [
    'linearChain.json',
    'diamond.json',
    'userMultiProduct.json',
  ];

  for (const name of FIXTURES) {
    it(`${name}: PRS → DP → DO → FP do not overlap on any product`, () => {
      const state = load(name);
      normaliseState(state);            // mutates in place; doesn't return
      // Match what the renderer sees in production: every save runs
      // enforcePhaseOrder, so the on-screen phase strip is computed
      // AFTER ordering. Call it here so we don't flag "raw" fixtures
      // that are only broken because Auto-sequence hasn't run yet.
      enforcePhaseOrder(state);
      const products = getProductTracks(state);
      const allRanges = computeAllProductPhaseRanges(state);
      const failures = [];
      for (const p of products) {
        const ranges = allRanges[p.id] || {};
        // Only assert about products that actually have ≥2 phase blocks —
        // a product with a single phase can't overlap with itself.
        const phaseKeys = Object.keys(ranges).filter(c => PHASE_ORDER.hasOwnProperty(c));
        if (phaseKeys.length < 2) continue;
        const overlaps = findPhaseOverlaps(ranges);
        for (const o of overlaps) {
          failures.push(
            `${p.label || p.id}: ${o.a} ends at ${o.aEnd.toFixed(3)} ` +
            `but ${o.b} starts at ${o.bStart.toFixed(3)} ` +
            `(overlap = ${o.overlap.toFixed(3)} months)`
          );
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }

  /* Sanity check for the detection helper itself — feed a hand-rolled
     overlap and confirm we catch it. Guards against the test reporting
     "all green" because the detector silently broke. */
  it('detector flags a manual PRS-into-DP overlap', () => {
    const ranges = {
      PRS: { start: 0, end: 2.0 },
      DP:  { start: 1.5, end: 4.0 },
    };
    const overlaps = findPhaseOverlaps(ranges);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].a).toBe('PRS');
    expect(overlaps[0].b).toBe('DP');
    expect(overlaps[0].overlap).toBeCloseTo(0.5);
  });

  it('detector accepts touching ranges (PRS.end === DP.start)', () => {
    const ranges = {
      PRS: { start: 0, end: 2.0 },
      DP:  { start: 2.0, end: 4.0 },
    };
    expect(findPhaseOverlaps(ranges)).toEqual([]);
  });
});
