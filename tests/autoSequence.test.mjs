import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  autoSequence,
  topoOrder,
  createsCycle,
  buildBarMap,
  effSpan,
  WEEKS_PER_MONTH,
} from '../src/proplan-core.mjs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// Recompute violations from scratch — same rule the renderArrowsIn check uses.
function countViolations(state, toleranceMonths = 1 / WEEKS_PER_MONTH) {
  const map = buildBarMap(state);
  let violations = 0;
  for (const lane of state.lanes) {
    for (const bar of lane.bars) {
      for (const predId of bar.dependsOn || []) {
        const p = map[predId];
        if (!p) continue;
        const predEnd = p.bar.type === 'milestone'
          ? p.bar.startIdx
          : p.bar.startIdx + effSpan(p.bar) / WEEKS_PER_MONTH;
        if (predEnd - bar.startIdx > toleranceMonths) violations++;
      }
    }
  }
  return violations;
}

describe('topoOrder', () => {
  it('returns null when a direct cycle exists', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: ['b'] },
          { id: 'b', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: ['a'] },
        ],
      }],
    };
    expect(topoOrder(buildBarMap(state))).toBeNull();
  });

  it('returns a valid order for a linear chain', () => {
    const state = load('linearChain.json');
    const order = topoOrder(buildBarMap(state));
    expect(order).not.toBeNull();
    // The order must place each bar's predecessors before it.
    const seen = new Set();
    const map = buildBarMap(state);
    for (const id of order) {
      for (const predId of (map[id].bar.dependsOn || [])) {
        expect(seen.has(predId)).toBe(true);
      }
      seen.add(id);
    }
  });
});

describe('createsCycle', () => {
  it('detects a direct cycle (target -> pred -> target)', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: ['b'] },
          { id: 'b', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: [] },
        ],
      }],
    };
    expect(createsCycle('b', 'a', buildBarMap(state))).toBe(true);
  });

  it('detects a transitive cycle (a -> b -> c -> a)', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: [] },
          { id: 'b', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: ['a'] },
          { id: 'c', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: ['b'] },
        ],
      }],
    };
    // Adding c as a predecessor of a would create the cycle.
    expect(createsCycle('a', 'c', buildBarMap(state))).toBe(true);
  });

  it('returns false for an independent pair', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: [] },
          { id: 'b', type: 'work', startIdx: 0, span: 4, buffer: 0, dependsOn: [] },
        ],
      }],
    };
    expect(createsCycle('a', 'b', buildBarMap(state))).toBe(false);
  });
});

describe('autoSequence — linear chain', () => {
  it('places successors tight against predecessors', () => {
    const state = load('linearChain.json');
    const result = autoSequence(state);
    expect(result.ok).toBe(true);

    const a = state.lanes[0].bars.find(b => b.id === 'a');
    const b = state.lanes[0].bars.find(x => x.id === 'b');
    const c = state.lanes[0].bars.find(x => x.id === 'c');

    expect(a.startIdx).toBe(0);
    // a ends at 4 weeks = 1 month; b should start there
    expect(b.startIdx).toBe(1);
    // b ends at 2 months; c starts there
    expect(c.startIdx).toBe(2);

    expect(countViolations(state)).toBe(0);
  });
});

describe('autoSequence — diamond', () => {
  it('D after max(B.end, C.end), not just one of them', () => {
    const state = load('diamond.json');
    autoSequence(state);
    const bars = Object.fromEntries(state.lanes[0].bars.map(b => [b.id, b]));

    expect(bars.a.startIdx).toBe(0);
    expect(bars.b.startIdx).toBe(1); // 1 month after a ends
    expect(bars.c.startIdx).toBe(1);
    // B is 8 weeks = 2 months, ends at 1 + 2 = 3
    // C is 4 weeks = 1 month, ends at 1 + 1 = 2
    // D must start at max(3, 2) = 3
    expect(bars.d.startIdx).toBe(3);

    expect(countViolations(state)).toBe(0);
  });
});

describe('autoSequence — multi-phase', () => {
  it('ratchet propagates phase-gate pushes to successors', () => {
    const state = load('multiPhase.json');
    const result = autoSequence(state);
    expect(result.ok).toBe(true);

    const bars = Object.fromEntries(state.lanes[0].bars.map(b => [b.id, b]));

    // PRS-long: 12 weeks = 3 months
    expect(bars.prs_long.startIdx).toBe(0);
    // DP tasks must be pushed past PRS.end = 3
    expect(bars.dp_first.startIdx).toBeGreaterThanOrEqual(3);
    expect(bars.dp_dep_on_first.startIdx).toBeGreaterThanOrEqual(bars.dp_first.startIdx + 1);
    // DO and FP chain forwards too
    expect(bars.do_one.startIdx).toBeGreaterThanOrEqual(bars.dp_dep_on_first.startIdx + 1);
    expect(bars.fp_one.startIdx).toBeGreaterThanOrEqual(bars.do_one.startIdx + 1);

    expect(countViolations(state)).toBe(0);
  });
});

describe('autoSequence — cycle handling', () => {
  it('returns ok:false with an error message; does not mutate', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'a', type: 'work', startIdx: 7, span: 4, buffer: 0, dependsOn: ['b'] },
          { id: 'b', type: 'work', startIdx: 5, span: 4, buffer: 0, dependsOn: ['a'] },
        ],
      }],
    };
    const snapshot = JSON.stringify(state);
    const result = autoSequence(state);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cycle/i);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('autoSequence — idempotency', () => {
  it('running twice produces the same layout', () => {
    const state = load('multiPhase.json');
    autoSequence(state);
    const after1 = JSON.stringify(state);
    autoSequence(state);
    const after2 = JSON.stringify(state);
    expect(after2).toBe(after1);
  });
});
