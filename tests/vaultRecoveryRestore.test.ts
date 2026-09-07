import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { restoreCommittedRecovery } from '../src/app/vaultRecoveryRestore.js';
import { createMemoryRecoveryStore, type RecoveryRecord } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';

const enc = (value: string) => new TextEncoder().encode(value);
function store() { return createMemoryRecoveryStore(fixedClock('2026-09-08T00:00:00.000Z')); }

describe('Gate 13C3B conditional recovery restore', () => {
  it('conditionally restores update bytes and is idempotent', async () => {
    const vault = createMemoryVault({ 'task.md': 'new' }); const recovery = store();
    const record: RecoveryRecord = { requestId: 'u', operation: 'update', path: 'task.md', revision: 'task.md@1', bytes: enc('old'), nextBytes: enc('new'), createdAt: 'now', status: 'committed' };
    await recovery.save(record);
    const first = await restoreCommittedRecovery(record, vault, vault, recovery);
    expect(first.outcome).toBe('recovered'); expect((await vault.read('task.md')).text).toBe('old');
    expect((await recovery.list())[0]?.status).toBe('recovered');
    expect((await restoreCommittedRecovery({ ...record, status: 'recovered' }, vault, vault, recovery)).outcome).toBe('already-recovered');
  });

  it('refuses peer edits and missing intended evidence', async () => {
    const recovery = store(); const peer = createMemoryVault({ 'task.md': 'peer' });
    const record: RecoveryRecord = { requestId: 'u', operation: 'update', path: 'task.md', revision: 'task.md@1', bytes: enc('old'), nextBytes: enc('new'), createdAt: 'now', status: 'committed' };
    expect((await restoreCommittedRecovery(record, peer, peer, recovery)).outcome).toBe('blocked');
    expect((await restoreCommittedRecovery({ ...record, nextBytes: undefined }, createMemoryVault({ 'task.md': 'new' }), peer, recovery)).outcome).toBe('blocked');
  });

  it('recreates a deleted file only while absent, and blocks peer recreation', async () => {
    const recovery = store(); const missing = createMemoryVault({});
    const record: RecoveryRecord = { requestId: 'd', operation: 'delete', path: 'task.md', revision: 'task.md@1', bytes: enc('old'), createdAt: 'now', status: 'committed' };
    expect((await restoreCommittedRecovery(record, missing, missing, recovery)).outcome).toBe('recovered');
    expect((await missing.read('task.md')).text).toBe('old');
    const peer = createMemoryVault({ 'task.md': 'peer' });
    expect((await restoreCommittedRecovery(record, peer, peer, recovery)).outcome).toBe('blocked');
  });

  it('moves a committed destination back only while bytes and source state are unchanged', async () => {
    const recovery = store(); const moved = createMemoryVault({ 'moved.md': 'old' });
    const record: RecoveryRecord = { requestId: 'm', operation: 'move', path: 'task.md', destination: 'moved.md', revision: 'task.md@1', bytes: enc('old'), createdAt: 'now', status: 'committed' };
    expect((await restoreCommittedRecovery(record, moved, moved, recovery)).outcome).toBe('recovered');
    expect((await moved.read('task.md')).text).toBe('old');
    expect((await restoreCommittedRecovery({ ...record, status: 'committed' }, moved, moved, recovery)).outcome).toBe('already-recovered');
  });
});
