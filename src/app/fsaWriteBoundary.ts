/**
 * Native File System Access does not expose a compare-and-swap commit primitive.
 * A caller can reread a handle and then createWritable(), but another process may
 * replace the file between that check and close().  Shared creator-vault writes
 * therefore remain disabled unless Papers supplies a stronger host capability.
 */
export const FSA_WRITE_BOUNDARY_SCHEMA_VERSION = 1 as const;

export interface FsaWriteBoundaryReport {
  schemaVersion: typeof FSA_WRITE_BOUNDARY_SCHEMA_VERSION;
  status: 'BLOCKED';
  expectedRevisionCheck: 'non-atomic';
  racePolicy: 'unacceptable';
  externalWritesProtected: false;
  writerEnabled: false;
  reason: 'fsa-no-compare-and-swap';
}

export function evaluateFsaWriteBoundary(): FsaWriteBoundaryReport {
  return {
    schemaVersion: FSA_WRITE_BOUNDARY_SCHEMA_VERSION,
    status: 'BLOCKED',
    expectedRevisionCheck: 'non-atomic',
    racePolicy: 'unacceptable',
    externalWritesProtected: false,
    writerEnabled: false,
    reason: 'fsa-no-compare-and-swap',
  };
}

export function isFsaWriteBoundaryReport(value: unknown): value is FsaWriteBoundaryReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Partial<FsaWriteBoundaryReport>;
  return report.schemaVersion === FSA_WRITE_BOUNDARY_SCHEMA_VERSION
    && report.status === 'BLOCKED'
    && report.expectedRevisionCheck === 'non-atomic'
    && report.racePolicy === 'unacceptable'
    && report.externalWritesProtected === false
    && report.writerEnabled === false
    && report.reason === 'fsa-no-compare-and-swap';
}
