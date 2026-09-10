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

function renderReservedPanel(
  panel: 'timeline' | 'countdowns',
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
      ? renderReservedPanel('timeline', 'Timeline/Gantt')
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
