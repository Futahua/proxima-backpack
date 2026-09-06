import { describe, expect, it } from 'vitest';
import { isRelativeFsaPath, validateFsaEvidence } from '../src/app/fsaEvidence.js';

const validReport = {
  schemaVersion: 1,
  handleName: 'gate5-fsa-clean-fixture',
  permission: 'granted',
  persisted: true,
  entries: [
    { path: 'nested', kind: 'directory' },
    { path: 'nested/child-note.txt', kind: 'file', size: 15, textMarker: 'gate5-child-v1\n', revision: '2026-09-06T07:53:54.825Z:15:15' },
    { path: 'root-note.txt', kind: 'file', size: 25, textMarker: 'clean-profile-root-v1\n', revision: '2026-09-06T09:10:27.627Z:25:25' },
  ],
};

describe('bounded FSA evidence', () => {
  it('accepts the relative-only report shape', () => {
    expect(validateFsaEvidence(validReport)).toEqual({ ok: true, errors: [] });
  });

  it.each(['/absolute/file.txt', '\\server\\share\\file.txt', 'C:\\temp\\file.txt', 'nested/../file.txt', 'nested//file.txt'])('rejects unsafe relative path %s', (path) => {
    expect(isRelativeFsaPath(path)).toBe(false);
  });

  it('rejects absolute paths anywhere in the report and duplicate entries', () => {
    const invalid = { ...validReport, entries: [...validReport.entries, { path: 'root-note.txt', kind: 'file', size: 1, textMarker: 'C:\\secret', revision: 'r' }] };
    const result = validateFsaEvidence(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('entries[3].path is duplicated');
    expect(result.errors).toContain('report must not contain absolute paths');
  });

  it('rejects unbounded file fields', () => {
    const invalid = { ...validReport, entries: [{ path: 'root.txt', kind: 'file', size: -1, textMarker: 'x'.repeat(401), revision: 'r'.repeat(201) }] };
    expect(validateFsaEvidence(invalid).ok).toBe(false);
  });
});
