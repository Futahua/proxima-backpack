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
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { ProximaState } from '../domain/types.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import type { TaskFieldMutation, TaskMutationResult } from './taskMutations.js';
import { moveTaskToWorkflowStage, type WorkflowMoveAction, type WorkflowMoveGestureResult } from './workflowMoveGesture.js';

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
      readonly workflowAction: WorkflowMoveAction;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof WORKFLOW_BOARD_DROP_SCHEMA_VERSION;
      readonly reason: WorkflowBoardDropFailureReason;
      readonly detail: string;
      readonly refreshed: boolean;
    };

function refused(reason: WorkflowBoardDropFailureReason, detail: string, refreshed = false): WorkflowBoardDropOutcome {
  return { ok: false, schemaVersion: WORKFLOW_BOARD_DROP_SCHEMA_VERSION, reason, detail, refreshed };
}

export async function performWorkflowDrop(
  deps: WorkflowBoardDropDependencies,
  intent: WorkflowBoardDropIntent,
): Promise<WorkflowBoardDropOutcome> {
  const task = deps.state?.tasks.find((candidate) => candidate.id === intent.taskId);
  if (task === undefined) return refused('unknown-task', 'the board has no card with that id');

  // Cleared before the attempt so a refusal cannot outlive the drop that produced it.
  deps.setRefusal(null);

  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    return refused('writes-unavailable', reason);
  }

  const result = await moveTaskToWorkflowStage(
    {
      updateTask: (input) => writes.updateTask(input),
      refresh: deps.refresh,
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
        workflowAction: result.workflowAction,
        revision: result.revision,
        refreshed: result.refreshed,
      }
    : refused(result.reason, result.detail, result.refreshed);
}
