import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { createDurableRecoveryStore } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyFixtureToDisk, createDiskVault, removeDiskFixture } from './test-disk-vault.js';
import { fixtureFiles } from './fixtures.js';

describe('Gate 13 disposable owner-mode mutation contract', () => {
  it('supports conditional create/update/move/delete and refuses stale conflicts', async () => {
    const vault = createMemoryVault({ 'notes/a.md': 'one' });
    const before = await vault.read('notes/a.md');
    expect(await vault.createIfAbsent('notes/a.md', new TextEncoder().encode('other'))).toMatchObject({ ok: false, reason: 'already-exists' });
    expect(await vault.writeIfUnchanged('notes/a.md', new TextEncoder().encode('two'), before.revision)).toMatchObject({ ok: true });
    expect(await vault.writeIfUnchanged('notes/a.md', new TextEncoder().encode('three'), before.revision)).toMatchObject({ ok: false, reason: 'stale' });
    const after = await vault.read('notes/a.md');
    expect(await vault.moveIfUnchanged('notes/a.md', 'notes/b.md', before.revision)).toMatchObject({ ok: false, reason: 'stale' });
    expect(await vault.moveIfUnchanged('notes/a.md', 'notes/b.md', after.revision)).toMatchObject({ ok: true });
    const moved = await vault.read('notes/b.md');
    expect(moved.text).toBe('two');
    expect(await vault.deleteIfUnchanged('notes/b.md', moved.revision)).toMatchObject({ ok: true });
    expect(await vault.exists('notes/b.md')).toBe(false);
  });

  it('coordinates bounded paths, recovery, postconditions and terminal events without retries', async () => {
    const vault = createMemoryVault({ 'notes/a.md': 'one' });
    const clock = fixedClock('2026-09-07T00:00:00.000Z');
    const recovery = createMemoryRecoveryStore(clock);
    const coordinator = createVaultMutationCoordinator({ reader: vault, writer: vault, recovery, clock, ids: sequentialIdGenerator(), maxBytes: 32 });
    const observed = await vault.read('notes/a.md');
    const result = await coordinator.execute({ kind: 'update', path: 'notes/a.md', bytes: new TextEncoder().encode('two'), expectedRevision: observed.revision });
    expect(result).toMatchObject({ ok: true, requestId: 'mutation-0001' });
    expect(recovery.list()).toHaveLength(1);
    expect(coordinator.events().map((event) => event.outcome)).toEqual(['started', 'accepted']);
    const stale = await coordinator.execute({ kind: 'update', path: 'notes/a.md', bytes: new TextEncoder().encode('three'), expectedRevision: observed.revision });
    expect(stale).toMatchObject({ ok: false, reason: 'stale' });
    expect(coordinator.events().at(-1)?.outcome).toBe('conflict');
    expect(await coordinator.execute({ kind: 'create', path: '../escape.md', bytes: new TextEncoder().encode('x') })).toMatchObject({ ok: false });
    expect(await coordinator.execute({ kind: 'create', path: 'notes/large.md', bytes: new Uint8Array(33) })).toMatchObject({ ok: false, reason: 'mutation byte limit exceeded' });
  });

  it('runs conditional mutations against a disposable real-disk root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-gate13-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const vault = createDiskVault(root);
      const path = 'Proxima/tasks/Write fixture vault.md';
      const observed = await vault.read(path);
      expect(await vault.writeIfUnchanged(path, new TextEncoder().encode('disk update'), observed.revision)).toMatchObject({ ok: true });
      expect(await vault.writeIfUnchanged(path, new TextEncoder().encode('stale'), observed.revision)).toMatchObject({ ok: false, reason: 'stale' });
      const current = await vault.read(path);
      expect(await vault.moveIfUnchanged(path, 'Proxima/tasks/moved.md', current.revision)).toMatchObject({ ok: true });
      const moved = await vault.read('Proxima/tasks/moved.md');
      expect(await vault.deleteIfUnchanged('Proxima/tasks/moved.md', moved.revision)).toMatchObject({ ok: true });
      expect(await vault.exists('Proxima/tasks/moved.md')).toBe(false);
    } finally { await removeDiskFixture(root); }
  });

  it('refuses forced check-to-commit races instead of overwriting peer bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-gate13-race-'));
    try {
      await writeFile(join(root, 'task.md'), 'original', 'utf8');
      let peer: Promise<void> | undefined;
      const vault = createDiskVault(root, { beforeCommit: async (operation, path) => {
        if (operation === 'update') peer = writeFile(join(root, path), 'peer-update', 'utf8');
        if (operation === 'delete') peer = writeFile(join(root, path), 'peer-delete', 'utf8');
        if (operation === 'move') peer = writeFile(join(root, 'destination.md'), 'peer-destination', 'utf8');
        if (operation === 'create') peer = writeFile(join(root, path), 'peer-create', 'utf8');
        await peer;
      } });
      const observed = await vault.read('task.md');
      expect(await vault.writeIfUnchanged('task.md', new TextEncoder().encode('proxima'), observed.revision)).toMatchObject({ ok: false, reason: 'stale' });
      const afterUpdate = await vault.read('task.md'); expect(afterUpdate.text).toBe('peer-update');
      expect(await vault.deleteIfUnchanged('task.md', afterUpdate.revision)).toMatchObject({ ok: false, reason: 'stale' });
      expect(await vault.exists('task.md')).toBe(true);
      const fresh = await vault.read('task.md');
      expect(await vault.moveIfUnchanged('task.md', 'destination.md', fresh.revision)).toMatchObject({ ok: false, reason: 'destination-exists' });
      expect(await vault.read('destination.md')).toMatchObject({ text: 'peer-destination' });
      expect(await vault.createIfAbsent('task.md', new TextEncoder().encode('proxima-create'))).toMatchObject({ ok: false, reason: 'already-exists' });
    } finally { await removeDiskFixture(root); }
  });

  it('persists recovery intent and commit state across coordinator restart', async () => {
    let journal: string | undefined;
    const backend = { async read() { return journal; }, async write(value: string) { journal = value; } };
    const first = createDurableRecoveryStore(backend);
    const record = { requestId: 'mutation-1', operation: 'delete' as const, path: 'task.md', revision: 'r1', bytes: new TextEncoder().encode('old'), createdAt: '2026-09-07T00:00:00.000Z' };
    await first.save(record);
    const restarted = createDurableRecoveryStore(backend); await restarted.load();
    expect(restarted.list()[0]).toMatchObject({ requestId: 'mutation-1', status: 'prepared', path: 'task.md' });
    await restarted.markCommitted?.('mutation-1');
    const loadedAgain = createDurableRecoveryStore(backend); await loadedAgain.load();
    expect(loadedAgain.list()[0]).toMatchObject({ status: 'committed' });
  });
});
