/**
 * A dropped card, from gesture to accepted write.
 *
 * This is the piece that makes Stage 9's UI claims checkable without a browser: a gesture names
 * a target, the gesture writes **one** accepted mutation, and *then* the surface is refreshed
 * from the record store. Nothing is drawn as saved before the store says so, which is why a
 * refusal needs no special "undo" path — the authoritative state was never touched, so the card
 * is already where it belongs.
 *
 * It also decides which semantic operation the gesture *is*: dropping a card into a different
 * column is `task.execution.move`, and dropping it back among its own column's cards is
 * `task.execution.reorder`. The name matters because Stage 17 audits coverage by action type,
 * and a gesture that silently reports the wrong one would make that audit a fiction.
 *
 * The app layer takes a structural dependency here rather than importing the adapter that
 * composes storage: this module knows what a gesture means, not where records live.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CanonicalExecutionState } from '../domain/canonicalTaskState.js';
import type { IdGenerator } from '../domain/clock.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const TASK_MOVE_GESTURE_SCHEMA_VERSION = 1 as const;

export type TaskMoveActionType = 'task.execution.move' | 'task.execution.reorder';

export interface TaskMoveGestureDependencies {
  readonly updateTask: (input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }) => Promise<TaskMutationResult>;
  /** The session's refresh, so every surface converges from the store rather than from a guess. */
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export interface TaskMoveGestureInput {
  readonly taskId: OpaqueRecordId;
  /** The execution state the card is in now, which decides move versus reorder. */
  readonly from: CanonicalExecutionState;
  readonly to: CanonicalExecutionState;
  readonly targetIndex: number;
  /** The revision the card was read at; a caller that lost a race is refused, not merged. */
  readonly expectedRevision: string;
  /**
   * The semantic request id, when a trusted internal layer already minted one for this run.
   *
   * `performElasticDrop` is such a layer: it refuses before this gesture is reached, so it mints at its own
   * boundary and hands the id down rather than leaving its refusals uncorrelated. A wire never supplies one.
   */
  readonly requestId?: string;
}

export type TaskMoveGestureResult =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof TASK_MOVE_GESTURE_SCHEMA_VERSION;
      readonly outcome: 'moved';
      readonly actionType: TaskMoveActionType;
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly revision: string;
      readonly refreshed: boolean;
      /** Set when the write was accepted and the refresh then failed: the write still stands. */
      readonly refreshFailure: string | null;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof TASK_MOVE_GESTURE_SCHEMA_VERSION;
      readonly outcome: 'refused';
      readonly actionType: TaskMoveActionType;
      readonly reason: TaskMutationFailureReason;
      readonly detail: string;
      /** Present on a refusal too, so a refused drop is correlatable with the event it left behind. */
      readonly requestId: string;
      /**
       * True when the refusal was a lost race and the surface was re-read, so the card is
       * showing where the store says it is rather than where this caller last saw it.
       */
      readonly refreshed: boolean;
      readonly refreshFailure: string | null;
      /** The revision that beat this caller, so the surface can refetch rather than guess. */
      readonly actualRevision?: string;
    };

export function taskMoveActionType(
  from: CanonicalExecutionState,
  to: CanonicalExecutionState,
): TaskMoveActionType {
  return from === to ? 'task.execution.reorder' : 'task.execution.move';
}

export async function moveTaskByGesture(
  deps: TaskMoveGestureDependencies,
  input: TaskMoveGestureInput,
): Promise<TaskMoveGestureResult> {
  const actionType = taskMoveActionType(input.from, input.to);
  const requestId = input.requestId ?? mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, errorCode?: string): void => {
    deps.audit.append({
      requestId,
      // The verb the gesture actually is: moving between columns and reordering within one are different
      // semantic operations, and `taskMoveActionType` is the rule that already says which this is.
      actionType,
      outcome,
      entityIds: [input.taskId],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  if (!Number.isSafeInteger(input.targetIndex) || input.targetIndex < 0) {
    audit('rejected', 'validation-refused');
    return {
      ok: false,
      schemaVersion: TASK_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'refused',
      actionType,
      reason: 'validation-refused',
      detail: 'a drop needs a position in the target column',
      requestId,
      refreshed: false,
      refreshFailure: null,
    };
  }

  // One accepted write carries the whole gesture: the card's column and its position are one
  // change as far as a reader is concerned, and two writes could leave a card in the new column
  // at the old index if the second failed.
  const written = await deps.updateTask({
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    mutations: [
      { kind: 'execution-state', value: input.to },
      { kind: 'execution-order', value: input.targetIndex },
    ],
  });

  if (!written.ok) {
    // A lost race is the one refusal where the surface is *wrong* rather than merely unchanged:
    // another writer moved or edited this card, so the board is showing a revision that is no
    // longer the record's. Re-reading is how the card returns to where the store says it is.
    // Every other refusal left the world exactly as it was, and refreshing there would be a
    // redraw that implies something happened.
    const convergence = await convergeAfterWrite(deps, {
      accepted: false,
      lostRace: written.reason === 'stale-revision',
    });

    audit('rejected', written.reason);
    return {
      ok: false,
      schemaVersion: TASK_MOVE_GESTURE_SCHEMA_VERSION,
      outcome: 'refused',
      actionType,
      reason: written.reason,
      detail: written.detail,
      requestId,
      refreshed: convergence.refreshed,
      refreshFailure: convergence.refreshFailure,
      ...(written.actualRevision === undefined ? {} : { actualRevision: written.actualRevision }),
    };
  }

  const convergence = await convergeAfterWrite(deps, { accepted: true });

  audit('accepted');
  return {
    ok: true,
    schemaVersion: TASK_MOVE_GESTURE_SCHEMA_VERSION,
    outcome: 'moved',
    actionType,
    requestId,
    revision: written.revision,
    refreshed: convergence.refreshed,
    refreshFailure: convergence.refreshFailure,
  };
}
