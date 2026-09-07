import type { RecoveryRecord } from './vaultRecovery.js';

export type RecoveryClassification = 'not-applied' | 'effect-present' | 'conflict' | 'already-committed';
export interface RecoveryReconciliation { requestId: string; classification: RecoveryClassification; reason: string; }
export interface RecoveryReadSource {
  read(path: string): Promise<{ revision: string; text: string }>;
  exists(path: string): Promise<boolean>;
  readBinary?(path: string, maxBytes: number): Promise<{ bytes: Uint8Array }>;
}

type ObservedBytes = { state: 'absent' } | { state: 'present'; bytes: Uint8Array } | { state: 'unreadable' };
function equalBytes(a: Uint8Array, b: Uint8Array): boolean { if (a.byteLength !== b.byteLength) return false; for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false; return true; }

async function bytesAt(reader: RecoveryReadSource, path: string): Promise<ObservedBytes> {
  let exists: boolean; try { exists = await reader.exists(path); } catch { return { state: 'unreadable' }; }
  if (!exists) return { state: 'absent' };
  if (reader.readBinary) { try { return { state: 'present', bytes: (await reader.readBinary(path, 4 * 1024 * 1024)).bytes }; } catch { return { state: 'unreadable' }; } }
  try { return { state: 'present', bytes: new TextEncoder().encode((await reader.read(path)).text) }; } catch { return { state: 'unreadable' }; }
}

/** Read-only classification of prepared entries; never restores or mutates files. */
export async function classifyRecoveryRecord(record: RecoveryRecord, reader: RecoveryReadSource): Promise<RecoveryReconciliation> {
  if (record.status === 'committed') return { requestId: record.requestId, classification: 'already-committed', reason: 'journal already committed' };
  const source = await bytesAt(reader, record.path);
  if (record.operation === 'delete') {
    if (source.state === 'absent') return { requestId: record.requestId, classification: 'effect-present', reason: 'source absent' };
    if (source.state === 'unreadable') return { requestId: record.requestId, classification: 'conflict', reason: 'source unreadable' };
    if (equalBytes(source.bytes, record.bytes)) return { requestId: record.requestId, classification: 'not-applied', reason: 'original bytes remain' };
    return { requestId: record.requestId, classification: 'conflict', reason: 'source replaced by peer' };
  }
  if (record.operation === 'update') {
    if (source.state !== 'present') return { requestId: record.requestId, classification: 'conflict', reason: source.state === 'absent' ? 'source missing' : 'source unreadable' };
    if (record.nextBytes && equalBytes(source.bytes, record.nextBytes)) return { requestId: record.requestId, classification: 'effect-present', reason: 'intended bytes present' };
    if (equalBytes(source.bytes, record.bytes)) return { requestId: record.requestId, classification: 'not-applied', reason: 'original bytes remain' };
    return { requestId: record.requestId, classification: 'conflict', reason: 'third-party bytes present' };
  }
  const destination = record.destination;
  const destinationState = destination ? await bytesAt(reader, destination) : { state: 'unreadable' as const };
  if (source.state === 'unreadable' || destinationState.state === 'unreadable') return { requestId: record.requestId, classification: 'conflict', reason: 'source or destination unreadable' };
  if (source.state === 'absent' && destinationState.state === 'present' && equalBytes(destinationState.bytes, record.bytes)) return { requestId: record.requestId, classification: 'effect-present', reason: 'source absent and destination has original bytes' };
  if (source.state === 'present' && destinationState.state === 'absent' && equalBytes(source.bytes, record.bytes)) return { requestId: record.requestId, classification: 'not-applied', reason: 'source remains and destination absent' };
  return { requestId: record.requestId, classification: 'conflict', reason: 'source/destination state is ambiguous or peer-modified' };
}
