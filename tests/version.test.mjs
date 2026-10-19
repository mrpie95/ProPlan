import { describe, it, expect } from 'vitest';
import {
  parseSemver, bumpVersion, compareSemver, formatCommit, makeBuildEntry,
  appendBuildHistory, nextBuildNumber, formatVersionLabel, formatBuildInfo,
  changelogStub, insertChangelogEntry, BUILD_HISTORY_CAP,
} from '../src/proplan-core.mjs';
import { setConfVersion, setCargoVersion, setCargoLockVersion } from '../scripts/sync-version.mjs';

describe('semver', () => {
  it('parses plain, prerelease and build-metadata versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: '' });
    expect(parseSemver('0.2.0-beta.1')).toMatchObject({ pre: 'beta.1' });
    expect(parseSemver('1.0.0+abc')).toMatchObject({ major: 1 });
  });
  it('rejects junk', () => {
    for (const v of ['', null, undefined, '1.2', 'v1.2.3', '1.2.x', 'a.b.c']) expect(parseSemver(v)).toBeNull();
  });
  it('bumps patch / minor / major and resets lower parts', () => {
    expect(bumpVersion('0.2.0', 'patch')).toBe('0.2.1');
    expect(bumpVersion('0.2.7', 'minor')).toBe('0.3.0');
    expect(bumpVersion('1.4.9', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.4.9-beta.2', 'patch')).toBe('1.4.10');
  });
  it('throws on bad input', () => {
    expect(() => bumpVersion('nope', 'patch')).toThrow();
    expect(() => bumpVersion('1.0.0', 'huge')).toThrow();
  });
  it('compares', () => {
    expect(compareSemver('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('x', '0.0.1')).toBeLessThan(0);
  });
});

describe('build history', () => {
  it('formats the commit label', () => {
    expect(formatCommit('abc1234', false)).toBe('abc1234');
    expect(formatCommit('abc1234', true)).toBe('abc1234+dirty');
    expect(formatCommit('', true)).toBe('unknown');
  });
  it('normalises entries and keeps testsPassing only when numeric', () => {
    const e = makeBuildEntry({ build: '3', version: '0.2.0', date: 'd', commit: 'abc', dirty: 1, branch: 'main', testsPassing: 12 });
    expect(e).toEqual({ build: 3, version: '0.2.0', date: 'd', commit: 'abc', dirty: true, branch: 'main', testsPassing: 12 });
    expect('testsPassing' in makeBuildEntry({ build: 1, testsPassing: undefined })).toBe(false);
    expect(makeBuildEntry({}).build).toBe(0);
  });
  it('appends without mutating and caps to the newest entries', () => {
    const base = [{ build: 1 }, { build: 2 }];
    const out = appendBuildHistory(base, { build: 3 }, 2);
    expect(base).toHaveLength(2);
    expect(out.map(e => e.build)).toEqual([2, 3]);
    let h = [];
    for (let i = 1; i <= BUILD_HISTORY_CAP + 10; i++) h = appendBuildHistory(h, { build: i });
    expect(h).toHaveLength(BUILD_HISTORY_CAP);
    expect(h[h.length - 1].build).toBe(BUILD_HISTORY_CAP + 10);
    expect(appendBuildHistory(null, { build: 1 })).toEqual([{ build: 1 }]);
  });
  it('picks the next build number from lastBuild and history, tolerating junk', () => {
    expect(nextBuildNumber({ lastBuild: 4, history: [] })).toBe(5);
    expect(nextBuildNumber({ lastBuild: 0, history: [{ build: 9 }, { build: 2 }] })).toBe(10);
    expect(nextBuildNumber(null)).toBe(1);
    expect(nextBuildNumber({ lastBuild: 'x' })).toBe(1);
  });
  it('formats labels and the copyable block', () => {
    expect(formatVersionLabel({ version: '0.2.0', build: 7 })).toBe('0.2.0 (build 7)');
    expect(formatVersionLabel(null)).toBe('dev');
    const txt = formatBuildInfo({ version: '0.2.0', build: 7, date: '2026-10-19T10:00:00Z', commit: 'abc1234', dirty: true, branch: 'main', testsPassing: 300 });
    expect(txt.split('\n')).toEqual([
      'ProPlan 0.2.0 (build 7)', 'Built: 2026-10-19T10:00:00Z', 'Commit: abc1234+dirty on main', 'Tests passing: 300',
    ]);
    expect(formatBuildInfo(null)).toBe('ProPlan dev');
  });
});

describe('changelog helpers', () => {
  const cl = '# Changelog\n\nintro\n\n## [0.1.0] - 2026-01-01\n\n- old\n';
  it('inserts a new entry above the newest one', () => {
    const out = insertChangelogEntry(cl, '0.2.0', changelogStub('0.2.0', '2026-10-19'));
    expect(out.indexOf('## [0.2.0]')).toBeGreaterThan(0);
    expect(out.indexOf('## [0.2.0]')).toBeLessThan(out.indexOf('## [0.1.0]'));
  });
  it('is idempotent per version and handles an empty file', () => {
    const once = insertChangelogEntry(cl, '0.2.0', changelogStub('0.2.0', 'd'));
    expect(insertChangelogEntry(once, '0.2.0', 'x')).toBe(once);
    expect(insertChangelogEntry('', '0.1.0', changelogStub('0.1.0', 'd'))).toContain('## [0.1.0] - d');
  });
});

describe('sync-version text edits', () => {
  it('rewrites only the version field', () => {
    expect(setConfVersion('{\n  "productName": "x",\n  "version": "0.1.0",\n  "a": "0.1.0"\n}', '0.2.0'))
      .toBe('{\n  "productName": "x",\n  "version": "0.2.0",\n  "a": "0.1.0"\n}');
    const cargo = '[package]\nname = "proplan"\nversion = "0.1.0"\n\n[dependencies]\ntauri = { version = "2" }\nserde = "1"\n';
    expect(setCargoVersion(cargo, '0.3.0')).toBe(cargo.replace('version = "0.1.0"', 'version = "0.3.0"'));
    const lock = '[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "proplan"\nversion = "0.1.0"\n';
    expect(setCargoLockVersion(lock, '0.3.0')).toContain('name = "proplan"\nversion = "0.3.0"');
    expect(setCargoLockVersion(lock, '0.3.0')).toContain('name = "other"\nversion = "1.0.0"');
  });
});
