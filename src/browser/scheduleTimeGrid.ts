import type {
  ActionResult,
  ScheduleChangeOperation,
} from '../app/actionProtocol.js';
import { eventFormValuesFrom, renderEventModal as renderEventEditorModal } from './eventModal.js';
import type { EventEditorDraft } from '../app/eventEditor.js';
import type { EventFormValues } from '../app/eventFormPlan.js';
import type { CalendarEvent } from '../domain/types.js';
import { formatClockTime, localDateKey } from '../domain/time.js';
import { localCalendarDate } from './calendarGrid.js';
import { renderScheduleNavigation } from './scheduleNavigation.js';
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

import {
  expandScheduleRecurringOccurrences,
  hasScheduleRecurrence,
  renderScheduleRecurrenceScopeModal,
  scheduleRecurringOccurrenceToken,
  type ScheduleRecurrenceScope,
  type ScheduleRecurringOccurrence,
  type ScheduleRecurringOccurrenceSelection,
} from './scheduleRecurrence.js';

export type ScheduleTimeGridMode = 'day' | 'four-day' | 'week';

export interface ScheduleTimedSegment {
  eventId: string;
  dayKey: string;
  startMinute: number;
  endMinute: number;
}

export interface ScheduleAllDayPlacement {
  eventId: string;
  startColumn: number;
  spanColumns: number;
}

interface ScheduleTemporalEvent {
  id: string;
  startDate: string;
  deadline: string;
}

export interface ScheduleEventDraft {
  name: string;
  projectId: string | null;
  description: string;
  startDate: string;
  deadline: string;
}

export interface ScheduleTimeGridRenderOptions {
  mode: ScheduleTimeGridMode;
  events: CalendarEvent[];
  projectNames: Map<string, string>;
  selectionLabel: string;
  calendarCursor: Date;
  now: Date;

  /** The zone dates are derived in. Absent means the host zone. */

  zone?: TimeZone;
  selectedEventId: string | null;
  seededEvent?: ScheduleEventDraft | null;
  selectedRecurringOccurrence?: ScheduleRecurringOccurrenceSelection | null;
  selectedRecurringScope?: ScheduleRecurrenceScope | null;
  /** The last refused write on this surface, drawn on the block it was about. */
  writeRefusal?: { eventId: string; code: string } | null;
  /** The last accepted write's sentence, drawn at the surface level. */
  writeFeedback?: string | null;
  /** What the seeded form's last save answered, drawn on the form. */
  seedRefusal?: string | null;
  /**
   * What the Event editor draws: the resolved write path, its last answer, and the form's draft.
   * `refusal === null` is what makes the editor a form rather than a projection.
   */
  eventEditorWrites?: { refusal: string | null; feedback: string | null; feedbackRefusal?: string | null } | null;
  eventEditorDraft?: EventEditorDraft | null;
  /** What the recurrence scope modal draws: the write path, its last answer, and the dates typed. */
  recurrenceScopeWrites?: { refusal: string | null; feedback: string | null; feedbackRefusal: string | null } | null;
  occurrenceDraft?: { startDate: string; deadline: string } | null;
}
export interface ScheduleEventChangeIntent {
  eventId: string;
  operation: ScheduleChangeOperation;
  proposedStartDate: string;
  proposedDeadline: string;
}
export interface ScheduleEventCreateIntent extends ScheduleEventDraft {}

export interface ScheduleTimeGridHandlers {
  openEvent(eventId: string): void;
  closeEvent(): void;
  seedEvent(draft: ScheduleEventDraft): void;
  createEvent(intent: ScheduleEventCreateIntent): void;
  changeEvent(intent: ScheduleEventChangeIntent): void;
  /** The Event editor's Save and Delete, which only run when the editor is a form. */
  saveEvent(intent: { eventId: string; values: EventFormValues }): void;
  deleteEvent(intent: { eventId: string }): void;
}

const MINUTES_PER_DAY = 1_440;
const SLOTS_PER_DAY = 96;
const SLOT_MINUTES = 15;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function dayCountForMode(mode: ScheduleTimeGridMode): number {
  if (mode === 'day') return 1;
  if (mode === 'four-day') return 4;
  return 7;
}

function modeTitle(mode: ScheduleTimeGridMode): string {
  if (mode === 'day') return 'Day';
  if (mode === 'four-day') return '4-Day';
  return 'Week';
}

function minuteOfDay(date: Date): number {
  return (
    date.getHours() * 60
    + date.getMinutes()
    + date.getSeconds() / 60
    + date.getMilliseconds() / 60_000
  );
}

function localMidnight(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
}

function nextLocalMidnight(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  );
}

function scheduleDayFromKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = localCalendarDate(year, month - 1, day);

  return dateKeyOf(date) === value ? date : null;
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

function civilMinuteDistance(start: Date, end: Date): number {
  return (
    (civilDayOrdinal(end) - civilDayOrdinal(start)) * MINUTES_PER_DAY
    + minuteOfDay(end)
    - minuteOfDay(start)
  );
}

function scheduleDateAtMinute(day: Date, minute: number): Date {
  const value = localMidnight(day);
  value.setMinutes(minute, 0, 0);
  return value;
}

function snapScheduleMinutes(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;

  return (
    Math.sign(value)
    * Math.floor((Math.abs(value) / SLOT_MINUTES) + 0.5)
    * SLOT_MINUTES
  );
}

function isLocalMidnight(date: Date): boolean {
  return (
    date.getHours() === 0
    && date.getMinutes() === 0
    && date.getSeconds() === 0
    && date.getMilliseconds() === 0
  );
}

export function scheduleVisibleDays(
  cursor: Date,
  mode: ScheduleTimeGridMode,
): Date[] {
  const count = dayCountForMode(mode);
  const days: Date[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    days.push(new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + offset,
    ));
  }

  return days;
}

export function isAllDayScheduleEvent(
  event: Pick<ScheduleTemporalEvent, 'startDate' | 'deadline'>,
): boolean {
  const start = new Date(event.startDate);
  const end = new Date(event.deadline);

  return (
    Number.isFinite(start.getTime())
    && Number.isFinite(end.getTime())
    && end.getTime() > start.getTime()
    && isLocalMidnight(start)
    && isLocalMidnight(end)
  );
}

export function scheduleTimedProjection(
  events: readonly ScheduleTemporalEvent[],
  visibleDays: readonly Date[],
): ScheduleTimedSegment[] {
  const segments: ScheduleTimedSegment[] = [];

  for (const event of events) {
    if (isAllDayScheduleEvent(event)) continue;

    const start = new Date(event.startDate);
    const end = new Date(event.deadline);
    const startMs = start.getTime();
    const endMs = end.getTime();

    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || endMs <= startMs
    ) {
      continue;
    }

    for (const day of visibleDays) {
      const dayStart = localMidnight(day);
      const dayEnd = nextLocalMidnight(day);
      const dayStartMs = dayStart.getTime();
      const dayEndMs = dayEnd.getTime();

      if (endMs <= dayStartMs || startMs >= dayEndMs) continue;

      const segmentStartMs = Math.max(startMs, dayStartMs);
      const segmentEndMs = Math.min(endMs, dayEndMs);

      const startMinute = segmentStartMs <= dayStartMs
        ? 0
        : minuteOfDay(new Date(segmentStartMs));
      const endMinute = segmentEndMs >= dayEndMs
        ? MINUTES_PER_DAY
        : minuteOfDay(new Date(segmentEndMs));

      if (endMinute <= startMinute) continue;

      segments.push({
        eventId: event.id,
        dayKey: dateKeyOf(day),
        startMinute,
        endMinute,
      });
    }
  }

  return segments.sort(
    (left, right) =>
      left.dayKey.localeCompare(right.dayKey)
      || left.startMinute - right.startMinute
      || left.eventId.localeCompare(right.eventId),
  );
}

export function scheduleAllDayProjection(
  events: readonly ScheduleTemporalEvent[],
  visibleDays: readonly Date[],
): ScheduleAllDayPlacement[] {
  const placements: ScheduleAllDayPlacement[] = [];

  for (const event of events) {
    if (!isAllDayScheduleEvent(event)) continue;

    const startMs = Date.parse(event.startDate);
    const endMs = Date.parse(event.deadline);
    const occupiedColumns: number[] = [];

    visibleDays.forEach((day, index) => {
      const dayStartMs = localMidnight(day).getTime();
      const dayEndMs = nextLocalMidnight(day).getTime();

      if (startMs < dayEndMs && endMs > dayStartMs) {
        occupiedColumns.push(index);
      }
    });

    if (occupiedColumns.length === 0) continue;

    const firstColumn = occupiedColumns[0]!;
    const lastColumn = occupiedColumns[occupiedColumns.length - 1]!;

    placements.push({
      eventId: event.id,
      startColumn: firstColumn + 1,
      spanColumns: lastColumn - firstColumn + 1,
    });
  }

  return placements.sort(
    (left, right) =>
      left.startColumn - right.startColumn
      || left.eventId.localeCompare(right.eventId),
  );
}

function projectName(
  event: CalendarEvent,
  projectNames: Map<string, string>,
): string {
  if (!event.projectId) return 'Uncategorised';
  return projectNames.get(event.projectId) ?? event.projectId;
}

function renderEventModal(
  events: readonly CalendarEvent[],
  eventId: string | null,
  seededEvent: ScheduleEventDraft | null,
  projectNames: Map<string, string>,
  seedRefusal: string | null,
  writes: { refusal: string | null; feedback: string | null } | null,
  draft: EventEditorDraft | null,
): string {
  if (seededEvent) {
    const projectLabel = seededEvent.projectId === null
      ? 'Uncategorised'
      : projectNames.get(seededEvent.projectId) ?? seededEvent.projectId;

    return `<div class="modal-backdrop" data-papers-visual-key="schedule-event-modal-backdrop"><section class="task-modal" role="dialog" aria-modal="true" aria-label="Event editor" data-schedule-editor-mode="create" data-schedule-draft-project-id="${escapeHtml(seededEvent.projectId ?? '')}"${seedRefusal === null ? '' : ` data-schedule-refusal="${escapeHtml(seedRefusal)}"`} data-papers-visual-key="schedule-event-modal"><header class="surface-header"><div><p class="eyebrow">Event editor</p><h3>New event</h3></div><button type="button" class="icon-button" data-schedule-action="close-event" data-papers-visual-key="schedule-event-modal-close" aria-label="Close event editor">×</button></header><label>Name<input data-papers-visual-key="schedule-event-name" value="${escapeHtml(seededEvent.name)}"></label><label>Project<input data-papers-visual-key="schedule-event-project" value="${escapeHtml(projectLabel)}" readonly></label><label>Start<input data-papers-visual-key="schedule-event-start" value="${escapeHtml(seededEvent.startDate)}" readonly></label><label>End<input data-papers-visual-key="schedule-event-end" value="${escapeHtml(seededEvent.deadline)}" readonly></label><label>Description<textarea data-papers-visual-key="schedule-event-description">${escapeHtml(seededEvent.description)}</textarea></label>${seedRefusal === null ? '' : `<small data-schedule-seed-feedback="${escapeHtml(seedRefusal)}">${escapeHtml(seedRefusal)}</small>`}<button type="button" data-schedule-action="save-seeded-event" data-papers-visual-key="schedule-event-save">Save</button></section></div>`;
  }
  return renderEventEditorModal({ events, projectNames, eventId, closeAction: 'close-event', closeAttribute: 'data-schedule-action', mode: 'edit', writes, draft });
}

function renderAllDayRegion(
  events: readonly CalendarEvent[],
  recurringOccurrences: readonly ScheduleRecurringOccurrence[],
  visibleDays: readonly Date[],
  projectNames: Map<string, string>,
): string {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const recurringByKey = new Map(
    recurringOccurrences.map((occurrence) => [occurrence.occurrenceKey, occurrence]),
  );
  const temporalEvents: ScheduleTemporalEvent[] = [
    ...events,
    ...recurringOccurrences.map((occurrence) => ({
      id: occurrence.occurrenceKey,
      startDate: occurrence.startDate,
      deadline: occurrence.deadline,
    })),
  ];
  const placements = scheduleAllDayProjection(temporalEvents, visibleDays);

  const items = placements.map((placement) => {
    const recurring = recurringByKey.get(placement.eventId);
    if (recurring) {
      const event = recurring.event;
      const token = scheduleRecurringOccurrenceToken(recurring);
      return `<article class="event-card schedule-all-day-event schedule-recurring-occurrence" role="button" tabindex="0" data-schedule-recurring-action="open-occurrence" data-schedule-recurring-event-id="${escapeHtml(event.id)}" data-schedule-occurrence-start="${escapeHtml(recurring.startDate)}" data-schedule-occurrence-deadline="${escapeHtml(recurring.deadline)}" data-schedule-all-day-start-column="${placement.startColumn}" data-schedule-all-day-span-columns="${placement.spanColumns}" data-papers-visual-key="schedule-all-day-recurring-${escapeHtml(event.id)}-${token}" style="grid-column:${placement.startColumn + 1} / span ${placement.spanColumns};"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></article>`;
    }

    const event = eventsById.get(placement.eventId);
    if (!event) return '';

    return `<article class="event-card schedule-all-day-event" role="button" tabindex="0" data-schedule-action="open-event" data-schedule-event-id="${escapeHtml(event.id)}" data-schedule-all-day-start-column="${placement.startColumn}" data-schedule-all-day-span-columns="${placement.spanColumns}" data-papers-visual-key="schedule-all-day-event-${escapeHtml(event.id)}" style="grid-column:${placement.startColumn + 1} / span ${placement.spanColumns};"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></article>`;
  }).join('');

  return `<section class="schedule-all-day-region" data-papers-visual-key="schedule-all-day-region" aria-label="All-day events"><div class="schedule-all-day-grid" style="display:grid;grid-template-columns:64px repeat(${visibleDays.length},minmax(0,1fr));gap:2px;"><strong style="grid-column:1;">All day</strong>${items}</div></section>`;
}

function renderTimedDay(
  day: Date,
  segments: readonly ScheduleTimedSegment[],
  eventsById: Map<string, CalendarEvent>,
  recurringByKey: Map<string, ScheduleRecurringOccurrence>,
  projectNames: Map<string, string>,
  now: Date,
  writeRefusal: { eventId: string; code: string } | null,
): string {
  const dayKey = dateKeyOf(day);
  const daySegments = segments.filter((segment) => segment.dayKey === dayKey);
  const nowKey = dateKeyOf(now);
  const currentMinute = minuteOfDay(now);
  const currentTime = nowKey === dayKey
    ? `<div class="schedule-current-time-indicator" data-current-minute="${currentMinute}" data-papers-visual-key="schedule-current-time-${escapeHtml(dayKey)}" style="position:absolute;left:0;right:0;top:${(currentMinute / MINUTES_PER_DAY) * 100}%;border-top:2px solid currentColor;z-index:3;"></div>`
    : '';

  const slots = Array.from(
    { length: SLOTS_PER_DAY },
    (_, slotIndex) => {
      const startMinute = slotIndex * SLOT_MINUTES;
      const hour = Math.floor(startMinute / 60);
      const minute = startMinute % 60;
      const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      return `<div class="schedule-time-slot" role="button" tabindex="0" data-schedule-action="seed-event" data-schedule-day-key="${escapeHtml(dayKey)}" data-schedule-slot="${slotIndex}" data-papers-visual-key="schedule-slot-${escapeHtml(dayKey)}-${slotIndex}" aria-label="Create event at ${escapeHtml(dayKey)} ${timeLabel}" style="height:8px;border-top:1px solid currentColor;opacity:0.12;cursor:pointer;"></div>`;
    },
  ).join('');

  const eventCards = daySegments.map((segment) => {
    const durationMinutes = segment.endMinute - segment.startMinute;

    const recurring = recurringByKey.get(segment.eventId);
    if (recurring) {
      const event = recurring.event;
      const token = scheduleRecurringOccurrenceToken(recurring);
      return `<article class="event-card schedule-timed-event schedule-recurring-occurrence${event.isCompleted ? ' completed' : ''}" role="button" tabindex="0" data-schedule-recurring-action="open-occurrence" data-schedule-recurring-event-id="${escapeHtml(event.id)}" data-schedule-occurrence-start="${escapeHtml(recurring.startDate)}" data-schedule-occurrence-deadline="${escapeHtml(recurring.deadline)}" data-schedule-start-minute="${segment.startMinute}" data-schedule-end-minute="${segment.endMinute}" data-papers-visual-key="schedule-recurring-${escapeHtml(event.id)}-${token}-${escapeHtml(dayKey)}" style="position:absolute;left:4px;right:4px;top:${(segment.startMinute / MINUTES_PER_DAY) * 100}%;height:${(durationMinutes / MINUTES_PER_DAY) * 100}%;z-index:2;cursor:pointer;"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></article>`;
    }

    const event = eventsById.get(segment.eventId);
    if (!event) return '';

    const deadline = new Date(event.deadline);
    const finalSegmentDayKey = Number.isFinite(deadline.getTime())
      ? dateKeyOf(new Date(deadline.getTime() - 1))
      : '';
    const resizeHandle = finalSegmentDayKey === dayKey
      ? `<span data-schedule-resize-edge="end" data-papers-visual-key="schedule-event-${escapeHtml(event.id)}-${escapeHtml(dayKey)}-resize-end" aria-label="Resize event end" style="position:absolute;left:0;right:0;bottom:0;height:8px;border-bottom:2px solid currentColor;cursor:ns-resize;z-index:4;"></span>`
      : '';

    return `<article class="event-card schedule-timed-event${event.isCompleted ? ' completed' : ''}" role="button" tabindex="0" data-schedule-action="open-event" data-schedule-timed-event="true" data-schedule-event-id="${escapeHtml(event.id)}" data-schedule-start-value="${escapeHtml(event.startDate)}" data-schedule-deadline-value="${escapeHtml(event.deadline)}" data-schedule-start-minute="${segment.startMinute}" data-schedule-end-minute="${segment.endMinute}"${writeRefusal !== null && writeRefusal.eventId === event.id ? ` data-schedule-refusal="${escapeHtml(writeRefusal.code)}"` : ''} data-papers-visual-key="schedule-event-${escapeHtml(event.id)}-${escapeHtml(dayKey)}" style="position:absolute;left:4px;right:4px;top:${(segment.startMinute / MINUTES_PER_DAY) * 100}%;height:${(durationMinutes / MINUTES_PER_DAY) * 100}%;z-index:2;cursor:grab;">${resizeHandle}<strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small>${writeRefusal !== null && writeRefusal.eventId === event.id ? `<small class="schedule-write-refusal" data-schedule-write-refusal="${escapeHtml(writeRefusal.code)}">${escapeHtml(writeRefusal.code)}</small>` : ''}</article>`;
  }).join('');

  return `<div class="schedule-day-column" data-schedule-day="${escapeHtml(dayKey)}" data-papers-visual-key="schedule-day-${escapeHtml(dayKey)}"><div class="schedule-time-track" data-papers-visual-key="schedule-time-track-${escapeHtml(dayKey)}" style="position:relative;height:${SLOTS_PER_DAY * 8}px;">${slots}${eventCards}${currentTime}</div></div>`;
}

function renderTimeAxis(): string {
  const labels = Array.from(
    { length: 24 },
    (_, hour) => `<div style="height:32px;"><small>${String(hour).padStart(2, '0')}:00</small></div>`,
  ).join('');

  return `<div class="schedule-time-axis" data-papers-visual-key="schedule-time-axis" aria-hidden="true">${labels}</div>`;
}

export function renderScheduleTimeGrid(
  options: ScheduleTimeGridRenderOptions,
): string {
  const visibleDays = scheduleVisibleDays(
    options.calendarCursor,
    options.mode,
  );
  const firstDay = visibleDays[0]!;
  const lastDay = visibleDays[visibleDays.length - 1]!;
  const ordinaryEvents = options.events.filter(
    (event) => !hasScheduleRecurrence(event),
  );
  const recurringOccurrences = expandScheduleRecurringOccurrences(
    options.events,
    {
      start: localMidnight(firstDay),
      end: nextLocalMidnight(lastDay),
    },
  );
  const recurringByKey = new Map(
    recurringOccurrences.map((occurrence) => [occurrence.occurrenceKey, occurrence]),
  );
  const temporalEvents: ScheduleTemporalEvent[] = [
    ...ordinaryEvents,
    ...recurringOccurrences.map((occurrence) => ({
      id: occurrence.occurrenceKey,
      startDate: occurrence.startDate,
      deadline: occurrence.deadline,
    })),
  ];
  const segments = scheduleTimedProjection(temporalEvents, visibleDays);
  const eventsById = new Map(
    ordinaryEvents.map((event) => [event.id, event]),
  );
  const title = modeTitle(options.mode);

  const headers = visibleDays.map((day) => {
    const key = dateKeyOf(day);
    const isToday = key === dateKeyOf(options.now);

    return `<div class="schedule-day-header${isToday ? ' today' : ''}" data-papers-visual-key="schedule-day-header-${escapeHtml(key)}"${isToday ? ' aria-current="date"' : ''}><strong>${escapeHtml(day.toLocaleDateString(undefined, { weekday: 'short' }))}</strong><small>${escapeHtml(key)}</small></div>`;
  }).join('');

  const dayColumns = visibleDays.map((day) => (
    renderTimedDay(
      day,
      segments,
      eventsById,
      recurringByKey,
      options.projectNames,
      options.now,
      options.writeRefusal ?? null,
    )
  )).join('');

  const modal = options.selectedRecurringOccurrence
    ? renderScheduleRecurrenceScopeModal(
      options.events,
      options.selectedRecurringOccurrence,
      options.selectedRecurringScope ?? null,
      options.projectNames,
      options.recurrenceScopeWrites ?? null,
      options.occurrenceDraft ?? null,
    )
    : renderEventModal(
      options.events,
      options.selectedEventId,
      options.seededEvent ?? null,
      options.projectNames,
      options.seedRefusal ?? null,
      options.eventEditorWrites ?? null,
      options.eventEditorDraft ?? null,
    );

  return `<section class="surface calendar-surface schedule-time-grid" data-schedule-time-grid="true" data-schedule-mode="${options.mode}" data-papers-visual-key="schedule-${options.mode}-region" aria-label="${escapeHtml(title)} schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>${escapeHtml(title)}</h2><p class="surface-description">Schedule workspace · 15-minute time-of-day grid.</p></div>${renderScheduleNavigation(options.calendarCursor, options.mode)}</header>${renderAllDayRegion(ordinaryEvents, recurringOccurrences, visibleDays, options.projectNames)}<div class="schedule-time-grid-header" style="display:grid;grid-template-columns:64px repeat(${visibleDays.length},minmax(0,1fr));"><span></span>${headers}</div><div class="schedule-time-grid-body" data-papers-visual-key="schedule-time-grid-body" data-schedule-day-count="${visibleDays.length}" data-schedule-slot-minutes="${SLOT_MINUTES}" style="display:grid;grid-template-columns:64px repeat(${visibleDays.length},minmax(0,1fr));">${renderTimeAxis()}${dayColumns}</div>${modal}</section>`;
}

export function bindScheduleTimeGridInteractions(
  root: HTMLElement,
  handlers: ScheduleTimeGridHandlers,
): void {
  interface ScheduleGestureState {
    eventId: string;
    operation: ScheduleChangeOperation;
    sourceCard: HTMLElement;
    originalCards: HTMLElement[];
    sourceDayKey: string;
    startClientX: number;
    startClientY: number;
    originalStart: Date;
    originalDeadline: Date;
    originalStartValue: string;
    originalDeadlineValue: string;
    durationMs: number;
    pickupOffsetMinutes: number;
    proposedStartDate: string;
    proposedDeadline: string;
    changed: boolean;
    valid: boolean;
  }

  interface SchedulePointerTarget {
    day: Date;
    dayKey: string;
    minute: number;
  }

  function scheduleEventCards(eventId: string): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>('[data-schedule-timed-event="true"]'),
    ).filter((card) => card.dataset.scheduleEventId === eventId);
  }

  function schedulePointerTarget(event: PointerEvent): SchedulePointerTarget | null {
    const column = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-schedule-day]');
    if (!column || !root.contains(column)) return null;

    const dayKey = column.dataset.scheduleDay;
    const track = column.querySelector<HTMLElement>('.schedule-time-track');
    if (!dayKey || !track) return null;

    const day = scheduleDayFromKey(dayKey);
    const rect = track.getBoundingClientRect();
    if (
      !day
      || !Number.isFinite(rect.height)
      || rect.height <= 0
    ) {
      return null;
    }

    const y = Math.min(
      Math.max(event.clientY - rect.top, 0),
      rect.height,
    );

    return {
      day,
      dayKey,
      minute: (y / rect.height) * MINUTES_PER_DAY,
    };
  }

  function clearSchedulePreview(): void {
    root
      .querySelectorAll<HTMLElement>('[data-schedule-preview-for]')
      .forEach((preview) => {
        preview.remove();
      });
  }

  function renderSchedulePreview(
    state: ScheduleGestureState,
    start: Date,
    deadline: Date,
  ): void {
    clearSchedulePreview();

    const startMs = start.getTime();
    const deadlineMs = deadline.getTime();
    const label = state.sourceCard.querySelector('strong')?.textContent ?? '';

    root
      .querySelectorAll<HTMLElement>('[data-schedule-day]')
      .forEach((column) => {
        const dayKey = column.dataset.scheduleDay;
        if (!dayKey) return;

        const day = scheduleDayFromKey(dayKey);
        const track = column.querySelector<HTMLElement>('.schedule-time-track');
        if (!day || !track) return;

        const dayStart = localMidnight(day);
        const dayEnd = nextLocalMidnight(day);
        const dayStartMs = dayStart.getTime();
        const dayEndMs = dayEnd.getTime();

        if (deadlineMs <= dayStartMs || startMs >= dayEndMs) return;

        const segmentStartMs = Math.max(startMs, dayStartMs);
        const segmentEndMs = Math.min(deadlineMs, dayEndMs);
        const startMinute = segmentStartMs <= dayStartMs
          ? 0
          : minuteOfDay(new Date(segmentStartMs));
        const endMinute = segmentEndMs >= dayEndMs
          ? MINUTES_PER_DAY
          : minuteOfDay(new Date(segmentEndMs));
        const durationMinutes = endMinute - startMinute;

        if (durationMinutes <= 0) return;

        const preview = root.ownerDocument.createElement('article');
        preview.className = 'event-card schedule-timed-event schedule-gesture-preview';
        preview.dataset.schedulePreviewFor = state.eventId;
        preview.dataset.schedulePreviewOperation = state.operation;
        preview.dataset.schedulePreviewStartMinute = String(startMinute);
        preview.dataset.schedulePreviewEndMinute = String(endMinute);
        preview.dataset.schedulePreviewDurationMinutes = String(durationMinutes);
        preview.setAttribute(
          'data-papers-visual-key',
          `schedule-preview-${state.eventId}-${dayKey}`,
        );
        preview.setAttribute('aria-hidden', 'true');
        preview.style.position = 'absolute';
        preview.style.left = '4px';
        preview.style.right = '4px';
        preview.style.top = `${(startMinute / MINUTES_PER_DAY) * 100}%`;
        preview.style.height = `${(durationMinutes / MINUTES_PER_DAY) * 100}%`;
        preview.style.zIndex = '5';
        preview.style.pointerEvents = 'none';
        preview.textContent = label;
        track.append(preview);
      });
  }

  function restoreScheduleGesture(state: ScheduleGestureState): void {
    clearSchedulePreview();

    state.originalCards.forEach((card) => {
      card.style.opacity = '';
      card.style.cursor = 'grab';
      delete card.dataset.schedulePickup;
      delete card.dataset.scheduleInvalid;
      delete card.dataset.scheduleProposedStart;
      delete card.dataset.scheduleProposedDeadline;
    });
  }

  function updateScheduleGesture(
    state: ScheduleGestureState,
    event: PointerEvent,
  ): void {
    const target = schedulePointerTarget(event);
    if (!target) return;

    const samePointer = (
      event.clientX === state.startClientX
      && event.clientY === state.startClientY
      && target.dayKey === state.sourceDayKey
    );

    let proposedStart = new Date(state.originalStart);
    let proposedDeadline = new Date(state.originalDeadline);

    if (!samePointer && state.operation === 'move') {
      const snappedStartMinute = snapScheduleMinutes(
        target.minute - state.pickupOffsetMinutes,
      );
      proposedStart = scheduleDateAtMinute(
        target.day,
        snappedStartMinute,
      );
      proposedDeadline = new Date(
        proposedStart.getTime() + state.durationMs,
      );
    } else if (!samePointer && state.operation === 'resize-end') {
      proposedDeadline = scheduleDateAtMinute(
        target.day,
        snapScheduleMinutes(target.minute),
      );
    }

    const valid = (
      Number.isFinite(proposedStart.getTime())
      && Number.isFinite(proposedDeadline.getTime())
      && proposedDeadline.getTime() > proposedStart.getTime()
      && (
        state.operation !== 'resize-end'
        || civilMinuteDistance(proposedStart, proposedDeadline) >= SLOT_MINUTES
      )
    );
    const proposedStartDate = proposedStart.toISOString();
    const proposedDeadlineValue = proposedDeadline.toISOString();
    const changed = (
      proposedStartDate !== state.originalStartValue
      || proposedDeadlineValue !== state.originalDeadlineValue
    );

    state.proposedStartDate = proposedStartDate;
    state.proposedDeadline = proposedDeadlineValue;
    state.changed = changed;
    state.valid = valid;

    state.originalCards.forEach((card) => {
      card.dataset.scheduleProposedStart = proposedStartDate;
      card.dataset.scheduleProposedDeadline = proposedDeadlineValue;
    });

    if (!valid) {
      clearSchedulePreview();
      state.originalCards.forEach((card) => {
        card.dataset.scheduleInvalid = 'true';
      });
      return;
    }

    state.originalCards.forEach((card) => {
      delete card.dataset.scheduleInvalid;
    });

    renderSchedulePreview(
      state,
      proposedStart,
      proposedDeadline,
    );
  }

  let gesture: ScheduleGestureState | null = null;
  let suppressNextClickEventId: string | null = null;

  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-schedule-action]');
    if (!control) return;

    if (control.dataset.scheduleAction === 'open-event') {
      const eventId = control.dataset.scheduleEventId;
      if (!eventId) return;

      if (suppressNextClickEventId === eventId) {
        suppressNextClickEventId = null;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      handlers.openEvent(eventId);
      return;
    }

    if (control.dataset.scheduleAction === 'seed-event') {
      const dayKey = control.dataset.scheduleDayKey;
      const slotIndex = Number(control.dataset.scheduleSlot);
      const day = dayKey ? scheduleDayFromKey(dayKey) : null;

      if (
        !day
        || !Number.isInteger(slotIndex)
        || slotIndex < 0
        || slotIndex >= SLOTS_PER_DAY
      ) {
        return;
      }

      const startMinute = slotIndex * SLOT_MINUTES;
      const start = scheduleDateAtMinute(day, startMinute);
      const deadline = scheduleDateAtMinute(
        day,
        startMinute + 60,
      );

      handlers.seedEvent({
        name: 'New event',
        projectId: null,
        description: '',
        startDate: start.toISOString(),
        deadline: deadline.toISOString(),
      });
      return;
    }

    if (control.dataset.scheduleAction === 'save-seeded-event') {
      const modal = control.closest<HTMLElement>(
        '[data-schedule-editor-mode="create"]',
      );
      const name = modal?.querySelector<HTMLInputElement>(
        '[data-papers-visual-key="schedule-event-name"]',
      );
      const start = modal?.querySelector<HTMLInputElement>(
        '[data-papers-visual-key="schedule-event-start"]',
      );
      const deadline = modal?.querySelector<HTMLInputElement>(
        '[data-papers-visual-key="schedule-event-end"]',
      );
      const description = modal?.querySelector<HTMLTextAreaElement>(
        '[data-papers-visual-key="schedule-event-description"]',
      );

      if (!modal || !name || !start || !deadline || !description) {
        return;
      }

      // The sequence runs in the shell, so the refusal it answers with is drawn by the next render
      // where the form is — not written into the DOM here, which the next render would erase.
      handlers.createEvent({
        name: name.value,
        projectId: modal.dataset.scheduleDraftProjectId || null,
        description: description.value,
        startDate: start.value,
        deadline: deadline.value,
      });
      return;
    }

    // The Event editor's Save and Delete. The form is read where it is and handed over: the sequence
    // runs in the shell, and what it answers is what the next render draws.
    if (control.dataset.scheduleAction === 'save-event') {
      const modal = control.closest<HTMLElement>(
        '[data-schedule-editor-mode="edit"]',
      );
      const eventId = modal?.dataset.scheduleEventId;
      const values = modal ? eventFormValuesFrom(modal) : null;
      if (!modal || !eventId || !values) return;
      handlers.saveEvent({ eventId, values });
      return;
    }

    if (control.dataset.scheduleAction === 'delete-event') {
      const modal = control.closest<HTMLElement>(
        '[data-schedule-editor-mode="edit"]',
      );
      const eventId = modal?.dataset.scheduleEventId;
      if (!eventId) return;
      handlers.deleteEvent({ eventId });
      return;
    }

    if (control.dataset.scheduleAction === 'close-event') {
      handlers.closeEvent();
    }
  });

  root.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>(
      '[data-schedule-timed-event="true"]',
    );
    if (!card) return;

    const eventId = card.dataset.scheduleEventId;
    const originalStartValue = card.dataset.scheduleStartValue;
    const originalDeadlineValue = card.dataset.scheduleDeadlineValue;
    const sourceTarget = schedulePointerTarget(event);

    if (
      !eventId
      || !originalStartValue
      || !originalDeadlineValue
      || !sourceTarget
    ) {
      return;
    }

    const originalStart = new Date(originalStartValue);
    const originalDeadline = new Date(originalDeadlineValue);
    const durationMs = (
      originalDeadline.getTime()
      - originalStart.getTime()
    );

    if (
      !Number.isFinite(originalStart.getTime())
      || !Number.isFinite(originalDeadline.getTime())
      || durationMs <= 0
    ) {
      return;
    }

    const operation: ScheduleChangeOperation = (
      target.closest<HTMLElement>('[data-schedule-resize-edge="end"]')
    )
      ? 'resize-end'
      : 'move';
    const pickupOffsetMinutes = (
      (
        civilDayOrdinal(sourceTarget.day)
        - civilDayOrdinal(originalStart)
      ) * MINUTES_PER_DAY
      + sourceTarget.minute
      - minuteOfDay(originalStart)
    );
    const originalCards = scheduleEventCards(eventId);

    originalCards.forEach((eventCard) => {
      delete eventCard.dataset.scheduleRefusal;
      eventCard.style.opacity = '0.35';
      eventCard.dataset.schedulePickup = operation;
    });
    card.style.cursor = operation === 'move'
      ? 'grabbing'
      : 'ns-resize';

    gesture = {
      eventId,
      operation,
      sourceCard: card,
      originalCards,
      sourceDayKey: sourceTarget.dayKey,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originalStart,
      originalDeadline,
      originalStartValue,
      originalDeadlineValue,
      durationMs,
      pickupOffsetMinutes,
      proposedStartDate: originalStartValue,
      proposedDeadline: originalDeadlineValue,
      changed: false,
      valid: true,
    };
  });

  root.addEventListener('pointermove', (event) => {
    if (!gesture) return;

    event.preventDefault();
    updateScheduleGesture(gesture, event);
  });

  root.addEventListener('pointerup', (event) => {
    if (!gesture) return;

    const finished = gesture;
    updateScheduleGesture(finished, event);
    gesture = null;

    if (!finished.changed) {
      restoreScheduleGesture(finished);
      return;
    }

    suppressNextClickEventId = finished.eventId;

    if (!finished.valid) {
      restoreScheduleGesture(finished);
      return;
    }

    // The block goes back to where the surface was rendering it, and the shell's answer — accepted
    // or refused — arrives as the next render. A lost race re-reads first, which is what puts the
    // block where the store says it is rather than where the pointer left it.
    restoreScheduleGesture(finished);

    handlers.changeEvent({
      eventId: finished.eventId,
      operation: finished.operation,
      proposedStartDate: finished.proposedStartDate,
      proposedDeadline: finished.proposedDeadline,
    });
  });

  root.addEventListener('pointercancel', () => {
    if (!gesture) return;

    const cancelled = gesture;
    gesture = null;
    restoreScheduleGesture(cancelled);
  });
}

export function startScheduleTimeTicker(
  root: HTMLElement,
  isLiveClock: () => boolean,
  refresh: () => void,
): () => void {
  const timer = globalThis.setInterval(() => {
    if (
      isLiveClock()
      && root.querySelector('[data-schedule-time-grid="true"]')
    ) {
      refresh();
    }
  }, 60_000);

  return () => {
    globalThis.clearInterval(timer);
  };
}
