import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  barHoursDist,
  proposalBarCountsForHours,
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
