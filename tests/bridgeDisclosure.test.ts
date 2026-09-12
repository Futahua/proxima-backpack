import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { copyFixtureToDisk, removeDiskFixture } from './test-disk-vault.js';
import { fixtureFiles } from './fixtures.js';

/**
 * The bridge is the one component that will be pointed at the creator's real vault,
 * so what it declines to say matters as much as what it serves. These tests pin the
 * two disclosure rules: a response never names the root, and a page that is not
 * loopback is never granted permission to read one.
 */

/**
 * How long a spawned bridge gets to announce itself.
 *
 * These cases start a real child process and wait for it to print `listening`, and under a full parallel suite
 * - where every other test file is competing for the same machine - thirty seconds was not enough: this file
 * failed twice in one session at ~30.0 s while passing in under half a second on its own. The budget is a
 * safety bound, not a measurement, so it is generous on purpose.
 */
const BRIDGE_START_BUDGET_MS = 90_000;
const BOUNDED_CODES = new Set([
  'invalid-path',
  'path-escapes-root',
  'symlink-rejected',
  'entry-bound-exceeded',
  'depth-bound-exceeded',
  'file-bound-exceeded',
  'not-found',
  'not-a-directory',
  'not-permitted',
  'source-unavailable',
  'unknown-operation',
  'not-found-route',
  'read-only-bridge',
  'host-not-allowed',
]);

/** A GET that can set headers fetch() reserves, such as Host. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false }, (response) => {
      const chunks: string[] = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: chunks.join('') }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function listening(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // This bound is about a child process starting at all, not about how fast the bridge
    // ought to be: the assertions below are about what it discloses, not how quickly. Five
    // seconds was tight enough that a parallel run, with the rest of the suite compiling and
    // running alongside, could fail here while the same file passed alone in half a second —
    // a flake that makes the whole suite untrustworthy. Thirty seconds still fails a bridge
    // that never starts, and no longer fails one that is merely queued behind other work.
    const timer = setTimeout(() => reject(new Error('bridge did not start')), BRIDGE_START_BUDGET_MS);
    child.stdout?.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`bridge exited ${code}`)); } });
  });
}

/** One token for this suite: the bridge refuses to start without one, and every request carries it. */
const TOKEN = 'bridge-disclosure-suite-token';
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

describe('bridge disclosure bounds', () => {
  it('never emits the configured root, and answers only in bounded codes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-disclosure-'));
    const port = 4198;
    const child = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port), '--token', TOKEN], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    child.stdout?.on('data', (chunk) => stdout.push(String(chunk)));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      await listening(child);

      // A missing path is where the raw errno message used to carry the absolute root.
      const missing = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=NoSuchFolder`, { headers: auth() });
      const missingBody = await missing.text();
      expect(missing.status).toBe(400);
      expect(missingBody).not.toContain(root);
      expect(missingBody).not.toMatch(/ENOENT|scandir|no such file/i);
      expect(BOUNDED_CODES).toContain(JSON.parse(missingBody).error);

      // Every other failure shape must also stay inside the vocabulary.
      const cases = [
        `/api/vault/read?path=${encodeURIComponent('../../secret')}`,
        `/api/vault/read?path=${encodeURIComponent('Proxima')}`,
        `/api/vault/read?path=NoSuchFile.md`,
        `/api/vault/nonsense?path=`,
        `/elsewhere`,
      ];
      for (const path of cases) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: auth() });
        const body = await response.text();
        expect(body).not.toContain(root);
        expect(BOUNDED_CODES).toContain(JSON.parse(body).error);
      }

      // The startup banner reports where it listens, never what it exposes.
      expect(stdout.join('')).not.toContain(root);
    } finally { child.kill(); await removeDiskFixture(root); }
  }, BRIDGE_START_BUDGET_MS);

  it('grants read permission to loopback pages only, and refuses a rebound Host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-origin-'));
    const port = 4199;
    const child = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port), '--token', TOKEN], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      await listening(child);

      // Any loopback port, not one hardcoded guess.
      for (const origin of ['http://127.0.0.1:4173', 'http://127.0.0.1:5999', 'http://localhost:8080']) {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { ...auth(), origin } });
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      }

      // A public page reaching the socket gets no permission to read the answer.
      const foreign = await fetch(`http://127.0.0.1:${port}/health`, { headers: { ...auth(), origin: 'https://example.com' } });
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
      expect(foreign.headers.get('vary')).toBe('Origin');

      // DNS rebinding: the packet arrives on loopback while the Host says otherwise.
      // fetch() refuses to send a Host header — it is forbidden to script — so this
      // has to go out over a raw request, or the check is never actually exercised.
      // The token is supplied on both raw probes, so what the first one proves is the Host check
      // refusing an otherwise-authenticated caller rather than authentication refusing everyone.
      const rebound = await rawGet(port, '/health', { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` });
      expect(rebound.status).toBe(403);
      expect(JSON.parse(rebound.body).error).toBe('host-not-allowed');

      const honest = await rawGet(port, '/health', { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` });
      expect(honest.status).toBe(200);
    } finally { child.kill(); await removeDiskFixture(root); }
  }, BRIDGE_START_BUDGET_MS);

  it('refuses binary reads through an intermediate symlink component', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-intermediate-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'proxima-intermediate-outside-'));
    const port = 4200;
    const child = spawn(process.execPath, ['tools/agent-vault-bridge.mjs', '--root', root, '--port', String(port), '--token', TOKEN], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await mkdir(join(outside, 'attachments'), { recursive: true });
      await writeFile(join(outside, 'attachments', 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      let linked = false;
      for (const type of ['junction', 'dir'] as const) {
        try { await symlink(join(outside, 'attachments'), join(root, 'inside-link'), type); linked = true; break; } catch { /* try the other Windows link flavour */ }
      }
      if (!linked) throw new Error('cannot create a directory link on this machine');
      await listening(child);
      const response = await fetch(`http://127.0.0.1:${port}/api/vault/read-binary?path=${encodeURIComponent('inside-link/secret.png')}&maxBytes=1000`, { headers: auth() });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('symlink-rejected');
      const listing = await fetch(`http://127.0.0.1:${port}/api/vault/list?path=${encodeURIComponent('inside-link')}`, { headers: auth() });
      expect(listing.status).toBe(400);
      expect((await listing.json()).error).toBe('symlink-rejected');
    } finally { child.kill(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  }, BRIDGE_START_BUDGET_MS);
});
