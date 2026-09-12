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
import type { IdGenerator } from '../domain/clock.js';
import type { ProximaState } from '../domain/types.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
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
  /**
   * Whether anything landed, which is the same question every other result in this tree answers with `ok`.
   *
   * Derived rather than decided a second time: false exactly when the status is `refused`, and true for a
   * `partial` run, because a partial run did write records and reporting it as a failure would be the lie the
   * status field exists to avoid. It is here so a caller can ask "did this succeed" of a submission result
   * without first asking which family answered: a union member with no discriminant is one no guard narrows.
   */
  readonly ok: boolean;
  readonly action: BulkTaskActionKind;
  /** How the caller is meant to read this: never `accepted` unless every member was. */
  readonly status: BulkTaskActionStatus;
  /** This run's semantic request id: one run, one id, however many members it touched. */
  readonly requestId: string;
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

export interface BulkTaskActionDependencies extends BulkTaskActionOperationDependencies {
  readonly state: ProximaState | null;
  readonly render: () => void;
}

/**
 * What the operation needs, and nothing a cockpit owns.
 *
 * The one fact a bulk run took from a projection was each member's revision, and the caller is the one that
 * read the selection - so it arrives through `resolveRevision`, which answers with the revision the caller read
 * for a member and null for one it cannot answer for. The cockpit answers from the board it rendered; the agent
 * wire answers from the revisions the agent sent. `render` is the surface's own and stays above.
 */
export interface BulkTaskActionOperationDependencies {
  readonly writes: () => Promise<BulkTaskWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** Mints this run's semantic request id: one per run, not one per member. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
  /**
   * The revision a member is written at, or null when the caller cannot answer for it.
   *
   * Null is a refusal and not a default: a member the caller cannot say it read is one this run will not write
   * on a guess, and the report names it as unknown rather than losing the whole selection to it.
   */
  readonly resolveRevision?: (taskId: string) => string | null;
  /**
   * What the surface does with the run so far, before the run is journalled.
   *
   * Present only where there is a surface, because the order is this family's contract: the board redraws after
   * convergence and before the terminal event. A caller with no board omits it and draws nothing, which is
   * exactly what the agent wire does.
   */
  readonly settle?: () => void;
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
  requestId: string,
): BulkTaskActionReport {
  return {
    schemaVersion: BULK_TASK_ACTION_SCHEMA_VERSION,
    ok: statusOf(entities) !== 'refused',
    action,
    status: statusOf(entities),
    requestId,
    requested: entities.length,
    accepted: entities.filter((entity) => entity.ok).length,
    refused: entities.filter((entity) => !entity.ok).length,
    entities,
    refreshed,
  };
}

/** The run's outcome, from the status the report already computes: `refused` is the journal's `rejected`. */
function semanticOutcomeOfStatus(status: BulkTaskActionStatus): SemanticOutcome {
  switch (status) {
    case 'accepted':
      return 'accepted';
    case 'partial':
      return 'partial';
    default:
      return 'rejected';
  }
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
export async function runBulk(
  deps: BulkTaskActionOperationDependencies,
  input: { readonly taskIds: readonly string[] },
  action: BulkTaskActionKind,
): Promise<BulkTaskActionReport> {
  // One run, one id, whatever the selection holds: a bulk action is one semantic operation even though it
  // writes many records, and the journal that gave every member its own id would stop being a record of what
  // a person asked for.
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: action,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  const requested = [...input.taskIds];
  if (requested.length === 0) {
    // An action with nothing marked is refused as a whole: there are no entities to report, and
    // "accepted" for zero writes is the kind of success a caller should never be told.
    audit('rejected', [], 'nothing-selected');
    return report(action, [], false, requestId);
  }

  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    const entities: BulkEntityOutcome[] = requested.map((taskId) => ({
      taskId,
      ok: false,
      reason: 'writes-unavailable' as const,
      detail: reason,
    }));
    deps.settle?.();
    audit('rejected', requested, 'writes-unavailable');
    return report(action, entities, false, requestId);
  }

  const entities: BulkEntityOutcome[] = [];
  let acceptedAny = false;

  for (const taskId of requested) {
    const revision = deps.resolveRevision?.(taskId) ?? null;
    if (revision === null) {
      entities.push({ taskId, ok: false, reason: 'unknown-task', detail: 'the selection names a task that is not loaded' });
      continue;
    }

    // One attempt per entity, with the revision the caller read. A member that lost a race is reported and the
    // loop continues: one raced record must not cost the whole action.
    const result = action === 'task.bulk.delete'
      ? await writes.deleteTask({ taskId: taskId as OpaqueRecordId, expectedRevision: revision })
      : await writes.updateTask({
          taskId: taskId as OpaqueRecordId,
          expectedRevision: revision,
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
  deps.settle?.();

  const built = report(action, entities, refreshed, requestId);
  // One terminal event for the whole run, after convergence: the outcome comes from the members - a selection
  // where some landed and some were refused is `partial`, which is neither an acceptance nor a rejection -
  // and the ids are the records that landed. A run where *nothing* landed names the targets it was refused
  // about instead, because a rejection nobody can trace to a record is a dead end.
  const landed = entities.filter((entity) => entity.ok).map((entity) => entity.taskId);
  const about = built.status === 'refused' ? requested : landed;
  const stopped = entities.find((entity) => !entity.ok);
  audit(
    semanticOutcomeOfStatus(built.status),
    about,
    built.status === 'accepted' || stopped === undefined || stopped.ok ? undefined : stopped.reason,
  );

  return built;
}

/**
 * The cockpit's entry: answer each member's revision from the board it rendered, then draw the report.
 *
 * The board is handed over as a resolver rather than read here, so the "not loaded" refusal is still the run's
 * own and stays in one place. A caller with no board supplies its own resolver - the agent wire answers with
 * the revisions the agent sent - and this wrapper is not on its path.
 */
async function runBulkFromBoard(
  deps: BulkTaskActionDependencies,
  input: { readonly taskIds: readonly string[] },
  action: BulkTaskActionKind,
): Promise<BulkTaskActionReport> {
  return await runBulk(
    {
      ...deps,
      resolveRevision: (taskId) => deps.state?.tasks.find((candidate) => candidate.id === taskId)?.source.revision ?? null,
      settle: () => deps.render(),
    },
    input,
    action,
  );
}

export async function bulkCompleteTasks(
  deps: BulkTaskActionDependencies,
  input: { readonly taskIds: readonly string[] },
): Promise<BulkTaskActionReport> {
  return await runBulkFromBoard(deps, input, 'task.bulk.complete');
}

export async function bulkDeleteTasks(
  deps: BulkTaskActionDependencies,
  input: { readonly taskIds: readonly string[] },
): Promise<BulkTaskActionReport> {
  return await runBulkFromBoard(deps, input, 'task.bulk.delete');
}
