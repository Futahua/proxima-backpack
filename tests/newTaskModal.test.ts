// @vitest-environment happy-dom
/**
 * The New Task form through the real renderer and the real binder.
 *
 * What these cases are for: the form has to be reachable (a control that opens it), it has to hold
 * what a person types (through its *own* attributes, so the card editor beside it cannot answer its
 * keystrokes), and its Save has to be a real control exactly when a record write path resolved —
 * disabled while the form holds nothing to create, and reported through the binder when it does.
 *
 * The mount is deliberately the production pair: `renderElasticCockpit` and
 * `bindElasticCockpitInteractions`, with the shell's own bookkeeping written out by hand.
 */
import { describe, expect, it } from 'vitest';
import { applyTaskEditorEdit, type TaskEditorDraft } from '../src/app/taskEditor.js';
import { newTaskDraft } from '../src/app/taskCreate.js';
import type { ProximaState } from '../src/domain/types.js';
import { bindElasticCockpitInteractions, renderElasticCockpit } from '../src/browser/elasticCockpit.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';

const state: ProximaState = {
  projects: [
    { id: 'p1', source: { path: 'Proxima/projects/p1.md', revision: 'r1', kind: 'project', idOrigin: 'filename' }, name: 'Project one', description: '', createdAt: '2026-01-01T00:00:00.000Z', status: 'active', projectType: 'task', linkedFolders: [] },
  ],
  tasks: [],
  events: [],
  statuses: [
    { id: 'backlog', name: 'Backlog', color: '#636e72', column: 'backlog' },
    { id: 'running', name: 'Running', color: '#00b894', column: 'running' },
    { id: 'finished', name: 'Finished', color: '#fdcb6e', column: 'finished' },
  ],
  taskSchema: [],
};

const session = { targetTime: '2026-09-12T09:00:00.000Z', lockedAt: null };

/**
 * A board with the New Task form's bookkeeping written by hand, exactly as the shell holds it.
 */
function mount(
  writes: { refusal: string | null } = { refusal: null },
  behaviour: { readonly refuseCreate?: string } = {},
) {
  let draft: TaskEditorDraft | null = null;
  let refusal: string | null = null;
  const opened: number[] = [];
  const cancelled: number[] = [];
  const created: (TaskEditorDraft | null)[] = [];
  const edits: unknown[] = [];
  const root = document.createElement('div');
  document.body.appendChild(root);

  const draw = () => {
    root.innerHTML = renderElasticCockpit({
      state,
      tasks: state.tasks,
      projectNames: new Map([['p1', 'Project one']]),
      selectionLabel: 'All projects',
      session,
      now: new Date('2026-09-12T05:30:00.000Z'),
      selectedTaskId: null,
      editorDraft: null,
      dropRefusal: null,
      taskWrites: { refusal: writes.refusal, editorRefusal: null },
      newTaskDraft: draft,
      newTaskRefusal: refusal,
    });
  };

  draw();
  bindElasticCockpitInteractions(root, {
    openTask: () => undefined,
    closeTask: () => undefined,
    setTarget: () => undefined,
    lock: () => undefined,
    unlock: () => undefined,
    moveTask: () => undefined,
    editTask: () => undefined,
    cancelTaskEdit: () => undefined,
    saveTask: () => undefined,
    deleteTask: () => undefined,
    openNewTask: () => { opened.push(opened.length + 1); draft = newTaskDraft(state, 'p1'); refusal = null; draw(); },
    cancelNewTask: () => { cancelled.push(cancelled.length + 1); draft = null; refusal = null; draw(); },
    editNewTask: (edit) => { edits.push(edit); draft = applyTaskEditorEdit(draft!, edit); },
    createTask: () => {
      created.push(draft);
      // A create that the write path refuses leaves the form open with its refusal beside it,
      // which is the behaviour this mount has to be able to model.
      if (behaviour.refuseCreate !== undefined) {
        refusal = behaviour.refuseCreate;
        draw();
        return;
      }
      draft = null;
      refusal = null;
      draw();
    },
  });

  return {
    root,
    harness: createInteractionHarness(root),
    draw,
    draft: () => draft,
    opened,
    cancelled,
    created,
    edits,
    control: (key: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-papers-visual-key="${key}"]`),
  };
}

describe('Stage 9 New Task form', () => {
  it('is closed until the board offers it, and then holds the defaults', () => {
    const mounted = mount();
    expect(mounted.root.querySelector('[data-papers-visual-key="new-task-modal"]')).toBeNull();

    mounted.harness.click('elastic-new-task');

    expect(mounted.opened).toHaveLength(1);
    const modal = mounted.root.querySelector('[data-papers-visual-key="new-task-modal"]')!;
    expect(modal.getAttribute('data-new-task-writes')).toBe('available');
    expect(modal.getAttribute('data-new-task-field-count')).toBe('9');
    expect((mounted.control('new-task-editor-name') as HTMLInputElement).value).toBe('');
    expect((mounted.control('new-task-editor-project') as HTMLSelectElement).value).toBe('p1');
    expect((mounted.control('new-task-editor-executionState') as HTMLSelectElement).value).toBe('backlog');
    expect((mounted.control('new-task-editor-weight') as HTMLInputElement).value).toBe('1');
    expect(mounted.root.querySelector('[data-papers-visual-key="new-task-empty"]')).not.toBeNull();
  });

  it('holds what is typed, through its own attributes, and offers Save only once there is a name', () => {
    const mounted = mount();
    mounted.harness.click('elastic-new-task');

    // An empty form has nothing to create, so Save is offered disabled rather than clicked-refused.
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="new-task-save"]')!.disabled).toBe(true);

    mounted.harness.typeText('new-task-editor-name', 'Typed name');
    mounted.draw();

    expect(mounted.draft()!.values.name).toBe('Typed name');
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="new-task-save"]')!.disabled).toBe(false);
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="new-task-save"]')!.textContent).toBe('Create task');
    expect(mounted.root.querySelector('[data-papers-visual-key="new-task-ready"]')).not.toBeNull();

    // The edit went through the New Task hooks, not the card editor's: every keystroke is this
    // form's field, and the last one is what the field holds.
    expect(mounted.edits.every((edit) => (edit as { fieldId: string }).fieldId === 'name')).toBe(true);
    expect(mounted.edits.at(-1)).toEqual({ fieldId: 'name', value: 'Typed name' });

    mounted.harness.click('new-task-save');
    expect(mounted.created).toHaveLength(1);
    expect(mounted.created[0]!.values.name).toBe('Typed name');
    expect(mounted.root.querySelector('[data-papers-visual-key="new-task-modal"]')).toBeNull();
  });

  it('reports a checkbox and a column choice too, and Cancel closes without creating', () => {
    const mounted = mount();
    mounted.harness.click('elastic-new-task');

    const box = mounted.control('new-task-editor-fixedDurationOn') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mounted.draft()!.checks.fixedDurationOn).toBe(true);

    const column = mounted.control('new-task-editor-executionState') as HTMLSelectElement;
    column.value = 'running';
    column.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mounted.draft()!.values.executionState).toBe('running');

    mounted.harness.click('new-task-cancel');
    expect(mounted.cancelled).toHaveLength(1);
    expect(mounted.created).toHaveLength(0);
    expect(mounted.root.querySelector('[data-papers-visual-key="new-task-modal"]')).toBeNull();
  });

  it('says the form cannot create when this run has no write path, and draws a refusal beside it', () => {
    const unavailable = mount({ refusal: 'record-writes-need-an-activated-store' });
    unavailable.harness.click('elastic-new-task');

    const save = unavailable.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="new-task-save"]')!;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('data-new-task-save-refusal')).toBe('record-writes-need-an-activated-store');
    expect(save.textContent).toBe('Create unavailable');
    expect(unavailable.root.querySelector('[data-papers-visual-key="new-task-modal"]')!.getAttribute('data-new-task-writes')).toBe('unavailable');

    // And a create the write path refuses: the refusal is drawn beside the form, which stays open
    // with what was typed, and nothing claims a task was created.
    const refused = mount({ refusal: null }, { refuseCreate: 'stale-revision' });
    refused.harness.click('elastic-new-task');
    refused.harness.typeText('new-task-editor-name', 'Contested');
    refused.draw();
    refused.harness.click('new-task-save');

    const banner = refused.root.querySelector('[data-papers-visual-key="new-task-refusal"]')!;
    expect(banner.getAttribute('data-new-task-refusal')).toBe('stale-revision');
    expect(banner.textContent).toContain('No task was created');
    expect(refused.control('new-task-editor-name')).not.toBeNull();
    expect(refused.draft()!.values.name).toBe('Contested');
  });

  it('closes on Escape, and does not take the card editor with it', () => {
    const mounted = mount();
    mounted.harness.click('elastic-new-task');
    mounted.harness.pressKey('new-task-modal', 'Escape');

    expect(mounted.cancelled).toHaveLength(1);
    expect(mounted.root.querySelector('[data-papers-visual-key="new-task-modal"]')).toBeNull();
  });
});
