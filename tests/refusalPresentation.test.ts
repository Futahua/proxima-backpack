/**
 * How a refusal reaches a reader.
 *
 * These cases pin the shape rather than the wording of one surface: the code comes first because a
 * selector and an agent both match on it, the producer's sentence follows it, and the revision that
 * beat the caller is the last thing said. A refusal that named only the code was the defect this
 * exists to prevent, so each part is asserted to be *absent* when the producer did not supply it -
 * a formatter that invented a sentence or a revision number would be worse than the bare code.
 */
import { describe, expect, it } from 'vitest';
import { refusalTextFor } from '../src/app/refusalPresentation.js';

describe('the refusal a surface prints', () => {
  it('always starts with the stable code, so the machine-readable half survives', () => {
    expect(refusalTextFor({ code: 'action-not-available' })).toBe('action-not-available');
    const rich = refusalTextFor({
      code: 'stale-revision',
      detail: 'another writer changed this task first',
      actualRevision: 'rev-7',
    });
    expect(rich.startsWith('stale-revision')).toBe(true);
  });

  it('says what happened and at which revision when the producer knew', () => {
    const text = refusalTextFor({
      code: 'stale-revision',
      detail: 'another writer changed this task first',
      actualRevision: '2026-09-12T21:00:00.000Z:412:9ab3f1c2',
    });
    expect(text).toContain('another writer changed this task first');
    expect(text).toContain('now at revision 2026-09-12T21:00:00.000Z:412:9ab3f1c2');
  });

  it('does not invent a sentence or a revision the producer did not supply', () => {
    // Absent, null and blank all mean "nothing to add" rather than "something to guess at".
    expect(refusalTextFor({ code: 'storage-failure', detail: null })).toBe('storage-failure');
    expect(refusalTextFor({ code: 'storage-failure', detail: undefined })).toBe('storage-failure');
    expect(refusalTextFor({ code: 'storage-failure', detail: '   ' })).toBe('storage-failure');
    expect(refusalTextFor({ code: 'storage-failure', actualRevision: '' })).toBe('storage-failure');
    expect(refusalTextFor({ code: 'storage-failure', detail: '', actualRevision: null })).toBe('storage-failure');
  });

  it('never renders a revision without the code it belongs to', () => {
    const text = refusalTextFor({ code: 'stale-revision', actualRevision: 'rev-9' });
    expect(text).toBe('stale-revision (now at revision rev-9)');
  });
});
