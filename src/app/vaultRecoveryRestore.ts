import type { VaultWriter } from '../ports/vault.js';
import type { RecoveryRecord, RecoveryStore } from './vaultRecovery.js';
import type { RecoveryReadSource } from './vaultRecoveryReconcile.js';

export type RecoveryRestoreOutcome = 'recovered' | 'already-recovered' | 'blocked' | 'not-eligible';
export interface RecoveryRestoreResult { requestId: string; outcome: RecoveryRestoreOutcome; reason: string; }

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

type Observed = { state: 'absent' } | { state: 'present'; bytes: Uint8Array } | { state: 'unreadable' };
async function bytesAt(reader: RecoveryReadSource, path: string): Promise<Observed> {
  let exists: boolean;
  try { exists = await reader.exists(path); } catch { return { state: 'unreadable' }; }
  if (!exists) return { state: 'absent' };
  try {
    if (reader.readBinary) { const value = await reader.readBinary(path, 4 * 1024 * 1024); return { state: 'present', bytes: value.bytes }; }
    const value = await reader.read(path); return { state: 'present', bytes: new TextEncoder().encode(value.text) };
  } catch { return { state: 'unreadable' }; }
}

async function revisionAt(reader: RecoveryReadSource, path: string): Promise<string | undefined> {
  try { return (await reader.read(path)).revision; } catch { return undefined; }
}

/** Conditionally restore one committed record using only VaultWriter CAS APIs. */
export async function restoreCommittedRecovery(
  record: RecoveryRecord,
  reader: RecoveryReadSource,
  writer: VaultWriter,
  store?: RecoveryStore,
): Promise<RecoveryRestoreResult> {
  if (record.status === 'recovered') return { requestId: record.requestId, outcome: 'already-recovered', reason: 'journal already recovered' };
  if (record.status !== 'committed') return { requestId: record.requestId, outcome: 'not-eligible', reason: 'only committed records can be restored' };
  const prior = new Uint8Array(record.bytes);
  const source = await bytesAt(reader, record.path);
  const markRecovered = async () => {
    if (!store?.updateStatus) throw new Error('recovery status persistence unavailable');
    await store.updateStatus(record.requestId, 'recovered');
  };
  try {
    if (record.operation === 'update') {
      if (!record.nextBytes) return { requestId: record.requestId, outcome: 'blocked', reason: 'missing intended bytes' };
      if (source.state !== 'present') return { requestId: record.requestId, outcome: 'blocked', reason: source.state === 'absent' ? 'source missing' : 'source unreadable' };
      if (equalBytes(source.bytes, prior)) { await markRecovered(); return { requestId: record.requestId, outcome: 'already-recovered', reason: 'prior bytes already present' }; }
      if (!equalBytes(source.bytes, record.nextBytes)) return { requestId: record.requestId, outcome: 'blocked', reason: 'peer bytes changed' };
      const revision = await revisionAt(reader, record.path);
      if (!revision) return { requestId: record.requestId, outcome: 'blocked', reason: 'source revision unreadable' };
      const result = await writer.writeIfUnchanged(record.path, prior, revision);
      if (!result.ok) return { requestId: record.requestId, outcome: 'blocked', reason: result.reason };
      await markRecovered();
      return { requestId: record.requestId, outcome: 'recovered', reason: 'conditional update restore committed' };
    }
    if (record.operation === 'delete') {
      if (source.state === 'unreadable') return { requestId: record.requestId, outcome: 'blocked', reason: 'source unreadable' };
      if (source.state === 'present') {
        if (equalBytes(source.bytes, prior)) { await markRecovered(); return { requestId: record.requestId, outcome: 'already-recovered', reason: 'prior bytes already present' }; }
        return { requestId: record.requestId, outcome: 'blocked', reason: 'peer recreation or unreadable source' };
      }
      const result = await writer.createIfAbsent(record.path, prior);
      if (!result.ok) return { requestId: record.requestId, outcome: 'blocked', reason: result.reason };
      await markRecovered();
      return { requestId: record.requestId, outcome: 'recovered', reason: 'conditional delete restore committed' };
    }
    if (!record.destination) return { requestId: record.requestId, outcome: 'blocked', reason: 'missing move destination' };
    const destination = await bytesAt(reader, record.destination);
    if (source.state === 'unreadable' || destination.state === 'unreadable') return { requestId: record.requestId, outcome: 'blocked', reason: 'source or destination unreadable' };
    if (source.state === 'present') {
      if (destination.state === 'absent' && equalBytes(source.bytes, prior)) { await markRecovered(); return { requestId: record.requestId, outcome: 'already-recovered', reason: 'prior source already restored' }; }
      return { requestId: record.requestId, outcome: 'blocked', reason: 'source or destination changed' };
    }
    if (destination.state !== 'present' || !equalBytes(destination.bytes, prior)) return { requestId: record.requestId, outcome: 'blocked', reason: 'destination changed or unreadable' };
    const revision = await revisionAt(reader, record.destination);
    if (!revision) return { requestId: record.requestId, outcome: 'blocked', reason: 'destination revision unreadable' };
    const result = await writer.moveIfUnchanged(record.destination, record.path, revision);
    if (!result.ok) return { requestId: record.requestId, outcome: 'blocked', reason: result.reason };
    await markRecovered();
    return { requestId: record.requestId, outcome: 'recovered', reason: 'conditional move restore committed' };
  } catch (error) {
    return { requestId: record.requestId, outcome: 'blocked', reason: error instanceof Error ? error.message.slice(0, 200) : 'restore failed' };
  }
}
