// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindElasticCockpitInteractions,
  elasticExecutionPresentation,
  renderElasticCockpit,
  shouldTickElasticProgress,
  type ElasticCockpitHandlers,
} from '../src/browser/elasticCockpit.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { applyTaskEditorEdit, taskEditorDraftFor, type TaskEditorDraft } from '../src/app/taskEditor.js';
import { refusalTextFor } from '../src/app/refusalPresentation.js';
import type { ProximaState, PropertySchema, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

function task(id: string, status: string, weight: number, properties: Record<string, unknown> = {}): Task {
  return {
    id,
    source: sourceRef('task', id),
    name: `Task ${id}`,
    description: `Description ${id}`,
    projectId: null,
    status,
    weight,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: status === 'review',
    createdAt: '2026-09-01T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties,
  };
}

const runningA = task('running-a', 'running', 3, { priority: 'P1' });
const runningB = task('running-b', 'running', 1);
const backlog = task('backlog-a', 'backlog', 1);
const finished = task('finished-a', 'review', 1);

const state: ProximaState = {
  projects: [],
  tasks: [backlog, runningA, runningB, finished],
  events: [],
  statuses: [
    { id: 'backlog', name: 'Backlog', color: '#000', column: 'backlog' },
    { id: 'running', name: 'Running', color: '#000', column: 'running' },
    { id: 'review', name: 'Finished', color: '#000', column: 'finished' },
  ],
  taskSchema: [
    { id: 'priority', name: 'Priority', type: 'text' },
  ],
};

const session = {
  targetTime: '2026-09-06T16:00:00.000Z',
  lockedAt: null,
};

function render(selectedTaskId: string | null = null): string {
  return renderElasticCockpit({
    state,
    tasks: state.tasks,
    projectNames: new Map(),
    selectionLabel: 'All projects',
    session,
    now: new Date('2026-09-06T12:00:00.000Z'),
    selectedTaskId,
    editorDraft: null,
    dropRefusal: null,
    taskWrites: { refusal: 'action-not-available', editorRefusal: null },
    newTaskDraft: null,
    newTaskRefusal: null,
    containerHeight: 800,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 2 Elastic execution cockpit', () => {
  it('sizes running cards from the execution target rather than task deadlines', () => {
    const presentation = elasticExecutionPresentation(
      [runningA, runningB],
      session,
      new Date('2026-09-06T12:00:00.000Z'),
      800,
    );

    expect(presentation.heights).toEqual({
      'running-a': 600,
      'running-b': 200,
    });
    expect(presentation.allocationMinutes['running-a']).toBe(180);
    expect(presentation.allocationMinutes['running-b']).toBe(60);
    expect(presentation.targetExpired).toBe(false);
  });

  it('recalculates Running allocations deterministically when the target changes', () => {
    const shorter = elasticExecutionPresentation(
      [runningA, runningB],
      {
        targetTime: '2026-09-06T16:00:00.000Z',
        lockedAt: null,
      },
      new Date('2026-09-06T12:00:00.000Z'),
      800,
    );

    const longer = elasticExecutionPresentation(
      [runningA, runningB],
      {
        targetTime: '2026-09-06T20:00:00.000Z',
        lockedAt: null,
      },
      new Date('2026-09-06T12:00:00.000Z'),
      800,
    );

    expect(shorter.allocationMinutes).toMatchObject({
      'running-a': 180,
      'running-b': 60,
    });
    expect(longer.allocationMinutes).toMatchObject({
      'running-a': 360,
      'running-b': 120,
    });
    expect(longer.heights['running-a']).toBe(shorter.heights['running-a']);
    expect(longer.heights['running-b']).toBe(shorter.heights['running-b']);
  });

  it('advances deterministic per-task and overall progress while locked', () => {
    const locked = {
      targetTime: '2026-09-06T16:00:00.000Z',
      lockedAt: '2026-09-06T12:00:00.000Z',
    };

    const halfway = elasticExecutionPresentation(
      [runningA, runningB],
      locked,
      new Date('2026-09-06T14:00:00.000Z'),
      800,
    );

    expect(halfway.overallProgress).toBe(0.5);
    expect(halfway.progress['running-a']).toBeCloseTo(2 / 3);
    expect(halfway.progress['running-b']).toBe(0);

    const later = elasticExecutionPresentation(
      [runningA, runningB],
      locked,
      new Date('2026-09-06T15:30:00.000Z'),
      800,
    );

    expect(later.progress['running-a']).toBe(1);
    expect(later.progress['running-b']).toBeCloseTo(0.5);
  });

  it('ticks live locked Elastic state only in the external Elastic surface', () => {
    const lockedAt = '2026-09-06T12:00:00.000Z';

    expect(shouldTickElasticProgress('external', 'tasks', 'elastic', lockedAt)).toBe(true);
    expect(shouldTickElasticProgress('fixture', 'tasks', 'elastic', lockedAt)).toBe(false);
    expect(shouldTickElasticProgress('external', 'tasks', 'timekeeping', lockedAt)).toBe(false);
    expect(shouldTickElasticProgress('external', 'schedule', 'elastic', lockedAt)).toBe(false);
    expect(shouldTickElasticProgress('external', 'tasks', 'elastic', null)).toBe(false);
  });

  it('renders execution controls, property pills and a read-only quick editor', () => {
    document.body.innerHTML = render('running-a');

    const harness = createInteractionHarness(document);

    expect(harness.target('elastic-target-input')).toBeInstanceOf(HTMLInputElement);
    expect(harness.target('elastic-lock')).toBeInstanceOf(HTMLButtonElement);
    expect(harness.target('elastic-property-running-a-priority').textContent).toContain('Priority');
    expect(harness.target('elastic-property-running-a-priority').textContent).toContain('P1');
    expect(harness.target('elastic-task-modal').getAttribute('role')).toBe('dialog');
    expect((harness.target('elastic-task-save') as HTMLButtonElement).disabled).toBe(true);
    expect((harness.target('elastic-task-delete') as HTMLButtonElement).disabled).toBe(true);
  });

  it('preserves target and lock presentation across an ordinary rerender', () => {
    const lockedSession = {
      targetTime: '2026-09-06T18:00:00.000Z',
      lockedAt: '2026-09-06T12:00:00.000Z',
    };

    const renderLocked = () => renderElasticCockpit({
      state,
      tasks: state.tasks,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      session: lockedSession,
      now: new Date('2026-09-06T13:00:00.000Z'),
      selectedTaskId: null,
      editorDraft: null,
      dropRefusal: null,
      taskWrites: { refusal: 'action-not-available', editorRefusal: null },
      newTaskDraft: null,
      newTaskRefusal: null,
      containerHeight: 800,
    });

    document.body.innerHTML = renderLocked();
    let harness = createInteractionHarness(document);

    expect((harness.target('elastic-target-input') as HTMLInputElement).disabled).toBe(true);
    expect(harness.target('elastic-unlock')).toBeInstanceOf(HTMLButtonElement);

    document.body.innerHTML = renderLocked();
    harness = createInteractionHarness(document);

    expect((harness.target('elastic-target-input') as HTMLInputElement).disabled).toBe(true);
    expect(harness.target('elastic-unlock')).toBeInstanceOf(HTMLButtonElement);
  });

  it('routes task opening, target changes, lock and unlock through the real DOM', () => {
    document.body.innerHTML = render();

    const calls: string[] = [];
    const handlers: ElasticCockpitHandlers = {
      openTask: (taskId) => calls.push(`open:${taskId}`),
      closeTask: () => calls.push('close'),
      setTarget: (targetTime) => calls.push(`target:${targetTime}`),
      lock: () => calls.push('lock'),
      unlock: () => calls.push('unlock'),
      moveTask: () => calls.push('move'),
      editTask: () => undefined,
      cancelTaskEdit: () => undefined,
      saveTask: () => undefined,
      openNewTask: () => undefined,
      cancelNewTask: () => undefined,
      editNewTask: () => undefined,
      createTask: () => undefined,
      deleteTask: () => undefined,
    };

    bindElasticCockpitInteractions(document.body, handlers);
    const harness = createInteractionHarness(document);

    harness.click('elastic-task-running-a');
    harness.click('elastic-lock');

    const target = harness.target('elastic-target-input') as HTMLInputElement;
    target.value = '2026-09-06T17:00';
    target.dispatchEvent(new Event('change', { bubbles: true }));

    expect(calls).toEqual([
      'open:running-a',
      'lock',
      `target:${new Date('2026-09-06T17:00').toISOString()}`,
    ]);
  });

  it('renders a visible pre-storage refusal without pretending the task moved', () => {
    document.body.innerHTML = renderElasticCockpit({
      state,
      tasks: state.tasks,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      session,
      now: new Date('2026-09-06T12:00:00.000Z'),
      selectedTaskId: null,
      editorDraft: null,
      dropRefusal: 'action-not-available',
      taskWrites: { refusal: 'action-not-available', editorRefusal: null },
      newTaskDraft: null,
      newTaskRefusal: null,
      containerHeight: 800,
    });

    const harness = createInteractionHarness(document);
    const refusal = harness.target('elastic-drop-refusal');

    expect(refusal.textContent).toContain('action-not-available');
    expect(refusal.textContent).toContain('Task data was not changed');
  });

  it('shows a lost race with the sentence and the revision that beat the caller', () => {
    document.body.innerHTML = renderElasticCockpit({
      state,
      tasks: state.tasks,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      session,
      now: new Date('2026-09-06T12:00:00.000Z'),
      selectedTaskId: null,
      editorDraft: null,
      // Exactly what the drop action hands the shell after a lost race.
      dropRefusal: refusalTextFor({
        code: 'stale-revision',
        detail: 'another writer changed this task first',
        actualRevision: 'rev-7',
      }),
      taskWrites: { refusal: null, editorRefusal: null },
      newTaskDraft: null,
      newTaskRefusal: null,
      containerHeight: 800,
    });

    const refusal = createInteractionHarness(document).target('elastic-drop-refusal');
    expect(refusal.textContent).toContain('stale-revision');
    expect(refusal.textContent).toContain('another writer changed this task first');
    expect(refusal.textContent).toContain('now at revision rev-7');
    expect(refusal.textContent).toContain('Task data was not changed');
  });

  it('clears hover, pickup, placeholder and destination feedback when a drag ends outside a slot', () => {
    document.body.innerHTML = render();

    const moves: unknown[] = [];
    bindElasticCockpitInteractions(document.body, {
      openTask: () => undefined,
      closeTask: () => undefined,
      setTarget: () => undefined,
      lock: () => undefined,
      unlock: () => undefined,
      moveTask: (intent) => moves.push(intent),
      editTask: () => undefined,
      cancelTaskEdit: () => undefined,
      saveTask: () => undefined,
      openNewTask: () => undefined,
      cancelNewTask: () => undefined,
      editNewTask: () => undefined,
      createTask: () => undefined,
      deleteTask: () => undefined,
    });

    const harness = createInteractionHarness(document);
    const source = harness.target('elastic-task-running-a');

    source.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(source.dataset.elasticHover).toBe('true');
    expect(source.style.outline).not.toBe('');

    source.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(source.dataset.elasticHover).toBeUndefined();
    expect(source.style.outline).toBe('');

    const drag = harness.beginDrag('elastic-task-running-a', {
      clientX: 0,
      clientY: 0,
    });

    drag.move('elastic-drop-backlog-0', {
      clientX: 20,
      clientY: 20,
    });

    const placeholder = harness.target('elastic-placeholder-backlog-0');
    const column = harness.target('board-column-backlog');

    expect(source.dataset.elasticPickup).toBe('true');
    expect(source.style.opacity).toBe('0.65');
    expect(placeholder.style.height).toBe('90px');
    expect(column.style.outline).not.toBe('');

    source.dispatchEvent(new Event('dragend', { bubbles: true }));

    expect(source.dataset.elasticPickup).toBeUndefined();
    expect(source.style.opacity).toBe('');
    expect(source.style.transform).toBe('');
    expect(placeholder.style.height).toBe('0px');
    expect(placeholder.style.opacity).toBe('0');
    expect(column.style.outline).toBe('');
    expect(moves).toEqual([]);
  });

  it('shows a correctly sized insertion placeholder before drop and emits one semantic move only on drop', () => {
    document.body.innerHTML = render();

    const moves: Array<{ taskId: string; targetColumn: string; targetIndex: number }> = [];
    bindElasticCockpitInteractions(document.body, {
      openTask: () => undefined,
      closeTask: () => undefined,
      setTarget: () => undefined,
      lock: () => undefined,
      unlock: () => undefined,
      moveTask: (intent) => moves.push(intent),
      editTask: () => undefined,
      cancelTaskEdit: () => undefined,
      saveTask: () => undefined,
      openNewTask: () => undefined,
      cancelNewTask: () => undefined,
      editNewTask: () => undefined,
      createTask: () => undefined,
      deleteTask: () => undefined,
    });

    const harness = createInteractionHarness(document);
    const drag = harness.beginDrag('elastic-task-running-a', {
      clientX: 0,
      clientY: 0,
    });

    drag.move('elastic-drop-backlog-0', {
      clientX: 20,
      clientY: 20,
    });

    const source = harness.target('elastic-task-running-a');
    const placeholder = harness.target('elastic-placeholder-backlog-0');
    const slot = harness.target('elastic-drop-backlog-0');

    const column = harness.target('board-column-backlog');

    expect(source.dataset.elasticHeight).toBe('600');
    expect(source.dataset.elasticPickup).toBe('true');
    expect(source.style.opacity).toBe('0.65');
    expect(placeholder.style.height).toBe('90px');
    expect(slot.dataset.elasticPreview).toBe('true');
    expect(column.style.outline).not.toBe('');
    expect(moves).toEqual([]);

    drag.move('elastic-drop-backlog-1', {
      clientX: 24,
      clientY: 28,
    });

    const secondPlaceholder = harness.target('elastic-placeholder-backlog-1');

    expect(placeholder.style.height).toBe('0px');
    expect(placeholder.style.opacity).toBe('0');
    expect(secondPlaceholder.style.height).toBe('90px');
    expect(secondPlaceholder.style.opacity).toBe('1');
    expect(moves).toEqual([]);

    drag.drop('elastic-drop-backlog-1', {
      clientX: 20,
      clientY: 20,
    });

    expect(moves).toEqual([
      {
        taskId: 'running-a',
        targetColumn: 'backlog',
        targetIndex: 1,
      },
    ]);
    expect(source.dataset.elasticPickup).toBeUndefined();
    expect(source.style.opacity).toBe('');
    expect(secondPlaceholder.style.height).toBe('0px');
    expect(column.style.outline).toBe('');
  });
});

/**
 * The Task editor, driven through the document.
 *
 * The modal's field list comes from `projectTaskEditor`; this suite is what makes the
 * § Task modal boxes evidence rather than a reading of the projection: it opens the real
 * modal over a schema that declares every property type, types into it, ticks it, and
 * discards the result.
 */
describe('Stage 6 Task editor in the Task modal', () => {
  const editorSchema: PropertySchema[] = [
    { id: 'notes', name: 'Notes', type: 'text' },
    { id: 'estimate', name: 'Estimate', type: 'number' },
    { id: 'area', name: 'Area', type: 'select', options: [{ id: 'work', name: 'Work', color: '#111' }, { id: 'home', name: 'Home', color: '#222' }] },
    { id: 'tags', name: 'Tags', type: 'multi-select', options: [{ id: 'urgent', name: 'Urgent', color: '#333' }, { id: 'later', name: 'Later', color: '#444' }] },
    { id: 'due', name: 'Due', type: 'date' },
    { id: 'flagged', name: 'Flagged', type: 'checkbox' },
    { id: 'blocks', name: 'Blocks', type: 'relation' },
    { id: 'childCount', name: 'Child count', type: 'rollup', aggregation: 'count', targetProperty: 'children' },
    { id: 'progress', name: 'Progress', type: 'formula', expression: 'done / total' },
  ];

  const editableTask: Task = {
    ...task('editable', 'running', 3, {
      notes: 'from the record',
      area: 'work',
      tags: ['urgent'],
      flagged: true,
      childCount: 4,
      progress: '2/5',
    }),
    name: 'Editable task',
    projectId: 'p-editor',
    isFixedDuration: true,
    fixedDuration: 90,
    maxDuration: 240,
    startDate: '2026-03-01T00:00:00.000Z',
    workflowStageId: 'st-review',
  };

  const editorState: ProximaState = {
    ...state,
    // One project, so the modal's workflow control is a select over that project's stages rather than the text
    // fallback a vault with no stages gets - and so the task's own project is a real choice.
    projects: [
      { id: 'p-editor', source: sourceRef('project', 'p-editor'), name: 'Editor project', description: '', createdAt: '2026-09-01T00:00:00.000Z', status: 'active', projectType: 'task', linkedFolders: [] },
    ],
    tasks: [editableTask],
    taskSchema: editorSchema,
    workflowStages: [
      { id: 'st-review', projectId: 'p-editor', name: 'Review', revision: 'st-review.json@1' },
      { id: 'st-doing', projectId: 'p-editor', name: 'Doing', revision: 'st-doing.json@1' },
    ],
  };

  /**
   * A session over the production renderer and binder. An edit deliberately does not
   * re-render, which is what production does — a keystroke must not take the field away
   * from the reader — so a case that wants to see the draft drawn asks for `draw()`.
   *
   * The write view is a parameter because it is the shell that decides it, not the modal: the
   * default is "this run cannot write", which is what a fixture boot resolves to.
   */
  function mount(writes: { refusal: string | null; editorRefusal?: string | null } = { refusal: 'action-not-available' }) {
    let selectedTaskId: string | null = editableTask.id;
    let draft: TaskEditorDraft | null = null;
    let editorRefusal: string | null = writes.editorRefusal ?? null;
    const saves: (TaskEditorDraft | null)[] = [];
    const deletes: string[] = [];
    const root = document.createElement('div');
    document.body.appendChild(root);

    const draw = () => {
      root.innerHTML = renderElasticCockpit({
        state: editorState,
        tasks: editorState.tasks,
        projectNames: new Map(),
        selectionLabel: 'All projects',
        session,
        now: new Date('2026-09-06T13:00:00.000Z'),
        selectedTaskId,
        editorDraft: draft,
        dropRefusal: null,
        taskWrites: { refusal: writes.refusal, editorRefusal },
        newTaskDraft: null,
        newTaskRefusal: null,
      });
    };

    draw();
    bindElasticCockpitInteractions(root, {
      openTask: (taskId) => { selectedTaskId = taskId; draft = null; draw(); },
      closeTask: () => { selectedTaskId = null; draft = null; draw(); },
      setTarget: () => undefined,
      lock: () => undefined,
      unlock: () => undefined,
      moveTask: () => undefined,
      editTask: (edit) => {
        const record = editorState.tasks.find((candidate) => candidate.id === selectedTaskId);
        if (!record) return;
        draft = applyTaskEditorEdit(draft ?? taskEditorDraftFor(record), edit);
      },
      cancelTaskEdit: () => { draft = null; draw(); },
      // The shell's half: what the binder reports is what these record. What a write path then
      // does with it is the app layer's business, and its own suite proves that.
      saveTask: () => { saves.push(draft); editorRefusal = null; draw(); },
      deleteTask: () => { deletes.push(selectedTaskId ?? ''); selectedTaskId = null; draft = null; draw(); },
      // The New Task form has its own suite; here it only needs to be bindable.
      openNewTask: () => undefined,
      cancelNewTask: () => undefined,
      editNewTask: () => undefined,
      createTask: () => undefined,
    });

    return {
      root,
      harness: createInteractionHarness(root),
      draw,
      draft: () => draft,
      saves,
      deletes,
      control: (key: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-papers-visual-key="${key}"]`),
      /** Tick a box the way the document does, then report it. */
      toggle: (key: string) => {
        const box = root.querySelector<HTMLInputElement>(`[data-papers-visual-key="${key}"]`)!;
        box.checked = !box.checked;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return box.checked;
      },
    };
  }

  it('shows a control for every field, of the kind its type calls for', () => {
    const mounted = mount();

    // The task's own fields.
    expect(mounted.control('task-editor-name')).not.toBeNull();
    expect(mounted.control('task-editor-name')!.tagName).toBe('INPUT');
    expect((mounted.control('task-editor-name') as HTMLInputElement).value).toBe('Editable task');
    expect((mounted.control('task-editor-executionState') as HTMLSelectElement).value).toBe('running');
    expect(Array.from((mounted.control('task-editor-executionState') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['backlog', 'running', 'review']);
    // The workflow dimension has its own control, from the task's project's stages, with the record's value.
    expect((mounted.control('task-editor-workflowStage') as HTMLSelectElement).value).toBe('st-review');
    expect(Array.from((mounted.control('task-editor-workflowStage') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['st-review', 'st-doing']);
    expect((mounted.control('task-editor-weight') as HTMLInputElement).value).toBe('3');
    expect((mounted.control('task-editor-fixedDurationOn') as HTMLInputElement).checked).toBe(true);
    expect((mounted.control('task-editor-fixedDuration') as HTMLInputElement).value).toBe('90');
    expect((mounted.control('task-editor-maxDuration') as HTMLInputElement).value).toBe('240');
    expect((mounted.control('task-editor-startDate') as HTMLInputElement).value).toBe('2026-03-01T00:00:00.000Z');
    expect((mounted.control('task-editor-deadline') as HTMLInputElement).value).toBe('');
    expect((mounted.control('task-editor-completion') as HTMLInputElement).checked).toBe(false);

    // Every property type the schema declares, and the value the record holds.
    expect((mounted.control('task-editor-property:notes') as HTMLInputElement).value).toBe('from the record');
    expect((mounted.control('task-editor-property:estimate') as HTMLInputElement).value).toBe('');
    expect((mounted.control('task-editor-property:area') as HTMLSelectElement).value).toBe('work');
    expect((mounted.control('task-editor-property:due') as HTMLInputElement).value).toBe('');
    expect((mounted.control('task-editor-property:flagged') as HTMLInputElement).checked).toBe(true);
    expect((mounted.control('task-editor-property:blocks') as HTMLInputElement).value).toBe('');
    expect((mounted.control('task-editor-property:tags-urgent') as HTMLInputElement).checked).toBe(true);
    expect((mounted.control('task-editor-property:tags-later') as HTMLInputElement).checked).toBe(false);

    // Derived values are shown with what they come from, and have nothing to type in.
    const derived = mounted.root.querySelector('[data-papers-visual-key="task-editor-property:childCount"]')!;
    expect(derived.tagName).toBe('P');
    expect(derived.querySelector('input, select')).toBeNull();
    expect(derived.textContent).toContain('4');
    expect(mounted.root.textContent).toContain('count of children');
    expect(mounted.root.textContent).toContain('done / total');
    expect(mounted.root.querySelector('[data-papers-visual-key="task-editor-property:progress"]')!.querySelector('input, select')).toBeNull();

    // The editor says how many fields it is showing, so a reader need not count markup.
    expect(mounted.root.querySelector('[data-papers-visual-key="elastic-task-modal"]')!.getAttribute('data-task-editor-field-count')).toBe(String(16 + editorSchema.length));
  });

  it('reports a typed value, and draws the draft without pretending it is saved', () => {
    const mounted = mount();

    mounted.harness.typeText('task-editor-name', '!');

    expect(mounted.draft()!.values.name).toBe('Editable task!');
    // Nothing was saved, so the record is untouched and the rendered form still shows
    // what the draft holds once it is drawn again.
    expect(editableTask.name).toBe('Editable task');
    mounted.draw();
    expect((mounted.control('task-editor-name') as HTMLInputElement).value).toBe('Editable task!');
    expect(mounted.root.querySelector('[data-papers-visual-key="task-editor-dirty"]')).not.toBeNull();
    expect(mounted.root.textContent).toContain('until the record store can write');
  });

  it('reports a checkbox, a select and a whole multi-select group', () => {
    const mounted = mount();

    expect(mounted.toggle('task-editor-completion')).toBe(true);
    expect(mounted.draft()!.checks.completion).toBe(true);

    expect(mounted.toggle('task-editor-property:flagged')).toBe(false);
    expect(mounted.draft()!.checks['property:flagged']).toBe(false);

    expect(mounted.toggle('task-editor-property:tags-later')).toBe(true);
    expect(mounted.draft()!.selections['property:tags']).toEqual(['urgent', 'later']);

    expect(mounted.toggle('task-editor-property:tags-urgent')).toBe(false);
    expect(mounted.draft()!.selections['property:tags']).toEqual(['later']);
  });

  it('discards the provisional form state on Cancel and on Escape', () => {
    const cancelled = mount();
    cancelled.harness.typeText('task-editor-name', '!');
    cancelled.draw();
    expect(cancelled.root.querySelector('[data-papers-visual-key="task-editor-dirty"]')).not.toBeNull();

    cancelled.harness.click('task-editor-cancel');

    expect(cancelled.draft()).toBeNull();
    expect((cancelled.control('task-editor-name') as HTMLInputElement).value).toBe('Editable task');
    expect(cancelled.root.querySelector('[data-papers-visual-key="task-editor-clean"]')).not.toBeNull();

    const escaped = mount();
    escaped.toggle('task-editor-completion');
    expect(escaped.draft()).not.toBeNull();

    escaped.harness.pressKey('elastic-task-modal', 'Escape');

    expect(escaped.draft()).toBeNull();
    expect((escaped.control('task-editor-completion') as HTMLInputElement).checked).toBe(false);
    expect(escaped.root.querySelector('[data-papers-visual-key="elastic-task-modal"]')).not.toBeNull();
  });

  it('keeps Save refused with a typed result rather than hiding the button', () => {
    const mounted = mount();
    const save = mounted.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="elastic-task-save"]')!;

    expect(save.disabled).toBe(true);
    expect(save.getAttribute('data-task-editor-save-refusal')).toBe('action-not-available');
    expect(save.textContent).toContain('Save unavailable');
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="elastic-task-delete"]')!.disabled).toBe(true);
    expect(mounted.root.querySelector('[data-papers-visual-key="task-editor-cancel"]')).not.toBeNull();
    // And the modal says which of the two worlds it is in, so a caller need not read the buttons.
    expect(mounted.root.querySelector('[data-papers-visual-key="elastic-task-modal"]')!.getAttribute('data-task-editor-writes')).toBe('unavailable');
  });

  it('offers Save only when there is something to write, and reports both controls through the binder', () => {
    const mounted = mount({ refusal: null });
    const save = () => mounted.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="elastic-task-save"]')!;
    const remove = () => mounted.root.querySelector<HTMLButtonElement>('[data-papers-visual-key="elastic-task-delete"]')!;

    // A form that matches the record has nothing to save, so the button is offered disabled.
    expect(mounted.root.querySelector('[data-papers-visual-key="elastic-task-modal"]')!.getAttribute('data-task-editor-writes')).toBe('available');
    expect(save().disabled).toBe(true);
    expect(save().getAttribute('data-task-editor-save-refusal')).toBeNull();
    expect(remove().disabled).toBe(false);
    expect(remove().textContent).toBe('Delete');

    mounted.harness.typeText('task-editor-name', '!');
    mounted.draw();

    expect(save().disabled).toBe(false);
    mounted.harness.click('elastic-task-save');
    expect(mounted.saves).toHaveLength(1);
    expect(mounted.saves[0]!.values.name).toBe('Editable task!');

    mounted.harness.click('elastic-task-delete');
    expect(mounted.deletes).toEqual([editableTask.id]);
    expect(mounted.root.querySelector('[data-papers-visual-key="elastic-task-modal"]')).toBeNull();
  });

  it('draws a refused save beside the form without claiming the record changed', () => {
    const mounted = mount({ refusal: null, editorRefusal: 'stale-revision' });
    const refusal = mounted.root.querySelector('[data-papers-visual-key="task-editor-refusal"]')!;

    expect(refusal.getAttribute('data-task-editor-refusal')).toBe('stale-revision');
    expect(refusal.textContent).toContain('stale-revision');
    expect(refusal.textContent).toContain('The record was not changed');
    // The form is still there with its edits, which is what lets a reader retry from the
    // authoritative revision rather than losing what they typed.
    expect(mounted.control('task-editor-name')).not.toBeNull();
  });

  it('closes without leaving a draft behind for the next task', () => {
    const mounted = mount();
    mounted.harness.typeText('task-editor-name', '!');
    expect(mounted.draft()).not.toBeNull();

    mounted.harness.click('elastic-task-modal-close');

    expect(mounted.draft()).toBeNull();
    expect(mounted.root.querySelector('[data-papers-visual-key="elastic-task-modal"]')).toBeNull();
  });
});
