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
  SYSTEM_TRACK_SEEDS,
  getProductTracks,
  getContinuousTracks,
  getTrackById,
  getTrackActivePhase,
  setTrackActivePhase,
  defaultColorForNewTrack,
  addProduct,
  removeTrack,
  renameTrack,
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
    // v5: track ids are user-extensible (custom product names), so barTrack
    // no longer validates against a hardcoded allowlist — it just trusts
    // bar.track if it's a non-empty string. Dangling refs are scrubbed
    // upstream by normaliseState, so by the time barTrack runs, bar.track
    // is either valid or undefined.
    it('returns whatever bar.track is set to (no allowlist enforcement)', () => {
      expect(barTrack({ track: 'foo' }, { track: 'ple' })).toBe('foo');
    });

    // v5 multi-product: bar.tracks is a string[] for activities that belong
    // to multiple products. barTracks() returns the full list; barTrack()
    // returns the first element for legacy callers.
    it('barTracks: bar.tracks array takes precedence', async () => {
      const { barTracks } = await import('../src/proplan-core.mjs');
      expect(barTracks({ tracks: ['a', 'b'] }, { track: 'c' })).toEqual(['a', 'b']);
      expect(barTrack ({ tracks: ['a', 'b'] }, { track: 'c' })).toBe('a');
    });
    it('barTracks: falls back to bar.track then lane.track', async () => {
      const { barTracks } = await import('../src/proplan-core.mjs');
      expect(barTracks({ track: 'x' }, { track: 'y' })).toEqual(['x']);
      expect(barTracks({}, { track: 'y' })).toEqual(['y']);
      expect(barTracks({}, {})).toEqual(['product']);
    });
    it('barTracks: empty/invalid bar.tracks falls through to bar.track', async () => {
      const { barTracks } = await import('../src/proplan-core.mjs');
      expect(barTracks({ tracks: [], track: 'x' }, {})).toEqual(['x']);
      expect(barTracks({ tracks: ['', null], track: 'x' }, {})).toEqual(['x']);
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

    it('drops duplicate entries but PRESERVES user-named tracks', () => {
      // v5: ids are user-extensible — a "foo" track is a perfectly valid
      // user-named product. Only literal duplicate ids are dropped.
      const state = { lanes: [], tracks: [
        { id: 'product', enabled: true },
        { id: 'foo', enabled: true },
        { id: 'product', enabled: false },   // duplicate of product
      ]};
      normaliseState(state);
      // Only one product, kept with its initial enabled value
      expect(state.tracks.filter(t => t.id === 'product')).toHaveLength(1);
      expect(state.tracks.find(t => t.id === 'product').enabled).toBe(true);
      // "foo" survives — it's just a user-named track. Its missing fields
      // (kind, label, color) get filled in by normaliseState's enrichment.
      const foo = state.tracks.find(t => t.id === 'foo');
      expect(foo).toBeDefined();
      expect(foo.enabled).toBe(true);
      expect(foo.kind).toBe('product'); // default for non-system ids
      expect(foo.label).toBe('foo');
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

  // ─── v5: multi-product track model + v4 migration ───────────────────────
  describe('v5 track model — kind + enrichment', () => {
    it('enriches a v4-style track entry with kind/label/color/activePhase', () => {
      const state = { lanes: [], tracks: [
        { id: 'product', enabled: true },
        { id: 'ple', enabled: false },
      ]};
      normaliseState(state);
      const product = state.tracks.find(t => t.id === 'product');
      const ple = state.tracks.find(t => t.id === 'ple');
      // product enriched from SYSTEM_TRACK_SEEDS:
      expect(product.kind).toBe('product');
      expect(product.label).toBe('Product');
      expect(product.color).toEqual({ bar: '#e0f2fe', border: '#0369a1' });
      expect(product.activePhase).toBe(null);
      // ple enriched as continuous:
      expect(ple.kind).toBe('continuous');
      expect(ple.label).toBe('PLE');
      // continuous tracks don't get an activePhase field at all
      expect(ple.activePhase).toBeUndefined();
    });

    it('treats non-system ids as user-named products with kind=product', () => {
      const state = { lanes: [], tracks: [
        { id: 'hearing-aid-v2', enabled: true, label: 'Hearing aid v2' },
      ]};
      normaliseState(state);
      const t = state.tracks.find(x => x.id === 'hearing-aid-v2');
      expect(t.kind).toBe('product');
      expect(t.label).toBe('Hearing aid v2'); // preserved when provided
      expect(t.activePhase).toBe(null);       // default for products
      expect(t.color).toBeDefined();          // colour picked from palette
    });

    it('preserves an existing per-track activePhase across re-normalisation', () => {
      const state = { lanes: [], tracks: [
        { id: 'product', kind: 'product', label: 'P', color: { bar: '#fff', border: '#000' }, enabled: true, activePhase: 'DP' },
      ]};
      normaliseState(state);
      expect(getTrackActivePhase(state, 'product')).toBe('DP');
    });
  });

  describe('v4 → v5 migration of state.activePhase', () => {
    it('moves a global activePhase into the "product" track', () => {
      // v4 shape: state.activePhase is a top-level field, state.tracks is
      // present but tracks don't have a per-track activePhase.
      const state = {
        lanes: [],
        activePhase: 'DO',
        tracks: [
          { id: 'product', enabled: true },
          { id: 'ple', enabled: false },
          { id: 'exploration', enabled: false },
        ],
      };
      normaliseState(state);
      expect(getTrackActivePhase(state, 'product')).toBe('DO');
      // Continuous tracks stay phase-less.
      expect(getTrackActivePhase(state, 'ple')).toBe(null);
    });

    it('does not clobber an existing per-track phase when re-loading', () => {
      const state = {
        lanes: [],
        activePhase: 'PRS',       // legacy global value
        tracks: [
          // Product already has activePhase set (post-migration), DP > PRS
          { id: 'product', kind: 'product', label: 'P', color: { bar: '#fff', border: '#000' }, enabled: true, activePhase: 'DP' },
        ],
      };
      normaliseState(state);
      expect(getTrackActivePhase(state, 'product')).toBe('DP');
    });

    it('preserves PLE and Exploration as continuous after migration', () => {
      const state = { lanes: [], activePhase: 'DP', tracks: [
        { id: 'product', enabled: true },
        { id: 'ple', enabled: true },
        { id: 'exploration', enabled: true },
      ]};
      normaliseState(state);
      const ple = getTrackById(state, 'ple');
      const exp = getTrackById(state, 'exploration');
      expect(ple.kind).toBe('continuous');
      expect(exp.kind).toBe('continuous');
      expect(ple.activePhase).toBeUndefined();
      expect(exp.activePhase).toBeUndefined();
    });
  });

  describe('Product CRUD', () => {
    it('addProduct appends a well-formed track with a unique id', () => {
      const state = { lanes: [] };
      normaliseState(state);
      const t1 = addProduct(state, { label: 'New product' });
      expect(t1.kind).toBe('product');
      expect(t1.enabled).toBe(true);
      expect(t1.activePhase).toBe(null);
      expect(t1.color).toBeDefined();
      // ID is slugified from label
      expect(t1.id).toBe('new-product');
      // Adding another with the same label gets a numeric suffix
      const t2 = addProduct(state, { label: 'New product' });
      expect(t2.id).toBe('new-product-2');
    });

    it('defaultColorForNewTrack avoids colours already in use', () => {
      const state = { lanes: [] };
      normaliseState(state);
      // product seeded with the first palette colour (#0369a1 border)
      const c = defaultColorForNewTrack(state);
      expect(c.border).not.toBe('#0369a1'); // shouldn't pick the same as product
    });

    it('removeTrack reassigns orphaned lanes to a fallback product', () => {
      const state = { lanes: [
        { id: 'l1', track: 'product', bars: [] },
        { id: 'l2', track: 'extra',   bars: [{ id: 'b1', type: 'work', span: 4, track: 'extra' }] },
      ]};
      normaliseState(state);
      addProduct(state, { label: 'Extra' });
      // Force lane.track to point at the new product (normaliseState had
      // already remapped l2 to "product" because "extra" didn't exist yet).
      state.lanes[1].track = 'extra';
      state.lanes[1].bars[0].track = 'extra';
      // Now remove "extra": l2 should rebind to the first remaining product,
      // and b1's per-bar override should be cleared.
      expect(removeTrack(state, 'extra')).toBe(true);
      expect(state.lanes[1].track).toBe('product');
      expect(state.lanes[1].bars[0].track).toBeUndefined();
    });

    it('renameTrack updates the label but keeps the id stable', () => {
      const state = { lanes: [] };
      normaliseState(state);
      expect(renameTrack(state, 'product', 'Hearing aid v2')).toBe(true);
      const p = getTrackById(state, 'product');
      expect(p.label).toBe('Hearing aid v2');
      expect(p.id).toBe('product');
    });
  });

  describe('getProductTracks / getContinuousTracks split', () => {
    it('separates by kind, only returning enabled tracks', () => {
      const state = { lanes: [], tracks: [
        { id: 'product', enabled: true },
        { id: 'extra-prod', kind: 'product', enabled: true, label: 'X', color: { bar: '#fff', border: '#000' } },
        { id: 'ple', enabled: true },
        { id: 'exploration', enabled: false },
      ]};
      normaliseState(state);
      const prods = getProductTracks(state).map(t => t.id);
      const conts = getContinuousTracks(state).map(t => t.id);
      expect(prods).toEqual(['product', 'extra-prod']);
      expect(conts).toEqual(['ple']);   // exploration disabled, excluded
    });
  });

  describe('Milestone follows-end-of', () => {
    it('syncFollowsEndOf snaps a milestone to its target\'s end', async () => {
      const { syncFollowsEndOf } = await import('../src/proplan-core.mjs');
      const state = {
        lanes: [{ id: 'l1', track: 'product', bars: [
          // Activity: 4 weeks, 10% buffer → effSpan = 4.4 weeks = 1.1 months.
          // Starts at month 2 → ends at 3.1.
          { id: 'a1', type: 'work', startIdx: 2, span: 4, buffer: 10, alloc: 100, dependsOn: [] },
          // Milestone with stale startIdx — should be overwritten to 3.1.
          { id: 'm1', type: 'milestone', startIdx: 0, span: 0, dependsOn: [], followsEndOf: 'a1' },
        ]}],
      };
      syncFollowsEndOf(state);
      expect(state.lanes[0].bars[1].startIdx).toBeCloseTo(3.1, 5);
    });

    it('clears followsEndOf when target no longer exists', async () => {
      const { syncFollowsEndOf } = await import('../src/proplan-core.mjs');
      const state = {
        lanes: [{ id: 'l1', track: 'product', bars: [
          { id: 'm1', type: 'milestone', startIdx: 5, span: 0, dependsOn: [], followsEndOf: 'a-deleted' },
        ]}],
      };
      syncFollowsEndOf(state);
      expect(state.lanes[0].bars[0].followsEndOf).toBeUndefined();
      // startIdx untouched (no target to follow).
      expect(state.lanes[0].bars[0].startIdx).toBe(5);
    });

    it('normaliseState scrubs dangling followsEndOf refs and syncs', async () => {
      const state = {
        lanes: [{ id: 'l1', track: 'product', bars: [
          { id: 'a1', type: 'work', startIdx: 1, span: 4, buffer: 0, alloc: 100, dependsOn: [] },
          { id: 'm-valid', type: 'milestone', startIdx: 99, span: 0, dependsOn: [], followsEndOf: 'a1' },
          { id: 'm-dangling', type: 'milestone', startIdx: 99, span: 0, dependsOn: [], followsEndOf: 'a-deleted' },
        ]}],
      };
      normaliseState(state);
      const valid = state.lanes[0].bars.find(b => b.id === 'm-valid');
      const dangling = state.lanes[0].bars.find(b => b.id === 'm-dangling');
      // Valid milestone snapped to a1's end (1 + 4/4 = 2).
      expect(valid.startIdx).toBeCloseTo(2, 5);
      // Dangling ref cleared.
      expect(dangling.followsEndOf).toBeUndefined();
    });
  });

  describe('setTrackActivePhase / getTrackActivePhase', () => {
    it('round-trips a phase per product track', () => {
      const state = { lanes: [] };
      normaliseState(state);
      addProduct(state, { label: 'Earmold' });
      setTrackActivePhase(state, 'product', 'DP');
      setTrackActivePhase(state, 'earmold', 'PRS');
      expect(getTrackActivePhase(state, 'product')).toBe('DP');
      expect(getTrackActivePhase(state, 'earmold')).toBe('PRS');
      // Setting on a continuous track is a no-op
      setTrackActivePhase(state, 'ple', 'DP');
      expect(getTrackActivePhase(state, 'ple')).toBe(null);
    });
  });

  // ─── Disciplines (axis orthogonal to tracks) ─────────────────────────
  describe('Disciplines', () => {
    it('seeds an empty list when missing', async () => {
      const { getDisciplines } = await import('../src/proplan-core.mjs');
      const state = { lanes: [] };
      normaliseState(state);
      expect(Array.isArray(state.disciplines)).toBe(true);
      expect(getDisciplines(state)).toEqual([]);
    });

    it('addDiscipline creates entries with slugified id + palette color', async () => {
      const { addDiscipline, getDisciplines } = await import('../src/proplan-core.mjs');
      const state = { lanes: [] };
      normaliseState(state);
      const a = addDiscipline(state, { label: 'Acoustics' });
      const m = addDiscipline(state, { label: 'Mechanical' });
      expect(a.id).toBe('acoustics');
      expect(m.id).toBe('mechanical');
      expect(a.color).not.toBe(m.color);
      expect(getDisciplines(state)).toHaveLength(2);
    });

    it('duplicate label gets a numeric suffix', async () => {
      const { addDiscipline } = await import('../src/proplan-core.mjs');
      const state = { lanes: [] };
      normaliseState(state);
      const a = addDiscipline(state, { label: 'Quality' });
      const b = addDiscipline(state, { label: 'Quality' });
      expect(a.id).toBe('quality');
      expect(b.id).toBe('quality-2');
    });

    it('removeDiscipline clears dangling refs on bars + lanes', async () => {
      const { addDiscipline, removeDiscipline, barDiscipline } = await import('../src/proplan-core.mjs');
      const state = {
        lanes: [
          { id: 'l1', track: 'product', discipline: 'acoustics', bars: [
            { id: 'b1', type: 'work', span: 1, discipline: 'acoustics' },
            { id: 'b2', type: 'work', span: 1 },
          ]},
        ],
      };
      normaliseState(state);
      addDiscipline(state, { label: 'Acoustics' });
      // Re-tag now that the discipline exists
      state.lanes[0].discipline = 'acoustics';
      state.lanes[0].bars[0].discipline = 'acoustics';
      expect(removeDiscipline(state, 'acoustics')).toBe(true);
      expect(state.lanes[0].discipline).toBeUndefined();
      expect(state.lanes[0].bars[0].discipline).toBeUndefined();
      // barDiscipline returns null when neither bar nor lane is set
      expect(barDiscipline(state.lanes[0].bars[0], state.lanes[0])).toBe(null);
    });

    it('barDiscipline: bar override beats lane default; lane default applies otherwise', async () => {
      const { barDiscipline } = await import('../src/proplan-core.mjs');
      expect(barDiscipline({ discipline: 'mechanical' }, { discipline: 'acoustics' })).toBe('mechanical');
      expect(barDiscipline({}, { discipline: 'acoustics' })).toBe('acoustics');
      expect(barDiscipline({}, {})).toBe(null);
      expect(barDiscipline(null, null)).toBe(null);
    });

    it('barDiscipline: "_none" sentinel is explicit-no, overrides WP default to null', async () => {
      const { barDiscipline } = await import('../src/proplan-core.mjs');
      // Bar explicitly opts out of the WP's acoustics default.
      expect(barDiscipline({ discipline: '_none' }, { discipline: 'acoustics' })).toBe(null);
      // No lane default either — same result.
      expect(barDiscipline({ discipline: '_none' }, {})).toBe(null);
    });

    it('normaliseState preserves the "_none" sentinel on bars', async () => {
      const state = {
        lanes: [
          { id: 'l1', track: 'product', discipline: 'acoustics', bars: [
            { id: 'b1', type: 'work', span: 1, discipline: '_none' },
          ]},
        ],
        disciplines: [{ id: 'acoustics', label: 'Acoustics', color: '#7c3aed' }],
      };
      normaliseState(state);
      expect(state.lanes[0].bars[0].discipline).toBe('_none');
    });

    it('normaliseState scrubs dangling discipline refs', async () => {
      const state = {
        lanes: [
          { id: 'l1', track: 'product', discipline: 'no-such', bars: [
            { id: 'b1', type: 'work', span: 1, discipline: 'also-gone' },
          ]},
        ],
        disciplines: [{ id: 'acoustics', label: 'Acoustics', color: '#7c3aed' }],
      };
      normaliseState(state);
      expect(state.lanes[0].discipline).toBeUndefined();
      expect(state.lanes[0].bars[0].discipline).toBeUndefined();
    });

    it('renameDiscipline updates label, id stays', async () => {
      const { addDiscipline, renameDiscipline, getDisciplineById } = await import('../src/proplan-core.mjs');
      const state = { lanes: [] };
      normaliseState(state);
      addDiscipline(state, { label: 'Acoustics' });
      expect(renameDiscipline(state, 'acoustics', 'Acoustic engineering')).toBe(true);
      expect(getDisciplineById(state, 'acoustics').label).toBe('Acoustic engineering');
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
  it('spans from project start to the END of the last non-ongoing bar (not state.end)', () => {
    const state = {
      start: '2026-01', end: '2026-12',          // declared end is December
      lanes: [{ bars: [
        { id: 'pm',   type: 'ongoing', startIdx: 99, span: 4, alloc: 20 },
        // The real work only runs up to month 5 + 4 weeks = month 6 → 24 weeks.
        { id: 'work', type: 'work',    startIdx: 5, span: 4, buffer: 0, alloc: 100 },
      ]}],
    };
    syncOngoingBars(state);
    const pm = state.lanes[0].bars[0];
    expect(pm.startIdx).toBe(0);
    // 5 months + 1 month of work = 6 months = 24 weeks
    expect(pm.span).toBe(24);
  });
  it('falls back to projectSpanWeeks when there are no other bars', () => {
    const state = {
      start: '2026-01', end: '2026-06',          // 6 months = 24 weeks
      lanes: [{ bars: [{ id: 'pm', type: 'ongoing', startIdx: 99, span: 4, alloc: 20 }] }],
    };
    syncOngoingBars(state);
    expect(state.lanes[0].bars[0].span).toBe(24);
  });
  it('leaves non-ongoing bars unchanged', () => {
    const state = {
      start: '2026-01', end: '2026-06',
      lanes: [{ bars: [
        { id: 'pm',   type: 'ongoing', startIdx: 5, span: 4, alloc: 20 },
        { id: 'work', type: 'work',    startIdx: 5, span: 4, alloc: 100 },
      ]}],
    };
    syncOngoingBars(state);
    expect(state.lanes[0].bars[1].startIdx).toBe(5);
    expect(state.lanes[0].bars[1].span).toBe(4);
  });
  it('milestones count toward the project end (point in time, no duration)', () => {
    const state = {
      start: '2026-01', end: '2026-12',
      lanes: [{ bars: [
        { id: 'pm', type: 'ongoing', startIdx: 0, span: 0, alloc: 20 },
        // Milestone at month 8 → ongoing should still extend to month 8 = 32 weeks
        { id: 'ms', type: 'milestone', startIdx: 8, span: 0 },
        { id: 'w',  type: 'work', startIdx: 3, span: 4, buffer: 0 },   // ends at month 4
      ]}],
    };
    syncOngoingBars(state);
    expect(state.lanes[0].bars[0].span).toBe(32);
  });
  it('is idempotent', () => {
    const state = {
      start: '2026-01', end: '2026-12',
      lanes: [{ bars: [
        { id: 'pm', type: 'ongoing', startIdx: 0, span: 24, alloc: 20 },
        { id: 'w',  type: 'work', startIdx: 5, span: 4, buffer: 0 },
      ]}],
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
