/**
 * Derived reads over ProximaState. Pure functions, no stores, so the same
 * selectors serve the UI, the tests and the agent inspection projection.
 */
import { columnOf } from './elastic.js';
import { localDateKey } from './time.js';
import type { CalendarEvent, ElasticColumn, Project, ProximaState, StatusDefinition, Task } from './types.js';

/** Sentinel project selections used by the project picker. */
export const ALL_PROJECTS = 'all';
export const UNCATEGORISED = '';

export type ProjectSelection = string;

export function tasksForSelection(tasks: Task[], selection: ProjectSelection): Task[] {
  if (selection === ALL_PROJECTS) return tasks;
  if (selection === UNCATEGORISED) return tasks.filter((t) => !t.projectId);
  return tasks.filter((t) => t.projectId === selection);
}

export function eventsForSelection(events: CalendarEvent[], selection: ProjectSelection): CalendarEvent[] {
  if (selection === ALL_PROJECTS) return events;
  if (selection === UNCATEGORISED) return events.filter((e) => !e.projectId);
  return events.filter((e) => e.projectId === selection);
}

export function activeProjects(projects: Project[]): Project[] {
  return projects.filter((p) => p.status === 'active');
}

/** Task projects feed the Elastic board; schedule projects feed the calendar. */
export function projectsFor(projects: Project[], kind: 'task' | 'schedule'): Project[] {
  return activeProjects(projects).filter((p) => p.projectType === kind);
}

/**
 * A selection is only valid for the surface showing it. Selecting a schedule
 * project and switching to the board must not leak a project the board cannot
 * show — the original guarded this reactively; here it is one honest function.
 */
export function reconcileSelection(
  projects: Project[],
  selection: ProjectSelection,
  surface: 'board' | 'calendar',
): ProjectSelection {
  if (selection === ALL_PROJECTS || selection === UNCATEGORISED) return selection;
  const project = projects.find((p) => p.id === selection);
  if (!project) return ALL_PROJECTS;
  const wanted = surface === 'calendar' ? 'schedule' : 'task';
  return project.projectType === wanted ? selection : ALL_PROJECTS;
}

export interface ElasticBoard {
  backlog: Task[];
  running: Task[];
  finished: Task[];
}

export function elasticBoard(
  tasks: Task[],
  statuses: StatusDefinition[],
): ElasticBoard {
  const board: ElasticBoard = { backlog: [], running: [], finished: [] };
  for (const task of tasks) board[columnOf(task, statuses)].push(task);
  const byOrder = (a: Task, b: Task) => (Number(a.orderIndex) || 0) - (Number(b.orderIndex) || 0);
  board.backlog.sort(byOrder);
  board.running.sort(byOrder);
  board.finished.sort(byOrder);
  return board;
}

export function columnCounts(board: ElasticBoard): Record<ElasticColumn, number> {
  return { backlog: board.backlog.length, running: board.running.length, finished: board.finished.length };
}

/**
 * Events grouped by the local calendar day they start on. Multi-day events appear
 * on every day they cover, which is what a month grid needs.
 */
export function eventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    for (const key of daysCovered(event)) {
      const bucket = byDay.get(key);
      if (bucket) bucket.push(event);
      else byDay.set(key, [event]);
    }
  }
  return byDay;
}

function daysCovered(event: CalendarEvent): string[] {
  const start = new Date(event.startDate);
  const end = new Date(event.deadline || event.startDate);
  if (Number.isNaN(start.getTime())) return [];
  if (Number.isNaN(end.getTime()) || end < start) return [localDateKey(start)];

  const keys: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  // Guard against a pathological range producing an unbounded list.
  for (let i = 0; cursor <= last && i < 3660; i += 1) {
    keys.push(localDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** Tasks with a deadline, soonest first. Undated tasks are not deadlines. */
export function upcomingDeadlines(tasks: Task[], now: number, withinDays = 30): Task[] {
  const horizon = now + withinDays * 86400000;
  return tasks
    .filter((t) => !t.isCompleted && t.deadline)
    .filter((t) => {
      const at = new Date(t.deadline as string).getTime();
      return !Number.isNaN(at) && at <= horizon;
    })
    .sort(
      (a, b) => new Date(a.deadline as string).getTime() - new Date(b.deadline as string).getTime(),
    );
}

export function projectById(state: ProximaState, id: string | null): Project | undefined {
  if (!id) return undefined;
  return state.projects.find((p) => p.id === id);
}
