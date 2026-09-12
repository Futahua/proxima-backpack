/**
 * A dropped card on the project workflow board: intent to write, by the rule every drop follows.
 *
 * The board reports what was dropped where; this decides what that means. The stage the card is
 * leaving comes from the world the board was *rendering* — not from a fresh read — because that is
 * the revision the reader was looking at, and a drop built on a fresher one would silently
 * overwrite whatever happened in between.
 *
 * A card the board is not showing is refused without resolving a write path, for the same reason
 * the Elastic drop refuses one: there is no revision to write against, and guessing one is how a
 * gesture overwrites someone else's edit.
 *
 * This is also the boundary that mints the run's semantic request id, exactly as `performElasticDrop`
 * does on the other axis: the two refusals below are decided *before* the gesture is reached, so an
 * id minted inside the gesture would leave them with no correlation id and no event at all.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { IdGenerator } from '../domain/clock.js';
import type { ProximaState } from '../domain/types.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import type { TaskFieldMutation, TaskMutationResult } from './taskMutations.js';
import {
  moveTaskToWorkflowStage,
  type WorkflowMoveAction,
  type WorkflowMoveActionType,
  type WorkflowMoveGestureResult,
} from './workflowMoveGesture.js';

export const WORKFLOW_BOARD_DROP_SCHEMA_VERSION = 1 as const;

export interface WorkflowBoardWriteOperations {
  updateTask(input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }): Promise<TaskMutationResult>;
}

export interface WorkflowBoardDropDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<WorkflowBoardWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes, for the refusals decided here as much as the gesture's. */
  readonly audit: SemanticAuditSink;
}

export interface WorkflowBoardDropIntent {
  readonly taskId: string;
  /** Null when the card was dropped on the "no stage" column. */
  readonly targetStageId: string | null;
  readonly targetIndex: number;
}

export type WorkflowBoardDropFailureReason =
  | 'unknown-task'
  | 'writes-unavailable'
  | Extract<WorkflowMoveGestureResult, { ok: false }>['reason'];

export type WorkflowBoardDropOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof WORKFLOW_BOARD_DROP_SCHEMA_VERSION;
      readonly actionType: WorkflowMoveActionType;
      readonly workflowAction: WorkflowMoveAction;
      /** This run's semantic request id, so a caller can correlate the answer with the event. */
      readonly requestId: string;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof WORKFLOW_BOARD_DROP_SCHEMA_VERSION;
      readonly actionType: WorkflowMoveActionType;
      readonly reason: WorkflowBoardDropFailureReason;
      readonly detail: string;
      /** Present on a refusal too: a refused drop is correlatable with the event it left behind. */
      readonly requestId: string;
      readonly refreshed: boolean;
    };

/**
 * A refusal this wrapper decides before the gesture is reached.
 *
 * A drop refused because the board is not showing the card, or because this run has no write path, has
 * no truthful move-versus-reorder answer the wrapper can stand behind — and `task.workflow.move` is the
 * family verb its own event already names either way, so it does not guess a sharper one.
 */
function refused(
  reason: WorkflowBoardDropFailureReason,
  detail: string,
  requestId: string,
  refreshed = false,
): WorkflowBoardDropOutcome {
  return {
    ok: false,
    schemaVersion: WORKFLOW_BOARD_DROP_SCHEMA_VERSION,
    actionType: 'task.workflow.move',
    reason,
    detail,
    requestId,
    refreshed,
  };
}

export async function performWorkflowDrop(
  deps: WorkflowBoardDropDependencies,
  intent: WorkflowBoardDropIntent,
): Promise<WorkflowBoardDropOutcome> {
  // The boundary for this run, minted before the two refusals below can happen and handed down to the
  // gesture, so a drop refused because the board has no such card or because there is no write path is
  // journalled with the same id an accepted drop would have carried.
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, errorCode: string, entityIds: readonly string[]): void => {
    deps.audit.append({ requestId, actionType: 'task.workflow.move', outcome, entityIds: [...entityIds], errorCode });
  };

  const task = deps.state?.tasks.find((candidate) => candidate.id === intent.taskId);
  if (task === undefined) {
    audit('rejected', 'unknown-task', []);
    return refused('unknown-task', 'the board has no card with that id', requestId);
  }

  // Cleared before the attempt so a refusal cannot outlive the drop that produced it.
  deps.setRefusal(null);

  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', 'writes-unavailable', [task.id]);
    return refused('writes-unavailable', reason, requestId);
  }

  const result = await moveTaskToWorkflowStage(
    {
      updateTask: (input) => writes.updateTask(input),
      refresh: deps.refresh,
      ids: deps.ids,
      audit: deps.audit,
    },
    {
      taskId: task.id as OpaqueRecordId,
      // The stage the board drew is the stage the record is in as far as this reader knows, and the
      // revision the card was read at is what makes a lost race a refusal rather than an overwrite.
      from: task.workflowStageId ?? null,
      to: intent.targetStageId,
      // The board reports a slot index for every column, including the trailing one; leaving the
      // workflow has no position in it, and the gesture refuses a leave that carries one.
      targetIndex: intent.targetStageId === null ? null : intent.targetIndex,
      expectedRevision: task.source.revision,
      // The id this run already minted, so the gesture does not mint a second one for one drop.
      requestId,
    },
  );

  // One render either way, after the store answered: on success the refresh has already redrawn,
  // and on refusal this is what shows the card beside the reason.
  if (!result.ok) deps.setRefusal(result.reason);
  deps.render();

  return result.ok
    ? {
        ok: true,
        schemaVersion: WORKFLOW_BOARD_DROP_SCHEMA_VERSION,
        actionType: result.actionType,
        workflowAction: result.workflowAction,
        requestId: result.requestId,
        revision: result.revision,
        refreshed: result.refreshed,
      }
    : {
        ok: false,
        schemaVersion: WORKFLOW_BOARD_DROP_SCHEMA_VERSION,
        actionType: result.actionType,
        reason: result.reason,
        detail: result.detail,
        requestId: result.requestId,
        refreshed: result.refreshed,
      };
}
