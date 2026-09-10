import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { isDiagnosticCode } from '../src/app/diagnostics.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureFiles } from './fixtures.js';

const TASK_PATH = 'Proxima/tasks/Write fixture vault.md';

function taskDocument(frontmatter: string): string {
  return `---\nid: task-fixtures\n${frontmatter}\n---\nbody`;
}

describe('Stage 6 slice 8 frontmatter parse-failure diagnostics', () => {
  it('maps parser failure issue classes to the stable frontmatter-parse-failure diagnostic code', async () => {
    const cases = [
      'status: [broken',
      'name: "unfinished',
      'name: "finished"junk',
      'status: running\nstatus: review',
      'just some prose',
    ];

    for (const frontmatter of cases) {
      const vault = createMemoryVault(fixtureFiles('vault-basic'));
      vault.set(TASK_PATH, taskDocument(frontmatter));

      const loaded = await loadVaultState(vault);
      const problems = loaded.problems.filter(
        (problem) => problem.path === TASK_PATH,
      );

      expect(
        problems.some(
          (problem) =>
            problem.code === 'frontmatter-parse-failure'
            && problem.severity === 'warning'
            && problem.kind === 'task',
        ),
      ).toBe(true);
      expect(
        problems.some(
          (problem) => problem.code === 'unsupported-frontmatter',
        ),
      ).toBe(false);
      expect(
        isDiagnosticCode('frontmatter-parse-failure'),
      ).toBe(true);
      expect(
        loaded.state.tasks.some((task) => task.id === 'task-fixtures'),
      ).toBe(true);
    }
  });

  it('keeps recognized unsupported YAML constructs under unsupported-frontmatter rather than relabeling them as parse failures', async () => {
    const vault = createMemoryVault(fixtureFiles('vault-basic'));
    vault.set(
      TASK_PATH,
      taskDocument(
        [
          'name: Kept',
          'meta:',
          '  owner: ana',
        ].join('\n'),
      ),
    );

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
        (problem) => problem.code === 'frontmatter-parse-failure',
      ),
    ).toBe(false);
    expect(
      loaded.state.tasks.find(
        (task) => task.id === 'task-fixtures',
      )?.name,
    ).toBe('Kept');
  });

  it('keeps the last accepted generation on parse failure and recovers through the existing refresh path after repair', async () => {
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
      taskDocument('status: [broken'),
    );

    const degraded = await controller.refreshSource(
      'external-signal',
    );

    expect(degraded).toMatchObject({
      ok: false,
      outcome: 'malformed',
      changed: false,
      snapshot: {
        stale: true,
        refreshState: 'degraded',
        lastRefreshProblemCode: 'frontmatter-parse-failure',
      },
    });
    expect(JSON.stringify(degraded.snapshot.load.state))
      .toBe(beforeState);

    vault.set(TASK_PATH, files[TASK_PATH]!);

    const recovered = await controller.refreshSource('manual');

    expect(recovered).toMatchObject({
      ok: true,
      outcome: 'changed',
      changed: true,
      snapshot: {
        stale: false,
        refreshState: 'idle',
        lastRefreshProblemCode: null,
      },
    });
  });
});
