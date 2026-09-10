import { ALL_PROJECTS, UNCATEGORISED } from '../domain/selectors.js';
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../domain/clock.js';
import type { LoadProblem } from '../domain/problems.js';
import type { ElasticColumn, ProximaState } from '../domain/types.js';
import { createEventRing, type EventRing, type ProximaEvent } from './eventRing.js';
import {
  categoryOf,
  isActionErrorCode,
  isActionOutcome,
  outcomeForErrorCode,
  type ActionCategory,
  type ActionErrorCode,
  type ActionOutcome,
  type RegisteredActionType,
} from './actionTaxonomy.js';

export type { ActionCategory, ActionErrorCode, ActionOutcome } from './actionTaxonomy.js';

/** The wire/schema version for project-owned semantic actions. */
export const ACTION_SCHEMA_VERSION = 2 as const;

export type Surface = 'tasks' | 'schedule' | 'projects' | 'canvas';
export type TasksMode = 'elastic' | 'timekeeping';
export type TimekeepingPanel = 'calendar' | 'timeline' | 'countdowns';
export type TimekeepingPanelVisibility = Record<TimekeepingPanel, boolean>;
export type TimelineChangeOperation = 'move' | 'resize-start' | 'resize-end';
export type ScheduleChangeOperation = 'move' | 'resize-end';
export type ScheduleMode = 'day' | 'four-day' | 'week' | 'month' | 'year' | 'agenda';
export type ProjectWorkspaceTab = 'notes' | 'task-board' | 'backlog' | 'deadlines' | 'schedule';

export interface ElasticSessionState {
  targetTime: string;
  lockedAt: string | null;
}

export type ProximaAction =
  | { type: 'project.select'; projectId: string }
  | { type: 'surface.select'; surface: Surface }
  | { type: 'tasks.mode.select'; mode: TasksMode }
  | { type: 'timekeeping.panel.set-visible'; panel: TimekeepingPanel; visible: boolean }
  | { type: 'task.timeline.change'; taskId: string; operation: TimelineChangeOperation; proposedStartDate: string | null; proposedDeadline: string | null; targetRowIndex: number }
  | { type: 'elastic.target.set'; targetTime: string }
  | { type: 'elastic.lock' }
  | { type: 'elastic.unlock' }
  | { type: 'task.execution.move'; taskId: string; targetColumn: ElasticColumn; targetIndex: number }
  | { type: 'event.schedule.change'; eventId: string; operation: ScheduleChangeOperation; proposedStartDate: string; proposedDeadline: string }
  | { type: 'event.schedule.create'; name: string; projectId: string | null; description: string; startDate: string; deadline: string }
  | { type: 'schedule.mode.select'; mode: ScheduleMode }
  | { type: 'schedule.cursor.set'; date: string }
  | { type: 'project.workspace-tab.select'; tab: ProjectWorkspaceTab }
  | { type: 'calendar.navigate'; direction: 'previous' | 'next' }
  | { type: 'calendar.today' }
  | { type: 'calendar.select-month'; month: string }
  | { type: 'calendar.shift-month'; delta: -1 | 1 }
  | { type: 'fixture.reset' };

const ACTION_TAXONOMY_MATCHES_PROTOCOL: [
  Exclude<ProximaAction['type'], RegisteredActionType>,
  Exclude<RegisteredActionType, ProximaAction['type']>,
] extends [never, never]
  ? true
  : never = true;
void ACTION_TAXONOMY_MATCHES_PROTOCOL;

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  field?: string;
}

export interface ActionSnapshot {
  surface: Surface;
  selection: string;
  tasksMode: TasksMode;
  timekeepingPanels: TimekeepingPanelVisibility;
  scheduleMode: ScheduleMode;
  scheduleDate: string;
  projectWorkspaceTab: ProjectWorkspaceTab;
  calendarMonth: string;
  elasticTargetTime: string;
  elasticLockedAt: string | null;
}

export interface ActionSuccess {
  schemaVersion: typeof ACTION_SCHEMA_VERSION;
  ok: true;
  actionType: ProximaAction['type'];
  /** What performing this cost. Presentation today; mutation categories arrive with the record store. */
  category: ActionCategory;
  /** Always 'accepted' on success, so one field answers "what happened" for every result. */
  outcome: Extract<ActionOutcome, 'accepted'>;
  changed: boolean;
  stateRevision: number;
  requestId: string;
  /** Records this action affected. Empty for presentation actions, never absent. */
  entityIds: string[];
  snapshot: ActionSnapshot;
}

export interface ActionFailure {
  schemaVersion: typeof ACTION_SCHEMA_VERSION;
  ok: false;
  actionType: string;
  /** 'unknown' when the action type itself was not recognised, so it has no category. */
  category: ActionCategory | 'unknown';
  outcome: Exclude<ActionOutcome, 'accepted'>;
  stateRevision: number;
  requestId: string;
  entityIds: string[];
  error: ActionError;
}

export type ActionResult = ActionSuccess | ActionFailure;

export interface ActionDispatcherState {
  state: ProximaState;
  problems: LoadProblem[];
  revisions: Record<string, string>;
  mode: 'fixture' | 'live';
  surface: Surface;
  selection: string;
  tasksMode: TasksMode;
  timekeepingPanels: TimekeepingPanelVisibility;
  scheduleMode: ScheduleMode;
  scheduleDate: string;
  projectWorkspaceTab: ProjectWorkspaceTab;
  calendarMonth: string;
  elasticTargetTime: string;
  elasticLockedAt: string | null;
  stateRevision: number;
  settledRevision: number;
  settled: boolean;
  latestEventSequence: number;
  sourceRevision: number;
}

export interface ActionDispatcherOptions {
  state: ProximaState;
  problems?: LoadProblem[];
  revisions?: Record<string, string>;
  mode?: 'fixture' | 'live';
  initialSurface?: Surface;
  initialSelection?: string;
  initialTasksMode?: TasksMode;
  initialScheduleMode?: ScheduleMode;
  initialScheduleDate?: string;
  initialProjectWorkspaceTab?: ProjectWorkspaceTab;
  initialCalendarMonth?: string;
  initialElasticTargetTime?: string;
  initialElasticLockedAt?: string | null;
  clock?: Clock;
  idGenerator?: IdGenerator;
  eventCapacity?: number;
  initialSourceRevision?: number;
}

export interface ProximaActionDispatcher {
  dispatch(input: unknown): ActionResult;
  /** Atomically replace the readable source generation; never writes to the source. */
  replaceSource(input: {
    state: ProximaState;
    problems: LoadProblem[];
    revisions: Record<string, string>;
    sourceRevision: number;
  }): { changed: boolean; stateRevision: number };
  snapshot(): Readonly<ActionDispatcherState>;
  events(afterSequence?: number): ProximaEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidAction(message: string, field?: string, requestId = 'request-invalid'): ActionFailure {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: false,
    actionType: 'unknown',
    category: 'unknown',
    outcome: outcomeForErrorCode('invalid-action'),
    stateRevision: 0,
    requestId,
    entityIds: [],
    error: { code: 'invalid-action', message, field },
  };
}

/** Parse and validate the public action shape before dispatching it. */
export function parseAction(input: unknown): { ok: true; action: ProximaAction } | { ok: false; error: ActionError } {
  if (!isRecord(input) || typeof input.type !== 'string') {
    return {
      ok: false,
      error: {
        code: 'invalid-action',
        message: 'action must be an object with a string type',
        field: 'type',
      },
    };
  }

  if (input.type === 'project.select') {
    return typeof input.projectId === 'string' && input.projectId.length <= 200
      ? { ok: true, action: { type: input.type, projectId: input.projectId } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'projectId must be a bounded string',
            field: 'projectId',
          },
        };
  }

  if (input.type === 'surface.select') {
    return input.surface === 'tasks'
      || input.surface === 'schedule'
      || input.surface === 'projects'
      || input.surface === 'canvas'
      ? { ok: true, action: { type: input.type, surface: input.surface } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'surface must be tasks, schedule, projects or canvas',
            field: 'surface',
          },
        };
  }

  if (input.type === 'tasks.mode.select') {
    return input.mode === 'elastic' || input.mode === 'timekeeping'
      ? { ok: true, action: { type: input.type, mode: input.mode } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'tasks mode must be elastic or timekeeping',
            field: 'mode',
          },
        };
  }

  if (input.type === 'timekeeping.panel.set-visible') {
    if (
      input.panel !== 'calendar'
      && input.panel !== 'timeline'
      && input.panel !== 'countdowns'
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid-action-input',
          message: 'timekeeping panel must be calendar, timeline or countdowns',
          field: 'panel',
        },
      };
    }

    if (typeof input.visible !== 'boolean') {
      return {
        ok: false,
        error: {
          code: 'invalid-action-input',
          message: 'timekeeping panel visibility must be boolean',
          field: 'visible',
        },
      };
    }

    return {
      ok: true,
      action: {
        type: input.type,
        panel: input.panel,
        visible: input.visible,
      },
    };
  }

  if (input.type === 'elastic.target.set') {
    return isCanonicalInstant(input.targetTime)
      ? { ok: true, action: { type: input.type, targetTime: input.targetTime } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'targetTime must be a canonical ISO instant',
            field: 'targetTime',
          },
        };
  }

  if (input.type === 'elastic.lock' || input.type === 'elastic.unlock') {
    return { ok: true, action: { type: input.type } };
  }

  if (input.type === 'task.timeline.change') {
    if (
      typeof input.taskId !== 'string'
      || input.taskId.length === 0
      || input.taskId.length > 200
      || (
        input.operation !== 'move'
        && input.operation !== 'resize-start'
        && input.operation !== 'resize-end'
      )
      || !(
        input.proposedStartDate === null
        || (
          typeof input.proposedStartDate === 'string'
          && input.proposedStartDate.length > 0
          && input.proposedStartDate.length <= 100
          && Number.isFinite(Date.parse(input.proposedStartDate))
        )
      )
      || !(
        input.proposedDeadline === null
        || (
          typeof input.proposedDeadline === 'string'
          && input.proposedDeadline.length > 0
          && input.proposedDeadline.length <= 100
          && Number.isFinite(Date.parse(input.proposedDeadline))
        )
      )
      || (
        input.proposedStartDate === null
        && input.proposedDeadline === null
      )
      || !Number.isInteger(input.targetRowIndex)
      || Number(input.targetRowIndex) < 0
      || Number(input.targetRowIndex) > 100_000
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid-action-input',
          message: 'task timeline change requires a bounded taskId, valid operation, non-inverted temporal bounds and non-negative targetRowIndex',
        },
      };
    }

    if (
      input.proposedStartDate !== null
      && input.proposedDeadline !== null
      && Date.parse(input.proposedStartDate) > Date.parse(input.proposedDeadline)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid-action-input',
          message: 'task timeline change requires a bounded taskId, valid operation, non-inverted temporal bounds and non-negative targetRowIndex',
        },
      };
    }

    return {
      ok: true,
      action: {
        type: input.type,
        taskId: input.taskId,
        operation: input.operation,
        proposedStartDate: input.proposedStartDate,
        proposedDeadline: input.proposedDeadline,
        targetRowIndex: Number(input.targetRowIndex),
      },
    };
  }

  if (input.type === 'task.execution.move') {
    return typeof input.taskId === 'string'
      && input.taskId.length > 0
      && input.taskId.length <= 200
      && (input.targetColumn === 'backlog' || input.targetColumn === 'running' || input.targetColumn === 'finished')
      && Number.isInteger(input.targetIndex)
      && Number(input.targetIndex) >= 0
      && Number(input.targetIndex) <= 100_000
      ? {
          ok: true,
          action: {
            type: input.type,
            taskId: input.taskId,
            targetColumn: input.targetColumn,
            targetIndex: Number(input.targetIndex),
          },
        }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'task execution move requires a bounded taskId, execution column and non-negative targetIndex',
          },
        };
  }

  if (input.type === 'event.schedule.create') {
    if (
      typeof input.name !== 'string'
      || input.name.trim().length === 0
      || input.name.length > 200
      || !(
        input.projectId === null
        || (
          typeof input.projectId === 'string'
          && input.projectId.length > 0
          && input.projectId.length <= 200
        )
      )
      || typeof input.description !== 'string'
      || input.description.length > 20_000
      || !isCanonicalInstant(input.startDate)
      || !isCanonicalInstant(input.deadline)
      || Date.parse(input.startDate) >= Date.parse(input.deadline)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid-action-input',
          message: 'schedule event creation requires a bounded name and project, bounded description, canonical temporal bounds and a positive span',
        },
      };
    }
    return {
      ok: true,
      action: {
        type: input.type,
        name: input.name,
        projectId: input.projectId,
        description: input.description,
        startDate: input.startDate,
        deadline: input.deadline,
      },
    };
  }
  if (input.type === 'event.schedule.change') {
    if (
      typeof input.eventId !== 'string'
      || input.eventId.length === 0
      || input.eventId.length > 200
      || (input.operation !== 'move' && input.operation !== 'resize-end')
      || !isCanonicalInstant(input.proposedStartDate)
      || !isCanonicalInstant(input.proposedDeadline)
      || Date.parse(input.proposedStartDate) >= Date.parse(input.proposedDeadline)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid-action-input',
          message: 'schedule event change requires a bounded eventId, move or resize-end operation, canonical temporal bounds and a positive span',
        },
      };
    }

    return {
      ok: true,
      action: {
        type: input.type,
        eventId: input.eventId,
        operation: input.operation,
        proposedStartDate: input.proposedStartDate,
        proposedDeadline: input.proposedDeadline,
      },
    };
  }

  if (input.type === 'schedule.mode.select') {
    return input.mode === 'day'
      || input.mode === 'four-day'
      || input.mode === 'week'
      || input.mode === 'month'
      || input.mode === 'year'
      || input.mode === 'agenda'
      ? { ok: true, action: { type: input.type, mode: input.mode } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'schedule mode must be day, four-day, week, month, year or agenda',
            field: 'mode',
          },
        };
  }

  if (input.type === 'schedule.cursor.set') {
    return typeof input.date === 'string'
      && isValidScheduleDate(input.date)
      ? { ok: true, action: { type: input.type, date: input.date } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'schedule date must be a canonical local YYYY-MM-DD',
            field: 'date',
          },
        };
  }

  if (input.type === 'project.workspace-tab.select') {
    return input.tab === 'notes'
      || input.tab === 'task-board'
      || input.tab === 'backlog'
      || input.tab === 'deadlines'
      || input.tab === 'schedule'
      ? { ok: true, action: { type: input.type, tab: input.tab } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'project workspace tab must be notes, task-board, backlog, deadlines or schedule',
            field: 'tab',
          },
        };
  }

  if (input.type === 'calendar.navigate') {
    return input.direction === 'previous' || input.direction === 'next'
      ? { ok: true, action: { type: input.type, direction: input.direction } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'calendar direction must be previous or next',
            field: 'direction',
          },
        };
  }

  if (input.type === 'calendar.today') {
    return { ok: true, action: { type: input.type } };
  }

  if (input.type === 'calendar.select-month') {
    return typeof input.month === 'string'
      && isValidCalendarMonth(input.month)
      ? { ok: true, action: { type: input.type, month: input.month } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'calendar month must be canonical YYYY-MM-01',
            field: 'month',
          },
        };
  }

  if (input.type === 'calendar.shift-month') {
    return input.delta === -1 || input.delta === 1
      ? { ok: true, action: { type: input.type, delta: input.delta } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'delta must be -1 or 1',
            field: 'delta',
          },
        };
  }

  if (input.type === 'fixture.reset') {
    return { ok: true, action: { type: input.type } };
  }

  return {
    ok: false,
    error: {
      code: 'invalid-action',
      message: `unsupported action type: ${input.type}`,
      field: 'type',
    },
  };
}

function snapshot(state: ActionDispatcherState): ActionSnapshot {
  return {
    surface: state.surface,
    selection: state.selection,
    tasksMode: state.tasksMode,
    timekeepingPanels: { ...state.timekeepingPanels },
    scheduleMode: state.scheduleMode,
    scheduleDate: state.scheduleDate,
    projectWorkspaceTab: state.projectWorkspaceTab,
    calendarMonth: state.calendarMonth,
    elasticTargetTime: state.elasticTargetTime,
    elasticLockedAt: state.elasticLockedAt,
  };
}

function resultFor(
  state: ActionDispatcherState,
  actionType: ProximaAction['type'],
  changed: boolean,
  requestId: string,
  entityIds: string[] = [],
): ActionSuccess {
  const category = categoryOf(actionType);

  // An accepted action whose type was never registered would report a cost nobody
  // declared, so refuse to invent one rather than defaulting it to 'presentation'.
  if (category === undefined) {
    throw new Error(`action type is not registered in the taxonomy: ${actionType}`);
  }

  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: true,
    actionType,
    category,
    outcome: 'accepted',
    changed,
    stateRevision: state.stateRevision,
    requestId,
    entityIds: [...entityIds],
    snapshot: snapshot(state),
  };
}

function failureFor(
  state: ActionDispatcherState,
  actionType: string,
  error: ActionError,
  requestId: string,
  entityIds: string[] = [],
): ActionFailure {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: false,
    actionType,
    category: categoryOf(actionType) ?? 'unknown',
    outcome: outcomeForErrorCode(error.code),
    stateRevision: state.stateRevision,
    requestId,
    entityIds: [...entityIds],
    error,
  };
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function defaultElasticTargetTime(clock: Clock): string {
  return new Date(clock.now() + 4 * 60 * 60 * 1000).toISOString();
}

function defaultTimekeepingPanels(): TimekeepingPanelVisibility {
  return {
    calendar: true,
    timeline: false,
    countdowns: false,
  };
}

function isValidCalendarMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)
    && Number.isFinite(new Date(`${value}T00:00:00`).getTime());
}

function shiftCalendarMonth(value: string, delta: -1 | 1): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(value);
  if (!match) {
    return '2026-09-01';
  }

  const monthIndex = Number(match[1]) * 12 + Number(match[2]) - 1 + delta;
  const year = Math.floor(monthIndex / 12);
  if (year < 0 || year > 9999) {
    return value;
  }

  const month = monthIndex - year * 12 + 1;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`;
}

function calendarMonthForClock(clock: Clock): string {
  const date = new Date(clock.now());
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`;
}

function isValidScheduleDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);

  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function scheduleDateForClock(clock: Clock): string {
  const date = new Date(clock.now());
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

function existingSelection(projects: ProximaState['projects'], selection: string): string {
  if (selection === ALL_PROJECTS || selection === UNCATEGORISED) return selection;
  return projects.some((project) => project.id === selection) ? selection : ALL_PROJECTS;
}

function rejectAction(
  state: ActionDispatcherState,
  ring: EventRing,
  actionType: ProximaAction['type'],
  error: ActionError,
  requestId: string,
  entityIds: string[] = [],
): ActionFailure {
  const result = failureFor(state, actionType, error, requestId, entityIds);
  ring.append({
    kind: 'action.rejected',
    category: 'diagnostic',
    entityIds,
    requestId,
    actionType,
    stateRevision: state.stateRevision,
    errorCode: result.error.code,
  });
  state.latestEventSequence = ring.latestSequence();
  return result;
}

function settleLocalAction(
  state: ActionDispatcherState,
  ring: EventRing,
  actionType: ProximaAction['type'],
  changed: boolean,
  requestId: string,
  entityIds: string[] = [],
): ActionSuccess {
  ring.append({
    kind: 'action.accepted',
    category: 'domain',
    entityIds,
    requestId,
    actionType,
    stateRevision: state.stateRevision,
  });
  ring.append({
    kind: 'state.settled',
    category: 'lifecycle',
    entityIds: [],
    requestId,
    actionType,
    stateRevision: state.stateRevision,
  });
  state.settledRevision = state.stateRevision;
  state.settled = true;
  state.latestEventSequence = ring.latestSequence();
  return resultFor(state, actionType, changed, requestId, entityIds);
}

export function createActionDispatcher(options: ActionDispatcherOptions): ProximaActionDispatcher {
  const clock = options.clock ?? systemClock;
  const ids = options.idGenerator ?? randomIdGenerator();
  const ring = createEventRing({ clock, ids, capacity: options.eventCapacity });

  const state: ActionDispatcherState = {
    state: options.state,
    problems: [...(options.problems ?? [])],
    revisions: { ...(options.revisions ?? {}) },
    mode: options.mode ?? 'fixture',
    surface: options.initialSurface ?? 'tasks',
    selection: options.initialSelection ?? ALL_PROJECTS,
    tasksMode: options.initialTasksMode ?? 'elastic',
    timekeepingPanels: defaultTimekeepingPanels(),
    scheduleMode: options.initialScheduleMode ?? 'month',
    scheduleDate: typeof options.initialScheduleDate === 'string'
      && isValidScheduleDate(options.initialScheduleDate)
      ? options.initialScheduleDate
      : scheduleDateForClock(clock),
    projectWorkspaceTab: options.initialProjectWorkspaceTab ?? 'notes',
    calendarMonth: options.initialCalendarMonth ?? '2026-09-01',
    elasticTargetTime: isCanonicalInstant(options.initialElasticTargetTime)
      ? options.initialElasticTargetTime
      : defaultElasticTargetTime(clock),
    elasticLockedAt: isCanonicalInstant(options.initialElasticLockedAt)
      ? options.initialElasticLockedAt
      : null,
    stateRevision: 1,
    settledRevision: 1,
    settled: true,
    latestEventSequence: 0,
    sourceRevision: options.initialSourceRevision ?? 1,
  };

  if (!isValidCalendarMonth(state.calendarMonth)) {
    state.calendarMonth = '2026-09-01';
  }

  state.selection = existingSelection(state.state.projects, state.selection);

  return {
    dispatch(input: unknown): ActionResult {
      const requestId = ids.next('request');
      const parsed = parseAction(input);

      if (!parsed.ok) {
        const result = failureFor(
          state,
          isRecord(input) && typeof input.type === 'string' ? input.type : 'unknown',
          parsed.error,
          requestId,
        );

        ring.append({
          kind: 'action.rejected',
          category: 'diagnostic',
          entityIds: [],
          requestId,
          actionType: result.actionType,
          stateRevision: state.stateRevision,
          errorCode: result.error.code,
        });
        state.latestEventSequence = ring.latestSequence();
        return result;
      }

      const action = parsed.action;

      if (action.type === 'project.select') {
        if (
          action.projectId !== ALL_PROJECTS
          && action.projectId !== UNCATEGORISED
          && !state.state.projects.some((project) => project.id === action.projectId)
        ) {
          const result = failureFor(
            state,
            action.type,
            {
              code: 'project-not-found',
              message: `project does not exist: ${action.projectId}`,
              field: 'projectId',
            },
            requestId,
            [action.projectId],
          );

          ring.append({
            kind: 'action.rejected',
            category: 'diagnostic',
            entityIds: [action.projectId],
            requestId,
            actionType: action.type,
            stateRevision: state.stateRevision,
            errorCode: result.error.code,
          });
          state.latestEventSequence = ring.latestSequence();
          return result;
        }

        const changed = action.projectId !== state.selection;

        if (changed) {
          state.selection = action.projectId;
          state.stateRevision += 1;
        }

        ring.append({
          kind: 'action.accepted',
          category: 'domain',
          entityIds: [action.projectId],
          requestId,
          actionType: action.type,
          stateRevision: state.stateRevision,
        });
        ring.append({
          kind: 'state.settled',
          category: 'lifecycle',
          entityIds: [],
          requestId,
          actionType: action.type,
          stateRevision: state.stateRevision,
        });
        state.settledRevision = state.stateRevision;
        state.settled = true;
        state.latestEventSequence = ring.latestSequence();

        return resultFor(state, action.type, changed, requestId, [action.projectId]);
      }

      if (action.type === 'surface.select') {
        const changed = state.surface !== action.surface;
        if (changed) {
          state.surface = action.surface;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'tasks.mode.select') {
        const changed = state.tasksMode !== action.mode;
        if (changed) {
          state.tasksMode = action.mode;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'timekeeping.panel.set-visible') {
        const changed = state.timekeepingPanels[action.panel] !== action.visible;

        if (changed) {
          state.timekeepingPanels = {
            ...state.timekeepingPanels,
            [action.panel]: action.visible,
          };
          state.stateRevision += 1;
        }

        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'elastic.target.set') {
        if (state.elasticLockedAt !== null) {
          return rejectAction(
            state,
            ring,
            action.type,
            {
              code: 'semantic-conflict',
              message: 'unlock the Elastic run before changing its target',
              field: 'targetTime',
            },
            requestId,
          );
        }

        if (Date.parse(action.targetTime) <= clock.now()) {
          return rejectAction(
            state,
            ring,
            action.type,
            {
              code: 'invalid-action-input',
              message: 'Elastic target must be in the future',
              field: 'targetTime',
            },
            requestId,
          );
        }

        const changed = state.elasticTargetTime !== action.targetTime;
        if (changed) {
          state.elasticTargetTime = action.targetTime;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'elastic.lock') {
        if (Date.parse(state.elasticTargetTime) <= clock.now()) {
          return rejectAction(
            state,
            ring,
            action.type,
            {
              code: 'invalid-action-input',
              message: 'Elastic target must be in the future before locking',
              field: 'targetTime',
            },
            requestId,
          );
        }

        const changed = state.elasticLockedAt === null;
        if (changed) {
          state.elasticLockedAt = new Date(clock.now()).toISOString();
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'elastic.unlock') {
        const changed = state.elasticLockedAt !== null;
        if (changed) {
          state.elasticLockedAt = null;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'task.timeline.change') {
        if (!state.state.tasks.some((task) => task.id === action.taskId)) {
          return rejectAction(
            state,
            ring,
            action.type,
            {
              code: 'record-not-found',
              message: `task does not exist: ${action.taskId}`,
              field: 'taskId',
            },
            requestId,
            [action.taskId],
          );
        }

        return rejectAction(
          state,
          ring,
          action.type,
          {
            code: 'action-not-available',
            message: 'task timeline writes remain unavailable before record-store cutover',
          },
          requestId,
          [action.taskId],
        );
      }

      if (action.type === 'task.execution.move') {
        if (!state.state.tasks.some((task) => task.id === action.taskId)) {
          return rejectAction(
            state,
            ring,
            action.type,
            {
              code: 'record-not-found',
              message: `task does not exist: ${action.taskId}`,
              field: 'taskId',
            },
            requestId,
            [action.taskId],
          );
        }

        return rejectAction(
          state,
          ring,
          action.type,
          {
            code: 'action-not-available',
            message: 'task execution writes remain unavailable before record-store cutover',
          },
          requestId,
          [action.taskId],
        );
      }

      if (action.type === 'event.schedule.create') {
        return rejectAction(
          state,
          ring,
          action.type,
          {
            code: 'action-not-available',
            message: 'schedule event creation remains unavailable before record-store cutover',
          },
          requestId,
        );
      }
      if (action.type === 'event.schedule.change') {
        if (!state.state.events.some((event) => event.id === action.eventId)) {
          return rejectAction(
            state,
            ring,
            action.type,
            {
              code: 'record-not-found',
              message: `event does not exist: ${action.eventId}`,
              field: 'eventId',
            },
            requestId,
            [action.eventId],
          );
        }
        return rejectAction(
          state,
          ring,
          action.type,
          {
            code: 'action-not-available',
            message: 'schedule event writes remain unavailable before record-store cutover',
          },
          requestId,
          [action.eventId],
        );
      }

      if (action.type === 'schedule.mode.select') {
        const changed = state.scheduleMode !== action.mode;
        if (changed) {
          state.scheduleMode = action.mode;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'schedule.cursor.set') {
        const changed = state.scheduleDate !== action.date;
        if (changed) {
          state.scheduleDate = action.date;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'project.workspace-tab.select') {
        const changed = state.projectWorkspaceTab !== action.tab;
        if (changed) {
          state.projectWorkspaceTab = action.tab;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'calendar.navigate') {
        const delta = action.direction === 'previous' ? -1 : 1;
        const next = shiftCalendarMonth(state.calendarMonth, delta);
        const changed = next !== state.calendarMonth;
        if (changed) {
          state.calendarMonth = next;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'calendar.today') {
        const next = calendarMonthForClock(clock);
        const changed = next !== state.calendarMonth;
        if (changed) {
          state.calendarMonth = next;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'calendar.select-month') {
        const changed = action.month !== state.calendarMonth;
        if (changed) {
          state.calendarMonth = action.month;
          state.stateRevision += 1;
        }
        return settleLocalAction(state, ring, action.type, changed, requestId);
      }

      if (action.type === 'calendar.shift-month') {
        const next = shiftCalendarMonth(state.calendarMonth, action.delta);
        const changed = next !== state.calendarMonth;
        state.calendarMonth = next;

        if (changed) {
          state.stateRevision += 1;
        }

        ring.append({
          kind: 'action.accepted',
          category: 'domain',
          entityIds: [state.calendarMonth],
          requestId,
          actionType: action.type,
          stateRevision: state.stateRevision,
        });
        ring.append({
          kind: 'state.settled',
          category: 'lifecycle',
          entityIds: [],
          requestId,
          actionType: action.type,
          stateRevision: state.stateRevision,
        });
        state.settledRevision = state.stateRevision;
        state.settled = true;
        state.latestEventSequence = ring.latestSequence();

        return resultFor(state, action.type, changed, requestId);
      }

      if (state.mode !== 'fixture') {
        const result = failureFor(
          state,
          action.type,
          {
            code: 'action-not-available',
            message: 'fixture reset is only available in fixture mode',
          },
          requestId,
        );

        ring.append({
          kind: 'action.rejected',
          category: 'diagnostic',
          entityIds: [],
          requestId,
          actionType: action.type,
          stateRevision: state.stateRevision,
          errorCode: result.error.code,
        });
        state.latestEventSequence = ring.latestSequence();
        return result;
      }

      const resetElasticTarget = defaultElasticTargetTime(clock);
      const resetTimekeepingPanels = defaultTimekeepingPanels();
      const resetScheduleDate = scheduleDateForClock(clock);
      const changed = state.surface !== 'tasks'
        || state.selection !== ALL_PROJECTS
        || state.tasksMode !== 'elastic'
        || state.timekeepingPanels.calendar !== resetTimekeepingPanels.calendar
        || state.timekeepingPanels.timeline !== resetTimekeepingPanels.timeline
        || state.timekeepingPanels.countdowns !== resetTimekeepingPanels.countdowns
        || state.scheduleMode !== 'month'
        || state.scheduleDate !== resetScheduleDate
        || state.projectWorkspaceTab !== 'notes'
        || state.calendarMonth !== '2026-09-01'
        || state.elasticTargetTime !== resetElasticTarget
        || state.elasticLockedAt !== null;

      state.surface = 'tasks';
      state.selection = ALL_PROJECTS;
      state.tasksMode = 'elastic';
      state.timekeepingPanels = resetTimekeepingPanels;
      state.scheduleMode = 'month';
      state.scheduleDate = resetScheduleDate;
      state.projectWorkspaceTab = 'notes';
      state.calendarMonth = '2026-09-01';
      state.elasticTargetTime = resetElasticTarget;
      state.elasticLockedAt = null;

      if (changed) {
        state.stateRevision += 1;
      }

      ring.append({
        kind: 'action.accepted',
        category: 'domain',
        entityIds: [],
        requestId,
        actionType: action.type,
        stateRevision: state.stateRevision,
      });
      ring.append({
        kind: 'state.settled',
        category: 'lifecycle',
        entityIds: [],
        requestId,
        actionType: action.type,
        stateRevision: state.stateRevision,
      });
      state.settledRevision = state.stateRevision;
      state.settled = true;
      state.latestEventSequence = ring.latestSequence();

      return resultFor(state, action.type, changed, requestId);
    },

    replaceSource(input) {
      const sourceChanged = input.sourceRevision !== state.sourceRevision;
      const nextSelection = existingSelection(input.state.projects, state.selection);
      const selectionChanged = nextSelection !== state.selection;

      state.state = input.state;
      state.problems = [...input.problems];
      state.revisions = { ...input.revisions };
      state.sourceRevision = input.sourceRevision;
      state.selection = nextSelection;

      if (sourceChanged || selectionChanged) {
        state.stateRevision += 1;
      }

      state.settledRevision = state.stateRevision;
      state.settled = true;

      if (sourceChanged || selectionChanged) {
        const requestId = ids.next('refresh');

        ring.append({
          kind: 'action.accepted',
          category: 'lifecycle',
          entityIds: [],
          requestId,
          actionType: 'source.refresh',
          stateRevision: state.stateRevision,
        });
        ring.append({
          kind: 'state.settled',
          category: 'lifecycle',
          entityIds: [],
          requestId,
          actionType: 'source.refresh',
          stateRevision: state.stateRevision,
        });
        state.latestEventSequence = ring.latestSequence();
      }

      return {
        changed: sourceChanged || selectionChanged,
        stateRevision: state.stateRevision,
      };
    },

    snapshot(): Readonly<ActionDispatcherState> {
      return {
        ...state,
        problems: [...state.problems],
        revisions: { ...state.revisions },
        timekeepingPanels: { ...state.timekeepingPanels },
      };
    },

    events(afterSequence = 0): ProximaEvent[] {
      return ring.read(afterSequence);
    },
  };
}

/** Keep invalid-result construction itself visible to tests and integrations. */
export function invalidActionResult(message = 'invalid action', requestId = 'request-invalid'): ActionFailure {
  return invalidAction(message, undefined, requestId);
}

/**
 * Runtime guard for action responses crossing an agent/UI boundary.
 *
 * An agent gets to trust exactly one thing about a response: that it passed this guard.
 * So `outcome`, `category` and `entityIds` are required rather than optional - a result
 * that cannot say what happened is not a result an agent can act on.
 */
export function isActionResult(value: unknown): value is ActionResult {
  if (
    !isRecord(value)
    || value.schemaVersion !== ACTION_SCHEMA_VERSION
    || typeof value.ok !== 'boolean'
    || typeof value.stateRevision !== 'number'
    || typeof value.actionType !== 'string'
  ) {
    return false;
  }

  if (
    !Number.isInteger(value.stateRevision)
    || value.stateRevision < 0
    || typeof value.requestId !== 'string'
    || value.requestId.length === 0
    || !isActionOutcome(value.outcome)
  ) {
    return false;
  }

  if (
    !Array.isArray(value.entityIds)
    || value.entityIds.some((id) => typeof id !== 'string')
  ) {
    return false;
  }

  const expectedCategory = categoryOf(value.actionType);

  if (value.ok) {
    const snapshotValue = value.snapshot;

    return expectedCategory !== undefined
      && value.category === expectedCategory
      && value.outcome === 'accepted'
      && typeof value.changed === 'boolean'
      && isRecord(snapshotValue)
      && (
        snapshotValue.surface === 'tasks'
        || snapshotValue.surface === 'schedule'
        || snapshotValue.surface === 'projects'
        || snapshotValue.surface === 'canvas'
      )
      && typeof snapshotValue.selection === 'string'
      && (snapshotValue.tasksMode === 'elastic' || snapshotValue.tasksMode === 'timekeeping')
      && isRecord(snapshotValue.timekeepingPanels)
      && typeof snapshotValue.timekeepingPanels.calendar === 'boolean'
      && typeof snapshotValue.timekeepingPanels.timeline === 'boolean'
      && typeof snapshotValue.timekeepingPanels.countdowns === 'boolean'
      && (
        snapshotValue.scheduleMode === 'day'
        || snapshotValue.scheduleMode === 'four-day'
        || snapshotValue.scheduleMode === 'week'
        || snapshotValue.scheduleMode === 'month'
        || snapshotValue.scheduleMode === 'year'
        || snapshotValue.scheduleMode === 'agenda'
      )
      && typeof snapshotValue.scheduleDate === 'string'
      && isValidScheduleDate(snapshotValue.scheduleDate)
      && (
        snapshotValue.projectWorkspaceTab === 'notes'
        || snapshotValue.projectWorkspaceTab === 'task-board'
        || snapshotValue.projectWorkspaceTab === 'backlog'
        || snapshotValue.projectWorkspaceTab === 'deadlines'
        || snapshotValue.projectWorkspaceTab === 'schedule'
      )
      && typeof snapshotValue.calendarMonth === 'string'
      && isValidCalendarMonth(snapshotValue.calendarMonth)
      && isCanonicalInstant(snapshotValue.elasticTargetTime)
      && (snapshotValue.elasticLockedAt === null || isCanonicalInstant(snapshotValue.elasticLockedAt));
  }

  const errorValue = value.error;

  if (value.category !== (expectedCategory ?? 'unknown')) {
    return false;
  }

  if (
    !isRecord(errorValue)
    || !isActionErrorCode(errorValue.code)
    || typeof errorValue.message !== 'string'
    || (errorValue.field !== undefined && typeof errorValue.field !== 'string')
  ) {
    return false;
  }

  return value.outcome === outcomeForErrorCode(errorValue.code);
}
