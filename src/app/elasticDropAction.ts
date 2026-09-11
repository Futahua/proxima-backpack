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
import { executionStateOf } from './recordStateProjection.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { moveTaskByGesture, type TaskMoveActionType, type TaskMoveGestureResult } from './taskMoveGesture.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';

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
}

export interface ElasticDropIntent {
  readonly taskId: string;
  readonly targetColumn: ElasticColumn;
  readonly targetIndex: number;
}

export type ElasticDropOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof ELASTIC_DROP_ACTION_SCHEMA_VERSION;
      readonly actionType: TaskMoveActionType;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof ELASTIC_DROP_ACTION_SCHEMA_VERSION;
      readonly reason: 'unknown-task' | 'writes-unavailable' | TaskMutationFailureReason;
      readonly detail: string;
      readonly refreshed: boolean;
    };

function refused(
  reason: 'unknown-task' | 'writes-unavailable' | TaskMutationFailureReason,
  detail: string,
  refreshed = false,
): ElasticDropOutcome {
  return { ok: false, schemaVersion: ELASTIC_DROP_ACTION_SCHEMA_VERSION, reason, detail, refreshed };
}

export async function performElasticDrop(
  deps: ElasticDropDependencies,
  intent: ElasticDropIntent,
): Promise<ElasticDropOutcome> {
  const task = deps.state?.tasks.find((candidate) => candidate.id === intent.taskId);
  // A card the board is not showing cannot be dropped anywhere: there is no revision to write
  // against, and writing against a guessed one is how a gesture overwrites someone else's edit.
  if (!task) return refused('unknown-task', 'the board has no card with that id');

  // Cleared before the attempt so a refusal cannot outlive the gesture that produced it.
  deps.setRefusal(null);

  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    return refused('writes-unavailable', reason);
  }

  const result: TaskMoveGestureResult = await moveTaskByGesture(
    {
      updateTask: (input) => writes.updateTask(input),
      refresh: deps.refresh,
    },
    {
      taskId: task.id as OpaqueRecordId,
      // The column the card is in *is* the execution state, and the revision it was read at is
      // what turns a lost race into a refusal instead of a silent overwrite.
      from: executionStateOf(task),
      to: intent.targetColumn,
      targetIndex: intent.targetIndex,
      expectedRevision: task.source.revision,
    },
  );

  // One render either way, and it happens after the store answered: on success the refresh has
  // already redrawn from the store, and on refusal this is what shows the card beside the reason.
  if (!result.ok) deps.setRefusal(result.reason);
  deps.render();

  return result.ok
    ? {
        ok: true,
        schemaVersion: ELASTIC_DROP_ACTION_SCHEMA_VERSION,
        actionType: result.actionType,
        revision: result.revision,
        refreshed: result.refreshed,
      }
    : refused(result.reason, result.detail, result.refreshed);
}
