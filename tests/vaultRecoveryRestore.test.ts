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
    await recovery.save(record);
    expect((await restoreCommittedRecovery(record, peer, peer, recovery)).outcome).toBe('blocked');
    await recovery.save({ ...record, requestId: 'u2', nextBytes: undefined });
    expect((await restoreCommittedRecovery({ ...record, requestId: 'u2', nextBytes: undefined }, createMemoryVault({ 'task.md': 'new' }), peer, recovery)).outcome).toBe('blocked');
  });

  it('requires an existing durable record and reports status failure after a committed CAS', async () => {
    const record: RecoveryRecord = { requestId: 'missing', operation: 'update', path: 'task.md', revision: 'task.md@1', bytes: enc('old'), nextBytes: enc('new'), createdAt: 'now', status: 'committed' };
    let writes = 0;
    const vault = createMemoryVault({ 'task.md': 'new' });
    const writer = { ...vault, async writeIfUnchanged(...args: Parameters<typeof vault.writeIfUnchanged>) { writes += 1; return vault.writeIfUnchanged(...args); } };
    expect((await restoreCommittedRecovery(record, vault, writer, store())).outcome).toBe('not-eligible');
    expect(writes).toBe(0);
    const failingStore = { save: async () => {}, list: () => [record] as readonly RecoveryRecord[], updateStatus: async () => { throw new Error('disk full'); } };
    const failed = await restoreCommittedRecovery(record, vault, writer, failingStore);
    expect(failed.outcome).toBe('recovery-required'); expect((await vault.read('task.md')).text).toBe('old');
    const retryStore = store(); await retryStore.save(record);
    expect((await restoreCommittedRecovery(record, vault, vault, retryStore)).outcome).toBe('already-recovered');
  });

  it('recreates a deleted file only while absent, and blocks peer recreation', async () => {
    const recovery = store(); const missing = createMemoryVault({});
    const record: RecoveryRecord = { requestId: 'd', operation: 'delete', path: 'task.md', revision: 'task.md@1', bytes: enc('old'), createdAt: 'now', status: 'committed' };
    await recovery.save(record);
    expect((await restoreCommittedRecovery(record, missing, missing, recovery)).outcome).toBe('recovered');
    expect((await missing.read('task.md')).text).toBe('old');
    const peer = createMemoryVault({ 'task.md': 'peer' });
    const peerRecovery = store(); await peerRecovery.save(record);
    expect((await restoreCommittedRecovery(record, peer, peer, peerRecovery)).outcome).toBe('blocked');
    const unreadable = { exists: async () => true, read: async () => { throw new Error('permission denied'); } };
    const unreadableRecovery = store(); await unreadableRecovery.save({ ...record, requestId: 'du' });
    expect((await restoreCommittedRecovery({ ...record, requestId: 'du' }, unreadable, missing, unreadableRecovery)).outcome).toBe('blocked');
  });

  it('moves a committed destination back only while bytes and source state are unchanged', async () => {
    const recovery = store(); const moved = createMemoryVault({ 'moved.md': 'old' });
    const record: RecoveryRecord = { requestId: 'm', operation: 'move', path: 'task.md', destination: 'moved.md', revision: 'task.md@1', bytes: enc('old'), createdAt: 'now', status: 'committed' };
    await recovery.save(record);
    expect((await restoreCommittedRecovery(record, moved, moved, recovery)).outcome).toBe('recovered');
    expect((await moved.read('task.md')).text).toBe('old');
    expect((await restoreCommittedRecovery({ ...record, status: 'committed' }, moved, moved, recovery)).outcome).toBe('already-recovered');
  });
});
