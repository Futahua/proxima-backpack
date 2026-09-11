// @vitest-environment happy-dom
/**
 * The Projects Hub's lifecycle controls once a write path has resolved.
 *
 * `tests/projectLifecycleActions.test.ts` already drives archive, restore and delete through
 * `src/app/projectLifecycleActions.ts` against a real store, so nothing here re-tests the sequence.
 * What this file is about is the other half — the surface:
 *
 *   - a resolved write path turns Archive, Restore and Delete into real buttons, carrying no refusal
 *     at all, and a run with no path keeps them disabled with the reason drawn beside them;
 *   - a click reaches the handler that owns that control, with the id the button itself carried, and
 *     a disabled control reports nothing — the binder is not the thing that decides, the write path
 *     is;
 *   - Delete is offered on the same terms as the other two, because while the deletion policy is
 *     undecided its refusal *is* the answer, and the sentence that says so is drawn where the button
 *     is rather than replacing it.
 *
 * The last two cases take the project id from the DOM a reader would have clicked and the revision
 * from the state that DOM was drawn from, then run the real operation: a write is addressed to the
 * world the surface was rendering, not to the world the handler happened to be holding.
 * `src/browser/main.ts` composes these pieces into the running shell; the checklist's browser run is
 * what exercises that composition.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  restoreProject,
  updateProject,
  type ProjectMutationDependencies,
} from '../src/app/projectMutations.js';
import { archiveProjectAction, createProjectAction, deleteProjectAction, restoreProjectAction, updateProjectAction } from '../src/app/projectLifecycleActions.js';
import { planProjectFieldMutations, projectEditorDraftFor } from '../src/app/projectEditor.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { ALL_PROJECTS } from '../src/domain/selectors.js';
import type { ProximaState } from '../src/domain/types.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  bindProjectsHubInteractions,
  renderProjectsHub,
  type ProjectCreateIntent,
  type ProjectEditView,
  type ProjectFormRefusal,
  type ProjectsHubHandlers,
  type ProjectWriteView,
} from '../src/browser/projectsHub.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { sourceRef } from './fixtures.js';

const CLOCK_ISO = '2026-09-12T09:00:00+07:00';
const NOW = new Date('2026-09-12T05:00:00.000Z');

const quietHandlers: ProjectsHubHandlers = {
  setFilter: () => undefined,
  openProject: () => undefined,
  showHub: () => undefined,
  openNewProject: () => undefined,
  closeNewProject: () => undefined,
  createProject: () => undefined,
  openProjectEditor: () => undefined,
  closeProjectEditor: () => undefined,
  saveProjectEdit: () => undefined,
  archiveProject: () => undefined,
  restoreProject: () => undefined,
  deleteProject: () => undefined,
};

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

function hubState() {
  const template = {
    id: 'hub-active',
    source: sourceRef('project', 'hub-active'),
    name: 'Hub Active',
    description: 'A project',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active' as const,
    projectType: 'task' as const,
    linkedFolders: [],
  };
  return {
    projects: [
      { ...template },
      { ...template, id: 'hub-archived', name: 'Hub Archived', status: 'archived' as const, archivedAt: '2026-09-01T00:00:00.000Z' },
    ],
    tasks: [],
    events: [],
    statuses: [],
    taskSchema: [],
  };
}

function renderHub(state: ReturnType<typeof hubState> | ProximaState, selection: string, filter: 'active' | 'archived', writes: ProjectWriteView): string {
  return renderProjectsHub({ state, selection, filter, workspaceTab: 'notes', now: NOW, projectWrites: writes });
}

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

/** A real store with one project in it, and the operations the shell resolves for a surface. */
async function projectWorld(seedOffset: number) {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = seedOffset;
  const deps: ProjectMutationDependencies & TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const created = await createProject(deps, { name: 'Atlas', description: 'The project under the controls' });
  if (!created.ok) throw new Error(`seeding the project failed: ${created.reason}`);

  const source = recordStoreStateSource(store);
  return {
    files,
    store,
    projectId: created.recordId,
    read: async (): Promise<ProximaState> => (await source.load()).state,
    operations: {
      createProject: async (request: Parameters<typeof createProject>[1]) => await createProject(deps, request),
      updateProject: async (input: Parameters<typeof updateProject>[1]) => await updateProject(deps, input),
      archiveProject: async (input: Parameters<typeof archiveProject>[1]) => await archiveProject(deps, input),
      restoreProject: async (input: Parameters<typeof restoreProject>[1]) => await restoreProject(deps, input),
      deleteProject: async (input: Parameters<typeof deleteProject>[1]) => await deleteProject(deps, input),
    },
    seedTask: async (name: string): Promise<string> => {
      const task = await createTask(deps, { name, projectId: created.recordId, executionState: 'backlog', executionOrder: 0 });
      if (!task.ok) throw new Error(`seeding ${name} failed: ${task.reason}`);
      return task.recordId;
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 11 Projects Hub lifecycle controls with a write path', () => {
  it('renders all three controls as real buttons, and no refusal anywhere on them', () => {
    const state = hubState();
    const host = mount(renderHub(state, ALL_PROJECTS, 'active', { refusal: null, feedback: null }));
    const harness = createInteractionHarness(host);

    const archive = harness.target('project-lifecycle-archive-hub-active') as HTMLButtonElement;
    const remove = harness.target('project-lifecycle-delete-hub-active') as HTMLButtonElement;
    expect(archive.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(archive.getAttribute('data-project-lifecycle-refusal')).toBeNull();
    expect(remove.getAttribute('data-project-lifecycle-refusal')).toBeNull();
    expect(archive.dataset.projectId).toBe('hub-active');
    expect(remove.dataset.projectId).toBe('hub-active');
    expect(harness.target('project-lifecycle-controls-hub-active').dataset.projectLifecycleWrites).toBe('available');
    // An active project is not restorable, so the control is absent rather than inert.
    expect(() => harness.target('project-lifecycle-restore-hub-active')).toThrow();

    document.body.innerHTML = '';
    const archivedHost = mount(renderHub(state, ALL_PROJECTS, 'archived', { refusal: null, feedback: null }));
    const archivedHarness = createInteractionHarness(archivedHost);
    const restore = archivedHarness.target('project-lifecycle-restore-hub-archived') as HTMLButtonElement;
    expect(restore.disabled).toBe(false);
    expect(restore.dataset.projectId).toBe('hub-archived');
    expect((archivedHarness.target('project-lifecycle-delete-hub-archived') as HTMLButtonElement).disabled).toBe(false);
    expect(() => archivedHarness.target('project-lifecycle-archive-hub-archived')).toThrow();

    // The opened workspace draws the same controls for the project it is showing.
    document.body.innerHTML = '';
    const workspaceHost = mount(renderHub(state, 'hub-active', 'active', { refusal: null, feedback: null }));
    const workspaceHarness = createInteractionHarness(workspaceHost);
    expect((workspaceHarness.target('project-lifecycle-archive-hub-active') as HTMLButtonElement).disabled).toBe(false);
    expect(workspaceHarness.target('project-lifecycle-controls-hub-active').dataset.projectLifecycleWrites).toBe('available');
  });

  it('keeps the controls disabled and the reason drawn where they are when no write path resolved', () => {
    const host = mount(renderHub(hubState(), ALL_PROJECTS, 'active', { refusal: 'record-writes-need-an-activated-store', feedback: null }));
    const harness = createInteractionHarness(host);
    const archive = harness.target('project-lifecycle-archive-hub-active') as HTMLButtonElement;

    expect(archive.disabled).toBe(true);
    expect(archive.getAttribute('data-project-lifecycle-refusal')).toBe('record-writes-need-an-activated-store');
    const controls = harness.target('project-lifecycle-controls-hub-active');
    expect(controls.dataset.projectLifecycleWrites).toBe('unavailable');
    expect(host.querySelector('[data-project-lifecycle-feedback]')!.getAttribute('data-project-lifecycle-feedback'))
      .toBe('record-writes-need-an-activated-store');
    expect(controls.textContent).toContain('Unavailable until record-store cutover');
    // The list carries the same sentence, so the reason survives the cards being filtered away.
    const report = host.querySelector<HTMLElement>('[data-project-lifecycle-report]')!;
    expect(report.getAttribute('data-project-lifecycle-report')).toBe('record-writes-need-an-activated-store');
    expect(report.textContent).toContain('Unavailable until record-store cutover');
  });

  it('reaches the handler that owns the clicked control with the id the button carried, and nothing from a disabled one', () => {
    const calls: string[] = [];
    const host = mount(renderHub(hubState(), ALL_PROJECTS, 'active', { refusal: null, feedback: null }));
    bindProjectsHubInteractions(host, {
      ...quietHandlers,
      openProject: (projectId) => { calls.push(`open:${projectId}`); },
      archiveProject: (projectId) => { calls.push(`archive:${projectId}`); },
      restoreProject: (projectId) => { calls.push(`restore:${projectId}`); },
      deleteProject: (projectId) => { calls.push(`delete:${projectId}`); },
    });
    const harness = createInteractionHarness(host);

    // The card shell holds both an open-project button and the lifecycle controls: clicking one
    // must not be answered by the other's branch.
    harness.click('project-lifecycle-archive-hub-active');
    harness.click('project-lifecycle-delete-hub-active');
    harness.click('project-hub-card-hub-active');
    expect(calls).toEqual(['archive:hub-active', 'delete:hub-active', 'open:hub-active']);

    document.body.innerHTML = '';
    const refusedHost = mount(renderHub(hubState(), ALL_PROJECTS, 'active', { refusal: 'record-writes-need-an-activated-store', feedback: null }));
    bindProjectsHubInteractions(refusedHost, {
      ...quietHandlers,
      archiveProject: (projectId) => { calls.push(`again:${projectId}`); },
      deleteProject: (projectId) => { calls.push(`again:${projectId}`); },
    });
    const refusedHarness = createInteractionHarness(refusedHost);
    refusedHarness.click('project-lifecycle-archive-hub-active');
    refusedHarness.click('project-lifecycle-delete-hub-active');
    expect(calls).toEqual(['archive:hub-active', 'delete:hub-active', 'open:hub-active']);
  });

  it('offers Delete while the policy is undecided and draws the refusal it answers with', () => {
    const sentence = 'policy-not-decided: deleting Hub Active would affect 2 task(s) and 1 event(s); whether those are left uncategorised, cascaded explicitly, or whether the delete is refused while they exist is the creator\'s decision, so nothing was changed';
    const host = mount(renderHub(hubState(), ALL_PROJECTS, 'active', { refusal: null, feedback: sentence, feedbackRefusal: 'policy-not-decided' }));
    const harness = createInteractionHarness(host);

    // Enabled, and carrying no control-level refusal: the answer is a sentence, not a missing feature.
    const remove = harness.target('project-lifecycle-delete-hub-active') as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute('data-project-lifecycle-refusal')).toBeNull();
    expect(harness.target('project-lifecycle-controls-hub-active').dataset.projectLifecycleWrites).toBe('available');

    const feedback = host.querySelector<HTMLElement>('[data-project-lifecycle-feedback]')!;
    expect(feedback.getAttribute('data-project-lifecycle-feedback')).toBe('policy-not-decided');
    expect(feedback.textContent).toContain('the creator\'s decision');
  });

  it('archives and restores the project a clicked control named, from the state the surface was drawn from', async () => {
    const app = await projectWorld(2100);
    const member = await app.seedTask('Member');
    const pending: Promise<void>[] = [];
    let view: ProjectWriteView = { refusal: null, feedback: null };
    let filter: 'active' | 'archived' = 'active';
    let drawn: ProximaState = await app.read();
    const host = mount(renderHub(drawn, ALL_PROJECTS, filter, view));
    const redraw = (): void => { host.innerHTML = renderHub(drawn, ALL_PROJECTS, filter, view); };

    // The shell's half: the world the surface is rendering goes in, and the sentence it will draw
    // comes out. A click's id is the one the button carried, not one the shell looked up again.
    const run = (kind: 'archive' | 'restore' | 'delete', projectId: string): Promise<void> => (async () => {
      const dependencies = {
        state: drawn,
        writes: async () => app.operations,
        unavailableReason: () => null,
        refresh: async () => null,
        setRefusal: (reason: string | null) => { view = { ...view, feedbackRefusal: reason }; },
        render: () => undefined,
      };
      const outcome = kind === 'archive'
        ? await archiveProjectAction(dependencies, { projectId })
        : kind === 'restore'
          ? await restoreProjectAction(dependencies, { projectId })
          : await deleteProjectAction(dependencies, { projectId });
      view = {
        refusal: null,
        feedback: outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`,
        feedbackRefusal: outcome.ok ? null : outcome.reason,
      };
      drawn = await app.read();
      redraw();
    })();

    bindProjectsHubInteractions(host, {
      ...quietHandlers,
      archiveProject: (projectId) => { pending.push(run('archive', projectId)); },
      restoreProject: (projectId) => { pending.push(run('restore', projectId)); },
      deleteProject: (projectId) => { pending.push(run('delete', projectId)); },
    });

    const archiveControl = host.querySelector<HTMLElement>('[data-project-lifecycle-action="archive"]')!;
    expect(archiveControl.dataset.projectId).toBe(app.projectId);
    const memberRevisionBefore = (await app.store.list()).find((observation) => observation.record.id === member)?.observedRevision;
    createInteractionHarness(host).click(archiveControl.getAttribute('data-c1-key')!);
    await Promise.all(pending);

    // The write happened, against the revision the surface was drawn from.
    const archived = (await app.read()).projects.find((project) => project.id === app.projectId)!;
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(new Date(CLOCK_ISO).toISOString());
    expect(view.feedback).toBe(`archived at revision ${archived.source.revision}`);
    // And the member record is untouched, which is what makes this an archive rather than a delete.
    expect((await app.store.list()).find((observation) => observation.record.id === member)?.observedRevision).toBe(memberRevisionBefore);
    // The card moves out of the active list, and the sentence stays behind at the list level: a
    // report that vanished with the card it referred to would be one nobody could read.
    expect(host.textContent).toContain('No active projects.');
    expect(host.querySelector<HTMLElement>('[data-project-lifecycle-report]')!.textContent).toBe(view.feedback);
    expect(host.querySelector<HTMLElement>('[data-project-lifecycle-report]')!.getAttribute('data-project-lifecycle-report')).toBe('');

    // Back the other way, through the control the archived filter draws.
    filter = 'archived';
    redraw();
    const restoreControl = host.querySelector<HTMLElement>('[data-project-lifecycle-action="restore"]')!;
    expect(restoreControl.dataset.projectId).toBe(app.projectId);
    createInteractionHarness(host).click(restoreControl.getAttribute('data-c1-key')!);
    await Promise.all(pending);

    const restored = (await app.read()).projects.find((project) => project.id === app.projectId)!;
    expect(restored.status).toBe('active');
    // The projection drops the key rather than carrying a null archive date, so both spellings of
    // "never archived" are accepted here and neither is a date.
    expect(restored.archivedAt ?? null).toBeNull();
    filter = 'active';
    redraw();
    expect(host.querySelector<HTMLElement>(`[data-c1-key="project-lifecycle-controls-${app.projectId}"]`)).not.toBeNull();
  });

  it('answers Delete on a project with members without writing, and draws the question it is waiting on', async () => {
    const app = await projectWorld(2200);
    await app.seedTask('Member one');
    await app.seedTask('Member two');
    const before = await app.read();
    const filesBefore = app.files.size;
    let view: ProjectWriteView = { refusal: null, feedback: null };
    const host = mount(renderHub(before, ALL_PROJECTS, 'active', view));
    const pending: Promise<void>[] = [];

    bindProjectsHubInteractions(host, {
      ...quietHandlers,
      deleteProject: (projectId) => {
        pending.push((async () => {
          const outcome = await deleteProjectAction(
            {
              state: before,
              writes: async () => app.operations,
              unavailableReason: () => null,
              refresh: async () => null,
              setRefusal: () => undefined,
              render: () => undefined,
            },
            { projectId },
          );
          view = {
            refusal: null,
            feedback: outcome.ok ? 'deleted' : `${outcome.reason}: ${outcome.detail}`,
            feedbackRefusal: outcome.ok ? null : outcome.reason,
          };
          host.innerHTML = renderHub(await app.read(), ALL_PROJECTS, 'active', view);
        })());
      },
    });

    const remove = host.querySelector<HTMLElement>('[data-project-lifecycle-action="delete"]')!;
    expect(remove.hasAttribute('disabled')).toBe(false);
    createInteractionHarness(host).click(remove.getAttribute('data-c1-key')!);
    await Promise.all(pending);

    // Same request, same answer, and the counts it names are the members that exist.
    expect(view.feedbackRefusal).toBe('policy-not-decided');
    expect(view.feedback).toContain('would affect 2 task(s) and 0 event(s)');
    const drawn = host.querySelector<HTMLElement>('[data-project-lifecycle-feedback]')!;
    expect(drawn.getAttribute('data-project-lifecycle-feedback')).toBe('policy-not-decided');
    expect(drawn.textContent).toContain('the creator\'s decision');
    // Nothing was written and nothing was removed, so the button is still there to answer for.
    expect(app.files.size).toBe(filesBefore);
    expect((await app.read()).projects).toHaveLength(1);
    expect(host.querySelector('[data-project-lifecycle-action="delete"]')).not.toBeNull();
  });
});

/**
 * The two project forms.
 *
 * `main.ts` is not importable from a test, so each case here performs the shell's half explicitly —
 * run the real sequence, hold what it answered, re-read, redraw — and asserts the surface contract
 * around it. The sequences themselves are covered in `tests/projectLifecycleActions.test.ts`; what
 * these cases add is that the forms are wired to them, that only the fields that changed are
 * submitted, and that a refusal is drawn on the form instead of replacing it.
 */
describe('Stage 11 the project forms', () => {
  it('creates the project the New Project form described, and answers an invalid one with the operation\'s own reason', async () => {
    const app = await projectWorld(2300);
    let state = await app.read();
    let open = true;
    let draft: ProjectCreateIntent | null = { name: '', description: '' };
    const form: { refusal: ProjectFormRefusal | null } = { refusal: null };
    const pending: Promise<void>[] = [];
    const draw = (): string => renderProjectsHub({ state, selection: ALL_PROJECTS, filter: 'active', workspaceTab: 'notes', now: NOW, newProjectOpen: open, projectCreateRefusal: form.refusal, projectCreateDraft: draft });
    const host = mount(draw());
    const rerender = (): void => { host.innerHTML = draw(); };

    bindProjectsHubInteractions(host, {
      ...quietHandlers,
      openNewProject: () => { open = true; form.refusal = null; draft = { name: '', description: '' }; rerender(); },
      closeNewProject: () => { open = false; form.refusal = null; draft = null; rerender(); },
      createProject: ({ name, description }) => {
        draft = { name, description };
        pending.push((async () => {
          const outcome = await createProjectAction(
            {
              state,
              writes: async () => app.operations,
              unavailableReason: () => null,
              refresh: async () => null,
              setRefusal: () => undefined,
              render: () => undefined,
            },
            { name, description },
          );
          if (outcome.ok) { open = false; draft = null; }
          else form.refusal = { code: outcome.reason, sentence: `${outcome.reason}: ${outcome.detail}` };
          state = await app.read();
          rerender();
        })());
      },
    });
    const harness = createInteractionHarness(host);

    // A project needs a name, and the answer comes from the operation rather than from the form:
    // the form's job is to say what it was told, not to decide what is valid.
    harness.click('project-create-save');
    await Promise.all(pending);
    expect(form.refusal?.code).toBe('validation-refused');
    expect(open).toBe(true);
    expect(host.querySelector<HTMLElement>('[data-project-create-refusal]')!.getAttribute('data-project-create-refusal')).toBe('validation-refused');
    expect(host.querySelector<HTMLElement>('[data-project-create-feedback]')!.textContent).toContain('a project needs a name');
    expect((await app.read()).projects).toHaveLength(1);

    harness.typeText('project-create-name', 'Second project');
    harness.typeText('project-create-description', 'Named while the refusal was on screen');
    harness.click('project-create-save');
    await Promise.all(pending);

    const created = (await app.read()).projects.map((project) => project.name).sort();
    expect(created).toEqual(['Atlas', 'Second project']);
    // Accepted, so the form goes: the project it described exists and the hub is drawing it.
    expect(open).toBe(false);
    expect(host.querySelector('[data-c1-key="project-create-modal"]')).toBeNull();
    expect(host.querySelector('[data-project-create-refusal]')).toBeNull();
    expect(host.querySelectorAll('[data-projects-hub-action="open-project"]').length).toBe(2);
  });

  it('keeps the New Project form open with the reason when this run has no write path', async () => {
    const app = await projectWorld(2400);
    const filesBefore = app.files.size;
    const form: { refusal: ProjectFormRefusal | null } = { refusal: null };
    let draft: ProjectCreateIntent | null = { name: '', description: '' };
    const host = mount(renderProjectsHub({ state: await app.read(), selection: ALL_PROJECTS, filter: 'active', workspaceTab: 'notes', now: NOW, newProjectOpen: true, projectCreateRefusal: null, projectCreateDraft: draft }));
    const pending: Promise<void>[] = [];

    bindProjectsHubInteractions(host, {
      ...quietHandlers,
      createProject: ({ name, description }) => {
        draft = { name, description };
        pending.push((async () => {
          const outcome = await createProjectAction(
            {
              state: await app.read(),
              writes: async () => null,
              unavailableReason: () => 'record-writes-need-an-activated-store',
              refresh: async () => null,
              setRefusal: () => undefined,
              render: () => undefined,
            },
            { name, description },
          );
          draft = { name, description };
          form.refusal = outcome.ok ? null : { code: outcome.reason, sentence: `${outcome.reason}: ${outcome.detail}` };
          host.innerHTML = renderProjectsHub({ state: await app.read(), selection: ALL_PROJECTS, filter: 'active', workspaceTab: 'notes', now: NOW, newProjectOpen: true, projectCreateRefusal: form.refusal, projectCreateDraft: draft });
        })());
      },
    });

    const harness = createInteractionHarness(host);
    harness.typeText('project-create-name', 'Wanted anyway');
    harness.click('project-create-save');
    await Promise.all(pending);

    expect(form.refusal?.code).toBe('writes-unavailable');
    expect(host.querySelector<HTMLElement>('[data-project-create-refusal]')!.getAttribute('data-project-create-refusal')).toBe('writes-unavailable');
    expect(host.querySelector<HTMLElement>('[data-project-create-feedback]')!.textContent).toContain('record-writes-need-an-activated-store');
    // The form is still there with what was typed in it, and nothing was written.
    expect((harness.target('project-create-name') as HTMLInputElement).value).toBe('Wanted anyway');
    expect(app.files.size).toBe(filesBefore);
    expect((await app.read()).projects).toHaveLength(1);
  });

  it('saves the fields the editor changed, refuses a save with nothing changed, and closes only on acceptance', async () => {
    const app = await projectWorld(2500);
    let state = await app.read();
    const editorState: { editor: ProjectEditView | null } = { editor: null };
    const pending: Promise<void>[] = [];
    const draw = (): string => renderProjectsHub({ state, selection: app.projectId, filter: 'active', workspaceTab: 'notes', now: NOW, projectEdit: editorState.editor });
    const host = mount(draw());
    const rerender = (): void => { host.innerHTML = draw(); };

    bindProjectsHubInteractions(host, {
      ...quietHandlers,
      openProjectEditor: (projectId) => {
        const project = state.projects.find((candidate) => candidate.id === projectId);
        if (project === undefined) return;
        editorState.editor = { projectId, draft: projectEditorDraftFor(project), refusal: null };
        rerender();
      },
      closeProjectEditor: () => { editorState.editor = null; rerender(); },
      saveProjectEdit: ({ projectId, name, description }) => {
        pending.push((async () => {
          const project = state.projects.find((candidate) => candidate.id === projectId)!;
          const outcome = await updateProjectAction(
            {
              state,
              writes: async () => app.operations,
              unavailableReason: () => null,
              refresh: async () => null,
              setRefusal: () => undefined,
              render: () => undefined,
            },
            { projectId, mutations: planProjectFieldMutations(project, { name, description }) },
          );
          editorState.editor = outcome.ok
            ? null
            : { projectId, draft: { name, description }, refusal: { code: outcome.reason, sentence: `${outcome.reason}: ${outcome.detail}` } };
          state = await app.read();
          rerender();
        })());
      },
    });
    const harness = createInteractionHarness(host);

    // The form starts from the record, which is what makes "only what changed" a real computation.
    harness.click('project-edit-open');
    const name = harness.target('project-edit-name') as HTMLInputElement;
    expect(name.value).toBe('Atlas');
    expect((harness.target('project-edit-description') as HTMLTextAreaElement).value).toBe('The project under the controls');
    name.setSelectionRange(name.value.length, name.value.length);
    harness.typeText('project-edit-name', ' Renamed');
    expect(name.value).toBe('Atlas Renamed');
    harness.click('project-edit-save');
    await Promise.all(pending);

    const renamed = (await app.read()).projects.find((project) => project.id === app.projectId)!;
    expect(renamed.name).toBe('Atlas Renamed');
    // The description was not in the draft's changes, so it was not submitted and not rewritten.
    expect(renamed.description).toBe('The project under the controls');
    expect(editorState.editor).toBeNull();
    expect(host.querySelector('[data-project-editor-mode="edit"]')).toBeNull();

    // A second save with nothing changed is the operation's no-op refusal, and the record keeps its
    // revision: a form that wrote a record saying the same thing would be a write nobody asked for.
    harness.click('project-edit-open');
    const revisionBefore = (await app.store.list()).find((observation) => observation.record.id === app.projectId)!.observedRevision;
    harness.click('project-edit-save');
    await Promise.all(pending);
    expect(editorState.editor?.refusal?.code).toBe('validation-refused');
    expect(host.querySelector<HTMLElement>('[data-project-edit-refusal]')!.getAttribute('data-project-edit-refusal')).toBe('validation-refused');
    expect(host.querySelector<HTMLElement>('[data-project-edit-feedback]')!.textContent).toContain('an update with no field to change is not an update');
    expect((await app.store.list()).find((observation) => observation.record.id === app.projectId)!.observedRevision).toBe(revisionBefore);
    expect((await app.read()).projects.find((project) => project.id === app.projectId)!.name).toBe('Atlas Renamed');

    // Escape closes it, and cancelling leaves the record where it was.
    harness.escape('project-edit-name');
    expect(editorState.editor).toBeNull();
    expect(host.querySelector('[data-project-editor-mode="edit"]')).toBeNull();
  });
});
