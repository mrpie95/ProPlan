import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  DEFAULT_PROCESS_ID, SOP18_PROCESS, STAGE_GATE_PROCESS, NO_PROCESS,
  PHASE_ORDER, PHASE_CODES_IN_ORDER,
  validateProcessDef, registerProcess, unregisterProcess, getProcessById, listProcesses,
  serializeCustomProcesses, loadCustomProcesses, exportProcessDef,
  getProcess, isProcessResolved, processPhase, processPhaseIndex, gateLabel,
  mapPhaseCode, planProcessSwitch, applyProcessSwitch,
  isBleedingBar, phaseSpanCodes, computePhaseRanges, computePhaseGates,
  computeAllProductPhaseGates, enforcePhaseOrder, autoSequence, normaliseState,
} from '../src/proplan-core.mjs';

const customIds = [];
afterEach(() => { while (customIds.length) unregisterProcess(customIds.pop()); });
const reg = (def) => { const r = registerProcess(def); if (r.ok) customIds.push(def.id); return r; };

const twoPhase = (id = 'two') => ({
  id, name: 'Two phase',
  phases: [{ code: 'A', name: 'Alpha' }, { code: 'B', name: 'Beta' }],
});

const bar = (id, phase, startIdx, span, extra = {}) => ({
  id, type: 'work', label: id, startIdx, span, buffer: 0, phase, dependsOn: [], ...extra,
});
const mk = (processId, bars, extra = {}) => {
  const s = {
    start: '2026-01', end: '2026-12', colWidth: 60,
    ...(processId ? { processId } : {}),
    lanes: [{ id: 'L', code: 'WP 1', desc: '', bars }],
    ...extra,
  };
  normaliseState(s);
  return s;
};

describe('process registry', () => {
  it('has the three built-ins, built-ins first', () => {
    const ids = listProcesses().map(p => p.id);
    expect(ids.slice(0, 3)).toEqual(['sop18', 'stagegate', 'none']);
    expect(getProcessById('sop18')).toBe(SOP18_PROCESS);
    expect(getProcessById('nope')).toBeNull();
    expect(DEFAULT_PROCESS_ID).toBe('sop18');
  });

  it('SOP-18 matches the legacy constants exactly', () => {
    expect(SOP18_PROCESS.codes).toEqual(PHASE_CODES_IN_ORDER);
    expect(SOP18_PROCESS.order).toEqual(PHASE_ORDER);
    expect(SOP18_PROCESS.phases.map(p => p.num)).toEqual(['100', '200', '300', '400']);
    expect(SOP18_PROCESS.phases[0].color).toEqual({ bg: '#fee2e2', accent: '#ef4444', text: '#7f1d1d' });
    expect(SOP18_PROCESS.phases[3].tasks.at(-1).num).toBe('499');
    expect(SOP18_PROCESS.roles.map(r => r.code)).toEqual(['PL', 'PM', 'QM', 'SME', 'ME']);
  });

  it('Stage-Gate has 3 phases, "none" has 0 and does not enforce', () => {
    expect(STAGE_GATE_PROCESS.codes).toEqual(['SCP', 'DEV', 'LCH']);
    expect(NO_PROCESS.codes).toEqual([]);
    expect(NO_PROCESS.gates.enforce).toBe(false);
  });

  it('built-ins are frozen', () => {
    expect(Object.isFrozen(SOP18_PROCESS)).toBe(true);
    expect(Object.isFrozen(SOP18_PROCESS.phases[0].color)).toBe(true);
    expect(() => { 'use strict'; SOP18_PROCESS.codes.push('X'); }).toThrow();
  });

  it('registers, lists and unregisters a custom process', () => {
    const r = reg(twoPhase());
    expect(r.ok).toBe(true);
    expect(r.process.builtin).toBe(false);
    expect(r.process.order).toEqual({ A: 0, B: 1 });
    expect(r.process.phases[1].color.accent).toMatch(/^#/); // default colour filled in
    expect(listProcesses().map(p => p.id)).toContain('two');
    expect(unregisterProcess('two')).toBe(true);
    expect(getProcessById('two')).toBeNull();
  });

  it('refuses to clobber or remove a built-in', () => {
    const r = registerProcess({ ...twoPhase('sop18') });
    expect(r.ok).toBe(false);
    expect(unregisterProcess('sop18')).toBe(false);
    expect(getProcessById('sop18')).toBe(SOP18_PROCESS);
  });

  it('rejects malformed definitions with readable errors', () => {
    const bad = (d) => validateProcessDef(d);
    expect(bad(null).ok).toBe(false);
    expect(bad({ id: 'Bad Id', name: 'x', phases: [{ code: 'A', name: 'a' }] }).ok).toBe(false);
    expect(bad({ id: 'x', name: '', phases: [{ code: 'A', name: 'a' }] }).ok).toBe(false);
    expect(bad({ id: 'x', name: 'x', phases: [] }).ok).toBe(false);          // custom needs ≥1
    expect(bad({ id: 'x', name: 'x', phases: [{ code: 'A', name: 'a' }, { code: 'A', name: 'b' }] }).errors.join()).toMatch(/duplicated/);
    expect(bad({ id: 'x', name: 'x', phases: [{ code: 'END', name: 'a' }] }).errors.join()).toMatch(/reserved/);
    expect(bad({ id: 'x', name: 'x', phases: [{ code: 'TOOLONGCODE', name: 'a' }] }).ok).toBe(false);
    expect(bad({ id: 'x', name: 'x', phases: [{ code: 'A', name: 'a', color: { bg: 1 } }] }).ok).toBe(false);
    expect(bad({ id: 'x', name: 'x', phases: [{ code: 'A', name: 'a' }], gates: { enforce: 'yes' } }).ok).toBe(false);
    expect(bad({ id: 'x', name: 'x', phases: 'nope' }).ok).toBe(false);
  });

  it('serialises custom processes and reloads them, skipping invalid ones', () => {
    reg(twoPhase('rt'));
    const saved = JSON.parse(JSON.stringify(serializeCustomProcesses()));
    expect(saved.map(d => d.id)).toEqual(['rt']);
    expect(saved[0].codes).toBeUndefined();               // derived fields not persisted
    unregisterProcess('rt');
    const res = loadCustomProcesses([...saved, { id: 'BAD' }, 'junk']);
    customIds.push('rt');
    expect(res.loaded).toEqual(['rt']);
    expect(res.rejected).toHaveLength(2);
    expect(getProcessById('rt').codes).toEqual(['A', 'B']);
    expect(exportProcessDef(getProcessById('rt')).phases[0].code).toBe('A');
  });

  it('gate label templates use {code} / {name}', () => {
    expect(gateLabel(SOP18_PROCESS, 'DP', false)).toBe('DP closure');
    expect(gateLabel(SOP18_PROCESS, 'FP', true)).toBe('Project close');
    expect(gateLabel(STAGE_GATE_PROCESS, 'DEV', false)).toBe('Develop gate');
    expect(processPhase(STAGE_GATE_PROCESS, 'DEV').name).toBe('Develop');
    expect(processPhase(STAGE_GATE_PROCESS, 'PRS')).toBeNull();
    expect(processPhaseIndex(STAGE_GATE_PROCESS, 'LCH')).toBe(2);
    expect(processPhaseIndex(STAGE_GATE_PROCESS, 'toString')).toBe(-1);
  });
});

describe('getProcess resolution + normaliseState migration', () => {
  it('resolves a Process, a state, and undefined', () => {
    expect(getProcess(STAGE_GATE_PROCESS)).toBe(STAGE_GATE_PROCESS);
    expect(getProcess({ processId: 'stagegate' })).toBe(STAGE_GATE_PROCESS);
    expect(getProcess({ lanes: [] })).toBe(SOP18_PROCESS);
    expect(getProcess(undefined)).toBe(SOP18_PROCESS);
    expect(getProcess({ processId: 'ghost' })).toBe(NO_PROCESS);
    expect(isProcessResolved({ processId: 'ghost' })).toBe(false);
    expect(isProcessResolved({ lanes: [] })).toBe(true);
  });

  it('state without processId loads as SOP-18', () => {
    const s = { lanes: [] };
    normaliseState(s);
    expect(s.processId).toBe('sop18');
  });

  it('junk processId values become SOP-18, unknown strings are kept (unresolved)', () => {
    for (const bad of [null, 7, '', '   ', {}]) {
      const s = { lanes: [], processId: bad };
      normaliseState(s);
      expect(s.processId).toBe('sop18');
    }
    const s = { lanes: [], processId: 'ghost' };
    normaliseState(s);
    expect(s.processId).toBe('ghost');
    expect(isProcessResolved(s)).toBe(false);
  });

  it('all fixtures (pre-process exports) load as SOP-18 and keep behaviour', () => {
    const files = readdirSync(new URL('./fixtures/', import.meta.url)).filter(f => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const s = JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
      if (!s || !Array.isArray(s.lanes)) continue;
      normaliseState(s);
      expect(s.processId).toBe('sop18');
    }
  });

  it('adopts an embedded custom definition and drops invalid / built-in ones', () => {
    const def = twoPhase('embedded');
    const s = { lanes: [], processId: 'embedded', processDef: def };
    normaliseState(s);
    customIds.push('embedded');
    expect(getProcessById('embedded')).not.toBeNull();
    expect(isProcessResolved(s)).toBe(true);
    const t = { lanes: [], processId: 'sop18', processDef: { id: 'sop18', name: 'x', phases: [{ code: 'Z', name: 'z' }] } };
    normaliseState(t);
    expect(t.processDef).toBeUndefined();
    expect(getProcessById('sop18')).toBe(SOP18_PROCESS);
    const u = { lanes: [], processDef: { nope: 1 } };
    normaliseState(u);
    expect(u.processDef).toBeUndefined();
    expect(u.processId).toBe('sop18');
  });
});

describe('SOP-18 behaviour is unchanged', () => {
  it('same results with no process, processId "sop18", and an explicit Process', () => {
    const bars = () => [bar('a', 'PRS', 0, 4), bar('b', 'DP', 0, 4, { phaseEnd: 'DO' }), bar('c', 'FP', 0, 4)];
    const a = mk(null, bars()), b = mk('sop18', bars());
    for (const s of [a, b]) enforcePhaseOrder(s);
    expect(a.lanes[0].bars.map(x => x.startIdx)).toEqual(b.lanes[0].bars.map(x => x.startIdx));
    expect(computePhaseRanges(a)).toEqual(computePhaseRanges(b));
    expect(phaseSpanCodes({ phase: 'DP', phaseEnd: 'FP' })).toEqual(['DP', 'DO', 'FP']);
    expect(phaseSpanCodes({ phase: 'DP', phaseEnd: 'FP' }, SOP18_PROCESS)).toEqual(['DP', 'DO', 'FP']);
    expect(isBleedingBar({ phase: 'DP', phaseEnd: 'DO' }, b)).toBe(true);
  });

  it('gates keep the legacy labels and END code', () => {
    const ranges = { PRS: { start: 0, end: 2 }, DP: { start: 2, end: 5 } };
    const g = computePhaseGates(ranges, ['PRS', 'DP']);
    expect(g.map(x => x.label)).toEqual(['PRS closure', 'Project close']);
    expect(g.map(x => x._gateCode)).toEqual(['PRS', 'END']);
  });
});

describe('phase functions under another process', () => {
  const sg = (bars) => mk('stagegate', bars);

  it('phaseSpanCodes / isBleedingBar read the state\'s process', () => {
    const s = sg([]);
    expect(phaseSpanCodes({ phase: 'SCP', phaseEnd: 'LCH' }, s)).toEqual(['SCP', 'DEV', 'LCH']);
    expect(isBleedingBar({ phase: 'SCP', phaseEnd: 'DEV' }, s)).toBe(true);
    expect(isBleedingBar({ phase: 'LCH', phaseEnd: 'SCP' }, s)).toBe(false);
  });

  it('bars tagged with SOP-18 codes are dormant (ignored like untagged)', () => {
    const s = sg([bar('a', 'PRS', 3, 4), bar('b', 'DP', 0, 4, { phaseEnd: 'DO' })]);
    expect(phaseSpanCodes(s.lanes[0].bars[0], s)).toEqual([]);
    expect(isBleedingBar(s.lanes[0].bars[1], s)).toBe(false);
    expect(computePhaseRanges(s)).toEqual({});
    const before = JSON.stringify(s.lanes);
    enforcePhaseOrder(s);
    expect(JSON.stringify(s.lanes)).toBe(before);
  });

  it('computePhaseRanges / gates use the 3 phases', () => {
    const s = sg([bar('a', 'SCP', 0, 4), bar('b', 'DEV', 1, 8), bar('c', 'LCH', 2, 4)]);
    const r = computePhaseRanges(s);
    expect(Object.keys(r).sort()).toEqual(['DEV', 'LCH', 'SCP']);
    const gates = computeAllProductPhaseGates(s);
    expect(gates.map(g => g.label)).toEqual(['Scope gate', 'Develop gate', 'Project close']);
    expect(gates.map(g => g._gateCode)).toEqual(['SCP', 'DEV', 'END']);
    expect(gates.every(g => g._productId)).toBe(true);
  });

  it('enforcePhaseOrder snaps in order under a 3-phase process', () => {
    const s = sg([bar('a', 'SCP', 0, 4), bar('b', 'DEV', 0, 4), bar('c', 'LCH', 0, 4)]);
    enforcePhaseOrder(s);
    const [a, b, c] = s.lanes[0].bars;
    expect(a.startIdx).toBe(0);
    expect(b.startIdx).toBe(1);          // after SCP ends (4 weeks = 1 month)
    expect(c.startIdx).toBe(2);
  });

  it('extendsPhase and locked still exempt under a 3-phase process', () => {
    const s = sg([
      bar('a', 'SCP', 0, 40, { extendsPhase: true }),
      bar('b', 'DEV', 0, 4),
      bar('c', 'LCH', 0, 4, { locked: true }),
    ]);
    enforcePhaseOrder(s);
    const [, b, c] = s.lanes[0].bars;
    expect(b.startIdx).toBe(0);          // not held by the extending SCP tail
    expect(c.startIdx).toBe(0);          // locked
  });

  it('bleed contributes to phaseEnd, not phase (3-phase)', () => {
    const s = sg([bar('a', 'SCP', 0, 4, { phaseEnd: 'DEV' }), bar('b', 'DEV', 0, 4)]);
    enforcePhaseOrder(s);
    expect(s.lanes[0].bars[1].startIdx).toBe(0);   // SCP→DEV bleed doesn't gate SCP's successor
  });

  it('autoSequence works with a custom process', () => {
    reg(twoPhase('seq'));
    const s = mk('seq', [bar('a', 'A', 0, 8), bar('b', 'B', 0, 4)]);
    expect(autoSequence(s).ok).toBe(true);
    expect(s.lanes[0].bars[1].startIdx).toBe(2);
  });

  it('gates.enforce=false draws gates but never moves bars', () => {
    reg({ ...twoPhase('soft'), gates: { enforce: false } });
    const s = mk('soft', [bar('a', 'A', 0, 8), bar('b', 'B', 0, 4)]);
    enforcePhaseOrder(s);
    expect(s.lanes[0].bars[1].startIdx).toBe(0);
    expect(computeAllProductPhaseGates(s).length).toBeGreaterThan(0);
  });

  it('"none" is a no-op for ordering, ranges and gates', () => {
    const s = mk('none', [bar('a', 'PRS', 0, 8), bar('b', 'DP', 0, 4)]);
    enforcePhaseOrder(s);
    expect(s.lanes[0].bars[1].startIdx).toBe(0);
    expect(computePhaseRanges(s)).toEqual({});
    expect(computeAllProductPhaseGates(s)).toEqual([]);
  });

  it('unknown process id behaves like "none" (nothing moved, nothing deleted)', () => {
    const s = mk('ghost', [bar('a', 'PRS', 0, 8), bar('b', 'DP', 0, 4)]);
    enforcePhaseOrder(s);
    expect(s.lanes[0].bars.map(b => b.phase)).toEqual(['PRS', 'DP']);
    expect(s.lanes[0].bars[1].startIdx).toBe(0);
  });
});

describe('switching a project\'s process', () => {
  const sopProject = () => mk('sop18', [
    bar('p', 'PRS', 0, 4),
    bar('d', 'DP', 1, 4, { phaseEnd: 'DO' }),
    bar('o', 'DO', 2, 4),
    bar('f', 'FP', 3, 4),
    bar('u', undefined, 4, 4),
  ], { activePhase: null });

  it('mapPhaseCode: shared code kept, otherwise position-based (first→first, last→last)', () => {
    expect(mapPhaseCode('DP', SOP18_PROCESS, SOP18_PROCESS)).toBe('DP');
    expect(['PRS', 'DP', 'DO', 'FP'].map(c => mapPhaseCode(c, SOP18_PROCESS, STAGE_GATE_PROCESS)))
      .toEqual(['SCP', 'DEV', 'DEV', 'LCH']);
    expect(['SCP', 'DEV', 'LCH'].map(c => mapPhaseCode(c, STAGE_GATE_PROCESS, SOP18_PROCESS)))
      .toEqual(['PRS', 'DO', 'FP']);
    expect(mapPhaseCode('PRS', SOP18_PROCESS, NO_PROCESS)).toBe('PRS');      // dormant target keeps
    expect(mapPhaseCode('ZZZ', SOP18_PROCESS, STAGE_GATE_PROCESS)).toBe('ZZZ'); // unknown to old: untouched
  });

  it('plan reports the mapping and counts, without mutating', () => {
    const s = sopProject();
    const before = JSON.stringify(s);
    const plan = planProcessSwitch(s, 'stagegate');
    expect(JSON.stringify(s)).toBe(before);
    expect(plan.ok).toBe(true);
    expect(plan.noop).toBe(false);
    expect(plan.dormant).toBe(false);
    expect(plan.taggedBars).toBe(4);
    expect(plan.dormantBars).toBe(0);
    const m = Object.fromEntries(plan.mapping.map(r => [`${r.from}>${r.to}`, r.bars]));
    expect(m).toEqual({ 'PRS>SCP': 1, 'DP>DEV': 1, 'DO>DEV': 1, 'FP>LCH': 1 });
    expect(plan.retaggedBars).toBe(4);
    expect(plan.mapping.map(r => r.from)).toEqual(['PRS', 'DP', 'DO', 'FP']);   // old-process order
    expect(plan.bleedsDropped).toBe(1);  // DP→DO becomes DEV→DEV: no longer a bleed
  });

  it('apply retags bars, bleeds, lanes and track phases; sets processId; keeps dates', () => {
    const s = sopProject();
    s.lanes[0].phase = 'DO';
    s.tracks.find(t => t.id === 'product').activePhase = 'DP';
    s.activePhase = 'DP';
    const startsBefore = s.lanes[0].bars.map(b => b.startIdx);
    const plan = applyProcessSwitch(s, 'stagegate');
    expect(plan.ok).toBe(true);
    expect(s.processId).toBe('stagegate');
    expect(s.lanes[0].bars.map(b => b.phase)).toEqual(['SCP', 'DEV', 'DEV', 'LCH', undefined]);
    expect(s.lanes[0].bars[1].phaseEnd).toBeUndefined();
    expect(s.lanes[0].phase).toBe('DEV');
    expect(s.tracks.find(t => t.id === 'product').activePhase).toBe('DEV');
    expect(s.activePhase).toBe('DEV');
    expect(s.lanes[0].bars.map(b => b.startIdx)).toEqual(startsBefore);
    expect(s.processDef).toBeUndefined();               // built-in: nothing embedded
  });

  it('a bleed that collapses onto one phase is dropped (and counted)', () => {
    const s = mk('sop18', [bar('x', 'DP', 0, 4, { phaseEnd: 'DO' }), bar('y', 'PRS', 0, 4, { phaseEnd: 'DP' })]);
    const plan = planProcessSwitch(s, 'stagegate');     // DP,DO → DEV (collapses); PRS→SCP, DP→DEV (still forward)
    expect(plan.bleedsDropped).toBe(1);
    applyProcessSwitch(s, 'stagegate');
    expect(s.lanes[0].bars[0].phase).toBe('DEV');
    expect(s.lanes[0].bars[1].phaseEnd).toBe('DEV');
    expect(s.lanes[0].bars[0].phaseEnd).toBeUndefined();
  });

  it('"_closed" and null track phases survive', () => {
    const s = sopProject();
    s.tracks.find(t => t.id === 'product').activePhase = '_closed';
    applyProcessSwitch(s, 'stagegate');
    expect(s.tracks.find(t => t.id === 'product').activePhase).toBe('_closed');
    const t = sopProject();
    applyProcessSwitch(t, 'stagegate');
    expect(t.tracks.find(x => x.id === 'product').activePhase).toBeNull();
  });

  it('switching to "none" keeps every tag (dormant) and is fully reversible', () => {
    const s = sopProject();
    const tags = () => JSON.stringify(s.lanes[0].bars.map(b => [b.phase, b.phaseEnd]));
    const before = tags();
    const plan = planProcessSwitch(s, 'none');
    expect(plan.dormant).toBe(true);
    expect(plan.dormantBars).toBe(4);
    expect(plan.retaggedBars).toBe(0);
    applyProcessSwitch(s, 'none');
    expect(s.processId).toBe('none');
    expect(tags()).toBe(before);
    expect(computePhaseRanges(s)).toEqual({});
    applyProcessSwitch(s, 'sop18');
    expect(tags()).toBe(before);
    expect(Object.keys(computePhaseRanges(s)).sort()).toEqual(['DO', 'DP', 'FP', 'PRS']);
  });

  it('dormant tags are untouched and re-activate when the target knows them', () => {
    const s = mk('stagegate', [bar('a', 'PRS', 0, 4), bar('b', 'DEV', 0, 4)]);   // PRS dormant here
    const plan = planProcessSwitch(s, 'sop18');
    expect(plan.dormantBars).toBe(0);                  // PRS is live in the target
    applyProcessSwitch(s, 'sop18');
    expect(s.lanes[0].bars.map(b => b.phase)).toEqual(['PRS', 'DO']);
    const t = mk('stagegate', [bar('a', 'ZZZ', 0, 4)]);
    applyProcessSwitch(t, 'sop18');
    expect(t.lanes[0].bars[0].phase).toBe('ZZZ');      // never destroyed
    expect(planProcessSwitch(t, 'sop18').dormantBars).toBe(1);
  });

  it('same process is a no-op; unknown target is an error', () => {
    const s = sopProject();
    const before = JSON.stringify(s);
    expect(planProcessSwitch(s, 'sop18').noop).toBe(true);
    expect(applyProcessSwitch(s, 'sop18').noop).toBe(true);
    expect(JSON.stringify(s)).toBe(before);
    const bad = applyProcessSwitch(s, 'nope');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Unknown process/);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('a project with no processId counts as SOP-18 when switching', () => {
    const s = { lanes: [{ id: 'L', code: 'WP 1', desc: '', bars: [bar('a', 'DO', 0, 4)] }] };
    expect(planProcessSwitch(s, 'sop18').noop).toBe(true);
    applyProcessSwitch(s, 'stagegate');
    expect(s.lanes[0].bars[0].phase).toBe('DEV');
  });

  it('switching to a custom process embeds its definition; survives a JSON round trip', () => {
    reg(twoPhase('cust'));
    const s = sopProject();
    applyProcessSwitch(s, 'cust');
    expect(s.processId).toBe('cust');
    expect(s.processDef.id).toBe('cust');
    // PRS,DP → A ; DO,FP → B
    expect(s.lanes[0].bars.map(b => b.phase)).toEqual(['A', 'A', 'B', 'B', undefined]);
    const copy = JSON.parse(JSON.stringify(s));
    unregisterProcess('cust');                          // pretend: fresh install
    normaliseState(copy);
    customIds.push('cust');
    expect(isProcessResolved(copy)).toBe(true);
    expect(phaseSpanCodes(copy.lanes[0].bars[0], copy)).toEqual(['A']);
    // back to a built-in drops the embedded def
    applyProcessSwitch(copy, 'sop18');
    expect(copy.processDef).toBeUndefined();
  });
});
