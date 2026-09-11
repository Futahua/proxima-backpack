import type { LoadProblem } from '../domain/problems.js';
import { eventFormValuesFrom, renderEventModal as renderEventEditorModal } from './eventModal.js';
import { eventsByDay } from '../domain/selectors.js';
import { localDateKey } from '../domain/time.js';
import type { EventEditorDraft } from '../app/eventEditor.js';
import type { EventFormValues } from '../app/eventFormPlan.js';
import type { CalendarEvent } from '../domain/types.js';
import {
  calendarGridDates,
  localCalendarDate,
} from './calendarGrid.js';
import { renderScheduleNavigation } from './scheduleNavigation.js';
import {
  expandScheduleRecurringOccurrences,
  hasScheduleRecurrence,
  renderScheduleRecurrenceScopeModal,
  scheduleRecurringOccurrenceToken,
  type ScheduleRecurrenceScope,
  type ScheduleRecurrenceWindow,
  type ScheduleRecurringOccurrence,
  type ScheduleRecurringOccurrenceSelection,
} from './scheduleRecurrence.js';

export type ScheduleProjectionMode = 'month' | 'year' | 'agenda';

export interface ScheduleDateOccurrence {
  dayKey: string;
  eventId: string;
}

export interface ScheduleProjectionRenderOptions {
  mode: ScheduleProjectionMode;
  events: readonly CalendarEvent[];
  projectNames: Map<string, string>;
  selectionLabel: string;
  calendarCursor: Date;
  now: Date;
  selectedEventId: string | null;
  selectedRecurringOccurrence?: ScheduleRecurringOccurrenceSelection | null;
  selectedRecurringScope?: ScheduleRecurrenceScope | null;
  problems?: LoadProblem[];
  /** What the Event editor draws: the resolved write path, its last answer, and the form's draft. */
  eventEditorWrites?: { refusal: string | null; feedback: string | null; feedbackRefusal?: string | null } | null;
  eventEditorDraft?: EventEditorDraft | null;
  /** What the recurrence scope modal draws: the write path, its last answer, and the dates typed. */
  recurrenceScopeWrites?: { refusal: string | null; feedback: string | null; feedbackRefusal: string | null } | null;
  occurrenceDraft?: { startDate: string; deadline: string } | null;
}

export interface ScheduleProjectionHandlers {
  openEvent(eventId: string): void;
  closeEvent(): void;
  /** The Event editor's Save and Delete, which only run when the editor is a form. */
  saveEvent(intent: { eventId: string; values: EventFormValues }): void;
  deleteEvent(intent: { eventId: string }): void;
  selectMonth(month: string): void;
  drillMonth(month: string): void;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function projectName(
  event: CalendarEvent,
  projectNames: Map<string, string>,
): string {
  if (!event.projectId) return 'Uncategorised';
  return projectNames.get(event.projectId) ?? event.projectId;
}

interface ScheduleProjectedDateOccurrence {
  event: CalendarEvent;
  startDate: string;
  deadline: string;
  recurring: ScheduleRecurringOccurrence | null;
}

function occurrenceOrder(
  left: ScheduleProjectedDateOccurrence,
  right: ScheduleProjectedDateOccurrence,
): number {
  return (
    left.startDate.localeCompare(right.startDate)
    || left.deadline.localeCompare(right.deadline)
    || left.event.id.localeCompare(right.event.id)
  );
}

function projectionRecurrenceWindow(
  mode: ScheduleProjectionMode,
  cursor: Date,
): ScheduleRecurrenceWindow {
  if (mode === 'year') {
    return {
      start: localCalendarDate(cursor.getFullYear(), 0, 1),
      end: localCalendarDate(cursor.getFullYear() + 1, 0, 1),
    };
  }

  if (mode === 'agenda') {
    return {
      start: localCalendarDate(cursor.getFullYear(), cursor.getMonth(), 1),
      end: localCalendarDate(cursor.getFullYear(), cursor.getMonth() + 1, 1),
    };
  }

  const days = calendarGridDates(cursor);
  const first = days[0]!;
  const last = days[days.length - 1]!;

  return {
    start: localCalendarDate(first.getFullYear(), first.getMonth(), first.getDate()),
    end: localCalendarDate(last.getFullYear(), last.getMonth(), last.getDate() + 1),
  };
}

function calendarMonthKey(
  year: number,
  monthIndex: number,
): string {
  return `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-01`;
}

function sortedEventsByDay(
  events: readonly CalendarEvent[],
  problems: LoadProblem[],
  recurrenceWindow?: ScheduleRecurrenceWindow,
): Map<string, ScheduleProjectedDateOccurrence[]> {
  const result = new Map<string, ScheduleProjectedDateOccurrence[]>();
  const ordinaryEvents = recurrenceWindow
    ? events.filter((event) => !hasScheduleRecurrence(event))
    : [...events];
  const ordinary = eventsByDay(ordinaryEvents, problems);

  for (const [key, dayEvents] of ordinary) {
    result.set(key, dayEvents.map((event) => ({
      event,
      startDate: event.startDate,
      deadline: event.deadline,
      recurring: null,
    })));
  }

  if (recurrenceWindow) {
    const recurring = expandScheduleRecurringOccurrences(events, recurrenceWindow);
    for (const occurrence of recurring) {
      const temporalView: CalendarEvent = {
        ...occurrence.event,
        startDate: occurrence.startDate,
        deadline: occurrence.deadline,
      };
      const covered = eventsByDay([temporalView], problems);
      for (const key of covered.keys()) {
        const bucket = result.get(key) ?? [];
        bucket.push({
          event: occurrence.event,
          startDate: occurrence.startDate,
          deadline: occurrence.deadline,
          recurring: occurrence,
        });
        result.set(key, bucket);
      }
    }
  }

  for (const [key, values] of result) {
    result.set(key, values.sort(occurrenceOrder));
  }

  return new Map([...result.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function scheduleDateOccurrenceProjection(
  events: readonly CalendarEvent[],
  problems: LoadProblem[] = [],
  recurrenceWindow?: ScheduleRecurrenceWindow,
): ScheduleDateOccurrence[] {
  const byDay = sortedEventsByDay(events, problems, recurrenceWindow);
  const projection: ScheduleDateOccurrence[] = [];

  for (const [dayKey, dayEvents] of byDay) {
    for (const occurrence of dayEvents) {
      projection.push({
        dayKey,
        eventId: occurrence.event.id,
      });
    }
  }

  return projection;
}

/**
 * The projection surfaces' Event editor.
 *
 * It is the same modal the time grid draws, so a Month or Agenda reader edits the record the same way
 * a Day reader does — the only difference is which action attribute its controls carry. Without a
 * resolved write path it stays the read-only projection it has always been.
 */
function renderProjectionEventModal(
  events: readonly CalendarEvent[],
  eventId: string | null,
  projectNames: Map<string, string>,
  writes: { refusal: string | null; feedback: string | null; feedbackRefusal?: string | null } | null,
  draft: EventEditorDraft | null,
): string {
  return renderEventEditorModal({
    events,
    projectNames,
    eventId,
    closeAction: 'close-event',
    closeAttribute: 'data-schedule-projection-action',
    mode: writes !== null && writes.refusal === null ? 'edit' : 'read-only',
    writes,
    draft,
  });
}

function renderOccurrenceButton(
  occurrence: ScheduleProjectedDateOccurrence,
  dayKey: string,
  mode: 'month' | 'agenda',
  projectNames: Map<string, string>,
): string {
  const event = occurrence.event;
  if (occurrence.recurring) {
    const token = scheduleRecurringOccurrenceToken(occurrence.recurring);
    return `<button type="button" class="event-card schedule-${mode}-event schedule-recurring-occurrence" data-schedule-recurring-action="open-occurrence" data-schedule-recurring-event-id="${escapeHtml(event.id)}" data-schedule-occurrence-start="${escapeHtml(occurrence.startDate)}" data-schedule-occurrence-deadline="${escapeHtml(occurrence.deadline)}" data-schedule-occurrence-date="${escapeHtml(dayKey)}" data-c1-key="schedule-${mode}-recurring-${escapeHtml(event.id)}-${token}-${escapeHtml(dayKey)}" title="${escapeHtml(event.description || event.name)}"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></button>`;
  }

  return `<button type="button" class="event-card schedule-${mode}-event" data-schedule-projection-action="open-event" data-schedule-event-id="${escapeHtml(event.id)}" data-schedule-occurrence-date="${escapeHtml(dayKey)}" data-c1-key="schedule-${mode}-event-${escapeHtml(event.id)}-${escapeHtml(dayKey)}" title="${escapeHtml(event.description || event.name)}"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></button>`;
}

function renderMonth(
  options: ScheduleProjectionRenderOptions,
  byDay: Map<string, ScheduleProjectedDateOccurrence[]>,
): string {
  const days = calendarGridDates(options.calendarCursor);
  const todayKey = localDateKey(options.now);

  const cells = days.map((day) => {
    const key = localDateKey(day);
    const outside = day.getMonth() !== options.calendarCursor.getMonth();
    const dayEvents = byDay.get(key) ?? [];
    const events = dayEvents.map((occurrence) => (
      renderOccurrenceButton(
        occurrence,
        key,
        'month',
        options.projectNames,
      )
    )).join('');

    return `<div class="calendar-day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}" data-schedule-month-day="${escapeHtml(key)}" data-schedule-occurrence-count="${dayEvents.length}" data-c1-key="schedule-month-day-${escapeHtml(key)}" aria-label="${escapeHtml(key)}"${key === todayKey ? ' aria-current="date"' : ''}><span class="day-number">${day.getDate()}</span><div class="day-events">${events}</div></div>`;
  }).join('');

  return `<section class="surface calendar-surface schedule-month-projection" data-schedule-projection-mode="month" data-c1-key="schedule-month-region" aria-label="Month schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Month</h2><p class="surface-description">Date-level event occurrences on local civil days.</p></div>${renderScheduleNavigation(options.calendarCursor, options.mode)}</header><div class="weekday-row" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${cells}</div>${options.selectedRecurringOccurrence ? renderScheduleRecurrenceScopeModal(options.events, options.selectedRecurringOccurrence, options.selectedRecurringScope ?? null, options.projectNames, options.recurrenceScopeWrites ?? null, options.occurrenceDraft ?? null) : renderProjectionEventModal(options.events, options.selectedEventId, options.projectNames, options.eventEditorWrites ?? null, options.eventEditorDraft ?? null)}</section>`;
}

function renderYear(
  options: ScheduleProjectionRenderOptions,
  byDay: Map<string, ScheduleProjectedDateOccurrence[]>,
): string {
  const year = options.calendarCursor.getFullYear();
  const todayKey = localDateKey(options.now);

  const months = Array.from(
    { length: 12 },
    (_, monthIndex) => {
      const first = localCalendarDate(year, monthIndex, 1);
      const monthKey = calendarMonthKey(year, monthIndex);
      const title = first.toLocaleDateString(undefined, {
        month: 'long',
      });
      const cells = calendarGridDates(first).map((day) => {
        if (day.getMonth() !== monthIndex) {
          return '<span class="schedule-year-day outside" aria-hidden="true"></span>';
        }

        const key = localDateKey(day);
        const count = byDay.get(key)?.length ?? 0;
        const indicator = count > 0
          ? `<span class="schedule-year-event-indicator" data-schedule-year-event-indicator="${escapeHtml(key)}" data-schedule-occurrence-count="${count}" aria-label="${count} event occurrence${count === 1 ? '' : 's'}">${count}</span>`
          : '';

        return `<button type="button" class="schedule-year-day${key === todayKey ? ' today' : ''}" data-schedule-projection-action="drill-month" data-schedule-target-date="${escapeHtml(key)}" data-schedule-target-month="${escapeHtml(monthKey)}" data-c1-key="schedule-year-day-${escapeHtml(key)}"${key === todayKey ? ' aria-current="date"' : ''}><span>${day.getDate()}</span>${indicator}</button>`;
      }).join('');

      return `<section class="schedule-year-month" data-schedule-year-month="${escapeHtml(monthKey)}" data-c1-key="schedule-year-month-${escapeHtml(monthKey)}"><header><strong>${escapeHtml(title)}</strong></header><div class="schedule-year-weekdays" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day) => `<span>${day}</span>`).join('')}</div><div class="schedule-year-days">${cells}</div></section>`;
    },
  ).join('');

  return `<section class="surface calendar-surface schedule-year-projection" data-schedule-projection-mode="year" data-c1-key="schedule-year-region" aria-label="Year schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Year</h2><p class="surface-description">Twelve mini-months with date-level event indicators.</p></div>${renderScheduleNavigation(options.calendarCursor, options.mode)}</header><div class="schedule-year-grid">${months}</div>${options.selectedRecurringOccurrence ? renderScheduleRecurrenceScopeModal(options.events, options.selectedRecurringOccurrence, options.selectedRecurringScope ?? null, options.projectNames, options.recurrenceScopeWrites ?? null, options.occurrenceDraft ?? null) : renderProjectionEventModal(options.events, options.selectedEventId, options.projectNames, options.eventEditorWrites ?? null, options.eventEditorDraft ?? null)}</section>`;
}

function renderAgenda(
  options: ScheduleProjectionRenderOptions,
  byDay: Map<string, ScheduleProjectedDateOccurrence[]>,
): string {
  const groups = [...byDay.entries()].map(([dayKey, dayEvents]) => {
    const rows = dayEvents.map((occurrence) => (
      `<div class="schedule-agenda-row" data-schedule-agenda-row="${escapeHtml(occurrence.event.id)}" data-schedule-occurrence-date="${escapeHtml(dayKey)}">${renderOccurrenceButton(occurrence, dayKey, 'agenda', options.projectNames)}<small class="schedule-agenda-time">${escapeHtml(occurrence.startDate)} → ${escapeHtml(occurrence.deadline)}</small></div>`
    )).join('');

    return `<section class="schedule-agenda-date-group" data-schedule-agenda-date="${escapeHtml(dayKey)}" data-c1-key="schedule-agenda-date-${escapeHtml(dayKey)}"><header><h3>${escapeHtml(dayKey)}</h3><span>${dayEvents.length}</span></header>${rows}</section>`;
  }).join('');

  return `<section class="surface calendar-surface schedule-agenda-projection" data-schedule-projection-mode="agenda" data-c1-key="schedule-agenda-region" aria-label="Agenda schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Agenda</h2><p class="surface-description">Chronological local-date groups of event occurrences.</p></div>${renderScheduleNavigation(options.calendarCursor, options.mode)}</header><div class="schedule-agenda-groups">${groups || '<p class="empty-state" data-c1-key="schedule-agenda-empty">No dated events.</p>'}</div>${options.selectedRecurringOccurrence ? renderScheduleRecurrenceScopeModal(options.events, options.selectedRecurringOccurrence, options.selectedRecurringScope ?? null, options.projectNames, options.recurrenceScopeWrites ?? null, options.occurrenceDraft ?? null) : renderProjectionEventModal(options.events, options.selectedEventId, options.projectNames, options.eventEditorWrites ?? null, options.eventEditorDraft ?? null)}</section>`;
}

export function renderScheduleProjection(
  options: ScheduleProjectionRenderOptions,
): string {
  const byDay = sortedEventsByDay(
    options.events,
    options.problems ?? [],
    projectionRecurrenceWindow(options.mode, options.calendarCursor),
  );

  if (options.mode === 'month') {
    return renderMonth(options, byDay);
  }
  if (options.mode === 'year') {
    return renderYear(options, byDay);
  }
  return renderAgenda(options, byDay);
}

export function bindScheduleProjectionInteractions(
  root: HTMLElement,
  handlers: ScheduleProjectionHandlers,
): void {
  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-schedule-projection-action]');
    if (!control || !root.contains(control)) return;

    if (
      control.dataset.scheduleProjectionAction === 'open-event'
    ) {
      const eventId = control.dataset.scheduleEventId;
      if (eventId) handlers.openEvent(eventId);
      return;
    }

    // The Event editor's Save and Delete. The form is read where it is and handed over: the sequence
    // runs in the shell, and what it answers is what the next render draws.
    if (
      control.dataset.scheduleProjectionAction === 'save-event'
    ) {
      const modal = control.closest<HTMLElement>(
        '[data-schedule-editor-mode="edit"]',
      );
      const eventId = modal?.dataset.scheduleEventId;
      const values = modal ? eventFormValuesFrom(modal) : null;
      if (!modal || !eventId || !values) return;
      handlers.saveEvent({ eventId, values });
      return;
    }

    if (
      control.dataset.scheduleProjectionAction === 'delete-event'
    ) {
      const modal = control.closest<HTMLElement>(
        '[data-schedule-editor-mode="edit"]',
      );
      const eventId = modal?.dataset.scheduleEventId;
      if (!eventId) return;
      handlers.deleteEvent({ eventId });
      return;
    }

    if (
      control.dataset.scheduleProjectionAction === 'close-event'
    ) {
      handlers.closeEvent();
      return;
    }

    const month = control.dataset.scheduleTargetMonth;
    if (!month) return;

    if (
      control.dataset.scheduleProjectionAction === 'select-month'
    ) {
      handlers.selectMonth(month);
      return;
    }

    if (
      control.dataset.scheduleProjectionAction === 'drill-month'
    ) {
      handlers.drillMonth(month);
    }
  });
}
