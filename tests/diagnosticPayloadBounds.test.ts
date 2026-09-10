import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import {
  boundDiagnosticProblems,
  DIAGNOSTIC_LIMITS,
} from '../src/app/diagnostics.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { renderWithBoundary } from '../src/browser/renderBoundary.js';
import type { LoadProblem } from '../src/domain/problems.js';
import { fixtureVault } from './fixtures.js';

const build = {
  proximaVersion: '0.1.0',
  gitSha: 'test-sha',
  buildMode: 'fixture',
  domainSchemaVersion: '1',
  controlSchemaVersion: '0',
  fixtureSchemaVersion: '1',
  fixtureHash: 'fixture-hash',
  lockfileHash: 'lock-hash',
  fixedClock: '2026-09-06T12:00:00.000Z',
};

function verboseProblems(): LoadProblem[] {
  return Array.from(
    { length: DIAGNOSTIC_LIMITS.problems + 5 },
    (_, index): LoadProblem => ({
      code: 'unreadable',
      severity: 'error',
      path: `Proxima/${'p'.repeat(400)}-${index}`,
      kind: 'task',
      id: `task-${'i'.repeat(500)}-${index}`,
      detail: `problem-${'d'.repeat(600)}-${index}`,
    }),
  );
}

function expectProblemBounds(
  problems: readonly LoadProblem[],
): void {
  expect(problems.length).toBeLessThanOrEqual(
    DIAGNOSTIC_LIMITS.problems,
  );
  expect(
    problems.every(
      (problem) =>
        problem.path.length <= DIAGNOSTIC_LIMITS.problemPath
        && (problem.id === undefined
          || problem.id.length <= DIAGNOSTIC_LIMITS.problemId)
        && problem.detail.length <= DIAGNOSTIC_LIMITS.problemDetail,
    ),
  ).toBe(true);
}

describe('Stage 6 slice 7 diagnostic payload bounds', () => {
  it('bounds problem count and textual payloads without mutating the source problems', () => {
    const source = verboseProblems();
    const bounded = boundDiagnosticProblems(source);

    expect(bounded).toHaveLength(DIAGNOSTIC_LIMITS.problems);
    expectProblemBounds(bounded);
    expect(bounded[0]).not.toBe(source[0]);
    expect(bounded[0]).toMatchObject({
      code: 'unreadable',
      severity: 'error',
      kind: 'task',
    });

    expect(source).toHaveLength(DIAGNOSTIC_LIMITS.problems + 5);
    expect(source[0]!.path.length)
      .toBeGreaterThan(DIAGNOSTIC_LIMITS.problemPath);
    expect(source[0]!.id!.length)
      .toBeGreaterThan(DIAGNOSTIC_LIMITS.problemId);
    expect(source[0]!.detail.length)
      .toBeGreaterThan(DIAGNOSTIC_LIMITS.problemDetail);
  });

  it('bounds refresh snapshots and the read-only diagnostic projection at the same contract', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({
      vault,
      initial: {
        ...initial,
        problems: verboseProblems(),
      },
    });

    const snapshot = controller.snapshot();
    expect(snapshot.load.problems)
      .toHaveLength(DIAGNOSTIC_LIMITS.problems);
    expectProblemBounds(snapshot.load.problems);

    const projection = createReadOnlyProjection(snapshot);
    expect(projection.problems)
      .toHaveLength(DIAGNOSTIC_LIMITS.problems);
    expectProblemBounds(projection.problems);
    expect(projection.health.problemCodes.length)
      .toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.problemCodes);
    expect(projection.health.problemCodes).toEqual(['unreadable']);
  });

  it('bounds headless inspection diagnostics even when raw dispatcher problems bypass refresh projection', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const rawProblems = verboseProblems();
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: rawProblems,
      revisions: loaded.revisions,
      mode: 'fixture',
    });

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      build,
    );

    expect(inspection.loadProblems)
      .toHaveLength(DIAGNOSTIC_LIMITS.problems);
    expect(
      inspection.loadProblems.every(
        (problem) =>
          (problem.path === undefined
            || problem.path.length <= DIAGNOSTIC_LIMITS.problemPath)
          && (problem.id === undefined
            || problem.id.length <= DIAGNOSTIC_LIMITS.problemId)
          && problem.detail.length <= DIAGNOSTIC_LIMITS.problemDetail,
      ),
    ).toBe(true);
    expect(inspection.sourceHealth.problemCodes.length)
      .toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.problemCodes);

    expect(inspection.degraded.blockingProblemCount)
      .toBe(rawProblems.length);
    expect(dispatcher.snapshot().problems)
      .toHaveLength(rawProblems.length);
  });

  it('binds renderer diagnostic detail to the shared renderer payload limit', () => {
    const result = renderWithBoundary(() => {
      throw new Error('r'.repeat(1_000));
    });

    expect(result.failure).toMatchObject({
      code: 'renderer-failure',
    });
    expect(result.failure?.detail)
      .toHaveLength(DIAGNOSTIC_LIMITS.rendererDetail);
    expect(result.markup).toContain(
      'data-c1-key="renderer-failure"',
    );
  });
});
