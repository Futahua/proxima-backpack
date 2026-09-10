import type {
  TimekeepingPanel,
  TimekeepingPanelVisibility,
} from '../app/actionProtocol.js';
import { deadlineHue, localDateKey } from '../domain/time.js';
import type { ProximaState, Task } from '../domain/types.js';
import { calendarGridDates } from './calendarGrid.js';
import { renderTaskModal } from './elasticCockpit.js';

export interface DeadlineCalendarEntry {
  taskId: string;
  dayKey: string;
  deadline: string;
  remainingMs: number;
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
  calendarCursor: Date;
  now: Date;
  selectedTaskId: string | null;
}

export interface TimekeepingCockpitHandlers {
  setPanelVisible(panel: TimekeepingPanel, visible: boolean): void;
  navigateMonth(direction: 'previous' | 'next'): void;
  today(): void;
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

function panelToggle(
  panel: TimekeepingPanel,
  label: string,
  visible: boolean,
): string {
  return `<button type="button" class="surface-tab${visible ? ' selected' : ''}" data-timekeeping-action="panel-set-visible" data-timekeeping-panel="${panel}" data-timekeeping-visible="${visible ? 'false' : 'true'}" data-c1-key="timekeeping-panel-toggle-${panel}" aria-pressed="${visible}">${label}</button>`;
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

  return `<article class="${classes}" role="button" tabindex="0" data-elastic-action="open-task" data-elastic-task-id="${escapeHtml(task.id)}" data-deadline-overdue="${overdue ? 'true' : 'false'}" data-c1-key="timekeeping-calendar-task-${escapeHtml(task.id)}"${style}><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(meta)}</small></article>`;
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

  return `<section class="timekeeping-panel calendar-surface" data-c1-key="timekeeping-panel-calendar" aria-label="Deadline Calendar"><header class="surface-header"><div><h3>Deadline Calendar</h3><p class="surface-description">Task deadlines, separate from Schedule events.</p></div><div class="calendar-controls"><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="previous" data-c1-key="timekeeping-calendar-previous" aria-label="Previous month">←</button><button type="button" class="icon-button" data-timekeeping-action="month-today" data-c1-key="timekeeping-calendar-today">Today</button><strong data-c1-key="timekeeping-calendar-month" data-calendar-month="${monthKey(options.calendarCursor)}">${escapeHtml(monthTitle(options.calendarCursor))}</strong><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="next" data-c1-key="timekeeping-calendar-next" aria-label="Next month">→</button></div></header><div class="weekday-row" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${days.map((day) => {
    const key = localDateKey(day);
    const outside = day.getMonth() !== options.calendarCursor.getMonth();
    const entries = entriesByDay.get(key) ?? [];

    return `<div class="calendar-day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}" data-c1-key="timekeeping-calendar-day-${escapeHtml(key)}" data-deadline-count="${entries.length}" aria-label="${escapeHtml(key)}"${key === todayKey ? ' aria-current="date"' : ''}><span class="day-number">${day.getDate()}</span><div class="day-events">${entries.map((entry) => {
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

  const rows = entries.map((entry) => {
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

    return `<div class="timekeeping-gantt-row" data-c1-key="timekeeping-gantt-row-${escapeHtml(task.id)}"><div class="timekeeping-gantt-label"><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(projectName(options.projectNames, task))} · ${escapeHtml(temporalLabel)}</small></div><div class="timekeeping-gantt-track" style="display:grid;grid-template-columns:repeat(42,minmax(12px,1fr));position:relative;"><article class="${classes}" role="button" tabindex="0" data-elastic-action="open-task" data-elastic-task-id="${escapeHtml(task.id)}" data-gantt-kind="${entry.kind}" data-gantt-start="${escapeHtml(entry.startKey ?? '')}" data-gantt-end="${escapeHtml(entry.endKey ?? '')}" data-gantt-start-column="${entry.startColumn}" data-gantt-span-columns="${entry.spanColumns}" data-c1-key="timekeeping-gantt-task-${escapeHtml(task.id)}" style="grid-column:${entry.startColumn} / span ${entry.spanColumns};${pressureStyle}">${entry.kind === 'span' ? escapeHtml(task.name) : '◆'}</article></div></div>`;
  }).join('');

  return `<section class="timekeeping-panel project-details" data-c1-key="timekeeping-panel-timeline" aria-label="Timeline/Gantt"><header class="surface-header"><div><h3>Timeline/Gantt</h3><p class="surface-description">Task starts and deadlines across the active calendar window.</p></div><div class="calendar-controls"><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="previous" data-c1-key="timekeeping-gantt-previous" aria-label="Previous month">←</button><button type="button" class="icon-button" data-timekeeping-action="month-today" data-c1-key="timekeeping-gantt-today">Today</button><strong data-c1-key="timekeeping-gantt-month" data-calendar-month="${monthKey(options.calendarCursor)}">${escapeHtml(monthTitle(options.calendarCursor))}</strong><button type="button" class="icon-button" data-timekeeping-action="month-navigate" data-direction="next" data-c1-key="timekeeping-gantt-next" aria-label="Next month">→</button></div></header><div class="timekeeping-gantt-header" style="display:grid;grid-template-columns:220px 1fr;"><span>Task</span><div style="display:grid;grid-template-columns:repeat(42,minmax(12px,1fr));">${days.map((day) => {
    const key = localDateKey(day);
    return `<span class="${key === todayKey ? 'today' : ''}" data-c1-key="timekeeping-gantt-day-${escapeHtml(key)}" aria-current="${key === todayKey ? 'date' : 'false'}">${day.getDate()}</span>`;
  }).join('')}</div></div><div class="timekeeping-gantt-body" data-c1-key="timekeeping-gantt-body" data-gantt-today-column="${todayColumn > 0 ? todayColumn : ''}">${rows || '<p class="empty-state" data-c1-key="timekeeping-gantt-empty">No task starts or deadlines fall in this window.</p>'}</div></section>`;
}

function renderReservedPanel(
  panel: 'countdowns',
  title: string,
): string {
  return `<section class="timekeeping-panel project-details empty" data-c1-key="timekeeping-panel-${panel}" aria-label="${title}"><header><strong>${title}</strong></header></section>`;
}

export function renderTimekeepingCockpit(
  options: TimekeepingCockpitRenderOptions,
): string {
  const panels = [
    options.panels.calendar ? renderCalendar(options) : '',
    options.panels.timeline
      ? renderTimelineGantt(options)
      : '',
    options.panels.countdowns
      ? renderReservedPanel('countdowns', 'Countdowns')
      : '',
  ].join('');

  return `<section class="surface" data-c1-key="tasks-timekeeping-region" aria-label="Timekeeping"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Timekeeping</h2><p class="surface-description">Calendar, timeline and countdown workspace.</p></div><span class="surface-count">${options.tasks.length} tasks</span></header><div class="surface-switcher secondary" data-c1-key="timekeeping-panel-controls" role="group" aria-label="Timekeeping panels">${panelToggle('calendar', 'Calendar', options.panels.calendar)}${panelToggle('timeline', 'Timeline/Gantt', options.panels.timeline)}${panelToggle('countdowns', 'Countdowns', options.panels.countdowns)}</div><div data-c1-key="timekeeping-panel-stack">${panels || '<p class="empty-state" data-c1-key="timekeeping-no-panels">No Timekeeping panels are visible.</p>'}</div>${renderTaskModal(options.state, options.selectedTaskId, options.projectNames)}</section>`;
}

export function bindTimekeepingCockpitInteractions(
  root: HTMLElement,
  handlers: TimekeepingCockpitHandlers,
): void {
  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-timekeeping-action]');

    if (!control) return;

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
}
