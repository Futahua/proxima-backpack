import { describe, expect, it } from 'vitest';
import { evaluateCreatorVaultPreflight, isCreatorVaultPreflightReport, type CreatorVaultPreflightInput } from '../src/app/creatorVaultPreflight.js';
import type { RealVaultAcceptanceReport } from '../src/app/realVaultAcceptance.js';
import type { RealVaultRunbookReport } from '../src/app/realVaultRunbook.js';

function input(overrides: Partial<CreatorVaultPreflightInput> = {}): CreatorVaultPreflightInput {
  const acceptance = { schemaVersion: 1, build: { gitSha: 'sha', proximaVersion: '0.1.0' }, sourceMode: 'external', restoredHandlePresent: true, bootstrapStatus: 'ready', transitionState: 'stable', sourceGeneration: 1, counts: { projects: 1, tasks: 1, events: 1 }, sourceRevisions: [{ path: 'Proxima/projects/p.md', revision: 'r' }], provenanceSamples: [{ kind: 'project', logicalId: 'p', relativeSourcePath: 'Proxima/projects/p.md', sourceRevision: 'r', idOrigin: 'declared' }], health: { status: 'healthy', stale: false, degraded: false, lastSuccessfulRefreshRevision: 1, lastRefreshReason: null, problemCodes: [] }, refreshEvidence: null, externalChangeEvidence: null, renameDeleteEvidence: null, writeInvariant: { writesAttempted: 0, writerMethodsCalled: [] }, stages: { baselineRead: { verdict: 'PASS', failureCodes: [] }, externalEdit: { verdict: 'OPEN', failureCodes: [] }, renameDelete: { verdict: 'OPEN', failureCodes: [] }, obsidianCoexistence: { verdict: 'OPEN', failureCodes: [] }, writeInvariant: { verdict: 'PASS', failureCodes: [] }, overall: { verdict: 'OPEN', failureCodes: [] } }, passed: false } as unknown as RealVaultAcceptanceReport;
  const runbook = { schemaVersion: 1, status: 'READY', ready: true, preconditions: [], evidencePlan: [], abortCodes: [], zeroWrite: { passed: true, writesAttempted: 0, writerMethodsCalled: [] }, nativeBoundary: 'none' } as unknown as RealVaultRunbookReport;
  return { acceptance, runbook, coexistence: { passed: true, zeroWrites: true, sourceBoundsValid: true, hostCapabilityResolved: true }, expectedBuildSha: 'sha', ...overrides };
}

describe('Gate 6N creator-vault final preflight', () => {
  it('returns READY_FOR_NATIVE_GRANT only when all proven prerequisites hold', () => {
    const report = evaluateCreatorVaultPreflight(input());
    expect(report).toMatchObject({ status: 'READY_FOR_NATIVE_GRANT', ready: true, nativeAction: 'select/grant creator vault read-only directory', readOnly: true, zeroWriteInvariant: true, stages: { cleanProfileFsa: 'OPEN', realObsidian: 'OPEN' } });
    expect(report.blockerCodes).toEqual([]);
    expect(isCreatorVaultPreflightReport(report)).toBe(true);
  });

  it('blocks wrong build, non-ready runbook, missing simulation, and unsafe paths without echo', () => {
    const base = input();
    base.acceptance = { ...base.acceptance, sourceRevisions: [{ path: 'C:/secret/vault.md', revision: 'x' }] };
    base.runbook = { ...base.runbook, status: 'BLOCKED' };
    base.coexistence = { ...base.coexistence, passed: false, sourceBoundsValid: false, hostCapabilityResolved: false };
    const report = evaluateCreatorVaultPreflight({ ...base, expectedBuildSha: 'other' });
    expect(report.status).toBe('BLOCKED');
    expect(report.blockerCodes).toEqual(expect.arrayContaining(['build-mismatch', 'runbook-not-ready', 'coexistence-simulation-missing', 'path-safety-failed', 'host-capability-unresolved']));
    expect(JSON.stringify(report)).not.toContain('C:/secret');
  });

  it('aborts on any observed write and remains deterministic', () => {
    const first = input({ acceptance: { ...input().acceptance, writeInvariant: { writesAttempted: 1, writerMethodsCalled: ['writeIfUnchanged'] } }, coexistence: { passed: true, zeroWrites: false, sourceBoundsValid: true, hostCapabilityResolved: true } });
    const a = evaluateCreatorVaultPreflight(first);
    const b = evaluateCreatorVaultPreflight(first);
    expect(a.status).toBe('ABORTED');
    expect(a.blockerCodes).toContain('write-invariant-failed');
    expect(a).toEqual(b);
  });
});
