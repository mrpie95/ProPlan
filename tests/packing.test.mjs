import { describe, it, expect } from 'vitest';
import { packLaneRows } from '../src/proplan-core.mjs';

const mkBar = (id, startIdx, span, label = '', type = 'work', buffer = 0) =>
  ({ id, type, startIdx, span, buffer, label });

describe('packLaneRows', () => {
  it('packs non-overlapping bars into a single row', () => {
    const bars = [
      mkBar('a', 0,  4),  // 1 month
      mkBar('b', 2,  4),  // 1 month
      mkBar('c', 4,  4),
    ];
    const { rowByBarId, totalRows } = packLaneRows(bars);
    expect(totalRows).toBe(1);
    expect(rowByBarId).toEqual({ a: 0, b: 0, c: 0 });
  });

  it('two fully-overlapping bars → 2 rows', () => {
    const bars = [
      mkBar('a', 0, 8),  // 2 months
      mkBar('b', 0, 8),
    ];
    const { rowByBarId, totalRows } = packLaneRows(bars);
    expect(totalRows).toBe(2);
    expect(rowByBarId.a).not.toBe(rowByBarId.b);
  });

  it('three bars with a cascading overlap pack into 2 rows', () => {
    // a runs months 0..2, b runs 1..3 (overlaps a), c runs 2.5..4 (overlaps b only).
    const bars = [
      mkBar('a', 0,   8),
      mkBar('b', 1,   8),
      mkBar('c', 2.5, 6),
    ];
    const { rowByBarId, totalRows } = packLaneRows(bars);
    expect(totalRows).toBe(2);
    // a and c can share a row (they don't overlap); b must be on the other row.
    expect(rowByBarId.a).toBe(rowByBarId.c);
    expect(rowByBarId.b).not.toBe(rowByBarId.a);
  });

  it('milestonesAtBottom: work rows first, then milestone rows', () => {
    const bars = [
      mkBar('w1', 0, 4),
      mkBar('w2', 2, 4),
      { id: 'm1', type: 'milestone', startIdx: 1, span: 0, label: 'M1', buffer: 0 },
      { id: 'm2', type: 'milestone', startIdx: 3, span: 0, label: 'M2', buffer: 0 },
    ];
    const { rowByBarId, totalRows } = packLaneRows(bars, 60, { milestonesAtBottom: true });
    // Work bars w1, w2 — each in row 0 (they don't overlap).
    expect(rowByBarId.w1).toBe(0);
    expect(rowByBarId.w2).toBe(0);
    // Milestones go to row 1 (below the work row).
    expect(rowByBarId.m1).toBeGreaterThanOrEqual(1);
    expect(rowByBarId.m2).toBeGreaterThanOrEqual(1);
    expect(totalRows).toBeGreaterThanOrEqual(2);
  });

  it('returns at least 1 row even for an empty input', () => {
    expect(packLaneRows([]).totalRows).toBe(1);
  });

  it('label-aware packing: a very narrow bar with a long label claims extra room', () => {
    // Two 1-week bars 4 weeks apart. Without label accounting they fit on one row.
    // With a long label and a tight colW, they should bump to two rows.
    const longLabel = 'A really very long label that exceeds the bar width';
    const bars = [
      mkBar('a', 0, 1, longLabel),
      mkBar('b', 1, 1, longLabel),
    ];
    const tight = packLaneRows(bars, /* colW */ 20);
    const loose = packLaneRows(bars, /* colW */ 0);
    // colW=0 → no label accounting → 1 row. colW=20 (narrow) → 2 rows.
    expect(loose.totalRows).toBe(1);
    expect(tight.totalRows).toBeGreaterThan(1);
  });
});
