import { ALL_PROJECTS, UNCATEGORISED, reconcileSelection } from '../domain/selectors.js';
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../domain/clock.js';
import type { LoadProblem } from '../domain/problems.js';
import type { ProximaState } from '../domain/types.js';
import { createEventRing, type EventRing, type ProximaEvent } from './eventRing.js';

/** The wire/schema version for project-owned semantic actions. */
export const ACTION_SCHEMA_VERSION = 1 as const;

export type Surface = 'board' | 'calendar' | 'canvas';

export type ProximaAction =
  | { type: 'project.select'; projectId: string }
  | { type: 'surface.select'; surface: Surface }
  | { type: 'calendar.shift-month'; delta: -1 | 1 }
  | { type: 'fixture.reset' };

export type ActionErrorCode =
  | 'invalid-action'
  | 'invalid-action-input'
  | 'project-not-found'
  | 'action-not-available';

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  field?: string;
}

export interface ActionSnapshot {
  surface: Surface;
  selection: string;
  calendarMonth: string;
}

export interface ActionSuccess {
  schemaVersion: typeof ACTION_SCHEMA_VERSION;
  ok: true;
  actionType: ProximaAction['type'];
  changed: boolean;
  stateRevision: number;
  requestId: string;
  snapshot: ActionSnapshot;
}

export interface ActionFailure {
  schemaVersion: typeof ACTION_SCHEMA_VERSION;
  ok: false;
  actionType: string;
  stateRevision: number;
  requestId: string;
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
  calendarMonth: string;
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
  initialCalendarMonth?: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  eventCapacity?: number;
  initialSourceRevision?: number;
}

export interface ProximaActionDispatcher {
  dispatch(input: unknown): ActionResult;
  /** Atomically replace the readable source generation; never writes to the source. */
  replaceSource(input: { state: ProximaState; problems: LoadProblem[]; revisions: Record<string, string>; sourceRevision: number }): { changed: boolean; stateRevision: number };
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
    stateRevision: 0,
    requestId,
    error: { code: 'invalid-action', message, field },
  };
}

/** Parse and validate the public action shape before dispatching it. */
export function parseAction(input: unknown): { ok: true; action: ProximaAction } | { ok: false; error: ActionError } {
  if (!isRecord(input) || typeof input.type !== 'string') {
    return { ok: false, error: { code: 'invalid-action', message: 'action must be an object with a string type', field: 'type' } };
  }
  if (input.type === 'project.select') {
    return typeof input.projectId === 'string' && input.projectId.length <= 200
      ? { ok: true, action: { type: input.type, projectId: input.projectId } }
      : { ok: false, error: { code: 'invalid-action-input', message: 'projectId must be a bounded string', field: 'projectId' } };
  }
  if (input.type === 'surface.select') {
    return input.surface === 'board' || input.surface === 'calendar' || input.surface === 'canvas'
      ? { ok: true, action: { type: input.type, surface: input.surface } }
      : { ok: false, error: { code: 'invalid-action-input', message: 'surface must be board or calendar', field: 'surface' } };
  }
  if (input.type === 'calendar.shift-month') {
    return input.delta === -1 || input.delta === 1
      ? { ok: true, action: { type: input.type, delta: input.delta } }
      : { ok: false, error: { code: 'invalid-action-input', message: 'delta must be -1 or 1', field: 'delta' } };
  }
  if (input.type === 'fixture.reset') return { ok: true, action: { type: input.type } };
  return { ok: false, error: { code: 'invalid-action', message: `unsupported action type: ${input.type}`, field: 'type' } };
}

function snapshot(state: ActionDispatcherState): ActionSnapshot {
  return { surface: state.surface, selection: state.selection, calendarMonth: state.calendarMonth };
}

function resultFor(state: ActionDispatcherState, actionType: string, changed: boolean, requestId: string): ActionSuccess {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: true,
    actionType: actionType as ProximaAction['type'],
    changed,
    stateRevision: state.stateRevision,
    requestId,
    snapshot: snapshot(state),
  };
}

function failureFor(state: ActionDispatcherState, actionType: string, error: ActionError, requestId: string): ActionFailure {
  return { schemaVersion: ACTION_SCHEMA_VERSION, ok: false, actionType, stateRevision: state.stateRevision, requestId, error };
}

function isValidCalendarMonth(value: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00`).getTime());
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
    surface: options.initialSurface ?? 'board',
    selection: options.initialSelection ?? ALL_PROJECTS,
    calendarMonth: options.initialCalendarMonth ?? '2026-09-01',
    stateRevision: 1,
    settledRevision: 1,
    settled: true,
    latestEventSequence: 0,
    sourceRevision: options.initialSourceRevision ?? 1,
  };
  if (!isValidCalendarMonth(state.calendarMonth)) state.calendarMonth = '2026-09-01';
  if (state.surface !== 'canvas') state.selection = reconcileSelection(state.state.projects, state.selection, state.surface);

  return {
    dispatch(input: unknown): ActionResult {
      const requestId = ids.next('request');
      const parsed = parseAction(input);
      if (!parsed.ok) {
        const result = failureFor(state, isRecord(input) && typeof input.type === 'string' ? input.type : 'unknown', parsed.error, requestId);
        ring.append({ kind: 'action.rejected', category: 'diagnostic', entityIds: [], requestId, actionType: result.actionType, stateRevision: state.stateRevision, errorCode: result.error.code });
        state.latestEventSequence = ring.latestSequence();
        return result;
      }
      const action = parsed.action;
      if (action.type === 'project.select') {
        if (action.projectId !== ALL_PROJECTS && action.projectId !== UNCATEGORISED && !state.state.projects.some((project) => project.id === action.projectId)) {
          const result = failureFor(state, action.type, { code: 'project-not-found', message: `project does not exist: ${action.projectId}`, field: 'projectId' }, requestId);
          ring.append({ kind: 'action.rejected', category: 'diagnostic', entityIds: [action.projectId], requestId, actionType: action.type, stateRevision: state.stateRevision, errorCode: result.error.code });
          state.latestEventSequence = ring.latestSequence();
          return result;
        }
        const next = state.surface === 'canvas' ? state.selection : reconcileSelection(state.state.projects, action.projectId, state.surface);
        const changed = next !== state.selection;
        if (changed) { state.selection = next; state.stateRevision += 1; }
        ring.append({ kind: 'action.accepted', category: 'domain', entityIds: [action.projectId], requestId, actionType: action.type, stateRevision: state.stateRevision });
        ring.append({ kind: 'state.settled', category: 'lifecycle', entityIds: [], requestId, actionType: action.type, stateRevision: state.stateRevision });
        state.settledRevision = state.stateRevision; state.settled = true;
        state.latestEventSequence = ring.latestSequence();
        return resultFor(state, action.type, changed, requestId);
      }
      if (action.type === 'surface.select') {
        const nextSelection = action.surface === 'canvas' ? state.selection : reconcileSelection(state.state.projects, state.selection, action.surface);
        const changed = state.surface !== action.surface || state.selection !== nextSelection;
        if (changed) { state.surface = action.surface; state.selection = nextSelection; state.stateRevision += 1; }
        ring.append({ kind: 'action.accepted', category: 'domain', entityIds: [action.surface], requestId, actionType: action.type, stateRevision: state.stateRevision });
        ring.append({ kind: 'state.settled', category: 'lifecycle', entityIds: [], requestId, actionType: action.type, stateRevision: state.stateRevision });
        state.settledRevision = state.stateRevision; state.settled = true;
        state.latestEventSequence = ring.latestSequence();
        return resultFor(state, action.type, changed, requestId);
      }
      if (action.type === 'calendar.shift-month') {
        const current = new Date(`${state.calendarMonth}T00:00:00`);
        const next = new Date(current.getFullYear(), current.getMonth() + action.delta, 1);
        state.calendarMonth = `${next.getFullYear().toString().padStart(4, '0')}-${(next.getMonth() + 1).toString().padStart(2, '0')}-01`;
        state.stateRevision += 1;
        ring.append({ kind: 'action.accepted', category: 'domain', entityIds: [state.calendarMonth], requestId, actionType: action.type, stateRevision: state.stateRevision });
        ring.append({ kind: 'state.settled', category: 'lifecycle', entityIds: [], requestId, actionType: action.type, stateRevision: state.stateRevision });
        state.settledRevision = state.stateRevision; state.settled = true;
        state.latestEventSequence = ring.latestSequence();
        return resultFor(state, action.type, true, requestId);
      }
      if (state.mode !== 'fixture') {
        const result = failureFor(state, action.type, { code: 'action-not-available', message: 'fixture reset is only available in fixture mode' }, requestId);
        ring.append({ kind: 'action.rejected', category: 'diagnostic', entityIds: [], requestId, actionType: action.type, stateRevision: state.stateRevision, errorCode: result.error.code });
        state.latestEventSequence = ring.latestSequence();
        return result;
      }
      const changed = state.surface !== 'board' || state.selection !== ALL_PROJECTS || state.calendarMonth !== '2026-09-01';
      state.surface = 'board'; state.selection = ALL_PROJECTS; state.calendarMonth = '2026-09-01';
      if (changed) state.stateRevision += 1;
      ring.append({ kind: 'action.accepted', category: 'domain', entityIds: [], requestId, actionType: action.type, stateRevision: state.stateRevision });
      ring.append({ kind: 'state.settled', category: 'lifecycle', entityIds: [], requestId, actionType: action.type, stateRevision: state.stateRevision });
      state.settledRevision = state.stateRevision; state.settled = true;
      state.latestEventSequence = ring.latestSequence();
      return resultFor(state, action.type, changed, requestId);
    },
    replaceSource(input) {
      const sourceChanged = input.sourceRevision !== state.sourceRevision;
      const nextSelection = state.surface === 'canvas' ? state.selection : reconcileSelection(input.state.projects, state.selection, state.surface);
      const selectionChanged = nextSelection !== state.selection;
      state.state = input.state;
      state.problems = [...input.problems];
      state.revisions = { ...input.revisions };
      state.sourceRevision = input.sourceRevision;
      state.selection = nextSelection;
      if (sourceChanged || selectionChanged) state.stateRevision += 1;
      state.settledRevision = state.stateRevision;
      state.settled = true;
      if (sourceChanged || selectionChanged) {
        const requestId = ids.next('refresh');
        ring.append({ kind: 'action.accepted', category: 'lifecycle', entityIds: [], requestId, actionType: 'source.refresh', stateRevision: state.stateRevision });
        ring.append({ kind: 'state.settled', category: 'lifecycle', entityIds: [], requestId, actionType: 'source.refresh', stateRevision: state.stateRevision });
        state.latestEventSequence = ring.latestSequence();
      }
      return { changed: sourceChanged || selectionChanged, stateRevision: state.stateRevision };
    },
    snapshot(): Readonly<ActionDispatcherState> {
      return { ...state, problems: [...state.problems], revisions: { ...state.revisions } };
    },
    events(afterSequence = 0): ProximaEvent[] { return ring.read(afterSequence); },
  };
}

/** Keep invalid-result construction itself visible to tests and integrations. */
export function invalidActionResult(message = 'invalid action', requestId = 'request-invalid'): ActionFailure {
  return invalidAction(message, undefined, requestId);
}

/** Runtime guard for action responses crossing an agent/UI boundary. */
export function isActionResult(value: unknown): value is ActionResult {
  if (!isRecord(value) || value.schemaVersion !== ACTION_SCHEMA_VERSION || typeof value.ok !== 'boolean' || typeof value.stateRevision !== 'number' || typeof value.actionType !== 'string') return false;
  if (value.ok) {
    const snapshot = value.snapshot;
    return typeof value.changed === 'boolean' && typeof value.requestId === 'string' && isRecord(snapshot) && (snapshot.surface === 'board' || snapshot.surface === 'calendar' || snapshot.surface === 'canvas') && typeof snapshot.selection === 'string' && typeof snapshot.calendarMonth === 'string';
  }
  const error = value.error;
  return typeof value.requestId === 'string' && isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string';
}
