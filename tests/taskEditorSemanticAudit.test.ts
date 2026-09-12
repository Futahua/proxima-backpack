/**
 * The semantic envelope on the Task editor's write path: save and delete, the third and fourth actions wired.
 *
 * `tests/taskEditorWrite.test.ts` covers what a save plans and what a delete means; this file is only about the
 * envelope - a request id on every result including the refusals, and exactly one terminal event per run,
 * appended after convergence where the store was touched. It is also where the event's **action type** is
 * pinned: a save that moves a card between columns is an execution move as well as an edit, and the audit
 * should name the verb a reader would.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { applyTaskEditorEdit, taskEditorDraftFor } from '../src/app/taskEditor.js';
import {
  deleteTaskAction,
  saveTaskAction,
  type TaskEditorWriteDependencies,
} from '../src/app/taskEditorWrite.js';
import {
  createTask,
  type CreateTaskRequest,
  type TaskMutationDependencies,
  type TaskMutationResult,
} from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T12:00:00+07:00';

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
  bytes[14] = 0x9f;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

interface WorldOptions {
  readonly available?: boolean;
  /** Take the card away between the draft and the write, which is the lost-race and the unknown-task setup. */
  readonly withdrawn?: boolean;
}

async function world(options: WorldOptions = {}) {
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
  const created = await createTask(dependencies, { name: 'Write the brief', projectId: null });
  if (!created.ok) throw new Error('seeding the card failed');

  const source = recordStoreStateSource(store);
  let state: ProximaState = (await source.load()).state;
  const audit = recordingAudit();
  const order: string[] = [];

  const operations = {
    async updateTask(request: Parameters<typeof import('../src/app/taskMutations.js').updateTask>[1]): Promise<TaskMutationResult> {
      if (options.withdrawn === true) {
        const { updateTask } = await import('../src/app/taskMutations.js');
        return await updateTask(dependencies, request);
      }
      const { updateTask } = await import('../src/app/taskMutations.js');
      return await updateTask(dependencies, request);
    },
    async deleteTask(request: { taskId: OpaqueRecordId; expectedRevision: string }): Promise<TaskMutationResult> {
      const { deleteTask } = await import('../src/app/taskMutations.js');
      return await deleteTask(dependencies, request);
    },
  };

  const deps: TaskEditorWriteDependencies = {
    state,
    writes: async () => (options.available === false ? null : operations),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      state = (await source.load()).state;
      return null;
    },
    setRefusal: () => {},
    render: () => { order.push('render'); },
    ids: semanticIds(),
    audit: {
      append: (event) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  const card = (): Task => deps.state!.tasks.find((candidate) => candidate.id === created.recordId)!;

  /**
   * Somebody else edits the same card, through the store, while the surface still shows the old revision.
   *
   * The refresh is deliberately *not* called here: the point of a lost race is that this shell's state is
   * stale, which is exactly what the save carries into the write.
   */
  const bumpName = async (name: string): Promise<void> => {
    const fresh = (await source.load()).state;
    const current = fresh.tasks.find((candidate) => candidate.id === created.recordId)!;
    const { updateTask } = await import('../src/app/taskMutations.js');
    const result = await updateTask(dependencies, {
      taskId: created.recordId,
      expectedRevision: current.source.revision,
      mutations: [{ kind: 'name', value: name }],
    });
    if (!result.ok) throw new Error(`the other editor's write was refused: ${result.reason}`);
  };

  return { deps, audit, order, taskId: created.recordId as string, card, bumpName };
}

/** The draft the editor opens with, then one edit applied to it. */
function edited(task: Task, fieldId: string, value: string) {
  return applyTaskEditorEdit(taskEditorDraftFor(task), { fieldId, value });
}

describe('the semantic envelope on the editor write path', () => {
  it('mints an id on a save and journals the acceptance after convergence', async () => {
    const w = await world();
    const effect = await saveTaskAction(w.deps, { taskId: w.taskId, draft: edited(w.card(), 'name', 'Write the brief properly') });

    expect(effect.outcome?.ok).toBe(true);
    const outcome = effect.outcome!;
    expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'task.update',
      outcome: 'accepted',
      entityIds: [w.taskId],
    });
    expect(w.order).toEqual(['refresh', 'render', 'audit:accepted']);
  });

  it('names the move as the event action type when the save moves the card between columns', async () => {
    const w = await world();
    const effect = await saveTaskAction(w.deps, { taskId: w.taskId, draft: edited(w.card(), 'executionState', 'running') });

    expect(effect.outcome?.ok).toBe(true);
    // A save that changes the column *is* an execution move; the audit says so rather than flattening every
    // save to `task.update`, which is the same rule `taskEditorSaveActionType` already encodes for callers.
    expect(w.audit.events[0]).toMatchObject({ actionType: 'task.execution.move' });
  });

  it('correlates a save that had nothing to write, without converging anything', async () => {
    const w = await world();
    const effect = await saveTaskAction(w.deps, { taskId: w.taskId, draft: taskEditorDraftFor(w.card()) });

    expect(effect.outcome).toMatchObject({ ok: false, reason: 'nothing-to-save' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: effect.outcome!.requestId,
      actionType: 'task.update',
      outcome: 'rejected',
      entityIds: [w.taskId],
      errorCode: 'nothing-to-save',
    });
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('correlates a lost race, and converges because the store did move', async () => {
    const w = await world();
    // Somebody else wins between the card being read and the save being sent: the save carries the revision
    // the surface showed, so it is refused rather than merged.
    const stale = w.card();
    await w.bumpName('Somebody else got there first');

    const effect = await saveTaskAction(w.deps, { taskId: w.taskId, draft: edited(stale, 'name', 'Mine') });
    expect(effect.outcome).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: effect.outcome!.requestId,
      outcome: 'rejected',
      entityIds: [w.taskId],
      errorCode: 'stale-revision',
    });
    // A lost race is the one refusal where the surface was already wrong, so it does re-read.
    expect(w.order).toEqual(['refresh', 'render', 'audit:rejected']);
  });

  it('mints an id for a delete, and journals it as its own verb', async () => {
    const w = await world();
    const effect = await deleteTaskAction(w.deps, { taskId: w.taskId });

    expect(effect.outcome?.ok).toBe(true);
    expect(w.audit.events[0]).toMatchObject({
      requestId: effect.outcome!.requestId,
      actionType: 'task.delete',
      outcome: 'accepted',
      entityIds: [w.taskId],
    });
    expect(effect.closeEditor).toBe(true);
  });

  it('correlates the editor being pointed at a card that is not there', async () => {
    const w = await world();
    const effect = await saveTaskAction(w.deps, { taskId: 'pxr_missing', draft: null });

    expect(effect.outcome).toMatchObject({ ok: false, reason: 'unknown-task' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: effect.outcome!.requestId,
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'unknown-task',
    });
  });

  it('correlates a run with no write path, and appends nothing when no card was open', async () => {
    const unavailable = await world({ available: false });
    const refused = await saveTaskAction(unavailable.deps, { taskId: unavailable.taskId, draft: edited(unavailable.card(), 'name', 'Mine') });
    expect(refused.outcome).toMatchObject({ ok: false, reason: 'writes-unavailable' });
    expect(unavailable.audit.events[0]).toMatchObject({
      requestId: refused.outcome!.requestId,
      outcome: 'rejected',
      errorCode: 'writes-unavailable',
    });

    const idle = await world();
    const nothing = await saveTaskAction(idle.deps, { taskId: null, draft: null });
    expect(nothing.outcome).toBeNull();
    expect(idle.audit.events).toHaveLength(0);
  });
});
