/**
 * The New Task form's write path, over the real store and the real recovery gate.
 *
 * Two things are being protected. First, the *plan*: what a create asks for, exactly, including the
 * values the form never asked about (a new card lands at the top of its column, and a form that
 * invented an order would be claiming a position nobody chose). Second, that a refusal is a refusal:
 * an empty name, a project that is not there, a column that is not a canonical execution state and an
 * inverted date range all stop the create *before* the write path is asked, so nothing is written and
 * no revision moves.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { applyTaskEditorEdit, taskEditorDraftFor } from '../src/app/taskEditor.js';
import { createTaskAction, newTaskDraft, planTaskCreate, projectNewTaskEditor, type TaskCreateDependencies } from '../src/app/taskCreate.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T05:30:00+07:00';

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

const PROJECT = idFromLastByte(41);
const OTHER = idFromLastByte(42);

function projectRecord(id: OpaqueRecordId, name: string, status: 'active' | 'archived' = 'active'): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status,
    archivedAt: status === 'archived' ? '2026-08-02T00:00:00.000Z' : null,
    artifactBindings: [],
  };
}

interface World {
  readonly files: MemoryRecordFiles;
  readonly deps: TaskMutationDependencies;
  readonly refreshCalls: string[];
  state(): Promise<ProximaState>;
  form(options?: { readonly writesAvailable?: boolean; readonly unavailableReason?: string }): {
    readonly refusals: (string | null)[];
    readonly renders: number[];
    depsFor(state: ProximaState | null): TaskCreateDependencies;
    create(draft: ReturnType<typeof newTaskDraft> | null): ReturnType<typeof createTaskAction>;
  };
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 400;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  await store.createIfAbsent(projectRecord(PROJECT, 'Project') as CanonicalRecordV2);
  await store.createIfAbsent(projectRecord(OTHER, 'Archived project', 'archived') as CanonicalRecordV2);

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const refreshCalls: string[] = [];
  const read = async (): Promise<ProximaState> => (await source.load()).state;

  return {
    files,
    deps,
    refreshCalls,
    state: read,
    form: (options = {}) => {
      const refusals: (string | null)[] = [];
      const renders: number[] = [];
      const writesAvailable = options.writesAvailable ?? true;
      const depsFor = (state: ProximaState | null): TaskCreateDependencies => ({
        state,
        writes: async () => (writesAvailable ? { createTask: (request) => createTask(deps, request) } : null),
        unavailableReason: () => options.unavailableReason ?? 'no write path',
        refresh: async (reason: RefreshReason): Promise<RefreshResult> => {
          refreshCalls.push(reason);
          return await refresh.refreshSource(reason);
        },
        setRefusal: (reason: string | null) => { refusals.push(reason); },
        render: () => { renders.push(renders.length + 1); },
      });

      return {
        refusals,
        renders,
        depsFor,
        create: async (draft) => await createTaskAction(depsFor(await read()), { draft }),
      };
    },
  };
}

describe('Stage 9 planTaskCreate', () => {
  it('asks for exactly what the form holds, and nothing it never asked about', async () => {
    const app = await world();
    const state = await app.state();
    const draft = applyTaskEditorEdit(newTaskDraft(state, PROJECT), { fieldId: 'name', value: 'Brand new' });

    const plan = planTaskCreate(state, draft);

    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(plan.request).toEqual({
      name: 'Brand new',
      projectId: PROJECT,
      executionState: 'backlog',
      weight: 1,
      startDate: null,
      deadline: null,
      isFixedDuration: false,
      fixedDuration: null,
      maxDuration: null,
      // A new card lands at the top of its column; where it belongs among peers is a drag.
      executionOrder: 0,
    });
  });

  it('defaults the project from the selection, and to no project when the selection is not one', async () => {
    const app = await world();
    const state = await app.state();

    const inProject = planTaskCreate(state, applyTaskEditorEdit(newTaskDraft(state, PROJECT), { fieldId: 'name', value: 'Here' }));
    expect(inProject).toMatchObject({ ok: true, request: { projectId: PROJECT } });

    // "All projects" and "Uncategorised" are not project ids, so the form must not guess one.
    const unassigned = planTaskCreate(state, applyTaskEditorEdit(newTaskDraft(state, 'all-projects'), { fieldId: 'name', value: 'Anywhere' }));
    expect(unassigned).toMatchObject({ ok: true, request: { projectId: null } });
  });

  it('reads the whole typed form when it is filled in', async () => {
    const app = await world();
    const state = await app.state();
    let draft = newTaskDraft(state, '');
    draft = applyTaskEditorEdit(draft, { fieldId: 'name', value: 'Fully specified' });
    draft = applyTaskEditorEdit(draft, { fieldId: 'project', value: PROJECT });
    draft = applyTaskEditorEdit(draft, { fieldId: 'executionState', value: 'running' });
    draft = applyTaskEditorEdit(draft, { fieldId: 'weight', value: '2.5' });
    draft = applyTaskEditorEdit(draft, { fieldId: 'fixedDurationOn', checked: true });
    draft = applyTaskEditorEdit(draft, { fieldId: 'fixedDuration', value: '30' });
    draft = applyTaskEditorEdit(draft, { fieldId: 'maxDuration', value: '90' });
    draft = applyTaskEditorEdit(draft, { fieldId: 'startDate', value: '2026-09-20' });
    draft = applyTaskEditorEdit(draft, { fieldId: 'deadline', value: '2026-09-25' });

    expect(planTaskCreate(state, draft)).toMatchObject({
      ok: true,
      request: {
        name: 'Fully specified',
        projectId: PROJECT,
        executionState: 'running',
        weight: 2.5,
        isFixedDuration: true,
        fixedDuration: 30,
        maxDuration: 90,
        startDate: '2026-09-20',
        deadline: '2026-09-25',
      },
    });
  });

  it('refuses an unfillable form by field, before the write path is asked', async () => {
    const app = await world();
    const state = await app.state();
    const base = newTaskDraft(state, PROJECT);
    const named = applyTaskEditorEdit(base, { fieldId: 'name', value: 'Ok' });

    expect(planTaskCreate(state, base)).toMatchObject({ ok: false, reason: 'invalid-value', fieldId: 'name' });
    expect(planTaskCreate(state, applyTaskEditorEdit(named, { fieldId: 'name', value: '   ' }))).toMatchObject({ ok: false, fieldId: 'name' });
    expect(planTaskCreate(state, applyTaskEditorEdit(named, { fieldId: 'weight', value: 'heavy' }))).toMatchObject({ ok: false, fieldId: 'weight' });
    expect(planTaskCreate(state, applyTaskEditorEdit(named, { fieldId: 'executionState', value: 'doing' }))).toMatchObject({ ok: false, reason: 'invalid-value', fieldId: 'executionState' });
    expect(planTaskCreate(state, applyTaskEditorEdit(named, { fieldId: 'fixedDurationOn', checked: true }))).toMatchObject({ ok: false, fieldId: 'fixedDuration' });
    expect(planTaskCreate(state, applyTaskEditorEdit(applyTaskEditorEdit(named, { fieldId: 'startDate', value: '2026-09-20' }), { fieldId: 'deadline', value: '2026-09-19' }))).toMatchObject({ ok: false, fieldId: 'deadline' });
    expect(planTaskCreate(state, applyTaskEditorEdit(named, { fieldId: 'startDate', value: 'whenever' }))).toMatchObject({ ok: false, fieldId: 'startDate' });
    // A project the state does not hold is refused as its own reason rather than as a bad value.
    expect(planTaskCreate(state, applyTaskEditorEdit(named, { fieldId: 'project', value: idFromLastByte(99) }))).toMatchObject({ ok: false, reason: 'unknown-project', fieldId: 'project' });

    // And the form is still only a form: nothing above reached the store.
    expect(app.files.size).toBe(2);
    expect(app.refreshCalls).toEqual([]);
  });

  it('offers only the columns the request can carry, and marks itself dirty on a name', async () => {
    const app = await world();
    const state = await app.state();
    const projection = projectNewTaskEditor(state, newTaskDraft(state, PROJECT));
    const columns = projection.sections[0]!.fields.find((field) => field.id === 'executionState')!;

    // The three canonical execution states, not the vault's vocabulary: a create that offered a
    // status the request would refuse would be a form lying about what it can do.
    expect(columns.options.map((option) => option.id)).toEqual(['backlog', 'running', 'finished']);
    expect(projection.dirty).toBe(false);
    expect(projection.fieldCount).toBe(9);
    expect(projectNewTaskEditor(state, applyTaskEditorEdit(newTaskDraft(state, PROJECT), { fieldId: 'name', value: 'x' })).dirty).toBe(true);

    // The project choices are the active projects plus "no project": an archived project is not a
    // destination for new work, and the form should not offer one.
    const project = projection.sections[0]!.fields.find((field) => field.id === 'project')!;
    expect(project.options.map((option) => option.id)).toEqual([PROJECT, '']);
  });
});

describe('Stage 9 createTaskAction', () => {
  it('creates the record, converges the surfaces and closes the form', async () => {
    const app = await world();
    const form = app.form();
    const draft = applyTaskEditorEdit(newTaskDraft(await app.state(), PROJECT), { fieldId: 'name', value: 'Created from the form' });

    const effect = await form.create(draft);

    expect(effect).toMatchObject({ clearDraft: true, closeEditor: true });
    expect(effect.outcome).toMatchObject({ ok: true, refreshed: true });
    expect(app.refreshCalls).toEqual(['manual']);
    expect(form.refusals).toEqual([null]);
    expect(form.renders).toHaveLength(1);

    const state = await app.state();
    const created = state.tasks.find((task) => task.name === 'Created from the form');
    expect(created).toMatchObject({ status: 'backlog', projectId: PROJECT, isCompleted: false });
    expect(app.files.size).toBe(3);
  });

  it('refuses without a write path, and leaves the form open with what was typed', async () => {
    const app = await world();
    const form = app.form({ writesAvailable: false, unavailableReason: 'record-writes-need-an-activated-store' });
    const draft = applyTaskEditorEdit(newTaskDraft(await app.state(), PROJECT), { fieldId: 'name', value: 'Nowhere to go' });

    const effect = await form.create(draft);

    expect(effect).toMatchObject({ clearDraft: false, closeEditor: false });
    expect(effect.outcome).toMatchObject({ ok: false, reason: 'writes-unavailable', detail: 'record-writes-need-an-activated-store' });
    expect(form.refusals).toEqual([null, 'record-writes-need-an-activated-store']);
    expect(app.refreshCalls).toEqual([]);
    expect(app.files.size).toBe(2);
  });

  it('does nothing at all when the form is closed, not even resolving a write path', async () => {
    const app = await world();
    const form = app.form();

    const effect = await form.create(null);

    expect(effect).toEqual({ outcome: null, clearDraft: false, closeEditor: false });
    expect(form.refusals).toEqual([]);
    expect(form.renders).toEqual([]);
  });

  it('refuses an unfillable form in the form\'s own words, and writes nothing', async () => {
    const app = await world();
    const form = app.form();

    const effect = await form.create(newTaskDraft(await app.state(), PROJECT));

    expect(effect).toMatchObject({ clearDraft: false, closeEditor: false });
    expect(effect.outcome).toMatchObject({ ok: false, reason: 'invalid-value', detail: 'a task needs a name', fieldId: 'name' });
    expect(app.files.size).toBe(2);
    expect(app.refreshCalls).toEqual([]);
  });

  it('creates into the selection, and a form re-seeded from the record shows it afterwards', async () => {
    const app = await world();
    const form = app.form();
    const draft = applyTaskEditorEdit(newTaskDraft(await app.state(), PROJECT), { fieldId: 'name', value: 'Seeded back' });
    await form.create(draft);

    const state = await app.state();
    const created = state.tasks.find((task) => task.name === 'Seeded back')!;
    // The task the form created is a record like any other: the editor can be opened on it.
    const editorDraft = taskEditorDraftFor(created);
    expect(editorDraft.values.name).toBe('Seeded back');
    expect(editorDraft.values.executionState).toBe('backlog');
  });
});
