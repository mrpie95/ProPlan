import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normaliseState,
  spansToWeeks,
  buildBarMap,
} from '../src/proplan-core.mjs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('normaliseState', () => {
  it('fills missing dependsOn with []', () => {
    const state = { lanes: [{ bars: [{ id: 'a', type: 'work', span: 4 }] }] };
    normaliseState(state);
    expect(state.lanes[0].bars[0].dependsOn).toEqual([]);
  });

  it('clamps invalid / missing buffer to 10', () => {
    const state = { lanes: [{ bars: [
      { id: 'a', type: 'work', span: 4 },              // missing
      { id: 'b', type: 'work', span: 4, buffer: -5 },  // negative
      { id: 'c', type: 'work', span: 4, buffer: 30 },  // valid, keep
    ]}]};
    normaliseState(state);
    expect(state.lanes[0].bars[0].buffer).toBe(10);
    expect(state.lanes[0].bars[1].buffer).toBe(10);
    expect(state.lanes[0].bars[2].buffer).toBe(30);
  });

  it('defaults activePhase to null when missing', () => {
    const state = { lanes: [] };
    normaliseState(state);
    expect(state.activePhase).toBeNull();
  });

  it('preserves an existing activePhase', () => {
    const state = { lanes: [], activePhase: 'DP' };
    normaliseState(state);
    expect(state.activePhase).toBe('DP');
  });
});

describe('spansToWeeks (v3 → v4 migration)', () => {
  it('multiplies non-milestone spans by 4 and clamps to >= 1', () => {
    const state = load('legacyV3.json');
    spansToWeeks(state);
    const bars = state.lanes[0].bars;
    expect(bars.find(b => b.id === 'a').span).toBe(8);  // 2 months × 4
    expect(bars.find(b => b.id === 'b').span).toBe(2);  // 0.5 × 4
    expect(bars.find(b => b.id === 'ms').span).toBe(0); // milestone → 0
  });

  it('clamps a sub-quarter-month span to at least 1 week', () => {
    const state = { lanes: [{ bars: [{ id: 'tiny', type: 'work', span: 0.1 }] }] };
    spansToWeeks(state);
    expect(state.lanes[0].bars[0].span).toBe(1); // round(0.1 × 4) = 0, clamped to 1
  });
});

describe('buildBarMap', () => {
  it('returns a barId → {laneIdx, lane, bar} map', () => {
    const state = load('linearChain.json');
    const map = buildBarMap(state);
    expect(Object.keys(map).sort()).toEqual(['a', 'b', 'c']);
    expect(map.a.laneIdx).toBe(0);
    expect(map.a.lane).toBe(state.lanes[0]);
    expect(map.a.bar).toBe(state.lanes[0].bars.find(b => b.id === 'a'));
  });

  it('handles empty lanes / missing fields', () => {
    expect(buildBarMap({})).toEqual({});
    expect(buildBarMap({ lanes: [] })).toEqual({});
  });
});

describe('JSON roundtrip', () => {
  it('parse(stringify(state)) preserves the shape of every fixture', () => {
    for (const name of ['linearChain.json', 'diamond.json', 'multiPhase.json', 'bleed.json']) {
      const original = load(name);
      const round = JSON.parse(JSON.stringify(original));
      expect(round).toEqual(original);
    }
  });
});
