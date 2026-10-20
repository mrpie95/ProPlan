import { describe, it, expect } from 'vitest';
import {
  VIEW_DEFAULTS, VIEW_PRESETS, VIEW_MONTH_PRESETS, viewPresetById, matchViewPreset, viewPresetPatch,
  ALT_MONTHS_LADDER, altClampMonths, altEffMonths, altColWForMonths, altMonthsStep, altMonthsForSpan, altParseMonths,
  altFitMonths, normaliseState,
} from '../src/proplan-core.mjs';

describe('view presets', () => {
  it('has the three built-ins', () => {
    expect(VIEW_PRESETS.map(p => p.id)).toEqual(['planning', 'review', 'presentation']);
    expect(viewPresetById('review').settings.deps).toBe('markers');
    expect(viewPresetById('nope')).toBeNull();
  });
  it('every preset round-trips: defaults + patch matches itself', () => {
    for (const p of VIEW_PRESETS) {
      const applied = { ...VIEW_DEFAULTS, ...viewPresetPatch(p.id, VIEW_DEFAULTS) };
      expect(matchViewPreset(applied)).toBe(p.id);
    }
  });
  it('reports custom when nothing matches', () => {
    expect(matchViewPreset({ ...VIEW_DEFAULTS })).toBe('custom');
    expect(matchViewPreset({ ...VIEW_DEFAULTS, months: 12, deps: 'routed', names: true, today: true, arrows: true })).toBe('custom');
    expect(matchViewPreset(null)).toBe('custom');
  });
  it('a manual change after applying a preset becomes custom', () => {
    const s = { ...VIEW_DEFAULTS, ...viewPresetPatch('planning', VIEW_DEFAULTS) };
    expect(matchViewPreset(s)).toBe('planning');
    expect(matchViewPreset({ ...s, deps: 'routed' })).toBe('custom');
  });
  it('ignores keys a preset does not mention', () => {
    const s = { ...VIEW_DEFAULTS, ...viewPresetPatch('planning', VIEW_DEFAULTS), weeks: true, msBottom: true, compact: true };
    expect(matchViewPreset(s)).toBe('planning');
  });
  it('patch only contains keys that differ and null for unknown ids', () => {
    expect(viewPresetPatch('planning', { months: 12, deps: 'all', names: true, today: true, arrows: true })).toEqual({});
    expect(viewPresetPatch('review', VIEW_DEFAULTS)).toEqual({ months: 24, deps: 'markers', msBottom: true });
    expect(viewPresetPatch('x', {})).toBeNull();
  });
  it('picks the preset with the most matching keys when two overlap', () => {
    // names:false + arrows:false + compact + weeks:false matches presentation; review needs deps+msBottom too
    const s = { ...VIEW_DEFAULTS, arrows: false, compact: true, names: false, weeks: false, deps: 'markers', msBottom: true };
    expect(matchViewPreset(s)).toBe('presentation');
  });
});

describe('months shown', () => {
  it('clamps months: 0 = whole project, 1..60 otherwise', () => {
    expect(altClampMonths(0)).toBe(0); expect(altClampMonths(-3)).toBe(0); expect(altClampMonths('x')).toBe(0);
    expect(altClampMonths(7.4)).toBe(7); expect(altClampMonths(500)).toBe(60); expect(altClampMonths(0.2)).toBe(1);
  });
  it('effective months', () => {
    expect(altEffMonths(0, 30)).toBe(30); expect(altEffMonths(12, 30)).toBe(12); expect(altEffMonths(40, 30)).toBe(30);
  });
  it('column width makes N months exactly fill the viewport', () => {
    expect(altColWForMonths(1200, 12)).toBe(100);
    expect(altColWForMonths(1000, 12) * 12).toBeLessThanOrEqual(1000);
    expect(altColWForMonths(1000, 12) * 12).toBeGreaterThan(1000 - 12);
    expect(altColWForMonths(10, 60)).toBe(6);   // floor
    expect(altColWForMonths(1000, 0)).toBe(1000);
  });
  it('ladder steps', () => {
    expect(altMonthsStep(12, 'in', 36)).toBe(9); expect(altMonthsStep(12, 'out', 36)).toBe(18);
    expect(altMonthsStep(1, 'in', 36)).toBe(1); expect(altMonthsStep(24, 'out', 30)).toBe(0);   // 36 >= project: whole project
    expect(altMonthsStep(0, 'in', 30)).toBe(24); expect(altMonthsStep(0, 'out', 30)).toBe(0);
    expect(altMonthsStep(5, 'in', 0)).toBe(4); expect(altMonthsStep(5, 'out', 0)).toBe(6);
    expect(altMonthsStep(60, 'out', 0)).toBe(60);
    for (let i = 1; i < ALT_MONTHS_LADDER.length; i++) expect(ALT_MONTHS_LADDER[i]).toBeGreaterThan(ALT_MONTHS_LADDER[i - 1]);
  });
  it('months for a dragged span and parsing', () => {
    expect(altMonthsForSpan(300, 100)).toBe(3); expect(altMonthsForSpan(-250, 100)).toBe(3); expect(altMonthsForSpan(2, 100)).toBe(1);
    expect(altParseMonths('12')).toBe(12); expect(altParseMonths(' All ')).toBe(0); expect(altParseMonths('0')).toBe(0);
    expect(altParseMonths('99')).toBe(60); expect(altParseMonths('abc')).toBeNull(); expect(altParseMonths('')).toBeNull();
  });
  it('presets', () => {
    expect(VIEW_MONTH_PRESETS.map(p => p.months)).toEqual([3, 6, 12, 24, 0]);
  });
});

describe('altFitMonths (zoom ▸ Fit)', () => {
  const st = (bars) => { const s = { start: '2026-01', end: '2026-12', lanes: [{ id: 'L', code: 'WP 1 — A', bars: bars.map(b => ({ buffer: 0, ...b })) }] }; normaliseState(s); return s; };
  it('is the month the last task ends in, plus one', () => {
    // 9 weeks = ends 2.25 months in (during month 3) -> 4
    expect(altFitMonths(st([{ id: 'a', type: 'work', startIdx: 0, span: 9, label: 'A' }]))).toBe(4);
  });
  it('a task ending exactly on a month boundary is in that month', () => {
    expect(altFitMonths(st([{ id: 'a', type: 'work', startIdx: 0, span: 8, label: 'A' }]))).toBe(3);   // ends at 2.0 -> month 2 -> 3
  });
  it('uses the latest bar, milestones included', () => {
    const s = st([
      { id: 'a', type: 'work', startIdx: 0, span: 4, label: 'A' },
      { id: 'm', type: 'milestone', startIdx: 5.5, span: 0, label: 'M' },
    ]);
    expect(altFitMonths(s)).toBe(7);   // milestone in month 6 -> 7
  });
  it('counts the buffered (calendar) length', () => {
    const s = st([{ id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 25, label: 'A' }]);   // 5 wk = 1.25 mo -> month 2 -> 3
    expect(altFitMonths(s)).toBe(3);
  });
  it('ignores ongoing bars and honours the include filter', () => {
    const s = st([
      { id: 'lead', type: 'ongoing', startIdx: 0, span: 80, label: 'Lead' },
      { id: 'a', type: 'work', startIdx: 0, span: 4, label: 'A' },
      { id: 'z', type: 'work', startIdx: 10, span: 4, label: 'Z' },
    ]);
    expect(altFitMonths(s)).toBe(12);                              // Z ends at 11.0 -> month 11 -> 12
    expect(altFitMonths(s, (b) => b.id !== 'z')).toBe(2);          // A ends at 1.0 -> month 1 -> 2
  });
  it('nothing to fit = 0 (whole project); clamps to 60', () => {
    expect(altFitMonths({ start: '2026-01', end: '2026-12', lanes: [] })).toBe(0);
    expect(altFitMonths(st([{ id: 'a', type: 'work', startIdx: 0, span: 4 * 90, label: 'Long' }]))).toBe(60);
  });
});
