import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  barHoursDist,
  proposalBarCountsForHours,
  barAllocPct,
  effortWeeks,
  effSpan,
  PROPOSAL_HOURS_PER_WEEK,
  WEEKS_PER_MONTH,
} from '../src/proplan-core.mjs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('proposalBarCountsForHours', () => {
  it('excludes milestones', () => {
    expect(proposalBarCountsForHours({ type: 'milestone' })).toBe(false);
  });

  it('includes work, review, buffer', () => {
    for (const t of ['work', 'review', 'buffer']) {
      expect(proposalBarCountsForHours({ type: t })).toBe(true);
    }
  });

  it('includes leadtime when includeLeadtime=true (default)', () => {
    expect(proposalBarCountsForHours({ type: 'leadtime' })).toBe(true);
  });

  it('excludes leadtime when includeLeadtime=false', () => {
    expect(proposalBarCountsForHours({ type: 'leadtime' }, { includeLeadtime: false })).toBe(false);
  });
});

describe('barHoursDist', () => {
  const fixture = load('hoursCases.json');
  const bars = Object.fromEntries(fixture.lanes[0].bars.map(b => [b.id, b]));

  it('a bar that fits in one calendar month puts all its hours in that month', () => {
    // startIdx 2.0, span 4 weeks → starts month 2, ends month 3.
    const dist = barHoursDist(bars.intra, { numMonths: 12 });
    // 4 weeks × 40 h/wk = 160 hours, all in month idx 2.
    expect(dist[2]).toBe(160);
    // Every other slot should be zero.
    expect(dist.reduce((a, b) => a + b)).toBe(160);
  });

  it('a bar that straddles two months splits hours proportionally', () => {
    // startIdx 2.5, span 4 weeks → starts mid-month 2, ends mid-month 3.
    const dist = barHoursDist(bars.splitMonths, { numMonths: 12 });
    // Each half = 2 weeks × 40 h = 80 hours.
    expect(dist[2]).toBeCloseTo(80, 6);
    expect(dist[3]).toBeCloseTo(80, 6);
    expect(dist[0]).toBe(0);
    expect(dist[4]).toBe(0);
  });

  it('a bar that crosses the year boundary distributes across months 11 and 12', () => {
    // startIdx 11.5, span 4 weeks → half Dec, half Jan-of-next-year.
    const dist = barHoursDist(bars.yearCross, { numMonths: 14 });
    expect(dist[11]).toBeCloseTo(80, 6);
    expect(dist[12]).toBeCloseTo(80, 6);
  });

  it('milestones contribute zero hours', () => {
    const dist = barHoursDist(bars.msMarker, { numMonths: 12 });
    expect(dist.reduce((a, b) => a + b)).toBe(0);
  });

  it('buffer scales the total hours linearly', () => {
    // span 4 weeks + 25% buffer → effSpan = 5 weeks → 200 hours.
    const dist = barHoursDist(bars.withBuffer, { numMonths: 12 });
    const total = dist.reduce((a, b) => a + b);
    expect(total).toBeCloseTo(200, 6);
  });

  it('leadtime: contributes when includeLeadtime=true', () => {
    const dist = barHoursDist(bars.leadtime, { numMonths: 12, includeLeadtime: true });
    expect(dist.reduce((a, b) => a + b)).toBeCloseTo(160, 6);
  });

  it('leadtime: contributes zero when includeLeadtime=false', () => {
    const dist = barHoursDist(bars.leadtime, { numMonths: 12, includeLeadtime: false });
    expect(dist.reduce((a, b) => a + b)).toBe(0);
  });

  it('startMonthOffset shifts the bar into the rollup column space', () => {
    // intra bar at startIdx 2 with an offset of 5 → should land at month 7 in the rollup.
    const dist = barHoursDist(bars.intra, { numMonths: 12, startMonthOffset: 5 });
    expect(dist[7]).toBe(160);
    expect(dist[2]).toBe(0);
  });

  it('respects hoursPerWeek override', () => {
    const dist = barHoursDist(bars.intra, { numMonths: 12, hoursPerWeek: 20 });
    expect(dist[2]).toBe(80); // 4 weeks × 20
  });
});

describe('PROPOSAL_HOURS_PER_WEEK', () => {
  it('is 40', () => {
    expect(PROPOSAL_HOURS_PER_WEEK).toBe(40);
  });
});

describe('barAllocPct', () => {
  it('defaults to 100 when alloc is missing / not a number', () => {
    expect(barAllocPct({})).toBe(100);
    expect(barAllocPct({ alloc: null })).toBe(100);
    expect(barAllocPct({ alloc: 'foo' })).toBe(100);
  });
  it('returns the stored alloc when valid', () => {
    expect(barAllocPct({ alloc: 33 })).toBe(33);
    expect(barAllocPct({ alloc: 0 })).toBe(0);
  });
  it('clamps negative / >100 values', () => {
    expect(barAllocPct({ alloc: -5 })).toBe(100);
    expect(barAllocPct({ alloc: 150 })).toBe(100);
  });
});

describe('effortWeeks', () => {
  it('equals effSpan when alloc=100 (default)', () => {
    const b = { type: 'work', span: 4, buffer: 0 };
    expect(effortWeeks(b)).toBe(effSpan(b));
  });
  it('scales calendar weeks by alloc / 100', () => {
    // 4 calendar weeks at 33% = 1.32 effort weeks
    expect(effortWeeks({ type: 'work', span: 4, buffer: 0, alloc: 33 })).toBeCloseTo(1.32, 6);
    // 4 weeks × 1.25 buffer × 50% alloc = 2.5 effort weeks
    expect(effortWeeks({ type: 'work', span: 4, buffer: 25, alloc: 50 })).toBe(2.5);
  });
  it('is 0 for milestones', () => {
    expect(effortWeeks({ type: 'milestone' })).toBe(0);
  });
});

describe('barHoursDist with alloc', () => {
  it("a 4-week task at 33% allocation distributes 33% of the hours", () => {
    // Calendar: month 0..1 fully covered.
    // Hours WITHOUT alloc = 4 × 40 = 160. WITH alloc 33 → 160 × 0.33 = 52.8.
    const b = { type: 'work', startIdx: 0, span: 4, buffer: 0, alloc: 33 };
    const dist = barHoursDist(b, { numMonths: 3 });
    expect(dist.reduce((a, b) => a + b)).toBeCloseTo(52.8, 6);
  });
  it("the per-month split still follows the calendar, just scaled", () => {
    // 4-week task starting at startIdx 0.5 → half in month 0, half in month 1.
    // With alloc=50%, totals: month 0 = 40h, month 1 = 40h (each half is 80 × 0.5).
    const b = { type: 'work', startIdx: 0.5, span: 4, buffer: 0, alloc: 50 };
    const dist = barHoursDist(b, { numMonths: 3 });
    expect(dist[0]).toBeCloseTo(40, 6);
    expect(dist[1]).toBeCloseTo(40, 6);
  });
  it("alloc and buffer compose (both scale the per-month hours)", () => {
    // 4 weeks × 1.5 buffer = 6 calendar weeks; × 50% alloc = 120 total hours.
    const b = { type: 'work', startIdx: 0, span: 4, buffer: 50, alloc: 50 };
    const dist = barHoursDist(b, { numMonths: 4 });
    expect(dist.reduce((a, b) => a + b)).toBeCloseTo(120, 6);
  });
});
