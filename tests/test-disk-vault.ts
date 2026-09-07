import { access, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { DirectoryPresence, VaultEntry, VaultFile, VaultReader, VaultWriter, VaultMutationResult } from '../src/ports/vault.js';

export interface DiskVaultOptions {
  /** Test-only hook for deterministic permission-denied coverage on Windows/CI. */
  readText?: (absolutePath: string) => Promise<string>;
  /** Barrier used by adversarial tests after the revision check and before commit. */
  beforeCommit?: (operation: 'create' | 'update' | 'move' | 'delete', relativePath: string) => Promise<void>;
}

function normalise(path: string): string {
  const value = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (value.split('/').some((part) => part === '..' || part === '.')) throw new Error('disk path traversal is not allowed');
  return value;
}

function hash(text: string | Uint8Array): string {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ (typeof text === 'string' ? text.charCodeAt(index) : text[index]!), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}

function within(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, normalise(path));
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (target !== absoluteRoot && !target.startsWith(prefix)) throw new Error('disk path escapes fixture root');
  return target;
}

export function createDiskVault(root: string, options: DiskVaultOptions = {}): VaultReader & VaultWriter {
  async function entries(directory: string): Promise<VaultEntry[]> {
    const relativeDirectory = normalise(directory);
    const absoluteDirectory = within(root, relativeDirectory);
    const result: VaultEntry[] = [];
    for (const entry of (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      result.push({ path: relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
    }
    return result;
  }
  const current = async (path: string) => {
    const relativePath = normalise(path); const absolutePath = within(root, relativePath); const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new Error(`disk path is not a file: ${path}`);
    const bytes = new Uint8Array(await readFile(absolutePath));
    return { absolutePath, relativePath, metadata, bytes, revision: `${metadata.mtime.toISOString()}:${metadata.size}:${hash(bytes)}` };
  };
  const bounded = async (path: string, maxBytes: number) => {
    const relativePath = normalise(path); const absolutePath = within(root, relativePath); const handle = await open(absolutePath, 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error(`disk path is not a file: ${path}`);
      if (metadata.size > maxBytes) throw new Error('disk vault byte size limit exceeded');
      const buffer = new Uint8Array(Math.min(maxBytes, Number(metadata.size)) + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) throw new Error('disk vault byte size limit exceeded');
      const bytes = buffer.slice(0, offset); const revision = `${metadata.mtime.toISOString()}:${metadata.size}:${hash(bytes)}`;
      return { absolutePath, relativePath, metadata, bytes, revision };
    } finally { await handle.close(); }
  };
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
    /** Precise enough to separate genuine absence from an unreadable directory. */
    async presence(directory): Promise<DirectoryPresence> {
      try {
        await lstat(within(root, directory));
        return 'present';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
        if (code === 'EACCES' || code === 'EPERM') return 'present';
        return 'unknown';
      }
    },
    async read(path, maxChars): Promise<VaultFile> {
      if (maxChars !== undefined) {
        const boundedFile = await bounded(path, maxChars);
        const text = new TextDecoder().decode(boundedFile.bytes);
        if (text.length > maxChars) throw new Error('disk vault text size limit exceeded');
        return { path: boundedFile.relativePath, text, size: boundedFile.bytes.byteLength, modifiedAt: boundedFile.metadata.mtime.toISOString(), revision: boundedFile.revision };
      }
      const relativePath = normalise(path);
      const absolutePath = within(root, relativePath);
      const metadata = await stat(absolutePath);
      if (!metadata.isFile()) throw new Error(`disk path is not a file: ${path}`);
      const text = await (options.readText ? options.readText(absolutePath) : readFile(absolutePath, 'utf8'));
      const modifiedAt = metadata.mtime.toISOString();
      return { path: relativePath, text, size: metadata.size, modifiedAt, revision: `${modifiedAt}:${metadata.size}:${hash(new TextEncoder().encode(text))}` };
    },
    async readBinary(path, maxBytes) {
      const currentFile = await bounded(path, maxBytes);
      return { path: currentFile.relativePath, bytes: new Uint8Array(currentFile.bytes), size: currentFile.bytes.byteLength, modifiedAt: currentFile.metadata.mtime.toISOString(), revision: currentFile.revision };
    },
    async createIfAbsent(path, bytes): Promise<VaultMutationResult> {
      const relativePath = normalise(path); const target = within(root, relativePath);
      await mkdir(resolve(target, '..'), { recursive: true });
      if (options.beforeCommit) await options.beforeCommit('create', relativePath);
      try { await writeFile(target, bytes, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already-exists' }; throw error; }
      const after = await current(relativePath); return { ok: true, revision: after.revision };
    },
    async writeIfUnchanged(path, bytes, expectedRevision): Promise<VaultMutationResult> {
      let before; try { before = await current(path); } catch { return { ok: false, reason: 'missing' }; }
      if (before.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: before.revision };
      if (options.beforeCommit) await options.beforeCommit('update', before.relativePath);
      let checked; try { checked = await current(path); } catch { return { ok: false, reason: 'missing' }; }
      if (checked.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: checked.revision };
      await writeFile(checked.absolutePath, bytes);
      const after = await current(path); return { ok: true, revision: after.revision };
    },
    async moveIfUnchanged(path, destination, expectedRevision): Promise<VaultMutationResult> {
      let before; try { before = await current(path); } catch { return { ok: false, reason: 'missing' }; }
      if (before.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: before.revision };
      const target = within(root, destination);
      try { await access(target); return { ok: false, reason: 'destination-exists' }; } catch { /* absent */ }
      if (options.beforeCommit) await options.beforeCommit('move', before.relativePath);
      let checked; try { checked = await current(path); } catch { return { ok: false, reason: 'missing' }; }
      if (checked.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: checked.revision };
      try { await access(target); return { ok: false, reason: 'destination-exists' }; } catch { /* absent */ }
      await mkdir(resolve(target, '..'), { recursive: true }); await rename(checked.absolutePath, target);
      const after = await current(destination); return { ok: true, revision: after.revision };
    },
    async deleteIfUnchanged(path, expectedRevision): Promise<VaultMutationResult> {
      let before; try { before = await current(path); } catch { return { ok: false, reason: 'missing' }; }
      if (before.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: before.revision };
      if (options.beforeCommit) await options.beforeCommit('delete', before.relativePath);
      let checked; try { checked = await current(path); } catch { return { ok: false, reason: 'missing' }; }
      if (checked.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: checked.revision };
      await unlink(checked.absolutePath); return { ok: true, revision: `${checked.relativePath}@deleted` };
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
