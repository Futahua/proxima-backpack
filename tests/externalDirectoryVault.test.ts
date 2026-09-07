import { describe, expect, it } from 'vitest';
import { createExternalDirectoryVault, type ExternalDirectoryHandleLike } from '../src/adapters/externalDirectoryVault.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { createRefreshPolicy } from '../src/app/refreshPolicy.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { createBrowserSource } from '../src/browser/sourceFactory.js';
import { fixtureFiles } from './fixtures.js';

class MutableFile {
  readonly kind = 'file' as const;
  unreadable = false;
  constructor(public value: string, public modified = 0) {}
  async getFile() {
    if (this.unreadable) throw new Error('permission denied by injected handle');
    return { text: async () => this.value, size: this.value.length, lastModified: this.modified };
  }
}

class MutableDirectory implements ExternalDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MutableFile | MutableDirectory>();
  async *entries(): AsyncIterableIterator<[string, MutableFile | MutableDirectory]> {
    for (const entry of [...this.children.entries()].sort(([a], [b]) => a.localeCompare(b))) yield entry;
  }
}

function mutableHandle(files: Record<string, string>): MutableDirectory {
  const root = new MutableDirectory();
  for (const [path, value] of Object.entries(files)) {
    const parts = path.replaceAll('\\', '/').split('/');
    const name = parts.pop()!;
    let current = root;
    for (const part of parts) {
      const existing = current.children.get(part);
      if (existing instanceof MutableDirectory) current = existing;
      else { const next = new MutableDirectory(); current.children.set(part, next); current = next; }
    }
    current.children.set(name, new MutableFile(value));
  }
  return root;
}

function findFile(root: MutableDirectory, path: string): MutableFile {
  const parts = path.split('/');
  const name = parts.pop()!;
  let current = root;
  for (const part of parts) {
    const next = current.children.get(part);
    if (!(next instanceof MutableDirectory)) throw new Error(`missing directory ${part}`);
    current = next;
  }
  const file = current.children.get(name);
  if (!(file instanceof MutableFile)) throw new Error(`missing file ${path}`);
  return file;
}

describe('Gate 6F injected external-directory reader', () => {
  it('adapts a structural directory handle with deterministic bounded read-only traversal', async () => {
    const root = mutableHandle({ 'nested/z.txt': 'z', 'nested/a.txt': 'a', 'root.md': 'root' });
    const reader = createExternalDirectoryVault(root, { maxEntries: 20, maxDepth: 8, maxFileBytes: 100 });
    expect((await reader.list('')).map((entry) => entry.path)).toEqual(['nested', 'root.md']);
    expect(await reader.walk('nested')).toEqual(['nested/a.txt', 'nested/z.txt']);
    expect((await reader.read('nested/a.txt')).text).toBe('a');
    await expect(reader.read('../outside.md')).rejects.toThrow(/traversal/i);
    await expect(createExternalDirectoryVault(mutableHandle({ 'a': 'a', 'b': 'b', 'c': 'c' }), { maxEntries: 2 }).walk('')).rejects.toThrow(/limit/i);
    expect('requestPermission' in reader).toBe(false);
  });

  it('fails closed for traversal and root-shaped locators across every reader operation', async () => {
    const root = mutableHandle({ 'nested/a.txt': 'a', 'outside.txt': 'outside' });
    const reader = createExternalDirectoryVault(root, { maxEntries: 20, maxDepth: 8, maxFileBytes: 100 });
    const unsafe = ['../outside.txt', 'nested/../outside.txt', 'nested/./a.txt', 'nested/../../outside.txt', 'C:\\temp\\secret.txt', '\\\\server\\share\\secret.txt', 'file:///outside.txt'];
    for (const path of unsafe) {
      await expect(reader.read(path)).rejects.toThrow();
      await expect(reader.list(path)).rejects.toThrow();
      await expect(reader.walk(path)).rejects.toThrow();
      expect(await reader.exists(path)).toBe(false);
    }
    expect(await reader.read('nested/a.txt')).toMatchObject({ path: 'nested/a.txt', text: 'a' });
  });

  it('feeds external mutation, deletion, and failure through the existing refresh stack', async () => {
    const root = mutableHandle(fixtureFiles('vault-basic'));
    const source = createBrowserSource({ directory: root });
    expect(source.mode).toBe('injected');
    const initial = await loadVaultState(source.reader);
    const controller = createRefreshController({ vault: source.reader, initial });
    const policy = createRefreshPolicy({ controller, enabled: false });
    const standup = findFile(root, 'Proxima/tasks/Daily standup.md');
    standup.value = standup.value.replace('Daily standup', 'External standup');
    standup.modified = 1;
    const changed = await policy.trigger('external-signal');
    const changedProjection = createReadOnlyProjection(changed!.snapshot);
    expect(changed?.outcome).toBe('changed');
    expect(changedProjection.state.tasks.some((task) => task.name === 'External standup')).toBe(true);

    const projects = root.children.get('Proxima') as MutableDirectory;
    const projectDir = projects.children.get('projects') as MutableDirectory;
    projectDir.children.delete('Term Calendar.md');
    const deleted = await policy.trigger('manual');
    const deletedProjection = createReadOnlyProjection(deleted!.snapshot);
    expect(deleted?.outcome).toBe('deleted');
    expect(deletedProjection.state.projects.some((project) => project.id === 'proj-term')).toBe(false);

    standup.unreadable = true;
    const failed = await policy.trigger('focus');
    expect(failed?.ok).toBe(false);
    expect(failed?.outcome).toBe('unreadable');
    expect(failed?.snapshot.stale).toBe(true);
    expect(failed?.snapshot.load.state.tasks.some((task) => task.name === 'External standup')).toBe(true);
  });
});
