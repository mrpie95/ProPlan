import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { navViewIds } from '../src/proplan-core.mjs';

/* The native macOS menu (src-tauri/src/main.rs) only emits command ids; the
   page's runCommand() does the work. Every id the menu can emit must be one
   the page understands, or the menu item silently does nothing. */
const rust = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../ProPlan.html', import.meta.url), 'utf8');
const ids = [...rust.matchAll(/cmd\(app,\s*"([^"]+)"/g)].map(m => m[1]);
const betaIds = [...html.matchAll(/id:\s*"([A-Za-z]+)",\s*label:/g)].map(m => m[1]);

describe('native menu ids', () => {
  it('finds the menu items', () => {
    expect(ids.length).toBeGreaterThan(25);
  });

  it('every view:<id> is a nav view or a beta view', () => {
    const known = new Set([...navViewIds(), 'altTimeline', ...betaIds]);   // betaIds = window.BETA_VIEWS entries in the page
    for (const id of ids.filter(i => i.startsWith('view:'))) {
      expect(known.has(id.slice(5)), `native menu view "${id}" is not a known view`).toBe(true);
    }
  });

  it('every other id has a runCommand branch in the page', () => {
    for (const id of ids.filter(i => !i.startsWith('view:'))) {
      expect(html.includes(`cmd === "${id}"`), `runCommand has no branch for native menu id "${id}"`).toBe(true);
    }
  });

  it('no retired ids are left in the native menu', () => {
    expect(ids).not.toContain('togglePhases');
  });
});
