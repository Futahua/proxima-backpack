import { describe, expect, it } from 'vitest';
import { blocksBaseline } from '../src/domain/problems.js';
import { evaluateRealVaultAcceptance } from '../src/app/realVaultAcceptance.js';
import type { ProximaState } from '../src/domain/types.js';

/**
 * Gate 6P.1 — severity-aware baseline semantics.
 *
 * The acceptance evaluator used to fail a baseline whenever any problem existed.
 * A creator vault of any size carries at least one benign warning, so a real
 * baseline was close to unreachable and would have rejected a healthy vault for
 * something that is not a defect.
 *
 * The rule is now: a known warning is visible and non-blocking; an error, or a
 * problem whose severity cannot be classified, blocks. No numeric allowance and no
 * caller-supplied tolerance — either would let unknown problem classes be blessed
 * into a pass.
 */

const BUILD = {
  proximaVersion: '0.1.0',
  gitSha: 'sha',
  buildMode: 'fixture',
  domainSchemaVersion: '1',
  controlSchemaVersion: '0',
  fixtureSchemaVersion: '1',
  fixtureHash: 'fixture',
  lockfileHash: 'lock',
  fixedClock: '2026-09-06T12:00:00.000Z',
};

const STATE: ProximaState = {
  projects: [{ id: 'p', name: 'P', description: '', createdAt: '2026-09-01T00:00:00.000Z', status: 'active', projectType: 'task', linkedFolders: [], source: { path: 'Proxima/projects/p.md', revision: 'r', kind: 'project', idOrigin: 'frontmatter' } }] as ProximaState['projects'],
  tasks: [],
  events: [],
  statuses: [],
  taskSchema: [],
};

function evaluate(problems: Array<{ code: string; path: string; detail: string; severity?: string }>) {
  const health = { sourceRevision: 1, applicationRevision: 1, stale: false, degraded: false, status: 'healthy' as const, lastSuccessfulRefreshRevision: 1, lastRefreshReason: null, lastRefreshProblemCode: null, pendingRefreshCount: 0, problemCodes: [] };
  return evaluateRealVaultAcceptance({
    build: BUILD,
    startup: { startupSourceMode: 'external', restoredHandlePresent: true, bootstrapStatus: 'ready' },
    session: { sourceMode: 'external', sourceGeneration: 1, transitionState: 'stable' },
    projection: { generation: 1, state: STATE, health, revisions: { 'Proxima/projects/p.md': 'r' }, problems },
    inspection: { sourceHealth: { ...health }, applicationStateRevision: 1 } as never,
    writeInvariant: { writesAttempted: 0, writerMethodsCalled: [] },
  } as never);
}

const warning = { code: 'unexpected-type', path: 'Proxima/notes/x.md', detail: 'stray type', severity: 'warning' };
const error = { code: 'duplicate-id', path: 'Proxima/tasks/a.md', detail: 'two records claim one id', severity: 'error' };
const unclassified = { code: 'mystery', path: 'Proxima/tasks/b.md', detail: 'no severity given' };

describe('blocksBaseline', () => {
  it('lets a known warning through and blocks everything else', () => {
    expect(blocksBaseline({ severity: 'warning' })).toBe(false);
    expect(blocksBaseline({ severity: 'error' })).toBe(true);
  });

  it('fails closed on a severity it cannot classify', () => {
    // A severity added elsewhere later must not become silently non-blocking here.
    expect(blocksBaseline({})).toBe(true);
    expect(blocksBaseline({ severity: undefined })).toBe(true);
    expect(blocksBaseline({ severity: 'notice' })).toBe(true);
    expect(blocksBaseline({ severity: 'WARNING' })).toBe(true);
  });
});

describe('severity-aware baseline', () => {
  it('passes with warnings only, and reports them as evidence', () => {
    const report = evaluate([warning, { ...warning, path: 'Proxima/notes/y.md' }]);
    expect(report.stages.baselineRead.verdict).toBe('PASS');
    expect(report.baselineWarnings.count).toBe(2);
    expect(report.baselineWarnings.codes).toEqual(['unexpected-type']);
  });

  it('fails on a single error', () => {
    const report = evaluate([error]);
    expect(report.stages.baselineRead.verdict).toBe('FAIL');
    expect(report.stages.baselineRead.failureCodes).toContain('baseline-problems');
  });

  it('fails when an error accompanies warnings, and still reports the warnings', () => {
    const report = evaluate([warning, error]);
    expect(report.stages.baselineRead.verdict).toBe('FAIL');
    expect(report.baselineWarnings.count).toBe(1);
  });

  it('fails on an unclassified problem rather than treating it as benign', () => {
    expect(evaluate([unclassified]).stages.baselineRead.verdict).toBe('FAIL');
  });

  it('passes cleanly with no problems at all', () => {
    const report = evaluate([]);
    expect(report.stages.baselineRead.verdict).toBe('PASS');
    expect(report.baselineWarnings).toEqual({ count: 0, codes: [] });
  });

  it('bounds the reported warning codes', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ ...warning, code: `warn-${index}`, path: `Proxima/notes/${index}.md` }));
    const report = evaluate(many);
    expect(report.stages.baselineRead.verdict).toBe('PASS');
    expect(report.baselineWarnings.count).toBe(200);
    expect(report.baselineWarnings.codes.length).toBeLessThanOrEqual(20);
  });

  it('leaves the other stages open rather than quietly passing them', () => {
    const report = evaluate([warning]);
    expect(report.stages.externalEdit.verdict).toBe('OPEN');
    expect(report.stages.renameDelete.verdict).toBe('OPEN');
    expect(report.stages.obsidianCoexistence.verdict).toBe('OPEN');
    expect(report.passed).toBe(false);
  });
});
