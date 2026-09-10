import type { LoadProblem } from '../domain/problems.js';
import { eventsByDay } from '../domain/selectors.js';
import { localDateKey } from '../domain/time.js';
import type { CalendarEvent } from '../domain/types.js';
import {
  calendarGridDates,
  localCalendarDate,
} from './calendarGrid.js';

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
  problems?: LoadProblem[];
}

export interface ScheduleProjectionHandlers {
  openEvent(eventId: string): void;
  closeEvent(): void;
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

function eventOrder(
  left: CalendarEvent,
  right: CalendarEvent,
): number {
  return (
    left.startDate.localeCompare(right.startDate)
    || left.deadline.localeCompare(right.deadline)
    || left.id.localeCompare(right.id)
  );
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
): Map<string, CalendarEvent[]> {
  const source = eventsByDay([...events], problems);
  const result = new Map<string, CalendarEvent[]>();

  for (const key of [...source.keys()].sort()) {
    result.set(
      key,
      [...(source.get(key) ?? [])].sort(eventOrder),
    );
  }

  return result;
}

export function scheduleDateOccurrenceProjection(
  events: readonly CalendarEvent[],
  problems: LoadProblem[] = [],
): ScheduleDateOccurrence[] {
  const byDay = sortedEventsByDay(events, problems);
  const projection: ScheduleDateOccurrence[] = [];

  for (const [dayKey, dayEvents] of byDay) {
    for (const event of dayEvents) {
      projection.push({
        dayKey,
        eventId: event.id,
      });
    }
  }

  return projection;
}

function renderReadOnlyEventModal(
  events: readonly CalendarEvent[],
  eventId: string | null,
  projectNames: Map<string, string>,
): string {
  if (!eventId) return '';

  const event = events.find((candidate) => candidate.id === eventId);
  if (!event) return '';

  return `<div class="modal-backdrop" data-c1-key="schedule-event-modal-backdrop"><section class="task-modal" role="dialog" aria-modal="true" aria-label="Event editor" data-schedule-editor-mode="read-only" data-c1-key="schedule-event-modal"><header class="surface-header"><div><p class="eyebrow">Event editor</p><h3>${escapeHtml(event.name)}</h3></div><button type="button" class="icon-button" data-schedule-projection-action="close-event" data-c1-key="schedule-event-modal-close" aria-label="Close event editor">×</button></header><label>Name<input data-c1-key="schedule-event-name" value="${escapeHtml(event.name)}" readonly></label><label>Project<input data-c1-key="schedule-event-project" value="${escapeHtml(projectName(event, projectNames))}" readonly></label><label>Start<input data-c1-key="schedule-event-start" value="${escapeHtml(event.startDate)}" readonly></label><label>End<input data-c1-key="schedule-event-end" value="${escapeHtml(event.deadline)}" readonly></label><label>Description<textarea data-c1-key="schedule-event-description" readonly>${escapeHtml(event.description)}</textarea></label></section></div>`;
}

function renderOccurrenceButton(
  event: CalendarEvent,
  dayKey: string,
  mode: 'month' | 'agenda',
  projectNames: Map<string, string>,
): string {
  return `<button type="button" class="event-card schedule-${mode}-event" data-schedule-projection-action="open-event" data-schedule-event-id="${escapeHtml(event.id)}" data-schedule-occurrence-date="${escapeHtml(dayKey)}" data-c1-key="schedule-${mode}-event-${escapeHtml(event.id)}-${escapeHtml(dayKey)}" title="${escapeHtml(event.description || event.name)}"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></button>`;
}

function renderMonth(
  options: ScheduleProjectionRenderOptions,
  byDay: Map<string, CalendarEvent[]>,
): string {
  const days = calendarGridDates(options.calendarCursor);
  const todayKey = localDateKey(options.now);
  const title = options.calendarCursor.toLocaleDateString(
    undefined,
    {
      month: 'long',
      year: 'numeric',
    },
  );

  const cells = days.map((day) => {
    const key = localDateKey(day);
    const outside = day.getMonth() !== options.calendarCursor.getMonth();
    const dayEvents = byDay.get(key) ?? [];
    const events = dayEvents.map((event) => (
      renderOccurrenceButton(
        event,
        key,
        'month',
        options.projectNames,
      )
    )).join('');

    return `<div class="calendar-day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}" data-schedule-month-day="${escapeHtml(key)}" data-schedule-occurrence-count="${dayEvents.length}" data-c1-key="schedule-month-day-${escapeHtml(key)}" aria-label="${escapeHtml(key)}"${key === todayKey ? ' aria-current="date"' : ''}><span class="day-number">${day.getDate()}</span><div class="day-events">${events}</div></div>`;
  }).join('');

  return `<section class="surface calendar-surface schedule-month-projection" data-schedule-projection-mode="month" data-c1-key="schedule-month-region" aria-label="Month schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Month</h2><p class="surface-description">Date-level event occurrences on local civil days.</p></div><div class="calendar-controls"><button type="button" class="icon-button" data-action="calendar-navigate" data-direction="previous" data-c1-key="calendar-previous" aria-label="Previous month">←</button><button type="button" class="icon-button" data-action="calendar-today" data-c1-key="calendar-today">Today</button><strong>${escapeHtml(title)}</strong><button type="button" class="icon-button" data-action="calendar-navigate" data-direction="next" data-c1-key="calendar-next" aria-label="Next month">→</button></div></header><div class="weekday-row" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${cells}</div>${renderReadOnlyEventModal(options.events, options.selectedEventId, options.projectNames)}</section>`;
}

function renderYear(
  options: ScheduleProjectionRenderOptions,
  byDay: Map<string, CalendarEvent[]>,
): string {
  const year = options.calendarCursor.getFullYear();
  const cursorMonth = options.calendarCursor.getMonth();
  const todayKey = localDateKey(options.now);
  const previousTarget = year > 0
    ? calendarMonthKey(year - 1, cursorMonth)
    : null;
  const nextTarget = year < 9999
    ? calendarMonthKey(year + 1, cursorMonth)
    : null;

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

  const previous = previousTarget
    ? `<button type="button" class="icon-button" data-schedule-projection-action="select-month" data-schedule-target-month="${previousTarget}" data-c1-key="schedule-year-previous" aria-label="Previous year">←</button>`
    : '<button type="button" class="icon-button" data-c1-key="schedule-year-previous" aria-label="Previous year" disabled>←</button>';
  const next = nextTarget
    ? `<button type="button" class="icon-button" data-schedule-projection-action="select-month" data-schedule-target-month="${nextTarget}" data-c1-key="schedule-year-next" aria-label="Next year">→</button>`
    : '<button type="button" class="icon-button" data-c1-key="schedule-year-next" aria-label="Next year" disabled>→</button>';

  return `<section class="surface calendar-surface schedule-year-projection" data-schedule-projection-mode="year" data-c1-key="schedule-year-region" aria-label="Year schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Year</h2><p class="surface-description">Twelve mini-months with date-level event indicators.</p></div><div class="calendar-controls">${previous}<strong>${year}</strong>${next}</div></header><div class="schedule-year-grid">${months}</div>${renderReadOnlyEventModal(options.events, options.selectedEventId, options.projectNames)}</section>`;
}

function renderAgenda(
  options: ScheduleProjectionRenderOptions,
  byDay: Map<string, CalendarEvent[]>,
): string {
  const groups = [...byDay.entries()].map(([dayKey, dayEvents]) => {
    const rows = dayEvents.map((event) => (
      `<div class="schedule-agenda-row" data-schedule-agenda-row="${escapeHtml(event.id)}" data-schedule-occurrence-date="${escapeHtml(dayKey)}">${renderOccurrenceButton(event, dayKey, 'agenda', options.projectNames)}<small class="schedule-agenda-time">${escapeHtml(event.startDate)} → ${escapeHtml(event.deadline)}</small></div>`
    )).join('');

    return `<section class="schedule-agenda-date-group" data-schedule-agenda-date="${escapeHtml(dayKey)}" data-c1-key="schedule-agenda-date-${escapeHtml(dayKey)}"><header><h3>${escapeHtml(dayKey)}</h3><span>${dayEvents.length}</span></header>${rows}</section>`;
  }).join('');

  return `<section class="surface calendar-surface schedule-agenda-projection" data-schedule-projection-mode="agenda" data-c1-key="schedule-agenda-region" aria-label="Agenda schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Agenda</h2><p class="surface-description">Chronological local-date groups of event occurrences.</p></div></header><div class="schedule-agenda-groups">${groups || '<p class="empty-state" data-c1-key="schedule-agenda-empty">No dated events.</p>'}</div>${renderReadOnlyEventModal(options.events, options.selectedEventId, options.projectNames)}</section>`;
}

export function renderScheduleProjection(
  options: ScheduleProjectionRenderOptions,
): string {
  const byDay = sortedEventsByDay(
    options.events,
    options.problems ?? [],
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
