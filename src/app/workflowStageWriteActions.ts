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
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { ProximaState } from '../domain/types.js';
import type {
  CreateWorkflowStageRequest,
  WorkflowStageMutationFailureReason,
  WorkflowStageMutationResult,
  WorkflowStageRemapTarget,
} from './workflowStageMutations.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
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
      readonly refreshed: boolean;
      readonly remappedTaskIds: readonly OpaqueRecordId[];
    };

function refused(
  verb: WorkflowStageWriteVerb,
  reason: WorkflowStageWriteFailureReason,
  detail: string,
  refreshed = false,
  remappedTaskIds: readonly OpaqueRecordId[] = [],
): WorkflowStageWriteOutcome {
  return {
    ok: false,
    schemaVersion: WORKFLOW_STAGE_WRITE_ACTION_SCHEMA_VERSION,
    verb,
    reason,
    detail,
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
 * Run one stage write and converge the surfaces.
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
  let revision = '';
  if (stageId !== null) {
    const stage = deps.state?.workflowStages?.find((candidate) => candidate.id === stageId);
    if (stage === undefined) return refused(verb, 'unknown-stage', 'the board has no stage with that id');
    revision = stage.revision;
  }

  deps.setRefusal(null);
  deps.setFeedback(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    return refused(verb, 'writes-unavailable', reason);
  }

  const written = await write(operations, revision);
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  if (written.ok) deps.setFeedback(feedbackFor(verb, written, name));
  deps.render();

  return written.ok
    ? {
        ok: true,
        schemaVersion: WORKFLOW_STAGE_WRITE_ACTION_SCHEMA_VERSION,
        verb,
        outcome: written.outcome,
        recordId: written.recordId,
        revision: written.revision,
        refreshed: convergence.refreshed,
        remappedTaskIds: written.remappedTaskIds,
      }
    : refused(verb, written.reason, written.detail, convergence.refreshed, written.remappedTaskIds ?? []);
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
