/**
 * The Gantt's write: a bar drag or an edge resize becomes one semantic date mutation.
 *
 * Three rules, and they are the stage's boxes.
 *
 * - **A gesture becomes a date request, never a geometry.** The intent carries the two dates the
 *   surface would draw; this module decides whether they are a span at all and submits them. An agent
 *   expressing the same change in a sentence reaches the same call.
 * - **The row is local.** `TimelineChangeIntent` carries a `targetRowIndex`, and A3 settled what that
 *   is: Gantt row placement is LOCAL STATE, not a third durable task-order field. So the row is
 *   deliberately *not* written, and the outcome says so rather than leaving a caller to infer it —
 *   a scoped local movement that quietly reordered the Elastic board would be the silo A3 removed.
 * - **An inverted range is refused before storage.** A deadline that does not follow its start is
 *   refused here with a typed reason, so the bar can be restored and the reader told, rather than
 *   reaching the operation and coming back as "the write was rejected".
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { ProximaState } from '../domain/types.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const TIMELINE_CHANGE_SCHEMA_VERSION = 1 as const;

export type TimelineChangeOperation = 'move' | 'resize-start' | 'resize-end';

export interface TimelineChangeRequest {
  readonly taskId: string;
  readonly operation: TimelineChangeOperation;
  /** The dates the surface would draw: a move proposes both, a resize proposes the end it moved. */
  readonly proposedStartDate: string | null;
  readonly proposedDeadline: string | null;
  /** Where the bar was dropped. Local state: reported, never written. */
  readonly targetRowIndex: number;
}

/** The operations the shell resolved, structurally: no store, no coordinator, no paths. */
export interface TimelineWriteOperations {
  updateTask(input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }): Promise<TaskMutationResult>;
}

export interface TimelineChangeDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<TimelineWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
}

export type TimelineChangeFailureReason =
  | 'unknown-task'
  | 'writes-unavailable'
  | 'invalid-range'
  | TaskMutationFailureReason;

export type TimelineChangeOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof TIMELINE_CHANGE_SCHEMA_VERSION;
      readonly operation: TimelineChangeOperation;
      readonly taskId: OpaqueRecordId;
      readonly revision: string;
      readonly startDate: string | null;
      readonly deadline: string | null;
      /** Always false: the row is the surface's, and this is how a caller knows it was not written. */
      readonly rowApplied: false;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof TIMELINE_CHANGE_SCHEMA_VERSION;
      readonly operation: TimelineChangeOperation;
      readonly reason: TimelineChangeFailureReason;
      readonly detail: string;
      readonly refreshed: boolean;
    };

function refused(
  operation: TimelineChangeOperation,
  reason: TimelineChangeFailureReason,
  detail: string,
  refreshed = false,
): TimelineChangeOutcome {
  return { ok: false, schemaVersion: TIMELINE_CHANGE_SCHEMA_VERSION, operation, reason, detail, refreshed };
}

function instant(value: string | null): string | null {
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The span a request would write, given the record it is relative to.
 *
 * A resize names one end and keeps the other from the record, which is what makes "shift-drag the
 * start edge" mean what it looks like: the reader moved one end.
 */
function plannedSpan(
  record: { readonly startDate: string | null; readonly deadline: string | null },
  request: TimelineChangeRequest,
): { readonly startDate: string | null; readonly deadline: string | null } | { readonly reason: 'invalid-range'; readonly detail: string } {
  const proposedStart = instant(request.proposedStartDate);
  const proposedDeadline = instant(request.proposedDeadline);

  if (request.proposedStartDate !== null && proposedStart === null) {
    return { reason: 'invalid-range', detail: 'the start is not a real instant' };
  }
  if (request.proposedDeadline !== null && proposedDeadline === null) {
    return { reason: 'invalid-range', detail: 'the end is not a real instant' };
  }

  const startDate = request.operation === 'resize-end' ? record.startDate : proposedStart;
  const deadline = request.operation === 'resize-start' ? record.deadline : proposedDeadline;

  if (startDate !== null && deadline !== null && Date.parse(deadline) <= Date.parse(startDate)) {
    return { reason: 'invalid-range', detail: 'a task must end after it starts' };
  }

  return { startDate, deadline };
}

/**
 * Run one Gantt date change and converge the surfaces.
 *
 * The revision is the one the bar was drawn from, so a caller that lost a race is told so with the
 * revision that beat it — which is what puts the bar back where the store says it is.
 */
export async function changeTaskDatesAction(
  deps: TimelineChangeDependencies,
  request: TimelineChangeRequest,
): Promise<TimelineChangeOutcome> {
  const task = deps.state?.tasks.find((candidate) => candidate.id === request.taskId);
  if (task === undefined) return refused(request.operation, 'unknown-task', 'the timeline has no task with that id');

  const span = plannedSpan(task, request);
  if ('reason' in span) return refused(request.operation, span.reason, span.detail);

  deps.setRefusal(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    return refused(request.operation, 'writes-unavailable', reason);
  }

  let written;
  try {
    written = await operations.updateTask({
      taskId: request.taskId as OpaqueRecordId,
      expectedRevision: task.source.revision,
      // One mutation: the two ends travel together, because a task whose start moved and whose end
      // did not is a duration nobody asked for.
      mutations: [{ kind: 'dates', startDate: span.startDate, deadline: span.deadline }],
    });
  } catch {
    return refused(request.operation, 'storage-failure', 'the write could not be attempted');
  }

  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  deps.render();

  return written.ok
    ? {
        ok: true,
        schemaVersion: TIMELINE_CHANGE_SCHEMA_VERSION,
        operation: request.operation,
        taskId: written.recordId,
        revision: written.revision,
        startDate: span.startDate,
        deadline: span.deadline,
        rowApplied: false,
        refreshed: convergence.refreshed,
      }
    : refused(request.operation, written.reason, written.detail, convergence.refreshed);
}
