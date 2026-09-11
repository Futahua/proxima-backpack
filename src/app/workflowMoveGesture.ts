/**
 * A dropped card on the project workflow board: from a stage to a stage.
 *
 * This is the Elastic gesture's counterpart on the other axis, and A2 is the reason they are two
 * gestures rather than one. A drop here changes **where the project workflow has this task**; it
 * does not touch the execution state, the Elastic order or completion, and a task in Review is
 * still Running while it happens. The write path enforces that by construction — `workflow-stage`
 * and `execution-state` are separate mutations — and this module is what makes the *gesture* say so.
 *
 * Three moves, and which one it is falls out of the two stage ids rather than out of a mode:
 *
 * - **into a stage** (including the first one) writes the stage and its position together, because
 *   the canonical record refuses either half alone;
 * - **inside a stage** is an order change and nothing else, so it cannot disturb the stage or the
 *   execution dimension;
 * - **out of the workflow** clears both, and a caller that supplied a position for that has a bug
 *   and is refused rather than quietly ignored.
 *
 * The operation is reported as `task.update` with a `workflowAction` discriminator: the action
 * taxonomy has no registered workflow type, and inventing one here — where nothing could audit it —
 * is exactly the kind of vocabulary a coverage audit later finds unbacked. Stage 17's required
 * coverage names `workflow-stage move` and `workflow reorder`, and this is what they will be.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION = 1 as const;

export type WorkflowMoveAction = 'move' | 'reorder' | 'leave';

export interface WorkflowMoveGestureDependencies {
  readonly updateTask: (input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }) => Promise<TaskMutationResult>;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
}

export interface WorkflowMoveGestureInput {
  readonly taskId: OpaqueRecordId;
  /** The stage the card is in now, as the board rendered it; null when it is in none. */
  readonly from: string | null;
  /** The stage it was dropped on; null when it was dropped out of the workflow. */
  readonly to: string | null;
  /** Its position in the target stage. Null exactly when the drop leaves the workflow. */
  readonly targetIndex: number | null;
  readonly expectedRevision: string;
}

export type WorkflowMoveGestureResult =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION;
      readonly outcome: 'moved';
      readonly actionType: 'task.update';
      readonly workflowAction: WorkflowMoveAction;
      readonly revision: string;
      readonly refreshed: boolean;
      readonly refreshFailure: string | null;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION;
      readonly outcome: 'refused';
      readonly actionType: 'task.update';
      readonly workflowAction: WorkflowMoveAction;
      readonly reason: TaskMutationFailureReason | 'validation-refused';
      readonly detail: string;
      readonly refreshed: boolean;
      readonly refreshFailure: string | null;
      readonly actualRevision?: string;
    };

export function workflowMoveAction(from: string | null, to: string | null): WorkflowMoveAction {
  if (to === null) return 'leave';
  return from === to ? 'reorder' : 'move';
}

/**
 * The one mutation pair this gesture is.
 *
 * Exported because a caller that wants to make the same change without a gesture — an agent, or a
 * test asserting the two callers agree — should be able to ask what a drop would write rather than
 * restate it.
 */
export function workflowMutationsFor(
  from: string | null,
  to: string | null,
  targetIndex: number | null,
): readonly TaskFieldMutation[] {
  if (to === null) return [{ kind: 'workflow-stage', value: null, order: null }];
  if (from === to) return [{ kind: 'workflow-order', value: targetIndex ?? 0 }];
  return [{ kind: 'workflow-stage', value: to as OpaqueRecordId, order: targetIndex ?? 0 }];
}

export async function moveTaskToWorkflowStage(
  deps: WorkflowMoveGestureDependencies,
  input: WorkflowMoveGestureInput,
): Promise<WorkflowMoveGestureResult> {
  const workflowAction = workflowMoveAction(input.from, input.to);

  // A position is part of a drop into or inside a stage, and meaningless for a drop out of the
  // workflow — accepting one there would silently discard what the caller asked for.
  if (input.to === null && input.targetIndex !== null) {
    return {
      ok: false,
      schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'refused',
      actionType: 'task.update',
      workflowAction,
      reason: 'validation-refused',
      detail: 'leaving the workflow clears the stage position, so a drop out of it has none',
      refreshed: false,
      refreshFailure: null,
    };
  }
  if (input.to !== null && (!Number.isSafeInteger(input.targetIndex) || (input.targetIndex ?? -1) < 0)) {
    return {
      ok: false,
      schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'refused',
      actionType: 'task.update',
      workflowAction,
      reason: 'validation-refused',
      detail: 'a drop into a stage needs a position in it',
      refreshed: false,
      refreshFailure: null,
    };
  }

  const written = await deps.updateTask({
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    mutations: workflowMutationsFor(input.from, input.to, input.targetIndex),
  });

  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (written.ok) {
    return {
      ok: true,
      schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'moved',
      actionType: 'task.update',
      workflowAction,
      revision: written.revision,
      refreshed: convergence.refreshed,
      refreshFailure: convergence.refreshFailure,
    };
  }

  return {
    ok: false,
    schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
    outcome: 'refused',
    actionType: 'task.update',
    workflowAction,
    reason: written.reason,
    detail: written.detail,
    refreshed: convergence.refreshed,
    refreshFailure: convergence.refreshFailure,
    ...(written.actualRevision === undefined ? {} : { actualRevision: written.actualRevision }),
  };
}
