import type {
  ActionResult,
  TimekeepingPanel,
  TimekeepingPanelVisibility,
  TimelineChangeOperation,
} from '../app/actionProtocol.js';
import { deadlineHue, localDateKey } from '../domain/time.js';
import type { ProximaState, Task } from '../domain/types.js';
import { calendarGridDates } from './calendarGrid.js';
import { renderTaskModal } from './elasticCockpit.js';
import { TASK_EDITOR_SAVE_REFUSAL, type TaskEditorDraft } from '../app/taskEditor.js';
import { timekeepingPanelWidth } from '../app/panelSizing.js';

export interface DeadlineCalendarEntry {
  taskId: string;
  dayKey: string;
  deadline: string;
  remainingMs: number;
}

export type CountdownBucket =
  | 'overdue'
  | 'under-one-day'
  | 'under-three-days'
  | 'under-one-week'
  | 'later';

export interface CountdownEntry {
  taskId: string;
  deadline: string;
  remainingMs: number;
  bucket: CountdownBucket;
}

export type TimelineGanttKind = 'span' | 'start' | 'deadline';

export interface TimelineGanttEntry {
  taskId: string;
  kind: TimelineGanttKind;
  startKey: string | null;
  endKey: string | null;
  startColumn: number;
  spanColumns: number;
  remainingMs: number | null;
}

export interface TimekeepingCockpitRenderOptions {
  state: ProximaState;
  tasks: Task[];
  projectNames: Map<string, string>;
  selectionLabel: string;
  panels: TimekeepingPanelVisibility;
  /**
   * How wide the reader has dragged each panel, which is local state like the visibility beside it.
   *
   * Absent means nobody has resized anything, and every panel draws at the default the sizing module owns.
   */
  panelWidths?: Readonly<Record<string, number>>;
  calendarCursor: Date;
  now: Date;
  selectedTaskId: string | null;
  /** The Task editor's provisional edits, which this surface's modal also shows. */
  editorDraft: TaskEditorDraft | null;
  /** The last refused date change, drawn on the bar it was about rather than in a banner. */
  timelineWrites?: { taskId: string; code: string } | null;
  /** The last accepted change's sentence. */
  timelineFeedback?: string | null;
}

export interface TimelineChangeIntent {
  taskId: string;
  operation: TimelineChangeOperation;
  proposedStartDate: string | null;
  proposedDeadline: string | null;
  targetRowIndex: number;
}

export interface TimekeepingCockpitHandlers {
  openTask(taskId: string): void;
  setPanelVisible(panel: TimekeepingPanel, visible: boolean): void;
  /**
   * A panel edge was dragged. The width arrives unclamped, as a drag reports it, and the clamp is the app
   * layer's - so a surface cannot hold a width the sizing module would not accept.
   *
   * Optional, and the interaction is bound only when a shell supplies it: a harness that drives the surface
   * without caring how wide a panel is should not have to write a stub that does nothing, and an absent
   * handler means there is no edge to drag rather than an edge that silently does nothing.
   */
  resizePanel?(panel: TimekeepingPanel, width: number): void;
  navigateMonth(direction: 'previous' | 'next'): void;
  today(): void;
  changeTask(intent: TimelineChangeIntent): void;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function monthKey(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-01`;
}

function monthTitle(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

function projectName(
  projectNames: Map<string, string>,
  task: Task,
): string {
  if (!task.projectId) return 'Uncategorised';
  return projectNames.get(task.projectId) ?? task.projectId;
}

export function deadlineCalendarProjection(
  tasks: readonly Task[],
  now: Date,
): DeadlineCalendarEntry[] {
  const nowMs = now.getTime();

  return tasks
    .flatMap((task) => {
      if (!task.deadline) return [];

      const deadlineMs = Date.parse(task.deadline);
      if (!Number.isFinite(deadlineMs)) return [];

      return [{
        taskId: task.id,
        dayKey: localDateKey(task.deadline),
        deadline: task.deadline,
        remainingMs: deadlineMs - nowMs,
      }];
    })
    .sort(
      (left, right) =>
        Date.parse(left.deadline) - Date.parse(right.deadline)
        || left.taskId.localeCompare(right.taskId),
    );
}

function civilDayOrdinal(key: string): number {
  const parts = key.split('-');
  const yearPart = parts[0];
  const monthPart = parts[1];
  const dayPart = parts[2];

  if (
    parts.length !== 3
    || yearPart === undefined
    || monthPart === undefined
    || dayPart === undefined
  ) {
    throw new RangeError(`Invalid civil date key: ${key}`);
  }

  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);

  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || month < 1
    || month > 12
    || day < 1
    || day > 31
  ) {
    throw new RangeError(`Invalid civil date key: ${key}`);
  }

  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid civil date key: ${key}`);
  }

  return Math.floor(timestamp / 86_400_000);
}

export function timelineGanttProjection(
  tasks: readonly Task[],
  calendarCursor: Date,
  now: Date,
): TimelineGanttEntry[] {
  const days = calendarGridDates(calendarCursor);
  const firstKey = localDateKey(days[0]!);
  const lastKey = localDateKey(days[days.length - 1]!);
  const firstOrdinal = civilDayOrdinal(firstKey);
  const lastOrdinal = civilDayOrdinal(lastKey);
  const nowMs = now.getTime();
  const entries: TimelineGanttEntry[] = [];

  for (const task of tasks) {
    const rawStart = task.startDate;
    const rawDeadline = task.deadline;
    const parsedStart = rawStart ? Date.parse(rawStart) : Number.NaN;
    const parsedDeadline = rawDeadline ? Date.parse(rawDeadline) : Number.NaN;
    const hasStart = Number.isFinite(parsedStart);
    const hasDeadline = Number.isFinite(parsedDeadline);

    if (!hasStart && !hasDeadline) continue;

    const startKey = hasStart ? localDateKey(rawStart!) : null;
    const endKey = hasDeadline ? localDateKey(rawDeadline!) : null;

    let kind: TimelineGanttKind;
    let firstEntryOrdinal: number;
    let lastEntryOrdinal: number;

    if (startKey && endKey) {
      const startOrdinal = civilDayOrdinal(startKey);
      const endOrdinal = civilDayOrdinal(endKey);

      if (endOrdinal >= startOrdinal) {
        kind = 'span';
        firstEntryOrdinal = startOrdinal;
        lastEntryOrdinal = endOrdinal;
      } else {
        kind = 'deadline';
        firstEntryOrdinal = endOrdinal;
        lastEntryOrdinal = endOrdinal;
      }
    } else if (startKey) {
      kind = 'start';
      firstEntryOrdinal = civilDayOrdinal(startKey);
      lastEntryOrdinal = firstEntryOrdinal;
    } else {
      kind = 'deadline';
      firstEntryOrdinal = civilDayOrdinal(endKey!);
      lastEntryOrdinal = firstEntryOrdinal;
    }

    if (
      lastEntryOrdinal < firstOrdinal
      || firstEntryOrdinal > lastOrdinal
    ) {
      continue;
    }

    const clippedStart = Math.max(firstEntryOrdinal, firstOrdinal);
    const clippedEnd = Math.min(lastEntryOrdinal, lastOrdinal);

    entries.push({
      taskId: task.id,
      kind,
      startKey,
      endKey,
      startColumn: clippedStart - firstOrdinal + 1,
      spanColumns: clippedEnd - clippedStart + 1,
      remainingMs: hasDeadline ? parsedDeadline - nowMs : null,
    });
  }

  return entries.sort(
    (left, right) =>
      left.startColumn - right.startColumn
      || left.taskId.localeCompare(right.taskId),
  );
}

const COUNTDOWN_DAY_MS = 86_400_000;

const COUNTDOWN_BUCKETS: ReadonlyArray<{
  bucket: CountdownBucket;
  title: string;
}> = [
  { bucket: 'overdue', title: 'Overdue' },
  { bucket: 'under-one-day', title: 'Under one day' },
  { bucket: 'under-three-days', title: 'Under three days' },
  { bucket: 'under-one-week', title: 'Under one week' },
  { bucket: 'later', title: 'Later' },
];

export function countdownBucketForRemaining(
  remainingMs: number,
): CountdownBucket {
  if (remainingMs < 0) return 'overdue';
  if (remainingMs < COUNTDOWN_DAY_MS) return 'under-one-day';
  if (remainingMs < 3 * COUNTDOWN_DAY_MS) return 'under-three-days';
  if (remainingMs < 7 * COUNTDOWN_DAY_MS) return 'under-one-week';
  return 'later';
}

export function countdownProjection(
  tasks: readonly Task[],
  now: Date,
): CountdownEntry[] {
  const nowMs = now.getTime();

  return tasks
    .flatMap((task) => {
      if (task.isCompleted || !task.deadline) return [];

      const deadlineMs = Date.parse(task.deadline);
      if (!Number.isFinite(deadlineMs)) return [];

      const remainingMs = deadlineMs - nowMs;

      return [{
        taskId: task.id,
        deadline: task.deadline,
        remainingMs,
        bucket: countdownBucketForRemaining(remainingMs),
      }];
    })
    .sort(
      (left, right) =>
        left.remainingMs - right.remainingMs
        || left.taskId.localeCompare(right.taskId),
    );
}

function countdownLabel(remainingMs: number): string {
  const totalSeconds = Math.floor(Math.abs(remainingMs) / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const value = `${days}d ${hours}h ${minutes}m ${seconds}s`;

  return remainingMs < 0
    ? `Overdue by ${value}`
    : `${value} remaining`;
}

function panelToggle(
  panel: TimekeepingPanel,
  label: string,
  visible: boolean,
): string {
  return `<button type="button" class="surface-tab${visible ? ' selected' : ''}" data-timekeeping-action="panel-set-visible" data-timekeeping-panel="${panel}" data-timekeeping-visible="${visible ? 'false' : 'true'}" data-papers-visual-key="timekeeping-panel-toggle-${panel}" aria-pressed="${visible}">${label}</button>`;
}

function renderDeadlineTask(
  task: Task,
  entry: DeadlineCalendarEntry,
  projectNames: Map<string, string>,
): string {
  const overdue = !task.isCompleted && entry.remainingMs < 0;
  const classes = [
    'event-card',
    'timekeeping-deadline-task',
    overdue ? 'task-overdue' : '',
    task.isCompleted ? 'completed' : '',
  ].filter(Boolean).join(' ');

  const style = task.isCompleted
    ? ''
    : ` style="background-color:${deadlineHue(entry.remainingMs)}"`;

  const meta = overdue
    ? `Overdue · ${projectName(projectNames, task)}`
    : projectName(projectNames, task);

  return `<article class="${classes}" role="button" tabindex="0" data-elastic-action="open-task" data-elastic-task-id="${escapeHtml(task.id)}" data-deadline-overdue="${overdue ? 'true' : 'false'}" data-papers-visual-key="timekeeping-calendar-task-${escapeHtml(task.id)}"${style}><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(meta)}</small></article>`;
}

function renderCalendar(
  options: TimekeepingCockpitRenderOptions,
): string {
  const days = calendarGridDates(options.calendarCursor);
  const todayKey = localDateKey(options.now);
  const tasksById = new Map(options.tasks.map((task) => [task.id, task]));
  const entriesByDay = new Map<string, DeadlineCalendarEntry[]>();

  for (const entry of deadlineCalendarProjection(options.tasks, options.now)) {
    const dayEntries = entriesByDay.get(entry.dayKey);

    if (dayEntries) {
      dayEntries.push(entry);
    } else {
      entriesByDay.set(entry.dayKey, [entry]);
    }
  }

  return `<section class="timekeeping-panel calendar-surface" data-papers-visual-key="timekeeping-panel-calendar" aria-label="Deadline Calendar"><header class="surface-header"><div><h3>Deadline Calendar</h3><p class="surface-description">Task deadlines, separate from Schedule events.</p></div><div class="calendar-controls"><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="previous" data-papers-visual-key="timekeeping-calendar-previous" aria-label="Previous month">←</button><button type="button" class="icon-button" data-timekeeping-action="month-today" data-papers-visual-key="timekeeping-calendar-today">Today</button><strong data-papers-visual-key="timekeeping-calendar-month" data-calendar-month="${monthKey(options.calendarCursor)}">${escapeHtml(monthTitle(options.calendarCursor))}</strong><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="next" data-papers-visual-key="timekeeping-calendar-next" aria-label="Next month">→</button></div></header><div class="weekday-row" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${days.map((day) => {
    const key = localDateKey(day);
    const outside = day.getMonth() !== options.calendarCursor.getMonth();
    const entries = entriesByDay.get(key) ?? [];

    return `<div class="calendar-day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}" data-papers-visual-key="timekeeping-calendar-day-${escapeHtml(key)}" data-deadline-count="${entries.length}" aria-label="${escapeHtml(key)}"${key === todayKey ? ' aria-current="date"' : ''}><span class="day-number">${day.getDate()}</span><div class="day-events">${entries.map((entry) => {
      const task = tasksById.get(entry.taskId);
      return task
        ? renderDeadlineTask(task, entry, options.projectNames)
        : '';
    }).join('')}</div></div>`;
  }).join('')}</div></section>`;
}

function renderTimelineGantt(
  options: TimekeepingCockpitRenderOptions,
): string {
  const days = calendarGridDates(options.calendarCursor);
  const todayKey = localDateKey(options.now);
  const todayColumn = days.findIndex((day) => localDateKey(day) === todayKey) + 1;
  const entries = timelineGanttProjection(
    options.tasks,
    options.calendarCursor,
    options.now,
  );
  const tasksById = new Map(options.tasks.map((task) => [task.id, task]));

  const rows = entries.map((entry, rowIndex) => {
    const task = tasksById.get(entry.taskId);
    if (!task) return '';

    const overdue = (
      !task.isCompleted
      && entry.remainingMs !== null
      && entry.remainingMs < 0
    );

    const classes = [
      'event-card',
      'timekeeping-gantt-task',
      entry.kind === 'span' ? 'gantt-span' : 'gantt-milestone',
      overdue ? 'task-overdue' : '',
      task.isCompleted ? 'completed' : '',
    ].filter(Boolean).join(' ');

    const pressureStyle = (
      !task.isCompleted
      && entry.remainingMs !== null
    )
      ? `background-color:${deadlineHue(entry.remainingMs)};`
      : '';

    const temporalLabel = entry.kind === 'span'
      ? `${entry.startKey} → ${entry.endKey}`
      : entry.kind === 'start'
        ? `Starts ${entry.startKey}`
        : `Due ${entry.endKey}`;
    const startHandle = entry.startKey
      ? `<span data-gantt-edge="start" data-papers-visual-key="timekeeping-gantt-edge-start-${escapeHtml(task.id)}" aria-label="Resize start" title="Shift-drag to resize start" style="position:absolute;left:0;top:0;bottom:0;width:8px;border-left:2px solid currentColor;cursor:col-resize;"></span>`
      : '';
    const endHandle = entry.endKey
      ? `<span data-gantt-edge="end" data-papers-visual-key="timekeeping-gantt-edge-end-${escapeHtml(task.id)}" aria-label="Resize deadline" title="Shift-drag to resize deadline" style="position:absolute;right:0;top:0;bottom:0;width:8px;border-right:2px solid currentColor;cursor:col-resize;"></span>`
      : '';

    return `<div class="timekeeping-gantt-row" data-gantt-row-index="${rowIndex}" data-papers-visual-key="timekeeping-gantt-row-${escapeHtml(task.id)}"><div class="timekeeping-gantt-label"><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(projectName(options.projectNames, task))} · ${escapeHtml(temporalLabel)}</small><small data-gantt-proposal-for="${escapeHtml(task.id)}" data-papers-visual-key="timekeeping-gantt-proposal-${escapeHtml(task.id)}" aria-live="polite" style="opacity:0;"></small></div><div class="timekeeping-gantt-track" data-papers-visual-key="timekeeping-gantt-track-${escapeHtml(task.id)}" style="display:grid;grid-template-columns:repeat(42,minmax(12px,1fr));position:relative;"><article class="${classes}" role="button" tabindex="0" data-timekeeping-action="open-task" data-timekeeping-task-id="${escapeHtml(task.id)}" data-gantt-task-id="${escapeHtml(task.id)}" data-gantt-kind="${entry.kind}" data-gantt-start="${escapeHtml(entry.startKey ?? '')}" data-gantt-end="${escapeHtml(entry.endKey ?? '')}" data-gantt-start-value="${escapeHtml(task.startDate ?? '')}" data-gantt-deadline-value="${escapeHtml(task.deadline ?? '')}" data-gantt-start-column="${entry.startColumn}" data-gantt-span-columns="${entry.spanColumns}"${options.timelineWrites?.taskId === task.id ? ` data-gantt-refusal="${escapeHtml(options.timelineWrites.code)}"` : ''} data-papers-visual-key="timekeeping-gantt-task-${escapeHtml(task.id)}" style="grid-column:${entry.startColumn} / span ${entry.spanColumns};position:relative;cursor:grab;${pressureStyle}">${startHandle}${entry.kind === 'span' ? escapeHtml(task.name) : '◆'}${endHandle}</article></div></div>`;
  }).join('');

  return `<section class="timekeeping-panel project-details" data-papers-visual-key="timekeeping-panel-timeline" aria-label="Timeline/Gantt"><header class="surface-header"><div><h3>Timeline/Gantt</h3><p class="surface-description">Task starts and deadlines across the active calendar window.</p></div><div class="calendar-controls"><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="previous" data-papers-visual-key="timekeeping-gantt-previous" aria-label="Previous month">←</button><button type="button" class="icon-button" data-timekeeping-action="month-today" data-papers-visual-key="timekeeping-gantt-today">Today</button><strong data-papers-visual-key="timekeeping-gantt-month" data-calendar-month="${monthKey(options.calendarCursor)}">${escapeHtml(monthTitle(options.calendarCursor))}</strong><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="next" data-papers-visual-key="timekeeping-gantt-next" aria-label="Next month">→</button></div></header><div class="timekeeping-gantt-header" style="display:grid;grid-template-columns:220px 1fr;"><span>Task</span><div style="display:grid;grid-template-columns:repeat(42,minmax(12px,1fr));">${days.map((day) => {
    const key = localDateKey(day);
    return `<span class="${key === todayKey ? 'today' : ''}" data-papers-visual-key="timekeeping-gantt-day-${escapeHtml(key)}" aria-current="${key === todayKey ? 'date' : 'false'}">${day.getDate()}</span>`;
  }).join('')}</div></div><div class="timekeeping-gantt-body" data-papers-visual-key="timekeeping-gantt-body" data-gantt-today-column="${todayColumn > 0 ? todayColumn : ''}">${options.timelineFeedback === null || options.timelineFeedback === undefined ? '' : `<p data-papers-visual-key="timekeeping-gantt-feedback" data-gantt-feedback="${escapeHtml(options.timelineWrites?.code ?? '')}">${escapeHtml(options.timelineFeedback)}</p>`}${rows || '<p class="empty-state" data-papers-visual-key="timekeeping-gantt-empty">No task starts or deadlines fall in this window.</p>'}</div></section>`;
}

function renderCountdowns(
  options: TimekeepingCockpitRenderOptions,
): string {
  const entries = countdownProjection(options.tasks, options.now);
  const tasksById = new Map(options.tasks.map((task) => [task.id, task]));

  const buckets = COUNTDOWN_BUCKETS.map(({ bucket, title }) => {
    const bucketEntries = entries.filter((entry) => entry.bucket === bucket);

    return `<section class="timekeeping-countdown-bucket" data-countdown-bucket="${bucket}" data-countdown-count="${bucketEntries.length}" data-papers-visual-key="timekeeping-countdown-bucket-${bucket}" aria-label="${escapeHtml(title)}"><header><strong>${escapeHtml(title)}</strong><span>${bucketEntries.length}</span></header><div class="timekeeping-countdown-items">${bucketEntries.map((entry) => {
      const task = tasksById.get(entry.taskId);
      if (!task) return '';

      return `<article class="event-card timekeeping-countdown-task${bucket === 'overdue' ? ' task-overdue' : ''}" role="button" tabindex="0" data-timekeeping-action="open-task" data-timekeeping-task-id="${escapeHtml(task.id)}" data-countdown-deadline="${escapeHtml(entry.deadline)}" data-countdown-bucket="${bucket}" data-papers-visual-key="timekeeping-countdown-task-${escapeHtml(task.id)}" style="background-color:${deadlineHue(entry.remainingMs)}"><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(projectName(options.projectNames, task))}</small><small data-papers-visual-key="timekeeping-countdown-value-${escapeHtml(task.id)}">${escapeHtml(countdownLabel(entry.remainingMs))}</small></article>`;
    }).join('')}</div></section>`;
  }).join('');

  return `<section class="timekeeping-panel project-details" data-papers-visual-key="timekeeping-panel-countdowns" aria-label="Countdowns"><header class="surface-header"><div><h3>Countdowns</h3><p class="surface-description">Live task deadline pressure from the current clock.</p></div></header><div class="timekeeping-countdown-buckets" data-papers-visual-key="timekeeping-countdown-buckets">${buckets}</div></section>`;
}

export function renderTimekeepingCockpit(
  options: TimekeepingCockpitRenderOptions,
): string {
  // Each panel carries the width the reader dragged it to, and the stack beside it is the only thing that
  // reads them: a width is not a fact about a task, so nothing here is written anywhere else. The resize edge
  // is a separator rather than a button, which is what it is - the same role the Backlog's column edges carry.
  const widths = options.panelWidths ?? {};
  const sized = (panel: string, body: string): string => body === ''
    ? ''
    : `<div class="timekeeping-panel" data-timekeeping-panel-slot="${panel}" data-timekeeping-panel-width="${timekeepingPanelWidth(widths, panel)}" style="width:${timekeepingPanelWidth(widths, panel)}px"><span class="timekeeping-panel-resize" role="separator" aria-orientation="vertical" data-timekeeping-panel-resize="${panel}" data-timekeeping-panel-width="${timekeepingPanelWidth(widths, panel)}" aria-label="Resize the ${panel} panel" data-papers-visual-key="timekeeping-panel-resize-${panel}"></span>${body}</div>`;
  const panels = [
    sized('calendar', options.panels.calendar ? renderCalendar(options) : ''),
    sized('timeline', options.panels.timeline ? renderTimelineGantt(options) : ''),
    sized('countdowns', options.panels.countdowns ? renderCountdowns(options) : ''),
  ].join('');

  return `<section class="surface" data-papers-visual-key="tasks-timekeeping-region" aria-label="Timekeeping"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Timekeeping</h2><p class="surface-description">Calendar, timeline and countdown workspace.</p></div><span class="surface-count">${options.tasks.length} tasks</span></header><div class="surface-switcher secondary" data-papers-visual-key="timekeeping-panel-controls" role="group" aria-label="Timekeeping panels">${panelToggle('calendar', 'Calendar', options.panels.calendar)}${panelToggle('timeline', 'Timeline/Gantt', options.panels.timeline)}${panelToggle('countdowns', 'Countdowns', options.panels.countdowns)}</div><div data-papers-visual-key="timekeeping-panel-stack">${panels || '<p class="empty-state" data-papers-visual-key="timekeeping-no-panels">No Timekeeping panels are visible.</p>'}</div>${renderTaskModal(options.state, options.selectedTaskId, options.editorDraft, { refusal: TASK_EDITOR_SAVE_REFUSAL, editorRefusal: null })}</section>`;
}

interface TimelineGestureState {
  taskId: string;
  operation: TimelineChangeOperation;
  bar: HTMLElement;
  row: HTMLElement;
  proposal: HTMLElement | null;
  startX: number;
  startY: number;
  dayWidth: number;
  originalGridColumn: string;
  originalRowTransform: string;
  originalStartDate: string | null;
  originalDeadline: string | null;
  originalStartColumn: number;
  originalSpanColumns: number;
  originalRowIndex: number;
  targetRowIndex: number;
  proposedStartDate: string | null;
  proposedDeadline: string | null;
  changed: boolean;
  valid: boolean;
}

function shiftTemporalByCivilDays(
  value: string | null,
  dayDelta: number,
): string | null {
  if (value === null) return null;

  const shifted = new Date(value);
  if (!Number.isFinite(shifted.getTime())) {
    throw new RangeError(`Invalid timeline temporal value: ${value}`);
  }

  shifted.setDate(shifted.getDate() + dayDelta);
  return shifted.toISOString();
}

function snapTimelineDayDelta(deltaX: number, dayWidth: number): number {
  if (!Number.isFinite(dayWidth) || dayWidth <= 0 || deltaX === 0) return 0;

  return Math.sign(deltaX)
    * Math.floor((Math.abs(deltaX) / dayWidth) + 0.5);
}

function timelineProposalLabel(
  startDate: string | null,
  deadline: string | null,
): string {
  const start = startDate ? localDateKey(startDate) : '—';
  const deadlineLabel = deadline ? localDateKey(deadline) : '—';
  return `${start} → ${deadlineLabel}`;
}

function clearTimelineRowTargets(root: HTMLElement): void {
  root
    .querySelectorAll<HTMLElement>('[data-gantt-row-target="true"]')
    .forEach((row) => {
      delete row.dataset.ganttRowTarget;
      row.style.outline = '';
      row.style.outlineOffset = '';
    });
}

export function startTimekeepingCountdownTicker(
  root: HTMLElement,
  refresh: () => void,
): () => void {
  const timer = globalThis.setInterval(() => {
    if (
      root.querySelector('[data-papers-visual-key="timekeeping-panel-countdowns"]')
    ) {
      refresh();
    }
  }, 1_000);

  return () => {
    globalThis.clearInterval(timer);
  };
}

export function bindTimekeepingCockpitInteractions(
  root: HTMLElement,
  handlers: TimekeepingCockpitHandlers,
): void {
  let gesture: TimelineGestureState | null = null;
  let suppressNextClickTaskId: string | null = null;
  /**
   * The panel edge being dragged, if any. The same shape the Backlog's column resize holds: the width it
   * started at, where the pointer started, and the proposal it has reached. Nothing here is written anywhere -
   * the reported width is clamped by the pure helper and handed to the shell's view state.
   */
  let panelResize: { panel: TimekeepingPanel; startX: number; startWidth: number; width: number } | null = null;

  const restoreGestureGeometry = (state: TimelineGestureState): void => {
    state.bar.style.gridColumn = state.originalGridColumn;
    state.bar.style.opacity = '';
    state.bar.style.cursor = 'grab';
    state.row.style.transform = state.originalRowTransform;

    delete state.bar.dataset.ganttPickup;
    delete state.bar.dataset.ganttInvalid;
    delete state.bar.dataset.ganttProposedStart;
    delete state.bar.dataset.ganttProposedDeadline;
    delete state.bar.dataset.ganttPreviewStartColumn;
    delete state.bar.dataset.ganttPreviewSpanColumns;
    delete state.bar.dataset.ganttPreviewRowIndex;

    if (state.proposal) {
      state.proposal.textContent = '';
      state.proposal.style.opacity = '0';
      delete state.proposal.dataset.ganttRefusal;
    }

    clearTimelineRowTargets(root);
  };

  const updateGesturePreview = (
    state: TimelineGestureState,
    event: PointerEvent,
  ): void => {
    const dayDelta = snapTimelineDayDelta(
      event.clientX - state.startX,
      state.dayWidth,
    );

    let proposedStartDate = state.originalStartDate;
    let proposedDeadline = state.originalDeadline;
    let previewStartColumn = state.originalStartColumn;
    let previewSpanColumns = state.originalSpanColumns;

    if (state.operation === 'move') {
      proposedStartDate = shiftTemporalByCivilDays(
        state.originalStartDate,
        dayDelta,
      );
      proposedDeadline = shiftTemporalByCivilDays(
        state.originalDeadline,
        dayDelta,
      );
      previewStartColumn += dayDelta;
    } else if (state.operation === 'resize-start') {
      proposedStartDate = shiftTemporalByCivilDays(
        state.originalStartDate,
        dayDelta,
      );
      previewStartColumn += dayDelta;
      previewSpanColumns -= dayDelta;
    } else {
      proposedDeadline = shiftTemporalByCivilDays(
        state.originalDeadline,
        dayDelta,
      );
      previewSpanColumns += dayDelta;
    }

    let targetRowIndex = state.originalRowIndex;

    if (state.operation === 'move') {
      const targetRow = (event.target as HTMLElement)
        .closest<HTMLElement>('[data-gantt-row-index]');

      if (targetRow) {
        const candidateRowIndex = Number(targetRow.dataset.ganttRowIndex);

        if (
          Number.isInteger(candidateRowIndex)
          && candidateRowIndex >= 0
        ) {
          targetRowIndex = candidateRowIndex;
          clearTimelineRowTargets(root);
          targetRow.dataset.ganttRowTarget = 'true';
          targetRow.style.outline = '2px solid currentColor';
          targetRow.style.outlineOffset = '2px';
        }
      }

      state.row.style.transform = `translateY(${event.clientY - state.startY}px)`;
    } else {
      state.row.style.transform = state.originalRowTransform;
      clearTimelineRowTargets(root);
    }

    const proposedStartKey = proposedStartDate
      ? localDateKey(proposedStartDate)
      : null;
    const proposedDeadlineKey = proposedDeadline
      ? localDateKey(proposedDeadline)
      : null;
    const validTemporalOrder = (
      proposedStartKey === null
      || proposedDeadlineKey === null
      || civilDayOrdinal(proposedStartKey) <= civilDayOrdinal(proposedDeadlineKey)
    );
    const valid = previewSpanColumns >= 1 && validTemporalOrder;

    state.targetRowIndex = targetRowIndex;
    state.proposedStartDate = proposedStartDate;
    state.proposedDeadline = proposedDeadline;
    state.changed = (
      dayDelta !== 0
      || (
        state.operation === 'move'
        && targetRowIndex !== state.originalRowIndex
      )
    );
    state.valid = valid;

    state.bar.dataset.ganttPreviewRowIndex = String(targetRowIndex);

    if (!valid) {
      state.bar.dataset.ganttInvalid = 'true';

      if (state.proposal) {
        state.proposal.textContent = `Invalid: ${timelineProposalLabel(proposedStartDate, proposedDeadline)}`;
        state.proposal.style.opacity = '1';
      }

      return;
    }

    delete state.bar.dataset.ganttInvalid;

    state.bar.style.gridColumn = `${previewStartColumn} / span ${previewSpanColumns}`;
    state.bar.dataset.ganttProposedStart = proposedStartDate ?? '';
    state.bar.dataset.ganttProposedDeadline = proposedDeadline ?? '';
    state.bar.dataset.ganttPreviewStartColumn = String(previewStartColumn);
    state.bar.dataset.ganttPreviewSpanColumns = String(previewSpanColumns);

    if (state.proposal) {
      state.proposal.textContent = `Proposed: ${timelineProposalLabel(proposedStartDate, proposedDeadline)}`;
      state.proposal.style.opacity = '1';
    }
  };

  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-timekeeping-action]');

    if (!control) return;

    if (control.dataset.timekeepingAction === 'open-task') {
      const taskId = control.dataset.timekeepingTaskId;
      if (!taskId) return;

      if (suppressNextClickTaskId === taskId) {
        suppressNextClickTaskId = null;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      handlers.openTask(taskId);
      return;
    }

    if (control.dataset.timekeepingAction === 'panel-set-visible') {
      const panel = control.dataset.timekeepingPanel;
      const visible = control.dataset.timekeepingVisible;

      if (
        panel !== 'calendar'
        && panel !== 'timeline'
        && panel !== 'countdowns'
      ) return;

      if (visible !== 'true' && visible !== 'false') return;

      handlers.setPanelVisible(panel, visible === 'true');
      return;
    }

    if (control.dataset.timekeepingAction === 'month-navigate') {
      const direction = control.dataset.direction;

      if (direction !== 'previous' && direction !== 'next') return;

      handlers.navigateMonth(direction);
      return;
    }

    if (control.dataset.timekeepingAction === 'month-today') {
      handlers.today();
    }
  });

  // A panel edge is dragged, not clicked, so these three are bound only where a shell supplied the handler:
  // a harness that does not care how wide a panel is has no edge to drag rather than an edge that does nothing.
  if (handlers.resizePanel !== undefined) {
    const resizePanel = handlers.resizePanel;
    root.addEventListener('pointerdown', (event) => {
      const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-timekeeping-panel-resize]');
      if (!edge || !root.contains(edge)) return;

      const panel = edge.dataset.timekeepingPanelResize;
      if (panel !== 'calendar' && panel !== 'timeline' && panel !== 'countdowns') return;

      const startWidth = Number(edge.dataset.timekeepingPanelWidth);
      panelResize = {
        panel,
        startX: event.clientX,
        startWidth: Number.isFinite(startWidth) ? startWidth : 0,
        width: Number.isFinite(startWidth) ? startWidth : 0,
      };
      event.preventDefault();
    });

    root.addEventListener('pointermove', (event) => {
      if (panelResize === null) return;
      panelResize.width = panelResize.startWidth + (event.clientX - panelResize.startX);
      event.preventDefault();
    });

    // The width is reported on release rather than per move: a surface that redrew on every pixel would be
    // doing twelve redraws a second to show the same drag, which is what the Backlog's resize also avoids.
    root.addEventListener('pointerup', () => {
      if (panelResize === null) return;
      const finished = panelResize;
      panelResize = null;
      resizePanel(finished.panel, finished.width);
    });
  }

  root.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const bar = target.closest<HTMLElement>('[data-gantt-task-id]');
    if (!bar) return;

    const row = bar.closest<HTMLElement>('[data-gantt-row-index]');
    const track = bar.closest<HTMLElement>('.timekeeping-gantt-track');
    const taskId = bar.dataset.ganttTaskId;
    const originalStartColumn = Number(bar.dataset.ganttStartColumn);
    const originalSpanColumns = Number(bar.dataset.ganttSpanColumns);
    const originalRowIndex = row
      ? Number(row.dataset.ganttRowIndex)
      : Number.NaN;

    if (
      !row
      || !track
      || !taskId
      || !Number.isInteger(originalStartColumn)
      || !Number.isInteger(originalSpanColumns)
      || originalSpanColumns < 1
      || !Number.isInteger(originalRowIndex)
      || originalRowIndex < 0
    ) {
      return;
    }

    const trackWidth = track.getBoundingClientRect().width;
    if (!Number.isFinite(trackWidth) || trackWidth <= 0) return;

    const edge = target.closest<HTMLElement>('[data-gantt-edge]')
      ?.dataset.ganttEdge;
    const operation: TimelineChangeOperation = (
      event.shiftKey && edge === 'start'
    )
      ? 'resize-start'
      : (
          event.shiftKey && edge === 'end'
            ? 'resize-end'
            : 'move'
        );

    const originalStartDate = bar.dataset.ganttStartValue || null;
    const originalDeadline = bar.dataset.ganttDeadlineValue || null;

    if (
      (operation === 'resize-start' && originalStartDate === null)
      || (operation === 'resize-end' && originalDeadline === null)
    ) {
      return;
    }

    const proposal = Array.from(
      root.querySelectorAll<HTMLElement>('[data-gantt-proposal-for]'),
    ).find(
      (candidate) => candidate.dataset.ganttProposalFor === taskId,
    ) ?? null;

    delete bar.dataset.ganttRefusal;
    if (proposal) {
      proposal.textContent = '';
      proposal.style.opacity = '0';
      delete proposal.dataset.ganttRefusal;
    }

    gesture = {
      taskId,
      operation,
      bar,
      row,
      proposal,
      startX: event.clientX,
      startY: event.clientY,
      dayWidth: trackWidth / 42,
      originalGridColumn: bar.style.gridColumn,
      originalRowTransform: row.style.transform,
      originalStartDate,
      originalDeadline,
      originalStartColumn,
      originalSpanColumns,
      originalRowIndex,
      targetRowIndex: originalRowIndex,
      proposedStartDate: originalStartDate,
      proposedDeadline: originalDeadline,
      changed: false,
      valid: true,
    };

    bar.dataset.ganttPickup = 'true';
    bar.style.opacity = '0.7';
    bar.style.cursor = operation === 'move' ? 'grabbing' : 'col-resize';
  });

  root.addEventListener('pointermove', (event) => {
    if (!gesture) return;

    event.preventDefault();
    updateGesturePreview(gesture, event);
  });

  root.addEventListener('pointerup', (event) => {
    if (!gesture) return;

    const finished = gesture;
    updateGesturePreview(finished, event);
    gesture = null;

    if (!finished.changed) {
      restoreGestureGeometry(finished);
      return;
    }

    suppressNextClickTaskId = finished.taskId;

    if (!finished.valid) {
      restoreGestureGeometry(finished);
      return;
    }

    // The bar goes back to the geometry the surface was rendering, and the shell's answer —
    // accepted or refused — arrives as the next render. A lost race re-reads first, which is what
    // puts the bar where the store says it is rather than where the pointer left it.
    restoreGestureGeometry(finished);

    handlers.changeTask({
      taskId: finished.taskId,
      operation: finished.operation,
      proposedStartDate: finished.proposedStartDate,
      proposedDeadline: finished.proposedDeadline,
      targetRowIndex: finished.targetRowIndex,
    });
  });
}