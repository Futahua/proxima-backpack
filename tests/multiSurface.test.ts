import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createSourceSession, type SourceCandidate } from '../src/app/sourceSession.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureFiles } from './fixtures.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyFixtureToDisk, createDiskVault, removeDiskFixture } from './test-disk-vault.js';
import type { VaultReader } from '../src/ports/vault.js';

function scheduler() {
  let next = 1;
  const active = new Set<number>();
  return { scheduler: { setInterval: () => { const id = next++; active.add(id); return id; }, clearInterval: (id: unknown) => { active.delete(id as number); } }, active };
}

async function candidate(reader: VaultReader): Promise<SourceCandidate> {
  return { mode: 'external', reader, initial: await loadVaultState(reader) };
}

describe('Gate 17.1 multiple live Proxima surfaces', () => {
  it('converges two sessions over one source while retaining independent navigation state', async () => {
    const vault = createMemoryVault(fixtureFiles('vault-basic'));
    const a = scheduler(); const b = scheduler();
    const initialA = await candidate(vault); const initialB = await candidate(vault);
    const left = createSourceSession({ initial: initialA, scheduler: a.scheduler, intervalMs: 60_000 });
    const right = createSourceSession({ initial: initialB, scheduler: b.scheduler, intervalMs: 60_000 });
    const leftActions = createActionDispatcher({ state: left.projection().state, problems: left.projection().problems, revisions: left.projection().revisions, mode: 'live', initialSourceRevision: left.projection().generation, initialSurface: 'board' });
    const rightActions = createActionDispatcher({ state: right.projection().state, problems: right.projection().problems, revisions: right.projection().revisions, mode: 'live', initialSourceRevision: right.projection().generation, initialSurface: 'calendar' });

    expect(leftActions.dispatch({ type: 'project.select', projectId: 'proj-backpack' })).toMatchObject({ ok: true });
    expect(rightActions.dispatch({ type: 'project.select', projectId: 'proj-term' })).toMatchObject({ ok: true });
    expect(leftActions.snapshot().selection).toBe('proj-backpack');
    expect(rightActions.snapshot().selection).toBe('proj-term');

    vault.set('Proxima/projects/Backpack Port.md', fixtureFiles('vault-basic')['Proxima/projects/Backpack Port.md']!.replace('Move Proxima', 'Updated Proxima'));
    await left.refresh('manual');
    await right.refresh('manual');
    expect(left.snapshot().sourceGeneration).toBe(2);
    expect(right.snapshot().sourceGeneration).toBe(2);
    expect(left.projection().state.projects.find((project) => project.id === 'proj-backpack')?.description).toContain('Updated Proxima');
    expect(right.projection().state.projects.find((project) => project.id === 'proj-backpack')?.description).toContain('Updated Proxima');
    expect(leftActions.snapshot().selection).toBe('proj-backpack');
    expect(rightActions.snapshot().selection).toBe('proj-term');
    expect(a.active.size).toBe(1); expect(b.active.size).toBe(1);
    left.dispose(); right.dispose();
    expect(a.active.size).toBe(0); expect(b.active.size).toBe(0);
  });

  it('converges two sessions over the same disposable real-disk vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-multisurface-'));
    try {
      const files = fixtureFiles('vault-basic');
      await copyFixtureToDisk(files, root);
      const left = createSourceSession({ initial: await candidate(createDiskVault(root)), scheduler: scheduler().scheduler, intervalMs: 60_000 });
      const right = createSourceSession({ initial: await candidate(createDiskVault(root)), scheduler: scheduler().scheduler, intervalMs: 60_000 });
      const original = files['Proxima/projects/Backpack Port'] ?? files['Proxima/projects/Backpack Port.md'];
      await writeFile(join(root, 'Proxima/projects/Backpack Port.md'), original!.replace('Move Proxima', 'Disk update Proxima'), 'utf8');
      await left.refresh('manual'); await right.refresh('manual');
      expect(left.snapshot().sourceGeneration).toBe(2);
      expect(right.snapshot().sourceGeneration).toBe(2);
      expect(left.projection().state.projects.find((project) => project.id === 'proj-backpack')?.description).toContain('Disk update Proxima');
      expect(right.projection().state.projects.find((project) => project.id === 'proj-backpack')?.description).toContain('Disk update Proxima');
      left.dispose(); right.dispose();
    } finally { await removeDiskFixture(root); }
  });
});
