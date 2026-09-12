import type { CanonicalRecurrenceException } from '../domain/canonicalRecurrence.js';
import type { CalendarEvent } from '../domain/types.js';
import { localDateKey } from '../domain/time.js';
import { hostZone } from './hostTimeZone.js';
import type { TimeZone } from '../domain/timeZone.js';

/**
 * The zone this module derives civil dates in.
 *
 * Bound once per render call from the options the caller passed, defaulting to the host zone
 * read in exactly one place (`src/browser/hostTimeZone.ts`). Nothing here reads the ambient
 * zone itself, which is what makes the derivation testable by passing a zone.
 */
let activeZone: TimeZone = hostZone();

function bindZone(zone: TimeZone | undefined): void {
  activeZone = zone ?? hostZone();
}

const dateKeyOf = (value: string | number | Date): string => localDateKey(value, activeZone);
const clockTimeOf = (value: string | number | Date): string => formatClockTime(value, activeZone);


export type ScheduleRecurrenceFrequency =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly';

export type ScheduleRecurrenceScope =
  | 'occurrence'
  | 'series';

export interface ScheduleRecurrenceRule {
  frequency: ScheduleRecurrenceFrequency;
  interval: number;
  count: number | null;
  until: string | null;
}

export interface ScheduleRecurrenceWindow {
  start: Date;
  end: Date;
}

export interface ScheduleRecurringOccurrence {
  eventId: string;
  occurrenceKey: string;
  startDate: string;
  deadline: string;
  event: CalendarEvent;
}

export interface ScheduleRecurringOccurrenceSelection {
  eventId: string;
  startDate: string;
  deadline: string;
}

export interface ScheduleRecurrenceInteractionHandlers {
  openOccurrence(
    selection: ScheduleRecurringOccurrenceSelection,
  ): void;
  closeOccurrence(): void;
  selectScope(scope: ScheduleRecurrenceScope): void;
  /** Save the chosen scope: the occurrence it was opened on, or the whole series. */
  saveOccurrence(intent: {
    eventId: string;
    occurrenceStart: string;
    scope: ScheduleRecurrenceScope;
    startDate: string;
    deadline: string;
  }): void;
  /** Skip this occurrence, which is a cancelled exception rather than a deleted record. */
  skipOccurrence(intent: { eventId: string; occurrenceStart: string }): void;
}

export const MAX_SCHEDULE_RECURRENCE_EXPANSION = 10_000;

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

function localDate(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  const result = new Date(0);
  result.setHours(0, 0, 0, 0);
  result.setFullYear(year, monthIndex, day);
  result.setHours(hour, minute, second, millisecond);
  return result;
}

function parseTemporal(value: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const result = localDate(year, month - 1, day);

    return (
      result.getFullYear() === year
      && result.getMonth() === month - 1
      && result.getDate() === day
    )
      ? result : null;
  }

  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

function recurrenceUntilMs(value: string | null): number | null {
  if (value === null) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const date = parseTemporal(value);
    if (!date) return null;
    date.setHours(23, 59, 59, 999);
    return date.getTime();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysInMonth(
  year: number,
  monthIndex: number,
): number {
  return localDate(year, monthIndex + 1, 0).getDate();
}

function civilDayOrdinal(date: Date): number {
  const utc = new Date(0);
  utc.setUTCHours(0, 0, 0, 0);
  utc.setUTCFullYear(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  return Math.floor(utc.getTime() / 86_400_000);
}

function shiftAnchor(
  anchor: Date,
  frequency: ScheduleRecurrenceFrequency,
  amount: number,
): Date | null {
  const hour = anchor.getHours();
  const minute = anchor.getMinutes();
  const second = anchor.getSeconds();
  const millisecond = anchor.getMilliseconds();

  if (frequency === 'daily' || frequency === 'weekly') {
    const days = amount * (frequency === 'weekly' ? 7 : 1);
    return localDate(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + days,
      hour,
      minute,
      second,
      millisecond,
    );
  }

  if (frequency === 'monthly') {
    const absoluteMonth = (
      anchor.getFullYear() * 12
      + anchor.getMonth()
      + amount
    );
    const year = Math.floor(absoluteMonth / 12);
    if (year < 0 || year > 9999) return null;

    const month = absoluteMonth - year * 12;
    return localDate(
      year,
      month,
      Math.min(
        anchor.getDate(),
        daysInMonth(year, month),
      ),
      hour,
      minute,
      second,
      millisecond,
    );
  }

  const year = anchor.getFullYear() + amount;
  if (year < 0 || year > 9999) return null;

  return localDate(
    year,
    anchor.getMonth(),
    Math.min(
      anchor.getDate(),
      daysInMonth(year, anchor.getMonth()),
    ),
    hour,
    minute,
    second,
    millisecond,
  );
}

function distanceInFrequencyUnits(
  anchor: Date,
  target: Date,
  frequency: ScheduleRecurrenceFrequency,
): number {
  if (frequency === 'daily') {
    return civilDayOrdinal(target) - civilDayOrdinal(anchor);
  }
  if (frequency === 'weekly') {
    return (
      civilDayOrdinal(target) - civilDayOrdinal(anchor)
    ) / 7;
  }
  if (frequency === 'monthly') {
    return (
      (target.getFullYear() - anchor.getFullYear()) * 12
      + target.getMonth()
      - anchor.getMonth()
    );
  }
  return target.getFullYear() - anchor.getFullYear();
}

export function scheduleRecurrenceRule(
  event: CalendarEvent,
): ScheduleRecurrenceRule | null {
  const raw = event.properties.recurrence;
  if (!isRecord(raw)) return null;

  const frequency = raw.frequency;
  if (
    frequency !== 'daily'
    && frequency !== 'weekly'
    && frequency !== 'monthly'
    && frequency !== 'yearly'
  ) {
    return null;
  }

  const interval = raw.interval === undefined
    ? 1
    : raw.interval;
  if (
    !Number.isInteger(interval)
    || Number(interval) < 1
    || Number(interval) > 36_600
  ) {
    return null;
  }

  const count = raw.count === undefined
    ? null
    : raw.count;
  if (
    count !== null
    && (
      !Number.isInteger(count)
      || Number(count) < 1
      || Number(count) > 1_000_000
    )
  ) {
    return null;
  }

  const until = raw.until === undefined
    ? null
    : raw.until;
  if (
    until !== null
    && (
      typeof until !== 'string'
      || recurrenceUntilMs(until) === null
    )
  ) {
    return null;
  }

  return {
    frequency,
    interval: Number(interval),
    count: count === null ? null : Number(count),
    until,
  };
}

export function hasScheduleRecurrence(
  event: CalendarEvent,
): boolean {
  return scheduleRecurrenceRule(event) !== null;
}

export function expandScheduleRecurringOccurrences(
  events: readonly CalendarEvent[],
  window: ScheduleRecurrenceWindow,
): ScheduleRecurringOccurrence[] {
  const rangeStart = window.start.getTime();
  const rangeEnd = window.end.getTime();

  if (
    !Number.isFinite(rangeStart)
    || !Number.isFinite(rangeEnd)
    || rangeEnd <= rangeStart
  ) {
    return [];
  }

  const result: ScheduleRecurringOccurrence[] = [];

  for (const event of events) {
    const rule = scheduleRecurrenceRule(event);
    if (!rule) continue;

    const startAnchor = parseTemporal(event.startDate);
    const deadlineAnchor = parseTemporal(event.deadline);
    if (
      !startAnchor
      || !deadlineAnchor
      || deadlineAnchor.getTime() <= startAnchor.getTime()
    ) {
      continue;
    }

    const estimated = Math.floor(
      distanceInFrequencyUnits(
        deadlineAnchor,
        window.start,
        rule.frequency,
      ) / rule.interval,
    );
    let sequence = Math.max(0, estimated - 1);
    let examined = 0;
    const untilMs = recurrenceUntilMs(rule.until);

    while (true) {
      if (
        rule.count !== null
        && sequence >= rule.count
      ) {
        break;
      }
      if (examined >= MAX_SCHEDULE_RECURRENCE_EXPANSION) {
        throw new RangeError(
          `schedule recurrence expansion exceeded ${MAX_SCHEDULE_RECURRENCE_EXPANSION} occurrences for ${event.id}`,
        );
      }
      examined += 1;

      const amount = sequence * rule.interval;
      const occurrenceStart = shiftAnchor(
        startAnchor,
        rule.frequency,
        amount,
      );
      const occurrenceDeadline = shiftAnchor(
        deadlineAnchor,
        rule.frequency,
        amount,
      );

      if (!occurrenceStart || !occurrenceDeadline) break;

      const startMs = occurrenceStart.getTime();
      const deadlineMs = occurrenceDeadline.getTime();

      if (untilMs !== null && startMs > untilMs) break;
      if (startMs >= rangeEnd) break;

      const scheduledStart = occurrenceStart.toISOString();
      const exception = recurrenceExceptionFor(event, scheduledStart);

      // A cancelled occurrence is a hole in the series, and a detached one is its own record by now:
      // neither is drawn here. A rescheduled occurrence is drawn where the record says it went, while
      // its identity stays the slot the rule generated.
      if (exception === null || exception.state === 'rescheduled') {
        const startDate = exception === null ? scheduledStart : exception.startDate;
        const deadline = exception === null ? occurrenceDeadline.toISOString() : exception.deadline;
        const startMsDrawn = Date.parse(startDate);
        const deadlineMsDrawn = Date.parse(deadline);

        if (
          deadlineMsDrawn > rangeStart
          && startMsDrawn < rangeEnd
          && deadlineMsDrawn > startMsDrawn
        ) {
          result.push({
            eventId: event.id,
            occurrenceKey: `${event.id}@${scheduledStart}`,
            startDate,
            deadline,
            event,
          });
        }
      }

      sequence += 1;
    }
  }

  return result.sort(
    (left, right) => (
      left.startDate.localeCompare(right.startDate)
      || left.deadline.localeCompare(right.deadline)
      || left.eventId.localeCompare(right.eventId)
    ),
  );
}

/**
 * The exception a series carries for one scheduled occurrence, if any.
 *
 * The key is the occurrence's **scheduled** start — what the rule generated — not where the reader
 * moved it to. That is what makes an exception an override of a rule slot rather than a new event,
 * and it is what keeps a rescheduled occurrence recognisable after it has moved.
 */
function recurrenceExceptionFor(
  event: CalendarEvent,
  scheduledStart: string,
): CanonicalRecurrenceException | null {
  const raw = event.properties.recurrenceSeries;
  if (!isRecord(raw) || !Array.isArray(raw.exceptions)) return null;
  for (const candidate of raw.exceptions) {
    if (!isRecord(candidate) || !isRecord(candidate.occurrence)) continue;
    if (candidate.occurrence.scheduledStart !== scheduledStart) continue;
    const state = candidate.state;
    if (state === 'cancelled' || state === 'detached') return candidate as unknown as CanonicalRecurrenceException;
    if (state === 'rescheduled' && typeof candidate.startDate === 'string' && typeof candidate.deadline === 'string') {
      return candidate as unknown as CanonicalRecurrenceException;
    }
    return null;
  }
  return null;
}
export function scheduleRecurringOccurrenceToken(
  occurrence: Pick<ScheduleRecurringOccurrence, 'startDate'>,
): string {
  return occurrence.startDate.replace(/[^0-9A-Za-z]/g, '');
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderScheduleRecurrenceScopeModal(
  events: readonly CalendarEvent[],
  selection: ScheduleRecurringOccurrenceSelection | null,
  selectedScope: ScheduleRecurrenceScope | null,
  projectNames: Map<string, string>,
  writes: { refusal: string | null; feedback: string | null; feedbackRefusal: string | null } | null = null,
  draft: { startDate: string; deadline: string } | null = null,
): string {
  if (!selection) return '';

  const event = events.find(
    (candidate) => candidate.id === selection.eventId,
  );
  if (!event) return '';

  const projectLabel = event.projectId === null
    ? 'Uncategorised'
    : projectNames.get(event.projectId) ?? event.projectId;

  const writable = writes !== null && writes.refusal === null;
  const start = draft?.startDate ?? selection.startDate;
  const deadline = draft?.deadline ?? selection.deadline;
  const editable = writable ? '' : ' readonly';
  // The dates are the edit; the scope says which write carries it. Without a write path every control
  // is inert and the typed reason sits where Save would be, which is what the audit reads.
  const footer = writable
    ? `<div class="calendar-controls"><button type="button" data-schedule-recurring-action="skip-occurrence" data-papers-visual-key="schedule-recurrence-scope-skip">Skip this occurrence</button><button type="button" data-schedule-recurring-action="save-occurrence" data-papers-visual-key="schedule-recurrence-scope-save"${selectedScope === null ? ' disabled aria-disabled="true"' : ''}>Save</button></div>${writes?.feedback === null ? '' : `<small data-papers-visual-key="schedule-recurrence-scope-feedback" data-schedule-recurrence-refusal="${escapeHtml(writes?.feedbackRefusal ?? '')}">${escapeHtml(writes?.feedback ?? '')}</small>`}`
    : `<div class="calendar-controls"><button type="button" data-papers-visual-key="schedule-recurrence-scope-save" data-schedule-recurrence-save-refusal="${escapeHtml(writes?.refusal ?? 'Unavailable until record-store cutover')}" disabled>Save unavailable</button></div>`;

  return `<div class="modal-backdrop" data-papers-visual-key="schedule-recurrence-scope-backdrop"><section class="task-modal" role="dialog" aria-modal="true" aria-label="Recurring event scope" data-schedule-editor-mode="recurrence-scope" data-schedule-recurring-event-id="${escapeHtml(event.id)}" data-schedule-selected-scope="${escapeHtml(selectedScope ?? '')}" data-schedule-occurrence-start="${escapeHtml(selection.startDate)}" data-schedule-recurrence-writes="${writable ? 'available' : 'unavailable'}" data-papers-visual-key="schedule-recurrence-scope-modal"><header class="surface-header"><div><p class="eyebrow">Recurring event</p><h3>${escapeHtml(event.name)}</h3></div><button type="button" class="icon-button" data-schedule-recurring-action="close-occurrence" data-papers-visual-key="schedule-recurrence-scope-close" aria-label="Close recurrence scope">×</button></header><p>Choose the scope for a later edit.</p><div class="calendar-controls"><button type="button" data-schedule-recurring-action="select-scope" data-schedule-recurrence-scope="occurrence" data-papers-visual-key="schedule-recurrence-scope-occurrence" aria-pressed="${selectedScope === 'occurrence'}">This occurrence</button><button type="button" data-schedule-recurring-action="select-scope" data-schedule-recurrence-scope="series" data-papers-visual-key="schedule-recurrence-scope-series" aria-pressed="${selectedScope === 'series'}">Entire series</button></div><label>Project<input value="${escapeHtml(projectLabel)}" readonly></label><label>Occurrence start<input data-papers-visual-key="schedule-recurrence-occurrence-start" value="${escapeHtml(start)}"${editable}></label><label>Occurrence end<input data-papers-visual-key="schedule-recurrence-occurrence-end" value="${escapeHtml(deadline)}"${editable}></label><label>Description<textarea readonly>${escapeHtml(event.description)}</textarea></label>${footer}</section></div>`;
}

export function bindScheduleRecurrenceInteractions(
  root: HTMLElement,
  handlers: ScheduleRecurrenceInteractionHandlers,
): void {
  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-schedule-recurring-action]');
    if (!control || !root.contains(control)) return;

    if (
      control.dataset.scheduleRecurringAction === 'open-occurrence'
    ) {
      const eventId = control.dataset.scheduleRecurringEventId;
      const startDate = control.dataset.scheduleOccurrenceStart;
      const deadline = control.dataset.scheduleOccurrenceDeadline;

      if (
        !eventId
        || !startDate
        || !deadline
        || !Number.isFinite(Date.parse(startDate))
        || !Number.isFinite(Date.parse(deadline))
        || Date.parse(deadline) <= Date.parse(startDate)
      ) {
        return;
      }

      handlers.openOccurrence({
        eventId,
        startDate,
        deadline,
      });
      return;
    }

    if (
      control.dataset.scheduleRecurringAction === 'close-occurrence'
    ) {
      handlers.closeOccurrence();
      return;
    }

    if (
      control.dataset.scheduleRecurringAction === 'select-scope'
    ) {
      const scope = control.dataset.scheduleRecurrenceScope;
      if (scope === 'occurrence' || scope === 'series') {
        handlers.selectScope(scope);
      }
      return;
    }

    // The two writes the scope selects. The dates are read where they are, and the scope is the one
    // the reader chose — never inferred from which button was pressed.
    if (
      control.dataset.scheduleRecurringAction === 'save-occurrence'
    ) {
      const modal = control.closest<HTMLElement>(
        '[data-schedule-editor-mode="recurrence-scope"]',
      );
      const eventId = modal?.dataset.scheduleRecurringEventId;
      const occurrenceStart = modal?.dataset.scheduleOccurrenceStart;
      const scope = modal?.dataset.scheduleSelectedScope;
      const start = modal?.querySelector<HTMLInputElement>(
        '[data-papers-visual-key="schedule-recurrence-occurrence-start"]',
      );
      const end = modal?.querySelector<HTMLInputElement>(
        '[data-papers-visual-key="schedule-recurrence-occurrence-end"]',
      );

      if (
        !modal
        || !eventId
        || !occurrenceStart
        || (scope !== 'occurrence' && scope !== 'series')
        || !start
        || !end
      ) {
        return;
      }

      handlers.saveOccurrence({
        eventId,
        occurrenceStart,
        scope,
        startDate: start.value,
        deadline: end.value,
      });
      return;
    }

    if (
      control.dataset.scheduleRecurringAction === 'skip-occurrence'
    ) {
      const modal = control.closest<HTMLElement>(
        '[data-schedule-editor-mode="recurrence-scope"]',
      );
      const eventId = modal?.dataset.scheduleRecurringEventId;
      const occurrenceStart = modal?.dataset.scheduleOccurrenceStart;
      if (!eventId || !occurrenceStart) return;
      handlers.skipOccurrence({ eventId, occurrenceStart });
    }
  });
}
