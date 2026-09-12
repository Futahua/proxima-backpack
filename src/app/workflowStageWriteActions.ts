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

/**
 * The three verbs, as the action type a journal names them by.
 *
 * The taxonomy registers no stage verb - like the schema family, these are reached through a sibling entry
 * rather than through `dispatch` - so this one function is what keeps the operation and any wire that reaches
 * it agreeing about what a stage write is called, instead of each spelling `workflow.stage.` for itself.
 */
export function workflowStageActionType(verb: WorkflowStageWriteVerb): string {
  return `workflow.stage.${verb}`;
}

/** The verbs a submission may name, for a boundary that has to test a value rather than trust a type. */
export const WORKFLOW_STAGE_WRITE_VERBS: readonly WorkflowStageWriteVerb[] = ['create', 'rename', 'delete'];

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

/**
 * What the operation needs, and nothing a cockpit owns.
 *
 * There is no `state` here, and that is the whole shape of this family's extension: the only fact the sequence
 * ever took from the projection was a stage's revision, and a caller that read the record has it. A create
 * never had one. So a caller with no board to consult can run this, and the cockpit below hands it what it
 * just read - `setRefusal`, `setFeedback` and `render` stay where they belong, on the surface's entry.
 */
export interface WorkflowStageWriteOperationDependencies {
  readonly writes: () => Promise<WorkflowStageWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  readonly ids: IdGenerator;
  readonly audit: SemanticAuditSink;
  /**
   * What the surface does with the answer, before the run is journalled.
   *
   * Present only where there is a surface: the board shows the refusal or the feedback sentence and redraws
   * here, which is why this hook exists rather than a `render` call after `runStageWrite` returns - the order
   * is the family's contract, and this test file pins it (`refresh, render, audit:accepted`; `render,
   * audit:rejected`). A caller with no surface omits it and draws nothing. It is not called for a stage the
   * lookup could not find, because that refusal is decided before the write path was ever resolved and the
   * board is left exactly as it was.
   */
  readonly settle?: (outcome: WorkflowStageWriteOutcome) => void;
}

/** The cockpit's entry needs the operation's pieces plus the board's own: what it read, and what it draws. */
export interface WorkflowStageWriteDependencies extends WorkflowStageWriteOperationDependencies {
  readonly state: ProximaState | null;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  /** What an accepted write did, in one sentence, or null to clear it. */
  readonly setFeedback: (message: string | null) => void;
  readonly render: () => void;
}

export type WorkflowStageWriteFailureReason =
  | 'unknown-stage'
  | 'validation-refused'
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

/**
 * What an accepted write did, in one sentence, from the result rather than from the operation's own record.
 *
 * It reads the outcome and the remapped cards, which are the two facts the result carries, so it works the
 * same for a caller that never saw the mutation result the way the board does.
 */
function feedbackSentence(
  outcome: Extract<WorkflowStageWriteOutcome, { ok: true }>,
  name: string | null,
): string {
  if (outcome.outcome === 'created') {
    return name === null || name === '' ? 'Created the stage.' : `Created the stage ${name}.`;
  }
  if (outcome.outcome === 'renamed') {
    return name === null || name === '' ? 'Renamed the stage.' : `Renamed the stage to ${name}.`;
  }
  const moved = outcome.remappedTaskIds.length;
  return moved === 0
    ? 'Deleted the stage.'
    : `Deleted the stage and moved ${moved} card${moved === 1 ? '' : 's'}.`;
}

/**
 * Where the revision a stage write must carry comes from, when the caller does not already have it.
 *
 * The board supplies a lookup over the projection it is showing, which is how "the board has no stage with
 * that id" stays a journalled refusal of this run rather than a check in front of it. A wire supplies the
 * revision directly, or supplies no lookup at all and is refused for naming none. Both are one call: the run
 * mints its id before either answer, so a refusal decided here is correlatable exactly like an accepted write.
 */
export type WorkflowStageRevisionLookup = (stageId: string) => string | null;

/**
 * Run one stage write and converge the surfaces, under the semantic envelope.
 *
 * This is the first family whose write is a *sequence of sequences*: deleting a stage moves its cards through
 * the task operation rather than by a rule of its own. So the run's event carries the stage **and every card
 * that moved**, and a run where cards moved and the stage write then refused is `partial` rather than either an
 * acceptance or a rejection - the surface holds records it did not have before, which is exactly what the
 * shared outcome rule is for.
 *
 * **No projection is read here.** The revision comes either from the caller or from the lookup the caller
 * supplied, and a create needs neither. That one parameter is what makes the whole family reachable from an
 * entry with no board - the agent wire - while the same call stays the board's own.
 *
 * @param deps - the write callable, the refresh, the id source and the sink.
 * @param verb - which operation this is, so the result says what was attempted.
 * @param stageId - the stage, or null for a create (which has no id yet).
 * @param expectedRevision - the revision the caller read, when it has one.
 * @param lookup - where the revision comes from when it does not: a board's projection, or nothing.
 * @param name - the name to report in the feedback sentence, when the verb carries one.
 * @param write - the operation to call once a path has resolved.
 * @returns the outcome, with the store's revision when it was accepted.
 */
export async function runStageWrite(
  deps: WorkflowStageWriteOperationDependencies,
  verb: WorkflowStageWriteVerb,
  stageId: string | null,
  expectedRevision: string | null,
  lookup: WorkflowStageRevisionLookup | null,
  name: string | null,
  write: (operations: WorkflowStageWriteOperations, revision: string) => Promise<WorkflowStageMutationResult>,
): Promise<WorkflowStageWriteOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const target = stageId === null ? [] : [stageId];
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: workflowStageActionType(verb),
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  // A verb that names a stage must carry the revision that stage was read at. The board reads it from the
  // projection it is showing; a caller with no board is given the revision it read. Neither is inferred here,
  // because a revision guessed for a caller is how one caller's read overwrites another's write.
  let revision: string | null = null;
  if (stageId !== null) {
    revision = expectedRevision !== null && expectedRevision !== '' ? expectedRevision : (lookup?.(stageId) ?? null);
    if (revision === null) {
      const askable = lookup !== null;
      audit('rejected', target, askable ? 'unknown-stage' : 'validation-refused');
      return askable
        ? refused(verb, 'unknown-stage', 'the board has no stage with that id', requestId)
        : refused(verb, 'validation-refused', 'a stage write names the revision that stage was read at', requestId);
    }
  }

  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    const refusal = refused(verb, 'writes-unavailable', reason, requestId);
    deps.settle?.(refusal);
    audit('rejected', target, 'writes-unavailable');
    return refusal;
  }

  const written = await write(operations, revision ?? '');
  // The cards the operation moved, whatever it then answered. This is read before convergence on purpose: a
  // refusal that already moved cards has changed the store, so the surfaces are stale and re-reading is owed -
  // the same rule the template action states for a partial write, and the bug this family's own test caught.
  const moved = written.remappedTaskIds ?? [];
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok || moved.length > 0,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) {
    const refusal = refused(verb, written.reason, written.detail, requestId, convergence.refreshed, moved);
    deps.settle?.(refusal);
    audit(semanticOutcomeOf({ wrote: moved.length, refused: true }), [...target, ...moved], written.reason);
    return refusal;
  }

  const accepted: WorkflowStageWriteOutcome = {
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
  deps.settle?.(accepted);
  audit(semanticOutcomeOf({ wrote: 1, refused: false }), [written.recordId, ...moved]);
  return accepted;
}

/**
 * The board's entry over the operation: give it the revision the board is showing, and the drawing it owes.
 *
 * Everything the cockpit owns is here and nowhere else - the projection the revision comes from, the two sinks
 * and the redraw - and the operation above knows none of it. The board is handed over as a *lookup* rather than
 * searched here, so the refusal for a stage it cannot show is still the run's own, minted and journalled with
 * the id its result carries. The drawing is handed over as `settle`, so it happens in the order the family's
 * contract fixes rather than after the run has already been journalled.
 */
async function runStageWriteFromBoard(
  deps: WorkflowStageWriteDependencies,
  verb: WorkflowStageWriteVerb,
  stageId: string | null,
  name: string | null,
  write: (operations: WorkflowStageWriteOperations, revision: string) => Promise<WorkflowStageMutationResult>,
): Promise<WorkflowStageWriteOutcome> {
  deps.setRefusal(null);
  deps.setFeedback(null);
  return await runStageWrite(
    {
      ...deps,
      settle: (outcome) => {
        if (!outcome.ok) deps.setRefusal(outcome.reason);
        if (outcome.ok) deps.setFeedback(feedbackSentence(outcome, name));
        deps.render();
      },
    },
    verb,
    stageId,
    null,
    (id) => deps.state?.workflowStages?.find((candidate) => candidate.id === id)?.revision ?? null,
    name,
    write,
  );
}

/** Create the stage the board's form describes, in the project the board is showing. */
export async function createWorkflowStageAction(
  deps: WorkflowStageWriteDependencies,
  input: { readonly projectId: string; readonly name: string },
): Promise<WorkflowStageWriteOutcome> {
  return await runStageWriteFromBoard(deps, 'create', null, input.name.trim(), async (operations) => await operations.createWorkflowStage({
    projectId: input.projectId as OpaqueRecordId,
    name: input.name,
  }));
}

/** Rename the stage the board was rendering, at the revision it was rendering. */
export async function renameWorkflowStageAction(
  deps: WorkflowStageWriteDependencies,
  input: { readonly stageId: string; readonly name: string },
): Promise<WorkflowStageWriteOutcome> {
  return await runStageWriteFromBoard(deps, 'rename', input.stageId, input.name.trim(), async (operations, revision) => await operations.renameWorkflowStage({
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
  return await runStageWriteFromBoard(deps, 'delete', input.stageId, null, async (operations, revision) => await operations.deleteWorkflowStage({
    stageId: input.stageId as OpaqueRecordId,
    expectedRevision: revision,
    ...(input.remapTo === undefined ? {} : { remapTo: input.remapTo }),
  }));
}
