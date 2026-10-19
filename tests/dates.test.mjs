import { describe, it, expect } from 'vitest';
import {
  parseYM,
  toDateInputValue,
  monthsBetween,
  effSpan,
  fmtDur,
  rnd1,
  laneEffWeeks,
  WEEKS_PER_MONTH,
} from '../src/proplan-core.mjs';

describe('parseYM', () => {
  it('parses legacy YYYY-MM with day defaulting to 1', () => {
    expect(parseYM('2026-05')).toEqual({ y: 2026, m: 5, d: 1 });
  });

  it('parses full YYYY-MM-DD', () => {
    expect(parseYM('2026-05-15')).toEqual({ y: 2026, m: 5, d: 15 });
  });

  it('defends against empty / null / undefined — no throw, d defaults to 1', () => {
    // The function is intentionally lenient: for bad input you get back an
    // object with d:1 and whatever Number() makes of the rest. The important
    // contract is "no throw, callers can read .d safely".
    for (const bad of ['', null, undefined]) {
      const r = parseYM(bad);
      expect(r).toBeTypeOf('object');
      expect(r.d).toBe(1);
    }
  });
});

describe('toDateInputValue', () => {
  it('pads month and day', () => {
    expect(toDateInputValue('2026-05')).toBe('2026-05-01');
    expect(toDateInputValue('2026-1-3')).toBe('2026-01-03');
  });

  it('returns empty string for falsy input', () => {
    expect(toDateInputValue('')).toBe('');
    expect(toDateInputValue(null)).toBe('');
  });
});

describe('monthsBetween', () => {
  it('produces inclusive month list across a single year', () => {
    expect(monthsBetween('2026-03', '2026-05')).toEqual([
      { y: 2026, m: 3 },
      { y: 2026, m: 4 },
      { y: 2026, m: 5 },
    ]);
  });

  it('handles single-month ranges', () => {
    expect(monthsBetween('2026-07', '2026-07')).toEqual([{ y: 2026, m: 7 }]);
  });

  it('crosses year boundaries correctly', () => {
    const res = monthsBetween('2025-11', '2026-02');
    expect(res).toEqual([
      { y: 2025, m: 11 },
      { y: 2025, m: 12 },
      { y: 2026, m: 1 },
      { y: 2026, m: 2 },
    ]);
  });

  it('returns empty when end < start', () => {
    expect(monthsBetween('2026-05', '2026-01')).toEqual([]);
  });
});

describe('effSpan', () => {
  it('returns 0 for milestones', () => {
    expect(effSpan({ type: 'milestone', span: 99, buffer: 50 })).toBe(0);
  });

  it('returns raw span when buffer is 0 / missing', () => {
    expect(effSpan({ type: 'work', span: 4, buffer: 0 })).toBe(4);
    expect(effSpan({ type: 'work', span: 4 })).toBe(4);
  });

  it('scales by buffer percentage', () => {
    expect(effSpan({ type: 'work', span: 4, buffer: 25 })).toBe(5);
    expect(effSpan({ type: 'work', span: 10, buffer: 100 })).toBe(20);
  });

  it('handles missing fields gracefully', () => {
    expect(effSpan({ type: 'work' })).toBe(0);
    expect(effSpan(null)).toBe(0);
  });
});

describe('fmtDur / rnd1 / laneEffWeeks', () => {
  it('fmtDur produces a "X wk · ≈Y mo" string', () => {
    expect(fmtDur(4)).toMatch(/^4 wk · ≈1 mo$/);
    expect(fmtDur(6)).toMatch(/^6 wk · ≈1\.5 mo$/);
  });

  it('rnd1 rounds to 1 decimal', () => {
    expect(rnd1(1.234)).toBe(1.2);
    expect(rnd1(1.25)).toBe(1.3);
  });

  it('laneEffWeeks sums effSpan across all bars', () => {
    const lane = {
      bars: [
        { type: 'work', span: 4, buffer: 0 },           // 4
        { type: 'work', span: 4, buffer: 25 },          // 5
        { type: 'milestone', span: 0, buffer: 0 },      // 0
      ],
    };
    expect(laneEffWeeks(lane)).toBe(9);
  });
});

describe('WEEKS_PER_MONTH', () => {
  it('is 4', () => {
    expect(WEEKS_PER_MONTH).toBe(4);
  });
});
