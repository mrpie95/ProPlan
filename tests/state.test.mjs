import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normaliseState,
  spansToWeeks,
  buildBarMap,
  projectSpanWeeks,
  syncOngoingBars,
  effSpan,
  effortWeeks,
  barTrack,
  enabledTracks,
  isTrackEnabled,
  LANE_TRACKS,
  TRACK_DEFAULTS,
  WEEKS_PER_MONTH,
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

  it('clears invalid bar.track to undefined (=inherit) but preserves valid values', () => {
    const state = { lanes: [{ bars: [
      { id: 'a' },                          // no track → undefined
      { id: 'b', track: 'ple' },            // valid → keep
      { id: 'c', track: 'product' },        // valid → keep
      { id: 'd', track: 'foo' },            // invalid → undefined
    ]}]};
    normaliseState(state);
    const bars = state.lanes[0].bars;
    expect(bars[0].track).toBeUndefined();
    expect(bars[1].track).toBe('ple');
    expect(bars[2].track).toBe('product');
    expect(bars[3].track).toBeUndefined();
  });

  describe('barTrack', () => {
    it('returns the bar override when set', () => {
      expect(barTrack({ track: 'ple' }, { track: 'product' })).toBe('ple');
    });
    it('falls back to lane.track when the bar has no override', () => {
      expect(barTrack({}, { track: 'ple' })).toBe('ple');
      expect(barTrack({ track: undefined }, { track: 'product' })).toBe('product');
    });
    it('falls back to "product" when nothing is set', () => {
      expect(barTrack({}, {})).toBe('product');
      expect(barTrack(null, null)).toBe('product');
    });
    it('ignores an invalid bar override', () => {
      expect(barTrack({ track: 'foo' }, { track: 'ple' })).toBe('ple');
    });
  });

  describe('state.tracks seeding', () => {
    it('seeds a full tracks list with default enabled flags when missing', () => {
      const state = { lanes: [] };
      normaliseState(state);
      // One entry per LANE_TRACK, in order
      expect(state.tracks.map(t => t.id)).toEqual(LANE_TRACKS);
      // Product enabled by default, others off
      const byId = Object.fromEntries(state.tracks.map(t => [t.id, t]));
      expect(byId.product.enabled).toBe(true);
      expect(byId.exploration.enabled).toBe(false);
      expect(byId.ple.enabled).toBe(false);
    });

    it('preserves an existing enabled flag', () => {
      const state = { lanes: [], tracks: [{ id: 'ple', enabled: true }] };
      normaliseState(state);
      const byId = Object.fromEntries(state.tracks.map(t => [t.id, t]));
      expect(byId.ple.enabled).toBe(true);
      // The other (missing) tracks get default values
      expect(byId.product.enabled).toBe(true);
      expect(byId.exploration.enabled).toBe(false);
    });

    it('drops invalid / duplicate entries', () => {
      const state = { lanes: [], tracks: [
        { id: 'product', enabled: true },
        { id: 'foo', enabled: true },
        { id: 'product', enabled: false },   // duplicate
      ]};
      normaliseState(state);
      // Only one product, kept with its initial enabled value
      expect(state.tracks.filter(t => t.id === 'product')).toHaveLength(1);
      expect(state.tracks.find(t => t.id === 'product').enabled).toBe(true);
      // No "foo" snuck in
      expect(state.tracks.find(t => t.id === 'foo')).toBeUndefined();
    });
  });

  describe('enabledTracks / isTrackEnabled', () => {
    it('returns just the enabled track ids', () => {
      const state = { tracks: [
        { id: 'product', enabled: true },
        { id: 'exploration', enabled: false },
        { id: 'ple', enabled: true },
      ]};
      expect(enabledTracks(state)).toEqual(['product', 'ple']);
      expect(isTrackEnabled(state, 'product')).toBe(true);
      expect(isTrackEnabled(state, 'exploration')).toBe(false);
      expect(isTrackEnabled(state, 'ple')).toBe(true);
    });

    it('falls back to ["product"] when state has no tracks config', () => {
      expect(enabledTracks({})).toEqual(['product']);
      expect(isTrackEnabled({}, 'product')).toBe(true);
      expect(isTrackEnabled({}, 'ple')).toBe(false);
    });

    it('always returns at least ["product"] if every track is disabled', () => {
      const state = { tracks: LANE_TRACKS.map(id => ({ id, enabled: false })) };
      expect(enabledTracks(state)).toEqual(['product']);
    });
  });

  describe('TRACK_DEFAULTS metadata', () => {
    it('product is phase-bound; exploration + ple are not', () => {
      expect(TRACK_DEFAULTS.product.phaseBound).toBe(true);
      expect(TRACK_DEFAULTS.exploration.phaseBound).toBe(false);
      expect(TRACK_DEFAULTS.ple.phaseBound).toBe(false);
    });

    it('every LANE_TRACK has a label', () => {
      for (const id of LANE_TRACKS) {
        expect(TRACK_DEFAULTS[id]).toBeDefined();
        expect(typeof TRACK_DEFAULTS[id].label).toBe('string');
      }
    });
  });

  it('defaults lane.track to "product" when missing / invalid', () => {
    const state = { lanes: [
      { id: 'l1' },                          // missing → product
      { id: 'l2', track: 'ple' },            // valid → keep
      { id: 'l3', track: 'foo' },            // invalid → product
    ]};
    normaliseState(state);
    expect(state.lanes[0].track).toBe('product');
    expect(state.lanes[1].track).toBe('ple');
    expect(state.lanes[2].track).toBe('product');
  });

  it('defaults alloc to 100 when missing / invalid', () => {
    const state = { lanes: [{ bars: [
      { id: 'a', type: 'work', span: 4 },                  // missing → 100
      { id: 'b', type: 'work', span: 4, alloc: -10 },      // negative → 100
      { id: 'c', type: 'work', span: 4, alloc: 200 },      // > 100 → 100
      { id: 'd', type: 'work', span: 4, alloc: 33 },       // valid → keep
    ]}]};
    normaliseState(state);
    const bars = state.lanes[0].bars;
    expect(bars[0].alloc).toBe(100);
    expect(bars[1].alloc).toBe(100);
    expect(bars[2].alloc).toBe(100);
    expect(bars[3].alloc).toBe(33);
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

describe('projectSpanWeeks', () => {
  it('returns months × WEEKS_PER_MONTH for a valid range', () => {
    // 2026-01 .. 2026-06 = 6 months × 4 = 24 weeks
    expect(projectSpanWeeks({ start: '2026-01', end: '2026-06' })).toBe(24);
  });
  it('returns 0 for missing fields', () => {
    expect(projectSpanWeeks({})).toBe(0);
    expect(projectSpanWeeks(null)).toBe(0);
  });
});

describe('syncOngoingBars', () => {
  it('forces every ongoing bar to startIdx=0, span=projectSpanWeeks', () => {
    const state = {
      start: '2026-01', end: '2026-06',          // 24 weeks
      lanes: [{ bars: [
        { id: 'pm',   type: 'ongoing', startIdx: 5, span: 4, alloc: 20 },
        { id: 'work', type: 'work',    startIdx: 5, span: 4, alloc: 100 },
      ]}],
    };
    syncOngoingBars(state);
    const pm = state.lanes[0].bars[0];
    const work = state.lanes[0].bars[1];
    expect(pm.startIdx).toBe(0);
    expect(pm.span).toBe(24);
    // Work bars unaffected
    expect(work.startIdx).toBe(5);
    expect(work.span).toBe(4);
  });
  it('is idempotent', () => {
    const state = {
      start: '2026-01', end: '2026-06',
      lanes: [{ bars: [{ id: 'pm', type: 'ongoing', startIdx: 0, span: 24, alloc: 20 }] }],
    };
    syncOngoingBars(state);
    const snap = JSON.stringify(state);
    syncOngoingBars(state);
    expect(JSON.stringify(state)).toBe(snap);
  });
  it('handles missing fields gracefully', () => {
    syncOngoingBars(null);
    syncOngoingBars({});
    syncOngoingBars({ lanes: [] });   // should not throw
  });
});

describe('effSpan / effortWeeks for ongoing bars', () => {
  it('effSpan returns the stored span verbatim (no buffer multiplier)', () => {
    const ongoing = { type: 'ongoing', span: 24, buffer: 50 };
    expect(effSpan(ongoing)).toBe(24);    // buffer ignored
  });
  it('effortWeeks scales by alloc for ongoing too', () => {
    // 24-week ongoing at 20% workload → 4.8 effort weeks
    const ongoing = { type: 'ongoing', span: 24, alloc: 20 };
    expect(effortWeeks(ongoing)).toBeCloseTo(4.8, 6);
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
