import type { OpfsDirectoryHandleLike, OpfsFileHandleLike, OpfsHandleLike } from './opfsVault.js';

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

/** Read-only structural directory handle backed by the loopback automation bridge. */
export function createHttpDirectoryHandle(baseUrl: string): OpfsDirectoryHandleLike {
  const base = new URL(baseUrl);
  assertLoopback(base);
  return directoryHandle(base.toString().replace(/\/$/, ''), '');
}
