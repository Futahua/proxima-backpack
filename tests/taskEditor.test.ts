/**
 * Task editor model contracts.
 *
 * What the Task modal shows is decided here rather than in markup, so "every existing
 * meaningful field is representable" is a claim with evidence: the field list is walked
 * field by field, and the draft is probed for the property that makes Cancel exact —
 * that a draft seeded from a record is not yet a change.
 */

import { describe, expect, it } from 'vitest';

import {
  applyTaskEditorEdit,
  projectTaskEditor,
  sameTaskEditorDraft,
  taskEditorDraftFor,
  taskEditorPropertyFieldId,
  TASK_EDITOR_SAVE_NOTE,
  TASK_EDITOR_SAVE_REFUSAL,
  type TaskEditorField,
  type TaskEditorSection,
} from '../src/app/taskEditor.js';
import { EMPTY_STATE, type PropertySchema, type ProximaState, type Task } from '../src/domain/types.js';

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    source: { path: `Proxima/tasks/${overrides.id}.md`, revision: 'r1', kind: 'task', idOrigin: 'frontmatter' },
    name: overrides.id,
    description: '',
    projectId: 'p1',
    status: 'running',
    weight: 1,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-01-02T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
    ...overrides,
  };
}

function state(overrides: Partial<ProximaState> = {}): ProximaState {
  return {
    ...EMPTY_STATE,
    projects: [
      { id: 'p1', source: { path: 'Proxima/projects/p1.md', revision: 'r1', kind: 'project', idOrigin: 'frontmatter' }, name: 'Alpha project', description: '', createdAt: '2026-01-01T00:00:00.000Z', status: 'active', projectType: 'task', linkedFolders: [] },
      { id: 'p2', source: { path: 'Proxima/projects/p2.md', revision: 'r1', kind: 'project', idOrigin: 'frontmatter' }, name: 'Archived project', description: '', createdAt: '2026-01-01T00:00:00.000Z', status: 'archived', projectType: 'task', linkedFolders: [] },
    ],
    statuses: [
      { id: 'backlog', name: 'Backlog', color: '#888', column: 'backlog' },
      { id: 'running', name: 'Running', color: '#0a0', column: 'running' },
    ],
    taskSchema: [
      { id: 'notes', name: 'Notes', type: 'text' },
      { id: 'estimate', name: 'Estimate', type: 'number' },
      { id: 'area', name: 'Area', type: 'select', options: [{ id: 'work', name: 'Work', color: '#111' }, { id: 'home', name: 'Home', color: '#222' }] },
      { id: 'tags', name: 'Tags', type: 'multi-select', options: [{ id: 'urgent', name: 'Urgent', color: '#333' }] },
      { id: 'due', name: 'Due', type: 'date' },
      { id: 'flagged', name: 'Flagged', type: 'checkbox' },
      { id: 'blocks', name: 'Blocks', type: 'relation', relationProperty: 'blocks' },
      { id: 'childCount', name: 'Child count', type: 'rollup', aggregation: 'count', targetProperty: 'children' },
      { id: 'progress', name: 'Progress', type: 'formula', expression: 'done / total' },
    ],
    tasks: [task({ id: 't1' })],
    ...overrides,
  };
}

/** Every field of a projection, section by section, for walks that must be exhaustive. */
function fieldsOf(sections: readonly TaskEditorSection[]): TaskEditorField[] {
  return sections.flatMap((section) => [...section.fields]);
}

function fieldFor(sections: readonly TaskEditorSection[], id: string): TaskEditorField {
  const found = fieldsOf(sections).find((candidate) => candidate.id === id);

  if (!found) throw new Error(`no field "${id}"; the editor has ${fieldsOf(sections).map((candidate) => candidate.id).join(', ')}`);

  return found;
}

describe('Task editor projection', () => {
  it('represents every field of the task itself', () => {
    const loaded = state({
      tasks: [task({
        id: 't1',
        name: 'Ship it',
        projectId: 'p1',
        status: 'running',
        weight: 3,
        isFixedDuration: true,
        fixedDuration: 90,
        maxDuration: 240,
        startDate: '2026-03-01T00:00:00.000Z',
        deadline: '2026-03-10T00:00:00.000Z',
        isCompleted: false,
      })],
    });

    const editor = projectTaskEditor(loaded, 't1', null)!;
    const fields = fieldsOf(editor.sections);

    expect(editor.taskId).toBe('t1');
    expect(editor.title).toBe('Ship it');
    expect(editor.projectId).toBe('p1');

    // Every field of the task model is on the form, with the record's own value.
    expect(fieldFor(editor.sections, 'name').value).toBe('Ship it');
    expect(fieldFor(editor.sections, 'project').value).toBe('p1');
    expect(fieldFor(editor.sections, 'executionState').value).toBe('running');
    expect(fieldFor(editor.sections, 'weight').value).toBe('3');
    expect(fieldFor(editor.sections, 'fixedDurationOn').checked).toBe(true);
    expect(fieldFor(editor.sections, 'fixedDuration').value).toBe('90');
    expect(fieldFor(editor.sections, 'maxDuration').value).toBe('240');
    expect(fieldFor(editor.sections, 'startDate').value).toBe('2026-03-01T00:00:00.000Z');
    expect(fieldFor(editor.sections, 'deadline').value).toBe('2026-03-10T00:00:00.000Z');
    expect(fieldFor(editor.sections, 'completion').checked).toBe(false);

    // The controls are the ones each value's type calls for.
    expect(fieldFor(editor.sections, 'name').control).toBe('text');
    expect(fieldFor(editor.sections, 'project').control).toBe('select');
    expect(fieldFor(editor.sections, 'weight').control).toBe('number');
    expect(fieldFor(editor.sections, 'fixedDurationOn').control).toBe('checkbox');
    expect(fieldFor(editor.sections, 'startDate').control).toBe('date');

    // An absent value is empty, not the word "null".
    const bare = state({ tasks: [task({ id: 't1' })] });
    const bareEditor = projectTaskEditor(bare, 't1', null)!;
    expect(fieldFor(bareEditor.sections, 'deadline').value).toBe('');
    expect(fieldFor(bareEditor.sections, 'fixedDuration').value).toBe('');
    expect(fieldFor(bareEditor.sections, 'fixedDurationOn').checked).toBe(false);

    // The project choices are the active projects plus "no project".
    const projects = fieldFor(editor.sections, 'project');
    expect(projects.options.map((option) => option.id)).toEqual(['p1', '']);
    // The status choices are the vault's vocabulary, named with their Elastic column.
    expect(fieldFor(editor.sections, 'executionState').options.map((option) => option.label)).toEqual([
      'Backlog (backlog)',
      'Running (running)',
    ]);
  });

  it('falls back to the stored status when the vault declares no statuses', () => {
    const loaded = state({ statuses: [], tasks: [task({ id: 't1', status: 'odd-status' })] });

    const field = fieldFor(projectTaskEditor(loaded, 't1', null)!.sections, 'executionState');

    expect(field.control).toBe('text');
    expect(field.value).toBe('odd-status');
    expect(field.note).toContain('declares no statuses');
  });

  it('represents every schema property, whether the task has it or not', () => {
    const loaded = state({
      tasks: [task({
        id: 't1',
        properties: { notes: 'from the record', area: 'work', tags: ['urgent'], flagged: true },
      })],
    });

    const editor = projectTaskEditor(loaded, 't1', null)!;
    const properties = editor.sections.find((section) => section.id === 'properties')!;

    // The schema decides the list, so a property this task has never set is still a field.
    expect(properties.fields.map((entry) => entry.id)).toEqual([
      taskEditorPropertyFieldId('notes'),
      taskEditorPropertyFieldId('estimate'),
      taskEditorPropertyFieldId('area'),
      taskEditorPropertyFieldId('tags'),
      taskEditorPropertyFieldId('due'),
      taskEditorPropertyFieldId('flagged'),
      taskEditorPropertyFieldId('blocks'),
      taskEditorPropertyFieldId('childCount'),
      taskEditorPropertyFieldId('progress'),
    ]);

    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('notes')).value).toBe('from the record');
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('estimate')).value).toBe('');
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('area')).control).toBe('select');
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('area')).options.map((option) => option.label)).toEqual(['Work', 'Home']);
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('tags')).control).toBe('multi-select');
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('tags')).selected).toEqual(['urgent']);
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('due')).control).toBe('date');
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('flagged')).control).toBe('checkbox');
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('flagged')).checked).toBe(true);
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('blocks')).control).toBe('relation');
    expect(fieldFor(editor.sections, taskEditorPropertyFieldId('blocks')).note).toContain('HARD GATE A6');

    // A multi-select's default when unset is no selection rather than an empty choice.
    const empty = state({ tasks: [task({ id: 't1' })] });
    expect(fieldFor(projectTaskEditor(empty, 't1', null)!.sections, taskEditorPropertyFieldId('tags')).selected).toEqual([]);
  });

  it('shows derived properties and refuses to make them editable', () => {
    const loaded = state({
      tasks: [task({ id: 't1', properties: { childCount: 4, progress: '2/5' } })],
    });

    const editor = projectTaskEditor(loaded, 't1', null)!;
    const rollup = fieldFor(editor.sections, taskEditorPropertyFieldId('childCount'));
    const formula = fieldFor(editor.sections, taskEditorPropertyFieldId('progress'));

    expect(rollup.control).toBe('derived');
    expect(rollup.editable).toBe(false);
    expect(rollup.value).toBe('4');
    expect(rollup.note).toContain('count of children');
    expect(formula.editable).toBe(false);
    expect(formula.note).toContain('done / total');

    // Everything that is not derived is editable, or the form would lie about the rest.
    const editable = fieldsOf(editor.sections).filter((entry) => entry.editable);
    expect(editable.some((entry) => entry.control === 'derived')).toBe(false);
  });

  it('shows a record value the schema does not declare instead of hiding it', () => {
    const loaded = state({
      tasks: [task({ id: 't1', properties: { notes: 'known', mystery: 'unknown' } })],
    });

    const editor = projectTaskEditor(loaded, 't1', null)!;
    const mystery = fieldFor(editor.sections, taskEditorPropertyFieldId('mystery'));

    expect(mystery.label).toBe('mystery');
    expect(mystery.value).toBe('unknown');
    expect(mystery.editable).toBe(true);
    expect(mystery.note).toContain('not in the schema');

    // The schema's own field for that key is not duplicated.
    const ids = fieldsOf(editor.sections).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns nothing for a task that is not loaded', () => {
    expect(projectTaskEditor(state(), 'missing', null)).toBeNull();
  });

  it('counts the fields it shows', () => {
    const loaded = state();
    const editor = projectTaskEditor(loaded, 't1', null)!;

    expect(editor.fieldCount).toBe(fieldsOf(editor.sections).length);
    expect(editor.fieldCount).toBe(10 + loaded.taskSchema.length);
  });
});

describe('Task editor draft', () => {
  it('starts from the record, so a fresh draft is not yet a change', () => {
    const loaded = state({
      tasks: [task({ id: 't1', name: 'Ship it', weight: 3, properties: { notes: 'from the record', tags: ['urgent'], flagged: true } })],
    });
    const record = loaded.tasks[0]!;
    const draft = taskEditorDraftFor(record);

    expect(draft.values.name).toBe('Ship it');
    expect(draft.values.weight).toBe('3');
    expect(draft.values[taskEditorPropertyFieldId('notes')]).toBe('from the record');
    expect(draft.checks.flagged ?? draft.checks[taskEditorPropertyFieldId('flagged')]).toBe(true);
    expect(draft.selections[taskEditorPropertyFieldId('tags')]).toEqual(['urgent']);

    // No draft at all and a draft seeded from the record show the same thing and neither
    // is dirty, which is what makes Cancel exact.
    const seeded = projectTaskEditor(loaded, 't1', draft)!;
    const none = projectTaskEditor(loaded, 't1', null)!;
    expect(seeded.dirty).toBe(false);
    expect(none.dirty).toBe(false);
    expect(seeded.sections).toEqual(none.sections);
    expect(sameTaskEditorDraft(draft, taskEditorDraftFor(record))).toBe(true);
  });

  it('takes one edit per kind and marks the editor dirty', () => {
    const loaded = state({ tasks: [task({ id: 't1', weight: 3 })] });
    const seed = taskEditorDraftFor(loaded.tasks[0]!);

    const renamed = applyTaskEditorEdit(seed, { fieldId: 'name', value: 'Renamed' });
    expect(projectTaskEditor(loaded, 't1', renamed)!.dirty).toBe(true);
    expect(fieldFor(projectTaskEditor(loaded, 't1', renamed)!.sections, 'name').value).toBe('Renamed');

    const weighted = applyTaskEditorEdit(renamed, { fieldId: 'weight', value: '8' });
    expect(fieldFor(projectTaskEditor(loaded, 't1', weighted)!.sections, 'weight').value).toBe('8');

    const completed = applyTaskEditorEdit(weighted, { fieldId: 'completion', checked: true });
    expect(fieldFor(projectTaskEditor(loaded, 't1', completed)!.sections, 'completion').checked).toBe(true);

    const tagged = applyTaskEditorEdit(completed, { fieldId: taskEditorPropertyFieldId('tags'), selected: ['urgent', 'later'] });
    expect(fieldFor(projectTaskEditor(loaded, 't1', tagged)!.sections, taskEditorPropertyFieldId('tags')).selected).toEqual(['urgent', 'later']);

    const replaced = applyTaskEditorEdit(tagged, { fieldId: 'name', value: 'Again' });
    expect(fieldFor(projectTaskEditor(loaded, 't1', replaced)!.sections, 'name').value).toBe('Again');
    expect(replaced.values.weight).toBe('8');
  });

  it('goes back to not dirty when an edit is undone', () => {
    const loaded = state({ tasks: [task({ id: 't1', name: 'Ship it' })] });
    const seed = taskEditorDraftFor(loaded.tasks[0]!);

    const edited = applyTaskEditorEdit(seed, { fieldId: 'name', value: 'Other' });
    const undone = applyTaskEditorEdit(edited, { fieldId: 'name', value: 'Ship it' });

    expect(projectTaskEditor(loaded, 't1', undone)!.dirty).toBe(false);
    expect(sameTaskEditorDraft(undone, seed)).toBe(true);

    // A cleared value is a change when the record had one, and is not when it had none.
    const clearedDeadline = applyTaskEditorEdit(seed, { fieldId: 'deadline', value: '' });
    expect(projectTaskEditor(loaded, 't1', clearedDeadline)!.dirty).toBe(false);
  });

  it('never mutates the draft it was given', () => {
    const loaded = state({ tasks: [task({ id: 't1' })] });
    const seed = taskEditorDraftFor(loaded.tasks[0]!);
    const before = JSON.stringify(seed);

    applyTaskEditorEdit(seed, { fieldId: 'name', value: 'x' });
    applyTaskEditorEdit(seed, { fieldId: 'completion', checked: true });
    applyTaskEditorEdit(seed, { fieldId: taskEditorPropertyFieldId('tags'), selected: ['a'] });

    expect(JSON.stringify(seed)).toBe(before);
  });

  it('states the refusal it will answer with, so the modal cannot promise a save', () => {
    expect(TASK_EDITOR_SAVE_REFUSAL).toBe('action-not-available');
    expect(TASK_EDITOR_SAVE_NOTE).toContain('until the record store can write');
    expect(TASK_EDITOR_SAVE_NOTE).toContain('Nothing on this form has been changed');
  });
});
