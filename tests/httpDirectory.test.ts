import { describe, expect, it, vi } from 'vitest';
import { createHttpDirectoryHandle } from '../src/adapters/httpDirectory.js';
import { createExternalDirectoryVault } from '../src/adapters/externalDirectoryVault.js';

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
      const root = createHttpDirectoryHandle('http://127.0.0.1:4174');
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
});
