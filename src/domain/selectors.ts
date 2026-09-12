/**
 * Derived reads over ProximaState. Pure functions, no stores, so the same
 * selectors serve the UI, the tests and the agent inspection projection.
 */
import { columnOf } from './elastic.js';
import { civilDateKey, localDateKey, nextCivilDate, parseCivilDate, type CivilDate } from './time.js';
import { utcZone, type TimeZone } from './timeZone.js';
import type { LoadProblem } from './problems.js';
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

/** Maximum number of local calendar buckets one event may expand into. */
export const MAX_CALENDAR_EVENT_DAYS = 36_600;

export function activeProjects(projects: Project[]): Project[] {
  return projects.filter((p) => p.status === 'active');
}

export interface ProjectCapabilities {
  readonly taskBoard: boolean;
  readonly schedule: boolean;
  readonly notes: boolean;
}

/**
 * Project capabilities come from the data and workspace configuration currently
 * available for that project. The legacy projectType label is deliberately absent.
 */
export function projectCapabilities(
  state: ProximaState,
  projectId: string,
): ProjectCapabilities {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project || project.status !== 'active') {
    return {
      taskBoard: false,
      schedule: false,
      notes: false,
    };
  }
  return {
    taskBoard: state.tasks.some((task) => task.projectId === projectId),
    schedule: state.events.some((event) => event.projectId === projectId),
    notes: project.linkedFolders.length > 0,
  };
}

/**
 * Compatibility helper retained for pre-A4 callers.
 *
 * `kind` no longer filters anything: legacy projectType is import/presentation
 * metadata, not surface authority. Capability-aware consumers use
 * projectCapabilities instead.
 */
export function projectsFor(
  projects: Project[],
  _kind: 'task' | 'schedule',
): Project[] {
  return activeProjects(projects);
}

/**
 * A project selection is valid on either task or calendar surfaces while the
 * project is active. Its former task/schedule label does not gate visibility.
 */
export function reconcileSelection(
  projects: Project[],
  selection: ProjectSelection,
  _surface: 'board' | 'calendar',
): ProjectSelection {
  if (selection === ALL_PROJECTS || selection === UNCATEGORISED) return selection;
  const project = projects.find((p) => p.id === selection);
  if (!project) return ALL_PROJECTS;
  return project.status === 'active' ? selection : ALL_PROJECTS;
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
export function eventsByDay(events: CalendarEvent[], problems: LoadProblem[] = [], zone: TimeZone = utcZone()): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    for (const key of daysCovered(event, problems, zone)) {
      const bucket = byDay.get(key);
      if (bucket) bucket.push(event);
      else byDay.set(key, [event]);
    }
  }
  return byDay;
}

function daysCovered(event: CalendarEvent, problems: LoadProblem[], zone: TimeZone): string[] {
  const startCivil = parseCivilDate(event.startDate);
  const endValue = event.deadline || event.startDate;
  const endCivil = parseCivilDate(endValue);
  const startInstant = startCivil ? null : new Date(event.startDate);
  if (!startCivil && Number.isNaN(startInstant!.getTime())) return [];
  const startKey = startCivil ? civilDateKey(startCivil) : localDateKey(startInstant!, zone);
  const endInstant = endCivil ? null : new Date(endValue);
  if (!endCivil && Number.isNaN(endInstant!.getTime())) return [startKey];
  const endKey = endCivil ? civilDateKey(endCivil) : localDateKey(endInstant!, zone);
  if (endKey < startKey) return [startKey];

  const keys: string[] = [];
  let cursor: CivilDate = startCivil ?? parseCivilDate(startKey)!;
  const last = endCivil ?? parseCivilDate(endKey)!;
  // Date validation happens before this selector. Derive the complete finite range;
  // silently truncating a long creator event would invent an earlier end date.
  const lastKey = civilDateKey(last);
  for (let day = 0; civilDateKey(cursor) <= lastKey; day += 1) {
    if (day >= MAX_CALENDAR_EVENT_DAYS) {
      problems.push({
        code: 'event-span-too-large',
        severity: 'warning',
        path: event.source.path,
        kind: 'event',
        id: event.id,
        detail: `event spans more than ${MAX_CALENDAR_EVENT_DAYS} local calendar days; calendar expansion omitted.`,
      });
      return [];
    }
    keys.push(civilDateKey(cursor));
    if (civilDateKey(cursor) === lastKey) break;
    cursor = nextCivilDate(cursor);
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
