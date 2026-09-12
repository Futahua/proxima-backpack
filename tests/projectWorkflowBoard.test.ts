// @vitest-environment happy-dom
/**
 * The workflow board: grouped by stage, dragged by stage, and the drop that writes it.
 *
 * Two halves in one file because they are one story. The board half is rendered and driven through
 * the real renderer and binder: columns are the project's stages, a card carries both its stage and
 * its execution state (A2 in the markup), the pointer's column is marked while a drag is over it,
 * and a drop reports the stage it landed on. The sequence half runs the drop the shell actually
 * calls, against a real store and the real recovery gate, so "the card moved" means the record did.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { performWorkflowDrop, type WorkflowBoardDropDependencies, type WorkflowBoardDropOutcome } from '../src/app/workflowBoardDrop.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { CanonicalWorkflowStageStateRecord } from '../src/domain/canonicalTaskState.js';
import type { Project, ProximaState } from '../src/domain/types.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  bindProjectWorkflowBoardInteractions,
  EMPTY_PROJECT_WORKFLOW_BOARD_VIEW,
  NO_WORKFLOW_STAGE,
  projectHasWorkflow,
  renderProjectWorkflowBoard,
  workflowStagesFor,
  type ProjectWorkflowBoardViewState,
  type ProjectWorkflowMoveIntent,
} from '../src/browser/projectWorkflowBoard.js';
import { renderProjectWorkspace } from '../src/browser/projectWorkspace.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T07:30:00+07:00';

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

const PROJECT_ID = idFromLastByte(81);
const DESIGN = idFromLastByte(82);
const REVIEW = idFromLastByte(83);

/** A project whose state declares two stages, used for the surface cases. */
const project: Project = {
  id: PROJECT_ID,
  source: { path: PROJECT_ID, revision: `${PROJECT_ID}@1`, kind: 'project', idOrigin: 'record-store' },
  name: 'Project',
  description: '',
  createdAt: '2026-08-01T00:00:00.000Z',
  status: 'active',
  projectType: 'task',
  linkedFolders: [],
};

function task(id: string, name: string, stageId: string | null, workflowOrder: number | null, status: 'backlog' | 'running' | 'finished' = 'running'): ProximaState['tasks'][number] {
  return {
    id,
    source: { path: id, revision: `${id}@1`, kind: 'task', idOrigin: 'record-store' },
    name,
    description: '',
    projectId: PROJECT_ID,
    status,
    weight: 1,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: status === 'finished',
    createdAt: '2026-08-01T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
    workflowStageId: stageId,
    workflowOrder,
  };
}

function boardState(): ProximaState {
  return {
    projects: [project],
    tasks: [
      task('in-review', 'In review', REVIEW, 1),
      task('in-design-second', 'Design second', DESIGN, 2),
      task('in-design-first', 'Design first', DESIGN, 1),
      task('staged-nowhere', 'No stage task', null, null),
    ],
    events: [],
    statuses: [
      { id: 'backlog', name: 'Backlog', color: '#636e72', column: 'backlog' },
      { id: 'running', name: 'Running', color: '#00b894', column: 'running' },
      { id: 'finished', name: 'Finished', color: '#fdcb6e', column: 'finished' },
    ],
    taskSchema: [],
    workflowStages: [
      { id: DESIGN, projectId: PROJECT_ID, name: 'Design', revision: `${DESIGN}@1` },
      { id: REVIEW, projectId: PROJECT_ID, name: 'Review', revision: `${REVIEW}@1` },
    ],
  };
}

describe('Stage 10 project workflow board surface', () => {
  it('groups by stage, keeps the execution state on the card, and holds the tasks with no stage', () => {
    const state = boardState();
    document.body.innerHTML = renderProjectWorkflowBoard(state, project);

    const columns = Array.from(document.querySelectorAll<HTMLElement>('[data-project-workflow-stage-column]'));
    expect(columns.map((column) => column.dataset.projectWorkflowStageColumn)).toEqual([DESIGN, REVIEW, 'no-stage']);
    expect(columns.map((column) => column.querySelector('header strong')?.textContent)).toEqual(['Design', 'Review', 'No stage']);

    // A2 is visible in the markup: the card is in Review *and* it is Running.
    const reviewCard = document.querySelector<HTMLElement>('[data-project-workflow-task-id="in-review"]')!;
    expect(reviewCard.dataset.projectWorkflowStage).toBe(REVIEW);
    expect(reviewCard.dataset.projectWorkflowExecutionState).toBe('running');
    expect(reviewCard.querySelector('.task-status')?.textContent).toBe('running');

    // Within a column the order is the workflow order, not the arrival order.
    const designCards = Array.from(columns[0]!.querySelectorAll<HTMLElement>('[data-project-workflow-task-id]'))
      .map((card) => card.dataset.projectWorkflowTaskId);
    expect(designCards).toEqual(['in-design-first', 'in-design-second']);
    expect(Array.from(columns[2]!.querySelectorAll<HTMLElement>('[data-project-workflow-task-id]')).map((card) => card.dataset.projectWorkflowTaskId)).toEqual(['staged-nowhere']);
  });

  it('picks the workflow board for a project that has stages, and the status board for one that does not', () => {
    const state = boardState();
    expect(projectHasWorkflow(state, project)).toBe(true);
    expect(workflowStagesFor(state, project).map((stage) => stage.name)).toEqual(['Design', 'Review']);

    const workflowMarkup = renderProjectWorkspace({ state, project, tab: 'task-board', now: new Date(CLOCK_ISO) });
    expect(workflowMarkup).toContain('data-c1-key="project-workflow-board"');
    expect(workflowMarkup).not.toContain('data-project-board-status-column');

    // A legacy vault declares no stages at all, so the status board is still the board it gets.
    const legacy: ProximaState = { ...state, workflowStages: [] };
    expect(projectHasWorkflow(legacy, project)).toBe(false);
    const statusMarkup = renderProjectWorkspace({ state: legacy, project, tab: 'task-board', now: new Date(CLOCK_ISO) });
    expect(statusMarkup).toContain('data-project-board-status-column');
    expect(statusMarkup).not.toContain('data-c1-key="project-workflow-board"');
  });

  it('marks the column under the pointer and reports the stage a drop landed on', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let view: ProjectWorkflowBoardViewState = { ...EMPTY_PROJECT_WORKFLOW_BOARD_VIEW, projectId: PROJECT_ID };
    const previews: ProjectWorkflowMoveIntent[] = [];
    const drops: ProjectWorkflowMoveIntent[] = [];
    const draw = () => { root.innerHTML = renderProjectWorkflowBoard(boardState(), project, view); };

    draw();
    bindProjectWorkflowBoardInteractions(root, {
      openTask: () => undefined,
      closeTask: () => undefined,
      startDrag: (taskId) => { view = { ...view, dragTaskId: taskId }; },
      // A preview records the view state and does not re-render, exactly as production does: the
      // immediate feedback is the binder's, and a redraw would be a second one.
      previewMove: (intent) => { previews.push(intent); view = { ...view, dragTaskId: intent.taskId, dragTargetStageId: intent.targetStageId ?? NO_WORKFLOW_STAGE, dragTargetIndex: intent.targetIndex }; },
      dropMove: (intent) => { drops.push(intent); },
      clearDrag: () => { view = { ...view, dragTaskId: null, dragTargetStageId: null, dragTargetIndex: null }; },
      // This file is about the drop; the board's stage controls have their own suite.
      openStageForm: () => undefined,
      editStageName: () => undefined,
      saveStageForm: () => undefined,
      deleteStage: () => undefined,
      closeStageForm: () => undefined,
    });

    const harness = createInteractionHarness(root);
    const drag = harness.beginDrag('project-workflow-task-in-design-first', { clientX: 0, clientY: 0 });
    drag.move(`project-workflow-drop-${PROJECT_ID}-${REVIEW}-1`, { clientX: 1, clientY: 1 });

    // Destination feedback: the column the pointer is over is marked, and the others are not.
    const columnOf = (key: string) => root.querySelector<HTMLElement>(`[data-project-workflow-stage-column="${key}"]`)!;
    expect(columnOf(REVIEW).dataset.projectWorkflowDragTarget).toBe('true');
    expect(columnOf(DESIGN).dataset.projectWorkflowDragTarget).toBe('false');
    // And the slot's insertion placeholder is open at the size the board uses.
    const slot = root.querySelector<HTMLElement>(`[data-project-workflow-drop-stage="${REVIEW}"][data-project-workflow-drop-index="1"]`)!;
    expect(slot.querySelector<HTMLElement>('.project-board-insertion-placeholder')!.style.height).toBe('54px');
    expect(previews).toEqual([{ taskId: 'in-design-first', targetStageId: REVIEW, targetIndex: 1 }]);

    drag.drop(`project-workflow-drop-${PROJECT_ID}-${REVIEW}-1`, { clientX: 1, clientY: 1 });
    // A drop reports the stage and the position; what it means is the app layer's business.
    expect(drops).toEqual([{ taskId: 'in-design-first', targetStageId: REVIEW, targetIndex: 1 }]);

    // The trailing column takes a card out of the workflow, and says so with a null stage.
    const outside = createInteractionHarness(root);
    const second = outside.beginDrag('project-workflow-task-in-review', { clientX: 0, clientY: 0 });
    second.move(`project-workflow-drop-${PROJECT_ID}-no-stage-0`, { clientX: 1, clientY: 1 });
    second.drop(`project-workflow-drop-${PROJECT_ID}-no-stage-0`, { clientX: 1, clientY: 1 });
    expect(drops[1]).toEqual({ taskId: 'in-review', targetStageId: null, targetIndex: 0 });
  });

  it('opens and closes the inspector for a card, showing its stage beside its execution state', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let selected: string | null = null;
    const draw = () => { root.innerHTML = renderProjectWorkflowBoard(boardState(), project, { ...EMPTY_PROJECT_WORKFLOW_BOARD_VIEW, projectId: PROJECT_ID, selectedTaskId: selected }); };
    draw();
    bindProjectWorkflowBoardInteractions(root, {
      openTask: (taskId) => { selected = taskId; draw(); },
      closeTask: () => { selected = null; draw(); },
      startDrag: () => undefined,
      previewMove: () => undefined,
      dropMove: () => undefined,
      clearDrag: () => undefined,
      openStageForm: () => undefined,
      editStageName: () => undefined,
      saveStageForm: () => undefined,
      deleteStage: () => undefined,
      closeStageForm: () => undefined,
    });

    createInteractionHarness(root).click('project-workflow-task-in-review');
    const inspector = root.querySelector<HTMLElement>('[data-project-workflow-inspector-task-id="in-review"]')!;
    expect(inspector.querySelector('[data-project-workflow-detail="stage"] dd')?.textContent).toBe('Review');
    expect(inspector.querySelector('[data-project-workflow-detail="execution-state"] dd')?.textContent).toBe('running');

    createInteractionHarness(root).pressKey('project-workflow-task-inspector', 'Escape');
    expect(root.querySelector('[data-project-workflow-inspector-task-id]')).toBeNull();
  });
});

interface World {
  readonly store: ReturnType<typeof createCanonicalJsonRecordStore>;
  readonly deps: TaskMutationDependencies;
  readonly refreshCalls: string[];
  state(): Promise<ProximaState>;
  settle(id: OpaqueRecordId): Promise<CanonicalTaskRecordV2>;
  drop(input: { taskId: string; targetStageId: string | null; targetIndex: number; rendered?: ProximaState }): Promise<WorkflowBoardDropOutcome>;
  seedTask(): Promise<{ id: OpaqueRecordId; revision: string }>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 900;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };

  const projectRecord: CanonicalProjectRecordV2 = {
    ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT_ID, name: 'Project' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
  const stage = (id: OpaqueRecordId, name: string): CanonicalWorkflowStageStateRecord => ({
    ...defineCanonicalRecordHeader({ kind: 'workflow-stage', id, name }),
    projectId: PROJECT_ID,
  });
  for (const record of [projectRecord, stage(DESIGN, 'Design'), stage(REVIEW, 'Review')]) {
    await store.createIfAbsent(record as CanonicalRecordV2);
  }

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const refreshCalls: string[] = [];
  const read = async (): Promise<ProximaState> => (await source.load()).state;

  return {
    store,
    deps,
    refreshCalls,
    state: read,
    settle: async (id) => {
      const observation = await store.read(id);
      if (observation === undefined) throw new Error(`task ${id} is not in the store`);
      return observation.record as CanonicalTaskRecordV2;
    },
    seedTask: async () => {
      const created = await createTask(deps, {
        name: 'Workflow task',
        projectId: PROJECT_ID,
        executionState: 'running',
        executionOrder: 4,
        workflowStageId: DESIGN,
        workflowOrder: 1,
      });
      if (!created.ok) throw new Error(`seeding failed: ${created.reason}`);
      return { id: created.recordId, revision: created.revision };
    },
    drop: async (input) => {
      const rendered = input.rendered ?? await read();
      const depsForDrop: WorkflowBoardDropDependencies = {
        state: rendered,
        writes: async () => ({ updateTask: (request) => updateTask(deps, request) }),
        unavailableReason: () => 'record-writes-need-an-activated-store',
        refresh: async (reason: RefreshReason): Promise<RefreshResult> => {
          refreshCalls.push(reason);
          return await refresh.refreshSource(reason);
        },
        setRefusal: () => undefined,
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      };
      const outcome = await performWorkflowDrop(depsForDrop, {
        taskId: input.taskId,
        targetStageId: input.targetStageId,
        targetIndex: input.targetIndex,
      });
      return outcome;
    },
  };
}

describe('Stage 10 workflow board drop', () => {
  it('writes the stage the card was dropped on, and leaves the execution dimension alone', async () => {
    const app = await world();
    const task = await app.seedTask();

    const outcome = await app.drop({ taskId: task.id, targetStageId: REVIEW, targetIndex: 2 });

    expect(outcome).toMatchObject({ ok: true, workflowAction: 'move', refreshed: true });
    expect(app.refreshCalls).toEqual(['manual']);
    // A2 as data, through the same path the board uses: Review, still Running, Elastic order intact.
    expect(await app.settle(task.id)).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 2, executionState: 'running', executionOrder: 4 });
    const projected = (await app.state()).tasks[0]!;
    expect(projected).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 2, status: 'running', orderIndex: 4 });
  });

  it('treats a drop inside a stage as an order change, and a drop on the trailing column as leaving', async () => {
    const app = await world();
    const task = await app.seedTask();

    expect(await app.drop({ taskId: task.id, targetStageId: DESIGN, targetIndex: 0 })).toMatchObject({ ok: true, workflowAction: 'reorder' });
    expect(await app.settle(task.id)).toMatchObject({ workflowStageId: DESIGN, workflowOrder: 0, executionOrder: 4 });

    const leaving = await app.drop({ taskId: task.id, targetStageId: null, targetIndex: 0 });
    expect(leaving).toMatchObject({ ok: true, workflowAction: 'leave' });
    expect(await app.settle(task.id)).toMatchObject({ workflowStageId: null, workflowOrder: null, executionState: 'running' });
  });

  it('refuses a card the board is not showing, and a run with no write path, without writing', async () => {
    const app = await world();
    const task = await app.seedTask();

    const unknown = await app.drop({ taskId: 'not-a-card', targetStageId: REVIEW, targetIndex: 0 });
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown-task' });
    expect(app.refreshCalls).toEqual([]);

    // A write path that refuses: the sequence reports the reason the shell gave it and draws it.
    const rendered = await app.state();
    const refusals: (string | null)[] = [];
    const outcome = await performWorkflowDrop(
      {
        state: rendered,
        writes: async () => null,
        unavailableReason: () => 'record-writes-need-an-activated-store',
        refresh: async () => null,
        setRefusal: (reason) => { refusals.push(reason); },
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      },
      { taskId: task.id, targetStageId: REVIEW, targetIndex: 0 },
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'writes-unavailable', detail: 'record-writes-need-an-activated-store' });
    expect(refusals).toEqual([null, 'record-writes-need-an-activated-store']);
    expect(await app.settle(task.id)).toMatchObject({ workflowStageId: DESIGN, workflowOrder: 1 });
  });

  it('sends a card that lost a race back to where the store says it is', async () => {
    const app = await world();
    const task = await app.seedTask();
    const rendered = await app.state();

    // Someone else moves it first, so the board's revision is stale.
    const winner = await updateTask(app.deps, {
      taskId: task.id,
      expectedRevision: task.revision,
      mutations: [{ kind: 'workflow-stage', value: REVIEW, order: 0 }],
    });
    expect(winner.ok).toBe(true);

    const refused = await app.drop({ taskId: task.id, targetStageId: DESIGN, targetIndex: 3, rendered });

    expect(refused).toMatchObject({ ok: false, reason: 'stale-revision', refreshed: true });
    expect(await app.settle(task.id)).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 0 });
    expect((await app.state()).tasks[0]).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 0 });
  });
});
