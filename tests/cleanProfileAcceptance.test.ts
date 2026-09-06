import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLEAN_PROFILE_EXPECTED_ENTRIES, evaluateCleanProfileAcceptance } from '../src/app/fsaEvidence.js';

const build = { proximaVersion: '0.1.0', gitSha: 'test-sha', buildMode: 'fixture', fixtureHash: 'fixture-hash' };
const validReport = {
  schemaVersion: 1,
  handleName: 'gate5-fsa-clean-fixture',
  permission: 'granted',
  persisted: true,
  entries: [
    { path: 'nested', kind: 'directory' },
    { path: 'nested/child-note.txt', kind: 'file', size: 15, textMarker: 'gate5-child-v1\n', revision: 'r1' },
    { path: 'README.md', kind: 'file', size: 173, textMarker: 'Gate 5 disposable FSA fixture', revision: 'r2' },
    { path: 'root-note.txt', kind: 'file', size: 23, textMarker: 'clean-profile-root-v1\n', revision: 'r3' },
  ],
};

describe('Gate 5 clean-profile acceptance harness', () => {
  it('accepts only the expected disposable fixture report', () => {
    const result = evaluateCleanProfileAcceptance(validReport, build);
    expect(result.passed).toBe(true);
    expect(result.observed.entryPaths).toEqual(CLEAN_PROFILE_EXPECTED_ENTRIES.map((entry) => entry.path).sort());
  });

  it.each([
    ['missing expected entry', { entries: validReport.entries.slice(1) }, 'missing-entry'],
    ['wrong fixture handle', { handleName: 'other-folder' }, 'wrong-handle'],
    ['not persisted', { persisted: false }, 'persistence-not-proven'],
    ['permission not granted', { permission: 'prompt' }, 'permission-not-granted'],
    ['wrong entry kind', { entries: validReport.entries.map((entry) => entry.path === 'nested' ? { ...entry, kind: 'file' } : entry) }, 'wrong-entry-kind'],
    ['missing marker', { entries: validReport.entries.map((entry) => entry.path === 'root-note.txt' ? { ...entry, textMarker: 'other' } : entry) }, 'missing-marker'],
  ])('rejects %s', (_name, change, code) => {
    const result = evaluateCleanProfileAcceptance({ ...validReport, ...change }, build);
    expect(result.passed).toBe(false);
    expect(result.validation.failureCodes).toContain(code);
  });

  it('rejects duplicates, absolute-path leakage, oversized fields, malformed permission, and unexpected entries', () => {
    const invalid = {
      ...validReport,
      entries: [...validReport.entries, { path: 'C:\\secret.txt', kind: 'file', size: 1, textMarker: 'x'.repeat(401), revision: 'x'.repeat(201) }, { ...validReport.entries[0] }],
      permission: 'bogus',
    };
    const result = evaluateCleanProfileAcceptance(invalid, build);
    expect(result.passed).toBe(false);
    expect(result.validation.failureCodes).toContain('invalid-report');
    expect(result.validation.details.length).toBeGreaterThan(0);
  });

  it('does not echo rejected absolute paths in the bounded acceptance projection', () => {
    const result = evaluateCleanProfileAcceptance({ ...validReport, handleName: 'C:\\Users\\admin\\vault', entries: [{ path: 'C:\\Users\\admin\\secret.txt', kind: 'file', size: 1, textMarker: 'x', revision: 'r' }] }, build);
    expect(result.passed).toBe(false);
    expect(result.observed.handleName).toBeNull();
    expect(result.observed.entryPaths).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('C:\\Users\\admin');
  });

  it('keeps the fixture reset utility fixed to the disposable path', () => {
    const source = readFileSync(new URL('../tools/reset-gate5-clean-fixture.mjs', import.meta.url), 'utf8');
    expect(source).toContain('C:/This is Minh/MatTroiSeConMoc/gate5-fsa-clean-fixture');
    expect(source).not.toContain('process.argv[2]');
    expect(source).not.toContain('process.env');
  });
});
