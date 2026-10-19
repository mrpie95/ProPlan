import { describe, it, expect } from 'vitest';
import {
  normaliseState, setBarDone, setLaneDone, setLaneNote, laneProgress, projectProgress,
  recentActivity, groupActivityByDay, completionSummary, completionSeries,
  localDay, isDay, ACTIVITY_LOG_CAP,
} from '../src/proplan-core.mjs';

const at = (iso) => new Date(iso);
const mk = () => ({
  start: '2026-01', end: '2026-12',
  lanes: [
    { id: 'L1', code: 'WP 1 — Alpha', bars: [
      { id: 'a', type: 'work', startIdx: 0, span: 4, label: 'Task A' },
      { id: 'b', type: 'work', startIdx: 1, span: 4, label: 'Task B' },
      { id: 'm', type: 'milestone', startIdx: 2, span: 0, label: 'Gate' },
    ] },
    { id: 'L2', code: 'WP 2 — Beta', bars: [{ id: 'c', type: 'work', startIdx: 0, span: 2, label: 'Task C' }] },
    { id: 'L3', code: 'WP 3 — Empty', bars: [{ id: 'm2', type: 'milestone', startIdx: 0, span: 0, label: 'Only ms' }] },
  ],
});

describe('localDay / isDay', () => {
  it('formats the local calendar day', () => {
    expect(localDay(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
  });
  it('validates days', () => {
    expect(isDay('2026-10-05')).toBe(true);
    expect(isDay('2026-13-45')).toBe(false);
    expect(isDay('2026-10')).toBe(false);
    expect(isDay(null)).toBe(false);
  });
});

describe('laneProgress', () => {
  it('counts milestones and derives status', () => {
    const s = mk();
    expect(laneProgress(s.lanes[0])).toMatchObject({ total: 3, done: 0, pct: 0, status: 'not-started' });
    s.lanes[0].bars[0].done = true;
    expect(laneProgress(s.lanes[0])).toMatchObject({ done: 1, pct: 33, status: 'in-progress' });
    s.lanes[0].bars[1].done = true;
    expect(laneProgress(s.lanes[0])).toMatchObject({ done: 2, pct: 67, status: 'in-progress' });
    s.lanes[0].bars[2].done = true;
    expect(laneProgress(s.lanes[0])).toMatchObject({ done: 3, pct: 100, status: 'complete' });
  });
  it('a lane with only milestones is not-started until ticked, then complete', () => {
    const s = mk();
    expect(laneProgress(s.lanes[2]).status).toBe('not-started');
    s.lanes[2].bars[0].done = true;
    expect(laneProgress(s.lanes[2]).status).toBe('complete');
  });
  it('complete WP is dated by its latest task', () => {
    const s = mk();
    setBarDone(s, 'a', true, { date: '2026-03-01' });
    setBarDone(s, 'b', true, { date: '2026-03-09' });
    setBarDone(s, 'm', true, { date: '2026-03-05' });
    const p = laneProgress(s.lanes[0]);
    expect(p.doneAt).toBe('2026-03-09');
    expect(p.lastActivity).toBe('2026-03-09');
  });
  it('exposes the note', () => {
    const s = mk(); setLaneNote(s, 'L1', '  blocked on vendor ');
    expect(laneProgress(s.lanes[0]).note).toBe('blocked on vendor');
  });
});

describe('setBarDone', () => {
  it('stamps doneAt with the local day and logs it', () => {
    const s = mk();
    const r = setBarDone(s, 'a', true, { now: new Date(2026, 4, 6, 10) });
    expect(r).toEqual({ changed: true, wpComplete: false });
    expect(s.lanes[0].bars[0]).toMatchObject({ done: true, doneAt: '2026-05-06' });
    expect(s.log).toHaveLength(1);
    expect(s.log[0]).toMatchObject({ day: '2026-05-06', action: 'done', laneId: 'L1', barId: 'a', label: 'Task A', lane: 'WP 1 — Alpha' });
  });
  it('honours a backdate', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 6), date: '2026-05-01' });
    expect(s.lanes[0].bars[0].doneAt).toBe('2026-05-01');
  });
  it('ignores an invalid backdate', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 6), date: 'nope' });
    expect(s.lanes[0].bars[0].doneAt).toBe('2026-05-06');
  });
  it('is a no-op when already in the requested state', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 6) });
    const r = setBarDone(s, 'a', true, { now: new Date(2026, 4, 9) });
    expect(r.changed).toBe(false);
    expect(s.lanes[0].bars[0].doneAt).toBe('2026-05-06');
    expect(s.log).toHaveLength(1);
  });
  it('re-dates an already-done bar without adding a log entry', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 6) });
    const r = setBarDone(s, 'a', true, { date: '2026-04-30' });
    expect(r).toMatchObject({ changed: true, redated: true });
    expect(s.lanes[0].bars[0].doneAt).toBe('2026-04-30');
    expect(s.log).toHaveLength(1);
    expect(s.log[0].day).toBe('2026-04-30');
  });
  it('unticking clears doneAt and logs a reopen', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 6) });
    setBarDone(s, 'a', false, { now: new Date(2026, 4, 7) });
    expect(s.lanes[0].bars[0].done).toBe(false);
    expect('doneAt' in s.lanes[0].bars[0]).toBe(false);
    expect(s.log.map(e => e.action)).toEqual(['done', 'reopen']);
  });
  it('logs wp-done when the last task is ticked, wp-reopen when one is unticked', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 6) });
    setBarDone(s, 'm', true, { now: new Date(2026, 4, 6) });
    const r = setBarDone(s, 'b', true, { now: new Date(2026, 4, 7) });
    expect(r.wpComplete).toBe(true);
    expect(s.log.map(e => e.action)).toEqual(['done', 'done', 'done', 'wp-done']);
    expect(s.log[3]).toMatchObject({ laneId: 'L1', barId: null, lane: 'WP 1 — Alpha' });
    setBarDone(s, 'a', false, { now: new Date(2026, 4, 8) });
    expect(s.log.map(e => e.action).slice(-2)).toEqual(['reopen', 'wp-reopen']);
  });
  it('returns null for an unknown bar', () => {
    expect(setBarDone(mk(), 'zzz', true)).toBeNull();
  });
  it('caps the log at ACTIVITY_LOG_CAP, dropping the oldest', () => {
    const s = mk();
    for (let i = 0; i < ACTIVITY_LOG_CAP + 25; i++) {
      setBarDone(s, 'c', i % 2 === 0, { now: new Date(2026, 0, 1, 0, 0, i) });
    }
    expect(s.log.length).toBeLessThanOrEqual(ACTIVITY_LOG_CAP);
    expect(s.log[s.log.length - 1].at).toBe(new Date(2026, 0, 1, 0, 0, ACTIVITY_LOG_CAP + 24).toISOString());
  });
});

describe('setLaneDone', () => {
  it('ticks every task and milestone, logging each plus one wp-done', () => {
    const s = mk();
    const r = setLaneDone(s, 'L1', true, { now: new Date(2026, 4, 6) });
    expect(r).toEqual({ changed: 3, wpComplete: true });
    expect(s.lanes[0].bars.map(b => !!b.done)).toEqual([true, true, true]);
    expect(s.log.map(e => e.action)).toEqual(['done', 'done', 'done', 'wp-done']);
  });
  it('keeps the original date of tasks that were already done', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 3, 1) });
    setLaneDone(s, 'L1', true, { now: new Date(2026, 4, 6) });
    expect(s.lanes[0].bars[0].doneAt).toBe('2026-04-01');
    expect(s.lanes[0].bars[1].doneAt).toBe('2026-05-06');
  });
  it('can reopen a whole WP', () => {
    const s = mk();
    setLaneDone(s, 'L1', true, { now: new Date(2026, 4, 6) });
    const r = setLaneDone(s, 'L1', false, { now: new Date(2026, 4, 7) });
    expect(r).toEqual({ changed: 3, wpComplete: false });
    expect(s.log.map(e => e.action).slice(-4)).toEqual(['reopen', 'reopen', 'reopen', 'wp-reopen']);
  });
  it('is a no-op (and logs nothing) when nothing changes', () => {
    const s = mk();
    expect(setLaneDone(s, 'L1', false)).toEqual({ changed: 0, wpComplete: false });
    expect(s.log).toBeUndefined();
  });
  it('returns null for an unknown WP', () => {
    expect(setLaneDone(mk(), 'nope', true)).toBeNull();
  });
});

describe('setLaneNote', () => {
  it('sets, trims and clears', () => {
    const s = mk();
    expect(setLaneNote(s, 'L2', ' hi ')).toBe(true);
    expect(s.lanes[1].note).toBe('hi');
    setLaneNote(s, 'L2', '   ');
    expect('note' in s.lanes[1]).toBe(false);
    expect(setLaneNote(s, 'nope', 'x')).toBe(false);
  });
});

describe('projectProgress', () => {
  it('counts tasks and non-empty WPs', () => {
    const s = mk();
    setLaneDone(s, 'L2', true);
    expect(projectProgress(s)).toEqual({ tasks: 5, done: 1, doing: 0, pct: 20, wps: 3, wpsComplete: 1 });
  });
});

describe('recentActivity', () => {
  const now = new Date(2026, 4, 20, 12);
  it('returns newest first within the window', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 1, 9) });
    setBarDone(s, 'm', true, { now: new Date(2026, 4, 2, 9) });
    setBarDone(s, 'b', true, { now: new Date(2026, 4, 15, 9) });
    setBarDone(s, 'c', true, { now: new Date(2026, 4, 18, 9) });
    const ev = recentActivity(s, { now, days: 7 });
    expect(ev.map(e => `${e.action}:${e.barId}`)).toEqual(['wp-done:null', 'done:c', 'wp-done:null', 'done:b']);
    expect(ev.map(e => e.laneId)).toEqual(['L2', 'L2', 'L1', 'L1']);
    expect(recentActivity(s, { now, days: 0 }).length).toBe(s.log.length);
  });
  it('orders same-day events by time', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 18, 9) });
    setBarDone(s, 'c', true, { now: new Date(2026, 4, 18, 15) });
    expect(recentActivity(s, { now }).filter(e => e.action === 'done').map(e => e.barId)).toEqual(['c', 'a']);
  });
  it('synthesises events for dated done tasks missing from the log', () => {
    const s = mk();
    s.lanes[1].bars[0].done = true; s.lanes[1].bars[0].doneAt = '2026-05-19';
    const ev = recentActivity(s, { now });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ day: '2026-05-19', action: 'done', barId: 'c', label: 'Task C' });
  });
  it('does not double up bars that are in the log, and skips undated ones', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 18) });
    s.lanes[1].bars[0].done = true;   // legacy tick, no date
    expect(recentActivity(s, { now })).toHaveLength(1);
  });
  it('respects limit', () => {
    const s = mk();
    setLaneDone(s, 'L1', true, { now: new Date(2026, 4, 18) });
    expect(recentActivity(s, { now, limit: 2 })).toHaveLength(2);
  });
  it('survives a deleted bar thanks to the label snapshot', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 18) });
    s.lanes[0].bars.splice(0, 1);
    expect(recentActivity(s, { now })[0].label).toBe('Task A');
  });
});

describe('groupActivityByDay', () => {
  it('groups consecutive same-day events', () => {
    const g = groupActivityByDay([{ day: '2026-05-18' }, { day: '2026-05-18' }, { day: '2026-05-10' }]);
    expect(g.map(x => [x.day, x.events.length])).toEqual([['2026-05-18', 2], ['2026-05-10', 1]]);
  });
});

describe('completionSummary / completionSeries', () => {
  const now = new Date(2026, 4, 20, 12);
  it('summarises the last 7 days from current done flags', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 1) });
    setBarDone(s, 'm', true, { now: new Date(2026, 4, 2) });
    setBarDone(s, 'b', true, { now: new Date(2026, 4, 19) });
    setBarDone(s, 'c', true, { now: new Date(2026, 4, 14) });
    s.lanes[1].bars.push({ id: 'd', type: 'work', startIdx: 0, span: 1, label: 'D', done: true });   // undated
    expect(completionSummary(s, { now })).toEqual({ days: 7, tasks: 2, wps: 2, undated: 1 });
    expect(completionSummary(s, { now, days: 30 }).tasks).toBe(4);
  });
  it('an unticked task drops out of the summary', () => {
    const s = mk();
    setBarDone(s, 'a', true, { now: new Date(2026, 4, 19) });
    setBarDone(s, 'a', false, { now: new Date(2026, 4, 19) });
    expect(completionSummary(s, { now }).tasks).toBe(0);
  });
  it('builds a cumulative series in day order', () => {
    const s = mk();
    setBarDone(s, 'b', true, { date: '2026-05-09' });
    setBarDone(s, 'a', true, { date: '2026-05-02' });
    setBarDone(s, 'c', true, { date: '2026-05-09' });
    expect(completionSeries(s)).toEqual([
      { day: '2026-05-02', count: 1, cumulative: 1 },
      { day: '2026-05-09', count: 2, cumulative: 3 },
    ]);
  });
});

describe('normaliseState (completion fields)', () => {
  it('loads old data without the new fields', () => {
    const s = mk();
    normaliseState(s);
    expect(s.log).toEqual([]);
    expect(s.lanes[0].bars[0].doneAt).toBeUndefined();
  });
  it('keeps a legacy done flag with no date', () => {
    const s = mk(); s.lanes[0].bars[0].done = true;
    normaliseState(s);
    expect(s.lanes[0].bars[0].done).toBe(true);
    expect('doneAt' in s.lanes[0].bars[0]).toBe(false);
  });
  it('drops doneAt when not done or malformed, coerces done to boolean', () => {
    const s = mk();
    s.lanes[0].bars[0].doneAt = '2026-05-01';                       // not done
    s.lanes[0].bars[1].done = 1; s.lanes[0].bars[1].doneAt = 'junk';
    normaliseState(s);
    expect('doneAt' in s.lanes[0].bars[0]).toBe(false);
    expect(s.lanes[0].bars[1].done).toBe(true);
    expect('doneAt' in s.lanes[0].bars[1]).toBe(false);
  });
  it('keeps a valid doneAt and a valid note, drops a junk note', () => {
    const s = mk();
    s.lanes[0].bars[0].done = true; s.lanes[0].bars[0].doneAt = '2026-05-01';
    s.lanes[0].note = 'ok'; s.lanes[1].note = 42; s.lanes[2].note = '  ';
    normaliseState(s);
    expect(s.lanes[0].bars[0].doneAt).toBe('2026-05-01');
    expect(s.lanes[0].note).toBe('ok');
    expect('note' in s.lanes[1]).toBe(false);
    expect('note' in s.lanes[2]).toBe(false);
  });
  it('scrubs malformed log entries and caps length', () => {
    const s = mk();
    const good = { at: 'x', day: '2026-05-01', action: 'done', laneId: 'L1', barId: 'a', label: 'A', lane: 'WP 1' };
    s.log = [good, null, { ...good, day: 'bad' }, { ...good, action: 'zap' }, { ...good, laneId: 5 }, { day: '2026-05-02', action: 'wp-done', laneId: 'L1' }];
    normaliseState(s);
    expect(s.log).toHaveLength(2);
    expect(s.log[1]).toEqual({ at: '', day: '2026-05-02', action: 'wp-done', laneId: 'L1', barId: null, label: '', lane: '' });
    const big = mk();
    big.log = Array.from({ length: ACTIVITY_LOG_CAP + 10 }, (_, i) => ({ ...good, label: String(i) }));
    normaliseState(big);
    expect(big.log).toHaveLength(ACTIVITY_LOG_CAP);
    expect(big.log[big.log.length - 1].label).toBe(String(ACTIVITY_LOG_CAP + 9));
  });
  it('a non-array log becomes []', () => {
    const s = mk(); s.log = 'oops';
    normaliseState(s);
    expect(s.log).toEqual([]);
  });
});
