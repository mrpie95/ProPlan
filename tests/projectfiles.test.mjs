import { describe, it, expect } from 'vitest';
import {
  projectFileSlug, isSafeProjectFilename, uniqueProjectFilename, serializeProjectFile,
  parseProjectFile, isFileNewerThanLocal, MENU_BAR,
} from '../src/proplan-core.mjs';

const st = () => ({ start: '2026-01', end: '2026-12', colWidth: 80, lanes: [{ id: 'l1', code: 'WP 1', desc: '', bars: [] }] });

describe('project files', () => {
  it('slugs names safely', () => {
    expect(projectFileSlug('My Plan: v2!')).toBe('my-plan-v2');
    expect(projectFileSlug('Café ../../etc')).toBe('cafe-etc');
    expect(projectFileSlug('')).toBe('project');
    expect(projectFileSlug('   ')).toBe('project');
    expect(projectFileSlug('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
  it('validates file names', () => {
    expect(isSafeProjectFilename('a.proplan.json')).toBe(true);
    for (const bad of ['../a.proplan.json', 'a/b.proplan.json', 'a\\b.proplan.json', '.proplan.json', 'a.json', '.hid.proplan.json', '', null, 'a..b.proplan.json'])
      expect(isSafeProjectFilename(bad), String(bad)).toBe(false);
  });
  it('makes unique names', () => {
    expect(uniqueProjectFilename('Plan', [])).toBe('plan.proplan.json');
    expect(uniqueProjectFilename('Plan', ['plan.proplan.json'])).toBe('plan-2.proplan.json');
    expect(uniqueProjectFilename('Plan', ['PLAN.proplan.json', 'plan-2.proplan.json'])).toBe('plan-3.proplan.json');
  });
  it('round-trips', () => {
    const snap = { id: 's1', name: 'One', createdAt: 5, state: st() };
    const txt = serializeProjectFile({ name: 'P', state: st(), snapshots: [snap], app: { version: '1.0.0', build: 3 }, savedAt: 1000 });
    const r = parseProjectFile(txt);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('P');
    expect(r.state.lanes).toHaveLength(1);
    expect(r.snapshots).toHaveLength(1);
    expect(r.savedAt).toBe(1000);
    expect(r.app.build).toBe(3);
    expect(r.state.processId).toBeTruthy();
  });
  it('refuses junk without throwing', () => {
    for (const bad of ['', 'nope', '[]', 'null', '{}', '{"format":"x"}',
      JSON.stringify({ format: 'proplan-project', version: 1 }),
      JSON.stringify({ format: 'proplan-project', version: 1, state: { lanes: 'x' } }),
      JSON.stringify({ format: 'proplan-project', version: 99, state: st() })])
      expect(parseProjectFile(bad).ok, bad).toBe(false);
  });
  it('drops junk snapshots', () => {
    const o = { format: 'proplan-project', version: 1, name: ' ', state: st(), snapshots: [null, { id: 1 }, { id: 'a', state: { lanes: [] } }] };
    const r = parseProjectFile(JSON.stringify(o));
    expect(r.ok).toBe(true);
    expect(r.snapshots.map(s => s.id)).toEqual(['a']);
    expect(r.name).toBe('Imported project');
  });
  it('detects a newer file on disk', () => {
    expect(isFileNewerThanLocal(10000, { updatedAt: 5000, fileSavedAt: 6000 })).toBe(true);
    expect(isFileNewerThanLocal(6500, { updatedAt: 5000, fileSavedAt: 6000 })).toBe(false);
    expect(isFileNewerThanLocal(NaN, {})).toBe(false);
  });
  it('menu has the file commands', () => {
    const flat = JSON.stringify(MENU_BAR);
    for (const id of ['openProjectFile', 'saveProjectCopy', 'showProjectFile', 'openProjectFolder', 'toggleFileSave']) expect(flat).toContain(id);
  });
});
