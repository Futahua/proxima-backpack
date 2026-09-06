import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import type { VaultReader } from '../src/ports/vault.js';
import { fixtureFiles, fixtureVault } from './fixtures.js';

async function controllerFor(vault: VaultReader = fixtureVault('vault-basic')) {
  return createRefreshController({ vault, initial: await loadVaultState(vault) });
}

describe('Gate 6A read-only refresh controller', () => {
  it('does not bump revisions for an unchanged reread', async () => {
    const controller = await controllerFor();
    const result = await controller.refreshSource('manual');
    expect(result).toMatchObject({ ok: true, outcome: 'unchanged', changed: false });
    expect(result.snapshot.sourceRevision).toBe(1);
  });

  it('publishes one revision for content changes', async () => {
    const vault = createMemoryVault(fixtureFiles('vault-basic'));
    const controller = await controllerFor(vault);
    vault.set('Proxima/tasks/Write fixture vault.md', `${fixtureFiles('vault-basic')['Proxima/tasks/Write fixture vault.md']}\nexternal edit`);
    const result = await controller.refreshSource('external-signal');
    expect(result).toMatchObject({ ok: true, outcome: 'changed', changed: true });
    expect(result.snapshot.sourceRevision).toBe(2);
    expect(result.snapshot.load.state.tasks.find((task) => task.id === 'task-fixtures')?.description).toContain('external edit');
  });

  it('distinguishes deletion and keeps the last good snapshot on unreadable failure', async () => {
    const vault = createMemoryVault(fixtureFiles('vault-basic'));
    const controller = await controllerFor(vault);
    vault.delete('Proxima/tasks/Write fixture vault.md');
    expect(await controller.refreshSource('manual')).toMatchObject({ ok: true, outcome: 'deleted', changed: true });
    const goodTaskCount = controller.snapshot().load.state.tasks.length;
    const failing: VaultReader = { list: vault.list.bind(vault), walk: vault.walk.bind(vault), async read() { throw new Error('permission denied'); }, exists: vault.exists.bind(vault) };
    const failingController = createRefreshController({ vault: failing, initial: await loadVaultState(vault) });
    const failure = await failingController.refreshSource('focus');
    expect(failure).toMatchObject({ ok: false, outcome: 'unreadable', changed: false });
    expect(failure.snapshot.stale).toBe(true);
    expect(failure.snapshot.load.state.tasks.length).toBe(goodTaskCount);
  });

  it('converges a delete plus new path with the same explicit id as a rename', async () => {
    const files = fixtureFiles('vault-basic');
    const vault = createMemoryVault(files);
    const controller = await controllerFor(vault);
    const oldPath = 'Proxima/tasks/Write fixture vault.md';
    const newPath = 'Proxima/tasks/renamed-fixture.md';
    const text = files[oldPath]!;
    vault.delete(oldPath);
    vault.set(newPath, text);
    expect(await controller.refreshSource('external-signal')).toMatchObject({ ok: true, outcome: 'renamed', changed: true });
  });

  it('serializes concurrent refreshes and never lets a stale older result overwrite the newer one', async () => {
    const vault = createMemoryVault(fixtureFiles('vault-basic'));
    const controller = await controllerFor(vault);
    vault.set('Proxima/tasks/Write fixture vault.md', `${fixtureFiles('vault-basic')['Proxima/tasks/Write fixture vault.md']}\nv1`);
    const first = controller.refreshSource('interval');
    vault.set('Proxima/tasks/Write fixture vault.md', `${fixtureFiles('vault-basic')['Proxima/tasks/Write fixture vault.md']}\nv2`);
    const second = controller.refreshSource('interval');
    const [one, two] = await Promise.all([first, second]);
    expect(one.snapshot.sourceRevision).toBeLessThanOrEqual(two.snapshot.sourceRevision);
    expect(controller.snapshot().load.state.tasks.find((task) => task.id === 'task-fixtures')?.description).toContain('v2');
    expect(controller.snapshot().pendingRefreshCount).toBe(0);
  });

  it('recovers from malformed input once the source is repaired', async () => {
    const vault = createMemoryVault(fixtureFiles('vault-basic'));
    const controller = await controllerFor(vault);
    const path = 'Proxima/tasks/Write fixture vault.md';
    vault.set(path, '---\nstatus: [broken\n---\n');
    const degraded = await controller.refreshSource('external-signal');
    expect(degraded).toMatchObject({ ok: false, outcome: 'malformed', changed: false });
    expect(degraded.snapshot.stale).toBe(true);
    vault.set(path, fixtureFiles('vault-basic')[path]!);
    expect(await controller.refreshSource('manual')).toMatchObject({ ok: true, outcome: 'changed', changed: true });
    expect(controller.snapshot().refreshState).toBe('idle');
  });
});
