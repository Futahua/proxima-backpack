/**
 * The Task editor's write path, over the real store and the real recovery coordinator.
 *
 * The property these cases exist to protect is *narrowness*: a Save writes the fields that
 * changed and nothing else. That is not tidiness — a field nobody touched is a field a concurrent
 * editor may already have changed, so rewriting it would be this form overwriting work it never
 * saw. So the plan cases assert the exact mutation list, including the fields that are absent.
 *
 * The second property is that a refusal is a refusal: an unparseable value, a column that is not
 * one of the three canonical states, and a custom property (which needs Stage 10's schema mapping)
 * all stop the whole save rather than half-writing it.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { applyTaskEditorEdit, taskEditorDraftFor, type TaskEditorDraft } from '../src/app/taskEditor.js';
import {
  deleteTaskAction,
  deleteTaskFromEditor,
  planTaskEditorSave,
  saveTaskAction,
  saveTaskFromEditor,
  taskEditorSaveActionType,
  type TaskEditorWriteDependencies,
  type TaskEditorWriteOperations,
} from '../src/app/taskEditorWrite.js';
import {
  createTask,
  deleteTask,
  updateTask,
  taskRecordFileName,
  type TaskMutationDependencies,
} from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { CanonicalExecutionState } from '../src/domain/canonicalTaskState.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T04:30:00+07:00';

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(21);

function projectRecord(id: OpaqueRecordId): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name: 'Project' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

interface World {
  readonly files: MemoryRecordFiles;
  readonly deps: TaskMutationDependencies;
  readonly refreshCalls: string[];
  seed(name: string, executionState?: CanonicalExecutionState): Promise<OpaqueRecordId>;
  /** A workflow stage record of this project's, so a task can be moved into it. */
  stage(name: string): Promise<string>;
  task(id: OpaqueRecordId): Promise<Task>;
  stored(id: OpaqueRecordId): Promise<CanonicalTaskRecordV2>;
  /** The editor's dependencies, with the sinks and the write operations a browser would supply. */
  editor(options?: { readonly writesAvailable?: boolean; readonly unavailableReason?: string }): {
    readonly refusals: (string | null)[];
    readonly renders: number[];
    /** Deps over a world the caller chooses, which is how a stale editor is modelled. */
    depsFor(state: ProximaState | null): TaskEditorWriteDependencies;
    save(input: { taskId: string; draft: TaskEditorDraft | null }): ReturnType<typeof saveTaskFromEditor>;
    remove(input: { taskId: string }): ReturnType<typeof deleteTaskFromEditor>;
    state(): Promise<ProximaState>;
  };
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 200;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  await store.createIfAbsent(projectRecord(PROJECT) as CanonicalRecordV2);

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const refreshCalls: string[] = [];

  return {
    files,
    deps,
    refreshCalls,
    seed: async (name, executionState = 'backlog') => {
      const created = await createTask(deps, { name, projectId: PROJECT, executionState, executionOrder: 0 });
      if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason}`);
      return created.recordId;
    },
    stage: async (name) => {
      const id = idFromLastByte(nextId++);
      const created = await store.createIfAbsent({
        ...defineCanonicalRecordHeader({ kind: 'workflow-stage', id, name }),
        projectId: PROJECT,
      } as CanonicalRecordV2);
      if (!created.ok) throw new Error(`seeding the stage ${name} failed: ${created.reason}`);
      return id;
    },
    task: async (id) => {
      const loaded = await source.load();
      const found = loaded.state.tasks.find((candidate) => candidate.id === id);
      if (found === undefined) throw new Error(`task ${id} is not in the projection`);
      return found;
    },
    stored: async (id) => {
      const observation = await deps.store.read(id);
      if (observation === undefined) throw new Error(`task ${id} is not in the store`);
      return observation.record as CanonicalTaskRecordV2;
    },
    editor: (options = {}) => {
      const refusals: (string | null)[] = [];
      const renders: number[] = [];
      const writesAvailable = options.writesAvailable ?? true;
      const operations: TaskEditorWriteOperations = {
        updateTask: (input) => updateTask(deps, input),
        deleteTask: (input) => deleteTask(deps, input),
      };

      const depsFor = (state: ProximaState | null): TaskEditorWriteDependencies => ({
        state,
        writes: async () => (writesAvailable ? operations : null),
        unavailableReason: () => options.unavailableReason ?? 'no write path',
        refresh: async (reason: RefreshReason) => {
          refreshCalls.push(reason);
          return await refresh.refreshSource(reason);
        },
        setRefusal: (reason: string | null) => { refusals.push(reason); },
        render: () => { renders.push(renders.length + 1); },
        ids: semanticIds(),
        audit: recordingAudit(),
      });

      const currentState = async (): Promise<ProximaState> => (await source.load()).state;

      return {
        refusals,
        renders,
        depsFor,
        state: currentState,
        save: async (input) => await saveTaskFromEditor(depsFor(await currentState()), input),
        remove: async (input) => await deleteTaskFromEditor(depsFor(await currentState()), input),
      };
    },
  };
}

describe('Stage 9 planTaskEditorSave', () => {
  it('writes only the fields that changed, in a stable order', async () => {
    const app = await world();
    const id = await app.seed('Original', 'backlog');
    const task = await app.task(id);
    const seed = taskEditorDraftFor(task);
    const edited = applyTaskEditorEdit(applyTaskEditorEdit(seed, { fieldId: 'name', value: 'Renamed' }), { fieldId: 'weight', value: '3.5' });

    const plan = planTaskEditorSave(task, edited);

    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(plan.mutations).toEqual([
      { kind: 'name', value: 'Renamed' },
      { kind: 'weight', value: 3.5 },
    ]);
  });

  it('refuses a save that would write nothing, including an edit back to the record', async () => {
    const app = await world();
    const id = await app.seed('Unchanged', 'backlog');
    const task = await app.task(id);

    expect(planTaskEditorSave(task, null)).toMatchObject({ ok: false, reason: 'nothing-to-save', fieldId: null });
    const editedBack = applyTaskEditorEdit(taskEditorDraftFor(task), { fieldId: 'name', value: task.name });
    expect(planTaskEditorSave(task, editedBack)).toMatchObject({ ok: false, reason: 'nothing-to-save' });
  });

  it('places a card that enters a stage at the end of it, and refuses a stage it cannot place', async () => {
    const app = await world();
    const id = await app.seed('Moves', 'backlog');
    const task = await app.task(id);
    const seed = taskEditorDraftFor(task);
    const into = applyTaskEditorEdit(seed, { fieldId: 'workflowStage', value: 'st-review' });

    // The placement is the caller's count: three cards are in the stage, so this one is the fourth.
    const placed = planTaskEditorSave(task, into, [], { appendIndex: (stageId) => (stageId === 'st-review' ? 3 : null) });
    expect(placed).toMatchObject({ ok: true, mutations: [{ kind: 'workflow-stage', value: 'st-review', order: 3 }] });

    // A caller that cannot say where the card lands is refused rather than given a guessed position, and so is
    // a stage the caller does not hold - which is how a stage of another project is answered.
    expect(planTaskEditorSave(task, into)).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'workflowStage' });
    expect(planTaskEditorSave(task, into, [], { appendIndex: () => null })).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'workflowStage' });
    expect(planTaskEditorSave(task, into, [], { appendIndex: () => -1 })).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'workflowStage' });

    // Clearing the field leaves the stage, and the position goes with it - the record refuses one without the
    // other, so the pair is what the plan writes.
    const inStage = { ...task, workflowStageId: 'st-review', workflowOrder: 2 } as Task;
    const leaving = applyTaskEditorEdit(taskEditorDraftFor(inStage), { fieldId: 'workflowStage', value: '' });
    expect(planTaskEditorSave(inStage, leaving)).toMatchObject({ ok: true, mutations: [{ kind: 'workflow-stage', value: null, order: null }] });

    // An untouched stage writes nothing at all, and an edit back to the record is still nothing to save.
    expect(planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'workflowStage', value: '' }))).toMatchObject({ ok: false, reason: 'nothing-to-save' });
  });

  it('carries a stage move through the record layer, appending to the end of the stage it enters', async () => {
    const app = await world();
    const stageId = await app.stage('Review');
    const first = await app.seed('First', 'backlog');
    const second = await app.seed('Second', 'backlog');
    const editor = app.editor();

    // One card is already in the stage, so the second one that enters it lands after it - the count the
    // planner asked the shell for, read here from the state the save was opened over.
    const before = await editor.state();
    const plan = planTaskEditorSave(
      before.tasks.find((candidate) => candidate.id === first)!,
      applyTaskEditorEdit(taskEditorDraftFor(before.tasks.find((candidate) => candidate.id === first)!), { fieldId: 'workflowStage', value: stageId }),
      before.taskSchema,
      { appendIndex: (stage) => (stage === stageId ? before.tasks.filter((candidate) => candidate.workflowStageId === stage).length : null) },
    );
    expect(plan).toMatchObject({ ok: true });

    const moved = await editor.save({
      taskId: first,
      draft: applyTaskEditorEdit(taskEditorDraftFor(await app.task(first)), { fieldId: 'workflowStage', value: stageId }),
    });
    expect(moved).toMatchObject({ ok: true, outcome: 'updated' });

    // The stored record is where the claim is settled: the task is in the stage, at position 0.
    const stored = await app.stored(first as OpaqueRecordId);
    expect(stored.workflowStageId).toBe(stageId);
    expect(stored.workflowOrder).toBe(0);

    // The second card enters the same stage and lands after it, which is the append the planner promised.
    const secondPlan = await editor.save({
      taskId: second,
      draft: applyTaskEditorEdit(taskEditorDraftFor(await app.task(second)), { fieldId: 'workflowStage', value: stageId }),
    });
    expect(secondPlan).toMatchObject({ ok: true });
    const secondStored = await app.stored(second as OpaqueRecordId);
    expect(secondStored.workflowStageId).toBe(stageId);
    expect(secondStored.workflowOrder).toBe(1);

    // And leaving stages the card with no stage and no position, because the record refuses half of the pair.
    const left = await editor.save({
      taskId: second,
      draft: applyTaskEditorEdit(taskEditorDraftFor(await app.task(second)), { fieldId: 'workflowStage', value: '' }),
    });
    expect(left).toMatchObject({ ok: true });
    const cleared = await app.stored(second as OpaqueRecordId);
    expect(cleared.workflowStageId).toBeNull();
    expect(cleared.workflowOrder).toBeNull();

    // A save that names a stage this project does not declare is refused by the shell's own resolver before any
    // write, and the record is where it was: the check is the caller's, because only the caller can see the board.
    const ghost = await editor.save({
      taskId: second,
      draft: applyTaskEditorEdit(taskEditorDraftFor(await app.task(second)), { fieldId: 'workflowStage', value: 'st-ghost' }),
    });
    expect(ghost).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'workflowStage' });
    expect((await app.stored(second as OpaqueRecordId)).workflowStageId).toBeNull();
  });

  it('carries a fixed duration together with the flag that makes it count', async () => {
    const app = await world();
    const id = await app.seed('Duration', 'backlog');
    const task = await app.task(id);
    const seed = taskEditorDraftFor(task);

    const on = applyTaskEditorEdit(applyTaskEditorEdit(seed, { fieldId: 'fixedDurationOn', checked: true }), { fieldId: 'fixedDuration', value: '45' });
    expect(planTaskEditorSave(task, on)).toMatchObject({ ok: true, mutations: [{ kind: 'fixed-duration', isFixedDuration: true, fixedDuration: 45 }] });

    // And turning the flag off clears the number rather than leaving it behind uncounted.
    const editor = app.editor();
    const written = await editor.save({ taskId: id, draft: on });
    expect(written).toMatchObject({ ok: true, outcome: 'updated' });
    const after = await app.task(id);
    const off = applyTaskEditorEdit(taskEditorDraftFor(after), { fieldId: 'fixedDurationOn', checked: false });
    expect(planTaskEditorSave(after, off)).toMatchObject({ ok: true, mutations: [{ kind: 'fixed-duration', isFixedDuration: false, fixedDuration: null }] });
  });

  it('carries both dates when only one was edited, and refuses an unreadable one', async () => {
    const app = await world();
    const id = await app.seed('Dates', 'backlog');
    const task = await app.task(id);
    const seed = taskEditorDraftFor(task);

    const plan = planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'deadline', value: '2026-10-01' }));
    expect(plan).toMatchObject({ ok: true, mutations: [{ kind: 'dates', startDate: task.startDate, deadline: '2026-10-01' }] });

    const bad = planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'startDate', value: 'not a date' }));
    expect(bad).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'startDate' });
  });

  it('refuses a value the record could not hold rather than writing part of the form', async () => {
    const app = await world();
    const id = await app.seed('Refusals', 'backlog');
    const task = await app.task(id);
    const seed = taskEditorDraftFor(task);

    expect(planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'name', value: '   ' }))).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'name' });
    expect(planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'weight', value: 'heavy' }))).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'weight' });
    expect(planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'weight', value: '-2' }))).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'weight' });
    // A vault's own status id is not a canonical column, and writing it would invent one.
    expect(planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'executionState', value: 'doing' }))).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'executionState' });
    expect(planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'fixedDurationOn', checked: true }))).toMatchObject({ ok: false, reason: 'validation-refused', fieldId: 'fixedDuration' });
    // A custom property with no schema record to define it: Stage 10's mapping needs the schema, and
    // a property nobody declared is refused rather than written as free text.
    expect(planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'property:pxr_effort', value: '3' }), [])).toMatchObject({ ok: false, reason: 'unknown-schema', fieldId: 'property:pxr_effort' });
    // A refused plan wrote nothing, which is the point of planning before writing.
    expect((await app.deps.store.read(id))?.observedRevision).toBe(`${taskRecordFileName(id)}@1`);
  });

  it('names the operation a save is, so a save that moves a column is audited as a move', async () => {
    const app = await world();
    const id = await app.seed('Moved by the form', 'backlog');
    const task = await app.task(id);
    const seed = taskEditorDraftFor(task);

    expect(taskEditorSaveActionType(task, [{ kind: 'name', value: 'x' }])).toBe('task.update');
    expect(taskEditorSaveActionType(task, [{ kind: 'execution-state', value: 'running' }])).toBe('task.execution.move');
    expect(taskEditorSaveActionType(task, [{ kind: 'execution-state', value: 'backlog' }])).toBe('task.execution.reorder');
    const moved = planTaskEditorSave(task, applyTaskEditorEdit(seed, { fieldId: 'executionState', value: 'finished' }));
    expect(moved).toMatchObject({ ok: true, mutations: [{ kind: 'execution-state', value: 'finished' }] });
  });
});

describe('Stage 9 editor save and delete', () => {
  it('writes the planned mutations, then converges the surfaces from the store', async () => {
    const app = await world();
    const id = await app.seed('Save me', 'backlog');
    const editor = app.editor();
    const seed = taskEditorDraftFor(await app.task(id));
    const edited = applyTaskEditorEdit(applyTaskEditorEdit(seed, { fieldId: 'name', value: 'Saved' }), { fieldId: 'executionState', value: 'running' });

    const saved = await editor.save({ taskId: id, draft: edited });

    expect(saved).toMatchObject({ ok: true, outcome: 'updated', refreshed: true });
    expect(app.refreshCalls).toEqual(['manual']);
    expect(editor.refusals).toEqual([null]);
    expect(editor.renders).toHaveLength(1);
    expect(await app.stored(id)).toMatchObject({ name: 'Saved', executionState: 'running', isCompleted: false });
    expect(await app.task(id)).toMatchObject({ name: 'Saved', status: 'running' });
  });

  it('refuses a save with no write path, and one with nothing to write, without touching the record', async () => {
    const app = await world();
    const id = await app.seed('Cannot save', 'backlog');
    const seed = taskEditorDraftFor(await app.task(id));
    const edited = applyTaskEditorEdit(seed, { fieldId: 'name', value: 'Nope' });

    const unavailable = app.editor({ writesAvailable: false, unavailableReason: 'record-writes-need-an-activated-store' });
    const refused = await unavailable.save({ taskId: id, draft: edited });
    expect(refused).toMatchObject({ ok: false, reason: 'writes-unavailable', detail: 'record-writes-need-an-activated-store' });
    expect(unavailable.refusals).toEqual([null, 'record-writes-need-an-activated-store']);
    expect(app.refreshCalls).toEqual([]);

    const empty = await app.editor().save({ taskId: id, draft: null });
    expect(empty).toMatchObject({ ok: false, reason: 'nothing-to-save' });
    expect((await app.deps.store.read(id))?.observedRevision).toBe(`${taskRecordFileName(id)}@1`);
    expect(await app.stored(id)).toMatchObject({ name: 'Cannot save' });
  });

  it('deletes the card the editor is showing, and refuses a delete of a revision that moved', async () => {
    const app = await world();
    const id = await app.seed('Delete me', 'backlog');
    const editor = app.editor();

    const deleted = await editor.remove({ taskId: id });
    expect(deleted).toMatchObject({ ok: true, outcome: 'deleted', refreshed: true });
    expect(await app.deps.store.read(id)).toBeUndefined();
    expect((await editor.state()).tasks.some((candidate) => candidate.id === id)).toBe(false);

    // The same request again, from the same (now stale) revision, is a not-found rather than a
    // second delete of something that is already gone.
    const again = await editor.remove({ taskId: id });
    expect(again).toMatchObject({ ok: false, reason: 'unknown-task' });
  });

  it('sends a stale save back to the store instead of overwriting the winner', async () => {
    const app = await world();
    const id = await app.seed('Raced', 'backlog');
    // The editor rendered this record; someone else renames it before Save is pressed.
    const editor = app.editor();
    const staleState = await editor.state();
    const seed = taskEditorDraftFor(staleState.tasks.find((candidate) => candidate.id === id)!);
    const winner = await updateTask(app.deps, {
      taskId: id,
      expectedRevision: (await app.deps.store.read(id))!.observedRevision,
      mutations: [{ kind: 'name', value: 'Renamed first' }],
    });
    expect(winner.ok).toBe(true);

    const saved = await saveTaskFromEditor(
      editor.depsFor(staleState),
      { taskId: id, draft: applyTaskEditorEdit(seed, { fieldId: 'weight', value: '9' }) },
    );

    expect(saved).toMatchObject({ ok: false, reason: 'stale-revision', refreshed: true });
    expect(app.refreshCalls).toEqual(['manual']);
    // The loser's value never reached the record, and the card now shows the winner's.
    expect(await app.stored(id)).toMatchObject({ name: 'Renamed first', weight: 1 });
    expect(await app.task(id)).toMatchObject({ name: 'Renamed first' });
  });
});

describe('Stage 9 what a save means for the form', () => {
  it('leaves the edits in place when the save was refused, and clears them when it was accepted', async () => {
    const app = await world();
    const id = await app.seed('Keeps its edits', 'backlog');
    const editor = app.editor();
    // The record as this editor rendered it, held across both saves below.
    const rendered = await editor.state();
    const seed = taskEditorDraftFor(rendered.tasks.find((candidate) => candidate.id === id)!);

    const accepted = await saveTaskAction(
      editor.depsFor(rendered),
      { taskId: id, draft: applyTaskEditorEdit(seed, { fieldId: 'name', value: 'Typed' }) },
    );
    expect(accepted).toMatchObject({ clearDraft: true, closeEditor: false });
    expect(accepted.outcome).toMatchObject({ ok: true, outcome: 'updated' });
    expect(await app.stored(id)).toMatchObject({ name: 'Typed' });

    // A second save built on the record this editor was still showing: the record has moved on,
    // so the write is refused — and the form keeps what was typed, which is what lets the reader
    // retry from the authoritative revision instead of retyping it.
    const stale = await saveTaskAction(
      editor.depsFor(rendered),
      { taskId: id, draft: applyTaskEditorEdit(seed, { fieldId: 'weight', value: '7' }) },
    );
    expect(stale).toMatchObject({ clearDraft: false, closeEditor: false });
    expect(stale.outcome).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(await app.stored(id)).toMatchObject({ name: 'Typed', weight: 1 });
  });

  it('closes the editor only when a delete was accepted', async () => {
    const app = await world();
    const id = await app.seed('Closes on delete', 'backlog');
    const editor = app.editor();

    const deleted = await deleteTaskAction(editor.depsFor(await editor.state()), { taskId: id });
    expect(deleted).toMatchObject({ clearDraft: true, closeEditor: true });
    expect(deleted.outcome).toMatchObject({ ok: true, outcome: 'deleted' });

    // A second delete of something already gone closes nothing: there was no accepted write.
    const again = await deleteTaskAction(editor.depsFor(await editor.state()), { taskId: id });
    expect(again).toMatchObject({ clearDraft: false, closeEditor: false });
    expect(again.outcome).toMatchObject({ ok: false, reason: 'unknown-task' });
  });

  it('does nothing at all when no card is open, not even resolving a write path', async () => {
    const app = await world();
    const editor = app.editor();

    const saved = await saveTaskAction(editor.depsFor(await editor.state()), { taskId: null, draft: null });
    const removed = await deleteTaskAction(editor.depsFor(await editor.state()), { taskId: null });

    expect(saved).toEqual({ outcome: null, clearDraft: false, closeEditor: false });
    expect(removed).toEqual({ outcome: null, clearDraft: false, closeEditor: false });
    expect(editor.refusals).toEqual([]);
    expect(editor.renders).toEqual([]);
    expect(app.refreshCalls).toEqual([]);
  });
});
