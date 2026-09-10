import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { isDiagnosticCode } from '../src/app/diagnostics.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

const FIRST_PATH = 'Proxima/tasks/a.md';
const SECOND_PATH = 'Proxima/tasks/b.md';
const SHARED_ID = 'shared-task';

const BUILD = {
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

function task(
  name: string,
): string {
  return `---\nid: ${SHARED_ID}\nname: ${name}\nstatus: running\n---\n`;
}

function duplicateVault() {
  return createMemoryVault({
    [FIRST_PATH]: task('First claimant'),
    [SECOND_PATH]: task('Second claimant'),
  });
}

describe('Stage 6 slice 10 duplicate-ID diagnostics', () => {
  it('emits one structured duplicate-id error, rejects the later claimant and accounts for it in the census', async () => {
    const loaded = await loadVaultState(duplicateVault());

    expect(isDiagnosticCode('duplicate-id')).toBe(true);

    expect(loaded.state.tasks).toHaveLength(1);
    expect(loaded.state.tasks[0]).toMatchObject({
      id: SHARED_ID,
      name: 'First claimant',
      source: {
        path: FIRST_PATH,
      },
    });

    const duplicates = loaded.problems.filter(
      (problem) => problem.code === 'duplicate-id',
    );

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      code: 'duplicate-id',
      severity: 'error',
      kind: 'task',
      id: SHARED_ID,
      path: SECOND_PATH,
    });

    expect(loaded.census.task).toMatchObject({
      status: 'complete',
      recordCandidates: 2,
      loadedRecords: 1,
      explicitlyRejected: 1,
      unaccountedCandidates: 0,
    });
  });

  it('chooses the same claimant and reports the same collision on repeated reads', async () => {
    const vault = duplicateVault();

    const first = await loadVaultState(vault);
    const second = await loadVaultState(vault);
    const third = await loadVaultState(vault);

    const winnerPaths = [first, second, third].map(
      (loaded) => loaded.state.tasks[0]?.source.path,
    );
    expect(winnerPaths).toEqual([
      FIRST_PATH,
      FIRST_PATH,
      FIRST_PATH,
    ]);

    const collisionShapes = [first, second, third].map(
      (loaded) =>
        loaded.problems
          .filter((problem) => problem.code === 'duplicate-id')
          .map((problem) => ({
            code: problem.code,
            severity: problem.severity,
            kind: problem.kind,
            id: problem.id,
            path: problem.path,
          })),
    );

    expect(collisionShapes[1]).toEqual(collisionShapes[0]);
    expect(collisionShapes[2]).toEqual(collisionShapes[0]);

    expect((await vault.read(FIRST_PATH)).text)
      .toBe(task('First claimant'));
    expect((await vault.read(SECOND_PATH)).text)
      .toBe(task('Second claimant'));
  });

  it('keeps duplicate-id machine-readable through read-only projection and headless inspection', async () => {
    const vault = duplicateVault();
    const loaded = await loadVaultState(vault);
    const controller = createRefreshController({
      vault,
      initial: loaded,
    });

    const projection = createReadOnlyProjection(
      controller.snapshot(),
    );

    expect(projection.health.problemCodes)
      .toContain('duplicate-id');
    expect(
      projection.problems.filter(
        (problem) => problem.code === 'duplicate-id',
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        kind: 'task',
        id: SHARED_ID,
        path: SECOND_PATH,
      }),
    ]);

    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
    });

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );

    expect(inspection.sourceHealth.problemCodes)
      .toContain('duplicate-id');
    expect(
      inspection.loadProblems.filter(
        (problem) => problem.code === 'duplicate-id',
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        id: SHARED_ID,
        path: SECOND_PATH,
      }),
    ]);
    expect(inspection.degraded).toEqual({
      state: 'degraded',
      blockingProblemCount: 1,
    });
  });

  it('rejects a newly introduced duplicate generation on refresh and retains the last accepted state', async () => {
    const vault = createMemoryVault({
      [FIRST_PATH]: task('Accepted claimant'),
    });
    const initial = await loadVaultState(vault);
    const beforeState = JSON.stringify(initial.state);
    const controller = createRefreshController({
      vault,
      initial,
    });

    vault.set(
      SECOND_PATH,
      task('Conflicting claimant'),
    );

    const degraded = await controller.refreshSource(
      'external-signal',
    );

    expect(degraded).toMatchObject({
      ok: false,
      outcome: 'malformed',
      changed: false,
      snapshot: {
        sourceRevision: 1,
        lastSuccessfulRefreshRevision: 1,
        stale: true,
        refreshState: 'degraded',
        lastRefreshProblemCode: 'duplicate-id',
      },
    });

    expect(JSON.stringify(degraded.snapshot.load.state))
      .toBe(beforeState);
    expect(
      degraded.snapshot.load.state.tasks.map(
        (candidate) => candidate.name,
      ),
    ).toEqual(['Accepted claimant']);

    const projection = createReadOnlyProjection(
      degraded.snapshot,
    );
    expect(projection.health.problemCodes)
      .toContain('duplicate-id');

    expect((await vault.read(FIRST_PATH)).text)
      .toBe(task('Accepted claimant'));
    expect((await vault.read(SECOND_PATH)).text)
      .toBe(task('Conflicting claimant'));
  });
});
