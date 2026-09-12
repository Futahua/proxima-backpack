import type { OpfsDirectoryHandleLike, OpfsFileHandleLike, OpfsHandleLike } from './opfsVault.js';
import { base64ToBytes } from '../domain/imageMedia.js';
import type { DirectoryPresence, VaultBinaryFile } from '../ports/vault.js';

interface BridgeEntry { path: string; kind: 'file' | 'directory' }
interface BridgeFile { path: string; text: string; size: number; modifiedAt: string; revision: string }

function bridgeUrl(base: URL, operation: string, path: string): string {
  const url = new URL(base.toString());
  url.pathname = `/api/vault/${operation}`;
  url.search = `?path=${encodeURIComponent(path)}`;
  // The token lives in the base's fragment, and a request URL must not carry it: fetch would not
  // send it, but a URL string is exactly what ends up in a log when something goes wrong.
  url.hash = '';
  return url.toString();
}

function assertLoopback(base: URL): void {
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') throw new Error('automation bridge must be loopback-only');
}

/**
 * The session token the bridge requires, carried in the URL's fragment.
 *
 * A fragment is never sent to a server and never appears in a request line, so the credential
 * cannot land in a log or a proxy on the way; the page that was launched with it is the only
 * holder. A bridge URL with no token is refused here rather than attempted unauthenticated - the
 * bridge would answer `unauthorized` anyway, and failing at the boundary says why.
 */
function bridgeToken(base: URL): string {
  const token = new URLSearchParams(base.hash.replace(/^#/, '')).get('token') ?? '';
  if (token.length === 0) throw new Error('automation bridge requires a session token');
  return token;
}

/** A parsed, loopback-checked base: the token is required before any read is attempted. */
function bridgeBase(baseUrl: string): URL {
  const base = new URL(baseUrl);
  assertLoopback(base);
  bridgeToken(base);
  return base;
}

function authHeaders(base: URL): Record<string, string> {
  return { authorization: `Bearer ${bridgeToken(base)}` };
}

async function json<T>(base: URL, url: string): Promise<T> {
  const response = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', headers: authHeaders(base) });
  if (!response.ok) throw new Error(`automation bridge request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

function fileHandle(base: URL, path: string): OpfsFileHandleLike {
  return { kind: 'file', async getFile() { const value = await json<BridgeFile>(base, bridgeUrl(base, 'read', path)); return { text: async () => value.text, size: value.size, lastModified: Date.parse(value.modifiedAt) || 0 }; } };
}

function directoryHandle(base: URL, path: string, name?: string): OpfsDirectoryHandleLike {
  return { kind: 'directory', name, async *entries(): AsyncIterableIterator<[string, OpfsHandleLike]> { const result = await json<{ entries: BridgeEntry[] }>(base, bridgeUrl(base, 'list', path)); for (const entry of result.entries) { const entryName = entry.path.slice(entry.path.lastIndexOf('/') + 1); yield [entryName, entry.kind === 'directory' ? directoryHandle(base, entry.path, entryName) : fileHandle(base, entry.path)]; } } };
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
  const base = bridgeBase(baseUrl);
  const origin = base.toString().replace(/#.*$/, '').replace(/\/$/, '');
  return async (directory: string) => {
    try {
      const response = await fetch(`${origin}/api/vault/presence?path=${encodeURIComponent(directory)}`, { method: 'GET', credentials: 'omit', redirect: 'error', headers: authHeaders(base) });
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
  const base = bridgeBase(baseUrl);
  const origin = base.toString().replace(/#.*$/, '').replace(/\/$/, '');
  return async (path: string, maxBytes: number): Promise<VaultBinaryFile> => {
    const url = `${origin}/api/vault/read-binary?path=${encodeURIComponent(path)}&maxBytes=${encodeURIComponent(String(maxBytes))}`;
    const response = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', headers: authHeaders(base) });
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
  return directoryHandle(bridgeBase(baseUrl), '');
}
