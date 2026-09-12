/**
 * The workflow board's stage sequences: create, rename and delete.
 *
 * One shape, the same one every other write surface in this tree uses: the sequence lives here
 * where a test can execute it against a real store, the shell supplies only its own state and
 * sinks, and an accepted write is followed by a re-read rather than a redraw from a guess.
 *
 * Two things are specific to stages.
 *
 * **The revision comes from the surface's own world.** A rename or a delete carries the revision
 * the board was rendering, so a reader whose board is stale is told so with the revision that beat
 * them instead of overwriting a stage someone else has already changed.
 *
 * **A delete does not decide what happens to the cards.** The operation refuses a stage that still
 * holds tasks unless the caller says where they go, and this sequence passes that decision through
 * rather than inventing one: a caller that has decided supplies `remapTo`, and the board's own
 * Delete supplies nothing — so a stage with cards answers with the count and the question instead
 * of quietly emptying itself into the workflow.
 */
import type { IdGenerator } from '../domain/clock.js';
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { ProximaState } from '../domain/types.js';
import type {
  CreateWorkflowStageRequest,
  WorkflowStageMutationFailureReason,
  WorkflowStageMutationResult,
  WorkflowStageRemapTarget,
} from './workflowStageMutations.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, semanticOutcomeOf, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const WORKFLOW_STAGE_WRITE_ACTION_SCHEMA_VERSION = 1 as const;

export type WorkflowStageWriteVerb = 'create' | 'rename' | 'delete';

/** The operations the shell resolved, structurally: no store, no coordinator, no paths. */
export interface WorkflowStageWriteOperations {
  createWorkflowStage(request: CreateWorkflowStageRequest): Promise<WorkflowStageMutationResult>;
  renameWorkflowStage(input: {
    stageId: OpaqueRecordId;
    expectedRevision: string;
    name: string;
  }): Promise<WorkflowStageMutationResult>;
  deleteWorkflowStage(input: {
    stageId: OpaqueRecordId;
    expectedRevision: string;
    remapTo?: WorkflowStageRemapTarget;
  }): Promise<WorkflowStageMutationResult>;
}

export interface WorkflowStageWriteDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<WorkflowStageWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  /** What an accepted write did, in one sentence, or null to clear it. */
  readonly setFeedback: (message: string | null) => void;
  readonly render: () => void;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export type WorkflowStageWriteFailureReason =
  | 'unknown-stage'
  | 'writes-unavailable'
  | WorkflowStageMutationFailureReason;

export type WorkflowStageWriteOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof WORKFLOW_STAGE_WRITE_ACTION_SCHEMA_VERSION;
      readonly verb: WorkflowStageWriteVerb;
      readonly outcome: 'created' | 'renamed' | 'deleted';
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly recordId: OpaqueRecordId;
      readonly revision: string;
      readonly refreshed: boolean;
      readonly remappedTaskIds: readonly OpaqueRecordId[];
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof WORKFLOW_STAGE_WRITE_ACTION_SCHEMA_VERSION;
      readonly verb: WorkflowStageWriteVerb;
      readonly reason: WorkflowStageWriteFailureReason;
      readonly detail: string;
      /** Present on a refusal too, so a stage write that moved some cards and stopped is correlatable. */
      readonly requestId: string;
      readonly refreshed: boolean;
      readonly remappedTaskIds: readonly OpaqueRecordId[];
    };

function refused(
  verb: WorkflowStageWriteVerb,
  reason: WorkflowStageWriteFailureReason,
  detail: string,
  requestId: string,
  refreshed = false,
  remappedTaskIds: readonly OpaqueRecordId[] = [],
): WorkflowStageWriteOutcome {
  return {
    ok: false,
    schemaVersion: WORKFLOW_STAGE_WRITE_ACTION_SCHEMA_VERSION,
    verb,
    reason,
    detail,
    requestId,
    refreshed,
    remappedTaskIds,
  };
}

function feedbackFor(
  verb: WorkflowStageWriteVerb,
  written: Extract<WorkflowStageMutationResult, { ok: true }>,
  name: string | null,
): string {
  if (verb === 'create') {
    return name === null || name === '' ? 'Created the stage.' : `Created the stage ${name}.`;
  }
  if (verb === 'rename') {
    return name === null || name === '' ? 'Renamed the stage.' : `Renamed the stage to ${name}.`;
  }
  const moved = written.remappedTaskIds.length;
  return moved === 0
    ? 'Deleted the stage.'
    : `Deleted the stage and moved ${moved} card${moved === 1 ? '' : 's'}.`;
}

/**
 * Run one stage write and converge the surfaces, under the semantic envelope.
 *
 * This is the first family whose write is a *sequence of sequences*: deleting a stage moves its cards through
 * the task operation rather than by a rule of its own. So the run's event carries the stage **and every card
 * that moved**, and a run where cards moved and the stage write then refused is `partial` rather than either an
 * acceptance or a rejection - the surface holds records it did not have before, which is exactly what the
 * shared outcome rule is for.
 *
 * @param deps - the shell's pieces.
 * @param verb - which operation this is, so the result says what was attempted.
 * @param stageId - the stage, or null for a create (which has no id yet).
 * @param name - the name to report in the feedback sentence, when the verb carries one.
 * @param write - the operation to call once a path has resolved.
 * @returns the outcome, with the store's revision when it was accepted.
 */
async function runStageWrite(
  deps: WorkflowStageWriteDependencies,
  verb: WorkflowStageWriteVerb,
  stageId: string | null,
  name: string | null,
  write: (operations: WorkflowStageWriteOperations, revision: string) => Promise<WorkflowStageMutationResult>,
): Promise<WorkflowStageWriteOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const target = stageId === null ? [] : [stageId];
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: `workflow.stage.${verb}`,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  let revision = '';
  if (stageId !== null) {
    const stage = deps.state?.workflowStages?.find((candidate) => candidate.id === stageId);
    if (stage === undefined) {
      audit('rejected', target, 'unknown-stage');
      return refused(verb, 'unknown-stage', 'the board has no stage with that id', requestId);
    }
    revision = stage.revision;
  }

  deps.setRefusal(null);
  deps.setFeedback(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', target, 'writes-unavailable');
    return refused(verb, 'writes-unavailable', reason, requestId);
  }

  const written = await write(operations, revision);
  // The cards the operation moved, whatever it then answered. This is read before convergence on purpose: a
  // refusal that already moved cards has changed the store, so the surfaces are stale and re-reading is owed -
  // the same rule the template action states for a partial write, and the bug this family's own test caught.
  const moved = written.remappedTaskIds ?? [];
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok || moved.length > 0,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  if (written.ok) deps.setFeedback(feedbackFor(verb, written, name));
  deps.render();

  if (!written.ok) {
    audit(semanticOutcomeOf({ wrote: moved.length, refused: true }), [...target, ...moved], written.reason);
    return refused(verb, written.reason, written.detail, requestId, convergence.refreshed, moved);
  }

  audit(semanticOutcomeOf({ wrote: 1, refused: false }), [written.recordId, ...moved]);
  return {
    ok: true,
    schemaVersion: WORKFLOW_STAGE_WRITE_ACTION_SCHEMA_VERSION,
    verb,
    outcome: written.outcome,
    requestId,
    recordId: written.recordId,
    revision: written.revision,
    refreshed: convergence.refreshed,
    remappedTaskIds: written.remappedTaskIds,
  };
}

/** Create the stage the board's form describes, in the project the board is showing. */
export async function createWorkflowStageAction(
  deps: WorkflowStageWriteDependencies,
  input: { readonly projectId: string; readonly name: string },
): Promise<WorkflowStageWriteOutcome> {
  return await runStageWrite(deps, 'create', null, input.name.trim(), async (operations) => await operations.createWorkflowStage({
    projectId: input.projectId as OpaqueRecordId,
    name: input.name,
  }));
}

/** Rename the stage the board was rendering, at the revision it was rendering. */
export async function renameWorkflowStageAction(
  deps: WorkflowStageWriteDependencies,
  input: { readonly stageId: string; readonly name: string },
): Promise<WorkflowStageWriteOutcome> {
  return await runStageWrite(deps, 'rename', input.stageId, input.name.trim(), async (operations, revision) => await operations.renameWorkflowStage({
    stageId: input.stageId as OpaqueRecordId,
    expectedRevision: revision,
    name: input.name,
  }));
}

/**
 * Delete the stage the board was rendering.
 *
 * `remapTo` is the caller's decision and is passed through untouched. The board's own Delete does
 * not supply one, so a stage that still holds cards is answered with the operation's question.
 */
export async function deleteWorkflowStageAction(
  deps: WorkflowStageWriteDependencies,
  input: { readonly stageId: string; readonly remapTo?: WorkflowStageRemapTarget },
): Promise<WorkflowStageWriteOutcome> {
  return await runStageWrite(deps, 'delete', input.stageId, null, async (operations, revision) => await operations.deleteWorkflowStage({
    stageId: input.stageId as OpaqueRecordId,
    expectedRevision: revision,
    ...(input.remapTo === undefined ? {} : { remapTo: input.remapTo }),
  }));
}
