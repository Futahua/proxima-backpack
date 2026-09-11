// @vitest-environment happy-dom
/**
 * A change made *on Elastic* reaching the other surfaces.
 *
 * Stage 19's convergence was proven for a change made at the source (`8dc3841`: edit the vault,
 * reload, ask eight surfaces). What it could not prove is the half that starts in the cockpit,
 * because an Elastic edit was refused — so the surfaces were converging on changes nobody could
 * make from the UI. These cases start where a person does: a drop, and a card editor's Save. Then
 * they mount the real renderers over the projection the product's own refresh produced and ask each
 * one what it shows.
 *
 * The last case is the other half of HARD GATE A2 seen from the surface side: moving a card between
 * execution columns must not touch the deadline surfaces, so the case asserts they are *unchanged*
 * rather than merely present.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { applyTaskEditorEdit, projectTaskEditor, taskEditorDraftFor } from '../src/app/taskEditor.js';
import { saveTaskAction, type TaskEditorWriteDependencies } from '../src/app/taskEditorWrite.js';
import { moveTaskByGesture } from '../src/app/taskMoveGesture.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState } from '../src/domain/types.js';
import { renderElasticCockpit } from '../src/browser/elasticCockpit.js';
import { EMPTY_PROJECT_BACKLOG_VIEW, renderProjectBacklog } from '../src/browser/projectBacklog.js';
import { EMPTY_PROJECT_TASK_BOARD_VIEW, renderProjectTaskBoard } from '../src/browser/projectTaskBoard.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T05:00:00+07:00';
const DEADLINE = '2026-10-05T09:00:00.000Z';

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

const PROJECT = idFromLastByte(31);

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

async function world() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 300;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  await store.createIfAbsent(projectRecord(PROJECT) as CanonicalRecordV2);

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const read = async (): Promise<ProximaState> => (await source.load()).state;

  const refreshFromSource = async (reason: RefreshReason): Promise<RefreshResult> => await refresh.refreshSource(reason);

  return {
    store,
    deps,
    read,
    seed: async (name: string) => {
      const created = await createTask(deps, { name, projectId: PROJECT, executionState: 'backlog', executionOrder: 0, deadline: DEADLINE });
      if (!created.ok) throw new Error(`seeding failed: ${created.reason}`);
      return created.recordId;
    },
    /** The same sequence a drop runs, over the real store, then the product's own re-read. */
    drop: async (taskId: OpaqueRecordId, to: 'backlog' | 'running' | 'finished', index: number) => {
      const task = (await read()).tasks.find((candidate) => candidate.id === taskId)!;
      return await moveTaskByGesture(
        {
          updateTask: (input) => updateTask(deps, input),
          refresh: refreshFromSource,
        },
        { taskId, from: task.status === 'running' || task.status === 'finished' ? task.status : 'backlog', to, targetIndex: index, expectedRevision: task.source.revision },
      );
    },
    editor: (state: ProximaState): TaskEditorWriteDependencies => ({
      state,
      writes: async () => ({ updateTask: (input) => updateTask(deps, input), deleteTask: async () => { throw new Error('not used'); } }),
      unavailableReason: () => null,
      refresh: refreshFromSource,
      setRefusal: () => undefined,
      render: () => undefined,
    }),
  };
}

/** Mount the three surfaces that group, differ or list a task, over one projection. */
function mountSurfaces(state: ProximaState, selectedTaskId: string | null = null): void {
  const project = state.projects[0]!;
  document.body.innerHTML = [
    renderElasticCockpit({
      state,
      tasks: state.tasks,
      projectNames: new Map([[project.id, project.name]]),
      selectionLabel: 'All projects',
      session: { targetTime: '2026-09-12T09:00:00.000Z', lockedAt: null },
      now: new Date(CLOCK_ISO),
      selectedTaskId,
      editorDraft: null,
      dropRefusal: null,
      taskWrites: { refusal: null, editorRefusal: null },
    }),
    renderProjectTaskBoard(state, project, EMPTY_PROJECT_TASK_BOARD_VIEW),
    renderProjectBacklog(state, project, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: project.id }),
  ].join('');
}

function inColumn(columnKey: string, taskKey: string): boolean {
  const column = document.querySelector(`[data-c1-key="${columnKey}"]`);
  if (column === null) throw new Error(`no column ${columnKey}`);
  return column.querySelector(`[data-c1-key="${taskKey}"]`) !== null;
}

function executionStateOf(state: ProximaState, taskId: string): string | undefined {
  return projectTaskEditor(state, taskId, null)?.sections[0]?.fields.find((field) => field.id === 'executionState')?.value;
}

function backlogOrderOf(taskId: string): string | null {
  return document.querySelector(`[data-c1-key="project-backlog-task-${taskId}"]`)?.getAttribute('data-project-backlog-order') ?? null;
}

describe('Stage 19 a change made on Elastic reaches the other surfaces', () => {
  it('moves the card on every surface that groups by execution state, and nowhere else', async () => {
    const app = await world();
    const id = await app.seed('Converges');

    mountSurfaces(await app.read());
    expect(inColumn('board-column-backlog', `elastic-task-${id}`)).toBe(true);
    expect(inColumn('project-board-column-backlog', `project-board-task-${id}`)).toBe(true);
    expect(executionStateOf(await app.read(), id)).toBe('backlog');
    expect(backlogOrderOf(id)).toBe('0');

    const moved = await app.drop(id, 'running', 2);
    expect(moved).toMatchObject({ ok: true, actionType: 'task.execution.move', refreshed: true });

    // The re-read is the product's own, so what is mounted now is what a person would see.
    const after = await app.read();
    mountSurfaces(after);

    // Elastic: the card is in Running.
    expect(inColumn('board-column-running', `elastic-task-${id}`)).toBe(true);
    expect(inColumn('board-column-backlog', `elastic-task-${id}`)).toBe(false);
    // The project Task Board groups by the same status, so the card moved there too.
    expect(inColumn('project-board-column-running', `project-board-task-${id}`)).toBe(true);
    expect(inColumn('project-board-column-backlog', `project-board-task-${id}`)).toBe(false);
    // The Task editor shows the record's new state, and the Backlog row its new order.
    expect(executionStateOf(after, id)).toBe('running');
    expect(backlogOrderOf(id)).toBe('2');

    // A2: the deadline surfaces are not the execution state, so a column move leaves them alone.
    const task = after.tasks.find((candidate) => candidate.id === id)!;
    expect(task.deadline).toBe(DEADLINE);
    expect(task.isCompleted).toBe(false);
  });

  it('carries a card editor save to the same surfaces', async () => {
    const app = await world();
    const id = await app.seed('Editor name');
    const before = await app.read();
    const seed = taskEditorDraftFor(before.tasks.find((candidate) => candidate.id === id)!);

    mountSurfaces(before);
    expect(document.querySelector(`[data-c1-key="project-backlog-task-${id}"]`)!.textContent).toContain('Editor name');

    const saved = await saveTaskAction(app.editor(before), {
      taskId: id,
      draft: applyTaskEditorEdit(seed, { fieldId: 'name', value: 'Saved on Elastic' }),
    });
    expect(saved).toMatchObject({ clearDraft: true });
    expect(saved.outcome).toMatchObject({ ok: true, outcome: 'updated' });

    const after = await app.read();
    mountSurfaces(after, id);

    expect(document.querySelector(`[data-c1-key="project-backlog-task-${id}"]`)!.textContent).toContain('Saved on Elastic');
    expect(document.querySelector(`[data-c1-key="project-board-task-${id}"]`)!.textContent).toContain('Saved on Elastic');
    expect(document.querySelector(`[data-c1-key="elastic-task-${id}"]`)!.textContent).toContain('Saved on Elastic');
    expect(projectTaskEditor(after, id, null)!.title).toBe('Saved on Elastic');
  });
});
