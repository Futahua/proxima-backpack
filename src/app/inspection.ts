import { calculateElasticTimeline, elasticCardHeights } from '../domain/elastic.js';
import { isBlocking, type LoadProblem } from '../domain/problems.js';
import { elasticBoard, eventsByDay, eventsForSelection, projectsFor, tasksForSelection, type ProjectSelection } from '../domain/selectors.js';
import { localDateKey } from '../domain/time.js';
import type { CalendarEvent, ProximaState, Task } from '../domain/types.js';
import type { ActionDispatcherState, Surface } from './actionProtocol.js';
import { sourceProvenance, type ReadOnlyProjectionHealth, type RecordProvenance } from './readOnlyProjection.js';
import { createUiHealthModel, type UiHealthModel } from './uiHealth.js';

export const INSPECTION_SCHEMA_VERSION = 1 as const;
export const MAX_INSPECTION_ITEMS = 500;
export const MAX_INSPECTION_TEXT = 400;

export interface BuildIdentityLike {
  proximaVersion: string;
  gitSha: string;
  buildMode: string;
  domainSchemaVersion: string;
  controlSchemaVersion: string;
  fixtureSchemaVersion: string;
  fixtureHash: string;
  lockfileHash: string;
  fixedClock: string;
}

export interface InspectionProjection {
  schemaVersion: typeof INSPECTION_SCHEMA_VERSION;
  build: BuildIdentityLike;
  mode: 'fixture' | 'live';
  applicationStateRevision: number;
  surface: Surface;
  selection: ProjectSelection;
  projects: Array<{ id: string; name: string; projectType: 'task' | 'schedule'; status: string; provenance: RecordProvenance }>;
  board: { counts: { backlog: number; running: number; finished: number }; tasks: Array<{ id: string; name: string; projectId: string | null; column: string; deadline: string | null; durationMinutes: number | null; provenance: RecordProvenance }> };
  calendar: { cursorMonth: string; events: Array<{ id: string; name: string; projectId: string | null; startDate: string; deadline: string; dayKeys: string[]; provenance: RecordProvenance }> };
  loadProblems: Array<{ code: string; severity: string; id?: string; path?: string; detail: string }>;
  sourceRevisions: Array<{ kind: string; id: string; revision: string; path?: string }>;
  pendingOperations: string[];
  degraded: { state: 'healthy' | 'degraded'; blockingProblemCount: number };
  sourceHealth: UiHealthModel;
  latestEventSequence: number;
  settled: { state: 'settled' | 'busy'; revision: number };
}

function safeText(value: string, limit = MAX_INSPECTION_TEXT): string { return value.slice(0, limit); }

function safeProblem(problem: LoadProblem, mode: 'fixture' | 'live'): InspectionProjection['loadProblems'][number] {
  const path = mode === 'fixture' ? safeText(problem.path.replaceAll('\\', '/'), 260) : undefined;
  return { code: problem.code, severity: problem.severity, ...(problem.id ? { id: safeText(problem.id) } : {}), ...(path ? { path } : {}), detail: safeText(problem.detail) };
}

function taskDuration(task: Task): number | null {
  if (!task.deadline) return null;
  const now = new Date('2026-09-06T12:00:00.000Z');
  const deadline = new Date(task.deadline);
  if (!Number.isFinite(deadline.getTime())) return null;
  const timeline = calculateElasticTimeline([task], now, deadline);
  const slice = timeline[0];
  return slice ? Math.round(slice.duration) : (task.isFixedDuration ? task.fixedDuration : null);
}

function sourceRevisions(state: ProximaState, dispatcher: ActionDispatcherState): InspectionProjection['sourceRevisions'] {
  const records = [
    ...state.projects.map((record) => ({ kind: 'project', id: record.id, source: record.source })),
    ...state.tasks.map((record) => ({ kind: 'task', id: record.id, source: record.source })),
    ...state.events.map((record) => ({ kind: 'event', id: record.id, source: record.source })),
  ];
  return records.slice(0, MAX_INSPECTION_ITEMS).map(({ kind, id, source }) => ({ kind, id: safeText(id), revision: safeText(dispatcher.revisions[source.path] ?? source.revision), ...(dispatcher.mode === 'fixture' ? { path: safeText(source.path.replaceAll('\\', '/'), 260) } : {}) }));
}

function eventDayKeysById(byDay: Map<string, CalendarEvent[]>): Map<string, string[]> {
  const dayKeysById = new Map<string, string[]>();
  for (const [key, events] of byDay) {
    for (const candidate of events) {
      const keys = dayKeysById.get(candidate.id);
      if (keys) keys.push(key);
      else dayKeysById.set(candidate.id, [key]);
    }
  }
  return dayKeysById;
}

function eventSummary(event: CalendarEvent, dayKeysById: Map<string, string[]>): InspectionProjection['calendar']['events'][number] {
  const dayKeys = dayKeysById.get(event.id) ?? [];
  return { id: event.id, name: event.name, projectId: event.projectId, startDate: event.startDate, deadline: event.deadline, dayKeys, provenance: sourceProvenance(event) };
}

/** Build a bounded, renderer-independent, read-only state projection. */
export function createInspectionProjection(dispatcher: ActionDispatcherState, build: BuildIdentityLike, sourceHealth?: ReadOnlyProjectionHealth): InspectionProjection {
  const boardProjects = new Set(projectsFor(dispatcher.state.projects, 'task').map((project) => project.id));
  const boardTasks = dispatcher.state.tasks.filter((task) => task.projectId === null || boardProjects.has(task.projectId));
  const selectedTasks = tasksForSelection(boardTasks, dispatcher.selection);
  const board = elasticBoard(selectedTasks, dispatcher.state.statuses);
  const boardGroups: Array<[keyof typeof board, Task[]]> = [['backlog', board.backlog], ['running', board.running], ['finished', board.finished]];
  const now = new Date(build.fixedClock);
  const firstDeadline = board.running.map((task) => task.deadline ? new Date(task.deadline) : null).filter((date): date is Date => date !== null && Number.isFinite(date.getTime()) && date.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime())[0] ?? new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const heights = elasticCardHeights(board.running, calculateElasticTimeline(board.running, now, firstDeadline), 460);
  const taskSummaries = boardGroups.flatMap(([column, tasks]) => tasks.map((task) => ({ id: task.id, name: task.name, projectId: task.projectId, column, deadline: task.deadline, durationMinutes: column === 'running' ? Math.round(heights[task.id] ?? taskDuration(task) ?? 0) : taskDuration(task), provenance: sourceProvenance(task) })));
  const scheduleProjects = new Set(projectsFor(dispatcher.state.projects, 'schedule').map((project) => project.id));
  const calendarEvents = eventsForSelection(dispatcher.state.events.filter((event) => event.projectId === null || scheduleProjects.has(event.projectId)), dispatcher.selection);
  const calendarProblems: LoadProblem[] = [];
  const byDay = eventsByDay(calendarEvents, calendarProblems);
  const dayKeysById = eventDayKeysById(byDay);
  const problems = [...dispatcher.problems, ...calendarProblems];
  const health = createUiHealthModel(sourceHealth ?? {
    sourceRevision: 1,
    applicationRevision: dispatcher.stateRevision,
    stale: false,
    degraded: problems.some(isBlocking),
    lastSuccessfulRefreshRevision: 1,
    lastRefreshReason: null,
    problemCodes: [...new Set(problems.map((problem) => problem.code))].slice(0, 20),
  });
  return {
    schemaVersion: INSPECTION_SCHEMA_VERSION,
    build,
    mode: dispatcher.mode,
    applicationStateRevision: dispatcher.stateRevision,
    surface: dispatcher.surface,
    selection: dispatcher.selection,
    projects: dispatcher.state.projects.map((project) => ({ id: safeText(project.id), name: safeText(project.name), projectType: project.projectType, status: project.status, provenance: sourceProvenance(project) })).sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_INSPECTION_ITEMS),
    board: { counts: { backlog: board.backlog.length, running: board.running.length, finished: board.finished.length }, tasks: taskSummaries.slice(0, MAX_INSPECTION_ITEMS).map((task) => ({ ...task, id: safeText(task.id), name: safeText(task.name), provenance: { ...task.provenance, logicalId: safeText(task.provenance.logicalId), sourceRevision: safeText(task.provenance.sourceRevision) } })) },
    calendar: { cursorMonth: dispatcher.calendarMonth, events: calendarEvents.map((event) => eventSummary(event, dayKeysById)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_INSPECTION_ITEMS).map((event) => ({ ...event, id: safeText(event.id), name: safeText(event.name) })) },
    loadProblems: problems.slice(0, MAX_INSPECTION_ITEMS).map((problem) => safeProblem(problem, dispatcher.mode)),
    sourceRevisions: sourceRevisions(dispatcher.state, dispatcher),
    pendingOperations: [],
    degraded: { state: problems.some(isBlocking) || health.degraded ? 'degraded' : 'healthy', blockingProblemCount: problems.filter(isBlocking).length },
    sourceHealth: health,
    latestEventSequence: dispatcher.latestEventSequence,
    settled: { state: dispatcher.settled ? 'settled' : 'busy', revision: dispatcher.settledRevision },
  };
}

export function isInspectionProjection(value: unknown): value is InspectionProjection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InspectionProjection>;
  return candidate.schemaVersion === INSPECTION_SCHEMA_VERSION && typeof candidate.applicationStateRevision === 'number' && (candidate.mode === 'fixture' || candidate.mode === 'live') && (candidate.surface === 'board' || candidate.surface === 'calendar') && Array.isArray(candidate.projects) && Array.isArray(candidate.board?.tasks) && Array.isArray(candidate.calendar?.events) && Array.isArray(candidate.loadProblems) && Array.isArray(candidate.sourceRevisions) && Array.isArray(candidate.pendingOperations);
}
