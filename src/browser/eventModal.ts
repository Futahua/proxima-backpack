import type { CalendarEvent } from '../domain/types.js';
import {
  EVENT_EDITOR_SAVE_NOTE,
  EVENT_EDITOR_SAVE_REFUSAL,
  projectEventEditor,
  type EventEditorDraft,
  type EventEditorField,
  type EventEditorInput,
  type EventEditorOption,
  type EventEditorRecurrence,
} from '../app/eventEditor.js';
import type { EventFormRecurrence, EventFormRecurrenceEnd, EventFormValues } from '../app/eventFormPlan.js';
import { scheduleRecurrenceRule } from './scheduleRecurrence.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * What the record's recurrence amounts to, in the editor's own terms.
 *
 * The rule reader is the one the schedule already uses, so the editor and the projections
 * cannot disagree about whether an event recurs. A recurrence the record carries that the
 * reader refuses is reported as unusable rather than being shown as no recurrence at all.
 */
export function eventRecurrenceFor(event: CalendarEvent): EventEditorRecurrence {
  const rule = scheduleRecurrenceRule(event);

  if (rule) {
    return {
      kind: 'series',
      frequency: rule.frequency,
      interval: rule.interval,
      count: rule.count,
      until: rule.until,
    };
  }

  return event.properties.recurrence === undefined
    ? { kind: 'none' }
    : { kind: 'unsupported', detail: 'The stored recurrence could not be read, so no rule is shown.' };
}

/** The pieces of the loaded state this modal needs, which the schedule surfaces carry. */
export function eventEditorInputFor(events: readonly CalendarEvent[], projectNames: Map<string, string>): EventEditorInput {
  const projectChoices: EventEditorOption[] = [...projectNames]
    .map(([id, label]) => ({ id, label }))
    .filter((choice) => choice.id.length > 0);

  return {
    events,
    projectChoices: [...projectChoices, { id: '', label: 'No project' }],
  };
}

/**
 * The fields this form writes.
 *
 * The recurrence controls are editable now that the rule has somewhere to go: `saveEventFormAction` routes a
 * changed rule to `event.recurrence.set` or `event.recurrence.clear`, which are the verbs that write a series,
 * rather than folding it into the field update. The scope statement above them still says that one occurrence
 * is not the series, because editing a rule and editing one occurrence remain different acts.
 */
const EDITABLE_EVENT_FIELDS = new Set([
  'name',
  'description',
  'project',
  'start',
  'end',
  'completion',
  'recurrenceFrequency',
  'recurrenceInterval',
  'recurrenceEndKind',
  'recurrenceUntil',
  'recurrenceCount',
]);

/**
 * One field, as the control that carries it.
 *
 * With a resolved write path the fields this form owns are real controls; without one every control is inert
 * and the typed refusal sits where Save would be.
 */
function renderEventField(field: EventEditorField, writable: boolean): string {
  const key = `schedule-event-${field.id}`;
  const hooks = `data-schedule-event-field="${escapeHtml(field.id)}" data-schedule-event-control="${escapeHtml(field.control)}"`;
  const note = field.note === null ? '' : `<small class="schedule-event-note" data-schedule-event-note="${escapeHtml(field.id)}">${escapeHtml(field.note)}</small>`;
  const editable = writable && EDITABLE_EVENT_FIELDS.has(field.id);

  if (field.control === 'derived') {
    return `<p class="schedule-event-derived" data-c1-key="${escapeHtml(key)}" ${hooks}><strong>${escapeHtml(field.label)}</strong><span>${escapeHtml(field.value)}</span>${note}</p>`;
  }

  if (field.control === 'checkbox') {
    return `<label class="schedule-event-check"><input type="checkbox" data-c1-key="${escapeHtml(key)}" ${hooks}${field.checked ? ' checked' : ''}${editable ? '' : ' disabled'}> ${escapeHtml(field.label)}</label>${note}`;
  }

  if (field.control === 'select') {
    const options = field.options
      .map((option) => `<option value="${escapeHtml(option.id)}"${option.id === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
      .join('');

    return `<label>${escapeHtml(field.label)}<select data-c1-key="${escapeHtml(key)}" ${hooks}${editable ? '' : ' disabled'}>${options}</select></label>${note}`;
  }

  if (field.control === 'textarea') {
    return `<label>${escapeHtml(field.label)}<textarea data-c1-key="${escapeHtml(key)}" ${hooks}${editable ? '' : ' readonly'}>${escapeHtml(field.value)}</textarea></label>${note}`;
  }

  const type = field.control === 'number' ? 'number' : 'text';

  return `<label>${escapeHtml(field.label)}<input type="${type}" data-c1-key="${escapeHtml(key)}" ${hooks} value="${escapeHtml(field.value)}"${editable ? '' : ' readonly'}></label>${note}`;
}

export interface EventModalOptions {
  /** The events this surface can open. */
  events: readonly CalendarEvent[];
  /** The project names this surface knows, which is what its project choices come from. */
  projectNames: Map<string, string>;
  eventId: string | null;
  /** Which action closes the modal, which differs by surface. */
  closeAction: string;
  closeAttribute: 'data-schedule-action' | 'data-schedule-projection-action';
  mode: 'edit' | 'read-only';
  /**
   * The write view, or nothing at all.
   *
   * `refusal === null` is what makes the form real: with a resolved record write path the fields are
   * editable and Save and Delete are controls, and without one every control stays inert with the
   * reason drawn where Save would be.
   */
  writes?: { refusal: string | null; feedback: string | null; feedbackRefusal?: string | null } | null;
  /** The form's provisional values, so a refused save does not empty what was typed (D58). */
  draft?: EventEditorDraft | null;
}

/**
 * The form's values, read from the controls the editor drew.
 *
 * Null when a field the form owns is missing, because a Save that guessed at a value would write a
 * record nobody described.
 */
export function eventFormValuesFrom(root: ParentNode): EventFormValues | null {
  const control = (id: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-schedule-event-field="${id}"]`);
  const name = control('name');
  const description = control('description');
  const project = control('project');
  const start = control('start');
  const end = control('end');
  if (!name || !description || !project || !start || !end) return null;

  const projectId = (project as HTMLInputElement | HTMLSelectElement).value.trim();
  return {
    name: (name as HTMLInputElement).value,
    description: (description as HTMLTextAreaElement).value,
    projectId: projectId === '' ? null : projectId,
    startDate: (start as HTMLInputElement).value,
    deadline: (end as HTMLInputElement).value,
    isCompleted: root.querySelector<HTMLInputElement>('[data-schedule-event-field="completion"]')?.checked ?? false,
    recurrence: recurrenceFromControls(control),
  };
}

/**
 * The recurrence the controls describe.
 *
 * The end-condition select is the first answer, because "does not recur" is one of its values: with `none` the
 * rest of the controls are not read at all, which is what makes turning recurrence off a clear rather than an
 * edit to a rule nobody is looking at any more. What the form does not ask for — a weekly rule's weekday, a
 * monthly rule's day, a yearly rule's month and day — is derived from the event's start by the plan, so this
 * function reports only what a reader can actually see.
 */
function recurrenceFromControls(control: (id: string) => HTMLElement | null): EventFormRecurrence {
  const endKind = (control('recurrenceEndKind') as HTMLSelectElement | null)?.value ?? 'none';
  if (endKind === 'none') return { kind: 'none' };

  const frequency = (control('recurrenceFrequency') as HTMLSelectElement | null)?.value;
  const interval = Number((control('recurrenceInterval') as HTMLInputElement | null)?.value ?? '1');
  const end: EventFormRecurrenceEnd = endKind === 'until'
    ? { kind: 'until', until: (control('recurrenceUntil') as HTMLInputElement | null)?.value ?? '' }
    : endKind === 'count'
      ? { kind: 'count', count: Number((control('recurrenceCount') as HTMLInputElement | null)?.value ?? '1') }
      : { kind: 'never' };

  return {
    kind: 'series',
    frequency: (frequency === 'daily' || frequency === 'weekly' || frequency === 'monthly' || frequency === 'yearly')
      ? frequency
      : 'daily',
    interval: Number.isSafeInteger(interval) && interval > 0 ? interval : 1,
    end,
  };
}

/**
 * The Event modal.
 *
 * Everything it shows comes from `projectEventEditor`. The colour note and the scope statement are
 * shown where the fields are, so a reader learns why there is no colour control and that one
 * occurrence is not the series, rather than inferring both from silence.
 *
 * With a write path resolved it is a form: the six fields it owns are editable, Save submits the
 * difference from the record and Delete removes it, and whatever the sequence answers is drawn here
 * rather than replacing what was typed.
 */
export function renderEventModal(options: EventModalOptions): string {
  if (!options.eventId) return '';

  const event = options.events.find((candidate) => candidate.id === options.eventId);
  if (!event) return '';

  const editor = projectEventEditor(
    eventEditorInputFor(options.events, options.projectNames),
    options.eventId,
    options.draft ?? null,
    eventRecurrenceFor(event),
  );

  if (!editor) return '';

  const writes = options.writes ?? null;
  const writable = writes !== null && writes.refusal === null && options.mode === 'edit';
  const actionAttribute = options.closeAttribute;
  const sections = editor.sections
    .map((section) => `<fieldset class="schedule-event-section" data-c1-key="schedule-event-section-${escapeHtml(section.id)}"><legend>${escapeHtml(section.label)}</legend>${section.fields.map((field) => renderEventField(field, writable)).join('')}</fieldset>`)
    .join('');
  const refusal = writes?.feedback ?? null;
  const footer = writable
    ? `<footer><button type="button" ${actionAttribute}="delete-event" data-c1-key="schedule-event-delete">Delete</button><button type="button" ${actionAttribute}="save-event" data-c1-key="schedule-event-save">Save</button>${refusal === null ? '' : `<small data-c1-key="schedule-event-refusal-note" data-schedule-event-refusal="${escapeHtml(writes?.feedbackRefusal ?? '')}">${escapeHtml(refusal)}</small>`}</footer>`
    : `<footer><button type="button" data-c1-key="schedule-event-delete" data-schedule-event-delete-refusal="${escapeHtml(writes?.refusal ?? EVENT_EDITOR_SAVE_REFUSAL)}" disabled>Delete unavailable</button><button type="button" data-c1-key="schedule-event-save" data-schedule-event-save-refusal="${escapeHtml(writes?.refusal ?? EVENT_EDITOR_SAVE_REFUSAL)}" disabled>Save unavailable</button><small data-c1-key="schedule-event-save-note">${escapeHtml(EVENT_EDITOR_SAVE_NOTE)}</small></footer>`;

  return `<div class="modal-backdrop" data-c1-key="schedule-event-modal-backdrop"><section class="task-modal" role="dialog" aria-modal="true" aria-label="Event editor" data-schedule-editor-mode="${escapeHtml(options.mode)}" data-schedule-event-id="${escapeHtml(editor.eventId)}" data-schedule-event-field-count="${editor.fieldCount}" data-schedule-event-recurrence-kind="${escapeHtml(editor.recurrenceKind)}" data-schedule-event-writes="${writable ? 'available' : 'unavailable'}" data-c1-key="schedule-event-modal"><header class="surface-header"><div><p class="eyebrow">Event editor</p><h3>${escapeHtml(editor.title)}</h3></div><button type="button" class="icon-button" ${options.closeAttribute}="${escapeHtml(options.closeAction)}" data-c1-key="schedule-event-modal-close" aria-label="Close event editor">×</button></header><p class="schedule-event-colour" data-c1-key="schedule-event-colour-note">${escapeHtml(editor.colourNote)}</p>${sections}${footer}</section></div>`;
}
