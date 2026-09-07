import type { OpfsDirectoryHandleLike, OpfsFileHandleLike, OpfsHandleLike } from './opfsVault.js';
import { base64ToBytes } from '../domain/imageMedia.js';
import type { DirectoryPresence, VaultBinaryFile } from '../ports/vault.js';

interface BridgeEntry { path: string; kind: 'file' | 'directory' }
interface BridgeFile { path: string; text: string; size: number; modifiedAt: string; revision: string }

function bridgeUrl(baseUrl: string, operation: string, path: string): string {
  const base = new URL(baseUrl);
  assertLoopback(base);
  base.pathname = `/api/vault/${operation}`;
  base.search = `?path=${encodeURIComponent(path)}`;
  return base.toString();
}

function assertLoopback(base: URL): void {
  if (base.hostname !== '127.0.0.1' && base.hostname !== 'localhost' && base.hostname !== '::1') throw new Error('automation bridge must be loopback-only');
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: 'GET', credentials: 'omit' });
  if (!response.ok) throw new Error(`automation bridge request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

function fileHandle(baseUrl: string, path: string): OpfsFileHandleLike {
  return { kind: 'file', async getFile() { const value = await json<BridgeFile>(bridgeUrl(baseUrl, 'read', path)); return { text: async () => value.text, size: value.size, lastModified: Date.parse(value.modifiedAt) || 0 }; } };
}

function directoryHandle(baseUrl: string, path: string, name?: string): OpfsDirectoryHandleLike {
  return { kind: 'directory', name, async *entries(): AsyncIterableIterator<[string, OpfsHandleLike]> { const result = await json<{ entries: BridgeEntry[] }>(bridgeUrl(baseUrl, 'list', path)); for (const entry of result.entries) { const entryName = entry.path.slice(entry.path.lastIndexOf('/') + 1); yield [entryName, entry.kind === 'directory' ? directoryHandle(baseUrl, entry.path, entryName) : fileHandle(baseUrl, entry.path)]; } } };
}

/**
 * Ask the bridge whether a directory is definitively there.
 *
 * The bridge answers from errno, which is the only place that distinction actually
 * exists: a traversal failure alone cannot separate "not there" from "there and
 * unreadable", and treating the second as the first is how an unreadable record
 * directory once passed as a legal empty one.
 */
export function createHttpPresenceProbe(baseUrl: string): (directory: string) => Promise<DirectoryPresence> {
  const base = new URL(baseUrl);
  assertLoopback(base);
  const origin = base.toString().replace(/\/$/, '');
  return async (directory: string) => {
    try {
      const response = await fetch(`${origin}/api/vault/presence?path=${encodeURIComponent(directory)}`, { method: 'GET', credentials: 'omit' });
      if (!response.ok) return 'unknown';
      const body = (await response.json()) as { presence?: unknown };
      return body.presence === 'present' || body.presence === 'missing' ? body.presence : 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

/**
 * Read one file's bytes through the bridge.
 *
 * Base64 is the transport, not the representation: it is decoded here so nothing
 * above this line carries an inflated copy of every image.
 */
export function createHttpBinaryReader(baseUrl: string): (path: string, maxBytes: number) => Promise<VaultBinaryFile> {
  const base = new URL(baseUrl);
  assertLoopback(base);
  const origin = base.toString().replace(/\/$/, '');
  return async (path: string, maxBytes: number): Promise<VaultBinaryFile> => {
    const url = `${origin}/api/vault/read-binary?path=${encodeURIComponent(path)}&maxBytes=${encodeURIComponent(String(maxBytes))}`;
    const response = await fetch(url, { method: 'GET', credentials: 'omit' });
    if (!response.ok) throw new Error(`automation bridge binary read failed: ${response.status}`);
    const body = (await response.json()) as { path?: string; base64?: string; size?: number; modifiedAt?: string; revision?: string };
    const bytes = typeof body.base64 === 'string' ? base64ToBytes(body.base64) : null;
    if (!bytes) throw new Error('automation bridge returned an undecodable body');
    return {
      path: typeof body.path === 'string' ? body.path : path,
      bytes,
      size: typeof body.size === 'number' ? body.size : bytes.length,
      revision: typeof body.revision === 'string' ? body.revision : '',
      modifiedAt: typeof body.modifiedAt === 'string' ? body.modifiedAt : new Date(0).toISOString(),
    };
  };
}

/** Read-only structural directory handle backed by the loopback automation bridge. */
export function createHttpDirectoryHandle(baseUrl: string): OpfsDirectoryHandleLike {
  const base = new URL(baseUrl);
  assertLoopback(base);
  return directoryHandle(base.toString().replace(/\/$/, ''), '');
}
