import type { RecoveryRecord } from './vaultRecovery.js';

export type RecoveryClassification = 'not-applied' | 'effect-present' | 'conflict' | 'already-committed';
export interface RecoveryReconciliation { requestId: string; classification: RecoveryClassification; reason: string; }
export interface RecoveryReadSource {
  read(path: string): Promise<{ revision: string; text: string }>;
  exists(path: string): Promise<boolean>;
  readBinary?(path: string, maxBytes: number): Promise<{ bytes: Uint8Array }>;
}

function fingerprint(bytes: Uint8Array): { size: number; hash: string } {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
  return { size: bytes.byteLength, hash: (value >>> 0).toString(16).padStart(8, '0') };
}

async function bytesAt(reader: RecoveryReadSource, path: string): Promise<Uint8Array | undefined> {
  if (reader.readBinary) { try { return (await reader.readBinary(path, 4 * 1024 * 1024)).bytes; } catch { return undefined; } }
  try { return new TextEncoder().encode((await reader.read(path)).text); } catch { return undefined; }
}

/** Read-only classification of prepared entries; never restores or mutates files. */
export async function classifyRecoveryRecord(record: RecoveryRecord, reader: RecoveryReadSource): Promise<RecoveryReconciliation> {
  if (record.status === 'committed') return { requestId: record.requestId, classification: 'already-committed', reason: 'journal already committed' };
  const prior = record.priorFingerprint ?? fingerprint(record.bytes);
  const source = await bytesAt(reader, record.path);
  const sourceFp = source ? fingerprint(source) : undefined;
  if (record.operation === 'delete') {
    if (!sourceFp) return { requestId: record.requestId, classification: 'effect-present', reason: 'source absent' };
    if (sourceFp.hash === prior.hash && sourceFp.size === prior.size) return { requestId: record.requestId, classification: 'not-applied', reason: 'original bytes remain' };
    return { requestId: record.requestId, classification: 'conflict', reason: 'source replaced by peer' };
  }
  if (record.operation === 'update') {
    if (!sourceFp) return { requestId: record.requestId, classification: 'conflict', reason: 'source missing' };
    const intended = record.intendedFingerprint ?? (record.nextBytes ? fingerprint(record.nextBytes) : undefined);
    if (intended && sourceFp.hash === intended.hash && sourceFp.size === intended.size) return { requestId: record.requestId, classification: 'effect-present', reason: 'intended bytes present' };
    if (sourceFp.hash === prior.hash && sourceFp.size === prior.size) return { requestId: record.requestId, classification: 'not-applied', reason: 'original bytes remain' };
    return { requestId: record.requestId, classification: 'conflict', reason: 'third-party bytes present' };
  }
  const destination = record.destination;
  const destinationBytes = destination ? await bytesAt(reader, destination) : undefined;
  const destinationFp = destinationBytes ? fingerprint(destinationBytes) : undefined;
  if (!sourceFp && destinationFp && destinationFp.hash === prior.hash && destinationFp.size === prior.size) return { requestId: record.requestId, classification: 'effect-present', reason: 'source absent and destination has original bytes' };
  if (sourceFp && !destinationFp && sourceFp.hash === prior.hash && sourceFp.size === prior.size) return { requestId: record.requestId, classification: 'not-applied', reason: 'source remains and destination absent' };
  return { requestId: record.requestId, classification: 'conflict', reason: 'source/destination state is ambiguous or peer-modified' };
}
