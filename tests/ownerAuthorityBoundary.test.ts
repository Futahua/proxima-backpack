import { describe, expect, it } from 'vitest';
import { evaluateOwnerAuthorityBoundary, isOwnerAuthorityBoundaryReport } from '../src/app/ownerAuthorityBoundary.js';

describe('Gate 14 owner authority boundary', () => {
  it('reports the current read-only, exact-root-scoped boundary deterministically', () => {
    const report = evaluateOwnerAuthorityBoundary();
    expect(report).toEqual({
      schemaVersion: 1,
      status: 'BLOCKED',
      authority: 'read-only',
      scope: 'exact-root-required',
      startupRestore: 'read-only-only',
      writeAuthority: 'disabled',
      reason: 'native-fsa-grant-and-transaction-required',
    });
    expect(isOwnerAuthorityBoundaryReport(report)).toBe(true);
  });

  it('rejects a report that upgrades authority or enables writes', () => {
    expect(isOwnerAuthorityBoundaryReport({ ...evaluateOwnerAuthorityBoundary(), authority: 'read-write' })).toBe(false);
    expect(isOwnerAuthorityBoundaryReport({ ...evaluateOwnerAuthorityBoundary(), writeAuthority: 'enabled' })).toBe(false);
  });
});
