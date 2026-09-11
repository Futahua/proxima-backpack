/**
 * Bulk actions over a marked selection: `task.bulk.complete` and `task.bulk.delete`.
 *
 * A bulk action is not one write. It is one write per marked record, each with its own observed
 * revision, and the result has to say so — because the alternative is the failure this shape
 * exists to prevent: a selection of ten where seven were written, reported as "done".
 *
 * Four rules, one per thing a bulk action owes its caller.
 *
 * **Zero silent omissions.** Every marked task appears in `entities`, whether it was written or
 * refused. A task missing from the report is a task the caller cannot reason about.
 *
 * **No overall success unless it is one.** `status` is `accepted` only when every entity was
 * accepted, `partial` when some were, and `refused` when none were — so a caller that reads only
 * the summary cannot mistake a partial run for a complete one.
 *
 * **A stale member is a result, not an abort.** One task changing underneath the selection does
 * not stop the others: its entity carries `stale-revision` and the revision that beat it, and the
 * rest of the selection is still attempted. Stopping would make one raced record cost the whole
 * action.
 *
 * **Retry is the caller's.** Exactly one attempt is made per entity, and nothing is retried
 * internally: a caller that wants to try the refused members again asks again with those ids, and
 * that is the only way a bulk action can be safe to run twice.
 *
 * Completion here moves the task to Finished, because that is what a reader means by "complete" and
 * what the board shows. A data-only completion edit — a completed task still in Running — stays
 * available through the editor's own field, which is where a distinction that fine belongs.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { ProximaState } from '../domain/types.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';

export const BULK_TASK_ACTION_SCHEMA_VERSION = 1 as const;

export type BulkTaskActionKind = 'task.bulk.complete' | 'task.bulk.delete';

export type BulkEntityOutcome =
  | {
      readonly taskId: string;
      readonly ok: true;
      readonly revision: string;
    }
  | {
      readonly taskId: string;
      readonly ok: false;
      readonly reason: TaskMutationFailureReason | 'writes-unavailable' | 'unknown-task';
      readonly detail: string;
      /** The revision that beat this member, when the refusal was a lost race. */
      readonly actualRevision?: string;
    };

export type BulkTaskActionStatus = 'accepted' | 'partial' | 'refused';

export interface BulkTaskActionReport {
  readonly schemaVersion: typeof BULK_TASK_ACTION_SCHEMA_VERSION;
  readonly action: BulkTaskActionKind;
  /** How the caller is meant to read this: never `accepted` unless every member was. */
  readonly status: BulkTaskActionStatus;
  readonly requested: number;
  readonly accepted: number;
  readonly refused: number;
  /** One entry per requested task, in the order requested. */
  readonly entities: readonly BulkEntityOutcome[];
  readonly refreshed: boolean;
}

export interface BulkTaskWriteOperations {
  updateTask(input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }): Promise<TaskMutationResult>;
  deleteTask(input: { taskId: OpaqueRecordId; expectedRevision: string }): Promise<TaskMutationResult>;
}

export interface BulkTaskActionDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<BulkTaskWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  readonly render: () => void;
}

function statusOf(entities: readonly BulkEntityOutcome[]): BulkTaskActionStatus {
  const accepted = entities.filter((entity) => entity.ok).length;
  if (entities.length > 0 && accepted === entities.length) return 'accepted';
  return accepted === 0 ? 'refused' : 'partial';
}

function report(
  action: BulkTaskActionKind,
  entities: readonly BulkEntityOutcome[],
  refreshed: boolean,
): BulkTaskActionReport {
  return {
    schemaVersion: BULK_TASK_ACTION_SCHEMA_VERSION,
    action,
    status: statusOf(entities),
    requested: entities.length,
    accepted: entities.filter((entity) => entity.ok).length,
    refused: entities.filter((entity) => !entity.ok).length,
    entities,
    refreshed,
  };
}

/** What a refused member records, so nothing is summarised away. */
function refusal(entity: TaskMutationResult, taskId: string): BulkEntityOutcome {
  if (entity.ok) return { taskId, ok: true, revision: entity.revision };
  return {
    taskId,
    ok: false,
    reason: entity.reason,
    detail: entity.detail,
    ...(entity.actualRevision === undefined ? {} : { actualRevision: entity.actualRevision }),
  };
}

/**
 * Run one write per marked task, reporting each outcome.
 *
 * @param deps - the shell's pieces: the world it rendered, where operations come from, and refresh.
 * @param input - the marked task ids, in the order the caller wants them reported.
 * @param action - which bulk action this is, which decides the write and the report's name.
 * @returns the per-entity report, with a status that cannot overstate it.
 */
async function runBulk(
  deps: BulkTaskActionDependencies,
  input: { readonly taskIds: readonly string[] },
  action: BulkTaskActionKind,
): Promise<BulkTaskActionReport> {
  const requested = [...input.taskIds];
  if (requested.length === 0) {
    // An action with nothing marked is refused as a whole: there are no entities to report, and
    // "accepted" for zero writes is the kind of success a caller should never be told.
    return report(action, [], false);
  }

  const state = deps.state;
  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    const entities: BulkEntityOutcome[] = requested.map((taskId) => ({
      taskId,
      ok: false,
      reason: 'writes-unavailable' as const,
      detail: reason,
    }));
    deps.render();
    return report(action, entities, false);
  }

  const entities: BulkEntityOutcome[] = [];
  let acceptedAny = false;

  for (const taskId of requested) {
    const task = state?.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      entities.push({ taskId, ok: false, reason: 'unknown-task', detail: 'the selection names a task that is not loaded' });
      continue;
    }

    // One attempt per entity, with the revision the surface was rendering. A member that lost a
    // race is reported and the loop continues: one raced record must not cost the whole action.
    const result = action === 'task.bulk.delete'
      ? await writes.deleteTask({ taskId: taskId as OpaqueRecordId, expectedRevision: task.source.revision })
      : await writes.updateTask({
          taskId: taskId as OpaqueRecordId,
          expectedRevision: task.source.revision,
          mutations: [{ kind: 'execution-state', value: 'finished' }],
        });

    entities.push(refusal(result, taskId));
    acceptedAny ||= result.ok;
  }

  let refreshed = false;
  if (acceptedAny) {
    try {
      const result = await deps.refresh('manual');
      refreshed = result !== null;
    } catch {
      refreshed = false;
    }
  }
  deps.render();

  return report(action, entities, refreshed);
}

export async function bulkCompleteTasks(
  deps: BulkTaskActionDependencies,
  input: { readonly taskIds: readonly string[] },
): Promise<BulkTaskActionReport> {
  return await runBulk(deps, input, 'task.bulk.complete');
}

export async function bulkDeleteTasks(
  deps: BulkTaskActionDependencies,
  input: { readonly taskIds: readonly string[] },
): Promise<BulkTaskActionReport> {
  return await runBulk(deps, input, 'task.bulk.delete');
}
