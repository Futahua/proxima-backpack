import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createDurableRecoveryStore } from '../src/app/vaultRecovery.js';

describe('Gate 13C crash-durable recovery journal', () => {
  it('loads a prepared journal written by a terminated process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-recovery-'));
    const journalPath = join(root, 'recovery.json');
    try {
      const payload = JSON.stringify([{ requestId: 'crash-1', operation: 'update', path: 'task.md', revision: 'r1', bytes: [111, 108, 100], createdAt: '2026-09-07T00:00:00.000Z', status: 'prepared' }]);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv[1], process.argv[2]);`, journalPath, payload], { stdio: 'ignore' });
        child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
      });
      const backend = { async read() { try { return await readFile(journalPath, 'utf8'); } catch { return undefined; } }, async write(value: string) { await writeFile(journalPath, value, 'utf8'); } };
      const store = createDurableRecoveryStore(backend); await store.load();
      expect(store.list()[0]).toMatchObject({ requestId: 'crash-1', status: 'prepared', path: 'task.md' });
      expect(new TextDecoder().decode(store.list()[0]!.bytes)).toBe('old');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
