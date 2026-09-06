import { ALL_PROJECTS, UNCATEGORISED, reconcileSelection } from '../domain/selectors.js';
import type { LoadProblem } from '../domain/problems.js';
import type { ProximaState } from '../domain/types.js';

/** The wire/schema version for project-owned semantic actions. */
export const ACTION_SCHEMA_VERSION = 1 as const;

export type Surface = 'board' | 'calendar';

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
  snapshot: ActionSnapshot;
}

export interface ActionFailure {
  schemaVersion: typeof ACTION_SCHEMA_VERSION;
  ok: false;
  actionType: string;
  stateRevision: number;
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
}

export interface ActionDispatcherOptions {
  state: ProximaState;
  problems?: LoadProblem[];
  revisions?: Record<string, string>;
  mode?: 'fixture' | 'live';
  initialSurface?: Surface;
  initialSelection?: string;
  initialCalendarMonth?: string;
}

export interface ProximaActionDispatcher {
  dispatch(input: unknown): ActionResult;
  snapshot(): Readonly<ActionDispatcherState>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidAction(message: string, field?: string): ActionFailure {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: false,
    actionType: 'unknown',
    stateRevision: 0,
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
    return input.surface === 'board' || input.surface === 'calendar'
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

function resultFor(state: ActionDispatcherState, actionType: string, changed: boolean): ActionSuccess {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: true,
    actionType: actionType as ProximaAction['type'],
    changed,
    stateRevision: state.stateRevision,
    snapshot: snapshot(state),
  };
}

function failureFor(state: ActionDispatcherState, actionType: string, error: ActionError): ActionFailure {
  return { schemaVersion: ACTION_SCHEMA_VERSION, ok: false, actionType, stateRevision: state.stateRevision, error };
}

function isValidCalendarMonth(value: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00`).getTime());
}

export function createActionDispatcher(options: ActionDispatcherOptions): ProximaActionDispatcher {
  const state: ActionDispatcherState = {
    state: options.state,
    problems: [...(options.problems ?? [])],
    revisions: { ...(options.revisions ?? {}) },
    mode: options.mode ?? 'fixture',
    surface: options.initialSurface ?? 'board',
    selection: options.initialSelection ?? ALL_PROJECTS,
    calendarMonth: options.initialCalendarMonth ?? '2026-09-01',
    stateRevision: 1,
  };
  if (!isValidCalendarMonth(state.calendarMonth)) state.calendarMonth = '2026-09-01';
  state.selection = reconcileSelection(state.state.projects, state.selection, state.surface);

  return {
    dispatch(input: unknown): ActionResult {
      const parsed = parseAction(input);
      if (!parsed.ok) return failureFor(state, isRecord(input) && typeof input.type === 'string' ? input.type : 'unknown', parsed.error);
      const action = parsed.action;
      if (action.type === 'project.select') {
        if (action.projectId !== ALL_PROJECTS && action.projectId !== UNCATEGORISED && !state.state.projects.some((project) => project.id === action.projectId)) {
          return failureFor(state, action.type, { code: 'project-not-found', message: `project does not exist: ${action.projectId}`, field: 'projectId' });
        }
        const next = reconcileSelection(state.state.projects, action.projectId, state.surface);
        const changed = next !== state.selection;
        if (changed) { state.selection = next; state.stateRevision += 1; }
        return resultFor(state, action.type, changed);
      }
      if (action.type === 'surface.select') {
        const nextSelection = reconcileSelection(state.state.projects, state.selection, action.surface);
        const changed = state.surface !== action.surface || state.selection !== nextSelection;
        if (changed) { state.surface = action.surface; state.selection = nextSelection; state.stateRevision += 1; }
        return resultFor(state, action.type, changed);
      }
      if (action.type === 'calendar.shift-month') {
        const current = new Date(`${state.calendarMonth}T00:00:00`);
        const next = new Date(current.getFullYear(), current.getMonth() + action.delta, 1);
        state.calendarMonth = `${next.getFullYear().toString().padStart(4, '0')}-${(next.getMonth() + 1).toString().padStart(2, '0')}-01`;
        state.stateRevision += 1;
        return resultFor(state, action.type, true);
      }
      if (state.mode !== 'fixture') return failureFor(state, action.type, { code: 'action-not-available', message: 'fixture reset is only available in fixture mode' });
      const changed = state.surface !== 'board' || state.selection !== ALL_PROJECTS || state.calendarMonth !== '2026-09-01';
      state.surface = 'board'; state.selection = ALL_PROJECTS; state.calendarMonth = '2026-09-01';
      if (changed) state.stateRevision += 1;
      return resultFor(state, action.type, changed);
    },
    snapshot(): Readonly<ActionDispatcherState> {
      return { ...state, problems: [...state.problems], revisions: { ...state.revisions } };
    },
  };
}

/** Keep invalid-result construction itself visible to tests and integrations. */
export function invalidActionResult(message = 'invalid action'): ActionFailure {
  return invalidAction(message);
}

/** Runtime guard for action responses crossing an agent/UI boundary. */
export function isActionResult(value: unknown): value is ActionResult {
  if (!isRecord(value) || value.schemaVersion !== ACTION_SCHEMA_VERSION || typeof value.ok !== 'boolean' || typeof value.stateRevision !== 'number' || typeof value.actionType !== 'string') return false;
  if (value.ok) {
    const snapshot = value.snapshot;
    return typeof value.changed === 'boolean' && isRecord(snapshot) && (snapshot.surface === 'board' || snapshot.surface === 'calendar') && typeof snapshot.selection === 'string' && typeof snapshot.calendarMonth === 'string';
  }
  const error = value.error;
  return isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string';
}
