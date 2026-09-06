import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { VaultEntry, VaultFile, VaultReader } from '../src/ports/vault.js';

function normalise(path: string): string {
  const value = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (value.split('/').some((part) => part === '..' || part === '.')) throw new Error('disk path traversal is not allowed');
  return value;
}

function hash(text: string): string {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}

function within(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, normalise(path));
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (target !== absoluteRoot && !target.startsWith(prefix)) throw new Error('disk path escapes fixture root');
  return target;
}

export function createDiskVault(root: string): VaultReader {
  async function entries(directory: string): Promise<VaultEntry[]> {
    const relativeDirectory = normalise(directory);
    const absoluteDirectory = within(root, relativeDirectory);
    const result: VaultEntry[] = [];
    for (const entry of (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      result.push({ path: relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
    }
    return result;
  }
  return {
    list: entries,
    async walk(directory) {
      const result: string[] = [];
      for (const entry of await entries(directory)) if (entry.kind === 'file') result.push(entry.path); else result.push(...await this.walk(entry.path));
      return result.sort();
    },
    async exists(path) {
      try { await stat(within(root, path)); return true; } catch { return false; }
    },
    async read(path): Promise<VaultFile> {
      const relativePath = normalise(path);
      const absolutePath = within(root, relativePath);
      const metadata = await stat(absolutePath);
      if (!metadata.isFile()) throw new Error(`disk path is not a file: ${path}`);
      const text = await readFile(absolutePath, 'utf8');
      const modifiedAt = metadata.mtime.toISOString();
      return { path: relativePath, text, size: metadata.size, modifiedAt, revision: `${modifiedAt}:${metadata.size}:${hash(text)}` };
    },
  };
}

export async function copyFixtureToDisk(files: Record<string, string>, root: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const target = within(root, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
}

export async function removeDiskFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
