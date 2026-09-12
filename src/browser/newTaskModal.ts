/**
 * The New Task form, drawn.
 *
 * It is a sibling of the Task editor's modal and deliberately looks like one: same section and
 * field markup (through the same `renderTaskEditorField`, with hooks of its own so the two forms
 * cannot answer each other's keystrokes), same footer shape, same rule about writing — the form is
 * told whether this run may write, so a Save that cannot work says so where the button is instead of
 * being clicked and refused.
 *
 * Two small differences are the whole point of it being a separate modal. Its title is a constant,
 * because a task that does not exist yet has no name to show. And Save is offered only once the form
 * holds something a save could write — an empty New Task form has nothing to refuse, and a disabled
 * button is a better answer than a click that comes back with "a task needs a name".
 */
import type { ProximaState } from '../domain/types.js';
import { projectNewTaskEditor, TASK_CREATE_SCHEMA_VERSION, type TaskCreateProjection } from '../app/taskCreate.js';
import { TASK_EDITOR_SAVE_NOTE, type TaskEditorDraft } from '../app/taskEditor.js';
import type { TaskModalWriteView } from './elasticCockpit.js';
import { NEW_TASK_EDITOR_HOOKS, renderTaskEditorField } from './taskEditorFields.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The empty form's own sentence, which is not a write refusal. */
export const NEW_TASK_NAME_NOTE = 'A task needs a name before it can be created.';

export function renderNewTaskModal(
  state: ProximaState,
  draft: TaskEditorDraft,
  write: TaskModalWriteView,
): string {
  const form: TaskCreateProjection = projectNewTaskEditor(state, draft);
  const sections = form.sections
    .map((section) => `<fieldset class="task-editor-section" data-papers-visual-key="new-task-section-${escapeHtml(section.id)}"><legend>${escapeHtml(section.label)}</legend>${section.fields.map((field) => renderTaskEditorField(field, NEW_TASK_EDITOR_HOOKS)).join('')}</fieldset>`)
    .join('');
  const status = write.refusal === null
    ? (form.dirty
      ? '<p class="task-editor-dirty" data-papers-visual-key="new-task-ready" data-new-task-dirty="true">Save creates this task in the record store.</p>'
      : `<p class="task-editor-clean" data-papers-visual-key="new-task-empty" data-new-task-dirty="false">${escapeHtml(NEW_TASK_NAME_NOTE)}</p>`)
    : `<p class="task-editor-clean" data-papers-visual-key="new-task-unavailable" data-new-task-dirty="${form.dirty ? 'true' : 'false'}">${escapeHtml(TASK_EDITOR_SAVE_NOTE)}</p>`;
  const refusal = write.editorRefusal === null
    ? ''
    : `<p class="diagnostics" data-papers-visual-key="new-task-refusal" data-new-task-refusal="${escapeHtml(write.editorRefusal)}">Create refused: ${escapeHtml(write.editorRefusal)}. No task was created.</p>`;

  const saveControl = write.refusal !== null
    ? `<button type="button" data-papers-visual-key="new-task-save" data-new-task-save-refusal="${escapeHtml(write.refusal)}" disabled>Create unavailable</button>`
    : `<button type="button" data-elastic-action="create-task" data-papers-visual-key="new-task-save"${form.dirty ? '' : ' disabled'}>Create task</button>`;

  return `<section class="task-modal" role="dialog" aria-modal="true" aria-label="New task" data-papers-visual-key="new-task-modal" data-new-task-schema-version="${TASK_CREATE_SCHEMA_VERSION}" data-new-task-field-count="${form.fieldCount}" data-new-task-writes="${write.refusal === null ? 'available' : 'unavailable'}"><header><h2>${escapeHtml(form.title)}</h2><button type="button" data-elastic-action="cancel-new-task" data-papers-visual-key="new-task-modal-close" aria-label="Close new task">×</button></header>${status}${refusal}${sections}<footer><button type="button" data-elastic-action="cancel-new-task" data-papers-visual-key="new-task-cancel">Cancel</button>${saveControl}</footer></section>`;
}
