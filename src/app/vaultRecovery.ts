import type { Clock } from '../domain/clock.js';

export interface RecoveryRecord {
  requestId: string;
  operation: 'update' | 'move' | 'delete';
  path: string;
  destination?: string;
  revision: string;
  bytes: Uint8Array;
  nextBytes?: Uint8Array;
  priorFingerprint?: { size: number; hash: string };
  intendedFingerprint?: { size: number; hash: string };
  createdAt: string;
  status?: 'prepared' | 'committed' | 'recovery-required' | 'recovered' | 'blocked';
}

export interface RecoveryStore {
  save(record: RecoveryRecord): Promise<void>;
  markCommitted?(requestId: string): Promise<boolean>;
  updateStatus?(requestId: string, status: RecoveryRecord['status']): Promise<boolean>;
  list(): readonly RecoveryRecord[];
}

export type RecoveryReconciliation = 'committed' | 'recovered' | 'blocked';

/** Reconcile prepared entries against observed filesystem state; never guesses. */
export async function reconcileRecoveryEntries(
  store: RecoveryStore,
  reader: { read(path: string): Promise<{ revision: string; text: string }>; exists(path: string): Promise<boolean> },
): Promise<Array<{ requestId: string; outcome: RecoveryReconciliation }>> {
  const outcomes: Array<{ requestId: string; outcome: RecoveryReconciliation }> = [];
  for (const record of store.list()) {
    if (record.status !== 'prepared' && record.status !== 'recovery-required') continue;
    const sourceExists = await reader.exists(record.path);
    if (record.operation === 'delete') {
      if (!sourceExists) { await store.updateStatus?.(record.requestId, 'committed'); outcomes.push({ requestId: record.requestId, outcome: 'committed' }); continue; }
      const source = await reader.read(record.path);
      const old = new TextDecoder().decode(record.bytes);
      if (source.revision === record.revision && source.text === old) { await store.updateStatus?.(record.requestId, 'recovered'); outcomes.push({ requestId: record.requestId, outcome: 'recovered' }); }
      else { await store.updateStatus?.(record.requestId, 'blocked'); outcomes.push({ requestId: record.requestId, outcome: 'blocked' }); }
      continue;
    }
    if (record.operation === 'move') {
      const destination = record.destination;
      if (!destination) { await store.updateStatus?.(record.requestId, 'blocked'); outcomes.push({ requestId: record.requestId, outcome: 'blocked' }); continue; }
      const destinationExists = await reader.exists(destination);
      if (!sourceExists && destinationExists) { await store.updateStatus?.(record.requestId, 'committed'); outcomes.push({ requestId: record.requestId, outcome: 'committed' }); }
      else if (sourceExists && !destinationExists) { const source = await reader.read(record.path); const old = new TextDecoder().decode(record.bytes); const outcome = source.revision === record.revision && source.text === old ? 'recovered' : 'blocked'; await store.updateStatus?.(record.requestId, outcome); outcomes.push({ requestId: record.requestId, outcome }); }
      else { await store.updateStatus?.(record.requestId, 'blocked'); outcomes.push({ requestId: record.requestId, outcome: 'blocked' }); }
      continue;
    }
    if (!sourceExists) { await store.updateStatus?.(record.requestId, 'blocked'); outcomes.push({ requestId: record.requestId, outcome: 'blocked' }); continue; }
    const source = await reader.read(record.path);
    const old = new TextDecoder().decode(record.bytes);
    if (record.nextBytes && source.text === new TextDecoder().decode(record.nextBytes)) { await store.updateStatus?.(record.requestId, 'committed'); outcomes.push({ requestId: record.requestId, outcome: 'committed' }); }
    else if (source.revision === record.revision && source.text === old) { await store.updateStatus?.(record.requestId, 'recovered'); outcomes.push({ requestId: record.requestId, outcome: 'recovered' }); }
    else { await store.updateStatus?.(record.requestId, 'blocked'); outcomes.push({ requestId: record.requestId, outcome: 'blocked' }); }
  }
  return outcomes;
}

/** Bounded in-process recovery store for fixture/owner-mode tests. */
export function createMemoryRecoveryStore(clock: Clock, capacity = 64): RecoveryStore {
  const records: RecoveryRecord[] = [];
  const max = Math.max(1, Math.floor(capacity));
  return {
    async save(record) {
      records.push({ ...record, status: record.status ?? 'prepared', bytes: new Uint8Array(record.bytes) });
      while (records.length > max) records.shift();
    },
    async markCommitted(requestId) { const record = records.find((candidate) => candidate.requestId === requestId); if (!record) return false; record.status = 'committed'; return true; },
    async updateStatus(requestId, status) { const record = records.find((candidate) => candidate.requestId === requestId); if (!record) return false; record.status = status; return true; },
    list() { return records.map((record) => ({ ...record, bytes: new Uint8Array(record.bytes), ...(record.nextBytes ? { nextBytes: new Uint8Array(record.nextBytes) } : {}) })); },
  };
}

/**
 * Durable journal adapter with storage supplied by the host boundary. The app
 * remains free of Node/OS imports; Papers or a test harness supplies the bounded
 * read/write backend. Records are base64 encoded and never exposed to audit events.
 */
export interface RecoveryJournalBackend { read(): Promise<string | undefined>; write(value: string): Promise<void>; }

export function createDurableRecoveryStore(backend: RecoveryJournalBackend, capacity = 64, maxBytes = 4 * 1024 * 1024): RecoveryStore & { load(): Promise<void> } {
  const records: RecoveryRecord[] = [];
  const maxRecords = Math.max(1, Math.floor(capacity));
  const persist = async () => {
    const payload = JSON.stringify(records.map((record) => ({ ...record, bytes: Array.from(record.bytes), ...(record.nextBytes ? { nextBytes: Array.from(record.nextBytes) } : {}) })));
    if (new TextEncoder().encode(payload).byteLength > maxBytes) throw new Error('recovery journal byte limit exceeded');
    await backend.write(payload);
  };
  return {
    async load() {
      const raw = await backend.read(); if (!raw) return;
      if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('recovery journal byte limit exceeded');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('invalid recovery journal');
      records.splice(0, records.length, ...parsed.slice(-maxRecords).map((value) => {
        if (typeof value !== 'object' || value === null) throw new Error('invalid recovery record');
        const item = value as Record<string, unknown>;
        const validOperation = item.operation === 'update' || item.operation === 'move' || item.operation === 'delete';
        const validStatus = item.status === undefined || item.status === 'prepared' || item.status === 'committed' || item.status === 'recovery-required' || item.status === 'recovered' || item.status === 'blocked';
        const validBytes = Array.isArray(item.bytes) && item.bytes.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255);
        const validNextBytes = item.nextBytes === undefined || (Array.isArray(item.nextBytes) && item.nextBytes.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255));
        const validFp = (value: unknown): value is { size: number; hash: string } => typeof value === 'object' && value !== null && typeof (value as { size?: unknown }).size === 'number' && Number.isInteger((value as { size: number }).size) && (value as { size: number }).size >= 0 && (value as { size: number }).size <= maxBytes && typeof (value as { hash?: unknown }).hash === 'string' && (value as { hash: string }).hash.length <= 32;
        const validStrings = typeof item.requestId === 'string' && item.requestId.length <= 200 && typeof item.path === 'string' && item.path.length <= 260 && typeof item.revision === 'string' && item.revision.length <= 400 && typeof item.createdAt === 'string' && item.createdAt.length <= 80 && (item.destination === undefined || (typeof item.destination === 'string' && item.destination.length <= 260));
        if (!validOperation || !validStatus || !validStrings || !validBytes || !validNextBytes || (item.priorFingerprint !== undefined && !validFp(item.priorFingerprint)) || (item.intendedFingerprint !== undefined && !validFp(item.intendedFingerprint))) throw new Error('invalid recovery record');
        const requestId = item.requestId as string;
        const operation = item.operation as RecoveryRecord['operation'];
        const path = item.path as string;
        const revision = item.revision as string;
        const createdAt = item.createdAt as string;
        const byteValues = item.bytes as number[];
        return { requestId, operation, path, ...(typeof item.destination === 'string' ? { destination: item.destination } : {}), revision, bytes: new Uint8Array(byteValues), ...(Array.isArray(item.nextBytes) ? { nextBytes: new Uint8Array(item.nextBytes as number[]) } : {}), ...(validFp(item.priorFingerprint) ? { priorFingerprint: item.priorFingerprint } : {}), ...(validFp(item.intendedFingerprint) ? { intendedFingerprint: item.intendedFingerprint } : {}), createdAt, status: (item.status ?? 'prepared') as RecoveryRecord['status'] };
      }));
    },
    async save(record) { records.push({ ...record, status: record.status ?? 'prepared', bytes: new Uint8Array(record.bytes) }); while (records.length > maxRecords) records.shift(); await persist(); },
    async markCommitted(requestId) { const record = records.find((candidate) => candidate.requestId === requestId); if (!record) return false; record.status = 'committed'; await persist(); return true; },
    async updateStatus(requestId, status) { const record = records.find((candidate) => candidate.requestId === requestId); if (!record) return false; record.status = status; await persist(); return true; },
    list() { return records.map((record) => ({ ...record, bytes: new Uint8Array(record.bytes), ...(record.nextBytes ? { nextBytes: new Uint8Array(record.nextBytes) } : {}) })); },
  };
}
