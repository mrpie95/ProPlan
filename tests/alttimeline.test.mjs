import { describe, it, expect } from 'vitest';
import {
  normaliseState, buildBarMap, effSpan, WEEKS_PER_MONTH,
  ALT_TOOLS, altToolById, altToolForKey, altToolAllowed, altResolveTool, altSwitchTool,
  altBarRect, altLayout, altRowAt, altHitTest, altNormBox, altMarqueeSelect, altSelectClick,
  altSnapGrid, altEdgeWeeks, altSnapPoint, altSnapMove, altZoomColW, altZoomToRange,
  altBeginGesture, altFrozenReason, altSnapshot, altMoveBars, altResizeBar,
  altCreateBar, altAddEndMilestone, altSplitBar, altLinkBars, altUnlinkBars,
  altDeleteBars, altDuplicateBars, altBulkEdit, altAlignBars, altSelectionSummary,
  altBarDates, altStartIdxFromDate, ALT_ROW_H, ALT_MS_ROW_H, ALT_LANE_H,
} from '../src/proplan-core.mjs';

function mk() {
  const s = {
    start: '2026-01', end: '2026-12', colWidth: 80, processId: 'sop18',
    lanes: [
      { id: 'L1', code: 'WP 1 — A', desc: '', bars: [
        { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, label: 'A', dependsOn: [] },
        { id: 'b', type: 'work', startIdx: 1, span: 4, buffer: 25, label: 'B', dependsOn: ['a'] },
        { id: 'm', type: 'milestone', startIdx: 2, span: 0, label: 'M', dependsOn: [] },
      ] },
      { id: 'L2', code: 'WP 2 — B', desc: '', bars: [
        { id: 'c', type: 'work', startIdx: 3, span: 8, buffer: 0, label: 'C', dependsOn: ['b'] },
      ] },
      { id: 'L3', code: 'WP 3 — empty', desc: '', bars: [] },
    ],
  };
  normaliseState(s);
  // normaliseState defaults buffer to 10 only when missing/negative; keep ours.
  return s;
}
const bar = (s, id) => buildBarMap(s)[id].bar;

describe('tool table', () => {
  it('has unique ids and keys', () => {
    expect(new Set(ALT_TOOLS.map(t => t.id)).size).toBe(ALT_TOOLS.length);
    expect(new Set(ALT_TOOLS.map(t => t.key)).size).toBe(ALT_TOOLS.length);
  });
  it('maps keys case-insensitively', () => {
    expect(altToolForKey('V').id).toBe('select');
    expect(altToolForKey('b').id).toBe('draw');
    expect(altToolForKey('q')).toBeNull();
  });
  it('gates edit tools in view-only', () => {
    expect(altToolAllowed('draw', false)).toBe(false);
    expect(altToolAllowed('draw', true)).toBe(true);
    for (const id of ['select', 'done', 'hand', 'zoom']) expect(altToolAllowed(id, false)).toBe(true);
  });
  it('space turns any tool into hand', () => {
    expect(altResolveTool('draw', { space: true })).toBe('hand');
    expect(altResolveTool('draw')).toBe('draw');
    expect(altResolveTool('nope')).toBe('select');
  });
  it('altSwitchTool reports blocked / changed', () => {
    expect(altSwitchTool('select', 'b', { editMode: false })).toMatchObject({ tool: 'select', blocked: 'view-only', changed: false });
    expect(altSwitchTool('select', 'b', { editMode: true })).toMatchObject({ tool: 'draw', changed: true });
    expect(altSwitchTool('select', 'h')).toMatchObject({ tool: 'hand', changed: true });
    expect(altSwitchTool('draw', 'x', { editMode: true })).toMatchObject({ tool: 'draw', changed: false });
  });
});

describe('geometry', () => {
  it('lays out lane headers, task rows and an empty-lane row', () => {
    const s = mk();
    const lay = altLayout(s, 80);
    expect(lay.rows.map(r => r.kind)).toEqual(['lane', 'bar', 'bar', 'bar', 'lane', 'bar', 'lane', 'empty']);
    expect(lay.rows[1].y).toBe(ALT_LANE_H);
    expect(lay.height).toBe(3 * ALT_LANE_H + 3 * ALT_ROW_H + ALT_MS_ROW_H + ALT_ROW_H);
    expect(lay.width).toBe(12 * 80);
    expect(lay.rects).toHaveLength(4);
  });
  it('bar width uses the buffered calendar length; min one week', () => {
    const s = mk();
    const lay = altLayout(s, 80);
    expect(lay.rectById.a.x).toBe(0);
    expect(lay.rectById.a.w).toBe(80);                 // 4 wk = 1 month
    expect(lay.rectById.b.w).toBeCloseTo(100);         // 4 wk + 25% = 5 wk
    bar(s, 'a').span = 0.1;
    expect(altBarRect(bar(s, 'a'), 80, 0, 'L1').w).toBe(20); // floor: 1 week
  });
  it('milestones sit half a column in unless they follow an activity', () => {
    const s = mk();
    expect(altBarRect(bar(s, 'm'), 80, 0, 'L1').cx).toBe(2 * 80 + 40);
    bar(s, 'm').followsEndOf = 'a';
    expect(altBarRect(bar(s, 'm'), 80, 0, 'L1').cx).toBe(2 * 80);
  });
  it('collapsed WPs hide their bars', () => {
    const s = mk();
    const lay = altLayout(s, 80, { collapsed: new Set(['L1']) });
    expect(lay.rectById.a).toBeUndefined();
    expect(lay.rectById.c).toBeDefined();
  });
  it('laneFilter limits to one WP', () => {
    const lay = altLayout(mk(), 80, { laneFilter: 'L2' });
    expect(lay.rows.map(r => r.laneId)).toEqual(['L2', 'L2']);
  });
  it('altRowAt finds rows by y', () => {
    const lay = altLayout(mk(), 80);
    expect(altRowAt(lay.rows, 5).kind).toBe('lane');
    expect(altRowAt(lay.rows, ALT_LANE_H + 2).barId).toBe('a');
    expect(altRowAt(lay.rows, 99999)).toBeNull();
  });
});

describe('hit testing', () => {
  const s = mk();
  const lay = altLayout(s, 80);
  const r = lay.rectById.b;
  const cy = r.y + r.h / 2;
  it('finds body and edges', () => {
    expect(altHitTest(lay.rects, r.x + r.w / 2, cy)).toMatchObject({ barId: 'b', zone: 'body' });
    expect(altHitTest(lay.rects, r.x + 2, cy)).toMatchObject({ barId: 'b', zone: 'l' });
    expect(altHitTest(lay.rects, r.x + r.w - 2, cy)).toMatchObject({ barId: 'b', zone: 'r' });
  });
  it('returns null on empty space and between rows', () => {
    expect(altHitTest(lay.rects, 900, cy)).toBeNull();
    expect(altHitTest(lay.rects, r.x + 10, r.y - 10)).toBeNull();
  });
  it('hits milestones with their own zone', () => {
    const m = lay.rectById.m;
    expect(altHitTest(lay.rects, m.cx, m.y + 9)).toMatchObject({ barId: 'm', zone: 'ms', milestone: true });
  });
  it('shrinks edge zones on very narrow bars so the body stays grabbable', () => {
    const t = mk(); bar(t, 'a').span = 1;             // 20px wide at 80px/month
    const l = altLayout(t, 80);
    const ra = l.rectById.a;
    expect(altHitTest(l.rects, ra.x + ra.w / 2, ra.y + 5).zone).toBe('body');
  });
  it('reports flags and relative position', () => {
    const t = mk(); bar(t, 'a').locked = true;
    const l = altLayout(t, 80);
    const ra = l.rectById.a;
    const h = altHitTest(l.rects, ra.x + ra.w * 0.25, ra.y + 5);
    expect(h.locked).toBe(true);
    expect(h.rel).toBeCloseTo(0.25);
  });
});

describe('selection + marquee', () => {
  const lay = altLayout(mk(), 80);
  it('plain / shift / meta clicks', () => {
    expect(altSelectClick(['a'], 'b')).toEqual(['b']);
    expect(altSelectClick(['a'], 'b', { shift: true })).toEqual(['a', 'b']);
    expect(altSelectClick(['a', 'b'], 'b', { meta: true })).toEqual(['a']);
    expect(altSelectClick(['a'], 'b', { meta: true })).toEqual(['a', 'b']);
    expect(altSelectClick(['a', 'b'], 'a', { shift: true })).toEqual(['a', 'b']);
  });
  it('normalises boxes dragged in any direction', () => {
    expect(altNormBox(10, 20, 2, 5)).toEqual({ x0: 2, y0: 5, x1: 10, y1: 20 });
  });
  it('marquee selects intersecting bars in every mode', () => {
    const box = { x0: 0, y0: 0, x1: 120, y1: ALT_LANE_H + ALT_ROW_H * 2 };
    expect(altMarqueeSelect(lay.rects, box).sort()).toEqual(['a', 'b']);
    expect(altMarqueeSelect(lay.rects, box, 'add', ['c']).sort()).toEqual(['a', 'b', 'c']);
    expect(altMarqueeSelect(lay.rects, box, 'toggle', ['a', 'c']).sort()).toEqual(['b', 'c']);
    expect(altMarqueeSelect(lay.rects, { x0: 5000, y0: 0, x1: 5100, y1: 10 })).toEqual([]);
  });
});

describe('snapping', () => {
  it('grid snap by setting', () => {
    expect(altSnapGrid(2.6, 'week')).toBe(3);
    expect(altSnapGrid(2.6, '2week')).toBe(2);
    expect(altSnapGrid(5.5, 'month')).toBe(4);
    expect(altSnapGrid(2.6, 'off')).toBe(2.6);
    expect(altSnapGrid(2.6, 'bogus')).toBe(3);
  });
  it('edge list excludes the moving bars', () => {
    const s = mk();
    const edges = altEdgeWeeks(s, new Set(['b']));
    expect(edges).toContain(0); expect(edges).toContain(4);   // a: 0..4
    expect(edges).not.toContain(5.25 * 1);                     // b would end at 4+5=9
    expect(edges).toContain(8);                                // milestone m at 2 months
  });
  it('snapPoint prefers a close edge over the grid', () => {
    expect(altSnapPoint(4.3, { edges: [4], thresholdW: 0.5 })).toEqual({ weeks: 4, kind: 'edge' });
    expect(altSnapPoint(4.3, { edges: [9], thresholdW: 0.5 })).toEqual({ weeks: 4, kind: 'grid' });
    expect(altSnapPoint(4.3, { disable: true })).toEqual({ weeks: 4.3, kind: null });
  });
  it('snapMove snaps either end of the moving bar to an edge', () => {
    // bar 0..3 weeks wants to start at 5.2 -> its end 8.2 snaps to edge 8 -> start 5
    const r = altSnapMove({ startW: 0, effW: 3 }, 5.2, { edges: [8], thresholdW: 0.5 });
    expect(r.kind).toBe('edge'); expect(r.dW).toBeCloseTo(5); expect(r.atW).toBe(8);
  });
  it('snapMove falls back to the grid and honours disable', () => {
    expect(altSnapMove({ startW: 1, effW: 3 }, 2.4, { grid: 'week' }).dW).toBe(2);
    expect(altSnapMove({ startW: 1, effW: 3 }, 2.4, { disable: true }).dW).toBe(2.4);
    expect(altSnapMove({ startW: 1, effW: 3 }, 2.4, { grid: 'month' }).dW).toBe(3);
  });
});

describe('zoom', () => {
  it('steps and clamps', () => {
    expect(altZoomColW(80, 'in')).toBe(100);
    expect(altZoomColW(80, 'out')).toBe(64);
    expect(altZoomColW(15, 'out')).toBe(15);
    expect(altZoomColW(390, 'in')).toBe(400);
  });
  it('zoom-to-range scales so the range fills the viewport', () => {
    const r = altZoomToRange(80, 100, 300, 800);
    expect(r.colW).toBe(320);
    expect(r.scrollLeft).toBeCloseTo(100 * 4);
    expect(altZoomToRange(80, 100, 103, 800)).toEqual({ colW: 80, scrollLeft: null });
  });
});

describe('gesture decision table', () => {
  const hit = (o = {}) => ({ barId: 'a', laneId: 'L1', zone: 'body', rel: 0.5, locked: false, milestone: false, linked: false, ongoing: false, done: false, ...o });
  const row = { kind: 'bar', laneId: 'L1', barId: 'a' };
  const E = { editMode: true };
  it('view-only blocks every edit tool but not select/done/hand/zoom', () => {
    expect(altBeginGesture('draw', null, {}, row, { editMode: false })).toEqual({ kind: 'blocked', why: 'view-only' });
    expect(altBeginGesture('lock', hit(), {}, row, { editMode: false }).kind).toBe('blocked');
    expect(altBeginGesture('done', hit(), {}, row, { editMode: false }).kind).toBe('toggle-done');
    expect(altBeginGesture('hand', null, {}, null, { editMode: false }).kind).toBe('pan');
    expect(altBeginGesture('zoom', null, {}, null, { editMode: false }).kind).toBe('zoom-rect');
    expect(altBeginGesture('select', hit(), {}, row, { editMode: false })).toMatchObject({ kind: 'select', drag: false });
    expect(altBeginGesture('select', null, {}, row, { editMode: false }).kind).toBe('marquee');
  });
  it('select: body moves, edges resize, empty marquees (with modifier modes)', () => {
    expect(altBeginGesture('select', hit(), {}, row, E).kind).toBe('move');
    expect(altBeginGesture('select', hit({ zone: 'l' }), {}, row, E).kind).toBe('resize-l');
    expect(altBeginGesture('select', hit({ zone: 'r' }), {}, row, E).kind).toBe('resize-r');
    expect(altBeginGesture('select', null, {}, row, E)).toEqual({ kind: 'marquee', mode: 'replace' });
    expect(altBeginGesture('select', null, { shift: true }, row, E).mode).toBe('add');
    expect(altBeginGesture('select', null, { meta: true }, row, E).mode).toBe('toggle');
    expect(altBeginGesture('select', hit({ milestone: true, zone: 'ms' }), {}, row, E).kind).toBe('move');
  });
  it('frozen bars select but never drag', () => {
    expect(altBeginGesture('select', hit({ locked: true }), {}, row, E)).toMatchObject({ kind: 'select', drag: false, why: 'locked' });
    expect(altBeginGesture('select', hit({ ongoing: true }), {}, row, E).why).toBe('auto');
    expect(altBeginGesture('select', hit({ milestone: true, linked: true, zone: 'ms' }), {}, row, E).why).toBe('linked');
    expect(altBeginGesture('resize', hit({ locked: true }), {}, row, E)).toEqual({ kind: 'blocked', why: 'locked' });
    expect(altBeginGesture('split', hit({ locked: true }), {}, row, E).kind).toBe('blocked');
  });
  it('resize tool trims the nearer half', () => {
    expect(altBeginGesture('resize', hit({ rel: 0.2 }), {}, row, E).kind).toBe('resize-l');
    expect(altBeginGesture('resize', hit({ rel: 0.8 }), {}, row, E).kind).toBe('resize-r');
    expect(altBeginGesture('resize', hit({ milestone: true }), {}, row, E).kind).toBe('none');
    expect(altBeginGesture('resize', null, {}, row, E).kind).toBe('none');
  });
  it('draw / milestone / link / split / lock / done', () => {
    expect(altBeginGesture('draw', null, {}, row, E)).toEqual({ kind: 'draw', laneId: 'L1', afterBarId: 'a' });
    expect(altBeginGesture('draw', null, {}, { kind: 'lane', laneId: 'L2' }, E)).toEqual({ kind: 'draw', laneId: 'L2', afterBarId: null });
    expect(altBeginGesture('draw', hit(), {}, row, E)).toMatchObject({ kind: 'select', drag: false });
    expect(altBeginGesture('milestone', hit(), {}, row, E)).toEqual({ kind: 'milestone-at-end', barId: 'a' });
    expect(altBeginGesture('milestone', null, {}, row, E).kind).toBe('milestone-drop');
    expect(altBeginGesture('link', hit(), {}, row, E)).toEqual({ kind: 'link', fromId: 'a' });
    expect(altBeginGesture('link', null, {}, row, E).kind).toBe('none');
    expect(altBeginGesture('split', hit(), {}, row, E)).toEqual({ kind: 'split', barId: 'a' });
    expect(altBeginGesture('split', hit({ milestone: true }), {}, row, E).kind).toBe('none');
    expect(altBeginGesture('lock', hit({ locked: true }), {}, row, E)).toEqual({ kind: 'toggle-lock', barId: 'a' });
    expect(altBeginGesture('lock', hit({ milestone: true }), {}, row, E)).toEqual({ kind: 'toggle-lock', barId: 'a' });
    expect(altBeginGesture('done', hit({ milestone: true }), {}, row, E)).toEqual({ kind: 'toggle-done', barId: 'a' });
    expect(altBeginGesture('zoom', null, { alt: true }, null, E).kind).toBe('zoom-out');
  });
});

describe('moveBars', () => {
  it('moves a group together and keeps offsets', () => {
    const s = mk();
    const snap = altSnapshot(s, ['a', 'b']);
    const r = altMoveBars(s, snap, 2, { numMonths: 12 });
    expect(r.moved.sort()).toEqual(['a', 'b']);
    expect(bar(s, 'a').startIdx).toBeCloseTo(0.5);
    expect(bar(s, 'b').startIdx).toBeCloseTo(1.5);
  });
  it('clamps the whole group at the project start', () => {
    const s = mk();
    const snap = altSnapshot(s, ['a', 'b']);
    altMoveBars(s, snap, -10, { numMonths: 12 });
    expect(bar(s, 'a').startIdx).toBe(0);
    expect(bar(s, 'b').startIdx).toBe(1);              // offset preserved, not squashed
  });
  it('clamps at the project end using the buffered length', () => {
    const s = mk();
    const snap = altSnapshot(s, ['b']);
    altMoveBars(s, snap, 999, { numMonths: 12 });
    expect(bar(s, 'b').startIdx + effSpan(bar(s, 'b')) / WEEKS_PER_MONTH).toBeCloseTo(12);
  });
  it('is idempotent against the snapshot (drag back to 0 restores)', () => {
    const s = mk();
    const snap = altSnapshot(s, ['b']);
    altMoveBars(s, snap, 6); altMoveBars(s, snap, 0);
    expect(bar(s, 'b').startIdx).toBe(1);
  });
  it('skips locked, ongoing and linked-milestone bars and reports them', () => {
    const s = mk();
    bar(s, 'a').locked = true;
    bar(s, 'm').followsEndOf = 'b';
    const snap = altSnapshot(s, ['a', 'b', 'm']);
    const r = altMoveBars(s, snap, 4, { numMonths: 12 });
    expect(r.moved).toEqual(['b']);
    expect(r.blocked).toEqual([{ id: 'a', reason: 'locked' }, { id: 'm', reason: 'linked' }]);
    expect(bar(s, 'a').startIdx).toBe(0);
  });
  it('a frozen bar does not constrain the movers', () => {
    const s = mk();
    bar(s, 'a').locked = true;
    const snap = altSnapshot(s, ['a', 'b']);
    altMoveBars(s, snap, -2);
    expect(bar(s, 'b').startIdx).toBeCloseTo(0.5);     // would have been clamped by a at 0
  });
});

describe('resizeBar', () => {
  it('right edge follows the pointer through the buffer', () => {
    const s = mk();
    const snap = altSnapshot(s, ['b']);                // 4 wk +25% = 5 wk
    altResizeBar(s, snap, 'b', 'r', 5);                // -> 10 calendar weeks
    expect(effSpan(bar(s, 'b'))).toBeCloseTo(10);
    expect(bar(s, 'b').span).toBeCloseTo(8);
  });
  it('left edge keeps the right edge fixed', () => {
    const s = mk();
    const snap = altSnapshot(s, ['b']);
    const endBefore = bar(s, 'b').startIdx * 4 + effSpan(bar(s, 'b'));
    altResizeBar(s, snap, 'b', 'l', 2);
    expect(bar(s, 'b').startIdx * 4 + effSpan(bar(s, 'b'))).toBeCloseTo(endBefore);
    expect(bar(s, 'b').startIdx).toBeCloseTo(1.5);
  });
  it('never goes below one week or before the project start', () => {
    const s = mk();
    const snap = altSnapshot(s, ['b']);
    altResizeBar(s, snap, 'b', 'r', -99);
    expect(effSpan(bar(s, 'b'))).toBeCloseTo(1);
    altResizeBar(s, snap, 'b', 'l', -99);
    expect(bar(s, 'b').startIdx).toBe(0);
    altResizeBar(s, snap, 'b', 'l', 99);
    expect(effSpan(bar(s, 'b'))).toBeCloseTo(1);
  });
  it('clamps at the project end', () => {
    const s = mk();
    const snap = altSnapshot(s, ['c']);
    altResizeBar(s, snap, 'c', 'r', 999, { numMonths: 12 });
    expect(bar(s, 'c').startIdx + effSpan(bar(s, 'c')) / 4).toBeCloseTo(12);
  });
  it('refuses milestones, locked and ongoing bars', () => {
    const s = mk(); bar(s, 'a').locked = true;
    expect(altResizeBar(s, {}, 'm', 'r', 1)).toMatchObject({ ok: false, reason: 'milestone' });
    expect(altResizeBar(s, {}, 'a', 'r', 1)).toMatchObject({ ok: false, reason: 'locked' });
    expect(altResizeBar(s, {}, 'zz', 'r', 1)).toMatchObject({ ok: false, reason: 'missing' });
  });
});

describe('create', () => {
  it('creates a work bar with defaults, after a given bar', () => {
    const s = mk();
    const b = altCreateBar(s, 'L1', { startIdx: 3, span: 6, afterBarId: 'a' });
    expect(s.lanes[0].bars.map(x => x.id)).toEqual(['a', b.id, 'b', 'm']);
    expect(b).toMatchObject({ type: 'work', startIdx: 3, span: 6, buffer: 10, alloc: 100, dependsOn: [] });
  });
  it('milestones get span 0 / buffer 0', () => {
    const b = altCreateBar(mk(), 'L1', { type: 'milestone', startIdx: 5 });
    expect(b).toMatchObject({ type: 'milestone', span: 0, buffer: 0, label: 'New milestone' });
  });
  it('rejects ongoing type, bad lanes; validates phase / track / discipline', () => {
    const s = mk();
    s.disciplines = [{ id: 'mech', label: 'Mech', color: '#000' }];
    expect(altCreateBar(s, 'nope')).toBeNull();
    expect(altCreateBar(s, 'L1', { type: 'ongoing' }).type).toBe('work');
    const b = altCreateBar(s, 'L1', { phase: 'DP', track: 'product', discipline: 'mech' });
    expect(b).toMatchObject({ phase: 'DP', track: 'product', discipline: 'mech' });
    const c = altCreateBar(s, 'L1', { phase: 'XYZ', track: 'zzz', discipline: 'zzz' });
    expect(c.phase).toBeUndefined(); expect(c.track).toBeUndefined(); expect(c.discipline).toBeUndefined();
  });
  it('inherits the lane phase when none is given', () => {
    const s = mk(); s.lanes[0].phase = 'DO';
    expect(altCreateBar(s, 'L1').phase).toBe('DO');
    expect(altCreateBar(s, 'L1', { phase: '' }).phase).toBeUndefined();
  });
  it('end milestone follows its activity and sits at its end', () => {
    const s = mk();
    const ms = altAddEndMilestone(s, 'b');
    expect(ms.followsEndOf).toBe('b');
    expect(ms.startIdx).toBeCloseTo(1 + 5 / 4);
    expect(altAddEndMilestone(s, 'm')).toBeNull();
  });
});

describe('split', () => {
  it('cuts into two bars, second depends on first and inherits successors', () => {
    const s = mk();
    const r = altSplitBar(s, 'b', 2);                  // b is 5 cal weeks
    expect(r.ok).toBe(true);
    const first = bar(s, 'b'), second = bar(s, r.newId);
    expect(effSpan(first)).toBeCloseTo(2);
    expect(effSpan(second)).toBeCloseTo(3);
    expect(second.startIdx).toBeCloseTo(first.startIdx + 2 / 4);
    expect(second.dependsOn).toEqual(['b']);
    expect(bar(s, 'c').dependsOn).toEqual([r.newId]);
    expect(s.lanes[0].bars.map(x => x.id)).toEqual(['a', 'b', r.newId, 'm']);
  });
  it('moves follow-end milestones and phase bleed to the tail; clears done/lock on the tail', () => {
    const s = mk();
    bar(s, 'm').followsEndOf = 'b';
    bar(s, 'b').done = true; bar(s, 'b').phaseEnd = 'DO';
    const r = altSplitBar(s, 'b', 2);
    expect(bar(s, 'm').followsEndOf).toBe(r.newId);
    expect(bar(s, r.newId).phaseEnd).toBe('DO');
    expect(bar(s, 'b').phaseEnd).toBeUndefined();
    expect(bar(s, r.newId).done).toBeUndefined();
  });
  it('refuses too-short halves, milestones, locked', () => {
    const s = mk();
    expect(altSplitBar(s, 'b', 0.2).error).toBe('too-short');
    expect(altSplitBar(s, 'b', 4.8).error).toBe('too-short');
    expect(altSplitBar(s, 'm', 1).error).toBe('milestone');
    bar(s, 'a').locked = true;
    expect(altSplitBar(s, 'a', 2).error).toBe('locked');
    expect(altSplitBar(s, 'zz', 2).error).toBe('missing');
  });
  it('gap pushes the tail later', () => {
    const s = mk();
    const r = altSplitBar(s, 'c', 4, { gapWeeks: 2 });
    expect(bar(s, r.newId).startIdx).toBeCloseTo(3 + 6 / 4);
  });
});

describe('link / delete / duplicate', () => {
  it('links, rejects self / dup / cycle / missing', () => {
    const s = mk();
    expect(altLinkBars(s, 'a', 'c')).toEqual({ ok: true });
    expect(bar(s, 'c').dependsOn).toContain('a');
    expect(altLinkBars(s, 'a', 'c').error).toBe('exists');
    expect(altLinkBars(s, 'a', 'a').error).toBe('self');
    expect(altLinkBars(s, 'c', 'a').error).toBe('cycle');
    expect(altLinkBars(s, 'a', 'zz').error).toBe('missing');
  });
  it('unlinks', () => {
    const s = mk();
    expect(altUnlinkBars(s, 'a', 'b').ok).toBe(true);
    expect(bar(s, 'b').dependsOn).toEqual([]);
    expect(altUnlinkBars(s, 'a', 'b').ok).toBe(false);
  });
  it('delete scrubs dependencies and follow pointers, protects locked', () => {
    const s = mk();
    bar(s, 'm').followsEndOf = 'b';
    bar(s, 'a').locked = true;
    const r = altDeleteBars(s, ['a', 'b']);
    expect(r.removed).toEqual(['b']);
    expect(r.skipped).toEqual([{ id: 'a', reason: 'locked' }]);
    expect(bar(s, 'c').dependsOn).toEqual([]);
    expect(bar(s, 'm').followsEndOf).toBeUndefined();
    expect(buildBarMap(s).b).toBeUndefined();
  });
  it('duplicate places the copy after the original, later, clean flags', () => {
    const s = mk();
    bar(s, 'b').done = true; bar(s, 'b').locked = true; bar(s, 'b').doneAt = '2026-01-02';
    const [id] = altDuplicateBars(s, ['b']);
    const copy = bar(s, id);
    expect(s.lanes[0].bars.map(x => x.id)).toEqual(['a', 'b', id, 'm']);
    expect(copy.startIdx).toBeCloseTo(1 + 5 / 4);
    expect(copy.done).toBeUndefined(); expect(copy.locked).toBeUndefined();
    expect(copy.dependsOn).toEqual(['a']);
    copy.dependsOn.push('x');
    expect(bar(s, 'b').dependsOn).toEqual(['a']);     // not shared
  });
  it('duplicate honours an explicit offset', () => {
    const s = mk();
    const [id] = altDuplicateBars(s, ['a'], { offsetWeeks: 8 });
    expect(bar(s, id).startIdx).toBeCloseTo(2);
  });
});

describe('bulk edit', () => {
  it('applies valid fields to every bar and counts changes', () => {
    const s = mk();
    const r = altBulkEdit(s, ['a', 'b', 'c'], { alloc: 50, buffer: 20, type: 'review' });
    expect(r).toMatchObject({ changed: 3, invalid: 0, skippedLocked: 0 });
    for (const id of ['a', 'b', 'c']) expect(bar(s, id)).toMatchObject({ alloc: 50, buffer: 20, type: 'review' });
  });
  it('ignores invalid values and reports them', () => {
    const s = mk();
    const r = altBulkEdit(s, ['a'], { alloc: 150, buffer: -3, phase: 'ZZZ', type: 'ongoing', track: 'nope' });
    expect(r.changed).toBe(0); expect(r.invalid).toBe(5);
    expect(bar(s, 'a').alloc).toBe(100);
  });
  it('locked bars accept only the locked field', () => {
    const s = mk(); bar(s, 'a').locked = true;
    const r = altBulkEdit(s, ['a', 'b'], { alloc: 40 });
    expect(r).toMatchObject({ changed: 1, skippedLocked: 1 });
    expect(bar(s, 'a').alloc).toBe(100);
    altBulkEdit(s, ['a'], { locked: false });
    expect(bar(s, 'a').locked).toBeUndefined();
  });
  it('type -> milestone zeroes span; back to work restores a span', () => {
    const s = mk();
    altBulkEdit(s, ['a'], { type: 'milestone' });
    expect(bar(s, 'a').span).toBe(0);
    altBulkEdit(s, ['a'], { type: 'work' });
    expect(bar(s, 'a').span).toBe(4);
  });
  it('milestones skip span/buffer/alloc silently', () => {
    const s = mk();
    const r = altBulkEdit(s, ['m'], { span: 4, buffer: 5, alloc: 10 });
    expect(r).toMatchObject({ changed: 0, invalid: 0 });
    expect(bar(s, 'm').span).toBe(0);
  });
  it('phase set/clear, track and discipline set/clear', () => {
    const s = mk();
    s.disciplines = [{ id: 'mech', label: 'Mech', color: '#000' }];
    altBulkEdit(s, ['a'], { phase: 'DP', track: 'product', discipline: 'mech' });
    expect(bar(s, 'a')).toMatchObject({ phase: 'DP', track: 'product', discipline: 'mech' });
    bar(s, 'a').phaseEnd = 'DO';
    altBulkEdit(s, ['a'], { phase: '', track: '', discipline: '' });
    expect(bar(s, 'a').phase).toBeUndefined();
    expect(bar(s, 'a').phaseEnd).toBeUndefined();
    expect(bar(s, 'a').track).toBeUndefined();
    expect(bar(s, 'a').discipline).toBeUndefined();
  });
  it('phase respects the active process (stage-gate has no DP)', () => {
    const s = mk(); s.processId = 'stagegate';
    expect(altBulkEdit(s, ['a'], { phase: 'DP' }).invalid).toBe(1);
    expect(altBulkEdit(s, ['a'], { phase: 'DEV' }).changed).toBe(1);
  });
});

describe('align + summary + dates', () => {
  it('aligns starts and ends, skipping frozen bars', () => {
    const s = mk();
    expect(altAlignBars(s, ['a', 'b', 'c'], 'start').sort()).toEqual(['b', 'c']);
    expect(bar(s, 'c').startIdx).toBe(0);
    const t = mk();
    altAlignBars(t, ['a', 'c'], 'end');                // c ends at 3+2=5 months
    expect(bar(t, 'a').startIdx + 1).toBeCloseTo(5);
    const u = mk(); bar(u, 'c').locked = true;
    expect(altAlignBars(u, ['a', 'c'], 'start')).toEqual([]);
    expect(altAlignBars(u, ['a'], 'start')).toEqual([]);
  });
  it('summary flags mixed values', () => {
    const s = mk();
    bar(s, 'a').alloc = 50;
    const sum = altSelectionSummary(s, ['a', 'b']);
    expect(sum.count).toBe(2);
    expect(sum.values.alloc.mixed).toBe(true);
    expect(sum.values.type).toEqual({ value: 'work', mixed: false });
    expect(sum.effWeeks).toBeCloseTo(4 + 5);
    expect(sum.startW).toBe(0); expect(sum.endW).toBeCloseTo(9);
    expect(altSelectionSummary(s, []).startW).toBeNull();
  });
  it('bar dates: whole months + week offsets; round-trips with the picker', () => {
    const s = mk();
    expect(altBarDates(s, { startIdx: 0, span: 4, buffer: 0, type: 'work' })).toEqual({ start: '2026-01-01', end: '2026-01-29' });
    expect(altBarDates(s, { startIdx: 1.5, span: 2, buffer: 0, type: 'work' }).start).toBe('2026-02-15');
    expect(altBarDates(s, { startIdx: 2, type: 'milestone', span: 0 })).toEqual({ start: '2026-03-01', end: '2026-03-01' });
    expect(altStartIdxFromDate(s, '2026-02-15')).toBeCloseTo(1.5);
    expect(altStartIdxFromDate(s, '2026-03-01')).toBe(2);
    expect(altStartIdxFromDate(s, 'garbage')).toBeNull();
    expect(altStartIdxFromDate(s, '2025-06-01')).toBe(0);
  });
  it('frozen reasons', () => {
    expect(altFrozenReason({ locked: true })).toBe('locked');
    expect(altFrozenReason({ type: 'ongoing' })).toBe('auto');
    expect(altFrozenReason({ type: 'milestone', followsEndOf: 'x' })).toBe('linked');
    expect(altFrozenReason({ type: 'work' })).toBeNull();
  });
});

describe('altLayout without WP header rows', () => {
  it('drops headers of expanded WPs with tasks, keeps collapsed and empty ones', () => {
    const s = mk();
    const lay = altLayout(s, 80, { laneHeaders: false, collapsed: new Set(['L2']) });
    expect(lay.rows.map(r => r.kind + ':' + r.laneId)).toEqual(['bar:L1', 'bar:L1', 'bar:L1', 'lane:L2', 'lane:L3', 'empty:L3']);
    expect(lay.height).toBe(2 * ALT_ROW_H + ALT_MS_ROW_H + ALT_LANE_H + ALT_LANE_H + ALT_ROW_H);
    expect(lay.rectById.a.y).toBeCloseTo((ALT_ROW_H - 18) / 2, 5);
  });
});

describe('milestone locks and layout filters', () => {
  it('bulk edit can lock and unlock a milestone, which then freezes it', () => {
    const s = mk();
    expect(altBulkEdit(s, ['m'], { locked: true }).changed).toBe(1);
    expect(bar(s, 'm').locked).toBe(true);
    expect(altFrozenReason(bar(s, 'm'))).toBe('locked');
    expect(altBulkEdit(s, ['m'], { locked: false }).changed).toBe(1);
    expect(bar(s, 'm').locked).toBeUndefined();
  });
  it('altLayout barFilter drops hidden tasks and WPs whose tasks are all hidden', () => {
    const s = mk();
    const lay = altLayout(s, 80, { barFilter: (b) => b.type !== 'milestone' && b.id !== 'c' });
    expect(lay.rects.map(r => r.barId)).toEqual(['a', 'b']);
    expect(lay.rows.filter(r => r.kind === 'lane').map(r => r.laneId)).toEqual(['L1', 'L3']);   // L2 hidden, empty L3 kept
  });
  it('altLayout laneFilter accepts a predicate', () => {
    const s = mk();
    const lay = altLayout(s, 80, { laneFilter: (l) => l.id === 'L2' });
    expect(lay.rects.map(r => r.barId)).toEqual(['c']);
  });
});

describe('altLayout milestonesAtBottom', () => {
  it('moves milestones under a Milestones section, ordered by date; WPs of only milestones disappear', () => {
    const s = mk();
    s.lanes[2].bars.push({ id: 'm9', type: 'milestone', startIdx: 0, span: 0, label: 'Only', dependsOn: [] });
    const lay = altLayout(s, 80, { milestonesAtBottom: true, laneHeaders: false });
    expect(lay.rows.map(r => (r.kind === 'section' ? 'section' : r.barId || r.kind))).toEqual(['a', 'b', 'c', 'section', 'm9', 'm']);
    expect(lay.rows.at(-1).tail).toBe(true);
    expect(lay.rects.map(r => r.barId)).toEqual(['a', 'b', 'c', 'm9', 'm']);
    expect(lay.height).toBe(3 * ALT_ROW_H + ALT_LANE_H + 2 * ALT_ROW_H);
  });
});
