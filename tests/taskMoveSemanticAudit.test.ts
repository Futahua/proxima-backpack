/**
 * The semantic envelope on the execution move: `moveTaskByGesture`, and the drop that wraps it.
 *
 * The gesture is the action the matrix's `task.execution.move` row names, and the wrapper
 * (`performElasticDrop`) refuses twice before the gesture is ever reached - a card the board is not showing,
 * and a run with no write path. Those two refusals are the reason the wrapper mints: a drop refused before the
 * gesture is reached still has to be correlatable, and it hands its id down rather than letting the gesture
 * mint a second one, so a run leaves exactly one event.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { performElasticDrop } from '../src/app/elasticDropAction.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { moveTaskByGesture, type TaskMoveGestureDependencies } from '../src/app/taskMoveGesture.js';
import {
  createTask,
  updateTask,
  type TaskMutationDependencies,
} from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T12:30:00+07:00';

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
  bytes[14] = 0xa0;
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
  const created = await createTask(dependencies, { name: 'Move me', projectId: null, executionState: 'backlog', executionOrder: 0 });
  if (!created.ok) throw new Error('seeding the card failed');

  const source = recordStoreStateSource(store);
  let state: ProximaState = (await source.load()).state;
  const audit = recordingAudit();
  const order: string[] = [];

  const refresh = async (): Promise<null> => {
    order.push('refresh');
    state = (await source.load()).state;
    return null;
  };

  const gestureDeps: TaskMoveGestureDependencies = {
    updateTask: (input) => updateTask(dependencies, input),
    refresh,
    ids: semanticIds(),
    audit: {
      append: (event) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  const dropDeps = {
    state,
    writes: async () => (options.writesAvailable === false ? null : { updateTask: (input: Parameters<typeof updateTask>[1]) => updateTask(dependencies, input) }),
    unavailableReason: () => 'the record store is not open',
    refresh,
    setRefusal: () => {},
    render: () => { order.push('render'); },
    ids: semanticIds(),
    audit: gestureDeps.audit,
  };

  const card = () => state.tasks.find((candidate) => candidate.id === created.recordId)!;

  return {
    gestureDeps,
    dropDeps: { ...dropDeps, get state() { return state; } },
    audit,
    order,
    taskId: created.recordId as string,
    card,
    /** Somebody else moves the card through the store while this shell still shows the old revision. */
    bumpName: async (name: string): Promise<void> => {
      const fresh = (await source.load()).state;
      const current = fresh.tasks.find((candidate) => candidate.id === created.recordId)!;
      const result = await updateTask(dependencies, {
        taskId: created.recordId,
        expectedRevision: current.source.revision,
        mutations: [{ kind: 'name', value: name }],
      });
      if (!result.ok) throw new Error(`the other writer was refused: ${result.reason}`);
    },
  };
}

describe('the semantic envelope on the execution move', () => {
  it('mints an id, journals the move after convergence, and names the verb', async () => {
    const w = await world();
    const moved = await moveTaskByGesture(w.gestureDeps, {
      taskId: w.taskId as OpaqueRecordId,
      from: 'backlog',
      to: 'running',
      targetIndex: 2,
      expectedRevision: w.card().source.revision,
    });

    expect(moved.ok).toBe(true);
    expect(moved.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: moved.requestId,
      actionType: 'task.execution.move',
      outcome: 'accepted',
      entityIds: [w.taskId],
    });
    expect(w.order).toEqual(['refresh', 'audit:accepted']);
  });

  it('names a reorder as its own verb rather than calling it a move', async () => {
    const w = await world();
    const moved = await moveTaskByGesture(w.gestureDeps, {
      taskId: w.taskId as OpaqueRecordId,
      from: 'backlog',
      to: 'backlog',
      targetIndex: 3,
      expectedRevision: w.card().source.revision,
    });

    expect(moved).toMatchObject({ ok: true, actionType: 'task.execution.reorder' });
    expect(w.audit.events[0]).toMatchObject({ actionType: 'task.execution.reorder', outcome: 'accepted' });
  });

  it('correlates a drop with no position, before the store is touched', async () => {
    const w = await world();
    const moved = await moveTaskByGesture(w.gestureDeps, {
      taskId: w.taskId as OpaqueRecordId,
      from: 'backlog',
      to: 'running',
      targetIndex: -1,
      expectedRevision: w.card().source.revision,
    });

    expect(moved).toMatchObject({ ok: false, reason: 'validation-refused' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: moved.requestId,
      outcome: 'rejected',
      entityIds: [w.taskId],
      errorCode: 'validation-refused',
    });
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('correlates a lost race, and converges because the card moved under it', async () => {
    const w = await world();
    const stale = w.card();
    await w.bumpName('Somebody else edited it');

    const moved = await moveTaskByGesture(w.gestureDeps, {
      taskId: w.taskId as OpaqueRecordId,
      from: 'backlog',
      to: 'running',
      targetIndex: 0,
      expectedRevision: stale.source.revision,
    });

    expect(moved).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: moved.requestId,
      outcome: 'rejected',
      errorCode: 'stale-revision',
    });
    expect(w.order).toEqual(['refresh', 'audit:rejected']);
  });

  it('correlates the drop refusals that happen before the gesture is reached', async () => {
    const missing = await world();
    const noCard = await performElasticDrop(missing.dropDeps, { taskId: 'pxr_missing', targetColumn: 'running', targetIndex: 0 });
    expect(noCard).toMatchObject({ ok: false, reason: 'unknown-task' });
    expect(missing.audit.events[0]).toMatchObject({
      requestId: noCard.requestId,
      actionType: 'task.execution.move',
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'unknown-task',
    });

    const unavailable = await world({ writesAvailable: false });
    const noWrites = await performElasticDrop(unavailable.dropDeps, { taskId: unavailable.taskId, targetColumn: 'running', targetIndex: 0 });
    expect(noWrites).toMatchObject({ ok: false, reason: 'writes-unavailable' });
    expect(unavailable.audit.events[0]).toMatchObject({
      requestId: noWrites.requestId,
      outcome: 'rejected',
      entityIds: [unavailable.taskId],
      errorCode: 'writes-unavailable',
    });
  });

  it('leaves exactly one event per drop, because the wrapper hands its id down', async () => {
    const w = await world();
    const dropped = await performElasticDrop(w.dropDeps, { taskId: w.taskId, targetColumn: 'running', targetIndex: 1 });

    expect(dropped).toMatchObject({ ok: true, actionType: 'task.execution.move' });
    // The wrapper minted and the gesture used that id rather than minting its own: one run, one event, one
    // correlation - a second event here would mean the audit counted the same drop twice.
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]!.requestId).toBe(dropped.requestId);
    expect(dropped.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
  });
});
