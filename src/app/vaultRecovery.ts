import type { Clock } from '../domain/clock.js';

export interface RecoveryRecord {
  requestId: string;
  operation: 'update' | 'move' | 'delete';
  path: string;
  destination?: string;
  revision: string;
  bytes: Uint8Array;
  createdAt: string;
  status?: 'prepared' | 'committed' | 'recovery-required' | 'recovered' | 'blocked';
}

export interface RecoveryStore {
  save(record: RecoveryRecord): Promise<void>;
  markCommitted?(requestId: string): Promise<void>;
  list(): readonly RecoveryRecord[];
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
    async markCommitted(requestId) { const record = records.find((candidate) => candidate.requestId === requestId); if (record) record.status = 'committed'; },
    list() { return records.map((record) => ({ ...record, bytes: new Uint8Array(record.bytes) })); },
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
    const payload = JSON.stringify(records.map((record) => ({ ...record, bytes: Array.from(record.bytes) })));
    if (new TextEncoder().encode(payload).byteLength > maxBytes) throw new Error('recovery journal byte limit exceeded');
    await backend.write(payload);
  };
  return {
    async load() {
      const raw = await backend.read(); if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('invalid recovery journal');
      records.splice(0, records.length, ...parsed.slice(-maxRecords).map((value) => {
        if (typeof value !== 'object' || value === null) throw new Error('invalid recovery record');
        const item = value as Record<string, unknown>;
        if (typeof item.requestId !== 'string' || typeof item.operation !== 'string' || typeof item.path !== 'string' || typeof item.revision !== 'string' || !Array.isArray(item.bytes) || typeof item.createdAt !== 'string') throw new Error('invalid recovery record');
        return { requestId: item.requestId, operation: item.operation as RecoveryRecord['operation'], path: item.path, ...(typeof item.destination === 'string' ? { destination: item.destination } : {}), revision: item.revision, bytes: new Uint8Array(item.bytes.filter((byte): byte is number => typeof byte === 'number')), createdAt: item.createdAt, status: (typeof item.status === 'string' ? item.status : 'prepared') as RecoveryRecord['status'] };
      }));
    },
    async save(record) { records.push({ ...record, status: record.status ?? 'prepared', bytes: new Uint8Array(record.bytes) }); while (records.length > maxRecords) records.shift(); await persist(); },
    async markCommitted(requestId) { const record = records.find((candidate) => candidate.requestId === requestId); if (record) { record.status = 'committed'; await persist(); } },
    list() { return records.map((record) => ({ ...record, bytes: new Uint8Array(record.bytes) })); },
  };
}
