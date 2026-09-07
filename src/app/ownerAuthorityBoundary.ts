/**
 * Current owner-mode authority is deliberately read-only.  A browser/FSA handle
 * can be restored and queried for read permission, but this build has no native
 * transaction capability that would make creator-vault writes safe (13.3).
 */
export const OWNER_AUTHORITY_BOUNDARY_SCHEMA_VERSION = 1 as const;

export interface OwnerAuthorityBoundaryReport {
  schemaVersion: typeof OWNER_AUTHORITY_BOUNDARY_SCHEMA_VERSION;
  status: 'BLOCKED';
  authority: 'read-only';
  scope: 'exact-root-required';
  startupRestore: 'read-only-only';
  writeAuthority: 'disabled';
  reason: 'native-fsa-grant-and-transaction-required';
}

export function evaluateOwnerAuthorityBoundary(): OwnerAuthorityBoundaryReport {
  return {
    schemaVersion: OWNER_AUTHORITY_BOUNDARY_SCHEMA_VERSION,
    status: 'BLOCKED',
    authority: 'read-only',
    scope: 'exact-root-required',
    startupRestore: 'read-only-only',
    writeAuthority: 'disabled',
    reason: 'native-fsa-grant-and-transaction-required',
  };
}

export function isOwnerAuthorityBoundaryReport(value: unknown): value is OwnerAuthorityBoundaryReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Partial<OwnerAuthorityBoundaryReport>;
  return report.schemaVersion === OWNER_AUTHORITY_BOUNDARY_SCHEMA_VERSION
    && report.status === 'BLOCKED'
    && report.authority === 'read-only'
    && report.scope === 'exact-root-required'
    && report.startupRestore === 'read-only-only'
    && report.writeAuthority === 'disabled'
    && report.reason === 'native-fsa-grant-and-transaction-required';
}
