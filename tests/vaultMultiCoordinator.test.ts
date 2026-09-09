import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDiskVault } from './test-disk-vault.js';
import { createDurableRecoveryStore } from '../src/app/vaultRecovery.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { reconcileOwnerRecoveryOnStartup } from '../src/app/ownerRecoveryStartup.js';

const enc = (value: string) => new TextEncoder().encode(value);
function durableBackend(root: string, name: string) {
  const path = join(root, name);
  return { async read() { try { return await readFile(path, 'utf8'); } catch { return undefined; } }, async write(value: string) { await writeFile(path, value, 'utf8'); } };
}
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'proxima-multi-'));
  await writeFile(join(root, 'task.md'), 'original', 'utf8');
  await writeFile(join(root, 'a.md'), 'a-original', 'utf8');
  await writeFile(join(root, 'b.md'), 'b-original', 'utf8');
  return root;
}
async function side(root: string, name: string) {
  const vault = createDiskVault(root);
  const recovery = createDurableRecoveryStore(durableBackend(root, `recovery-${name}.json`)); await recovery.load();
  let sequence = 0;
  const coordinator = createVaultMutationCoordinator({ reader: createDiskVault(root), writer: createDiskVault(root), recovery, ids: { next: () => `${name}-${++sequence}` } });
  return { vault, recovery, coordinator };
}

describe('Gate 13.1P / 17.2A independent Proxima writers', () => {
  it('refuses stale same-source update symmetrically and preserves the winner', async () => {
    for (const winner of ['A', 'B'] as const) {
      const root = await makeRoot();
      try {
        const a = await side(root, 'A'); const b = await side(root, 'B');
        const revision = (await a.vault.read('task.md')).revision;
        const first = winner === 'A' ? a : b; const second = winner === 'A' ? b : a;
        const winnerResult = await first.coordinator.execute({ kind: 'update', path: 'task.md', bytes: enc(`${winner}-bytes`), expectedRevision: revision });
        const loserResult = await second.coordinator.execute({ kind: 'update', path: 'task.md', bytes: enc('loser-bytes'), expectedRevision: revision });
        expect(winnerResult.ok).toBe(true); expect(loserResult).toMatchObject({ ok: false, reason: 'stale' });
        expect(await readFile(join(root, 'task.md'), 'utf8')).toBe(`${winner}-bytes`);
        expect(first.recovery.list().find((record) => record.requestId === winnerResult.requestId)?.status).toBe('committed');
        expect(second.recovery.list().find((record) => record.requestId === loserResult.requestId)?.status).toBe('recovered');
        const restarted = createDurableRecoveryStore(durableBackend(root, `recovery-${winner === 'A' ? 'B' : 'A'}.json`));
        const startup = await reconcileOwnerRecoveryOnStartup(restarted, createDiskVault(root));
        expect(startup.mutationAuthority).toBe('available');
        expect(restarted.list().find((record) => record.requestId === loserResult.requestId)?.status).toBe('recovered');
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  it('isolates delete, move and destination conflicts across independent writers', async () => {
    for (const operation of ['update', 'delete', 'move'] as const) {
      const root = await makeRoot();
      try {
        const a = await side(root, 'A'); const b = await side(root, 'B');
        const revision = (await a.vault.read('task.md')).revision;
        const first = await a.coordinator.execute({ kind: 'delete', path: 'task.md', expectedRevision: revision });
        expect(first.ok).toBe(true);
        const second = operation === 'update'
          ? await b.coordinator.execute({ kind: 'update', path: 'task.md', bytes: enc('b'), expectedRevision: revision })
          : operation === 'delete'
            ? await b.coordinator.execute({ kind: 'delete', path: 'task.md', expectedRevision: revision })
            : await b.coordinator.execute({ kind: 'move', from: 'task.md', to: 'moved.md', expectedRevision: revision });
        expect(second.ok).toBe(false); if (!second.ok) expect(second.reason === 'missing' || second.reason === 'stale').toBe(true);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
    const destinationRoot = await makeRoot();
    try {
      const a = await side(destinationRoot, 'A'); const b = await side(destinationRoot, 'B');
      const revision = (await b.vault.read('task.md')).revision;
      const created = await a.coordinator.execute({ kind: 'create', path: 'moved.md', bytes: enc('A-destination') });
      const moved = await b.coordinator.execute({ kind: 'move', from: 'task.md', to: 'moved.md', expectedRevision: revision });
      expect(created.ok).toBe(true); expect(moved).toMatchObject({ ok: false, reason: 'destination-exists' });
      expect(await readFile(join(destinationRoot, 'moved.md'), 'utf8')).toBe('A-destination');
    } finally { await rm(destinationRoot, { recursive: true, force: true }); }
  });

  it('allows independent sources to commit concurrently and attributes recovery by writer', async () => {
    const root = await makeRoot();
    try {
      const a = await side(root, 'A'); const b = await side(root, 'B');
      const [updated, moved] = await Promise.all([
        a.coordinator.execute({ kind: 'update', path: 'a.md', bytes: enc('a-new'), expectedRevision: (await a.vault.read('a.md')).revision }),
        b.coordinator.execute({ kind: 'update', path: 'b.md', bytes: enc('b-new'), expectedRevision: (await b.vault.read('b.md')).revision }),
      ]);
      expect(updated.ok).toBe(true); expect(moved.ok).toBe(true);
      expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('a-new'); expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('b-new');
      expect(a.recovery.list().find((record) => record.requestId === updated.requestId)?.path).toBe('a.md');
      expect(b.recovery.list().find((record) => record.requestId === moved.requestId)?.path).toBe('b.md');
      expect(a.recovery.list().find((record) => record.requestId === moved.requestId)).toBeUndefined();
      expect(b.recovery.list().find((record) => record.requestId === updated.requestId)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
