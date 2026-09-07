import type { Clock, IdGenerator } from '../domain/clock.js';
import { randomIdGenerator, systemClock } from '../domain/clock.js';
import type { VaultReader, VaultWriter, VaultMutationResult } from '../ports/vault.js';
import type { RecoveryRecord, RecoveryStore } from './vaultRecovery.js';
function fingerprint(bytes: Uint8Array): { size: number; hash: string } { let value = 2166136261; for (const byte of bytes) value = Math.imul(value ^ byte, 16777619); return { size: bytes.byteLength, hash: (value >>> 0).toString(16).padStart(8, '0') }; }

export type VaultMutation =
  | { kind: 'create'; path: string; bytes: Uint8Array; requestId?: string }
  | { kind: 'update'; path: string; bytes: Uint8Array; expectedRevision: string; requestId?: string }
  | { kind: 'move'; from: string; to: string; expectedRevision: string; requestId?: string }
  | { kind: 'delete'; path: string; expectedRevision: string; requestId?: string };

export interface MutationEvent {
  requestId: string;
  kind: VaultMutation['kind'];
  path: string;
  destination?: string;
  outcome: 'started' | 'accepted' | 'conflict' | 'rejected';
  reason?: string;
}

export type VaultMutationOutcome =
  | { ok: true; requestId: string; kind: VaultMutation['kind']; path: string; revision: string }
  | { ok: false; requestId: string; kind: VaultMutation['kind']; path: string; reason: string; actualRevision?: string };

export interface VaultMutationOptions {
  reader: VaultReader;
  writer: VaultWriter;
  recovery?: RecoveryStore;
  clock?: Clock;
  ids?: IdGenerator;
  maxBytes?: number;
  maxPathLength?: number;
  eventCapacity?: number;
}

export interface VaultMutationCoordinator {
  execute(mutation: VaultMutation): Promise<VaultMutationOutcome>;
  events(): readonly MutationEvent[];
}

function canonicalPath(path: string, maxLength: number): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > maxLength) throw new Error('vault path is empty or exceeds the limit');
  const value = path.replaceAll('\\', '/');
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) throw new Error('absolute vault paths are not allowed');
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw new Error('vault path traversal is not allowed');
  return parts.join('/');
}

function resultPath(mutation: VaultMutation): string { return mutation.kind === 'move' ? mutation.from : mutation.path; }

export function createVaultMutationCoordinator(options: VaultMutationOptions): VaultMutationCoordinator {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator();
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  const maxPathLength = Math.max(1, Math.floor(options.maxPathLength ?? 260));
  const events: MutationEvent[] = [];
  const capacity = Math.max(1, Math.floor(options.eventCapacity ?? 128));
  const append = (event: MutationEvent) => { events.push(event); while (events.length > capacity) events.shift(); };
  const queues = new Map<string, Promise<unknown>>();
  const serial = async <T>(root: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(root, next);
    try { return await next; } finally { if (queues.get(root) === next) queues.delete(root); }
  };

  async function execute(mutation: VaultMutation): Promise<VaultMutationOutcome> {
    const requestId = mutation.requestId ?? ids.next('mutation');
    const rawPath = resultPath(mutation);
    let path: string;
    try {
      path = canonicalPath(rawPath, maxPathLength);
      if (mutation.kind === 'move') canonicalPath(mutation.to, maxPathLength);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid path';
      append({ requestId, kind: mutation.kind, path: rawPath, outcome: 'rejected', reason });
      return { ok: false, requestId, kind: mutation.kind, path: rawPath, reason };
    }
    const bytes = 'bytes' in mutation ? mutation.bytes : undefined;
    if (bytes && bytes.byteLength > maxBytes) {
      append({ requestId, kind: mutation.kind, path, outcome: 'rejected', reason: 'mutation byte limit exceeded' });
      return { ok: false, requestId, kind: mutation.kind, path, reason: 'mutation byte limit exceeded' };
    }
    return serial(path, async () => {
      append({ requestId, kind: mutation.kind, path, ...(mutation.kind === 'move' ? { destination: mutation.to } : {}), outcome: 'started' });
      let recovery: RecoveryRecord | undefined;
      if (mutation.kind !== 'create') {
        let prior;
        try { prior = await options.reader.read(path, maxBytes); } catch {
          const result: VaultMutationOutcome = { ok: false, requestId, kind: mutation.kind, path, reason: 'missing' };
          append({ requestId, kind: mutation.kind, path, outcome: 'conflict', reason: 'missing' });
          return result;
        }
          const priorBytes = options.reader.readBinary ? (await options.reader.readBinary(path, maxBytes)).bytes : new TextEncoder().encode(prior.text);
          recovery = { requestId, operation: mutation.kind, path, ...(mutation.kind === 'move' ? { destination: canonicalPath(mutation.to, maxPathLength) } : {}), revision: prior.revision, bytes: new Uint8Array(priorBytes), priorFingerprint: fingerprint(priorBytes), ...(mutation.kind === 'update' ? { nextBytes: new Uint8Array(mutation.bytes), intendedFingerprint: fingerprint(mutation.bytes) } : {}), createdAt: new Date(clock.now()).toISOString() };
        if (options.recovery) {
          try { await options.recovery.save(recovery); }
          catch {
            append({ requestId, kind: mutation.kind, path, outcome: 'rejected', reason: 'recovery-required' });
            return { ok: false, requestId, kind: mutation.kind, path, reason: 'recovery-required' };
          }
        }
      }
      let result: VaultMutationResult;
      try {
        if (mutation.kind === 'create') result = await options.writer.createIfAbsent(path, new Uint8Array(mutation.bytes));
        else if (mutation.kind === 'update') result = await options.writer.writeIfUnchanged(path, new Uint8Array(mutation.bytes), mutation.expectedRevision);
        else if (mutation.kind === 'move') result = await options.writer.moveIfUnchanged(path, canonicalPath(mutation.to, maxPathLength), mutation.expectedRevision);
        else result = await options.writer.deleteIfUnchanged(path, mutation.expectedRevision);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'writer-failed';
        append({ requestId, kind: mutation.kind, path, outcome: 'rejected', reason });
        return { ok: false, requestId, kind: mutation.kind, path, reason };
      }
      if (!result.ok) {
        append({ requestId, kind: mutation.kind, path, outcome: 'conflict', reason: result.reason });
        return { ok: false, requestId, kind: mutation.kind, path, reason: result.reason, ...(result.actualRevision ? { actualRevision: result.actualRevision } : {}) };
      }
      if (mutation.kind !== 'create' && options.recovery?.markCommitted) {
        try { await options.recovery.markCommitted(requestId); }
        catch {
          append({ requestId, kind: mutation.kind, path, outcome: 'rejected', reason: 'recovery-required' });
          return { ok: false, requestId, kind: mutation.kind, path, reason: 'recovery-required' };
        }
      }
      const destination = mutation.kind === 'move' ? canonicalPath(mutation.to, maxPathLength) : path;
      try {
        if (mutation.kind === 'delete') {
          if (await options.reader.exists(path)) throw new Error('delete postcondition failed');
        } else if (!(await options.reader.exists(destination))) throw new Error('mutation postcondition failed');
      } catch {
        append({ requestId, kind: mutation.kind, path, outcome: 'rejected', reason: 'postcondition-failed' });
        return { ok: false, requestId, kind: mutation.kind, path, reason: 'postcondition-failed' };
      }
      append({ requestId, kind: mutation.kind, path, outcome: 'accepted' });
      return { ok: true, requestId, kind: mutation.kind, path, revision: result.revision };
    });
  }
  return { execute, events: () => events.map((event) => ({ ...event })) };
}
