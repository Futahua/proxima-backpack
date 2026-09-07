import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { fixedClock } from '../src/domain/clock.js';
import { reconcileOwnerRecoveryOnStartup } from '../src/app/ownerRecoveryStartup.js';
import { createDurableRecoveryStore, type RecoveryRecord } from '../src/app/vaultRecovery.js';

function bytes(value: string) { return new TextEncoder().encode(value); }
function backend() {
  let raw: string | undefined;
  return { backend: { async read() { return raw; }, async write(value: string) { raw = value; } }, read: () => raw };
}
function record(requestId: string, status: RecoveryRecord['status'] = 'prepared'): RecoveryRecord {
  return { requestId, operation: 'update', path: `${requestId}.md`, revision: `${requestId}.md@1`, bytes: bytes('old'), nextBytes: bytes('new'), createdAt: 'now', status };
}

describe('Gate 13C3A autonomous startup recovery', () => {
  it('classifies every unresolved record, persists safe status, and never writes vault bytes', async () => {
    const io = backend();
    const first = createDurableRecoveryStore(io.backend);
    await first.save(record('effect')); await first.save(record('not-applied')); await first.save(record('peer')); await first.save(record('done', 'committed'));
    const vault = createMemoryVault({ 'effect.md': 'new', 'not-applied.md': 'old', 'peer.md': 'third-party', 'done.md': 'new' });
    const before = await vault.read('effect.md');
    const restarted = createDurableRecoveryStore(io.backend); const result = await reconcileOwnerRecoveryOnStartup(restarted, vault);
    expect(result).toMatchObject({ mutationAuthority: 'blocked', unresolved: 3 });
    expect(result.outcomes.map((item) => item.status)).toEqual(['committed', 'recovered', 'blocked', 'already-committed']);
    expect(restarted.list().map((item) => item.status)).toEqual(['committed', 'recovered', 'blocked', 'committed']);
    expect(await vault.read('effect.md')).toEqual(before);
  });

  it('blocks mutation authority when journal load or status persistence fails', async () => {
    const malformed = createDurableRecoveryStore({ async read() { return '{bad'; }, async write() {} });
    const blocked = await reconcileOwnerRecoveryOnStartup(malformed, createMemoryVault({}));
    expect(blocked.mutationAuthority).toBe('blocked');
    const store = createDurableRecoveryStore({ async read() { return undefined; }, async write() { throw new Error('disk full'); } });
    await expect(store.save(record('x'))).rejects.toThrow('disk full');
    expect((await reconcileOwnerRecoveryOnStartup(store, createMemoryVault({}))).mutationAuthority).toBe('blocked');
  });

  it('is idempotent after the first startup pass', async () => {
    const io = backend(); const first = createDurableRecoveryStore(io.backend);
    await first.save(record('effect')); const vault = createMemoryVault({ 'effect.md': 'new' });
    const restarted = createDurableRecoveryStore(io.backend); const once = await reconcileOwnerRecoveryOnStartup(restarted, vault);
    const twice = await reconcileOwnerRecoveryOnStartup(restarted, vault);
    expect(once.mutationAuthority).toBe('available'); expect(twice).toMatchObject({ mutationAuthority: 'available', unresolved: 0 });
    expect(twice.outcomes[0]).toMatchObject({ status: 'already-committed', classification: 'already-committed' });
  });
});
