import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { copyFixtureToDisk, removeDiskFixture } from './test-disk-vault.js';
import { fixtureFiles } from './fixtures.js';

/** One token for this suite: the bridge refuses to start without one, and every read carries it. */
const TOKEN = 'agent-vault-bridge-suite-token';
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

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
    const child = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port), '--token', TOKEN], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      await listening(child);
      const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: auth() });
      expect(await health.json()).toMatchObject({ ok: true, readOnly: true });
      const list = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=${encodeURIComponent('Proxima/tasks')}`, { headers: auth() });
      expect((await list.json()).entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file' })]));
      const read = await fetch(`http://127.0.0.1:${port}/api/vault/read?path=${encodeURIComponent('Proxima/tasks/Write fixture vault.md')}`, { headers: auth() });
      expect(await read.json()).toMatchObject({ path: 'Proxima/tasks/Write fixture vault.md', revision: expect.any(String) });
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const write = await fetch(`http://127.0.0.1:${port}/api/vault/read`, { method, headers: auth() });
        expect(write.status).toBe(405);
        expect(await write.json()).toEqual({ error: 'read-only-bridge' });
      }
      for (const operation of ['write', 'create', 'delete', 'rename', 'move']) {
        const mutation = await fetch(`http://127.0.0.1:${port}/api/vault/${operation}?path=Proxima%2Ftasks%2FWrite%20fixture%20vault.md`, { headers: auth() });
        expect(mutation.status).toBe(404);
        expect(await mutation.json()).toEqual({ error: 'unknown-operation' });
      }
      const traversal = await fetch(`http://127.0.0.1:${port}/api/vault/read?path=${encodeURIComponent('../secret')}`, { headers: auth() });
      expect(traversal.status).toBe(400);
    } finally { child.kill(); await removeDiskFixture(root); }
  });

  it('enforces entry, depth and file-size bounds at the transport boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-bridge-bounds-'));
    const port = 4201;
    const wide = join(root, 'wide');
    await mkdir(wide, { recursive: true });
    for (let index = 0; index < 10_001; index += 1) await writeFile(join(wide, `f-${index}.txt`), 'x');
    const deepParts = Array.from({ length: 66 }, (_, index) => `d-${index}`);
    const deep = join(root, ...deepParts);
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'leaf.txt'), 'x');
    await writeFile(join(root, 'oversized.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const child = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port), '--token', TOKEN], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await listening(child);
      const wideResponse = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=wide`, { headers: auth() });
      expect(wideResponse.status).toBe(400);
      expect(await wideResponse.json()).toEqual({ error: 'entry-bound-exceeded' });
      const deepResponse = await fetch(`http://127.0.0.1:${port}/api/vault/walk`, { headers: auth() });
      expect(deepResponse.status).toBe(400);
      expect(await deepResponse.json()).toEqual({ error: 'depth-bound-exceeded' });
      const fileResponse = await fetch(`http://127.0.0.1:${port}/api/vault/read-binary?path=oversized.bin&maxBytes=99999999`, { headers: auth() });
      expect(fileResponse.status).toBe(400);
      expect(await fileResponse.json()).toEqual({ error: 'file-bound-exceeded' });
    } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
  }, 45_000);

  it("refuses a caller without this run's token, and refuses to start without one at all", async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-bridge-auth-'));
    const port = 4211;

    // No token: the bridge does not start at all, rather than serving reads to anything that finds
    // the port. This is the difference between "loopback only" and "authenticated".
    const untokened = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    untokened.stderr?.on('data', () => { /* drained so the child cannot block on a full pipe */ });
    const exitCode = await new Promise<number | null>((resolve) => untokened.once('exit', (code) => resolve(code)));
    expect(exitCode).not.toBe(0);

    const child = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port), '--token', TOKEN], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      await listening(child);

      const anonymous = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=Proxima`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: 'unauthorized' });

      const wrong = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=Proxima`, { headers: { authorization: 'Bearer not-this-run' } });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: 'unauthorized' });

      // The same request with this run's token is served, so the refusals above are authentication
      // rather than a door that is simply closed to everyone.
      const authenticated = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=Proxima`, { headers: auth() });
      expect(authenticated.status).toBe(200);
      expect((await authenticated.json()).entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'directory' })]));

      // And the credential never comes back: not in the body, not in a response header.
      const echoed = await fetch(`http://127.0.0.1:${port}/health`, { headers: auth() });
      expect(await echoed.text()).not.toContain(TOKEN);
      expect(echoed.headers.get('authorization')).toBeNull();
    } finally { child.kill(); await removeDiskFixture(root); }
  }, 45_000);
});
