/**
 * The semantic envelope on a bulk action: one run, one id, one event, however many members it touched.
 *
 * This is the case the other families did not have. A selection writes many records, and the tempting shape -
 * an id and an event per member - would turn one thing a person asked for into N things in the journal, and
 * would leave the run itself untraceable. So the run mints once, and its single terminal event carries the
 * outcome the members produced: `accepted` only when every member landed, `partial` when some did, `rejected`
 * when none did, with the ids that landed (or, for a rejection, the targets it was refused about).
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { bulkCompleteTasks, bulkDeleteTasks, type BulkTaskActionDependencies } from '../src/app/bulkTaskActions.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import {
  createTask,
  deleteTask,
  updateTask,
  type TaskMutationDependencies,
} from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T13:00:00+07:00';

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFor(serial: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[14] = 0xa1;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

async function world(options: { readonly writesAvailable?: boolean } = {}) {
  const files = new MemoryRecordFiles();
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: sequentialIdGenerator(),
  });
  const store = createCanonicalJsonRecordStore(files);
  let serial = 0;
  const dependencies: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFor((serial += 1)),
  };

  const seeded: string[] = [];
  for (const name of ['First', 'Second', 'Third']) {
    const created = await createTask(dependencies, { name, projectId: null, executionState: 'running', executionOrder: 0 });
    if (!created.ok) throw new Error(`seeding ${name} failed`);
    seeded.push(created.recordId);
  }

  const source = recordStoreStateSource(store);
  let state: ProximaState = (await source.load()).state;
  const audit = recordingAudit();
  const order: string[] = [];

  const deps: BulkTaskActionDependencies = {
    get state() { return state; },
    writes: async () => (options.writesAvailable === false ? null : {
      updateTask: (input: Parameters<typeof updateTask>[1]) => updateTask(dependencies, input),
      deleteTask: (input: Parameters<typeof deleteTask>[1]) => deleteTask(dependencies, input),
    }),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      state = (await source.load()).state;
      return null;
    },
    render: () => { order.push('render'); },
    ids: semanticIds(),
    audit: {
      append: (event) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  return {
    deps,
    audit,
    order,
    first: seeded[0]!,
    all: seeded,
    /** Somebody else moves a task through the store, so this shell's copy of it is stale. */
    bumpName: async (taskId: string, name: string): Promise<void> => {
      const fresh = (await source.load()).state;
      const current = fresh.tasks.find((candidate) => candidate.id === taskId)!;
      const result = await updateTask(dependencies, {
        taskId: current.id as OpaqueRecordId,
        expectedRevision: current.source.revision,
        mutations: [{ kind: 'name', value: name }],
      });
      if (!result.ok) throw new Error(`the other writer was refused: ${result.reason}`);
    },
  };
}

describe('the semantic envelope on a bulk action', () => {
  it('mints one id for the run and journals one acceptance with every id that landed', async () => {
    const w = await world();
    const report = await bulkCompleteTasks(w.deps, { taskIds: w.all });

    expect(report.status).toBe('accepted');
    expect(report.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: report.requestId,
      actionType: 'task.bulk.complete',
      outcome: 'accepted',
      entityIds: w.all,
    });
    expect(w.audit.events[0]!.errorCode).toBeUndefined();
    expect(w.order).toEqual(['refresh', 'render', 'audit:accepted']);
  });

  it('journals a selection where some landed as partial, with only the ids that landed', async () => {
    const w = await world();
    // One member is edited behind this shell's back, so its revision is stale when the run reaches it.
    await w.bumpName(w.all[1]!, 'Somebody else got there first');

    const report = await bulkCompleteTasks(w.deps, { taskIds: w.all });

    expect(report.status).toBe('partial');
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: report.requestId,
      outcome: 'partial',
      entityIds: [w.all[0], w.all[2]],
      errorCode: 'stale-revision',
    });
    // A partial run wrote records, so it converged before the journal entry - and it is one entry, not three.
    expect(w.order).toEqual(['refresh', 'render', 'audit:partial']);
  });

  it('journals a run where nothing landed as a rejection naming the targets it was about', async () => {
    const w = await world();
    const report = await bulkCompleteTasks({ ...w.deps, state: null }, { taskIds: w.all });

    expect(report.status).toBe('refused');
    expect(w.audit.events[0]).toMatchObject({
      requestId: report.requestId,
      outcome: 'rejected',
      entityIds: w.all,
      errorCode: 'unknown-task',
    });
    // Nothing was written, so nothing converged - but the surface still redraws, because the report of what
    // was refused is what the reader has to see.
    expect(w.order).toEqual(['render', 'audit:rejected']);
  });

  it('correlates an empty selection, which is a refusal rather than a quiet success', async () => {
    const w = await world();
    const report = await bulkCompleteTasks(w.deps, { taskIds: [] });

    expect(report).toMatchObject({ status: 'refused', requested: 0 });
    expect(w.audit.events[0]).toMatchObject({
      requestId: report.requestId,
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'nothing-selected',
    });
  });

  it('correlates a run with no write path, naming every member it could not touch', async () => {
    const w = await world({ writesAvailable: false });
    const report = await bulkDeleteTasks(w.deps, { taskIds: w.all });

    expect(report).toMatchObject({ status: 'refused', action: 'task.bulk.delete' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: report.requestId,
      actionType: 'task.bulk.delete',
      outcome: 'rejected',
      entityIds: w.all,
      errorCode: 'writes-unavailable',
    });
  });

  it('names the delete as its own verb when the run lands', async () => {
    const w = await world();
    const report = await bulkDeleteTasks(w.deps, { taskIds: [w.first] });

    expect(report.status).toBe('accepted');
    expect(w.audit.events[0]).toMatchObject({
      actionType: 'task.bulk.delete',
      outcome: 'accepted',
      entityIds: [w.first],
    });
  });
});
