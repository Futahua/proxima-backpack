import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createOpfsVault, type OpfsDirectoryHandleLike, type OpfsHandleLike } from '../src/adapters/opfsVault.js';
import type { VaultReader } from '../src/ports/vault.js';
import { copyFixtureToDisk, createDiskVault, removeDiskFixture } from './test-disk-vault.js';
import { fixtureFiles } from './fixtures.js';

class FakeFile {
  readonly kind = 'file' as const;
  constructor(private readonly value: string, private readonly modified = 0) {}
  async getFile() { return { text: async () => this.value, size: this.value.length, lastModified: this.modified }; }
}

class FakeDirectory implements OpfsDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, OpfsHandleLike>();
  async *entries(): AsyncIterableIterator<[string, OpfsHandleLike]> { for (const entry of [...this.children.entries()].sort(([a], [b]) => a.localeCompare(b))) yield entry; }
}

function fakeOpfs(files: Record<string, string>): OpfsDirectoryHandleLike {
  const root = new FakeDirectory();
  for (const [path, value] of Object.entries(files)) {
    const parts = path.replaceAll('\\', '/').split('/');
    const name = parts.pop()!;
    let current = root;
    for (const part of parts) { const existing = current.children.get(part); if (existing instanceof FakeDirectory) current = existing; else { const next = new FakeDirectory(); current.children.set(part, next); current = next; } }
    current.children.set(name, new FakeFile(value));
  }
  return root;
}

async function assertContract(vault: VaultReader): Promise<void> {
  const direct = await vault.list('Proxima');
  expect(direct.map((entry) => entry.path)).toEqual(['Proxima/events', 'Proxima/projects', 'Proxima/tasks']);
  const walked = await vault.walk('Proxima/tasks');
  expect(walked).toContain('Proxima/tasks/Write fixture vault.md');
  expect(await vault.exists('Proxima/tasks/Write fixture vault.md')).toBe(true);
  expect(await vault.exists('Proxima/tasks/missing.md')).toBe(false);
  const file = await vault.read('Proxima/tasks/Write fixture vault.md');
  expect(file.text).toContain('Write fixture vault');
  expect(file.path).toBe('Proxima/tasks/Write fixture vault.md');
  await expect(vault.read('Proxima/tasks/missing.md')).rejects.toThrow();
  await expect(vault.read('../outside.md')).rejects.toThrow(/traversal|not found/i);
}

describe('Gate 4 repository adapter conformance', () => {
  it('covers the memory adapter and deterministic delete/recreate revisions', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/Write fixture vault.md': 'first', 'Proxima/tasks/é space!.md': 'unicode' });
    const before = await vault.read('\\Proxima\\tasks\\Write fixture vault.md');
    vault.set('Proxima/tasks/Write fixture vault.md', 'second');
    const changed = await vault.read('Proxima/tasks/Write fixture vault.md');
    expect(changed.revision).not.toBe(before.revision);
    vault.delete('Proxima/tasks/Write fixture vault.md');
    expect(await vault.exists('Proxima/tasks/Write fixture vault.md')).toBe(false);
    vault.set('Proxima/tasks/Write fixture vault.md', 'recreated');
    const recreated = await vault.read('Proxima/tasks/Write fixture vault.md');
    expect(recreated.revision).not.toBe(changed.revision);
    expect((await vault.list('Proxima/tasks')).map((entry) => entry.path)).toEqual(['Proxima/tasks/é space!.md', 'Proxima/tasks/Write fixture vault.md']);
    vault.set('Proxima/tasks/large reasonable.md', 'x'.repeat(128 * 1024));
    expect((await vault.read('Proxima/tasks/large reasonable.md')).size).toBe(128 * 1024);
  });

  it('runs the same contract against an actual disposable disk fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-gate4-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const vault = createDiskVault(root);
      await assertContract(vault);
      const target = join(root, 'Proxima', 'tasks', 'Write fixture vault.md');
      const before = await vault.read('Proxima/tasks/Write fixture vault.md');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', `const fs = require('node:fs'); fs.appendFileSync(process.argv[1], '\\nexternal process edit', 'utf8');`, target], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`external writer exited with ${code}`)));
      });
      const after = await vault.read('Proxima/tasks/Write fixture vault.md');
      expect(after.revision).not.toBe(before.revision);
      expect(after.text).toContain('external process edit');
      await import('node:fs/promises').then(({ rename }) => rename(target, join(root, 'Proxima', 'tasks', 'renamed.md')));
      expect(await vault.exists('Proxima/tasks/Write fixture vault.md')).toBe(false);
      expect(await vault.exists('Proxima/tasks/renamed.md')).toBe(true);
      await import('node:fs/promises').then(({ rm }) => rm(join(root, 'Proxima', 'tasks', 'renamed.md')));
      expect(await vault.exists('Proxima/tasks/renamed.md')).toBe(false);
      await writeFile(target, 'recreated after delete', 'utf8');
      const recreated = await vault.read('Proxima/tasks/Write fixture vault.md');
      expect(recreated.revision).not.toBe(after.revision);
    } finally { await removeDiskFixture(root); }
  });

  it('keeps unreadable existing files fail-visible with a deterministic permission-denied fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-gate4-unreadable-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const vault = createDiskVault(root, { readText: async () => { const error = Object.assign(new Error('permission denied by test fixture'), { code: 'EACCES' }); throw error; } });
      expect(await vault.exists('Proxima/tasks/Write fixture vault.md')).toBe(true);
      await expect(vault.read('Proxima/tasks/Write fixture vault.md')).rejects.toThrow(/permission denied/i);
    } finally { await removeDiskFixture(root); }
  });

  it('runs the same contract against an OPFS-shaped handle without a picker', async () => {
    const vault = createOpfsVault(fakeOpfs(fixtureFiles('vault-basic')));
    await assertContract(vault);
    await expect(vault.read('Proxima/../outside.md')).rejects.toThrow(/traversal/i);
  });
});
