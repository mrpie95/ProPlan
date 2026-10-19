import { describe, it, expect } from 'vitest';
import { normaliseState, setBarStatus, setBarDone, barStatus, laneProgress, projectProgress, altDuplicateBars } from '../src/proplan-core.mjs';

function mk() {
  const s = { start: '2026-01', end: '2026-12', colWidth: 80, lanes: [
    { id: 'L', code: 'WP 1', desc: '', bars: [
      { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, label: 'A', dependsOn: [] },
      { id: 'b', type: 'work', startIdx: 4, span: 4, buffer: 0, label: 'B', dependsOn: [] },
      { id: 'm', type: 'milestone', startIdx: 8, span: 0, label: 'M', dependsOn: [] },
    ] } ] };
  normaliseState(s); return s;
}
const bar = (s, id) => s.lanes[0].bars.find(b => b.id === id);

describe('task status (pending / doing / done)', () => {
  it('defaults to pending; doing is stored, done uses the completion fields', () => {
    const s = mk();
    expect(barStatus(bar(s, 'a'))).toBe('pending');
    expect(setBarStatus(s, 'a', 'doing')).toMatchObject({ changed: true, status: 'doing' });
    expect(bar(s, 'a').status).toBe('doing');
    expect(laneProgress(s.lanes[0])).toMatchObject({ doing: 1, done: 0, status: 'in-progress' });
    setBarStatus(s, 'a', 'done', { date: '2026-02-03' });
    expect(bar(s, 'a')).toMatchObject({ done: true, doneAt: '2026-02-03' });
    expect(bar(s, 'a').status).toBeUndefined();
    expect(barStatus(bar(s, 'a'))).toBe('done');
  });
  it('moving off done reopens the task (and logs it)', () => {
    const s = mk();
    setBarDone(s, 'a', true);
    setBarStatus(s, 'a', 'doing');
    expect(bar(s, 'a').done).toBeFalsy();
    expect(bar(s, 'a').status).toBe('doing');
    expect(s.log.map(e => e.action)).toEqual(['done', 'reopen']);
    setBarStatus(s, 'a', 'pending');
    expect(bar(s, 'a').status).toBeUndefined();
  });
  it('milestones only support pending/done; junk statuses are scrubbed; duplicates start pending', () => {
    const s = mk();
    expect(setBarStatus(s, 'm', 'doing')).toMatchObject({ changed: false, status: 'pending' });
    expect(barStatus(bar(s, 'm'))).toBe('pending');
    expect(setBarStatus(s, 'zzz', 'doing')).toBeNull();
    expect(setBarStatus(s, 'a', 'bogus')).toBeNull();
    bar(s, 'a').status = 'weird'; bar(s, 'b').status = 'doing'; bar(s, 'b').done = true; bar(s, 'm').status = 'doing';
    normaliseState(s);
    expect(bar(s, 'a').status).toBeUndefined();
    expect(bar(s, 'b').status).toBeUndefined();
    expect(bar(s, 'm').status).toBeUndefined();
    setBarStatus(s, 'a', 'doing');
    const [copy] = altDuplicateBars(s, ['a']);
    expect(bar(s, copy).status).toBeUndefined();
    expect(projectProgress(s).doing).toBe(1);
  });
});
