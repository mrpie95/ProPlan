import { describe, it, expect } from 'vitest';
import { exportTimelineHtml, altTaskCodes } from '../src/proplan-core.mjs';

const mk = () => ({
  start: '2026-01', end: '2026-12',
  tracks: [{ id: 'product', kind: 'product', enabled: true, label: 'Prod <A>', launch: '2026-10-15', color: { accent: '#b45309' } }],
  lanes: [
    { id: 'L1', code: 'WP 1 — Alpha <x>', bars: [
      { id: 'a', type: 'work', startIdx: 0, span: 8, label: 'Task "A" & co', done: true, doneAt: '2026-02-01' },
      { id: 'b', type: 'work', startIdx: 2, span: 4, label: 'Task B', status: 'doing', dependsOn: ['a'] },
      { id: 'm', type: 'milestone', startIdx: 4, span: 0, label: 'Gate', dependsOn: ['b'] },
    ] },
    { id: 'L2', code: 'WP 2 — Beta', bars: [{ id: 'c', type: 'work', startIdx: 5, span: 2, label: 'Task C', dependsOn: ['m'] }] },
  ],
});

describe('exportTimelineHtml', () => {
  it('is script- and resource-free, escaped, inline-styled', () => {
    const h = exportTimelineHtml(mk(), { today: '2026-03-10', title: '<script>alert(1)</script>' });
    expect(h).not.toMatch(/<script|<style|https?:\/\/|@import|<link|<img|url\(/i);
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('Task &quot;A&quot; &amp; co');
    expect(h).toContain('WP1.2');
    expect(h).toContain('WP1 — Alpha');
    expect(h).toContain('after 1.1');
    expect(h).toContain('Prod &lt;A&gt; launch');
    expect(h).toContain('Today');
    expect(h.trim().startsWith('<div')).toBe(true);
  });
  it('page mode wraps a full document', () => {
    const h = exportTimelineHtml(mk(), { mode: 'page', title: 'T' });
    expect(h).toMatch(/^<!DOCTYPE html>/);
    expect(h).toContain('<title>T</title>');
    expect(h).toContain('</html>');
  });
  it('honours deps / milestones / filters / compact', () => {
    const s = mk();
    expect(exportTimelineHtml(s, { deps: false })).not.toContain('>after ');
    const noMs = exportTimelineHtml(s, { showMilestones: false });
    expect(noMs).not.toContain('Gate');
    const lane = exportTimelineHtml(s, { filterLane: 'L2' });
    expect(lane).toContain('Task C'); expect(lane).not.toContain('Task B');
    const shown = exportTimelineHtml(s, { shownBarIds: new Set(['a']) });
    expect(shown).toContain('Task &quot;A&quot;'); expect(shown).not.toContain('Task C');
    expect(exportTimelineHtml(s, { compact: true })).not.toContain('>after ');
  });
  it('positions bars by percentage and tolerates empty/odd state', () => {
    const h = exportTimelineHtml(mk());
    expect(h).toContain('left:0%;width:16.67%'); // 8 wk = 2 mo of 12
    expect(exportTimelineHtml({ start: '2026-01', end: '2026-03', lanes: [] })).toContain('No tasks to show');
    expect(() => exportTimelineHtml({})).not.toThrow();
    expect(altTaskCodes(mk()).b.code).toBe('WP1.2');
  });
});
