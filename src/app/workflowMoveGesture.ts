/**
 * A dropped card on the project workflow board: from a stage to a stage.
 *
 * This is the Elastic gesture's counterpart on the other axis, and A2 is the reason they are two
 * gestures rather than one. A drop here changes **where the project workflow has this task**; it
 * does not touch the execution state, the Elastic order or completion, and a task in Review is
 * still Running while it happens. The write path enforces that by construction — `workflow-stage`
 * and `execution-order` are separate mutations — and this module is what makes the *gesture* say so.
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
 * The operation names itself, and the two names are the two rows Stage 17 audits: a drop into or out
 * of the workflow is `task.workflow.move`, and a drop inside a stage is `task.workflow.reorder`. This
 * file used to report both as `task.update` with a `workflowAction` discriminator, for a reason that
 * has now expired — the taxonomy had no registered workflow verb, and inventing one where nothing
 * could audit it is how a coverage audit later finds unbacked vocabulary. The matrix is that audit,
 * and D79 registers the two verbs it asks for.
 *
 * One run leaves one terminal event, minted here before the target can be wrong and handed down by a
 * wrapper that decided its own refusals first, for the reason every other semantic action does it:
 * a refusal that leaves no event is a refusal nobody can trace.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { IdGenerator } from '../domain/clock.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION = 1 as const;

export type WorkflowMoveAction = 'move' | 'reorder' | 'leave';

/** The two semantic operations a workflow drop can be. */
export type WorkflowMoveActionType = 'task.workflow.move' | 'task.workflow.reorder';

export interface WorkflowMoveGestureDependencies {
  readonly updateTask: (input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }) => Promise<TaskMutationResult>;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
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
  /**
   * The semantic request id, when a trusted internal layer already minted one for this run.
   *
   * `performWorkflowDrop` is such a layer: it refuses before this gesture is reached, so it mints at
   * its own boundary and hands the id down rather than leaving its refusals uncorrelated.
   */
  readonly requestId?: string;
}

export type WorkflowMoveGestureResult =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION;
      readonly outcome: 'moved';
      readonly actionType: WorkflowMoveActionType;
      readonly workflowAction: WorkflowMoveAction;
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly revision: string;
      readonly refreshed: boolean;
      readonly refreshFailure: string | null;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION;
      readonly outcome: 'refused';
      readonly actionType: WorkflowMoveActionType;
      readonly workflowAction: WorkflowMoveAction;
      readonly reason: TaskMutationFailureReason | 'validation-refused';
      readonly detail: string;
      /** Present on a refusal too, so a refused drop is correlatable with the event it left behind. */
      readonly requestId: string;
      readonly refreshed: boolean;
      readonly refreshFailure: string | null;
      readonly actualRevision?: string;
    };

export function workflowMoveAction(from: string | null, to: string | null): WorkflowMoveAction {
  if (to === null) return 'leave';
  return from === to ? 'reorder' : 'move';
}

/**
 * Which semantic operation a drop is.
 *
 * A leave names `task.workflow.move` rather than a third verb: clearing the stage is the same
 * operation as setting one — the card's place in the workflow changed — and a separate verb for the
 * empty case would make two names for one thing a reader cannot tell apart in a journal.
 */
export function workflowMoveActionType(action: WorkflowMoveAction): WorkflowMoveActionType {
  return action === 'reorder' ? 'task.workflow.reorder' : 'task.workflow.move';
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
  const actionType = workflowMoveActionType(workflowAction);
  const requestId = input.requestId ?? mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, errorCode?: string): void => {
    deps.audit.append({
      requestId,
      // The verb the drop actually is: entering or leaving a stage and reordering inside one are
      // different semantic operations, and `workflowMoveActionType` is the rule that says which.
      actionType,
      outcome,
      entityIds: [input.taskId],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  // A position is part of a drop into or inside a stage, and meaningless for a drop out of the
  // workflow — accepting one there would silently discard what the caller asked for.
  if (input.to === null && input.targetIndex !== null) {
    audit('rejected', 'validation-refused');
    return {
      ok: false,
      schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'refused',
      actionType,
      workflowAction,
      reason: 'validation-refused',
      detail: 'leaving the workflow clears the stage position, so a drop out of it has none',
      requestId,
      refreshed: false,
      refreshFailure: null,
    };
  }
  if (input.to !== null && (!Number.isSafeInteger(input.targetIndex) || (input.targetIndex ?? -1) < 0)) {
    audit('rejected', 'validation-refused');
    return {
      ok: false,
      schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'refused',
      actionType,
      workflowAction,
      reason: 'validation-refused',
      detail: 'a drop into a stage needs a position in it',
      requestId,
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
    // After convergence, never before it: the event reports a state a reader can go and look at.
    audit('accepted');
    return {
      ok: true,
      schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'moved',
      actionType,
      workflowAction,
      requestId,
      revision: written.revision,
      refreshed: convergence.refreshed,
      refreshFailure: convergence.refreshFailure,
    };
  }

  audit('rejected', written.reason);
  return {
    ok: false,
    schemaVersion: WORKFLOW_MOVE_GESTURE_SCHEMA_VERSION,
    outcome: 'refused',
    actionType,
    workflowAction,
    reason: written.reason,
    detail: written.detail,
    requestId,
    refreshed: convergence.refreshed,
    refreshFailure: convergence.refreshFailure,
    ...(written.actualRevision === undefined ? {} : { actualRevision: written.actualRevision }),
  };
}
