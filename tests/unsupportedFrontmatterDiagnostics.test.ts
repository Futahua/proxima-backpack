import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { isDiagnosticCode } from '../src/app/diagnostics.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureFiles } from './fixtures.js';

const TASK_PATH = 'Proxima/tasks/Write fixture vault.md';

function taskDocument(
  frontmatter: string,
  body = 'body',
): string {
  return `---\nid: task-fixtures\n${frontmatter}\n---\n${body}`;
}

describe('Stage 6 slice 9 unsupported-frontmatter diagnostics', () => {
  it('keeps recognized unsupported constructs distinct, warning-bearing and safely interpreted', async () => {
    const cases = [
      [
        'nested mapping',
        [
          'name: Kept',
          'meta:',
          '  owner: ana',
        ].join('\n'),
      ],
      [
        'flow mapping',
        [
          'name: Kept',
          'meta: { owner: ana }',
        ].join('\n'),
      ],
      [
        'unsupported escape',
        [
          'name: Kept',
          'description: "bad\\q"',
        ].join('\n'),
      ],
    ] as const;

    for (const [, frontmatter] of cases) {
      const vault = createMemoryVault(fixtureFiles('vault-basic'));
      vault.set(TASK_PATH, taskDocument(frontmatter));

      const loaded = await loadVaultState(vault);
      const problems = loaded.problems.filter(
        (problem) => problem.path === TASK_PATH,
      );

      expect(
        problems.some(
          (problem) =>
            problem.code === 'unsupported-frontmatter'
            && problem.severity === 'warning'
            && problem.kind === 'task',
        ),
      ).toBe(true);
      expect(
        problems.some(
          (problem) =>
            problem.code === 'frontmatter-parse-failure',
        ),
      ).toBe(false);
      expect(isDiagnosticCode('unsupported-frontmatter'))
        .toBe(true);
      expect(
        loaded.state.tasks.find(
          (task) => task.id === 'task-fixtures',
        )?.name,
      ).toBe('Kept');
    }
  });

  it('accepts a refreshed generation containing unsupported frontmatter while retaining its structured warning', async () => {
    const files = fixtureFiles('vault-basic');
    const vault = createMemoryVault(files);
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({
      vault,
      initial,
    });

    vault.set(
      TASK_PATH,
      taskDocument(
        [
          'name: Refresh accepted',
          'status: review',
          'meta:',
          '  owner: ana',
        ].join('\n'),
        'refreshed body',
      ),
    );

    const refreshed = await controller.refreshSource(
      'external-signal',
    );

    expect(refreshed).toMatchObject({
      ok: true,
      outcome: 'changed',
      changed: true,
      snapshot: {
        sourceRevision: 2,
        lastSuccessfulRefreshRevision: 2,
        stale: false,
        refreshState: 'idle',
        lastRefreshProblemCode: null,
      },
    });

    const acceptedTask = refreshed.snapshot.load.state.tasks.find(
      (task) => task.id === 'task-fixtures',
    );
    expect(acceptedTask).toMatchObject({
      name: 'Refresh accepted',
      status: 'review',
      description: 'refreshed body',
    });

    expect(
      refreshed.snapshot.load.problems.some(
        (problem) =>
          problem.path === TASK_PATH
          && problem.code === 'unsupported-frontmatter'
          && problem.severity === 'warning',
      ),
    ).toBe(true);

    const projection = createReadOnlyProjection(
      refreshed.snapshot,
    );
    expect(projection.health.problemCodes)
      .toContain('unsupported-frontmatter');
  });

  it('still rejects a refreshed generation when a real parse failure is present, even alongside unsupported frontmatter', async () => {
    const files = fixtureFiles('vault-basic');
    const vault = createMemoryVault(files);
    const initial = await loadVaultState(vault);
    const beforeState = JSON.stringify(initial.state);
    const controller = createRefreshController({
      vault,
      initial,
    });

    vault.set(
      TASK_PATH,
      taskDocument(
        [
          'meta:',
          '  owner: ana',
          'status: [broken',
        ].join('\n'),
      ),
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
        lastRefreshProblemCode: 'frontmatter-parse-failure',
      },
    });

    expect(JSON.stringify(degraded.snapshot.load.state))
      .toBe(beforeState);
  });
});
