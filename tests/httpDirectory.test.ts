import { describe, expect, it, vi } from 'vitest';
import { createHttpBinaryReader, createHttpDirectoryHandle, createHttpPresenceProbe } from '../src/adapters/httpDirectory.js';
import { createExternalDirectoryVault } from '../src/adapters/externalDirectoryVault.js';

/** The bridge refuses a caller without a token, and the adapter carries it in the URL fragment. */
const TOKEN = 'http-directory-suite-token';
const BRIDGE = `http://127.0.0.1:4174#token=${TOKEN}`;

describe('zero-click loopback directory adapter', () => {
  it('maps bounded bridge list/read calls into the existing structural handle seam', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/list')) {
        const path = new URL(url).searchParams.get('path') ?? '';
        const entries = path === '' ? [{ path: 'Proxima', kind: 'directory' }] : path === 'Proxima' ? [{ path: 'Proxima/note.md', kind: 'file' }] : [];
        return new Response(JSON.stringify({ entries }), { status: 200 });
      }
      if (url.pathname.endsWith('/read')) return new Response(JSON.stringify({ path: 'Proxima/note.md', text: 'hello', size: 5, modifiedAt: '2026-09-06T00:00:00.000Z', revision: 'r1' }), { status: 200 });
      throw new Error('unexpected bridge operation');
    }) as typeof fetch;
    try {
      const root = createHttpDirectoryHandle(BRIDGE);
      const entries = [];
      for await (const [name, handle] of root.entries()) entries.push({ name, handle });
      expect(entries[0]?.name).toBe('Proxima');
      const vault = createExternalDirectoryVault(root);
      await expect(vault.read('Proxima/note.md')).resolves.toMatchObject({ text: 'hello', revision: '2026-09-06T00:00:00.000Z:5:4f9f2cab' });
    } finally { globalThis.fetch = original; }
  });

  it('rejects non-loopback bridge URLs before any request', () => {
    expect(() => createHttpDirectoryHandle('https://example.com/bridge')).toThrow(/loopback/i);
  });

  it('refuses a bridge URL with no session token before any request', () => {
    // The bridge would answer `unauthorized`, and the adapter says why instead: a URL carrying no
    // credential is a configuration error, not a request to make.
    expect(() => createHttpDirectoryHandle('http://127.0.0.1:4174')).toThrow(/session token/i);
    expect(() => createHttpDirectoryHandle('http://127.0.0.1:4174#other=1')).toThrow(/session token/i);
  });

  it('uses only credentialless GET requests and rejects foreign URLs before fetch', async () => {
    const original = globalThis.fetch;
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ input: String(input), init });
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/list')) return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      if (path.endsWith('/presence')) return new Response(JSON.stringify({ presence: 'present' }), { status: 200 });
      if (path.endsWith('/read-binary')) return new Response(JSON.stringify({ path: 'x.png', base64: 'AA==', size: 1, modifiedAt: new Date(0).toISOString(), revision: 'r1' }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      expect(() => createHttpDirectoryHandle('https://example.com/bridge')).toThrow(/loopback/i);
      expect(calls).toHaveLength(0);
      const root = createHttpDirectoryHandle(BRIDGE);
      for await (const _entry of root.entries()) { /* exercise list */ }
      await createHttpPresenceProbe(`http://localhost:4174#token=${TOKEN}`)('Proxima/tasks');
      await createHttpBinaryReader(`http://[::1]:4174#token=${TOKEN}`)('x.png', 100);
      expect(calls.length).toBe(3);
      expect(calls.every(({ init }) => init?.method === 'GET' && init.credentials === 'omit' && init.redirect === 'error')).toBe(true);
      // Every request carries the run's bearer token, and no request URL carries it: the credential
      // lives in the fragment, which fetch never puts on the wire.
      expect(calls.every(({ init }) => new Headers(init?.headers).get('authorization') === `Bearer ${TOKEN}`)).toBe(true);
      expect(calls.every(({ input }) => !input.includes(TOKEN))).toBe(true);
    } finally { globalThis.fetch = original; }
  });
});
