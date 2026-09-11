import type { CalendarEvent } from '../domain/types.js';
import {
  EVENT_EDITOR_SAVE_NOTE,
  EVENT_EDITOR_SAVE_REFUSAL,
  projectEventEditor,
  type EventEditorField,
  type EventEditorInput,
  type EventEditorOption,
  type EventEditorRecurrence,
} from '../app/eventEditor.js';
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
 * One field, drawn as the control that would carry it.
 *
 * Every control is inert: the record store cannot commit yet, so the modal shows what
 * each field holds and carries the typed refusal where Save would be. A checkbox shows
 * its state, a select shows the chosen option — which is what makes "representable" true
 * of the modal rather than only of the projection behind it.
 */
function renderEventField(field: EventEditorField): string {
  const key = `schedule-event-${field.id}`;
  const hooks = `data-schedule-event-field="${escapeHtml(field.id)}" data-schedule-event-control="${escapeHtml(field.control)}"`;
  const note = field.note === null ? '' : `<small class="schedule-event-note" data-schedule-event-note="${escapeHtml(field.id)}">${escapeHtml(field.note)}</small>`;

  if (field.control === 'derived') {
    return `<p class="schedule-event-derived" data-c1-key="${escapeHtml(key)}" ${hooks}><strong>${escapeHtml(field.label)}</strong><span>${escapeHtml(field.value)}</span>${note}</p>`;
  }

  if (field.control === 'checkbox') {
    return `<label class="schedule-event-check"><input type="checkbox" data-c1-key="${escapeHtml(key)}" ${hooks}${field.checked ? ' checked' : ''} disabled> ${escapeHtml(field.label)}</label>${note}`;
  }

  if (field.control === 'select') {
    const options = field.options
      .map((option) => `<option value="${escapeHtml(option.id)}"${option.id === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
      .join('');

    return `<label>${escapeHtml(field.label)}<select data-c1-key="${escapeHtml(key)}" ${hooks} disabled>${options}</select></label>${note}`;
  }

  if (field.control === 'textarea') {
    return `<label>${escapeHtml(field.label)}<textarea data-c1-key="${escapeHtml(key)}" ${hooks} readonly>${escapeHtml(field.value)}</textarea></label>${note}`;
  }

  const type = field.control === 'number' ? 'number' : 'text';

  return `<label>${escapeHtml(field.label)}<input type="${type}" data-c1-key="${escapeHtml(key)}" ${hooks} value="${escapeHtml(field.value)}" readonly></label>${note}`;
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
}

/**
 * The Event modal.
 *
 * Everything it shows comes from `projectEventEditor`. The colour note and the scope
 * statement are shown where the fields are, so a reader learns why there is no colour
 * control and that one occurrence is not the series, rather than inferring both from
 * silence.
 */
export function renderEventModal(options: EventModalOptions): string {
  if (!options.eventId) return '';

  const event = options.events.find((candidate) => candidate.id === options.eventId);
  if (!event) return '';

  const editor = projectEventEditor(
    eventEditorInputFor(options.events, options.projectNames),
    options.eventId,
    null,
    eventRecurrenceFor(event),
  );

  if (!editor) return '';

  const sections = editor.sections
    .map((section) => `<fieldset class="schedule-event-section" data-c1-key="schedule-event-section-${escapeHtml(section.id)}"><legend>${escapeHtml(section.label)}</legend>${section.fields.map(renderEventField).join('')}</fieldset>`)
    .join('');

  return `<div class="modal-backdrop" data-c1-key="schedule-event-modal-backdrop"><section class="task-modal" role="dialog" aria-modal="true" aria-label="Event editor" data-schedule-editor-mode="${escapeHtml(options.mode)}" data-schedule-event-id="${escapeHtml(editor.eventId)}" data-schedule-event-field-count="${editor.fieldCount}" data-schedule-event-recurrence-kind="${escapeHtml(editor.recurrenceKind)}" data-c1-key="schedule-event-modal"><header class="surface-header"><div><p class="eyebrow">Event editor</p><h3>${escapeHtml(editor.title)}</h3></div><button type="button" class="icon-button" ${options.closeAttribute}="${escapeHtml(options.closeAction)}" data-c1-key="schedule-event-modal-close" aria-label="Close event editor">×</button></header><p class="schedule-event-colour" data-c1-key="schedule-event-colour-note">${escapeHtml(editor.colourNote)}</p>${sections}<footer><button type="button" data-c1-key="schedule-event-delete" disabled>Delete unavailable</button><button type="button" data-c1-key="schedule-event-save" data-schedule-event-save-refusal="${escapeHtml(EVENT_EDITOR_SAVE_REFUSAL)}" disabled>Save unavailable</button><small data-c1-key="schedule-event-save-note">${escapeHtml(EVENT_EDITOR_SAVE_NOTE)}</small></footer></section></div>`;
}
