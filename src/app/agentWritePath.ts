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
  runEventWrite,
  type EventWriteOperations,
  type EventWriteOutcome,
  type EventWriteVerb,
} from './eventWriteActions.js';
import type { EventResizeTarget } from './eventMutations.js';
import {
  runLifecycle,
  type ProjectLifecycleOperations,
  type ProjectLifecycleOutcome,
  type ProjectLifecycleVerb,
} from './projectLifecycleActions.js';
import type { ProjectFieldMutation } from './projectMutations.js';
import {
  runTaskCreate,
  TASK_CREATE_ACTION_TYPE,
  type TaskCreateOperations,
  type TaskCreateOutcome,
} from './taskCreate.js';
import type { TaskEditorDraft } from './taskEditor.js';
import {
  BULK_TASK_ACTION_SCHEMA_VERSION,
  runBulk,
  type BulkTaskActionKind,
  type BulkTaskActionReport,
  type BulkTaskWriteOperations,
} from './bulkTaskActions.js';
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
 * The event verbs this wire runs, and the one it deliberately does not.
 *
 * `event.update` plans a diff against the record it edits, so it needs a caller that read one - a board. Every
 * other verb in the family takes only a revision, or nothing at all, which is why they are here and it is not.
 */
const EVENT_WRITE_VERB_TYPES: Readonly<Record<string, EventWriteVerb>> = {
  'event.create': 'create',
  'event.delete': 'delete',
  'event.reschedule': 'reschedule',
  'event.resize': 'resize',
};

/**
 * The five project verbs, all of them, and the one that has to say what it means.
 *
 * `project.delete` is on this wire and carries its membership, because the operation verifies the
 * confirmed list before it removes anything: the creator answered the open question (D60), so what
 * deleting a project does with its members is no longer the thing this boundary has to refuse to
 * invent. A submission that names a project without its members is refused here rather than sent on,
 * and a list that no longer matches the store comes back as the operation's own
 * `membership-mismatch`. An agent that asks gets the same answer a person clicking Delete gets,
 * which is the property the parity box wants.
 */
const PROJECT_VERB_TYPES: Readonly<Record<string, ProjectLifecycleVerb>> = {
  'project.create': 'create',
  'project.update': 'update',
  'project.archive': 'archive',
  'project.restore': 'restore',
  'project.delete': 'delete',
};

/**
 * The two bulk verbs, which are the only family whose submission names many records at once.
 *
 * Each member carries the revision it was read at, because a bulk run writes every member at the revision its
 * caller read - the board takes them from what it rendered, and a caller with no board has to send them. That
 * is also why the wire refuses a selection with no members: "accepted" for zero writes is the kind of success a
 * caller should never be told, which is the operation's own rule.
 */
const BULK_VERB_TYPES: Readonly<Record<string, BulkTaskActionKind>> = {
  'task.bulk.complete': 'task.bulk.complete',
  'task.bulk.delete': 'task.bulk.delete',
};

/**
 * The verbs this wire runs without a cockpit. Every other registered verb is answered, not ignored.
 *
 * Five families qualify today and they qualify by the same rule rather than by seniority: `moveTaskByGesture`
 * takes the update callable, the refresh, the id source and the sink; `propertySchemaActions` takes the five
 * schema operations, the id source and the sink; `changeTaskSpan` takes the same four the gesture does, having
 * been given the record facts - the revision and the end a resize keeps - as a parameter; `runStageWrite` takes
 * those same four, with the one fact it used to read from a board supplied as a lookup the caller owns;
 * `runEventWrite` takes them with the revision the caller read, for the four verbs that need nothing else; and
 * `runLifecycle` takes them with the same, for all five of its verbs. None of the six reads a projection, a
 * draft or a modal.
 *
 * Two verbs are deliberately absent, and both for the same reason rather than by oversight: `workflow.stage.delete`
 * carries the caller's remap decision about the cards the stage holds, and `event.update` plans a diff against
 * the record it edits. Each is a thing a board owns, and a wire that carried either would be a second way to
 * decide it. `event.create`, `delete`, `reschedule` and `resize` take a revision or nothing, so they are here.
 */
export const AGENT_WRITE_VERBS = [
  'task.execution.move',
  'task.execution.reorder',
  TIMELINE_CHANGE_ACTION_TYPE,
  workflowStageActionType('create'),
  workflowStageActionType('rename'),
  TASK_CREATE_ACTION_TYPE,
  ...Object.keys(EVENT_WRITE_VERB_TYPES),
  ...Object.keys(PROJECT_VERB_TYPES),
  ...Object.keys(BULK_VERB_TYPES),
  ...Object.values(PROPERTY_SCHEMA_ACTION_TYPES),
] as const;

/**
 * The one family that does not answer `ok`, and why it has its own entry.
 *
 * A bulk run reports a status **per member** - accepted, partial or refused over a selection - rather than one
 * verdict, and a union member with no `ok` field would stop `if (!result.ok)` narrowing for every other family.
 * So a bulk submission is refused by `submitAgentWrite` with a sentence naming where it belongs, and runs here,
 * where the result is typed to the report. One entry per shape is what keeps the other families' discriminants
 * usable, and it is a statement about the report rather than about the wire.
 *
 * A submission this entry cannot read comes back as a report with one refusal and no members rather than as a
 * different shape, so a caller of the bulk family never has to ask which family answered it.
 */
export async function submitAgentBulk(
  deps: AgentWriteDependencies,
  input: unknown,
): Promise<BulkTaskActionReport> {
  const parsed = parseAgentWriteSubmission(input);
  if (!parsed.ok) {
    const requestId = mintSemanticRequestId(deps.ids);
    deps.audit.append({
      requestId,
      actionType: parsed.actionType,
      outcome: 'rejected',
      entityIds: [...parsed.entityIds],
      errorCode: parsed.reason === 'unsupported-verb' ? 'action-not-available' : 'validation-refused',
    });
    return {
      schemaVersion: BULK_TASK_ACTION_SCHEMA_VERSION,
      ok: false,
      action: 'task.bulk.complete',
      status: 'refused',
      requestId,
      requested: 0,
      accepted: 0,
      refused: 0,
      entities: [],
      refreshed: false,
    };
  }
  if (parsed.kind !== 'bulk') {
    // A well-formed submission for a family this entry does not run, answered in the report's own shape rather
    // than thrown: a caller of the bulk family should never have to ask which family answered it.
    const requestId = mintSemanticRequestId(deps.ids);
    deps.audit.append({ requestId, actionType: parsed.actionType, outcome: 'rejected', entityIds: [], errorCode: 'validation-refused' });
    return {
      schemaVersion: BULK_TASK_ACTION_SCHEMA_VERSION,
      ok: false,
      action: 'task.bulk.complete',
      status: 'refused',
      requestId,
      requested: 0,
      accepted: 0,
      refused: 0,
      entities: [],
      refreshed: false,
    };
  }

  const operations = deps.bulkWrites === undefined ? null : await deps.bulkWrites();
  const revisions = new Map(parsed.submission.members.map((member) => [member.taskId, member.expectedRevision]));
  return await runBulk(
    {
      writes: async () => operations,
      unavailableReason: () => deps.unavailableReason() ?? 'writes-unavailable',
      refresh: deps.refresh,
      ids: deps.ids,
      audit: deps.audit,
      resolveRevision: (taskId) => revisions.get(taskId) ?? null,
    },
    { taskIds: parsed.submission.members.map((member) => member.taskId) },
    parsed.action,
  );
}

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

/**
 * The wire shape an agent submits for one of the four event verbs it can run.
 *
 * One shape for four verbs, because they differ in which fields they carry rather than in what they mean: a
 * create names the whole span and no id, a delete names the id and the revision, a reschedule names a new start,
 * and a resize names either the end the pointer would land on or a duration. Which fields a verb requires is
 * decided where the verb is, so this type is the superset a caller may fill in.
 *
 * `event.update` is not here: it plans a diff against the record it edits, which is a thing a board owns.
 */
export interface AgentEventWriteSubmission {
  readonly type: AgentWriteVerb;
  /** The event a non-create verb names. Absent on a create, which has no id yet. */
  readonly eventId?: string;
  /** The revision the agent read the event at. Required by every verb except a create. */
  readonly expectedRevision?: string;
  /** A create's fields. */
  readonly name?: string;
  readonly description?: string;
  readonly projectId?: string | null;
  readonly startDate?: string;
  readonly deadline?: string;
  readonly isCompleted?: boolean;
  /** A resize's answer: the end the edge landed on, or a duration in minutes. */
  readonly resize?: EventResizeTarget;
}

/**
 * The wire shape an agent submits for one of the five project verbs.
 *
 * One shape for five verbs, because they differ in which fields they carry: a create names the project and
 * leaves the id out, an update names the id, the revision and the field mutations it wants, and archive,
 * restore and delete name the id and the revision. Which fields a verb requires is stated where the verb is.
 */
export interface AgentProjectWriteSubmission {
  readonly type: AgentWriteVerb;
  /** The project a non-create verb names. Absent on a create, which has no id yet. */
  readonly projectId?: string;
  /** The revision the agent read the project at. Required by every verb except a create. */
  readonly expectedRevision?: string;
  /** A create's name, or an update's new name when it changes one. */
  readonly name?: string;
  /** A create's description. */
  readonly description?: string;
  /** An update's fields, in the record layer's own vocabulary. */
  readonly mutations?: readonly ProjectFieldMutation[];
  /**
   * A delete's confirmed members (D60): the exact ids the caller saw, partitioned by kind.
   *
   * Optional on the wire shape because only the delete verb carries it; the parser refuses a delete
   * without it, and the parsed result for that verb requires it, so no caller can reach the operation with
   * an absent list and no member is ever inferred from the store.
   */
  readonly members?: {
    readonly tasks: readonly string[];
    readonly events: readonly string[];
  };
}

/**
 * The wire shape an agent submits for a bulk run over a selection.
 *
 * One array of members, each naming a task and the revision it was read at, rather than two parallel arrays:
 * a pair cannot drift out of step with itself, and a caller that got the alignment wrong would otherwise be
 * writing one record at another record's revision.
 */
export interface AgentBulkWriteSubmission {
  readonly type: AgentWriteVerb;
  readonly members: readonly { readonly taskId: string; readonly expectedRevision: string }[];
}

/**
 * The wire shape an agent submits for a new task.
 *
 * A create has no revision to carry, because there is no record yet. Its values are the fields the form would
 * have submitted, and they are handed to the same planner the form's Save is handed - built into a draft here
 * rather than validated a second time, so "what a New Task Save would ask for" stays one rule with one set of
 * words, including the refusal that names the field at fault.
 *
 * A project the agent names is **taken as named**: this wire has no projection to check it against, and a
 * project nobody holds is the record layer's answer rather than a guess about what exists.
 */
export interface AgentTaskCreateSubmission {
  readonly type: AgentWriteVerb;
  readonly name: string;
  readonly projectId?: string | null;
  readonly executionState?: string;
  readonly weight?: number;
  readonly startDate?: string | null;
  readonly deadline?: string | null;
  readonly isFixedDuration?: boolean;
  readonly fixedDuration?: number | null;
  readonly maxDuration?: number | null;
}

export interface AgentWriteDependencies {
  /** Resolve the sanctioned record write path; null when this run may not write records. */
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
  /**
   * Resolve the event write path, when this composition has one.
   *
   * The third write path, and separate for the same reason as the other two: an event is neither a task nor a
   * stage, and a composition may resolve one store's operations without another's.
   */
  readonly eventWrites?: () => Promise<EventWriteOperations | null>;
  /** Resolve the project lifecycle write path, when this composition has one: the fourth write path. */
  readonly projectWrites?: () => Promise<ProjectLifecycleOperations | null>;
  /** Resolve the task create write path, when this composition has one: the sixth write path. */
  readonly createWrites?: () => Promise<TaskCreateOperations | null>;
  /** Resolve the bulk task write path, when this composition has one. */
  readonly bulkWrites?: () => Promise<BulkTaskWriteOperations | null>;
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
  | EventWriteOutcome
  | ProjectLifecycleOutcome
  | TaskCreateOutcome
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
      readonly kind: 'event';
      readonly actionType: string;
      readonly verb: EventWriteVerb;
      readonly submission: AgentEventWriteSubmission;
    }
  | {
      readonly ok: true;
      readonly kind: 'create';
      readonly actionType: string;
      readonly draft: TaskEditorDraft;
    }
  | {
      readonly ok: true;
      readonly kind: 'bulk';
      readonly actionType: string;
      readonly action: BulkTaskActionKind;
      readonly submission: AgentBulkWriteSubmission;
    }
  | {
      readonly ok: true;
      readonly kind: 'project';
      readonly actionType: string;
      readonly verb: 'delete';
      /** A delete always carries its confirmed members: the parser refuses one without them. */
      readonly submission: AgentProjectWriteSubmission & {
        readonly members: {
          readonly tasks: readonly string[];
          readonly events: readonly string[];
        };
      };
    }
  | {
      readonly ok: true;
      readonly kind: 'project';
      readonly actionType: string;
      readonly verb: Exclude<ProjectLifecycleVerb, 'delete'>;
      readonly submission: AgentProjectWriteSubmission;
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
    // The one verb a family owns and this wire deliberately does not run. It is answered in the operation's own
    // vocabulary rather than as a malformed submission, because the submission is not malformed - it is a
    // perfectly good request for something a board owns, and the caller needs to be told which.
    if (rawType === 'event.update') {
      return {
        ok: false,
        reason: 'unsupported-verb',
        detail: 'this verb plans against the record it edits, so it needs a caller that read one',
        actionType: rawType,
        entityIds: namedEntityIds(candidate),
      };
    }
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

  // The create family: one verb, and the least this wire checks of any of them. A name is required because a
  // task without one is not a task; everything else is a value the planner reads, so an unreadable weight or a
  // deadline before its start is refused by the planner with the same words the form's Save produces, naming
  // the field at fault. Checking those here would be a second copy of a rule this file does not own.
  if (rawType === TASK_CREATE_ACTION_TYPE) {
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') return fail('a task needs a name');
    for (const field of ['projectId', 'startDate', 'deadline'] as const) {
      const value = candidate[field];
      if (value !== undefined && value !== null && typeof value !== 'string') return fail(`${field} must be text or null`);
    }
    for (const field of ['weight', 'fixedDuration', 'maxDuration'] as const) {
      const value = candidate[field];
      if (value !== undefined && value !== null && typeof value !== 'number') return fail(`${field} must be a number or null`);
    }
    if (candidate.executionState !== undefined && typeof candidate.executionState !== 'string') {
      return fail('executionState must be a column');
    }
    if (candidate.isFixedDuration !== undefined && typeof candidate.isFixedDuration !== 'boolean') {
      return fail('isFixedDuration must be true or false');
    }

    // The draft the planner reads. Numbers become the text a form would have typed, which is the shape the
    // planner was written for; an absent one is absent, so the planner's own default applies.
    const asText = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
    const draft: TaskEditorDraft = {
      values: {
        name: candidate.name,
        project: asText(candidate.projectId),
        ...(candidate.executionState === undefined ? {} : { executionState: candidate.executionState as string }),
        ...(candidate.weight === undefined ? {} : { weight: asText(candidate.weight) }),
        ...(candidate.fixedDuration === undefined ? {} : { fixedDuration: asText(candidate.fixedDuration) }),
        ...(candidate.maxDuration === undefined ? {} : { maxDuration: asText(candidate.maxDuration) }),
        ...(candidate.startDate === undefined ? {} : { startDate: asText(candidate.startDate) }),
        ...(candidate.deadline === undefined ? {} : { deadline: asText(candidate.deadline) }),
      },
      checks: { fixedDurationOn: candidate.isFixedDuration === true },
      selections: {},
    };

    return { ok: true, kind: 'create', actionType: rawType, draft };
  }

  // The bulk family: a selection, and every member carries the revision it was read at, because the run writes
  // each member at the revision its caller read. An empty selection is refused here rather than reaching the
  // operation, so the refusal is the wire's own shape rule and the operation keeps its own for the board.
  const bulkAction = BULK_VERB_TYPES[rawType];
  if (bulkAction !== undefined) {
    const members = candidate.members;
    if (!Array.isArray(members)) return fail('a bulk run needs the members it is about');
    if (members.length === 0) return fail('a bulk run needs at least one member');
    for (const member of members) {
      if (typeof member !== 'object' || member === null || Array.isArray(member)) return fail('every member is a task and the revision it was read at');
      const pair = member as { taskId?: unknown; expectedRevision?: unknown };
      if (typeof pair.taskId !== 'string' || pair.taskId === '') return fail('every member is a task and the revision it was read at');
      if (typeof pair.expectedRevision !== 'string' || pair.expectedRevision === '') {
        return fail('every member carries the revision it was read at, so a lost race is refused rather than merged');
      }
    }

    const bulk: AgentBulkWriteSubmission = {
      type: rawType as AgentWriteVerb,
      members: (members as readonly { readonly taskId: string; readonly expectedRevision: string }[])
        .map((member) => ({ taskId: member.taskId, expectedRevision: member.expectedRevision })),
    };

    return { ok: true, kind: 'bulk', actionType: rawType, action: bulkAction, submission: bulk };
  }

  // The project family: a create names the project, and the other four name it by id and revision. The field
  // mutations an update carries are the record layer's own vocabulary and are passed through rather than
  // re-validated here - the operation owns whether a mutation list is one, and answers an empty one with its
  // own sentence.
  const projectVerb = PROJECT_VERB_TYPES[rawType];
  // A delete's confirmed members, bound as they are validated: the parser refuses a delete without them, and
  // the parsed result for that verb requires them, so nothing downstream has to ask whether they are there.
  const confirmedMembers: { tasks: readonly string[]; events: readonly string[] } = { tasks: [], events: [] };
  if (projectVerb !== undefined) {
    if (projectVerb === 'create') {
      if (typeof candidate.name !== 'string' || candidate.name.trim() === '') return fail('a project create needs a name');
      if (candidate.description !== undefined && typeof candidate.description !== 'string') return fail('description must be text');
    } else {
      if (typeof candidate.projectId !== 'string' || candidate.projectId === '') return fail('the submission needs a projectId');
      if (typeof candidate.expectedRevision !== 'string' || candidate.expectedRevision === '') {
        return fail('the submission needs the revision it read the project at, so a lost race is refused rather than merged');
      }
      if (projectVerb === 'update' && !Array.isArray(candidate.mutations)) {
        return fail('a project update needs the field mutations it wants');
      }

      if (projectVerb === 'delete') {
        const submitted = candidate.members;
        if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) {
          return fail('project delete requires members');
        }

        const record = submitted as Record<string, unknown>;
        for (const field of ['tasks', 'events'] as const) {
          const value = record[field];
          if (
            !Array.isArray(value)
            || value.some(
              (memberId) =>
                typeof memberId !== 'string'
                || memberId.length === 0
                || memberId.length > 200,
            )
          ) {
            return fail('project delete requires members.tasks/events to be an array of non-empty bounded strings');
          }
          confirmedMembers[field] = value as readonly string[];
        }
      }
    }

    const project: AgentProjectWriteSubmission = {
      type: rawType as AgentWriteVerb,
      ...(typeof candidate.projectId === 'string' ? { projectId: candidate.projectId } : {}),
      ...(typeof candidate.expectedRevision === 'string' ? { expectedRevision: candidate.expectedRevision } : {}),
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      ...(Array.isArray(candidate.mutations) ? { mutations: candidate.mutations as readonly ProjectFieldMutation[] } : {}),
    };

    if (projectVerb === 'delete') {
      return { ok: true, kind: 'project', actionType: rawType, verb: 'delete', submission: { ...project, members: confirmedMembers } };
    }
    return { ok: true, kind: 'project', actionType: rawType, verb: projectVerb, submission: project };
  }

  // The event family: four of its five verbs, and the fields each requires stated once here rather than left
  // to the operation to discover. An instant that is not a real one is refused here because a span the caller
  // cannot read is not a record-layer question; whether the *record* it names exists is, and stays there.
  const eventVerb = EVENT_WRITE_VERB_TYPES[rawType];
  if (eventVerb !== undefined) {
    const instantOrNull = (field: 'startDate' | 'deadline'): string | null | undefined => {
      const value = candidate[field];
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value === '' || !Number.isFinite(Date.parse(value))) return null;
      return value;
    };

    if (eventVerb === 'create') {
      if (typeof candidate.name !== 'string' || candidate.name.trim() === '') return fail('an event create needs a name');
      const startDate = instantOrNull('startDate');
      const deadline = instantOrNull('deadline');
      if (startDate === undefined || startDate === null) return fail('an event create needs a start that is a real instant');
      if (deadline === undefined || deadline === null) return fail('an event create needs an end that is a real instant');
      if (typeof candidate.description !== 'string') return fail('an event create needs a description, which may be empty');
      if (candidate.projectId !== null && typeof candidate.projectId !== 'string') return fail('projectId must be a project or null');
      if (typeof candidate.isCompleted !== 'boolean') return fail('isCompleted must be true or false');
    } else {
      if (typeof candidate.eventId !== 'string' || candidate.eventId === '') return fail('the submission needs an eventId');
      if (typeof candidate.expectedRevision !== 'string' || candidate.expectedRevision === '') {
        return fail('the submission needs the revision it read the event at, so a lost race is refused rather than merged');
      }
      if (eventVerb === 'reschedule') {
        const startDate = instantOrNull('startDate');
        if (startDate === undefined || startDate === null) return fail('a reschedule needs a start that is a real instant');
      }
      if (eventVerb === 'resize') {
        const resize = candidate.resize;
        const wellFormed = typeof resize === 'object' && resize !== null && !Array.isArray(resize)
          && (
            ((resize as EventResizeTarget).kind === 'end' && Number.isFinite(Date.parse((resize as { value?: unknown }).value as string)))
            || ((resize as EventResizeTarget).kind === 'duration' && typeof (resize as { minutes?: unknown }).minutes === 'number')
          );
        if (!wellFormed) return fail('a resize names either the end it moved or a duration in minutes');
      }
    }

    const event: AgentEventWriteSubmission = {
      type: rawType as AgentWriteVerb,
      ...(typeof candidate.eventId === 'string' ? { eventId: candidate.eventId } : {}),
      ...(typeof candidate.expectedRevision === 'string' ? { expectedRevision: candidate.expectedRevision } : {}),
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      ...(candidate.projectId === null || typeof candidate.projectId === 'string' ? { projectId: candidate.projectId as string | null } : {}),
      ...(typeof candidate.startDate === 'string' ? { startDate: candidate.startDate } : {}),
      ...(typeof candidate.deadline === 'string' ? { deadline: candidate.deadline } : {}),
      ...(typeof candidate.isCompleted === 'boolean' ? { isCompleted: candidate.isCompleted } : {}),
      ...(typeof candidate.resize === 'object' && candidate.resize !== null ? { resize: candidate.resize as EventResizeTarget } : {}),
    };

    return { ok: true, kind: 'event', actionType: rawType, verb: eventVerb, submission: event };
  }

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

  // The create arm: the same operation and the same planner the form's Save runs, with the values built into a
  // draft at the parse. The wire names a project without checking it against anything, so it says so here - a
  // caller with no projection cannot answer that question, and the record layer answers it instead.
  if (parsed.kind === 'create') {
    const createWrites = deps.createWrites === undefined ? null : await deps.createWrites();
    return await runTaskCreate(
      {
        writes: async () => createWrites,
        unavailableReason: () => deps.unavailableReason() ?? 'writes-unavailable',
        refresh: deps.refresh,
        ids: deps.ids,
        audit: deps.audit,
        mayNameAnyProject: true,
      },
      parsed.draft,
    );
  }

  // The project arm: all five verbs, and every one that names a project carries the revision it read instead of
  // a record taken from a hub. The delete is here on purpose and answers its own refusal - what deleting does
  // with a project's members is the creator's decision, and an agent asking is told the same thing a person
  // clicking Delete is told rather than something else.
  if (parsed.kind === 'project') {
    const projectOperations = deps.projectWrites === undefined ? null : await deps.projectWrites();
    const { submission, verb } = parsed;
    const projectDeps = {
      writes: async () => projectOperations,
      unavailableReason: () => deps.unavailableReason() ?? 'writes-unavailable',
      refresh: deps.refresh,
      ids: deps.ids,
      audit: deps.audit,
    };
    const resolver = () => submission.expectedRevision ?? null;
    const projectId = submission.projectId ?? '';

    if (verb === 'create') {
      return await runLifecycle(projectDeps, 'create', null, null, async (operations) => await operations.createProject({
        name: submission.name ?? '',
        description: submission.description ?? '',
      }));
    }

    if (verb === 'update') {
      return await runLifecycle(projectDeps, 'update', projectId, resolver, async (operations, revision) => await operations.updateProject({
        projectId: projectId as OpaqueRecordId,
        expectedRevision: revision,
        mutations: submission.mutations ?? [],
      }));
    }

    if (verb === 'archive') {
      return await runLifecycle(projectDeps, 'archive', projectId, resolver, async (operations, revision) => await operations.archiveProject({
        projectId: projectId as OpaqueRecordId,
        expectedRevision: revision,
      }));
    }

    if (verb === 'restore') {
      return await runLifecycle(projectDeps, 'restore', projectId, resolver, async (operations, revision) => await operations.restoreProject({
        projectId: projectId as OpaqueRecordId,
        expectedRevision: revision,
      }));
    }

    const confirmedMembers = submission.members;
    if (confirmedMembers === undefined) throw new Error('the parser refuses a project delete without its confirmed members');

    return await runLifecycle(projectDeps, 'delete', projectId, resolver, async (operations, revision) => await operations.deleteProject({
      projectId: projectId as OpaqueRecordId,
      expectedRevision: revision,
      members: {
        tasks: confirmedMembers.tasks as readonly OpaqueRecordId[],
        events: confirmedMembers.events as readonly OpaqueRecordId[],
      },
    }));
  }

  // The event arm: the same sequence the Schedule runs, with the revision the agent read instead of a record
  // taken from a projection. The resolver answers that revision and **no record**, because the one verb that
  // plans against a record is not on this wire - so a verb that somehow needed one is refused by the operation
  // with its own sentence rather than reaching a write with a null it would have to invent around.
  if (parsed.kind === 'event') {
    const eventOperations = deps.eventWrites === undefined ? null : await deps.eventWrites();
    const { submission, verb } = parsed;
    const eventDeps = {
      writes: async () => eventOperations,
      unavailableReason: () => deps.unavailableReason() ?? 'writes-unavailable',
      refresh: deps.refresh,
      ids: deps.ids,
      audit: deps.audit,
    };
    const resolver = () => ({ revision: submission.expectedRevision ?? '', record: null });

    if (verb === 'create') {
      return await runEventWrite(eventDeps, 'create', null, null, async (operations) => await operations.createEvent({
        name: submission.name ?? '',
        projectId: (submission.projectId ?? null) as OpaqueRecordId | null,
        description: submission.description ?? '',
        startDate: submission.startDate ?? '',
        deadline: submission.deadline ?? '',
        isCompleted: submission.isCompleted ?? false,
      }));
    }

    const eventId = submission.eventId ?? '';
    if (verb === 'delete') {
      return await runEventWrite(eventDeps, 'delete', eventId, resolver, async (operations, revision) => await operations.deleteEvent({
        eventId: eventId as OpaqueRecordId,
        expectedRevision: revision,
      }));
    }

    if (verb === 'reschedule') {
      return await runEventWrite(eventDeps, 'reschedule', eventId, resolver, async (operations, revision) => await operations.rescheduleEvent({
        eventId: eventId as OpaqueRecordId,
        expectedRevision: revision,
        startDate: submission.startDate ?? '',
      }));
    }

    // Resize: the last of the four, and the shape is checked at the parse, so the target here is one of the two
    // the record layer takes - an end the pointer landed on, or a duration an agent asked for.
    return await runEventWrite(eventDeps, 'resize', eventId, resolver, async (operations, revision) => await operations.resizeEvent({
      eventId: eventId as OpaqueRecordId,
      expectedRevision: revision,
      target: submission.resize as EventResizeTarget,
    }));
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
  if (submission.type === 'task.bulk.complete' || submission.type === 'task.bulk.delete') {
    // Unreachable through this entry, and refused rather than reached: a bulk submission is answered by
    // `submitAgentBulk`, which is typed to the report that family returns. The check is here because the
    // result union deliberately has no bulk member, so this is the line that keeps the two entries apart.
    audit(submission.type, 'rejected', [], 'action-not-available');
    return refused(submission.type, 'unsupported-verb', 'a bulk run is submitted through submitAgentBulk', requestId);
  }
  const move = submission as AgentTaskMoveSubmission;
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    audit(move.type, 'rejected', [move.taskId], 'writes-unavailable');
    return refused(move.type, 'writes-unavailable', reason, requestId);
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
      taskId: move.taskId as OpaqueRecordId,
      from: move.from,
      to: move.to,
      targetIndex: move.targetIndex,
      expectedRevision: move.expectedRevision,
      requestId,
    },
  );
}

/** Re-exported so a caller can name the operation the wire runs without importing the gesture module. */
export type { TaskMoveActionType, TaskMoveGestureResult };
export { TASK_MOVE_GESTURE_SCHEMA_VERSION };
