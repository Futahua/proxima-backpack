/**
 * The Gantt's write: a bar drag or an edge resize becomes one semantic date mutation.
 *
 * Two entries over **one** operation, and the split is the point of this file:
 *
 * - `changeTaskSpan` is the operation, and its dependency set has no cockpit in it - the write callable,
 *   the refresh, the id source and the event sink. It reads no projection and draws nothing, so the same
 *   call can be submitted by an agent through `src/app/agentWritePath.ts` and by the drag below. That is
 *   the rule the wire holds every family to, and it is why the planning rule and the write live in one
 *   place rather than in a copy each.
 * - `changeTaskDatesAction` is the cockpit's entry: it finds the task in the projection, submits the span
 *   it read, draws the refusal the surface shows and re-reads. A cockpit-free operation cannot do any of
 *   those three things, and a surface entry that duplicated the write rules would be a second copy to keep
 *   true.
 *
 * Three rules, and they are the stage's boxes.
 *
 * - **A gesture becomes a date request, never a geometry.** The request carries the two dates the surface
 *   would draw; this module decides whether they are a span at all and submits them. An agent expressing
 *   the same change in a sentence reaches the same call.
 * - **The row is local.** `TimelineChangeRequest` carries a `targetRowIndex`, and A3 settled what that is:
 *   Gantt row placement is LOCAL STATE, not a third durable task-order field. So the row is deliberately
 *   *not* written, and the outcome says so rather than leaving a caller to infer it - a scoped local
 *   movement that quietly reordered the Elastic board would be the silo A3 removed.
 * - **An inverted range is refused before storage.** A deadline that does not follow its start is refused
 *   here with a typed reason, so the bar can be restored and the reader told, rather than reaching the
 *   operation and coming back as "the write was rejected".
 *
 * One thing changed when the write became an operation, and it is worth stating because it removes a
 * malformation rather than validating one: **the request carries the whole span**, both ends, for every
 * operation. A resize used to name one end *and* take the other from the projection, which is a read the
 * wire does not have; here the caller that read the record supplies both ends and declares which gesture it
 * was, so a `resize-start` whose deadline disagrees with the record is not a submission anybody can express
 * - there is no second source for the end. `expectedRevision` is what keeps the pair honest, and a record
 * that moved under the caller is refused `stale-revision` rather than merged.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { IdGenerator } from '../domain/clock.js';
import type { ProximaState } from '../domain/types.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const TIMELINE_CHANGE_SCHEMA_VERSION = 1 as const;

export type TimelineChangeOperation = 'move' | 'resize-start' | 'resize-end';

/** The three gestures, as a set a caller can test a value against. */
export const TIMELINE_CHANGE_OPERATIONS: readonly TimelineChangeOperation[] = ['move', 'resize-start', 'resize-end'];

/**
 * The semantic verb every Gantt date change is journalled under.
 *
 * One verb rather than three, because the protocol registers one: `task.timeline.change` carries the
 * operation as a field, and the audit names the verb. The *reason* vocabulary below distinguishes the three
 * gestures, which is where a distinction a caller can act on belongs.
 */
export const TIMELINE_CHANGE_ACTION_TYPE = 'task.timeline.change';

/** The highest row index a surface can name. The protocol's own bound, restated where the row is checked. */
const MAX_TARGET_ROW_INDEX = 100_000;

export interface TimelineChangeRequest {
  readonly taskId: string;
  readonly operation: TimelineChangeOperation;
  /** Both dates the surface would draw: a move proposes both ends, a resize proposes the end it moved. */
  readonly proposedStartDate: string | null;
  readonly proposedDeadline: string | null;
  /** Where the bar was dropped. Local state: reported, never written. */
  readonly targetRowIndex: number;
  /**
   * The revision the caller read the record at.
   *
   * Required, and it is the field that made this operation cockpit-free: the projection used to be the
   * source of the revision and of the end a resize kept, and a caller that has read the record has both.
   */
  readonly expectedRevision: string;
}

/** The operations the shell resolved, structurally: no store, no coordinator, no paths. */
export interface TimelineWriteOperations {
  updateTask(input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }): Promise<TaskMutationResult>;
}

/**
 * What the operation needs, and nothing a cockpit owns.
 *
 * There is deliberately no `state`, no `setRefusal` and no `render` here. The first is a read model, and the
 * other two are a surface's: an operation that took them could not be reached from a wire that has neither.
 */
export interface TimelineSpanWriteDependencies {
  readonly writes: () => Promise<TimelineWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** Mints this run's semantic request id, when no trusted layer above already minted one. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export type TimelineChangeFailureReason =
  | 'unknown-task'
  | 'invalid-range'
  | 'writes-unavailable'
  | 'validation-refused'
  | TaskMutationFailureReason;

export interface TimelineSpanWriteResult {
  readonly ok: true;
  readonly schemaVersion: typeof TIMELINE_CHANGE_SCHEMA_VERSION;
  readonly outcome: 'changed';
  readonly operation: TimelineChangeOperation;
  readonly actionType: typeof TIMELINE_CHANGE_ACTION_TYPE;
  /** This run's semantic request id: minted at the boundary, returned on every result. */
  readonly requestId: string;
  readonly taskId: OpaqueRecordId;
  readonly revision: string;
  readonly startDate: string | null;
  readonly deadline: string | null;
  /** Always false: the row is the surface's, and this is how a caller knows it was not written. */
  readonly rowApplied: false;
  readonly refreshed: boolean;
  /** Set when the write was accepted and the refresh then failed: the write still stands. */
  readonly refreshFailure: string | null;
}

export interface TimelineSpanWriteRefusal {
  readonly ok: false;
  readonly schemaVersion: typeof TIMELINE_CHANGE_SCHEMA_VERSION;
  readonly outcome: 'refused';
  readonly operation: TimelineChangeOperation;
  readonly actionType: typeof TIMELINE_CHANGE_ACTION_TYPE;
  readonly reason: TimelineChangeFailureReason;
  readonly detail: string;
  /** Present on a refusal too, so a refused drag is correlatable with the event it left behind. */
  readonly requestId: string;
  readonly refreshed: boolean;
  readonly refreshFailure: string | null;
  /** The revision that beat this caller, so the surface can refetch rather than guess. */
  readonly actualRevision?: string;
}

export type TimelineSpanWriteOutcome = TimelineSpanWriteResult | TimelineSpanWriteRefusal;

/** The cockpit's own result: the operation's outcome, with `reason`/`detail` kept where the shell reads them. */
export type TimelineChangeOutcome = TimelineSpanWriteOutcome;

export interface TimelineChangeDependencies {
  /** The projection the bar was drawn from, which supplies the revision and the ends a resize keeps. */
  readonly state: ProximaState | null;
  readonly writes: () => Promise<TimelineWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
  /** The id source, when the shell resolves one: the operation mints this run's request id from it. */
  readonly ids?: IdGenerator;
  /** Where the run's one terminal audit event goes, when the shell has a sink wired. */
  readonly audit?: SemanticAuditSink;
}

/**
 * The options a trusted layer above the operation hands down.
 *
 * The two entries above this module - the cockpit wrapper and the agent wire - each mint the id at *their*
 * boundary, before the range is planned, so a run refused for a range that is not a range is correlatable
 * exactly like an accepted one. A caller that already minted one hands it down rather than letting a second
 * be issued, which is what keeps one submission one id and one terminal event.
 */
export interface TimelineSpanWriteOptions {
  readonly requestId?: string;
}

function refused(
  operation: TimelineChangeOperation,
  reason: TimelineChangeFailureReason,
  detail: string,
  requestId: string,
  refreshed = false,
  actualRevision?: string,
): TimelineSpanWriteRefusal {
  return {
    ok: false,
    schemaVersion: TIMELINE_CHANGE_SCHEMA_VERSION,
    outcome: 'refused',
    operation,
    actionType: TIMELINE_CHANGE_ACTION_TYPE,
    reason,
    detail,
    requestId,
    refreshed,
    refreshFailure: null,
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
}

function instant(value: string | null): string | null {
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The span a request would write.
 *
 * A resize names one end and keeps the other, and both come from the request: "shift-drag the start edge"
 * means the reader moved one end and left the other where they read it, which is what makes the gesture
 * mean what it looks like.
 */
function plannedSpan(
  request: TimelineChangeRequest,
): { readonly startDate: string | null; readonly deadline: string | null } | { readonly reason: 'invalid-range'; readonly detail: string } {
  const proposedStart = instant(request.proposedStartDate);
  const proposedDeadline = instant(request.proposedDeadline);

  // Which end this operation *moves*, and which end it keeps exactly where the caller read it. The two are
  // named rather than folded into a pair of ternaries, because swapping them is precisely the mistake this
  // rule exists to prevent: a resize that wrote the end it was supposed to keep, and reported success.
  const movesStart = request.operation !== 'resize-end';
  const movesEnd = request.operation !== 'resize-start';

  // A resize that names only the end it moved names no end at all, because the other one is not inferred here.
  if (!movesStart && request.proposedStartDate === null) {
    return { reason: 'invalid-range', detail: 'a resize names the end that is not moving as well as the one that is' };
  }
  if (!movesEnd && request.proposedDeadline === null) {
    return { reason: 'invalid-range', detail: 'a resize names the end that is not moving as well as the one that is' };
  }
  if (request.proposedStartDate !== null && proposedStart === null) {
    return { reason: 'invalid-range', detail: 'the start is not a real instant' };
  }
  if (request.proposedDeadline !== null && proposedDeadline === null) {
    return { reason: 'invalid-range', detail: 'the end is not a real instant' };
  }

  const startDate = movesStart ? proposedStart : instant(request.proposedStartDate);
  const deadline = movesEnd ? proposedDeadline : instant(request.proposedDeadline);

  if (startDate !== null && deadline !== null && Date.parse(deadline) <= Date.parse(startDate)) {
    return { reason: 'invalid-range', detail: 'a task must end after it starts' };
  }

  return { startDate, deadline };
}

/**
 * Run one Gantt date change against the record layer, with no cockpit in the dependency set.
 *
 * The revision is the caller's own reading of the record, so a caller that lost a race is told so with the
 * revision that beat it - which is what puts the bar back where the store says it is.
 */
export async function changeTaskSpan(
  deps: TimelineSpanWriteDependencies,
  request: TimelineChangeRequest,
  options: TimelineSpanWriteOptions = {},
): Promise<TimelineSpanWriteOutcome> {
  const requestId = options.requestId ?? mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: TIMELINE_CHANGE_ACTION_TYPE,
      outcome,
      entityIds: [request.taskId],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  // The row is reported, never written, so a row that is not a row is refused here rather than travelling
  // as far as the record layer to be ignored. `moveTaskByGesture` owns the same rule for a drop's index.
  if (!Number.isSafeInteger(request.targetRowIndex) || request.targetRowIndex < 0 || request.targetRowIndex > MAX_TARGET_ROW_INDEX) {
    audit('rejected', 'validation-refused');
    return refused(request.operation, 'validation-refused', 'a timeline row is a whole number inside the surface, not negative and not beyond the last row', requestId);
  }

  if (typeof request.taskId !== 'string' || request.taskId.length === 0 || typeof request.expectedRevision !== 'string' || request.expectedRevision.length === 0) {
    audit('rejected', 'validation-refused');
    return refused(request.operation, 'validation-refused', 'a timeline change needs the record it is about and the revision that record was read at', requestId);
  }

  const span = plannedSpan(request);
  if ('reason' in span) {
    audit('rejected', span.reason);
    return refused(request.operation, span.reason, span.detail, requestId);
  }

  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    audit('rejected', 'writes-unavailable');
    return refused(request.operation, 'writes-unavailable', reason, requestId);
  }

  let written: TaskMutationResult;
  try {
    written = await operations.updateTask({
      taskId: request.taskId as OpaqueRecordId,
      expectedRevision: request.expectedRevision,
      // One mutation: the two ends travel together, because a task whose start moved and whose end
      // did not is a duration nobody asked for.
      mutations: [{ kind: 'dates', startDate: span.startDate, deadline: span.deadline }],
    });
  } catch {
    audit('rejected', 'storage-failure');
    return refused(request.operation, 'storage-failure', 'the write could not be attempted', requestId);
  }

  // A lost race is the one refusal where the surface is wrong rather than merely unchanged, so it re-reads;
  // every other refusal left the world as it was, and a redraw there would imply something happened.
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) {
    audit('rejected', written.reason);
    return refused(
      request.operation,
      written.reason,
      written.detail,
      requestId,
      convergence.refreshed,
      written.actualRevision,
    );
  }

  audit('accepted');
  return {
    ok: true,
    schemaVersion: TIMELINE_CHANGE_SCHEMA_VERSION,
    outcome: 'changed',
    operation: request.operation,
    actionType: TIMELINE_CHANGE_ACTION_TYPE,
    requestId,
    taskId: written.recordId,
    revision: written.revision,
    startDate: span.startDate,
    deadline: span.deadline,
    rowApplied: false,
    refreshed: convergence.refreshed,
    refreshFailure: convergence.refreshFailure,
  };
}

/** The id source an operation needs when the shell did not resolve one: a composition without a session. */
function fallbackIds(): IdGenerator {
  let next = 0;
  return { next: (prefix: string) => `${prefix}-${(next += 1).toString().padStart(4, '0')}` };
}

/** The sink a composition without a session gets: the run is answered, and there is nowhere to journal it. */
const DISCARD_AUDIT: SemanticAuditSink = { append: () => undefined };

/**
 * The cockpit's entry: find the task the bar was drawn from, submit the span, draw the answer.
 *
 * Everything a cockpit owns is here - the projection read, the refusal sink, the redraw - and everything
 * shared with the agent wire is in `changeTaskSpan`, which this calls with the record facts it just read.
 */
export async function changeTaskDatesAction(
  deps: TimelineChangeDependencies,
  request: Omit<TimelineChangeRequest, 'expectedRevision'>,
): Promise<TimelineChangeOutcome> {
  const task = deps.state?.tasks.find((candidate) => candidate.id === request.taskId);
  if (task === undefined) {
    // No projection entry means no revision to write against, so this is the surface's own refusal and no
    // event is journalled: nothing was submitted, and a cockpit refusal is not a record run. `unknown-task`
    // is therefore a reason only this entry can answer - a caller that read the record has no board to
    // consult, and one naming a record that does not exist reaches the record layer and gets its `not-found`,
    // exactly as the drop arm's two entries do.
    return refused(request.operation, 'unknown-task', 'the timeline has no task with that id', 'timeline-unknown-task');
  }

  deps.setRefusal(null);
  const outcome = await changeTaskSpan(
    {
      writes: deps.writes,
      unavailableReason: deps.unavailableReason,
      refresh: deps.refresh,
      ids: deps.ids ?? fallbackIds(),
      audit: deps.audit ?? DISCARD_AUDIT,
    },
    {
      ...request,
      expectedRevision: task.source.revision,
      // The two ends as the caller read them: a resize names one end and supplies the other from the record
      // the bar was drawn from. `expectedRevision` is what refuses the pair if that record has moved.
      proposedStartDate: request.operation === 'resize-end' ? task.startDate : request.proposedStartDate,
      proposedDeadline: request.operation === 'resize-start' ? task.deadline : request.proposedDeadline,
    },
  );

  if (!outcome.ok) deps.setRefusal(outcome.reason);
  deps.render();
  return outcome;
}
