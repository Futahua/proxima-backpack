// @vitest-environment happy-dom
/**
 * The workflow board's stage controls: New stage, Rename and Delete.
 *
 * The box this file closes is Stage 17's `workflow stage create` / `stage rename` /
 * `stage delete/remap`, so the evidence has to be both halves of the same story. The surface half
 * renders the real board and drives it through the real binder: the controls exist, they are
 * disabled with the typed reason when this run has no write path, the form is opened, typed into
 * and submitted, and a disabled control reports nothing. The sequence half runs what the shell
 * actually calls, against a real store and the real recovery gate, so "the stage was created" means
 * the record was.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import {
  createWorkflowStage,
  deleteWorkflowStage,
  renameWorkflowStage,
  type WorkflowStageMutationDependencies,
} from '../src/app/workflowStageMutations.js';
import {
  createWorkflowStageAction,
  deleteWorkflowStageAction,
  renameWorkflowStageAction,
  type WorkflowStageWriteOperations,
} from '../src/app/workflowStageWriteActions.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { CanonicalWorkflowStageStateRecord } from '../src/domain/canonicalTaskState.js';
import type { ProximaState } from '../src/domain/types.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  bindProjectWorkflowBoardInteractions,
  EMPTY_PROJECT_WORKFLOW_BOARD_VIEW,
  renderProjectWorkflowBoard,
  type ProjectWorkflowBoardViewState,
} from '../src/browser/projectWorkflowBoard.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T08:00:00+07:00';
const STAGE_UNAVAILABLE = 'record-writes-need-an-activated-store';

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

const PROJECT_ID = idFromLastByte(101);
const DESIGN = idFromLastByte(102);
const REVIEW = idFromLastByte(103);

interface StageWorld {
  files: MemoryRecordFiles;
  deps: WorkflowStageMutationDependencies;
  operations: WorkflowStageWriteOperations;
  state: () => Promise<ProximaState>;
  stage: (id: OpaqueRecordId) => Promise<CanonicalWorkflowStageStateRecord | undefined>;
  task: (id: OpaqueRecordId) => Promise<CanonicalTaskRecordV2 | undefined>;
  seedCard: (stageId: OpaqueRecordId) => Promise<OpaqueRecordId>;
  /** What the shell's two sinks hold after a sequence ran. */
  sinks: { refusal: string | null; feedback: string | null };
  refreshCalls: string[];
  run: (
    verb: 'create' | 'rename' | 'delete',
    input: { projectId?: string; stageId?: string; name?: string; remapTo?: { kind: 'no-stage' } },
    rendered?: ProximaState,
  ) => Promise<{ ok: boolean; reason?: string; detail?: string; remappedTaskIds?: readonly OpaqueRecordId[] }>;
}

async function world(): Promise<StageWorld> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  await recovery.load();
  const authority = await startRecordMutationAuthority({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
  });
  if (authority.mutationAuthority !== 'available') throw new Error('the recovery gate refused authority');

  let nextId = 120;
  const taskDeps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const deps: WorkflowStageMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    allocateRecordId: () => idFromLastByte(nextId++),
    taskDependencies: taskDeps,
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
    const created = await store.createIfAbsent(record as CanonicalRecordV2);
    expect(created.ok).toBe(true);
  }

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const sinks = { refusal: null as string | null, feedback: null as string | null };
  const refreshCalls: string[] = [];

  const operations: WorkflowStageWriteOperations = {
    createWorkflowStage: (request) => createWorkflowStage(deps, request),
    renameWorkflowStage: (input) => renameWorkflowStage(deps, input),
    deleteWorkflowStage: (input) => deleteWorkflowStage(deps, input),
  };

  return {
    files,
    deps,
    operations,
    sinks,
    refreshCalls,
    state: async () => (await source.load()).state,
    stage: async (id) => {
      const observation = await store.read(id);
      return observation?.kind === 'workflow-stage'
        ? observation.record as CanonicalWorkflowStageStateRecord
        : undefined;
    },
    task: async (id) => {
      const observation = await store.read(id);
      return observation?.kind === 'task' ? observation.record as CanonicalTaskRecordV2 : undefined;
    },
    seedCard: async (stageId) => {
      const created = await createTask(taskDeps, {
        name: 'A card in the stage',
        projectId: PROJECT_ID,
        executionState: 'running',
        executionOrder: 4,
        workflowStageId: stageId,
        workflowOrder: 1,
      });
      if (!created.ok) throw new Error(`seeding failed: ${created.reason}`);
      return created.recordId;
    },
    run: async (verb, input, rendered) => {
      const depsForWrite = {
        state: rendered ?? await source.load().then((projection) => projection.state) ?? null,
        writes: async () => operations,
        unavailableReason: () => STAGE_UNAVAILABLE,
        refresh: async (reason: RefreshReason): Promise<RefreshResult> => {
          refreshCalls.push(reason);
          return await refresh.refreshSource(reason);
        },
        setRefusal: (reason: string | null) => { sinks.refusal = reason; },
        setFeedback: (message: string | null) => { sinks.feedback = message; },
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      };
      if (verb === 'create') {
        return await createWorkflowStageAction(depsForWrite, {
          projectId: input.projectId ?? PROJECT_ID,
          name: input.name ?? '',
        });
      }
      if (verb === 'rename') {
        return await renameWorkflowStageAction(depsForWrite, {
          stageId: input.stageId ?? DESIGN,
          name: input.name ?? '',
        });
      }
      return await deleteWorkflowStageAction(depsForWrite, {
        stageId: input.stageId ?? DESIGN,
        ...(input.remapTo === undefined ? {} : { remapTo: input.remapTo }),
      });
    },
  };
}

/** The board's own stage view state, over a state the test supplies. */
function boardView(overrides: Partial<ProjectWorkflowBoardViewState> = {}): ProjectWorkflowBoardViewState {
  return { ...EMPTY_PROJECT_WORKFLOW_BOARD_VIEW, projectId: PROJECT_ID, ...overrides };
}

describe('the workflow board stage surface', () => {
  it('offers New stage, Rename and Delete for every stage, and the reason instead when this run cannot write', async () => {
    const app = await world();
    const state = await app.state();

    const available = document.createElement('div');
    available.innerHTML = renderProjectWorkflowBoard(state, state.projects[0]!, boardView());
    expect(available.querySelector('[data-papers-visual-key="project-workflow-stage-new"]')).not.toBeNull();
    expect(available.querySelector(`[data-papers-visual-key="project-workflow-stage-rename-${DESIGN}"]`)).not.toBeNull();
    expect(available.querySelector(`[data-papers-visual-key="project-workflow-stage-delete-${REVIEW}"]`)).not.toBeNull();
    expect(available.querySelector('[data-project-workflow-stage-write]')!.getAttribute('data-project-workflow-stage-write')).toBe('available');
    // The trailing column is not a stage, so it gets no stage controls.
    expect(available.querySelector('[data-project-workflow-stage-column="no-stage"] [data-project-workflow-action="rename-stage"]')).toBeNull();

    const unavailable = document.createElement('div');
    unavailable.innerHTML = renderProjectWorkflowBoard(state, state.projects[0]!, boardView({ stageWriteRefusal: STAGE_UNAVAILABLE }));
    const button = unavailable.querySelector<HTMLButtonElement>('[data-papers-visual-key="project-workflow-stage-new"]')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-project-workflow-stage-write-refusal')).toBe(STAGE_UNAVAILABLE);
    expect(unavailable.querySelector('[data-project-workflow-stage-write]')!.getAttribute('data-project-workflow-stage-write')).toBe('unavailable');

    // A disabled control reports nothing through the binder: it is not an inert button that looks
    // live, and it is not a live button that writes nothing.
    const root = document.createElement('div');
    document.body.appendChild(root);
    let opened = 0;
    root.innerHTML = renderProjectWorkflowBoard(state, state.projects[0]!, boardView({ stageWriteRefusal: STAGE_UNAVAILABLE }));
    bindProjectWorkflowBoardInteractions(root, {
      openTask: () => undefined,
      closeTask: () => undefined,
      startDrag: () => undefined,
      previewMove: () => undefined,
      dropMove: () => undefined,
      clearDrag: () => undefined,
      openStageForm: () => { opened += 1; },
      editStageName: () => undefined,
      saveStageForm: () => undefined,
      deleteStage: () => undefined,
      closeStageForm: () => undefined,
    });
    createInteractionHarness(root).click('project-workflow-stage-new');
    expect(opened).toBe(0);
  });

  it('opens the create form, types into it, and submits what was typed', async () => {
    const app = await world();
    const state = await app.state();
    const root = document.createElement('div');
    document.body.appendChild(root);
    let view = boardView();
    const saves: string[] = [];
    const draw = () => { root.innerHTML = renderProjectWorkflowBoard(state, state.projects[0]!, view); };

    draw();
    bindProjectWorkflowBoardInteractions(root, {
      openTask: () => undefined,
      closeTask: () => undefined,
      startDrag: () => undefined,
      previewMove: () => undefined,
      dropMove: () => undefined,
      clearDrag: () => undefined,
      openStageForm: (form) => {
        view = { ...view, stageForm: form.kind === 'create' ? { kind: 'create', name: '' } : { kind: 'rename', stageId: form.stageId, name: 'Design' } };
        draw();
      },
      editStageName: (value) => {
        const form = view.stageForm;
        if (form === null || form === undefined) return;
        view = { ...view, stageForm: { ...form, name: value } };
        draw();
      },
      saveStageForm: () => {
        const form = view.stageForm;
        saves.push(form === null || form === undefined ? 'none' : `${form.kind}:${form.name}`);
      },
      deleteStage: () => undefined,
      closeStageForm: () => { view = { ...view, stageForm: null }; draw(); },
    });

    const harness = createInteractionHarness(root);
    harness.click('project-workflow-stage-new');
    expect(view.stageForm).toEqual({ kind: 'create', name: '' });
    expect(root.querySelector('[data-papers-visual-key="project-workflow-stage-name"]')).not.toBeNull();

    // Typing is the field reporting what it holds, not the shell reading the DOM at Save time.
    const field = root.querySelector<HTMLInputElement>('[data-papers-visual-key="project-workflow-stage-name"]')!;
    field.value = 'Waiting';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.stageForm).toEqual({ kind: 'create', name: 'Waiting' });

    harness.click('project-workflow-stage-save');
    expect(saves).toEqual(['create:Waiting']);

    // Escape is the same discard Cancel is, as it is on every other form in this tree.
    harness.click('project-workflow-stage-cancel');
    expect(view.stageForm).toBeNull();
    expect(root.querySelector('[data-papers-visual-key="project-workflow-stage-name"]')).toBeNull();
  });

  it('opens the rename form for the stage that was clicked, pre-filled with that stage name', async () => {
    const app = await world();
    const state = await app.state();
    const root = document.createElement('div');
    document.body.appendChild(root);
    let view = boardView();
    const saved: string[] = [];
    const draw = () => { root.innerHTML = renderProjectWorkflowBoard(state, state.projects[0]!, view); };

    draw();
    bindProjectWorkflowBoardInteractions(root, {
      openTask: () => undefined,
      closeTask: () => undefined,
      startDrag: () => undefined,
      previewMove: () => undefined,
      dropMove: () => undefined,
      clearDrag: () => undefined,
      openStageForm: (form) => {
        const found = (state.workflowStages ?? []).find((candidate) => form.kind === 'rename' && candidate.id === form.stageId);
        view = {
          ...view,
          stageForm: form.kind === 'create'
            ? { kind: 'create', name: '' }
            : { kind: 'rename', stageId: form.stageId, name: found?.name ?? '' },
        };
        draw();
      },
      editStageName: (value) => {
        const form = view.stageForm;
        if (form === null || form === undefined) return;
        view = { ...view, stageForm: { ...form, name: value } };
        draw();
      },
      saveStageForm: () => {
        const form = view.stageForm;
        saved.push(form === null || form === undefined ? 'none' : form.kind === 'create' ? `create:${form.name}` : `rename:${form.stageId}:${form.name}`);
      },
      deleteStage: () => undefined,
      closeStageForm: () => { view = { ...view, stageForm: null }; draw(); },
    });

    createInteractionHarness(root).click(`project-workflow-stage-rename-${REVIEW}`);
    expect(view.stageForm).toEqual({ kind: 'rename', stageId: REVIEW, name: 'Review' });
    const field = root.querySelector<HTMLInputElement>(`[data-papers-visual-key="project-workflow-stage-name-${REVIEW}"]`)!;
    expect(field.value).toBe('Review');

    field.value = 'In review';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    createInteractionHarness(root).click(`project-workflow-stage-save-${REVIEW}`);
    expect(saved).toEqual([`rename:${REVIEW}:In review`]);
  });
});

describe('the workflow board stage writes', () => {
  it('creates the stage the form described, and the board draws it on the next read', async () => {
    const app = await world();

    const outcome = await app.run('create', { name: '  Waiting  ' });

    expect(outcome).toMatchObject({ ok: true, outcome: 'created', refreshed: true });
    expect(app.refreshCalls).toEqual(['manual']);
    expect(app.sinks.feedback).toBe('Created the stage Waiting.');
    expect(app.sinks.refusal).toBeNull();

    const state = await app.state();
    const created = (state.workflowStages ?? []).find((stage) => stage.name === 'Waiting');
    expect(created).toBeDefined();
    expect(await app.stage(created!.id as OpaqueRecordId)).toMatchObject({
      name: 'Waiting',
      projectId: PROJECT_ID,
    });

    // And the rendered board the next read produces carries the new column.
    const markup = renderProjectWorkflowBoard(state, state.projects[0]!, boardView());
    expect(markup).toContain('Waiting');
  });

  it('renames at the revision the board was rendering, and refuses a board that is already stale', async () => {
    const app = await world();
    const rendered = await app.state();

    const renamed = await app.run('rename', { stageId: DESIGN, name: 'Designing' }, rendered);
    expect(renamed).toMatchObject({ ok: true, outcome: 'renamed', refreshed: true });
    expect(app.sinks.feedback).toBe('Renamed the stage to Designing.');
    expect(await app.stage(DESIGN)).toMatchObject({ name: 'Designing' });

    // The same rendered world again: its revision is the one the rename already replaced.
    const stale = await app.run('rename', { stageId: DESIGN, name: 'Typed over a stale board' }, rendered);
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(app.sinks.refusal).toBe('stale-revision');
    expect(await app.stage(DESIGN)).toMatchObject({ name: 'Designing' });
    // A lost race re-reads rather than redrawing from the guess, so the board now shows the winner.
    expect(app.refreshCalls).toEqual(['manual', 'manual']);
  });

  it('answers Delete on a stage that still holds cards with the count and the question, and deletes an empty one', async () => {
    const app = await world();
    const card = await app.seedCard(DESIGN);
    const rendered = await app.state();

    const refused = await app.run('delete', { stageId: DESIGN }, rendered);
    expect(refused).toMatchObject({ ok: false, reason: 'semantic-conflict' });
    expect(refused.detail).toBe('the stage still holds 1 task(s); say where they go before deleting it');
    expect(app.sinks.refusal).toBe('semantic-conflict');
    // Nothing moved: the stage is still there and the card still names it.
    expect(await app.stage(DESIGN)).toBeDefined();
    expect(await app.task(card)).toMatchObject({ workflowStageId: DESIGN, workflowOrder: 1 });

    // The board's own Delete never decides for the reader, and it never refuses what it can do.
    const emptied = await app.run('delete', { stageId: REVIEW });
    expect(emptied).toMatchObject({ ok: true, outcome: 'deleted' });
    expect(app.sinks.feedback).toBe('Deleted the stage.');
    expect(await app.stage(REVIEW)).toBeUndefined();
    const state = await app.state();
    expect((state.workflowStages ?? []).some((stage) => stage.id === REVIEW)).toBe(false);
  });

  it('moves the cards and then deletes when the caller names the destination', async () => {
    const app = await world();
    const card = await app.seedCard(DESIGN);

    const deleted = await app.run('delete', { stageId: DESIGN, remapTo: { kind: 'no-stage' } });

    expect(deleted).toMatchObject({ ok: true, outcome: 'deleted', remappedTaskIds: [card] });
    expect(app.sinks.feedback).toBe('Deleted the stage and moved 1 card.');
    expect(await app.stage(DESIGN)).toBeUndefined();
    expect(await app.task(card)).toMatchObject({ workflowStageId: null, workflowOrder: null });
    // No card is left naming a stage that is gone.
    const state = await app.state();
    expect(state.tasks[0]).toMatchObject({ workflowStageId: null });
  });
});

describe('the workflow board stage writes, driven through the rendered surface', () => {
  it('creates the stage a reader typed into the board, into a real store, and draws it', async () => {
    const app = await world();
    let state = await app.state();
    const root = document.createElement('div');
    document.body.appendChild(root);
    let view = boardView();
    const pending: Promise<void>[] = [];
    const draw = () => { root.innerHTML = renderProjectWorkflowBoard(state, state.projects[0]!, view); };

    draw();
    bindProjectWorkflowBoardInteractions(root, {
      openTask: () => undefined,
      closeTask: () => undefined,
      startDrag: () => undefined,
      previewMove: () => undefined,
      dropMove: () => undefined,
      clearDrag: () => undefined,
      openStageForm: (form) => {
        view = { ...view, stageForm: form.kind === 'create' ? { kind: 'create', name: '' } : { kind: 'rename', stageId: form.stageId, name: '' }, stageRefusal: null, stageFeedback: null };
        draw();
      },
      editStageName: (value) => {
        const form = view.stageForm;
        if (form === null || form === undefined) return;
        view = { ...view, stageForm: { ...form, name: value } };
        draw();
      },
      // The shell's own handler: run the sequence, and close the form only when it was accepted.
      saveStageForm: () => {
        const form = view.stageForm;
        if (form === null || form === undefined) return;
        pending.push((async () => {
          const outcome = form.kind === 'create'
            ? await createWorkflowStageAction(
                {
                  state: state ?? null,
                  writes: async () => app.operations,
                  unavailableReason: () => STAGE_UNAVAILABLE,
                  refresh: async () => null,
                  setRefusal: (reason) => { view = { ...view, stageRefusal: reason }; },
                  setFeedback: (message) => { view = { ...view, stageFeedback: message }; },
                  render: () => undefined,
                  ids: semanticIds(),
                  audit: recordingAudit(),
                },
                { projectId: PROJECT_ID, name: form.name },
              )
            : await renameWorkflowStageAction(
                {
                  state: state ?? null,
                  writes: async () => app.operations,
                  unavailableReason: () => STAGE_UNAVAILABLE,
                  refresh: async () => null,
                  setRefusal: (reason) => { view = { ...view, stageRefusal: reason }; },
                  setFeedback: (message) => { view = { ...view, stageFeedback: message }; },
                  render: () => undefined,
                  ids: semanticIds(),
                  audit: recordingAudit(),
                },
                { stageId: form.stageId, name: form.name },
              );
          if (outcome.ok) {
            view = { ...view, stageForm: null };
            state = await app.state();
          }
          draw();
        })());
      },
      deleteStage: () => undefined,
      closeStageForm: () => { view = { ...view, stageForm: null }; draw(); },
    });

    const harness = createInteractionHarness(root);
    harness.click('project-workflow-stage-new');
    const field = root.querySelector<HTMLInputElement>('[data-papers-visual-key="project-workflow-stage-name"]')!;
    field.value = 'Waiting on the creator';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    harness.click('project-workflow-stage-save');
    await Promise.all(pending);

    // The form is gone, the sentence is drawn, and the column the write created is on the board.
    expect(root.querySelector('[data-papers-visual-key="project-workflow-stage-name"]')).toBeNull();
    expect(root.querySelector('[data-project-workflow-stage-feedback]')!.getAttribute('data-project-workflow-stage-feedback'))
      .toBe('Created the stage Waiting on the creator.');
    expect(Array.from(root.querySelectorAll('[data-project-workflow-stage-column]')).length).toBe(4);
    expect(root.textContent).toContain('Waiting on the creator');
  });
});
