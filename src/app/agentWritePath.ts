/**
 * The agent-facing write path: the entry an agent submits a record verb to, with no cockpit in it.
 *
 * The dispatcher refuses every record verb with `action-not-available` before the record layer, and that
 * containment rule is asserted by tests that exist to keep it. This module does not loosen it. It is the
 * same answer the AUTHOR gave template execution: a **sibling entry, not a `ProximaAction`**, because the
 * protocol's `dispatch()` is synchronous, generates its own request id, and answers record verbs with a
 * refusal that the surfaces depend on. An agent that needs to write a record reaches an operation, not a
 * second interpretation of the protocol.
 *
 * Three deliberate narrownesses, each of which a reader can check:
 *
 * - **A verb enters this wire only when the operation it names runs with no cockpit in the dependency
 *   set.** `task.execution.move` and `task.execution.reorder` qualify: `moveTaskByGesture` takes the write,
 *   the refresh, the id source and the event sink, and nothing else. `task.timeline.change` joined them the
 *   same way and for the same reason: `changeTaskSpan` was given the record facts as a parameter - the
 *   revision, and the end a resize keeps - so the projection it used to read is now the caller's, and the
 *   agent supplies what it read exactly as the drag does. The verbs that still need a rendered projection -
 *   `task.create` needs a draft and the state it projects from, the `project.*` verbs likewise - are
 *   answered with `unsupported-verb` and a sentence naming where they belong, rather than being silently
 *   absent from the wire.
 * - **The wire carries what the agent read**: the column the card is in, and the revision. A write is
 *   refused against a revision its caller did not observe, which is the same protection the UI's gesture
 *   has, and `from`/`to` name the operation by `taskMoveActionType`'s existing rule rather than by a
 *   second one. A submission whose declared verb contradicts that rule is refused instead of corrected.
 * - **No caller-supplied request id.** A `requestId` field on the submission is ignored; the id is minted
 *   here and handed down to the gesture, which is what makes an agent unable to claim an id the machinery
 *   did not issue.
 *
 * The refusal branch is deliberately the gesture's own refusal shape, widened by the two reasons this wire
 * decides before the gesture can run. A caller therefore compares two refusals rather than two
 * vocabularies, and the parity test compares field sets rather than field subsets.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CanonicalExecutionState } from '../domain/canonicalTaskState.js';
import type { IdGenerator } from '../domain/clock.js';
import { categoryOf, registeredActionTypes } from './actionTaxonomy.js';
import {
  PROPERTY_SCHEMA_ACTION_TYPES,
  submitPropertySchemaAction,
  type PropertySchemaActionOutcome,
  type PropertySchemaWriteOperations,
} from './propertySchemaActions.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import {
  TIMELINE_CHANGE_ACTION_TYPE,
  TIMELINE_CHANGE_OPERATIONS,
  changeTaskSpan,
  type TimelineChangeOperation,
  type TimelineSpanWriteOutcome,
} from './timelineChangeAction.js';
import {
  moveTaskByGesture,
  taskMoveActionType,
  TASK_MOVE_GESTURE_SCHEMA_VERSION,
  type TaskMoveActionType,
  type TaskMoveGestureResult,
} from './taskMoveGesture.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import {
  WORKFLOW_STAGE_WRITE_VERBS,
  runStageWrite,
  workflowStageActionType,
  type WorkflowStageWriteOperations,
  type WorkflowStageWriteOutcome,
  type WorkflowStageWriteVerb,
} from './workflowStageWriteActions.js';

export const AGENT_WRITE_SCHEMA_VERSION = 1 as const;

/** The three stage verbs this wire runs, by the names a submission carries. */
const STAGE_VERB_TYPES: readonly string[] = WORKFLOW_STAGE_WRITE_VERBS.map(workflowStageActionType);

/** A submission's type back to the verb it names, for the family whose three verbs are one operation. */
function stageVerbOf(type: string): WorkflowStageWriteVerb | null {
  const verb = WORKFLOW_STAGE_WRITE_VERBS.find((candidate) => workflowStageActionType(candidate) === type);
  return verb ?? null;
}

/**
 * The verbs this wire runs without a cockpit. Every other registered verb is answered, not ignored.
 *
 * Four families qualify today and they qualify by the same rule rather than by seniority: `moveTaskByGesture`
 * takes the update callable, the refresh, the id source and the sink; `propertySchemaActions` takes the five
 * schema operations, the id source and the sink; `changeTaskSpan` takes the same four the gesture does, having
 * been given the record facts - the revision and the end a resize keeps - as a parameter; and `runStageWrite`
 * takes those same four, with the one fact it used to read from a board supplied as a lookup the caller owns.
 * None of the four reads a projection, a draft or a modal. Not every family's verbs are on it yet: a stage
 * delete carries the caller's remap decision and is deliberately not run here.
 */
export const AGENT_WRITE_VERBS = [
  'task.execution.move',
  'task.execution.reorder',
  TIMELINE_CHANGE_ACTION_TYPE,
  workflowStageActionType('create'),
  workflowStageActionType('rename'),
  ...Object.values(PROPERTY_SCHEMA_ACTION_TYPES),
] as const;

export type AgentWriteVerb = (typeof AGENT_WRITE_VERBS)[number];

/** The five schema verbs, as a set the parse can test against. */
const SCHEMA_VERB_TYPES: readonly string[] = Object.values(PROPERTY_SCHEMA_ACTION_TYPES);

/** The three Gantt gestures, as a set the parse can test a value against. */
const TIMELINE_OPERATIONS: readonly string[] = TIMELINE_CHANGE_OPERATIONS;

/** The wire shape an agent submits for a drop. */
export interface AgentTaskMoveSubmission {
  readonly type: AgentWriteVerb;
  readonly taskId: string;
  /** The execution state the agent read the card in. It names the operation; the revision protects it. */
  readonly from: CanonicalExecutionState;
  readonly to: CanonicalExecutionState;
  readonly targetIndex: number;
  /** The revision the agent read. Required: writing against a guessed revision is how a caller overwrites one. */
  readonly expectedRevision: string;
}

/**
 * The record write the wire hands the gesture.
 *
 * It is the same one-callable shape the shell resolves for a drop - the field mutations are the record
 * layer's own vocabulary, not a wire's - so the gesture cannot tell which entry reached it.
 */
export interface AgentWriteOperations {
  updateTask(input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }): Promise<TaskMutationResult>;
}

/**
 * The wire shape an agent submits for a Gantt date change.
 *
 * It is the protocol's own `task.timeline.change` shape with one field replaced: the dispatcher finds the
 * task in the state it was built over, and an agent has no such state, so it names **the revision it read**
 * instead - the same trade the drop arm makes. The span travels complete for every gesture: a resize names
 * one end and supplies the other from the record it read, because which end was *moved* is what `operation`
 * says and there is no second source for the other end on this side of the wire.
 */
export interface AgentTimelineChangeSubmission {
  readonly type: AgentWriteVerb;
  readonly taskId: string;
  readonly operation: TimelineChangeOperation;
  /** Both ends as the agent read them: a move proposes both, a resize proposes the end it moved. */
  readonly proposedStartDate: string | null;
  readonly proposedDeadline: string | null;
  /** Where the bar belongs. Local state: reported, never written (A3). */
  readonly targetRowIndex: number;
  /** The revision the agent read. Required, and the field that makes the gesture's rule reachable at all. */
  readonly expectedRevision: string;
}

/**
 * The wire shape an agent submits for a workflow-stage create or rename.
 *
 * One shape rather than two because the two verbs differ in which fields they carry, not in what they mean: a
 * create needs the project and the name and has no revision to name, and a rename needs the stage and the name
 * and **must** name the revision it read. Which fields a given verb requires is decided where the verb is,
 * beside the operation, so the wire carries the submission rather than a second copy of the rule.
 *
 * A stage **delete** is deliberately not on this wire. The operation takes a `remapTo` decision about the cards
 * the stage still holds, and that is a creator's decision rather than a submission's - the board's own Delete
 * passes none, and a wire that carried one would be a second way to decide where someone's cards go.
 */
export interface AgentStageWriteSubmission {
  readonly type: AgentWriteVerb;
  /** The stage a rename names. Absent on a create, which has no id yet. */
  readonly stageId?: string;
  /** The project a create names. */
  readonly projectId?: string;
  readonly name: string;
  /** The revision the agent read the stage at. Required on a rename, meaningless on a create. */
  readonly expectedRevision?: string;
}

export interface AgentWriteDependencies {  /** Resolve the sanctioned record write path; null when this run may not write records. */
  readonly writes: () => Promise<AgentWriteOperations | null>;
  /**
   * Resolve the schema write path, when this composition has one.
   *
   * Separate from `writes` because the browser shell resolves no schema operations yet - there is no schema
   * editor for them to serve - and requiring them there would make a composition that cannot write schemas
   * unable to use the wire for the drops it can write. Absent or null, a schema verb is refused
   * `writes-unavailable` with this run's own reason rather than pretended away.
   */
  readonly schemaWrites?: () => Promise<PropertySchemaWriteOperations | null>;
  /**
   * Resolve the workflow-stage write path, when this composition has one.
   *
   * Separate from `writes` for the same reason `schemaWrites` is, and not because a composition is unlikely to
   * have it: `writes` is the task update callable - the drop and the Gantt change both write tasks through it -
   * and a stage is a different record with different operations. A run that resolves one and not the other
   * refuses the family it cannot reach with `writes-unavailable` rather than pretending the verb is unknown.
   */
  readonly stageWrites?: () => Promise<WorkflowStageWriteOperations | null>;
  /** Why there is no write path, in words a reader can act on. */
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** Mints this run's semantic request id, which the gesture below is handed rather than minting its own. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export type AgentWriteFailureReason =
  | 'malformed-submission'
  | 'unsupported-verb'
  | 'writes-unavailable'
  | TaskMutationFailureReason;

/**
 * A refusal this wire decides, in the gesture's own refusal shape.
 *
 * `actionType` is the semantic verb when the submission named one this wire runs, and the submission's raw
 * type otherwise - including `unknown` for a submission whose type is not even a string, which is the
 * dispatcher's own convention for the same case.
 */
export interface AgentWriteRefusal {
  readonly ok: false;
  readonly schemaVersion: typeof AGENT_WRITE_SCHEMA_VERSION;
  readonly outcome: 'refused';
  readonly actionType: string;
  readonly reason: AgentWriteFailureReason;
  readonly detail: string;
  /** Present on every refusal, which is what makes a refused submission correlatable. */
  readonly requestId: string;
  readonly refreshed: boolean;
  readonly actualRevision?: string;
}

export type AgentWriteResult =
  | TaskMoveGestureResult
  | TimelineSpanWriteOutcome
  | WorkflowStageWriteOutcome
  | PropertySchemaActionOutcome
  | AgentWriteRefusal;

/**
 * A submission this wire recognises.
 *
 * Three shapes, because three families own their own rules: a drop's facts are parsed here (the wire is what
 * knows `from`, `to` and the revision), a Gantt change's facts are parsed here too (the wire is what knows
 * that a submission claiming to be a timeline write must at least be one), while a schema submission is
 * recognised and handed to the entry that already parses it, so a name, a definition or an option change is
 * validated in one place rather than two.
 */
export type ParsedAgentWrite =
  | {
      readonly ok: true;
      readonly kind: 'move';
      readonly actionType: string;
      readonly submission: AgentTaskMoveSubmission;
    }
  | {
      readonly ok: true;
      readonly kind: 'timeline';
      readonly actionType: string;
      readonly submission: AgentTimelineChangeSubmission;
    }
  | {
      readonly ok: true;
      readonly kind: 'stage';
      readonly actionType: string;
      readonly verb: WorkflowStageWriteVerb;
      readonly submission: AgentStageWriteSubmission;
    }
  | {
      readonly ok: true;
      readonly kind: 'schema';
      readonly actionType: string;
    };

export interface RejectedAgentWrite {
  readonly ok: false;
  readonly reason: 'malformed-submission' | 'unsupported-verb';
  readonly detail: string;
  /** The verb the submission named, when it named one in words; `unknown` otherwise. */
  readonly actionType: string;
  /** The ids the submission named, by the field-scan rule below; empty when its shape is not trusted. */
  readonly entityIds: readonly string[];
}

const EXECUTION_STATES: readonly CanonicalExecutionState[] = ['backlog', 'running', 'finished'];

function isExecutionState(value: unknown): value is CanonicalExecutionState {
  return typeof value === 'string' && (EXECUTION_STATES as readonly string[]).includes(value);
}

/**
 * The ids a submission names, by its own field names.
 *
 * A refusal should name what it was about, and a wire cannot know every verb's target field - so the rule
 * is mechanical and stated: every string-valued field whose name ends in `Id`, in field-name order, so the
 * same submission always reports the same list. `requestId` is deliberately not one of them: a caller does
 * not get to name the id of the run it is refused in.
 */
function namedEntityIds(candidate: Record<string, unknown>): string[] {
  return Object.keys(candidate)
    .filter((key) => key !== 'requestId' && key.endsWith('Id') && typeof candidate[key] === 'string' && candidate[key] !== '')
    .sort()
    .map((key) => candidate[key] as string);
}

/**
 * Validate the outer wire shape only.
 *
 * Types and enum membership are this module's business; whether a *well-typed* value is acceptable is the
 * gesture's answer and comes back as its refusal. That is why a negative target index is not refused here:
 * `moveTaskByGesture` already owns that rule, and a second copy of it would be a second thing to keep true.
 */
export function parseAgentWriteSubmission(input: unknown): ParsedAgentWrite | RejectedAgentWrite {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'malformed-submission', detail: 'an agent write is an object', actionType: 'unknown', entityIds: [] };
  }
  const candidate = input as Record<string, unknown>;
  const rawType = candidate.type;
  if (typeof rawType !== 'string') {
    return { ok: false, reason: 'malformed-submission', detail: 'the submission needs a type', actionType: 'unknown', entityIds: [] };
  }

  if (!(AGENT_WRITE_VERBS as readonly string[]).includes(rawType)) {
    const registered = registeredActionTypes().some((type) => type === rawType);
    if (!registered) {
      return {
        ok: false,
        reason: 'malformed-submission',
        detail: `no action type is registered as ${rawType}`,
        actionType: rawType,
        entityIds: namedEntityIds(candidate),
      };
    }
    const category = categoryOf(rawType) ?? 'unknown';
    return {
      ok: false,
      reason: 'unsupported-verb',
      detail: category === 'record-mutation'
        ? `${rawType} is a record mutation this wire does not run: it needs a rendered cockpit, so submit it through the surface that owns it`
        : `${rawType} is registered as ${category}, and this wire runs record writes only`,
      actionType: rawType,
      entityIds: namedEntityIds(candidate),
    };
  }

  const ids = namedEntityIds(candidate);

  // The schema family: recognised here, parsed by the entry that owns its shape. A wire that re-implemented
  // "what a property definition is" would be a second copy of a rule the domain constructor already owns.
  if (SCHEMA_VERB_TYPES.includes(rawType)) {
    return { ok: true, kind: 'schema', actionType: rawType };
  }

  const fail = (detail: string): RejectedAgentWrite => ({
    ok: false,
    reason: 'malformed-submission',
    detail,
    actionType: rawType,
    entityIds: ids,
  });

  // The stage family: two of its three verbs, and which fields each requires is a rule this wire states once
  // rather than one it lets the operation discover. A create has no revision to carry and a rename has no
  // project; a submission that carries the fields of the other verb is answered rather than corrected.
  const stageVerb = stageVerbOf(rawType);
  if (stageVerb !== null) {
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') return fail('the submission needs a name');
    if (stageVerb === 'create') {
      if (typeof candidate.projectId !== 'string' || candidate.projectId === '') return fail('a stage create needs the project it belongs to');
    } else {
      if (typeof candidate.stageId !== 'string' || candidate.stageId === '') return fail('a stage rename needs the stage it renames');
      if (typeof candidate.expectedRevision !== 'string' || candidate.expectedRevision === '') {
        return fail('the submission needs the revision it read the stage at, so a lost race is refused rather than merged');
      }
    }

    const stage: AgentStageWriteSubmission = {
      type: rawType as AgentWriteVerb,
      ...(typeof candidate.stageId === 'string' ? { stageId: candidate.stageId } : {}),
      ...(typeof candidate.projectId === 'string' ? { projectId: candidate.projectId } : {}),
      name: candidate.name,
      ...(typeof candidate.expectedRevision === 'string' ? { expectedRevision: candidate.expectedRevision } : {}),
    };

    return { ok: true, kind: 'stage', actionType: rawType, verb: stageVerb, submission: stage };
  }

  // The Gantt family: the outer shape is the wire's business, and whether the two ends are a span is the
  // operation's. So an inverted range is not refused here - `changeTaskSpan` already owns that rule, in the
  // words the cockpit shows, and a second copy of it would be a second thing to keep true.
  if (rawType === TIMELINE_CHANGE_ACTION_TYPE) {
    if (typeof candidate.taskId !== 'string' || candidate.taskId === '') return fail('the submission needs a taskId');
    if (typeof candidate.expectedRevision !== 'string' || candidate.expectedRevision === '') {
      return fail('the submission needs the revision it read the task at, so a lost race is refused rather than merged');
    }
    if (typeof candidate.operation !== 'string' || !TIMELINE_OPERATIONS.includes(candidate.operation)) {
      return fail('operation must be move, resize-start or resize-end');
    }
    for (const field of ['proposedStartDate', 'proposedDeadline'] as const) {
      const value = candidate[field];
      if (value !== null && typeof value !== 'string') return fail(`${field} must be a date or null`);
      if (typeof value === 'string' && !Number.isFinite(Date.parse(value))) return fail(`${field} must be a date or null`);
    }
    // Both ends absent is not a change: it is how the protocol refuses the same submission, and an agent
    // asking to clear both ends is asking for a task with no timeline at all, which is not this verb.
    if (candidate.proposedStartDate === null && candidate.proposedDeadline === null) {
      return fail('a timeline change names at least one end');
    }
    if (typeof candidate.targetRowIndex !== 'number') return fail('targetRowIndex must be a number');

    const submission: AgentTimelineChangeSubmission = {
      type: rawType as AgentWriteVerb,
      taskId: candidate.taskId,
      operation: candidate.operation as TimelineChangeOperation,
      proposedStartDate: candidate.proposedStartDate as string | null,
      proposedDeadline: candidate.proposedDeadline as string | null,
      targetRowIndex: candidate.targetRowIndex,
      expectedRevision: candidate.expectedRevision,
    };

    return { ok: true, kind: 'timeline', actionType: rawType, submission };
  }

  if (typeof candidate.taskId !== 'string' || candidate.taskId === '') return fail('the submission needs a taskId');
  if (typeof candidate.expectedRevision !== 'string' || candidate.expectedRevision === '') {
    return fail('the submission needs the revision it read the task at, so a lost race is refused rather than merged');
  }
  if (!isExecutionState(candidate.from)) return fail('from must be backlog, running or finished');
  if (!isExecutionState(candidate.to)) return fail('to must be backlog, running or finished');
  if (typeof candidate.targetIndex !== 'number') return fail('targetIndex must be a number');

  const submission: AgentTaskMoveSubmission = {
    type: rawType as AgentWriteVerb,
    taskId: candidate.taskId,
    from: candidate.from,
    to: candidate.to,
    targetIndex: candidate.targetIndex,
    expectedRevision: candidate.expectedRevision,
  };

  // The declared verb and the record facts must agree, because the rule that names the operation is
  // `taskMoveActionType`'s and a wire that corrected a contradiction would journal an operation its caller
  // did not ask for.
  const actual = taskMoveActionType(submission.from, submission.to);
  if (actual !== submission.type) {
    return fail(`a drop from ${submission.from} to ${submission.to} is ${actual}, not ${submission.type}`);
  }

  return { ok: true, kind: 'move', actionType: rawType, submission };
}

function refused(
  actionType: string,
  reason: AgentWriteFailureReason,
  detail: string,
  requestId: string,
): AgentWriteRefusal {
  return { ok: false, schemaVersion: AGENT_WRITE_SCHEMA_VERSION, outcome: 'refused', actionType, reason, detail, requestId, refreshed: false };
}

/**
 * Submit a record verb on behalf of an agent, through the same operation the surface is bound to.
 *
 * The request id is minted before the submission is parsed, so a malformed or unsupported submission is
 * journalled with the id its caller can cite - the convention `dispatch` already follows, where the id
 * exists before `parseAction` is asked.
 */
export async function submitAgentWrite(
  deps: AgentWriteDependencies,
  input: unknown,
): Promise<AgentWriteResult> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (actionType: string, outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  const parsed = parseAgentWriteSubmission(input);
  if (!parsed.ok) {
    audit(parsed.actionType, 'rejected', parsed.entityIds, parsed.reason === 'unsupported-verb' ? 'action-not-available' : 'validation-refused');
    return refused(parsed.actionType, parsed.reason, parsed.detail, requestId);
  }

  if (parsed.kind === 'schema') {
    // The schema entry parses the submission, appends the run's one event and reports the record layer's own
    // outcome. It is handed the id this boundary minted, because a second mint would be a second run: one
    // submission, one id, one event - and the refusal it decides itself (no schema composition resolved) is
    // journalled under the family name `property.schema`, since at that point it has parsed no verb.
    const schemaOperations = deps.schemaWrites === undefined ? null : await deps.schemaWrites();
    return await submitPropertySchemaAction(
      {
        writes: async () => schemaOperations,
        unavailableReason: () => deps.unavailableReason() ?? 'writes-unavailable',
        ids: deps.ids,
        audit: deps.audit,
      },
      input,
      { requestId },
    );
  }

  // The stage arm: the same operation the board runs, resolved through its own optional path because a stage
  // is a different record from a task. The wire supplies the revision it read and no lookup, so a rename that
  // carries none is refused here for naming none - and the operation's own `unknown-stage` is a sentence only a
  // board can say, because only a board has a board to consult.
  if (parsed.kind === 'stage') {
    const stageOperations = deps.stageWrites === undefined ? null : await deps.stageWrites();
    const stageDeps = {
      writes: async () => stageOperations,
      unavailableReason: () => deps.unavailableReason() ?? 'writes-unavailable',
      refresh: deps.refresh,
      ids: deps.ids,
      audit: deps.audit,
    };
    const { submission, verb } = parsed;

    if (verb === 'create') {
      return await runStageWrite(
        stageDeps,
        'create',
        null,
        null,
        null,
        submission.name,
        async (operations) => await operations.createWorkflowStage({
          projectId: submission.projectId as OpaqueRecordId,
          name: submission.name,
        }),
      );
    }

    if (verb === 'rename') {
      return await runStageWrite(
        stageDeps,
        'rename',
        submission.stageId ?? null,
        submission.expectedRevision ?? null,
        null,
        submission.name,
        async (operations, revision) => await operations.renameWorkflowStage({
          stageId: (submission.stageId ?? '') as OpaqueRecordId,
          expectedRevision: revision,
          name: submission.name,
        }),
      );
    }

    // Unreachable through this wire, and structured so rather than asserted away: a delete is not one of
    // `AGENT_WRITE_VERBS`, so the parse never answers `kind: 'stage'` for it and there is no submission that can
    // arrive here. The branch exists because the verb is a member of the family's union, and the body it runs
    // is the honest one if it ever becomes reachable - the cards' destination is the creator's answer, so this
    // passes no remap and lets the operation ask rather than deciding it.
    return await runStageWrite(
      stageDeps,
      'delete',
      submission.stageId ?? null,
      submission.expectedRevision ?? null,
      null,
      null,
      async (operations, revision) => await operations.deleteWorkflowStage({
        stageId: (submission.stageId ?? '') as OpaqueRecordId,
        expectedRevision: revision,
      }),
    );
  }

  // The Gantt arm: the same operation the drag runs, handed the id this boundary minted - so one submission
  // is one id and one terminal event whichever entry reached it, and the row index the operation reports as
  // local state is the one the agent named.
  if (parsed.kind === 'timeline') {
    return await changeTaskSpan(
      {
        writes: deps.writes,
        unavailableReason: () => deps.unavailableReason() ?? 'writes-unavailable',
        refresh: deps.refresh,
        ids: deps.ids,
        audit: deps.audit,
      },
      parsed.submission,
      { requestId },
    );
  }

  const submission = parsed.submission;
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    audit(submission.type, 'rejected', [submission.taskId], 'writes-unavailable');
    return refused(submission.type, 'writes-unavailable', reason, requestId);
  }

  // The gesture mints nothing here: the id belongs to this boundary, which is the one that answers refusals
  // of its own before the gesture is reached.
  return await moveTaskByGesture(
    {
      updateTask: (write) => operations.updateTask(write),
      refresh: deps.refresh,
      ids: deps.ids,
      audit: deps.audit,
    },
    {
      taskId: submission.taskId as OpaqueRecordId,
      from: submission.from,
      to: submission.to,
      targetIndex: submission.targetIndex,
      expectedRevision: submission.expectedRevision,
      requestId,
    },
  );
}

/** Re-exported so a caller can name the operation the wire runs without importing the gesture module. */
export type { TaskMoveActionType, TaskMoveGestureResult };
export { TASK_MOVE_GESTURE_SCHEMA_VERSION };
