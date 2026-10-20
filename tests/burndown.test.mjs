import { describe, it, expect } from 'vitest';
import {
  normaliseState, burndownTasks, burndownSeries, burndownSequence, burndownForecast, burndownValueAt,
  burndownInclude, burndownWeekOf, burndownStartDay, burndownDaysBetween, burndownAddDays,
} from '../src/proplan-core.mjs';

/* Project starts Mon 2026-01-05. startIdx is in months (a week = 0.25), span in weeks, buffer 0:
   A: wk0-2 → due 2026-01-19, B: wk2-4 → due 2026-02-02, C: starts month 1 (Feb 5), 2 wk → due 2026-02-19. */
/* normaliseState defaults a missing buffer to 10 %, which would stretch every planned end; pin it to 0. */
const norm = (s) => {
  for (const l of s.lanes) for (const b of l.bars) if (b.buffer === undefined) b.buffer = 0;
  normaliseState(s);
};
const mk = (over = {}) => {
  const s = {
    start: '2026-01-05', end: '2026-12-31',
    lanes: [
      { id: 'L1', code: 'WP 1 — Alpha', bars: [
        { id: 'a', type: 'work', startIdx: 0, span: 2, label: 'A' },
        { id: 'b', type: 'work', startIdx: 0.5, span: 2, label: 'B' },
        { id: 'c', type: 'work', startIdx: 1, span: 2, label: 'C' },
      ] },
    ],
    ...over,
  };
  norm(s);
  return s;
};
const bar = (s, id) => s.lanes.flatMap(l => l.bars).find(b => b.id === id);
const TODAY = '2026-02-02';

describe('date helpers', () => {
  it('adds / subtracts days in UTC', () => {
    expect(burndownAddDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(burndownDaysBetween('2026-01-05', '2026-02-02')).toBe(28);
    expect(burndownDaysBetween('2026-02-02', '2026-01-05')).toBe(-28);
  });
  it('project start / project week', () => {
    const s = mk();
    expect(burndownStartDay(s)).toBe('2026-01-05');
    expect(burndownWeekOf(s, '2026-01-05')).toBe(1);
    expect(burndownWeekOf(s, '2026-01-12')).toBe(2);
    expect(burndownWeekOf(s, '2026-02-02')).toBe(5);
  });
  it('accepts a YYYY-MM project start', () => {
    expect(burndownStartDay({ start: '2026-03' })).toBe('2026-03-01');
  });
});

describe('burndownTasks', () => {
  it('lists planned dates and excludes ongoing bars', () => {
    const s = mk();
    s.lanes[0].bars.push({ id: 'lead', type: 'ongoing', startIdx: 0, span: 40, label: 'Lead' });
    const t = burndownTasks(s);
    expect(t.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(t[0]).toMatchObject({ plannedStart: '2026-01-05', plannedEnd: '2026-01-19', weight: 1, short: '1.1' });
  });
  it('effort weight = effort weeks (alloc applied), milestones weigh 0', () => {
    const s = mk();
    bar(s, 'a').alloc = 50;
    s.lanes[0].bars.push({ id: 'm', type: 'milestone', startIdx: 1, span: 0, label: 'Gate' });
    const t = burndownTasks(s, { weight: 'effort' });
    expect(t.find(x => x.id === 'a').weight).toBe(1);        // 2 wk × 50 %
    expect(t.find(x => x.id === 'b').weight).toBe(2);
    expect(t.find(x => x.id === 'm').weight).toBe(0);
    expect(burndownTasks(s).find(x => x.id === 'm').weight).toBe(1);   // counts as a task in "tasks" mode
  });
  it('include() filters; burndownInclude builds wp / track predicates', () => {
    const s = mk();
    s.lanes.push({ id: 'L2', code: 'WP 2 — Beta', bars: [{ id: 'd', type: 'work', startIdx: 0, span: 1, label: 'D' }] });
    norm(s);
    expect(burndownTasks(s, { include: burndownInclude('wp:L2') }).map(x => x.id)).toEqual(['d']);
    expect(burndownTasks(s, { include: burndownInclude('all') }).length).toBe(4);
    expect(burndownInclude('all')).toBe(null);
  });
});

describe('burndownSeries — ideal staircase', () => {
  it('drops by one on each task due day', () => {
    const r = burndownSeries(mk(), { today: TODAY });
    expect(r.total).toBe(3);
    expect(r.ideal).toEqual([
      { day: '2026-01-05', remaining: 3 },
      { day: '2026-01-19', remaining: 2 },
      { day: '2026-02-02', remaining: 1 },
      { day: '2026-02-19', remaining: 0 },        // C starts a whole month in (Feb 5), 2 wk long
    ]);
    expect(r.planFinish).toBe('2026-02-19');
  });
  it('ties become one bigger step', () => {
    const s = mk();
    bar(s, 'b').startIdx = 0;       // B now also ends 2026-01-19
    const r = burndownSeries(s, { today: TODAY });
    expect(r.ideal.map(p => p.remaining)).toEqual([3, 1, 0]);
  });
  it('effort mode: heavier task = bigger drop; zero-weight milestone adds no step', () => {
    const s = mk();
    bar(s, 'a').span = 4; bar(s, 'a').startIdx = 0;          // 4 wk, due 2026-02-02 (same day as B)
    s.lanes[0].bars.push({ id: 'm', type: 'milestone', startIdx: 0.25, span: 0, label: 'Gate' });
    const r = burndownSeries(s, { weight: 'effort', today: TODAY });
    expect(r.total).toBe(8);
    expect(r.ideal).toEqual([
      { day: '2026-01-05', remaining: 8 },
      { day: '2026-02-02', remaining: 2 },   // A (4) and B (2) are both due this day
      { day: '2026-02-19', remaining: 0 },
    ]);
  });
  it('empty plan', () => {
    const r = burndownSeries({ start: '2026-01', end: '2026-12', lanes: [] }, { today: TODAY });
    expect(r.total).toBe(0);
    expect(r.forecast).toBe(null);
    expect(r.ideal).toEqual([{ day: '2026-01-01', remaining: 0 }]);
  });
});

describe('burndownSeries — actual', () => {
  it('drops on doneAt, extends flat to today', () => {
    const s = mk();
    Object.assign(bar(s, 'a'), { done: true, doneAt: '2026-01-19' });
    Object.assign(bar(s, 'b'), { done: true, doneAt: '2026-01-26' });
    const r = burndownSeries(s, { today: TODAY });
    expect(r.actual).toEqual([
      { day: '2026-01-05', remaining: 3 },
      { day: '2026-01-19', remaining: 2 },
      { day: '2026-01-26', remaining: 1 },
      { day: '2026-02-02', remaining: 1 },
    ]);
    expect(r.remaining).toBe(1);
    expect(r.doneCount).toBe(2);
  });
  it('out-of-order completion is just its own drop', () => {
    const s = mk();
    Object.assign(bar(s, 'c'), { done: true, doneAt: '2026-01-12' });
    const r = burndownSeries(s, { today: TODAY });
    expect(burndownValueAt(r.actual, '2026-01-12')).toBe(2);
  });
  it('done without a date counts as done from the start and is reported', () => {
    const s = mk();
    s.lanes[0].bars[0].done = true;                    // no doneAt
    const r = burndownSeries(s, { today: TODAY });
    expect(r.undated).toEqual({ count: 1, weight: 1 });
    expect(r.actual[0]).toEqual({ day: '2026-01-05', remaining: 2 });
    expect(r.remaining).toBe(2);
  });
  it('a completion before the planned start widens the range instead of clamping', () => {
    const s = mk();
    Object.assign(bar(s, 'a'), { done: true, doneAt: '2025-12-20' });
    const r = burndownSeries(s, { today: TODAY });
    expect(r.start).toBe('2025-12-20');
    expect(r.actual[0]).toEqual({ day: '2025-12-20', remaining: 2 });
  });
  it('same-day completions are one vertical drop', () => {
    const s = mk();
    Object.assign(bar(s, 'a'), { done: true, doneAt: '2026-01-19' });
    Object.assign(bar(s, 'b'), { done: true, doneAt: '2026-01-19' });
    const r = burndownSeries(s, { today: TODAY });
    expect(r.actual.filter(p => p.day === '2026-01-19')).toEqual([{ day: '2026-01-19', remaining: 1 }]);
  });
});

describe('burndownSeries — baseline (scope vs slip)', () => {
  it('ideal comes from the baseline, actual from the live plan; scope chip counts adds/removes', () => {
    const base = mk();
    const live = JSON.parse(JSON.stringify(base));
    live.lanes[0].bars.push({ id: 'd', type: 'work', startIdx: 1.5, span: 2, label: 'D (added)' });
    live.lanes[0].bars = live.lanes[0].bars.filter(b => b.id !== 'c');   // C removed
    live.lanes[0].bars.push({ id: 'e', type: 'work', startIdx: 2, span: 2, label: 'E (added)' });
    norm(live);
    const r = burndownSeries(live, { baseline: base, today: TODAY });
    expect(r.planTotal).toBe(3);
    expect(r.total).toBe(4);
    expect(r.scope).toMatchObject({ added: 2, removed: 1, delta: 1 });
    expect(r.ideal[0].remaining).toBe(3);
    expect(r.actual[0].remaining).toBe(4);          // the gap at day 0 is the scope change
  });
  it('scope growth is not reported as slip', () => {
    const base = mk();
    const live = JSON.parse(JSON.stringify(base));
    live.lanes[0].bars.push({ id: 'd', type: 'work', startIdx: 3, span: 2, label: 'D (added)' });
    for (const id of ['a']) Object.assign(live.lanes[0].bars.find(b => b.id === id), { done: true, doneAt: '2026-01-19' });
    const r = burndownSeries(live, { baseline: base, today: '2026-01-19' });
    expect(r.forecast.slipDays).toBe(0);
    expect(r.delta).toBe(0);
  });
});

describe('burndownForecast', () => {
  const ideal = [
    { day: '2026-01-05', remaining: 3 }, { day: '2026-01-19', remaining: 2 },
    { day: '2026-02-02', remaining: 1 }, { day: '2026-02-16', remaining: 0 },
  ];
  it('on plan = 0 slip, finish unchanged', () => {
    expect(burndownForecast(ideal, 1, '2026-02-02', '2026-02-16')).toMatchObject({ slipDays: 0, finish: '2026-02-16', behind: false, ahead: false });
    expect(burndownForecast(ideal, 1, '2026-02-10', '2026-02-16').slipDays).toBe(0);   // between steps, still on plan
  });
  it('behind: lateness of the earliest overdue task, finish shifts by it', () => {
    const f = burndownForecast(ideal, 2, '2026-02-09', '2026-02-16');
    expect(f.slipDays).toBe(7);                     // plan had <2 left from 02-02
    expect(f.finish).toBe('2026-02-23');
    expect(f.behind).toBe(true);
  });
  it('nothing done: slip is how long the first task has been overdue', () => {
    expect(burndownForecast(ideal, 3, '2026-01-26', '2026-02-16').slipDays).toBe(7);
  });
  it('ahead gives a negative slip and an earlier finish', () => {
    const f = burndownForecast(ideal, 1, '2026-01-19', '2026-02-16');   // plan wants 2 left, we have 1
    expect(f.slipDays).toBe(-14);
    expect(f.finish).toBe('2026-02-02');
    expect(f.ahead).toBe(true);
  });
  it('done and no-plan cases', () => {
    expect(burndownForecast(ideal, 0, '2026-02-02', '2026-02-16').done).toBe(true);
    expect(burndownForecast([], 1, '2026-02-02', null)).toBe(null);
  });
  it('series wires it up end to end', () => {
    const s = mk();
    Object.assign(bar(s, 'a'), { done: true, doneAt: '2026-01-19' });
    const r = burndownSeries(s, { today: '2026-02-09' });
    expect(r.remaining).toBe(2);
    expect(r.forecast.slipDays).toBe(7);
    expect(r.delta).toBe(1);
    expect(r.end).toBe('2026-02-26');   // plan finish Feb 19 + 7 days slip
  });
});

describe('burndownSequence — tasks in the order they will happen', () => {
  it('orders by planned end and gives each task its step on the staircase', () => {
    const r = burndownSequence(mk(), { today: '2026-02-10' });
    expect(r.items.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.items.map(x => [x.before, x.after])).toEqual([[3, 2], [2, 1], [1, 0]]);
    expect(r.items.map(x => x.rank)).toEqual([1, 2, 3]);
    expect(r.total).toBe(3);
  });
  it('same end day: dependency order, then position — not the code alone', () => {
    const s = mk();
    bar(s, 'b').startIdx = 0;                       // b now also ends 2026-01-19
    bar(s, 'a').dependsOn = ['b'];                   // a after b
    const r = burndownSequence(s, { today: '2026-02-10' });
    expect(r.items.map(x => x.id).slice(0, 2)).toEqual(['b', 'a']);
  });
  it('a later WP can come first', () => {
    const s = mk();
    s.lanes.push({ id: 'L2', code: 'WP 2 — Beta', bars: [{ id: 'z', type: 'work', startIdx: 0, span: 1, buffer: 0, label: 'Z' }] });
    norm(s);
    const r = burndownSequence(s, { today: '2026-02-10' });
    expect(r.items[0].id).toBe('z');                // ends first (1 week), though its code is 2.1
    expect(r.items[0].short).toBe('2.1');
  });
  it('status: done / doing / overdue / upcoming, plus late and the plan-today marker', () => {
    const s = mk();
    Object.assign(bar(s, 'a'), { done: true, doneAt: '2026-01-26' });          // a week after its plan → late
    bar(s, 'b').status = 'doing';
    const r = burndownSequence(s, { today: '2026-02-10' });
    const by = Object.fromEntries(r.items.map(x => [x.id, x]));
    expect(by.a).toMatchObject({ status: 'done', late: true });
    expect(by.b.status).toBe('doing');
    expect(by.c.status).toBe('upcoming');
    expect(r.planTodayIndex).toBe(2);               // a and b are due by 02-10
    expect(r.plannedRemainingNow).toBe(1);
    expect(r.remaining).toBe(2);
    expect(r.lateCount).toBe(1);
    expect(r.nextUp.id).toBe('b');
  });
  it('overdue = not done and past its planned end', () => {
    const r = burndownSequence(mk(), { today: '2026-02-10' });
    expect(r.items.map(x => x.status)).toEqual(['overdue', 'overdue', 'upcoming']);
    expect(r.overdueCount).toBe(2);
  });
  it('flags tasks done ahead of an earlier open task, and ones finished before an earlier one', () => {
    const s = mk();
    Object.assign(bar(s, 'c'), { done: true, doneAt: '2026-01-30' });          // c done while a and b are open
    let r = burndownSequence(s, { today: '2026-02-10' });
    expect(r.items.find(x => x.id === 'c').outOfOrder).toBe(true);
    expect(r.outOfOrderCount).toBe(1);
    Object.assign(bar(s, 'a'), { done: true, doneAt: '2026-02-05' });          // a done AFTER c
    r = burndownSequence(s, { today: '2026-02-10' });
    expect(r.items.find(x => x.id === 'c').outOfOrder).toBe(true);
    expect(r.items.find(x => x.id === 'a').outOfOrder).toBe(false);
  });
  it('done in order is not out of order', () => {
    const s = mk();
    Object.assign(bar(s, 'a'), { done: true, doneAt: '2026-01-19' });
    Object.assign(bar(s, 'b'), { done: true, doneAt: '2026-02-02' });
    expect(burndownSequence(s, { today: '2026-02-10' }).outOfOrderCount).toBe(0);
  });
  it('effort mode: step height = weight; milestones are zero-height steps', () => {
    const s = mk();
    s.lanes[0].bars.push({ id: 'm', type: 'milestone', startIdx: 0.25, span: 0, label: 'Gate' });
    const r = burndownSequence(s, { weight: 'effort', today: '2026-02-10' });
    const m = r.items.find(x => x.id === 'm');
    expect(m.weight).toBe(0);
    expect(m.before).toBe(m.after);
    expect(r.total).toBe(6);
  });
  it('baseline: order + planned dates from the baseline; added flagged, removed dropped', () => {
    const base = mk();
    const live = JSON.parse(JSON.stringify(base));
    live.lanes[0].bars = live.lanes[0].bars.filter(b => b.id !== 'c');
    live.lanes[0].bars.push({ id: 'd', type: 'work', startIdx: 0.25, span: 1, buffer: 0, label: 'D (added)' });
    norm(live);
    bar(live, 'a').startIdx = 5;                       // a slipped in the live plan…
    const r = burndownSequence(live, { baseline: base, today: '2026-02-10' });
    expect(r.items.find(x => x.id === 'a').plannedEnd).toBe('2026-01-19');   // …but the baseline date is the plan
    expect(r.items.find(x => x.id === 'd').added).toBe(true);
    expect(r.items.some(x => x.id === 'c')).toBe(false);
    expect(r.scope).toEqual({ added: 1, removed: 1 });
  });
  it('empty plan', () => {
    const r = burndownSequence({ start: '2026-01', end: '2026-12', lanes: [] }, { today: '2026-02-10' });
    expect(r.items).toEqual([]);
    expect(r.nextUp).toBe(null);
    expect(r.total).toBe(0);
  });
});
