import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { isDiagnosticCode } from '../src/app/diagnostics.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import type {
  DirectoryPresence,
  VaultReader,
} from '../src/ports/vault.js';
import { fixtureFiles } from './fixtures.js';

const TASK_PATH = 'Proxima/tasks/Write fixture vault.md';
const TASK_DIRECTORY = 'Proxima/tasks';

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

interface FailureSwitches {
  readPath: string | null;
  walkDirectory: string | null;
  walkPresence: DirectoryPresence | null;
}

function failingReader(
  base: VaultReader,
  failures: FailureSwitches,
): VaultReader {
  return {
    list: (directory) => base.list(directory),
    exists: (path) => base.exists(path),
    read: async (path, maxChars) => {
      if (path === failures.readPath) {
        throw new Error('repository read failed by test fixture');
      }
      return await base.read(path, maxChars);
    },
    walk: async (directory) => {
      if (directory === failures.walkDirectory) {
        throw new Error('repository traversal failed by test fixture');
      }
      return await base.walk(directory);
    },
    presence: async (directory) => {
      if (
        directory === failures.walkDirectory
        && failures.walkPresence !== null
      ) {
        return failures.walkPresence;
      }
      return base.presence
        ? await base.presence(directory)
        : 'unknown';
    },
  };
}

describe('Stage 6 slice 14 filesystem/repository failure diagnostics', () => {
  it('reports an unreadable candidate structurally and accounts for the rejected record without silently dropping it', async () => {
    const base = createMemoryVault(fixtureFiles('vault-basic'));
    const failures: FailureSwitches = {
      readPath: TASK_PATH,
      walkDirectory: null,
      walkPresence: null,
    };
    const loaded = await loadVaultState(
      failingReader(base, failures),
    );

    expect(isDiagnosticCode('unreadable')).toBe(true);

    const unreadable = loaded.problems.filter(
      (problem) => problem.code === 'unreadable',
    );
    expect(unreadable).toEqual([
      expect.objectContaining({
        code: 'unreadable',
        severity: 'error',
        path: TASK_PATH,
        kind: 'task',
      }),
    ]);

    expect(
      loaded.state.tasks.some(
        (task) => task.source.path === TASK_PATH,
      ),
    ).toBe(false);

    expect(loaded.census.task.explicitlyRejected)
      .toBeGreaterThanOrEqual(1);
    expect(loaded.census.task.unaccountedCandidates).toBe(0);
    expect(
      loaded.census.task.loadedRecords
        + loaded.census.task.explicitlyRejected,
    ).toBe(loaded.census.task.recordCandidates);
  });

  it('distinguishes an unreadable existing directory from a proven-absent directory instead of guessing from traversal failure', async () => {
    const base = createMemoryVault(fixtureFiles('vault-basic'));

    const failed = await loadVaultState(
      failingReader(base, {
        readPath: null,
        walkDirectory: TASK_DIRECTORY,
        walkPresence: 'present',
      }),
    );

    expect(
      failed.problems.filter(
        (problem) =>
          problem.code === 'directory-unreadable'
          && problem.kind === 'task',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'directory-unreadable',
        severity: 'error',
        path: TASK_DIRECTORY,
        kind: 'task',
      }),
    ]);
    expect(failed.census.task).toEqual({
      status: 'failed',
      scannedFiles: 0,
      recordCandidates: 0,
      loadedRecords: 0,
      explicitlyRejected: 0,
      unaccountedCandidates: 0,
    });

    const absent = await loadVaultState(
      failingReader(base, {
        readPath: null,
        walkDirectory: TASK_DIRECTORY,
        walkPresence: 'missing',
      }),
    );

    expect(
      absent.problems.filter(
        (problem) =>
          problem.code === 'directory-unreadable'
          && problem.kind === 'task',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'directory-unreadable',
        severity: 'warning',
        path: TASK_DIRECTORY,
        kind: 'task',
      }),
    ]);
    expect(absent.census.task).toEqual({
      status: 'absent',
      scannedFiles: 0,
      recordCandidates: 0,
      loadedRecords: 0,
      explicitlyRejected: 0,
      unaccountedCandidates: 0,
    });
  });

  it('preserves filesystem/repository failure codes through read-only projection and headless inspection', async () => {
    const base = createMemoryVault(fixtureFiles('vault-basic'));
    const loaded = await loadVaultState(
      failingReader(base, {
        readPath: TASK_PATH,
        walkDirectory: null,
        walkPresence: null,
      }),
    );

    const controller = createRefreshController({
      vault: base,
      initial: loaded,
    });
    const projection = createReadOnlyProjection(
      controller.snapshot(),
    );

    expect(projection.health.problemCodes)
      .toContain('unreadable');
    expect(
      projection.problems.some(
        (problem) =>
          problem.code === 'unreadable'
          && problem.path === TASK_PATH,
      ),
    ).toBe(true);

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
      .toContain('unreadable');
    expect(
      inspection.loadProblems.some(
        (problem) =>
          problem.code === 'unreadable'
          && problem.path === TASK_PATH,
      ),
    ).toBe(true);
    expect(inspection.degraded).toEqual({
      state: 'degraded',
      blockingProblemCount: 1,
    });
  });

  it('retains the last accepted generation on repository failure and recovers through the same read path after the failure clears', async () => {
    const base = createMemoryVault(fixtureFiles('vault-basic'));
    const initial = await loadVaultState(base);
    const beforeState = JSON.stringify(initial.state);
    const failures: FailureSwitches = {
      readPath: TASK_PATH,
      walkDirectory: null,
      walkPresence: null,
    };

    const controller = createRefreshController({
      vault: failingReader(base, failures),
      initial,
    });

    const degraded = await controller.refreshSource(
      'external-signal',
    );

    expect(degraded).toMatchObject({
      ok: false,
      outcome: 'unreadable',
      changed: false,
      snapshot: {
        sourceRevision: 1,
        lastSuccessfulRefreshRevision: 1,
        stale: true,
        refreshState: 'degraded',
        lastRefreshProblemCode: 'unreadable',
      },
    });
    expect(JSON.stringify(degraded.snapshot.load.state))
      .toBe(beforeState);

    const degradedProjection = createReadOnlyProjection(
      degraded.snapshot,
    );
    expect(degradedProjection.health.problemCodes)
      .toContain('unreadable');

    failures.readPath = null;

    const recovered = await controller.refreshSource('manual');

    expect(recovered).toMatchObject({
      ok: true,
      outcome: 'unchanged',
      changed: false,
      snapshot: {
        sourceRevision: 1,
        lastSuccessfulRefreshRevision: 1,
        stale: false,
        refreshState: 'idle',
        lastRefreshProblemCode: null,
      },
    });
    expect(JSON.stringify(recovered.snapshot.load.state))
      .toBe(beforeState);
    expect((await base.read(TASK_PATH)).text)
      .toContain('Write fixture vault');
  });
});
