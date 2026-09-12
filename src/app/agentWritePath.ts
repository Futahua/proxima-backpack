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
 *   the refresh, the id source and the event sink, and nothing else. The verbs that need a rendered
 *   projection - `task.create` needs a draft and the state it projects from, `task.timeline.change` finds
 *   its task in the state, the `project.*` verbs likewise - are answered with `unsupported-verb` and a
 *   sentence naming where they belong, rather than being silently absent from the wire.
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
  moveTaskByGesture,
  taskMoveActionType,
  TASK_MOVE_GESTURE_SCHEMA_VERSION,
  type TaskMoveActionType,
  type TaskMoveGestureResult,
} from './taskMoveGesture.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';

export const AGENT_WRITE_SCHEMA_VERSION = 1 as const;

/**
 * The verbs this wire runs without a cockpit. Every other registered verb is answered, not ignored.
 *
 * Two families qualify today and they qualify by the same rule rather than by seniority: `moveTaskByGesture`
 * takes the update callable, the refresh, the id source and the sink, and `propertySchemaActions` takes the
 * five schema operations, the id source and the sink. Neither reads a projection, a draft or a modal.
 */
export const AGENT_WRITE_VERBS = [
  'task.execution.move',
  'task.execution.reorder',
  ...Object.values(PROPERTY_SCHEMA_ACTION_TYPES),
] as const;

export type AgentWriteVerb = (typeof AGENT_WRITE_VERBS)[number];

/** The five schema verbs, as a set the parse can test against. */
const SCHEMA_VERB_TYPES: readonly string[] = Object.values(PROPERTY_SCHEMA_ACTION_TYPES);

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

export type AgentWriteResult = TaskMoveGestureResult | PropertySchemaActionOutcome | AgentWriteRefusal;

/**
 * A submission this wire recognises.
 *
 * Two shapes, because the two families own their own rules: a drop's facts are parsed here (the wire is what
 * knows `from`, `to` and the revision), while a schema submission is recognised and handed to the entry that
 * already parses it, so a name, a definition or an option change is validated in one place rather than two.
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

  const { submission } = parsed;
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
