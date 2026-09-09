import { ALL_PROJECTS, UNCATEGORISED, reconcileSelection } from '../domain/selectors.js';
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../domain/clock.js';
import type { LoadProblem } from '../domain/problems.js';
import type { ProximaState } from '../domain/types.js';
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
export const ACTION_SCHEMA_VERSION = 1 as const;

export type Surface = 'board' | 'calendar' | 'canvas';

export type ProximaAction =
  | { type: 'project.select'; projectId: string }
  | { type: 'surface.select'; surface: Surface }
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
  calendarMonth: string;
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
    return input.surface === 'board' || input.surface === 'calendar' || input.surface === 'canvas'
      ? { ok: true, action: { type: input.type, surface: input.surface } }
      : {
          ok: false,
          error: {
            code: 'invalid-action-input',
            message: 'surface must be board, calendar or canvas',
            field: 'surface',
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
    calendarMonth: state.calendarMonth,
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

  if (!isValidCalendarMonth(state.calendarMonth)) {
    state.calendarMonth = '2026-09-01';
  }

  if (state.surface !== 'canvas') {
    state.selection = reconcileSelection(state.state.projects, state.selection, state.surface);
  }

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

        const next = state.surface === 'canvas'
          ? state.selection
          : reconcileSelection(state.state.projects, action.projectId, state.surface);
        const changed = next !== state.selection;

        if (changed) {
          state.selection = next;
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
        const nextSelection = action.surface === 'canvas'
          ? state.selection
          : reconcileSelection(state.state.projects, state.selection, action.surface);
        const changed = state.surface !== action.surface || state.selection !== nextSelection;

        if (changed) {
          state.surface = action.surface;
          state.selection = nextSelection;
          state.stateRevision += 1;
        }

        ring.append({
          kind: 'action.accepted',
          category: 'domain',
          entityIds: [action.surface],
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

      const changed = state.surface !== 'board'
        || state.selection !== ALL_PROJECTS
        || state.calendarMonth !== '2026-09-01';

      state.surface = 'board';
      state.selection = ALL_PROJECTS;
      state.calendarMonth = '2026-09-01';

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
      const nextSelection = state.surface === 'canvas'
        ? state.selection
        : reconcileSelection(input.state.projects, state.selection, state.surface);
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
        snapshotValue.surface === 'board'
        || snapshotValue.surface === 'calendar'
        || snapshotValue.surface === 'canvas'
      )
      && typeof snapshotValue.selection === 'string'
      && typeof snapshotValue.calendarMonth === 'string'
      && isValidCalendarMonth(snapshotValue.calendarMonth);
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
