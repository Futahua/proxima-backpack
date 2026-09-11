import type { TaskEditorField } from '../app/taskEditor.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The attribute names a surface uses for the editor's controls.
 *
 * The Task editor is one projection drawn by two surfaces — the Elastic board's modal and the
 * Backlog's panel — and each surface binds its own listeners on the application root. Shared
 * attribute names would mean both binders answering the same keystroke, so the *hooks* differ
 * even though the markup does not. The machine keys differ too, so a test can say which
 * surface it means.
 */
export interface TaskEditorHooks {
  /** The prefix every machine key in this editor carries. */
  keyPrefix:
    string;

  readonly fieldAttribute:
    string;

  readonly editAttribute:
    string;

  readonly optionAttribute:
    string;
}

/** The Elastic board's modal. */
export const ELASTIC_EDITOR_HOOKS:
  TaskEditorHooks = {
    keyPrefix:
      'task-editor',
    fieldAttribute:
      'data-task-editor-field',
    editAttribute:
      'data-task-editor-edit',
    optionAttribute:
      'data-task-editor-option',
  };

/** The Backlog panel's editor. */
export const BACKLOG_EDITOR_HOOKS:
  TaskEditorHooks = {
    keyPrefix:
      'project-backlog-editor',
    fieldAttribute:
      'data-project-backlog-editor-field',
    editAttribute:
      'data-project-backlog-editor-edit',
    optionAttribute:
      'data-project-backlog-editor-option',
  };

/**
 * One field of the Task editor, drawn as the control its type calls for.
 *
 * Dates are text inputs holding the stored value on purpose: the vault stores ISO
 * instants, and a date input would normalise `2026-03-10T00:00:00.000Z` to
 * `2026-03-10` on sight and report a change nobody made.
 */
export function renderTaskEditorField(
  field:
    TaskEditorField,
  hooks:
    TaskEditorHooks,
): string {
  const key = `${hooks.keyPrefix}-${field.id}`;
  const attributes = `${hooks.fieldAttribute}="${escapeHtml(field.id)}"`;

  if (field.control === 'derived') {
    return `<p class="task-editor-derived" data-c1-key="${escapeHtml(key)}"><strong>${escapeHtml(field.label)}</strong><span>${escapeHtml(field.value || 'No value')}</span><small>${escapeHtml(field.note ?? 'Derived value.')}</small></p>`;
  }

  if (field.control === 'checkbox') {
    return `<label class="task-editor-check"><input type="checkbox" data-c1-key="${escapeHtml(key)}" ${attributes} ${hooks.editAttribute}="check"${field.checked ? ' checked' : ''}${field.editable ? '' : ' disabled'}> ${escapeHtml(field.label)}</label>`;
  }

  if (field.control === 'select') {
    const options = field.options.map((option) => `<option value="${escapeHtml(option.id)}"${option.id === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');

    return `<label class="task-editor-field">${escapeHtml(field.label)}<select data-c1-key="${escapeHtml(key)}" ${attributes} ${hooks.editAttribute}="value">${options}</select></label>`;
  }

  if (field.control === 'multi-select') {
    const options = field.options.map((option) => `<label class="task-editor-option"><input type="checkbox" data-c1-key="${escapeHtml(key)}-${escapeHtml(option.id)}" ${attributes} ${hooks.optionAttribute}="${escapeHtml(option.id)}" ${hooks.editAttribute}="selection"${field.selected.includes(option.id) ? ' checked' : ''}> ${escapeHtml(option.label)}</label>`).join('');

    return `<fieldset class="task-editor-field task-editor-multi" data-c1-key="${escapeHtml(key)}"><legend>${escapeHtml(field.label)}</legend>${options}${field.note === null ? '' : `<small class="task-editor-note">${escapeHtml(field.note)}</small>`}</fieldset>`;
  }

  const type = field.control === 'number' ? 'number' : 'text';

  return `<label class="task-editor-field">${escapeHtml(field.label)}<input type="${type}" data-c1-key="${escapeHtml(key)}" ${attributes} ${hooks.editAttribute}="value" value="${escapeHtml(field.value)}"${field.editable ? '' : ' readonly'}></label>${field.note === null ? '' : `<small class="task-editor-note">${escapeHtml(field.note)}</small>`}`;
}

/**
 * Read one edit out of the document, from the control a person just used.
 *
 * The hooks are the surface's, so the same keystroke means the same edit on both surfaces —
 * and a surface cannot answer for the other's controls. A multi-select's group is read as a
 * whole, so unticking one option reports the remaining ones rather than a removal the model
 * would have to infer.
 */
export function taskEditorEditFrom(
  root:
    ParentNode,
  hooks:
    TaskEditorHooks,
  control:
    HTMLElement,
): { fieldId: string } & (
  | { value: string }
  | { checked: boolean }
  | { selected: readonly string[] }
) | null {
  const fieldId = control.getAttribute(hooks.fieldAttribute) ?? '';
  if (fieldId.length === 0) return null;

  const kind = control.getAttribute(hooks.editAttribute);
  const input = control as HTMLInputElement;

  if (kind === 'check') {
    return {
      fieldId,
      checked: input.checked,
    };
  }

  if (kind === 'selection') {
    const selected = Array.from(root.querySelectorAll<HTMLElement>(`[${hooks.fieldAttribute}="${fieldId}"][${hooks.optionAttribute}]`))
      .filter((option) => (option as HTMLInputElement).checked)
      .map((option) => option.getAttribute(hooks.optionAttribute) ?? '')
      .filter((optionId) => optionId.length > 0);

    return {
      fieldId,
      selected,
    };
  }

  return {
    fieldId,
    value: input.value,
  };
}
