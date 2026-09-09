import { describe, expect, it } from 'vitest';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDiskVault } from './test-disk-vault.js';
import { createDurableRecoveryStore } from '../src/app/vaultRecovery.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { restoreCommittedRecovery } from '../src/app/vaultRecoveryRestore.js';

const peerWorker = join(process.cwd(), 'tests', 'helpers', 'peer-vault-writer.mjs');
async function peer(root: string, operation: string, path: string, destination = '', value = ''): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [peerWorker, root, operation, path, destination, value], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`peer exited ${code}`)));
  });
}
function backend(root: string) {
  const journal = join(root, 'recovery.json');
  return { async read() { try { return await readFile(journal, 'utf8'); } catch { return undefined; } }, async write(value: string) { await writeFile(journal, value, 'utf8'); } };
}
async function rootWithFiles() {
  const root = await mkdtemp(join(tmpdir(), 'proxima-13d-'));
  await writeFile(join(root, 'task.md'), 'original', 'utf8');
  await writeFile(join(root, 'unrelated.md'), 'peer-stable', 'utf8');
  await writeFile(join(root, '.obsidian-workspace'), 'metadata-stable', 'utf8');
  return root;
}
const MAX_TREE_ITEMS = 256;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_DEPTH = 16;
async function treeSnapshot(root: string, directory = '', state = { items: 0, bytes: 0 }, depth = 0): Promise<Map<string, string>> {
  if (depth > MAX_TREE_DEPTH) throw new Error('tree snapshot depth limit exceeded');
  const result = new Map<string, string>();
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (relative === 'recovery.json') continue;
    if (entry.isSymbolicLink()) throw new Error('tree snapshot refuses symlinks');
    state.items += 1;
    if (state.items > MAX_TREE_ITEMS) throw new Error('tree snapshot item limit exceeded');
    if (entry.isDirectory()) for (const [path, value] of await treeSnapshot(root, relative, state, depth + 1)) result.set(path, value);
    else {
      const remaining = MAX_TREE_BYTES - state.bytes;
      const handle = await open(join(root, relative), 'r');
      const buffer = Buffer.alloc(remaining + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      await handle.close();
      if (bytesRead > remaining) throw new Error('tree snapshot byte limit exceeded');
      state.bytes += bytesRead;
      const content = buffer.subarray(0, bytesRead);
      result.set(relative, Buffer.from(content).toString('base64'));
    }
  }
  return result;
}
function changedSnapshot(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
}
async function makeCoordinator(root: string, options: Parameters<typeof createDiskVault>[1] = {}) {
  const vault = createDiskVault(root, options);
  const recovery = createDurableRecoveryStore(backend(root)); await recovery.load();
  return { vault, recovery, coordinator: createVaultMutationCoordinator({ reader: vault, writer: vault, recovery }) };
}
describe('Gate 13D1 disposable multi-writer coexistence', () => {
  it('runs coordinator create/update/move/delete while peer retains exact unrelated bytes', async () => {
    const root = await rootWithFiles();
    try {
      const { vault, recovery, coordinator } = await makeCoordinator(root);
      const created = await coordinator.execute({ kind: 'create', path: 'created.md', bytes: new TextEncoder().encode('created-by-proxima') });
      expect(created.ok).toBe(true); expect(await readFile(join(root, 'created.md'), 'utf8')).toBe('created-by-proxima');
      const revision = (await vault.read('task.md')).revision;
      const updated = await coordinator.execute({ kind: 'update', path: 'task.md', bytes: new TextEncoder().encode('updated-by-proxima'), expectedRevision: revision });
      expect(updated.ok).toBe(true); await peer(root, 'append', 'unrelated.md', '', '\npeer-update');
      const moved = await coordinator.execute({ kind: 'move', from: 'task.md', to: 'moved.md', expectedRevision: (await vault.read('task.md')).revision });
      expect(moved.ok).toBe(true); expect(await readFile(join(root, 'moved.md'), 'utf8')).toBe('updated-by-proxima');
      const deleted = await coordinator.execute({ kind: 'delete', path: 'created.md', expectedRevision: (await vault.read('created.md')).revision });
      expect(deleted.ok).toBe(true); expect(await vault.exists('created.md')).toBe(false);
      expect(await readFile(join(root, 'unrelated.md'), 'utf8')).toBe('peer-stable\npeer-update');
      expect(await readFile(join(root, '.obsidian-workspace'), 'utf8')).toBe('metadata-stable');
      expect(recovery.list().map((record) => record.status)).toEqual(['committed', 'committed', 'committed']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses deterministic same-file races without overwriting peer bytes', async () => {
    const root = await rootWithFiles();
    try {
      let race: 'update' | 'delete' | 'move' = 'update';
      const setup = await makeCoordinator(root, { beforeCommit: async (operation) => {
        if (operation === 'update' && race === 'update') await peer(root, 'append', 'task.md', '', '\npeer-update');
        if (operation === 'delete' && race === 'delete') await peer(root, 'append', 'task.md', '', '\npeer-delete');
        if (operation === 'move' && race === 'move') await peer(root, 'write', 'moved.md', '', 'peer-destination');
      } });
      const update = await setup.coordinator.execute({ kind: 'update', path: 'task.md', bytes: new TextEncoder().encode('proxima'), expectedRevision: (await setup.vault.read('task.md')).revision });
      expect(update).toMatchObject({ ok: false, reason: 'stale' }); expect(await readFile(join(root, 'task.md'), 'utf8')).toContain('peer-update');
      race = 'delete'; const deleted = await setup.coordinator.execute({ kind: 'delete', path: 'task.md', expectedRevision: (await setup.vault.read('task.md')).revision });
      expect(deleted).toMatchObject({ ok: false, reason: 'stale' }); expect(await readFile(join(root, 'task.md'), 'utf8')).toContain('peer-delete');
      race = 'move'; const moved = await setup.coordinator.execute({ kind: 'move', from: 'task.md', to: 'moved.md', expectedRevision: (await setup.vault.read('task.md')).revision });
      expect(moved).toMatchObject({ ok: false, reason: 'destination-exists' }); expect(await readFile(join(root, 'moved.md'), 'utf8')).toBe('peer-destination');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('blocks recovery restore after peer changes for update, delete and move', async () => {
    const root = await rootWithFiles();
    try {
      const updateSetup = await makeCoordinator(root); const update = await updateSetup.coordinator.execute({ kind: 'update', path: 'task.md', bytes: new TextEncoder().encode('new'), expectedRevision: (await updateSetup.vault.read('task.md')).revision });
      const updateRecord = updateSetup.recovery.list().find((record) => record.requestId === update.requestId)!;
      expect(updateRecord.operation).toBe('update'); await peer(root, 'write', 'task.md', '', 'peer');
      expect((await restoreCommittedRecovery(updateRecord, updateSetup.vault, updateSetup.vault, updateSetup.recovery)).outcome).toBe('blocked');

      await writeFile(join(root, 'task.md'), 'original', 'utf8'); const deleteSetup = await makeCoordinator(root); const deleted = await deleteSetup.coordinator.execute({ kind: 'delete', path: 'task.md', expectedRevision: (await deleteSetup.vault.read('task.md')).revision });
      expect(deleted.ok).toBe(true); const deleteRecord = deleteSetup.recovery.list().find((record) => record.requestId === deleted.requestId)!;
      expect(deleteRecord.operation).toBe('delete'); await peer(root, 'write', 'task.md', '', 'peer-recreated');
      expect((await restoreCommittedRecovery(deleteRecord, deleteSetup.vault, deleteSetup.vault, deleteSetup.recovery)).outcome).toBe('blocked');

      await writeFile(join(root, 'task.md'), 'original', 'utf8'); const moveSetup = await makeCoordinator(root); const moved = await moveSetup.coordinator.execute({ kind: 'move', from: 'task.md', to: 'moved.md', expectedRevision: (await moveSetup.vault.read('task.md')).revision });
      expect(moved.ok).toBe(true); const moveRecord = moveSetup.recovery.list().find((record) => record.requestId === moved.requestId)!;
      expect(moveRecord.operation).toBe('move'); expect(moveRecord.destination).toBe('moved.md'); await peer(root, 'write', 'moved.md', '', 'peer-destination');
      expect((await restoreCommittedRecovery(moveRecord, moveSetup.vault, moveSetup.vault, moveSetup.recovery)).outcome).toBe('blocked');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses peer source rename/delete races and attributes exactly the peer tree changes', async () => {
    for (const peerAction of ['rename', 'delete'] as const) {
      for (const operation of ['update', 'delete', 'move'] as const) {
        const root = await rootWithFiles();
        try {
          const before = await treeSnapshot(root);
          const setup = await makeCoordinator(root, { beforeCommit: async (phase) => {
            if (phase !== operation) return;
            if (peerAction === 'rename') await peer(root, 'rename', 'task.md', 'peer-renamed.md');
            else await peer(root, 'delete', 'task.md');
          } });
          const expectedRevision = (await setup.vault.read('task.md')).revision;
          const result = operation === 'update'
            ? await setup.coordinator.execute({ kind: 'update', path: 'task.md', bytes: new TextEncoder().encode('proxima'), expectedRevision })
            : operation === 'delete'
              ? await setup.coordinator.execute({ kind: 'delete', path: 'task.md', expectedRevision })
              : await setup.coordinator.execute({ kind: 'move', from: 'task.md', to: 'moved.md', expectedRevision });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason === 'missing' || result.reason === 'stale').toBe(true);
          const after = await treeSnapshot(root);
          expect(changedSnapshot(before, after)).toEqual(peerAction === 'rename' ? ['peer-renamed.md', 'task.md'] : ['task.md']);
          expect(await setup.vault.exists('task.md')).toBe(false);
          if (peerAction === 'rename') expect(await readFile(join(root, 'peer-renamed.md'), 'utf8')).toBe('original');
          expect(await setup.vault.exists('moved.md')).toBe(false);
        } finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  });

  it('rejects an intentionally oversized tree instead of accumulating unbounded evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-13d-bounds-'));
    try {
      await Promise.all(Array.from({ length: MAX_TREE_ITEMS + 1 }, (_, index) => writeFile(join(root, `file-${index}.md`), 'x', 'utf8')));
      await expect(treeSnapshot(root)).rejects.toThrow(/item limit/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects one oversized file before reading it into the evidence map', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-13d-byte-bounds-'));
    try {
      await writeFile(join(root, 'huge.bin'), Buffer.alloc(MAX_TREE_BYTES + 1));
      await expect(treeSnapshot(root)).rejects.toThrow(/byte limit/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
