import { describe, expect, it } from 'vitest';
import { evaluateRealVaultRunbook, isRealVaultRunbookReport } from '../src/app/realVaultRunbook.js';
import type { RealVaultAcceptanceReport } from '../src/app/realVaultAcceptance.js';

function report(overrides: Partial<RealVaultAcceptanceReport> = {}): RealVaultAcceptanceReport {
  const stages = { baselineRead: { verdict: 'PASS' as const, failureCodes: [] }, externalEdit: { verdict: 'OPEN' as const, failureCodes: [] }, renameDelete: { verdict: 'OPEN' as const, failureCodes: [] }, obsidianCoexistence: { verdict: 'OPEN' as const, failureCodes: [] }, writeInvariant: { verdict: 'PASS' as const, failureCodes: [] }, overall: { verdict: 'OPEN' as const, failureCodes: [] } };
  return { schemaVersion: 1, build: { proximaVersion: '0.1.0', gitSha: 'sha', buildMode: 'fixture', domainSchemaVersion: '1', controlSchemaVersion: '0', fixtureSchemaVersion: '1', fixtureHash: 'fixture', lockfileHash: 'lock', fixedClock: '2026-09-06T12:00:00.000Z' }, sourceMode: 'external', restoredHandlePresent: true, bootstrapStatus: 'ready', transitionState: 'stable', sourceGeneration: 1, counts: { projects: 1, tasks: 1, events: 1 }, sourceRevisions: [{ path: 'Proxima/projects/p.md', revision: 'r' }], provenanceSamples: [{ kind: 'project', logicalId: 'p', relativeSourcePath: 'Proxima/projects/p.md', sourceRevision: 'r', idOrigin: 'declared' }], health: { status: 'healthy', stale: false, degraded: false, lastSuccessfulRefreshRevision: 1, lastRefreshReason: null, problemCodes: [] }, refreshEvidence: null, externalChangeEvidence: null, renameDeleteEvidence: null, writeInvariant: { writesAttempted: 0, writerMethodsCalled: [] }, stages, passed: false, ...overrides };
}

describe('Gate 6L real-vault runbook guard', () => {
  it('blocks fixture or wrong-build preflight and keeps the native boundary explicit', () => {
    const guarded = evaluateRealVaultRunbook({ report: report({ sourceMode: 'fixture' }), expectedBuildSha: 'other' });
    expect(guarded.status).toBe('BLOCKED');
    expect(guarded.abortCodes).toEqual(expect.arrayContaining(['external-source', 'build-identity']));
    expect(guarded.nativeBoundary).toBe('select-and-grant');
  });

  it('readies a healthy granted baseline without inferring optional stages', () => {
    const guarded = evaluateRealVaultRunbook({ report: report(), expectedBuildSha: 'sha', expectedRoot: 'Proxima' });
    expect(guarded.status).toBe('READY');
    expect(guarded.ready).toBe(true);
    expect(guarded.evidencePlan.find((stage) => stage.stage === 'externalEdit')).toMatchObject({ required: true, verdict: 'OPEN' });
    expect(guarded.evidencePlan.find((stage) => stage.stage === 'obsidianCoexistence')).toMatchObject({ required: false, verdict: 'OPEN' });
    expect(guarded.nativeBoundary).toBe('none');
    expect(isRealVaultRunbookReport(guarded)).toBe(true);
  });

  it('aborts immediately on a write invariant violation and does not echo authority', () => {
    const guarded = evaluateRealVaultRunbook({ report: report({ writeInvariant: { writesAttempted: 1, writerMethodsCalled: ['writeIfUnchanged'] }, stages: { ...report().stages, writeInvariant: { verdict: 'FAIL', failureCodes: ['write-authority'] } } }) });
    expect(guarded.status).toBe('ABORTED');
    expect(guarded.abortCodes).toContain('zero-write');
    expect(guarded.zeroWrite.writerMethodsCalled).toEqual(['writeIfUnchanged']);
  });
});
