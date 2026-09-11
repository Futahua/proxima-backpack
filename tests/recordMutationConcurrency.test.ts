import { describe, expect, it } from 'vitest';

import {
  createRecordMutationCoordinator,
  type RecordMutation,
} from '../src/app/recordMutation.js';
import type { RecoveryRecord, RecoveryStore } from '../src/app/vaultRecovery.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileMutationResult,
  RecordStoreFileName,
  RecordStoreFileRead,
} from '../src/ports/recordStore.js';

const RECORD_FILE = (
  'pxr_00000000000000000000000000000001.json'
) as RecordStoreFileName;

const SECOND_RECORD_FILE = (
  'pxr_00000000000000000000000000000002.json'
) as RecordStoreFileName;

class AtomicMemoryRecordBackend implements RecordStoreFileBackend {
  private readonly files = new Map<string, { text: string; revision: string }>();
  readonly updateAttempts: Array<{ text: string; expectedRevision: string }> = [];
  private nextRevision = 2;

  seed(fileName: RecordStoreFileName, text: string, revision = 'record-r1'): void {
    this.files.set(fileName, { text, revision });
  }
  text(fileName: RecordStoreFileName): string | undefined { return this.files.get(fileName)?.text; }
  revision(fileName: RecordStoreFileName): string | undefined { return this.files.get(fileName)?.revision; }
  async listRecordFiles(): Promise<readonly string[]> { return [...this.files.keys()].sort(); }
  async readRecordFile(fileName: RecordStoreFileName): Promise<RecordStoreFileRead | undefined> {
    const value = this.files.get(fileName);
    return value ? { ...value } : undefined;
  }
  async createRecordFile(fileName: RecordStoreFileName, text: string): Promise<RecordStoreFileMutationResult> {
    const current = this.files.get(fileName);
    if (current) return { ok: false, reason: 'already-exists', actualRevision: current.revision };
    const revision = `record-r${this.nextRevision++}`;
    this.files.set(fileName, { text, revision });
    return { ok: true, revision };
  }
  async writeRecordFileIfUnchanged(fileName: RecordStoreFileName, text: string, expectedRevision: string): Promise<RecordStoreFileMutationResult> {
    this.updateAttempts.push({ text, expectedRevision });
    const current = this.files.get(fileName);
    if (!current) return { ok: false, reason: 'missing' };
    if (current.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: current.revision };
    const revision = `record-r${this.nextRevision++}`;
    this.files.set(fileName, { text, revision });
    return { ok: true, revision };
  }
  async deleteRecordFileIfUnchanged(fileName: RecordStoreFileName, expectedRevision: string): Promise<RecordStoreFileMutationResult> {
    const current = this.files.get(fileName);
    if (!current) return { ok: false, reason: 'missing' };
    if (current.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: current.revision };
    this.files.delete(fileName);
    return { ok: true, revision: `deleted:${current.revision}` };
  }
}

function quietRecovery(): RecoveryStore {
  return {
    async save(_record: RecoveryRecord) {},
    async markCommitted() { return true; },
    async updateStatus() { return true; },
    list() { return []; },
  };
}

function updateFromObservation(observation: RecordStoreFileRead, text: string, requestId: string): RecordMutation {
  return { kind: 'update', fileName: RECORD_FILE, text, expectedRevision: observation.revision, requestId };
}
function deleteFromObservation(observation: RecordStoreFileRead, requestId: string): RecordMutation {
  return { kind: 'delete', fileName: RECORD_FILE, expectedRevision: observation.revision, requestId };
}

function pairedPrepareBarrier(): { first: RecoveryStore; second: RecoveryStore; preparedRevisions: string[] } {
  let prepared = 0;
  let release: (() => void) | undefined;
  const bothPrepared = new Promise<void>((resolve) => { release = resolve; });
  const preparedRevisions: string[] = [];
  function store(): RecoveryStore {
    return {
      async save(record) {
        preparedRevisions.push(record.revision);
        prepared += 1;
        if (prepared === 2) release?.();
        await (prepared >= 2 ? Promise.resolve() : bothPrepared);
      },
      async markCommitted() { return true; },
      async updateStatus() { return true; },
      list() { return []; },
    };
  }
  return { first: store(), second: store(), preparedRevisions };
}

describe('Stage 7 slice 12 observed-revision same-record concurrency', () => {
  it('binds update and delete requests directly to the observed revision', async () => {
    const records = new AtomicMemoryRecordBackend();
    records.seed(RECORD_FILE, 'old', 'record-r1');
    const observation = await records.readRecordFile(RECORD_FILE);
    if (!observation) throw new Error('expected record observation');
    const update = updateFromObservation(observation, 'new', 'observed-update');
    const deletion = deleteFromObservation(observation, 'observed-delete');
    expect(update.expectedRevision).toBe(observation.revision);
    expect(deletion.expectedRevision).toBe(observation.revision);
    expect(observation.revision).toBe('record-r1');
  });

  it('gives one winner and one typed stale loser when independent callers race the same observed revision', async () => {
    const records = new AtomicMemoryRecordBackend();
    records.seed(RECORD_FILE, 'old', 'record-r1');
    const observation = await records.readRecordFile(RECORD_FILE);
    if (!observation) throw new Error('expected record observation');
    const barrier = pairedPrepareBarrier();
    const first = createRecordMutationCoordinator({ backend: records, recovery: barrier.first });
    const second = createRecordMutationCoordinator({ backend: records, recovery: barrier.second });
    const results = await Promise.all([
      first.execute(updateFromObservation(observation, 'from-caller-a', 'caller-a')),
      second.execute(updateFromObservation(observation, 'from-caller-b', 'caller-b')),
    ]);
    const winners = results.filter((result): result is Extract<typeof result, { ok: true }> => result.ok);
    const losers = results.filter((result): result is Extract<typeof result, { ok: false }> => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0];
    const loser = losers[0];
    if (!winner || !loser) throw new Error('expected one winner and one loser');
    expect(winner.revision).toBe('record-r2');
    expect(loser).toMatchObject({ ok: false, reason: 'stale', actualRevision: winner.revision });
    expect(loser.requestId).not.toBe(winner.requestId);
    expect(barrier.preparedRevisions.slice().sort()).toEqual(['record-r1', 'record-r1']);
    expect(records.updateAttempts.map((attempt) => attempt.expectedRevision).sort()).toEqual(['record-r1', 'record-r1']);
    expect(records.revision(RECORD_FILE)).toBe(winner.revision);
    const expectedText = winner.requestId === 'caller-a' ? 'from-caller-a' : 'from-caller-b';
    expect(records.text(RECORD_FILE)).toBe(expectedText);
  });

  it('lets independent callers commit different observed records without cross-record blocking or overwrite', async () => {
    const records = new AtomicMemoryRecordBackend();
    records.seed(RECORD_FILE, 'old-a', 'record-r1');
    records.seed(SECOND_RECORD_FILE, 'old-b', 'record-r7');

    const observationA = await records.readRecordFile(RECORD_FILE);
    const observationB = await records.readRecordFile(SECOND_RECORD_FILE);
    if (!observationA || !observationB) throw new Error('expected both record observations');
    expect(observationA.revision).toBe('record-r1');
    expect(observationB.revision).toBe('record-r7');

    const barrier = pairedPrepareBarrier();
    const first = createRecordMutationCoordinator({ backend: records, recovery: barrier.first });
    const second = createRecordMutationCoordinator({ backend: records, recovery: barrier.second });
    const results = await Promise.all([
      first.execute({ kind: 'update', fileName: RECORD_FILE, text: 'new-a', expectedRevision: observationA.revision, requestId: 'different-record-a' }),
      second.execute({ kind: 'update', fileName: SECOND_RECORD_FILE, text: 'new-b', expectedRevision: observationB.revision, requestId: 'different-record-b' }),
    ]);

    expect(barrier.preparedRevisions.slice().sort()).toEqual([observationA.revision, observationB.revision].sort());
    expect(records.updateAttempts.map((attempt) => attempt.expectedRevision).sort()).toEqual([observationA.revision, observationB.revision].sort());
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    const firstResult = results[0];
    const secondResult = results[1];
    if (!firstResult || !secondResult || !firstResult.ok || !secondResult.ok) throw new Error('expected both different-record mutations to succeed');
    expect(firstResult.requestId).toBe('different-record-a');
    expect(secondResult.requestId).toBe('different-record-b');
    expect(records.text(RECORD_FILE)).toBe('new-a');
    expect(records.text(SECOND_RECORD_FILE)).toBe('new-b');
    expect(records.revision(RECORD_FILE)).toBe(firstResult.revision);
    expect(records.revision(SECOND_RECORD_FILE)).toBe(secondResult.revision);
    expect(firstResult.revision).not.toBe(observationA.revision);
    expect(secondResult.revision).not.toBe(observationB.revision);
    expect(records.text(RECORD_FILE)).not.toBe('new-b');
    expect(records.text(SECOND_RECORD_FILE)).not.toBe('new-a');
  });
});
