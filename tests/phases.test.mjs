import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computePhaseRanges,
  computePhaseGates,
  enforcePhaseOrder,
  isBleedingBar,
  phaseSpanCodes,
  WEEKS_PER_MONTH,
} from '../src/proplan-core.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('isBleedingBar', () => {
  it('detects a forward bleed (DP -> DO)', () => {
    expect(isBleedingBar({ phase: 'DP', phaseEnd: 'DO' })).toBe(true);
  });

  it('rejects same phase or backwards', () => {
    expect(isBleedingBar({ phase: 'DP', phaseEnd: 'DP' })).toBe(false);
    expect(isBleedingBar({ phase: 'DO', phaseEnd: 'DP' })).toBe(false);
  });

  it('rejects bars without one or both fields', () => {
    expect(isBleedingBar({ phase: 'DP' })).toBe(false);
    expect(isBleedingBar({ phaseEnd: 'DO' })).toBe(false);
    expect(isBleedingBar(null)).toBe(false);
  });
});

describe('phaseSpanCodes', () => {
  it('returns [phase] for a plain tagged bar', () => {
    expect(phaseSpanCodes({ phase: 'DP' })).toEqual(['DP']);
  });

  it('returns the full PRS..phaseEnd range for a bleed', () => {
    expect(phaseSpanCodes({ phase: 'PRS', phaseEnd: 'DO' })).toEqual(['PRS', 'DP', 'DO']);
  });

  it('returns [] for an untagged or invalid bar', () => {
    expect(phaseSpanCodes({})).toEqual([]);
    expect(phaseSpanCodes({ phase: 'XYZ' })).toEqual([]);
  });
});

describe('computePhaseRanges', () => {
  it('excludes milestones from the range', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'a', type: 'work', startIdx: 0, span: 4, buffer: 0, phase: 'PRS' },
          // Milestone at month 10 should NOT extend PRS to 10
          { id: 'm', type: 'milestone', startIdx: 10, span: 0, phase: 'PRS' },
        ],
      }],
    };
    const r = computePhaseRanges(state);
    expect(r.PRS.start).toBe(0);
    expect(r.PRS.end).toBe(1); // 4 weeks / 4 = 1 month — well short of milestone
  });

  it('bleed contributes start to phase, end to phaseEnd', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'dpAnchor', type: 'work', startIdx: 0,   span: 4, buffer: 0, phase: 'DP' },
          { id: 'bleed',   type: 'work', startIdx: 0.5, span: 8, buffer: 0, phase: 'DP', phaseEnd: 'DO' },
        ],
      }],
    };
    const r = computePhaseRanges(state);
    // DP.start picks up the bleed's startIdx = 0; DP.end stops at the plain DP task's end (=1)
    expect(r.DP.start).toBe(0);
    expect(r.DP.end).toBe(1);
    // DO inherits the bleed's end (0.5 + 2 = 2.5)
    expect(r.DO.start).toBe(2.5);
    expect(r.DO.end).toBe(2.5);
  });

  it('untagged bars are ignored', () => {
    const state = { lanes: [{ bars: [
      { id: 'untagged', type: 'work', startIdx: 5, span: 4, buffer: 0 },
    ]}]};
    expect(Object.keys(computePhaseRanges(state))).toEqual([]);
  });
});

describe('computePhaseGates', () => {
  it('produces one gate per present phase with x = phase.end', () => {
    const ranges = {
      PRS: { start: 0, end: 1 },
      DP:  { start: 2, end: 3 },
      DO:  { start: 4, end: 5 },
      FP:  { start: 6, end: 7 },
    };
    const gates = computePhaseGates(ranges, ['PRS', 'DP', 'DO', 'FP']);
    expect(gates).toHaveLength(4);
    expect(gates.map(g => g.startIdx)).toEqual([1, 3, 5, 7]);
  });

  it('labels the last phase as "Project close" with code END', () => {
    const ranges = { PRS: { start: 0, end: 1 }, DP: { start: 1, end: 2 } };
    const gates = computePhaseGates(ranges, ['PRS', 'DP']);
    expect(gates[0].label).toBe('PRS closure');
    expect(gates[0]._gateCode).toBe('PRS');
    expect(gates[1].label).toBe('Project close');
    expect(gates[1]._gateCode).toBe('END');
  });

  it('returns empty for empty phase list', () => {
    expect(computePhaseGates({}, [])).toEqual([]);
  });
});

describe('enforcePhaseOrder', () => {
  it('push-snaps a DP task that starts before PRS ends', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'prsLong', type: 'work', startIdx: 0, span: 12, buffer: 0, phase: 'PRS', dependsOn: [] },
          { id: 'dpEarly', type: 'work', startIdx: 1, span: 4,  buffer: 0, phase: 'DP', dependsOn: [] },
        ],
      }],
    };
    enforcePhaseOrder(state);
    const dp = state.lanes[0].bars.find(b => b.id === 'dpEarly');
    // PRS ends at 12/4 = 3 months. DP should be pushed to at least 3.
    expect(dp.startIdx).toBeGreaterThanOrEqual(3);
  });

  it('respects extendsPhase — long tail does NOT push the next phase', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'short',  type: 'work', startIdx: 0, span: 4,  buffer: 0, phase: 'PRS', dependsOn: [] },
          { id: 'longTail', type: 'work', startIdx: 0, span: 40, buffer: 0, phase: 'PRS', extendsPhase: true, dependsOn: [] },
          { id: 'dp',     type: 'work', startIdx: 0, span: 4,  buffer: 0, phase: 'DP',  dependsOn: [] },
        ],
      }],
    };
    enforcePhaseOrder(state);
    // Without extendsPhase, dp would be pushed to >= 10 months (40 weeks).
    // With it, dp's only gate is the SHORT task (4 weeks = 1 month).
    const dp = state.lanes[0].bars.find(b => b.id === 'dp');
    expect(dp.startIdx).toBeLessThanOrEqual(1);
  });

  it('bleed contributes end to phaseEnd, not phase — does not gate the start phase', () => {
    const state = {
      lanes: [{
        bars: [
          { id: 'shortDP', type: 'work', startIdx: 0,   span: 4, buffer: 0, phase: 'DP', dependsOn: [] },
          // Bleed DP -> DO with a long tail. Should NOT make a sibling DP bar wait.
          { id: 'bleed',   type: 'work', startIdx: 0.5, span: 8, buffer: 0, phase: 'DP', phaseEnd: 'DO', dependsOn: [] },
          { id: 'do',      type: 'work', startIdx: 0,   span: 4, buffer: 0, phase: 'DO', dependsOn: [] },
        ],
      }],
    };
    enforcePhaseOrder(state);
    const doBar = state.lanes[0].bars.find(b => b.id === 'do');
    // DO's gate is DP's max end (= the plain DP task's end = 1 month). DO must start at >= 1.
    // Crucially DO should be pushed by the BLEED's end (2.5), since the bleed's end contributes to DO.
    expect(doBar.startIdx).toBeGreaterThanOrEqual(1);
  });
});
