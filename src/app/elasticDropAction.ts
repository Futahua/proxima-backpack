/**
 * A dropped card, from gesture to converged surface — the wiring, as a thing that can be run.
 *
 * The browser shell used to hold this sequence inline, which meant the one step that joins the
 * binder's intent to the semantic write path was guarded by reading `main.ts` as text and never
 * executed. It lives here instead, where the app layer already owns "what a gesture means" and a
 * test can drive a real store through the whole chain: intent, sanctioned write, refresh, and the
 * refusal the surface will draw.
 *
 * Nothing is drawn as moved before the write is accepted. The card is never optimistic, so a
 * refusal needs no undo path — the authoritative record never changed, and every render in this
 * file happens *after* the store has answered.
 *
 * The shell supplies the pieces it owns: where the write operations come from, what to say when
 * there are none, the session's refresh, and the two sinks a render needs — the refusal to draw
 * and the render itself. It supplies no storage, which is what keeps the containment rule true.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { ElasticColumn, ProximaState } from '../domain/types.js';
import type { IdGenerator } from '../domain/clock.js';
import { executionStateOf } from './recordStateProjection.js';
import { refusalTextFor } from './refusalPresentation.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import { moveTaskByGesture, type TaskMoveActionType, type TaskMoveGestureResult } from './taskMoveGesture.js';
import type { TaskFieldMutation, TaskMutationResult } from './taskMutations.js';

export const ELASTIC_DROP_ACTION_SCHEMA_VERSION = 1 as const;

/**
 * The one operation a drop needs, structurally.
 *
 * Narrow on purpose: the adapter hands the shell create, update and delete, and a gesture has no
 * business with the other two.
 */
export interface ElasticDropWriteOperations {
  updateTask(input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }): Promise<TaskMutationResult>;
}

export interface ElasticDropDependencies {
  /** The world the board is rendering, or null before the first load. */
  readonly state: ProximaState | null;
  /** Resolve the sanctioned write path; null when this run may not write records. */
  readonly writes: () => Promise<ElasticDropWriteOperations | null>;
  /** Why there is no write path, in words a reader can act on. */
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
  /** Mints this run's semantic request id, which the gesture below is handed rather than minting its own. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export interface ElasticDropIntent {
  readonly taskId: string;
  readonly targetColumn: ElasticColumn;
  readonly targetIndex: number;
}

/**
 * A refusal this wrapper decides before the gesture is reached.
 *
 * A drop refused because the board is not showing the card, or because this run has no write path, has no
 * truthful move-versus-reorder answer: the column the card is in is exactly what is missing. The wrapper
 * names the family `task.execution.move`, which is what its own audit event already said, rather than
 * guessing a verb it cannot know.
 */
export interface ElasticDropPreGestureRefusal {
  readonly ok: false;
  readonly schemaVersion: typeof ELASTIC_DROP_ACTION_SCHEMA_VERSION;
  readonly outcome: 'refused';
  readonly actionType: TaskMoveActionType;
  readonly reason: 'unknown-task' | 'writes-unavailable';
  readonly detail: string;
  /** Present on a refusal too: a refused drop is correlatable with the event it left behind. */
  readonly requestId: string;
  readonly refreshed: boolean;
}

/**
 * The drop's result **is** the gesture's result, deliberately.
 *
 * A wrapper that reshaped it would make the surface's answer and the agent's answer two vocabularies for
 * one operation, which is the thing Stage 17's parity box exists to rule out: the same drop submitted
 * through the agent write path returns the same object, field for field, apart from the run's own request
 * id. So this file adds only the two refusals it decides itself - in that same shape - and hands everything
 * else through untouched.
 */
export type ElasticDropOutcome = TaskMoveGestureResult | ElasticDropPreGestureRefusal;

function refused(
  reason: 'unknown-task' | 'writes-unavailable',
  detail: string,
  requestId: string,
  refreshed = false,
): ElasticDropPreGestureRefusal {
  return {
    ok: false,
    schemaVersion: ELASTIC_DROP_ACTION_SCHEMA_VERSION,
    outcome: 'refused',
    actionType: 'task.execution.move',
    reason,
    detail,
    requestId,
    refreshed,
  };
}

export async function performElasticDrop(
  deps: ElasticDropDependencies,
  intent: ElasticDropIntent,
): Promise<ElasticDropOutcome> {
  // The boundary for this run, minted before the two refusals below can happen and handed down to the
  // gesture, so a drop refused because the board has no such card or because there is no write path is
  // journalled with the same id an accepted drop would have carried.
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, errorCode: string, entityIds: readonly string[]): void => {
    deps.audit.append({ requestId, actionType: 'task.execution.move', outcome, entityIds: [...entityIds], errorCode });
  };

  const task = deps.state?.tasks.find((candidate) => candidate.id === intent.taskId);
  // A card the board is not showing cannot be dropped anywhere: there is no revision to write
  // against, and writing against a guessed one is how a gesture overwrites someone else's edit.
  if (!task) {
    audit('rejected', 'unknown-task', []);
    return refused('unknown-task', 'the board has no card with that id', requestId);
  }

  // Cleared before the attempt so a refusal cannot outlive the gesture that produced it.
  deps.setRefusal(null);

  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', 'writes-unavailable', [task.id]);
    return refused('writes-unavailable', reason, requestId);
  }

  const result: TaskMoveGestureResult = await moveTaskByGesture(
    {
      updateTask: (input) => writes.updateTask(input),
      refresh: deps.refresh,
      ids: deps.ids,
      audit: deps.audit,
    },
    {
      taskId: task.id as OpaqueRecordId,
      // The column the card is in *is* the execution state, and the revision it was read at is
      // what turns a lost race into a refusal instead of a silent overwrite.
      from: executionStateOf(task),
      to: intent.targetColumn,
      targetIndex: intent.targetIndex,
      expectedRevision: task.source.revision,
      requestId,
    },
  );

  // One render either way, and it happens after the store answered: on success the refresh has
  // already redrawn from the store, and on refusal this is what shows the card beside the reason.
  // The refusal is written down rather than passed through as a code: the gesture result already
  // carries the sentence and the revision that beat this caller, and a reader who lost a race needs
  // both to know what happened to their card.
  if (!result.ok) {
    deps.setRefusal(refusalTextFor({
      code: result.reason,
      detail: result.detail,
      actualRevision: result.actualRevision,
    }));
  }
  deps.render();

  return result;
}
