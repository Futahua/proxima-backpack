/**
 * Two Stage 16 boxes that the executor slice left open on the AUTHOR's word, closed here on evidence.
 *
 * "Batch creation uses stable opaque IDs": the ids are allocated by the port, so this asserts what the box
 * actually claims - every created id is the opaque `pxr_<32 hex>` form, they are distinct within the batch,
 * and they still name the same records after a restart. It does not claim an allocation *table*, which the
 * AUTHOR deferred until intra-batch relations exist.
 *
 * "Restart reproduces created state": the same record files are read back through a fresh store and a fresh
 * coordinator, which is what a restart is for a durable backend, and the records must be identical -
 * including their ids and creation timestamps, because those are stored rather than regenerated.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { parseTemplatePlan } from '../src/app/templateComposer.js';
import { executeTemplatePlan } from '../src/app/templateExecution.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T03:00:00+07:00';
const OPAQUE = /^pxr_[0-9a-f]{32}$/;

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

/**
 * A store, a coordinator and the create dependencies over one set of record files. Calling this twice with
 * the same files is a restart: nothing of the first run is reused except the bytes on the backend.
 */
function open(files: MemoryRecordFiles, serialStart: number) {
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: sequentialIdGenerator(),
  });
  const store = createCanonicalJsonRecordStore(files);
  let serial = serialStart;
  const deps: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => {
      serial += 1;
      const bytes = new Uint8Array(16);
      bytes[14] = 0x5c;
      bytes[15] = serial;
      return opaqueRecordIdFromRandomBytes(bytes);
    },
  };
  return { store, deps };
}

async function tasksIn(store: ReturnType<typeof createCanonicalJsonRecordStore>) {
  const observations = await store.list();
  return observations.filter((observation) => observation.kind === 'task');
}

const TEMPLATE = ['Write the brief', '  weight: 3', 'Draft the outline', 'Review the outline'].join('\n');

describe('template-created records survive a restart, with the ids they were given', () => {
  it('allocates opaque ids, distinct within the batch, and keeps them across a reopen', async () => {
    const files = new MemoryRecordFiles();
    const first = open(files, 0);

    const plan = parseTemplatePlan(TEMPLATE);
    expect(plan.errors).toEqual([]);
    const outcome = await executeTemplatePlan({
      plan,
      projectId: null,
      tasks: { createTask: (request) => createTask(first.deps, request) },
    });
    expect(outcome.kind).toBe('complete');
    const createdIds = outcome.kind === 'complete' ? outcome.created : [];
    expect(createdIds).toHaveLength(3);
    for (const id of createdIds) expect(id).toMatch(OPAQUE);
    expect(new Set(createdIds).size).toBe(3);

    const before = await tasksIn(first.store);
    expect(before.map((observation) => observation.id).sort()).toEqual([...createdIds].sort());

    // The restart: fresh store, fresh coordinator, fresh dependencies, same record files.
    const second = open(files, 100);
    const after = await tasksIn(second.store);

    expect(after).toHaveLength(3);
    expect(after.map((observation) => observation.id).sort()).toEqual([...createdIds].sort());
    expect(after.map((observation) => JSON.stringify(observation.record)).sort())
      .toEqual(before.map((observation) => JSON.stringify(observation.record)).sort());

    // And the reopened store can still be written to through the same seam, which is what makes this a
    // restart rather than a read-only snapshot.
    const another = await createTask(second.deps, { name: 'A fourth task', projectId: null });
    expect(another.ok).toBe(true);
    expect(await tasksIn(second.store)).toHaveLength(4);
    expect(await tasksIn(first.store)).toHaveLength(4);
  });

  it('a re-used id is refused rather than overwriting the record that owns it', async () => {
    const files = new MemoryRecordFiles();
    const first = open(files, 0);
    const one = await createTask(first.deps, { name: 'First', projectId: null });
    expect(one.ok).toBe(true);

    // A restart whose allocator starts again from zero proposes an id that already exists. The store is
    // create-if-absent, so the answer must be a refusal and the existing record must be untouched - an
    // aliased id is how a later write reaches a file nobody chose.
    const second = open(files, 0);
    const two = await createTask(second.deps, { name: 'Second', projectId: null });
    expect(two.ok).toBe(false);
    // The task layer translates the store's own `already-exists` into its vocabulary; what matters here is
    // that the collision is refused at all, rather than the spelling of the reason.
    if (!two.ok) expect(two.reason).toBe('semantic-conflict');

    const records = await tasksIn(second.store);
    expect(records).toHaveLength(1);
    const only = records[0];
    expect(only).toBeDefined();
    expect((only?.record as { name?: string }).name).toBe('First');
    expect(only?.id).toMatch(OPAQUE);
  });
});
