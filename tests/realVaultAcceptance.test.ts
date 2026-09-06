import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { evaluateRealVaultAcceptance, isRealVaultAcceptanceReport, type RealVaultAcceptanceInput } from '../src/app/realVaultAcceptance.js';
import { createUiHealthModel } from '../src/app/uiHealth.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

const build = { proximaVersion: '0.1.0', gitSha: 'sha', buildMode: 'fixture', domainSchemaVersion: '1', controlSchemaVersion: '0', fixtureSchemaVersion: '1', fixtureHash: 'hash', lockfileHash: 'lock', fixedClock: '2026-09-06T12:00:00.000Z' };

async function healthyInput(): Promise<RealVaultAcceptanceInput> {
  const reader = fixtureVault('vault-basic');
  const loaded = await loadVaultState(reader);
  const controller = createRefreshController({ vault: reader, initial: loaded });
  const projection = createReadOnlyProjection(controller.snapshot());
  const dispatcher = createActionDispatcher({ state: projection.state, problems: projection.problems, revisions: projection.revisions, mode: 'live', initialSourceRevision: projection.generation });
  const inspection = createInspectionProjection(dispatcher.snapshot(), build, projection.health);
  return {
    build,
    startup: { startupSourceMode: 'external', restoredHandlePresent: true, bootstrapStatus: 'ready' },
    session: { sourceMode: 'external', sourceGeneration: projection.generation, transitionState: 'stable' },
    projection: { generation: projection.generation, state: projection.state, health: projection.health, revisions: projection.revisions, problems: projection.problems },
    inspection,
    refreshEvidence: { outcome: 'changed', changed: true, previousGeneration: 1, currentGeneration: 2, beforeRevision: 'old:1', afterRevision: 'new:2', beforeMarker: 'before', afterMarker: 'after' },
    renameDeleteEvidence: { outcome: 'renamed', removedPath: 'Proxima/tasks/old.md', addedPath: 'Proxima/tasks/new.md' },
    writeInvariant: { writesAttempted: 0, writerMethodsCalled: [] },
  };
}

describe('Gate 6J real-vault readiness evaluator', () => {
  it('passes a healthy external baseline with staged edit/rename/write evidence and leaves Obsidian OPEN', async () => {
    const report = evaluateRealVaultAcceptance(await healthyInput());
    expect(report).toMatchObject({ schemaVersion: 1, sourceMode: 'external', passed: true, stages: { baselineRead: { verdict: 'PASS' }, externalEdit: { verdict: 'PASS' }, renameDelete: { verdict: 'PASS' }, obsidianCoexistence: { verdict: 'OPEN' }, writeInvariant: { verdict: 'PASS' }, overall: { verdict: 'PASS' } } });
    expect(report.provenanceSamples.map((sample) => sample.kind).sort()).toEqual(['event', 'project', 'task']);
    expect(report.externalChangeEvidence).toEqual({ beforeMarker: 'before', afterMarker: 'after' });
    expect(report.renameDeleteEvidence).toMatchObject({ outcome: 'renamed', removedPath: 'Proxima/tasks/old.md', addedPath: 'Proxima/tasks/new.md' });
    expect(isRealVaultAcceptanceReport(report)).toBe(true);
  });

  it('keeps overall readiness OPEN until optional external stages have evidence', async () => {
    const input = await healthyInput();
    input.refreshEvidence = undefined;
    input.renameDeleteEvidence = undefined;
    const report = evaluateRealVaultAcceptance(input);
    expect(report.stages.externalEdit.verdict).toBe('OPEN');
    expect(report.stages.renameDelete.verdict).toBe('OPEN');
    expect(report.stages.overall.verdict).toBe('OPEN');
    expect(report.passed).toBe(false);
  });

  it('rejects fixture, stale, mixed-generation, missing provenance, and write-authority baselines', async () => {
    const input = await healthyInput();
    input.startup.startupSourceMode = 'fixture';
    input.session.sourceMode = 'fixture';
    input.projection.health = { ...input.projection.health, stale: true, degraded: true };
    input.inspection.sourceHealth = createUiHealthModel(input.projection.health);
    input.session.sourceGeneration = 9;
    input.projection.generation = 8;
    input.writeInvariant = { writesAttempted: 1, writerMethodsCalled: ['writeIfUnchanged'] };
    const report = evaluateRealVaultAcceptance(input);
    expect(report.passed).toBe(false);
    expect(report.stages.baselineRead.failureCodes).toEqual(expect.arrayContaining(['wrong-source-mode', 'degraded-baseline', 'mixed-generation']));
    expect(report.stages.writeInvariant).toMatchObject({ verdict: 'FAIL', failureCodes: ['write-authority'] });
  });

  it('keeps missing edit evidence OPEN, rejects unchanged claims, and sanitizes absolute paths without echo', async () => {
    const absent = await healthyInput();
    absent.refreshEvidence = undefined;
    absent.renameDeleteEvidence = undefined;
    const open = evaluateRealVaultAcceptance(absent);
    expect(open.stages.externalEdit.verdict).toBe('OPEN');
    expect(open.stages.renameDelete.verdict).toBe('OPEN');
    const bad = await healthyInput();
    bad.refreshEvidence = { outcome: 'changed', changed: true, previousGeneration: 2, currentGeneration: 2, beforeRevision: 'same', afterRevision: 'same', beforeMarker: 'same', afterMarker: 'same' };
    bad.renameDeleteEvidence = { outcome: 'renamed', removedPath: 'C:/secret/old.md', addedPath: '/secret/new.md' };
    bad.projection.revisions = { 'C:/secret/leak.md': 'r' };
    const report = evaluateRealVaultAcceptance(bad);
    expect(report.stages.externalEdit).toMatchObject({ verdict: 'FAIL', failureCodes: expect.arrayContaining(['missing-external-edit', 'missing-revision-change']) });
    expect(report.stages.renameDelete.failureCodes).toContain('absolute-path');
    expect(JSON.stringify(report)).not.toContain('C:/secret');
    expect(JSON.stringify(report)).not.toContain('/secret');
    expect(JSON.stringify(report).length).toBeLessThan(100_000);
  });
});
