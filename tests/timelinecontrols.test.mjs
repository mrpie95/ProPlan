import { describe, it, expect } from 'vitest';
import { TIMELINE_CONTROLS, timelineControlsFor } from '../src/proplan-core.mjs';

const ids = TIMELINE_CONTROLS.map(c => c.id);
const all = (r) => [...r.bar, ...r.overflow, ...r.options, ...r.hidden, ...r.panel];

describe('timelineControlsFor', () => {
  it('has unique control ids and DOM ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
    const doms = TIMELINE_CONTROLS.map(c => c.dom);
    expect(new Set(doms).size).toBe(doms.length);
  });

  it('classic Timeline: every view control in the bar, edit-only ones only while editing', () => {
    const view = timelineControlsFor('viewA', { editing: false });
    expect(view.hidden.sort()).toEqual(['autoSeq', 'redo', 'undo']);
    expect(view.bar).toContain('editToggle');
    expect(view.overflow).toEqual([]);
    expect(view.options).toEqual([]);
    const edit = timelineControlsFor('viewA', { editing: true });
    expect(edit.bar).toEqual(ids);
    expect(edit.hidden).toEqual([]);
  });

  it('classic Timeline is unchanged by narrow windows', () => {
    expect(timelineControlsFor('viewA', { editing: true, narrow: true })).toEqual(timelineControlsFor('viewA', { editing: true }));
  });

  it('Alt: edit controls move to the options bar, none appear twice', () => {
    for (const editing of [false, true]) for (const narrow of [false, true]) {
      const r = timelineControlsFor('altTimeline', { editing, narrow });
      expect(r.options.sort()).toEqual(['autoSeq', 'editToggle', 'redo', 'undo']);
      expect(r.bar).not.toContain('undo');
      const every = all(r);
      expect(new Set(every).size).toBe(every.length);
      expect(every.sort()).toEqual([...ids].sort());
    }
  });

  it('Alt: every view control lives in the side-panel card; the bar and overflow stay empty', () => {
    for (const narrow of [false, true]) {
      const r = timelineControlsFor('altTimeline', { narrow });
      expect(r.bar).toEqual([]);
      expect(r.overflow).toEqual([]);
      expect(r.panel).toEqual(expect.arrayContaining(['zoom', 'fit', 'display', 'track', 'disciplines', 'layout', 'focusWp', 'exportImage', 'collapseAll', 'focusMode']));
    }
  });

  it('other views get nothing', () => {
    expect(timelineControlsFor('plan')).toEqual({ bar: [], overflow: [], options: [], hidden: [], panel: [] });
  });
});

import { normaliseState, launchMarkers } from '../src/proplan-core.mjs';
describe('state.launch (target launch day)', () => {
  const mk = (launch) => { const st = { start: '2026-01', end: '2026-12', colWidth: 80, lanes: [], launch }; normaliseState(st); return st; };
  it('keeps a valid day, drops junk', () => {
    expect(mk('2026-11-30').launch).toBe('2026-11-30');
    expect('launch' in mk('soon')).toBe(false);
    expect('launch' in mk(undefined)).toBe(false);
  });
});

describe('track.launch (per-product target launch)', () => {
  it('kept on product tracks when a valid day, dropped otherwise', () => {
    const st = { start: '2026-01', end: '2026-12', colWidth: 80, lanes: [], tracks: [
      { id: 'product', kind: 'product', label: 'P', enabled: true, launch: '2026-10-01' },
      { id: 'p2', kind: 'product', label: 'Q', enabled: true, launch: 'later' },
      { id: 'ple', kind: 'continuous', label: 'PLE', enabled: true, launch: '2026-10-01' },
    ] };
    normaliseState(st);
    const by = Object.fromEntries(st.tracks.map(t => [t.id, t]));
    expect(by.product.launch).toBe('2026-10-01');
    expect('launch' in by.p2).toBe(false);
    expect('launch' in by.ple).toBe(false);
  });
});

describe('launchMarkers', () => {
  it('one marker per product with a target, positioned in fractional months from start', () => {
    const st = { start: '2026-01', end: '2026-12', colWidth: 80, lanes: [], tracks: [
      { id: 'product', kind: 'product', label: 'Switch', enabled: true, launch: '2026-03-16' },
      { id: 'p2', kind: 'product', label: 'Insert', enabled: true },
    ] };
    normaliseState(st);
    const m = launchMarkers(st);
    expect(m.map(x => x.id)).toEqual(['product']);
    expect(m[0].label).toBe('Switch launch');
    expect(m[0].at).toBeCloseTo(2 + 15 / 31, 5);
  });
  it('falls back to the project-level launch when there are no products', () => {
    const st = { start: '2026-01', end: '2026-12', colWidth: 80, lanes: [], tracks: [], launch: '2026-02-01' };
    normaliseState(st);
    const prods = st.tracks.filter(t => t.kind === 'product' && t.enabled);
    if (!prods.length) expect(launchMarkers(st).map(x => x.id)).toEqual(['project']);
  });
});

import { altTaskCodes, altDepEdges } from '../src/proplan-core.mjs';
describe('task codes and dependency edges', () => {
  const mk = () => { const st = { start: '2026-01', end: '2026-12', colWidth: 80, lanes: [
    { id: 'L1', code: 'WP 1 — A', desc: '', bars: [
      { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, label: 'A', dependsOn: [] },
      { id: 'm', type: 'milestone', startIdx: 1, span: 0, label: 'M', dependsOn: ['a'] } ] },
    { id: 'L2', code: 'WP 2 — B', desc: '', bars: [
      { id: 'c', type: 'work', startIdx: 0, span: 4, buffer: 0, label: 'C', dependsOn: ['a'] } ] } ] }; normaliseState(st); return st; };
  it('tasks are WP.n; milestones are numbered separately as WP.Mn', () => {
    const c = altTaskCodes(mk());
    expect([c.a.code, c.m.code, c.c.code, c.c.short, c.m.short]).toEqual(['WP1.1', 'WP1.M1', 'WP2.1', '2.1', 'M1.1']);
  });
  it('edges flag overlaps and respect the visible set', () => {
    const e = altDepEdges(mk());
    expect(e.map(x => `${x.pred}>${x.succ}:${x.invalid}`).sort()).toEqual(['a>c:true', 'a>m:false']);
    expect(altDepEdges(mk(), new Set(['a', 'm'])).map(x => x.succ)).toEqual(['m']);
  });
});
