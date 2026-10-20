import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { wpNameOnly, renumberWPs } from '../src/proplan-core.mjs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('wpNameOnly', () => {
  it('drops a baked-in split-WP note like "(6 of 15)" or "6 of 15 tasks here"', () => {
    expect(wpNameOnly('WP 1 — Project Management (6 of 15) (6 of 15)')).toBe('Project Management');
    expect(wpNameOnly('WP 1 — Project Management 6 of 15 tasks here')).toBe('Project Management');
    expect(wpNameOnly('WP 2 — Phase 2 of 3 review')).toBe('Phase 2 of 3 review');
  });
  it('strips a canonical "WP N — Name" prefix with em-dash', () => {
    expect(wpNameOnly('WP 7 — Acoustics')).toBe('Acoustics');
  });

  it('handles hyphen and colon separators', () => {
    expect(wpNameOnly('WP 3 - Mechanical')).toBe('Mechanical');
    expect(wpNameOnly('WP 3: Mechanical')).toBe('Mechanical');
  });

  it('handles missing separator', () => {
    expect(wpNameOnly('WP 4 Acoustics')).toBe('Acoustics');
  });

  it('handles "WP" without a space', () => {
    expect(wpNameOnly('WP12 — Foo')).toBe('Foo');
  });

  it('returns the whole string if no prefix matches', () => {
    expect(wpNameOnly('Just a name')).toBe('Just a name');
  });

  it('defends against empty input', () => {
    expect(wpNameOnly('')).toBe('');
    expect(wpNameOnly(null)).toBe('');
    expect(wpNameOnly(undefined)).toBe('');
  });
});

describe('renumberWPs', () => {
  it('rewrites every code to "WP <position> — <name>" in order', () => {
    const state = load('wpReorder.json');
    renumberWPs(state);
    expect(state.lanes.map(l => l.code)).toEqual([
      'WP 1 — Foo',
      'WP 2 — Bar',
      'WP 3 — Baz',
    ]);
  });

  it('preserves the name part after the original prefix', () => {
    const state = {
      lanes: [
        { id: 'l1', code: 'WP 99 — Old name', bars: [] },
      ],
    };
    renumberWPs(state);
    expect(state.lanes[0].code).toBe('WP 1 — Old name');
  });

  it('handles a lane with no code by giving it a placeholder name', () => {
    const state = { lanes: [{ id: 'l1', code: '', bars: [] }] };
    renumberWPs(state);
    expect(state.lanes[0].code).toBe('WP 1 — New work package');
  });

  it('is a no-op on an empty state', () => {
    const state = {};
    renumberWPs(state);
    expect(state).toEqual({});
  });

  it('is idempotent', () => {
    const state = load('wpReorder.json');
    renumberWPs(state);
    const after1 = state.lanes.map(l => l.code);
    renumberWPs(state);
    const after2 = state.lanes.map(l => l.code);
    expect(after2).toEqual(after1);
  });
});

import { wpLabel, altBarRect, ALT_MS_ROW_H } from '../src/proplan-core.mjs';
describe('wpLabel / slim milestone rows', () => {
  it('normalises WP n to WPn for display', () => {
    expect(wpLabel('WP 1 — Foo')).toBe('WP1 — Foo');
    expect(wpLabel('WP12')).toBe('WP12');
    expect(wpLabel('')).toBe('');
  });
  it('milestone diamond fits a slim row', () => {
    const r = altBarRect({ id: 'm', type: 'milestone', startIdx: 1 }, 80, 0, 'L', ALT_MS_ROW_H);
    expect(r.y).toBeGreaterThanOrEqual(0); expect(r.y + r.h).toBeLessThanOrEqual(ALT_MS_ROW_H);
  });
});
