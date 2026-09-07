import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createDurableRecoveryStore, createMemoryRecoveryStore, reconcileRecoveryEntries } from '../src/app/vaultRecovery.js';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { fixedClock } from '../src/domain/clock.js';
import { classifyRecoveryRecord } from '../src/app/vaultRecoveryReconcile.js';

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

  it('fails closed on oversized or malformed journal input before coercion', async () => {
    const oversized = createDurableRecoveryStore({ async read() { return 'x'.repeat(5000); }, async write() {} }, 4, 100);
    await expect(oversized.load()).rejects.toThrow(/byte limit/i);
    const malformed = createDurableRecoveryStore({ async read() { return JSON.stringify([{ requestId: 'x', operation: 'write-anything', path: 'task.md', revision: 'r', bytes: [999], createdAt: 'now' }]); }, async write() {} });
    await expect(malformed.load()).rejects.toThrow(/invalid recovery record/i);
  });

  it('classifies prepared update/delete/move entries on restart without blind rollback', async () => {
    const vault = createMemoryVault({ 'task.md': 'new', 'old.md': 'old', 'destination.md': 'peer' });
    const store = createMemoryRecoveryStore(fixedClock('2026-09-08T00:00:00.000Z'));
    await store.save({ requestId: 'u', operation: 'update', path: 'task.md', revision: 'task.md@1', bytes: new TextEncoder().encode('old'), nextBytes: new TextEncoder().encode('new'), createdAt: 'now' });
    await store.save({ requestId: 'd', operation: 'delete', path: 'missing.md', revision: 'missing.md@1', bytes: new TextEncoder().encode('old'), createdAt: 'now' });
    await store.save({ requestId: 'm', operation: 'move', path: 'old.md', destination: 'destination.md', revision: 'old.md@1', bytes: new TextEncoder().encode('old'), createdAt: 'now' });
    const outcomes = await reconcileRecoveryEntries(store, vault);
    expect(outcomes).toEqual(expect.arrayContaining([{ requestId: 'u', outcome: 'committed' }, { requestId: 'd', outcome: 'committed' }, { requestId: 'm', outcome: 'blocked' }]));
    expect(store.list().find((record) => record.requestId === 'm')?.status).toBe('blocked');
  });

  it('classifies prepared records from byte fingerprints without writing', async () => {
    const vault = createMemoryVault({ 'task.md': 'new', 'old.md': 'old', 'destination.md': 'peer' });
    const prior = { requestId: 'u', operation: 'update' as const, path: 'task.md', revision: 'task.md@1', bytes: new TextEncoder().encode('old'), nextBytes: new TextEncoder().encode('new'), createdAt: 'now' };
    expect(await classifyRecoveryRecord(prior, vault)).toMatchObject({ classification: 'effect-present' });
    const deleted = { requestId: 'd', operation: 'delete' as const, path: 'missing.md', revision: 'missing.md@1', bytes: new TextEncoder().encode('old'), createdAt: 'now' };
    expect(await classifyRecoveryRecord(deleted, vault)).toMatchObject({ classification: 'effect-present' });
    const move = { requestId: 'm', operation: 'move' as const, path: 'old.md', destination: 'destination.md', revision: 'old.md@1', bytes: new TextEncoder().encode('old'), createdAt: 'now' };
    expect(await classifyRecoveryRecord(move, vault)).toMatchObject({ classification: 'conflict' });
    const unreadable = { exists: async () => true, read: async () => { throw new Error('permission denied'); } };
    expect(await classifyRecoveryRecord(deleted, unreadable)).toMatchObject({ classification: 'conflict' });
    const sameSizePeer = createMemoryVault({ 'peer.md': 'newer' });
    const peerRecord = { requestId: 'p', operation: 'update' as const, path: 'peer.md', revision: 'peer.md@1', bytes: new TextEncoder().encode('old___'), nextBytes: new TextEncoder().encode('target'), createdAt: 'now' };
    expect(await classifyRecoveryRecord(peerRecord, sameSizePeer)).toMatchObject({ classification: 'conflict' });
  });

  it('classifies real child-process mutation phases without rollback', async () => {
    for (const [operation, expectedBefore, expectedAfter] of [['update', 'not-applied', 'effect-present'], ['delete', 'not-applied', 'effect-present'], ['move', 'not-applied', 'effect-present']] as const) {
      for (const phase of ['before', 'after-commit'] as const) {
        const root = await mkdtemp(join(tmpdir(), `proxima-crash-${operation}-`));
        try {
          await writeFile(join(root, 'task.md'), 'original', 'utf8');
          const worker = join(process.cwd(), 'tests', 'helpers', 'mutation-crash-worker.mjs');
          await new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, [worker, root, operation, phase], { stdio: 'ignore' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))); });
          const journal = createDurableRecoveryStore({ async read() { return readFile(join(root, 'recovery.json'), 'utf8'); }, async write(value: string) { await writeFile(join(root, 'recovery.json'), value, 'utf8'); } });
          await journal.load(); const record = journal.list()[0]!; const vault = createDiskVault(root);
          const result = await classifyRecoveryRecord(record, vault);
          expect(result.classification).toBe(phase === 'before' ? expectedBefore : expectedAfter);
        } finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  });
});
