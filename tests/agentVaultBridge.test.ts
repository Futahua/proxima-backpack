import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { copyFixtureToDisk, removeDiskFixture } from './test-disk-vault.js';
import { fixtureFiles } from './fixtures.js';

async function listening(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge did not start')), 5_000);
    child.stdout?.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`bridge exited ${code}`)); } });
  });
}

describe('loopback read-only automation bridge', () => {
  it('serves bounded read/list/walk and rejects write methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-bridge-'));
    const port = 4197;
    const child = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      await listening(child);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toMatchObject({ ok: true, readOnly: true });
      const list = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=${encodeURIComponent('Proxima/tasks')}`);
      expect((await list.json()).entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file' })]));
      const read = await fetch(`http://127.0.0.1:${port}/api/vault/read?path=${encodeURIComponent('Proxima/tasks/Write fixture vault.md')}`);
      expect(await read.json()).toMatchObject({ path: 'Proxima/tasks/Write fixture vault.md', revision: expect.any(String) });
      const write = await fetch(`http://127.0.0.1:${port}/api/vault/read`, { method: 'POST' });
      expect(write.status).toBe(405);
      const traversal = await fetch(`http://127.0.0.1:${port}/api/vault/read?path=${encodeURIComponent('../secret')}`);
      expect(traversal.status).toBe(400);
    } finally { child.kill(); await removeDiskFixture(root); }
  });
});
