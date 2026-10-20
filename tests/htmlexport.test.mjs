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
    expect(h).toContain('>1.1</span>');              // dependency pill on Task B (just the code — no arrow glyph)
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
    expect(exportTimelineHtml(s, { deps: false })).not.toContain('<span title="depends on');
    const noMs = exportTimelineHtml(s, { showMilestones: false });
    expect(noMs).not.toContain('Gate');
    const lane = exportTimelineHtml(s, { filterLane: 'L2' });
    expect(lane).toContain('Task C'); expect(lane).not.toContain('Task B');
    const shown = exportTimelineHtml(s, { shownBarIds: new Set(['a']) });
    expect(shown).toContain('Task &quot;A&quot;'); expect(shown).not.toContain('Task C');
    expect(exportTimelineHtml(s, { compact: true })).not.toContain('<span title="depends on');
  });
  it('positions bars in fixed pixels and tolerates empty/odd state', () => {
    const h = exportTimelineHtml(mk());
    expect(h).toContain('left:0px;width:120.33px'); // 8 wk = 2 mo of 12 on a 722px track
    expect(exportTimelineHtml({ start: '2026-01', end: '2026-03', lanes: [] })).toContain('No tasks to show');
    expect(() => exportTimelineHtml({})).not.toThrow();
    expect(altTaskCodes(mk()).b.code).toBe('WP1.2');
  });
});

describe('exportTimelineHtml matches the Timeline tab', () => {
  it('WP strip: "WPn" over the name, rail colour, ID + status icon per row', () => {
    const h = exportTimelineHtml(mk(), { today: '2026-03-10' });
    expect(h).toContain('>WP1</div>');
    expect(h).toContain('Alpha &lt;x&gt;');
    expect(h).toContain('border-left:4px solid #ef4444');          // WP 1 rail
    expect(h).toContain('Work package &middot; ID');
    expect(h).toContain('>1.1</span>');
  });
  it('one colour until started: pending blue, in progress amber, done green', () => {
    const h = exportTimelineHtml(mk());
    expect(h).toContain('background:#afeac5;border:2px solid #15803d');   // done (a)
    expect(h).toContain('background:#fbd699;border:2px solid #b45309');   // in progress (b)
    expect(h).toContain('background:#b6daff;border:1px solid #0a84ff');   // pending (c)
  });
  it('names sit inside a block only when the whole name fits, otherwise beside it', () => {
    const s = mk();
    s.lanes[0].bars[1].label = 'A rather long task name that cannot fit inside a four-week block';
    const h = exportTimelineHtml(s);
    expect(h).toMatch(/left:\d+(\.\d+)?px;white-space:nowrap;font-size:11.5px/);   // outside label to the right
    expect(h).toContain('A rather long task name');
    expect(h).not.toContain('text-overflow:ellipsis;">A rather');   // never ellipsised
  });
  it('dependency pills: one per predecessor, green once the predecessor is done', () => {
    const h = exportTimelineHtml(mk());
    const pills = [...h.matchAll(/<span class="pp-pill" title="depends on ([^"]*)" style="([^"]*)">([^<]*)<\/span>/g)].map(m => ({ tip: m[1], style: m[2], txt: m[3] }));
    const a = pills.find(p => p.txt === '1.1'), b = pills.find(p => p.txt === '1.2');
    expect(a.style).toContain('background:#15803d');          // Task A is done → green
    expect(b.style).not.toContain('background:#15803d');     // Task B is only in progress
    expect(a.tip).toContain('1.1');
    expect(h).not.toContain('←');                              // just the code — no arrow glyph
  });
  it('today is a bold hot-pink line + dated pill + week highlight; launches are coloured pills', () => {
    const h = exportTimelineHtml(mk(), { today: '2026-03-10' });
    expect(h).toContain('border-left:2.5px solid #db2777');           // bold hot-pink line
    expect(h).toContain('Today &middot;'.replace('&middot;', '\u00B7'));   // pill carries the date
    expect(h).toContain('Prod &lt;A&gt; launch</span>');
  });
});

describe('exportTimelineHtml keeps its shape', () => {
  it('is a fixed-pixel table: no percentage widths/offsets, no calc(), the same width in any container', () => {
    const h = exportTimelineHtml(mk());
    expect(h).not.toMatch(/(?<!max-)(?:left|right|width):[\d.]+%/);
    expect(h).not.toContain('calc(');
    expect(h).not.toContain('min-width:900px');
    expect(h).toMatch(/width:900px;position:relative/);        // 112 + 66 label columns + the 722px track
    expect(h).not.toContain('max-width:1400px');
  });
  it('a long project widens the table instead of squeezing the months', () => {
    const s = mk(); s.end = '2028-12';
    const h = exportTimelineHtml(s);
    const w = Number(h.match(/width:(\d+)px;position:relative;background:#ffffff/)[1]);
    expect(w).toBe(178 + 36 * 52);
  });
  it('legend has no dependency entries (the pills in the chart stay)', () => {
    const h = exportTimelineHtml(mk());
    expect(h).toContain('Not started');
    expect(h).not.toContain('dependency already done');
    expect(h).not.toMatch(/>\s*dependency\s*</);
    expect(h).toContain('class="pp-pill"');
  });
  it('hover highlight is optional, CSS only, and absent by default', () => {
    expect(exportTimelineHtml(mk())).not.toContain('<style');
    const h = exportTimelineHtml(mk(), { hover: true });
    expect(h).toContain('<style>');
    expect(h).toContain('.pp-tl .pp-b:hover');
    expect(h).not.toContain('<script');
    expect(h).toContain('class="pp-row"');
  });
});

describe('exportTimelineHtml milestones at the bottom', () => {
  const withMs = () => {
    const s = mk();
    s.lanes[0].bars.push({ id: 'm1', type: 'milestone', startIdx: 5, span: 0, label: 'Gate <one>', dependsOn: [] });
    return s;
  };
  it('pulls milestones into one "Milestones" block at the end, tagged with their WP', () => {
    const h = exportTimelineHtml(withMs(), { milestonesAtBottom: true });
    expect(h).toContain('>Milestones</div>');
    expect(h).toContain('2 across all WPs');   // Gate + the existing one
    expect(h).toContain('WP1 &middot; Gate &lt;one&gt;'.replace('&middot;', '\u00B7'));
    expect(h.indexOf('Gate &lt;one&gt;')).toBeGreaterThan(h.indexOf('Beta'));   // after the last task row
  });
  it('is off by default (milestones stay with their tasks) and a WP of only milestones disappears when on', () => {
    expect(exportTimelineHtml(withMs())).not.toContain('across all WPs');
    const s = mk(); s.lanes.push({ id: 'L9', code: 'WP 9 — Only gates', desc: '', bars: [{ id: 'g', type: 'milestone', startIdx: 1, span: 0, label: 'G', dependsOn: [] }] });
    const h = exportTimelineHtml(s, { milestonesAtBottom: true });
    expect(h).not.toContain('Only gates');
    expect(h).toContain('WP3 \u00B7 G');
  });
});

describe('exportTimelineHtml dependency routes', () => {
  it('draws one orthogonal path per visible link in an inline SVG, off by default', () => {
    expect(exportTimelineHtml(mk())).not.toContain('<svg');
    const h = exportTimelineHtml(mk(), { routes: true, deps: false });
    expect(h).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    const paths = h.match(/<path d="M[^"]*"/g) || [];
    expect(paths.length).toBe(3);                          // a→b, b→m, m→c
    for (const p of paths) expect(p).toMatch(/^<path d="M[\d. ]+H[\d. ]+V[\d. ]+H/);   // horizontal / vertical segments only
    expect(h).not.toContain('class="pp-pill"');            // routes work without the pills
    expect(h).not.toContain('<script');
  });
  it('a link whose predecessor is done is green; routes need no <style>', () => {
    const h = exportTimelineHtml(mk(), { routes: true });
    expect(h).toContain('stroke="#15803d"');               // a is done
    expect(h).not.toContain('<style');
  });
});

describe('exportTimelineHtml status circles stay circles', () => {
  it('every status icon is a fixed 15x15 flex:none box (a flex row can never squash it into an ellipse)', () => {
    const h = exportTimelineHtml(mk());
    const icons = h.match(/<span style="display:inline-block;flex:none;box-sizing:border-box;width:15px;min-width:15px;height:15px;min-height:15px;border-radius:50%;/g) || [];
    expect(icons.length).toBe(4);   // one per task row (a, b, milestone, c)
  });
  it('the ID column is wide enough for its content (code + icon, plus a WP tag when milestones are at the bottom)', () => {
    expect(exportTimelineHtml(mk())).toContain('flex:0 0 66px;width:66px');
    expect(exportTimelineHtml(mk(), { milestonesAtBottom: true })).toContain('flex:0 0 96px;width:96px');
  });
});

describe('exportTimelineHtml packed milestones (beta)', () => {
  const many = () => {
    const s = mk();
    for (let i = 0; i < 6; i++) s.lanes[i % 2].bars.push({ id: 'q' + i, type: 'milestone', startIdx: 1 + i * 1.5, span: 0, label: 'Ms ' + i, dependsOn: [] });
    return s;
  };
  const rowCount = (h) => (h.match(/class="pp-row"/g) || []).length;
  it('packs milestones onto shared rows with the WP number in the diamond; numbers-only drops the beside-names', () => {
    const plain = exportTimelineHtml(many(), { milestonesAtBottom: true });
    const packed = exportTimelineHtml(many(), { milestonesPacked: true });
    const nums = exportTimelineHtml(many(), { milestonesPacked: true, msNames: false });
    expect(rowCount(packed)).toBeLessThan(rowCount(plain));
    expect(rowCount(nums)).toBeLessThanOrEqual(rowCount(packed));
    expect(packed).toContain('7 across all WPs');
    expect(packed).toContain('>Ms 0</span>');            // the name no longer repeats the WP (it is in the rhombus)
    expect(packed).toMatch(/>M\d+\.\d+<\/span><\/div>/);   // the milestone code sits in the tag
    expect(nums).not.toContain('>Ms 0</span>');
    expect(nums).toContain('title="WP');   // tooltip still names it via the code/label
    expect(packed).toMatch(/<polygon points="1\.6,10 8,1\.3 /);   // a hexagon tag whose left tip is the date
    expect(packed).toContain('<circle cx="0.8"');             // pin dot on the date
  });
  it('routes still find packed milestones, and the ID column stays 66px', () => {
    const h = exportTimelineHtml(many(), { milestonesPacked: true, routes: true });
    expect(h).toContain('<svg');
    expect(h).toContain('flex:0 0 66px;width:66px');
    expect(h).not.toContain('calc(');
  });
});

describe('exportTimelineHtml range', () => {
  const months = (h) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].filter(m => h.includes(`>${m}</span>`));
  it('"planned" trims the empty months before the first and after the last task', () => {
    const s = mk(); s.lanes.forEach(l => l.bars.forEach(b => { b.startIdx += 3; }));    // nothing planned in Jan–Mar
    const h = exportTimelineHtml(s, { range: 'planned' });
    expect(months(h)).not.toContain('Jan');
    expect(months(h)).not.toContain('Dec');
    expect(months(h)[0]).toBe('Apr');
    expect(h).toContain('Start: 2026-04');
    expect(exportTimelineHtml(s)).toContain('>Jan</span>');          // default = whole project
  });
  it('"custom" keeps only blocks in the range, cuts the ones that straddle its start, and keeps the original task codes', () => {
    const h = exportTimelineHtml(mk(), { range: 'custom', rangeStart: '2026-03', rangeEnd: '2026-08' });
    expect(months(h)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']);
    expect(h).not.toContain('Task &quot;A&quot; &amp; co');         // ends before March
    expect(h).toContain('>1.2</span>');                              // Task B keeps its code (not renumbered)
    expect(h).toContain('left:0px');                                 // B starts in Mar? or is cut at the left edge
  });
  it('a range with nothing in it, or an inverted one, still renders', () => {
    expect(() => exportTimelineHtml(mk(), { range: 'custom', rangeStart: '2026-09', rangeEnd: '2026-02' })).not.toThrow();
    expect(exportTimelineHtml(mk(), { range: 'planned', showMilestones: false, filterLane: 'nope' })).toContain('No tasks to show');
  });
});
