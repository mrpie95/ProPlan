import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NAV_VIEWS, NAV_LAYOUT, MENU_BAR, navViewIds, navGroupOfView, normalizeBetaViews, menuCommandIds,
} from '../src/proplan-core.mjs';

const html = readFileSync(new URL('../Carpati Timeline.html', import.meta.url), 'utf8');
const mainRs = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');

/** Ids handled by runCommand() in the page: `cmd === "x"` branches (+ the `view:` prefix). */
function handledCommands() {
  const start = html.indexOf('async function runCommand(cmd)');
  const end = html.indexOf('document.getElementById("importFile").addEventListener', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = html.slice(start, end);
  return new Set([...body.matchAll(/cmd === "([A-Za-z]+)"/g)].map(m => m[1]));
}

describe('nav layout', () => {
  it('has Summary on its own, then Editors, then Views, in that order', () => {
    expect(NAV_LAYOUT.map(g => g.id)).toEqual(['summary', 'editors', 'views']);
    expect(NAV_LAYOUT[0].views).toEqual(['summary']);
    expect(NAV_LAYOUT[1].views).toEqual(['structure', 'plan', 'progress', 'altTimeline']);
  });
  it('lists each view exactly once and every one has a label + description', () => {
    const ids = navViewIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Object.keys(NAV_VIEWS).sort());
    for (const id of ids) {
      expect(NAV_VIEWS[id].label).toBeTruthy();
      expect(NAV_VIEWS[id].desc).toBeTruthy();
    }
  });
  it('sections of a menu group cover exactly that group\'s views', () => {
    const views = NAV_LAYOUT.find(g => g.kind === 'menu');
    expect(views.sections.flatMap(s => s.views).sort()).toEqual([...views.views].sort());
  });
  it('every nav view has a renderer and a tab/dropdown entry in the page', () => {
    const renderCurrent = html.slice(html.indexOf('function renderCurrent()'), html.indexOf('function renderCurrent()') + 1800);
    for (const id of navViewIds()) expect(renderCurrent).toContain(`currentView === "${id}"`);
  });
  it('navGroupOfView maps views to their group, beta views to "beta", unknown to null', () => {
    expect(navGroupOfView('summary')).toBe('summary');
    expect(navGroupOfView('progress')).toBe('editors');
    expect(navGroupOfView('altTimeline')).toBe('editors');
    expect(navGroupOfView('viewA')).toBe('views');
    expect(navGroupOfView('milestones')).toBe('views');
    expect(navGroupOfView('betaX', ['betaX'])).toBe('beta');
    expect(navGroupOfView('betaX')).toBeNull();
    expect(navGroupOfView('nope')).toBeNull();
  });
});

describe('normalizeBetaViews', () => {
  it('keeps valid entries and flags those without a renderer as not ready', () => {
    const out = normalizeBetaViews([
      { id: 'a', label: 'A', render() {} },
      { id: 'b', label: 'B', desc: 'soon' },
    ]);
    expect(out).toEqual([
      { id: 'a', label: 'A', desc: '', ready: true },
      { id: 'b', label: 'B', desc: 'soon', ready: false },
    ]);
  });
  it('drops junk, duplicates and ids that clash with built-in views', () => {
    const out = normalizeBetaViews([null, 7, {}, { id: 'x' }, { id: '', label: 'e' },
      { id: 'plan', label: 'Clash' }, { id: 'ok', label: 'OK' }, { id: 'ok', label: 'Again' }]);
    expect(out.map(v => v.id)).toEqual(['ok']);
    expect(normalizeBetaViews(undefined)).toEqual([]);
  });
});

describe('menu bar', () => {
  const ids = menuCommandIds();
  it('has the expected top-level menus', () => {
    expect(MENU_BAR.map(m => m.label)).toEqual(['Project', 'Edit', 'View', 'Export & backup', 'Beta', 'Help']);
  });
  it('puts "Beta views" under Beta, filled from the registry', () => {
    const beta = MENU_BAR.find(m => m.id === 'beta');
    const sub = beta.items.find(i => i.t === 'sub');
    expect(sub.label).toBe('Beta views');
    expect(sub.items).toEqual([{ t: 'beta' }]);
  });
  it('has no duplicate command ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('absorbs every item the old Menu ▾ had', () => {
    for (const id of ['renameProject', 'newProject', 'duplicateProject', 'deleteProject', 'json', 'exportAll', 'import',
      'importBackup', 'importXlsx', 'png', 'pdf', 'html', 'toggleTheme', 'changeProcess', 'loadDemo', 'clear',
      'saveSnapshot', 'undo', 'redo']) expect(ids).toContain(id);
  });
  it('every menu id is handled by runCommand', () => {
    const handled = handledCommands();
    for (const id of ids) {
      if (id.startsWith('view:')) { expect(navViewIds()).toContain(id.slice(5)); continue; }
      expect(handled, `runCommand has no branch for "${id}"`).toContain(id);
    }
  });
  it('every id the native macOS menu emits is handled by runCommand', () => {
    const handled = handledCommands();
    const native = [...mainRs.matchAll(/cmd\(app, "([^"]+)"/g)].map(m => m[1]);
    expect(native.length).toBeGreaterThan(10);
    for (const id of native) {
      if (id.startsWith('view:')) { expect([...navViewIds(), 'altTimeline']).toContain(id.slice(5)); continue; }
      expect(handled, `runCommand has no branch for native menu id "${id}"`).toContain(id);
    }
  });
});
