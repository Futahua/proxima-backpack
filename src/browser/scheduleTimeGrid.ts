import type { CalendarEvent } from '../domain/types.js';
import { localDateKey } from '../domain/time.js';

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

export interface ScheduleTimeGridRenderOptions {
  mode: ScheduleTimeGridMode;
  events: CalendarEvent[];
  projectNames: Map<string, string>;
  selectionLabel: string;
  calendarCursor: Date;
  now: Date;
  selectedEventId: string | null;
}

export interface ScheduleTimeGridHandlers {
  openEvent(eventId: string): void;
  closeEvent(): void;
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
  event: CalendarEvent,
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
  events: readonly CalendarEvent[],
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
        dayKey: localDateKey(day),
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
  events: readonly CalendarEvent[],
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
  projectNames: Map<string, string>,
): string {
  if (!eventId) return '';

  const event = events.find((candidate) => candidate.id === eventId);
  if (!event) return '';

  return `<div class="modal-backdrop" data-c1-key="schedule-event-modal-backdrop"><section class="task-modal" role="dialog" aria-modal="true" aria-label="Event editor" data-c1-key="schedule-event-modal"><header class="surface-header"><div><p class="eyebrow">Event editor</p><h3>${escapeHtml(event.name)}</h3></div><button type="button" class="icon-button" data-schedule-action="close-event" data-c1-key="schedule-event-modal-close" aria-label="Close event editor">×</button></header><label>Name<input data-c1-key="schedule-event-name" value="${escapeHtml(event.name)}" readonly></label><label>Project<input data-c1-key="schedule-event-project" value="${escapeHtml(projectName(event, projectNames))}" readonly></label><label>Start<input data-c1-key="schedule-event-start" value="${escapeHtml(event.startDate)}" readonly></label><label>End<input data-c1-key="schedule-event-end" value="${escapeHtml(event.deadline)}" readonly></label><label>Description<textarea data-c1-key="schedule-event-description" readonly>${escapeHtml(event.description)}</textarea></label></section></div>`;
}

function renderAllDayRegion(
  events: readonly CalendarEvent[],
  visibleDays: readonly Date[],
  projectNames: Map<string, string>,
): string {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const placements = scheduleAllDayProjection(events, visibleDays);

  const items = placements.map((placement) => {
    const event = eventsById.get(placement.eventId);
    if (!event) return '';

    return `<article class="event-card schedule-all-day-event" role="button" tabindex="0" data-schedule-action="open-event" data-schedule-event-id="${escapeHtml(event.id)}" data-schedule-all-day-start-column="${placement.startColumn}" data-schedule-all-day-span-columns="${placement.spanColumns}" data-c1-key="schedule-all-day-event-${escapeHtml(event.id)}" style="grid-column:${placement.startColumn + 1} / span ${placement.spanColumns};"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></article>`;
  }).join('');

  return `<section class="schedule-all-day-region" data-c1-key="schedule-all-day-region" aria-label="All-day events"><div class="schedule-all-day-grid" style="display:grid;grid-template-columns:64px repeat(${visibleDays.length},minmax(0,1fr));gap:2px;"><strong style="grid-column:1;">All day</strong>${items}</div></section>`;
}

function renderTimedDay(
  day: Date,
  segments: readonly ScheduleTimedSegment[],
  eventsById: Map<string, CalendarEvent>,
  projectNames: Map<string, string>,
  now: Date,
): string {
  const dayKey = localDateKey(day);
  const daySegments = segments.filter((segment) => segment.dayKey === dayKey);
  const nowKey = localDateKey(now);
  const currentMinute = minuteOfDay(now);
  const currentTime = nowKey === dayKey
    ? `<div class="schedule-current-time-indicator" data-current-minute="${currentMinute}" data-c1-key="schedule-current-time-${escapeHtml(dayKey)}" style="position:absolute;left:0;right:0;top:${(currentMinute / MINUTES_PER_DAY) * 100}%;border-top:2px solid currentColor;z-index:3;"></div>`
    : '';

  const slots = Array.from(
    { length: SLOTS_PER_DAY },
    (_, slotIndex) => `<div class="schedule-time-slot" data-schedule-slot="${slotIndex}" data-c1-key="schedule-slot-${escapeHtml(dayKey)}-${slotIndex}" style="height:8px;border-top:1px solid currentColor;opacity:0.12;"></div>`,
  ).join('');

  const eventCards = daySegments.map((segment) => {
    const event = eventsById.get(segment.eventId);
    if (!event) return '';

    const durationMinutes = segment.endMinute - segment.startMinute;

    return `<article class="event-card schedule-timed-event${event.isCompleted ? ' completed' : ''}" role="button" tabindex="0" data-schedule-action="open-event" data-schedule-event-id="${escapeHtml(event.id)}" data-schedule-start-minute="${segment.startMinute}" data-schedule-end-minute="${segment.endMinute}" data-c1-key="schedule-event-${escapeHtml(event.id)}-${escapeHtml(dayKey)}" style="position:absolute;left:4px;right:4px;top:${(segment.startMinute / MINUTES_PER_DAY) * 100}%;height:${(durationMinutes / MINUTES_PER_DAY) * 100}%;z-index:2;"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(event, projectNames))}</small></article>`;
  }).join('');

  return `<div class="schedule-day-column" data-schedule-day="${escapeHtml(dayKey)}" data-c1-key="schedule-day-${escapeHtml(dayKey)}"><div class="schedule-time-track" data-c1-key="schedule-time-track-${escapeHtml(dayKey)}" style="position:relative;height:${SLOTS_PER_DAY * 8}px;">${slots}${eventCards}${currentTime}</div></div>`;
}

function renderTimeAxis(): string {
  const labels = Array.from(
    { length: 24 },
    (_, hour) => `<div style="height:32px;"><small>${String(hour).padStart(2, '0')}:00</small></div>`,
  ).join('');

  return `<div class="schedule-time-axis" data-c1-key="schedule-time-axis" aria-hidden="true">${labels}</div>`;
}

export function renderScheduleTimeGrid(
  options: ScheduleTimeGridRenderOptions,
): string {
  const visibleDays = scheduleVisibleDays(
    options.calendarCursor,
    options.mode,
  );
  const segments = scheduleTimedProjection(options.events, visibleDays);
  const eventsById = new Map(
    options.events.map((event) => [event.id, event]),
  );
  const title = modeTitle(options.mode);

  const headers = visibleDays.map((day) => {
    const key = localDateKey(day);
    const isToday = key === localDateKey(options.now);

    return `<div class="schedule-day-header${isToday ? ' today' : ''}" data-c1-key="schedule-day-header-${escapeHtml(key)}"${isToday ? ' aria-current="date"' : ''}><strong>${escapeHtml(day.toLocaleDateString(undefined, { weekday: 'short' }))}</strong><small>${escapeHtml(key)}</small></div>`;
  }).join('');

  const dayColumns = visibleDays.map((day) => (
    renderTimedDay(
      day,
      segments,
      eventsById,
      options.projectNames,
      options.now,
    )
  )).join('');

  return `<section class="surface calendar-surface schedule-time-grid" data-schedule-time-grid="true" data-schedule-mode="${options.mode}" data-c1-key="schedule-${options.mode}-region" aria-label="${escapeHtml(title)} schedule"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>${escapeHtml(title)}</h2><p class="surface-description">Schedule workspace · 15-minute time-of-day grid.</p></div></header>${renderAllDayRegion(options.events, visibleDays, options.projectNames)}<div class="schedule-time-grid-header" style="display:grid;grid-template-columns:64px repeat(${visibleDays.length},minmax(0,1fr));"><span></span>${headers}</div><div class="schedule-time-grid-body" data-c1-key="schedule-time-grid-body" data-schedule-day-count="${visibleDays.length}" data-schedule-slot-minutes="${SLOT_MINUTES}" style="display:grid;grid-template-columns:64px repeat(${visibleDays.length},minmax(0,1fr));">${renderTimeAxis()}${dayColumns}</div>${renderEventModal(options.events, options.selectedEventId, options.projectNames)}</section>`;
}

export function bindScheduleTimeGridInteractions(
  root: HTMLElement,
  handlers: ScheduleTimeGridHandlers,
): void {
  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-schedule-action]');
    if (!control) return;

    if (control.dataset.scheduleAction === 'open-event') {
      const eventId = control.dataset.scheduleEventId;
      if (eventId) handlers.openEvent(eventId);
      return;
    }

    if (control.dataset.scheduleAction === 'close-event') {
      handlers.closeEvent();
    }
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
