import type { VaultEntry, VaultFile, VaultReader } from '../ports/vault.js';

/** Minimal structural subset shared by browser OPFS and test doubles. */
export interface OpfsFileHandleLike { kind: 'file'; getFile(): Promise<{ text(): Promise<string>; size: number; lastModified: number }> }
export interface OpfsDirectoryHandleLike { kind: 'directory'; readonly name?: string; entries(): AsyncIterableIterator<[string, OpfsHandleLike]> }
export type OpfsHandleLike = OpfsFileHandleLike | OpfsDirectoryHandleLike;

export interface OpfsVaultOptions {
  maxEntries?: number;
  maxDepth?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

function normalise(path: string): string {
  const value = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (value.split('/').some((part) => part === '..' || part === '.')) throw new Error('OPFS path traversal is not allowed');
  return value;
}

function hash(text: string): string {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}

async function childDirectory(root: OpfsDirectoryHandleLike, path: string): Promise<OpfsDirectoryHandleLike> {
  let current = root;
  for (const part of normalise(path).split('/').filter(Boolean)) {
    let next: OpfsDirectoryHandleLike | undefined;
    for await (const [name, handle] of current.entries()) if (name === part && handle.kind === 'directory') next = handle;
    if (!next) throw new Error(`OPFS directory not found: ${path}`);
    current = next;
  }
  return current;
}

async function childFile(root: OpfsDirectoryHandleLike, path: string): Promise<OpfsFileHandleLike> {
  const parts = normalise(path).split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error('OPFS file path is empty');
  const directory = await childDirectory(root, parts.join('/'));
  for await (const [entryName, handle] of directory.entries()) if (entryName === name && handle.kind === 'file') return handle;
  throw new Error(`OPFS file not found: ${path}`);
}

export function createOpfsVault(root: OpfsDirectoryHandleLike, options: OpfsVaultOptions = {}): VaultReader {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH));
  const maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  async function list(directory: string): Promise<VaultEntry[]> {
    const handle = await childDirectory(root, directory);
    const entries: VaultEntry[] = [];
    for await (const [name, child] of handle.entries()) {
      if (entries.length >= maxEntries) throw new Error('OPFS directory entry limit exceeded');
      entries.push({ path: `${normalise(directory) ? `${normalise(directory)}/` : ''}${name}`, kind: child.kind });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async function walk(directory: string, depth = 0, budget = { count: 0 }): Promise<string[]> {
    if (depth > maxDepth) throw new Error('OPFS directory depth limit exceeded');
    const entries = await list(directory);
    const files: string[] = [];
    for (const entry of entries) {
      budget.count += 1;
      if (budget.count > maxEntries) throw new Error('OPFS recursive entry limit exceeded');
      if (entry.kind === 'file') files.push(entry.path); else files.push(...await walk(entry.path, depth + 1, budget));
    }
    return files.sort();
  }
  return {
    list,
    async walk(directory) { return walk(directory); },
    async exists(path) { try { await childFile(root, path); return true; } catch { try { await childDirectory(root, path); return true; } catch { return false; } } },
    async read(path): Promise<VaultFile> {
      const normalised = normalise(path);
      const file = await childFile(root, normalised);
      const data = await file.getFile();
      if (data.size > maxFileBytes) throw new Error('OPFS file size limit exceeded');
      const modifiedAt = new Date(data.lastModified || 0).toISOString();
      const text = await data.text();
      if (text.length > maxFileBytes) throw new Error('OPFS file size limit exceeded');
      return { path: normalised, text, size: data.size, modifiedAt, revision: `${modifiedAt}:${data.size}:${hash(text)}` };
    },
  };
}
