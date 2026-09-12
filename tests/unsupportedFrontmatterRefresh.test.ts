/**
 * D65's refresh half, proven rather than assumed.
 *
 * The project ledger recorded an asymmetry as an open question: `vaultRepository` emits
 * `unsupported-frontmatter` at severity `warning` and still loads the record, while the refresh path
 * was said to treat the same code as blocking, so a vault acceptable at startup would be unacceptable
 * on the next refresh. Checking the code while recording the creator's answer (D65: preserve and
 * report, the record *is* importable) suggested the asymmetry is not there: `isBlocking` is
 * severity-only, and the refresh failure predicate adds exactly one code of its own,
 * `frontmatter-parse-failure`.
 *
 * This file is that check as a test. If it passes, the refresh half of D65 needs no code change and the
 * ledger's question is closed by evidence; if it ever fails, the failure is the asymmetry, and the
 * refresh predicate is where the fix goes. The import-planner half of D65 is a separate, real change
 * and is not claimed here.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureFiles } from './fixtures.js';

const TASK_PATH = 'Proxima/tasks/Write fixture vault.md';

function taskDocument(name: string, frontmatter: string): string {
  return `---\nid: task-fixtures\nname: ${name}\n${frontmatter}\n---\nbody`;
}

/** A recognized unsupported construct: a nested mapping the reader cannot represent. */
const UNSUPPORTED = 'meta:\n  owner: ana';

async function refreshWorld(): Promise<{
  vault: ReturnType<typeof createMemoryVault>;
  refresh: ReturnType<typeof createRefreshController>['refreshSource'];
}> {
  const vault = createMemoryVault(fixtureFiles('vault-basic'));
  vault.set(TASK_PATH, taskDocument('Kept', UNSUPPORTED));
  const initial = await loadVaultState(vault);

  // The same warning the startup read produced must be present before anything is refreshed, or the
  // test would be proving something about a vault that never had the construct.
  expect(initial.problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported-frontmatter', severity: 'warning', path: TASK_PATH }),
    ]),
  );

  const controller = createRefreshController({ initial, vault });
  return { vault, refresh: controller.refreshSource.bind(controller) };
}

describe('D65 on the refresh path', () => {
  it('accepts a refreshed generation that still carries the unsupported construct', async () => {
    const { refresh } = await refreshWorld();

    const result = await refresh('manual');

    // The claim: a warning-bearing construct does not demote a refreshed generation. The reader's own
    // severity decides, and it says warning.
    expect(result.outcome).not.toBe('malformed');
    expect(result.ok).toBe(true);
    expect(result.snapshot.stale).toBe(false);
    expect(result.snapshot.lastRefreshProblemCode).toBeNull();
  });

  it('accepts a changed record that keeps the construct, and still reports it', async () => {
    const { vault, refresh } = await refreshWorld();

    // A real change to the same file, keeping the unsupported construct in place.
    vault.set(TASK_PATH, taskDocument('Renamed', UNSUPPORTED));
    const result = await refresh('manual');

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('changed');
    expect(result.changed).toBe(true);
    // The record itself moved, so the refresh is not merely tolerated: the new generation is what the
    // surfaces would draw.
    expect(result.snapshot.load.state.tasks.some((task) => task.name === 'Renamed')).toBe(true);
    // And the construct is still reported rather than swallowed by the acceptance.
    expect(result.snapshot.load.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported-frontmatter', severity: 'warning', path: TASK_PATH }),
      ]),
    );
  });

  it('still refuses a refresh whose frontmatter cannot be parsed at all', async () => {
    const { vault, refresh } = await refreshWorld();

    // The one code the refresh predicate adds by name stays blocking: D65 is about a construct the
    // reader recognized and interpreted, not about a document it could not read.
    vault.set('Proxima/tasks/Broken fixture vault.md', '---\nname: [unclosed\n---\nbody');
    const result = await refresh('manual');

    expect(result.ok).toBe(false);
    expect(['malformed', 'unreadable']).toContain(result.outcome);
  });
});
