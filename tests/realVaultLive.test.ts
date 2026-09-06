import { describe, expect, it } from 'vitest';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController, type RefreshResult } from '../src/app/refreshController.js';
import { refreshEvidenceFromProjections, renameDeleteEvidenceFromProjections } from '../src/browser/realVaultLive.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

async function projections() {
  const reader = fixtureVault('vault-basic');
  const loaded = await loadVaultState(reader);
  const controller = createRefreshController({ vault: reader, initial: loaded });
  const previous = createReadOnlyProjection(controller.snapshot());
  const next = createReadOnlyProjection({ ...controller.snapshot(), sourceRevision: 2, load: { ...loaded, revisions: { ...loaded.revisions, 'Proxima/tasks/task-1.md': 'changed:2' } } });
  return { previous, next };
}

describe('Gate 6K live evidence derivation', () => {
  it('derives changed revision evidence from a normal refresh result', async () => {
    const { previous, next } = await projections();
    const result = { ok: true, reason: 'interval', outcome: 'changed', changed: true, snapshot: {} } as RefreshResult;
    const evidence = refreshEvidenceFromProjections(previous, next, result);
    expect(evidence).toMatchObject({ outcome: 'changed', changed: true, previousGeneration: 1, currentGeneration: 2, beforeRevision: expect.any(String), afterRevision: 'changed:2' });
    expect(evidence.beforeRevision).not.toBe(evidence.afterRevision);
  });

  it('derives rename/delete evidence only from source identity/path deltas', async () => {
    const { previous, next } = await projections();
    const previousTask = previous.state.tasks[0];
    const nextTask = next.state.tasks[0];
    if (!previousTask || !nextTask) throw new Error('fixture task missing');
    const oldPath = previousTask.source.path;
    const newPath = `${oldPath}-renamed`;
    nextTask.source.path = newPath;
    const oldRevision = next.revisions[oldPath];
    if (!oldRevision) throw new Error('fixture revision missing');
    next.revisions = { ...next.revisions, [newPath]: oldRevision };
    delete next.revisions[oldPath];
    expect(renameDeleteEvidenceFromProjections(previous, next, 'renamed')).toEqual({ outcome: 'renamed', removedPath: oldPath, addedPath: newPath });
    expect(renameDeleteEvidenceFromProjections(previous, next, 'changed')).toBeNull();
  });
});
