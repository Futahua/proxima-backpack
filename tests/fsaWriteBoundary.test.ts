import { describe, expect, it } from 'vitest';
import { evaluateFsaWriteBoundary, isFsaWriteBoundaryReport } from '../src/app/fsaWriteBoundary.js';

describe('Gate 13.3 native FSA write boundary', () => {
  it('fails closed because FSA has no compare-and-swap commit primitive', () => {
    const report = evaluateFsaWriteBoundary();
    expect(report).toEqual({
      schemaVersion: 1,
      status: 'BLOCKED',
      expectedRevisionCheck: 'non-atomic',
      racePolicy: 'unacceptable',
      externalWritesProtected: false,
      writerEnabled: false,
      reason: 'fsa-no-compare-and-swap',
    });
    expect(isFsaWriteBoundaryReport(report)).toBe(true);
  });

  it('rejects any report that claims native FSA writes are enabled', () => {
    expect(isFsaWriteBoundaryReport({ ...evaluateFsaWriteBoundary(), writerEnabled: true })).toBe(false);
  });
});
