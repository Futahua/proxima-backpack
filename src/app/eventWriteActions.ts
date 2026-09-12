/**
 * The Schedule's write sequences: the seeded form's Create, the Event editor's Save and Delete.
 *
 * One shape, the same one every other write surface in this tree uses: the sequence lives here where
 * a test can execute it against a real store, the shell supplies only its own state and sinks, and
 * every accepted write is followed by a re-read rather than a redraw from a guess.
 *
 * What is specific to events is that the *form* and the *gesture* meet here. A save plans its
 * mutations from the record and the form (`eventFormPlan.ts`) and submits them through
 * `event.update`; a drag submits `event.reschedule` and a resize `event.resize`. All three carry the
 * revision the surface was rendering, so a caller that lost a race is told so with the revision that
 * beat it — which is what puts a dragged block back where the store says it is instead of leaving it
 * where the pointer did.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CalendarEvent, ProximaState } from '../domain/types.js';
import type { IdGenerator } from '../domain/clock.js';
import type {
  CreateEventRequest,
  EventFieldMutation,
  EventMutationFailureReason,
  EventMutationResult,
  EventResizeTarget,
} from './eventMutations.js';
import { planEventFormMutations, planEventRecurrenceWrite, type EventFormValues } from './eventFormPlan.js';
import { clearRecurrenceAction, setRecurrenceAction, type RecurrenceWriteOutcome } from './eventRecurrenceActions.js';
import type { OpaqueRecurrenceSeriesId } from '../domain/canonicalRecurrence.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, semanticOutcomeOf, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const EVENT_WRITE_ACTION_SCHEMA_VERSION = 1 as const;

export type EventWriteVerb = 'create' | 'update' | 'delete' | 'reschedule' | 'resize';

/** The operations the shell resolved, structurally: no store, no coordinator, no paths. */
export interface EventWriteOperations {
  createEvent(request: CreateEventRequest): Promise<EventMutationResult>;
  updateEvent(input: {
    eventId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly EventFieldMutation[];
  }): Promise<EventMutationResult>;
  deleteEvent(input: { eventId: OpaqueRecordId; expectedRevision: string }): Promise<EventMutationResult>;
  /** A move: the new start, with the duration taken from the record. */
  rescheduleEvent(input: { eventId: OpaqueRecordId; expectedRevision: string; startDate: string }): Promise<EventMutationResult>;
  /** A resize: the end the pointer landed on, or the duration an agent asked for. */
  resizeEvent(input: { eventId: OpaqueRecordId; expectedRevision: string; target: EventResizeTarget }): Promise<EventMutationResult>;
}

export interface EventWriteDependencies extends EventWriteOperationDependencies {
  readonly state: ProximaState | null;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
}

/**
 * What the operation needs, and nothing a cockpit owns.
 *
 * The record facts a run needs - the revision, and the record itself where the verb plans against it - arrive
 * through `resolveEvent` rather than from a projection, which is what makes the family reachable from an entry
 * with no schedule to consult. The board answers with the event it was rendering; the agent wire answers with
 * the revision the agent read, and the record is absent because the wire's verbs do not plan against one.
 */
export interface EventWriteOperationDependencies {
  readonly writes: () => Promise<EventWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  readonly ids: IdGenerator;
  readonly audit: SemanticAuditSink;
  /**
   * What the surface does with the answer, before the run is journalled.
   *
   * Present only where there is a surface, because the order is this family's contract and its own test pins
   * it. A caller with no surface omits it. It is not called for an event the resolver could not find, because
   * that refusal is decided before the write path was ever resolved and the schedule is left as it was.
   */
  readonly settle?: (outcome: EventWriteOutcome) => void;
}

/**
 * Where a run's record facts come from.
 *
 * `revision` is the revision the record was read at and is always required for a verb that names one. `record`
 * is the record itself, and it is null on a caller that read only the revision - which is enough for delete,
 * reschedule and resize, and not enough for a verb that plans a diff against the record.
 */
export type EventRecordResolver = () => { readonly revision: string; readonly record: CalendarEvent | null } | null;

export type EventWriteFailureReason =
  | 'unknown-event'
  | 'unsupported-verb'
  | 'writes-unavailable'
  | EventMutationFailureReason;

export type EventWriteOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof EVENT_WRITE_ACTION_SCHEMA_VERSION;
      readonly verb: EventWriteVerb;
      readonly outcome: 'created' | 'updated' | 'deleted' | 'rescheduled' | 'resized';
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly recordId: OpaqueRecordId;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof EVENT_WRITE_ACTION_SCHEMA_VERSION;
      readonly verb: EventWriteVerb;
      readonly reason: EventWriteFailureReason;
      readonly detail: string;
      /** Present on a refusal too, so a refused schedule write is correlatable with the event it left. */
      readonly requestId: string;
      readonly refreshed: boolean;
    };

function refused(
  verb: EventWriteVerb,
  reason: EventWriteFailureReason,
  detail: string,
  requestId: string,
  refreshed = false,
): EventWriteOutcome {
  return { ok: false, schemaVersion: EVENT_WRITE_ACTION_SCHEMA_VERSION, verb, reason, detail, requestId, refreshed };
}

/**
 * Run one event write and converge the surfaces.
 *
 * One sequence for all five verbs, so the envelope is minted here rather than five times: the id exists before
 * the event lookup can refuse, one terminal event follows - after convergence where the store moved - and the
 * journal names the verb as `event.<verb>`, which is the name each row of Stage 17's matrix already uses.
 *
 * @param deps - the shell's pieces.
 * @param verb - which operation this is, so the result says what was attempted.
 * @param eventId - the event, or null for a create (which has no id yet).
 * @param write - the operation to call once a path has resolved.
 * @returns the outcome, with the store's revision when it was accepted.
 */
export async function runEventWrite(
  deps: EventWriteOperationDependencies,
  verb: EventWriteVerb,
  eventId: string | null,
  resolveEvent: EventRecordResolver | null,
  write: (
    operations: EventWriteOperations,
    revision: string,
    event: CalendarEvent | null,
  ) => Promise<EventMutationResult>,
): Promise<EventWriteOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: `event.${verb}`,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };
  // The target, when there is one: a create has no id yet, so its refusals name nothing rather than guessing.
  const target = eventId === null ? [] : [eventId];

  let revision = '';
  let event: CalendarEvent | null = null;
  if (eventId !== null) {
    const resolved = resolveEvent?.() ?? null;
    if (resolved === null) {
      // A verb that names an event must be able to say which revision it read. A board cannot find the event it
      // was not showing and says so; a caller that read the record supplies the revision, so it has no such
      // answer to give and this branch is the board's. `unsupported-verb` is the exception, and it is the
      // family's own: four of its five verbs are reachable without a schedule, and the one that plans a diff
      // against the record is not, which a caller has to be told rather than left to infer from a refusal
      // about a revision.
      const askable = resolveEvent !== null;
      audit('rejected', target, askable ? 'unknown-event' : 'unsupported-verb');
      return askable
        ? refused(verb, 'unknown-event', 'the schedule has no event with that id', requestId)
        : refused(verb, 'unsupported-verb', 'this verb plans against the record it edits, so it needs a caller that read one', requestId);
    }
    revision = resolved.revision;
    event = resolved.record;
  }

  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    const refusal = refused(verb, 'writes-unavailable', reason, requestId);
    deps.settle?.(refusal);
    audit('rejected', target, 'writes-unavailable');
    return refusal;
  }

  // The write is reached only once the event is known to exist, which is why the callback is handed the
  // record: a plan built from a missing event is exactly the refusal above, said once rather than twice.
  const written = await write(operations, revision, event);
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) {
    const refusal = refused(verb, written.reason, written.detail, requestId, convergence.refreshed);
    deps.settle?.(refusal);
    audit(semanticOutcomeOf({ wrote: 0, refused: true }), target, written.reason);
    return refusal;
  }

  const accepted: EventWriteOutcome = {
    ok: true,
    schemaVersion: EVENT_WRITE_ACTION_SCHEMA_VERSION,
    verb,
    outcome: written.outcome,
    requestId,
    recordId: written.recordId,
    revision: written.revision,
    refreshed: convergence.refreshed,
  };
  deps.settle?.(accepted);
  audit(semanticOutcomeOf({ wrote: 1, refused: false }), [written.recordId]);
  return accepted;
}

/**
 * The board's entry over the operation: answer with the event it was rendering, and draw the answer.
 *
 * Everything the cockpit owns is here - the projection the record facts come from, the refusal sink and the
 * redraw - and the operation above knows none of it.
 */
async function runEventWriteFromSchedule(
  deps: EventWriteDependencies,
  verb: EventWriteVerb,
  eventId: string | null,
  write: (
    operations: EventWriteOperations,
    revision: string,
    event: CalendarEvent | null,
  ) => Promise<EventMutationResult>,
): Promise<EventWriteOutcome> {
  deps.setRefusal(null);
  return await runEventWrite(
    {
      ...deps,
      settle: (outcome) => {
        if (!outcome.ok) deps.setRefusal(outcome.reason);
        deps.render();
      },
    },
    verb,
    eventId,
    () => {
      const event = deps.state?.events.find((candidate) => candidate.id === eventId);
      return event === undefined ? null : { revision: event.source.revision, record: event };
    },
    write,
  );
}

/**
 * Create the event a seeded form describes.
 *
 * The project is the form's own answer, and null is a real answer: an event that belongs to no
 * project is ordinary, so the sequence does not default it to whatever happens to be selected.
 */
export async function createEventAction(
  deps: EventWriteDependencies,
  input: { readonly values: EventFormValues },
): Promise<EventWriteOutcome> {
  const values = input.values;
  return await runEventWriteFromSchedule(deps, 'create', null, async (operations) => await operations.createEvent({
    name: values.name,
    projectId: values.projectId === null ? null : values.projectId as OpaqueRecordId,
    description: values.description,
    startDate: values.startDate,
    deadline: values.deadline,
    isCompleted: values.isCompleted,
  }));
}

/**
 * What the Event editor's Save answers.
 *
 * A success names what happened to the rule as well as to the fields, because a reader who changed both is
 * owed both: `unchanged`, `set` or `cleared`. A refusal is whichever half refused, unchanged — the two
 * vocabularies are carried rather than translated, so a series failure keeps its own reason.
 */
export type EventFormSaveOutcome =
  | {
      readonly ok: true;
      readonly outcome: 'updated';
      readonly requestId: string;
      readonly recordId: OpaqueRecordId;
      readonly revision: string;
      readonly refreshed: boolean;
      readonly recurrence: 'unchanged' | 'set' | 'cleared';
    }
  | Extract<EventWriteOutcome, { ok: false }>
  | Extract<RecurrenceWriteOutcome, { ok: false }>;

/**
 * The Event editor's Save, which is one write or two.
 *
 * A form can change its fields, its rule, or both, and the two halves are different verbs: the fields are
 * `event.update` through `saveEventAction`, and the rule is `event.recurrence.set` or
 * `event.recurrence.clear`, which are their own boundary — they mint their own request id, carry the series
 * and leave their own terminal event. So this composes rather than merges: only the halves that changed run,
 * in the order the reader described them (the span first, because the rule is anchored on it), and a refusal
 * in either half stops there rather than writing the other.
 *
 * Two writes for one Save is the honest shape here rather than a compromise. A merged mutation list would be a
 * second implementation of what setting a rule means — the thing `setRecurrenceAction` exists to be — and the
 * record layer's own revision rule makes the second write safe: it re-reads the record the first write left.
 * The half-way state is stated rather than hidden: a save that set the fields and was then refused the rule
 * leaves the fields saved and says so, which is the same rule the schema panel's create-then-options sequence
 * follows.
 */
export async function saveEventFormAction(
  deps: EventWriteDependencies,
  input: {
    readonly eventId: string;
    readonly values: EventFormValues;
    readonly allocateSeriesId: () => OpaqueRecurrenceSeriesId;
  },
): Promise<EventFormSaveOutcome> {
  const event = deps.state?.events.find((candidate) => candidate.id === input.eventId) ?? null;
  const recurrence = event === null
    ? { kind: 'none' } as const
    : planEventRecurrenceWrite(event, input.values);

  if (recurrence.kind === 'refused') {
    return {
      ok: false,
      schemaVersion: EVENT_WRITE_ACTION_SCHEMA_VERSION,
      verb: 'update',
      reason: 'validation-refused',
      detail: recurrence.detail,
      requestId: mintSemanticRequestId(deps.ids),
      refreshed: false,
    };
  }

  const fieldsChanged = event !== null && planEventFormMutations(event, input.values).length > 0;
  if (!fieldsChanged && recurrence.kind === 'none') {
    // Nothing in either half: let the operation answer it, so a Save that changed nothing keeps answering with
    // the record layer's own sentence rather than a second one written here.
    const unchanged = await saveEventAction(deps, input);
    if (!unchanged.ok) return unchanged;
    return {
      ok: true,
      outcome: 'updated',
      requestId: unchanged.requestId,
      recordId: unchanged.recordId,
      revision: unchanged.revision,
      refreshed: unchanged.refreshed,
      recurrence: 'unchanged',
    };
  }

  let fields: Extract<EventWriteOutcome, { ok: true }> | null = null;
  if (fieldsChanged) {
    const written = await saveEventAction(deps, input);
    if (!written.ok) return written;
    fields = written;
  }

  if (recurrence.kind === 'set') {
    const set = await setRecurrenceAction(deps, {
      eventId: input.eventId,
      rule: recurrence.rule,
      allocateSeriesId: input.allocateSeriesId,
    });
    return set.ok
      ? { ok: true, outcome: 'updated', requestId: set.requestId, recordId: set.recordId, revision: set.revision, refreshed: set.refreshed, recurrence: 'set' }
      : set;
  }

  if (recurrence.kind === 'clear') {
    const cleared = await clearRecurrenceAction(deps, { eventId: input.eventId });
    return cleared.ok
      ? { ok: true, outcome: 'updated', requestId: cleared.requestId, recordId: cleared.recordId, revision: cleared.revision, refreshed: cleared.refreshed, recurrence: 'cleared' }
      : cleared;
  }

  // The fields were written and the rule was already what the form said.
  return {
    ok: true,
    outcome: 'updated',
    requestId: fields!.requestId,
    recordId: fields!.recordId,
    revision: fields!.revision,
    refreshed: fields!.refreshed,
    recurrence: 'unchanged',
  };
}

/** Save the Event editor's form. */
export async function saveEventAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string; readonly values: EventFormValues },
): Promise<EventWriteOutcome> {
  // No pre-check here: `runEventWrite` refuses an event the schedule does not hold, with the envelope, and the
  // callback below is handed the record it found. Planning before the sequence would mean minting a second id
  // for a run that then refused, or refusing with no id at all.
  return await runEventWriteFromSchedule(deps, 'update', input.eventId, async (operations, revision, event) => {
    if (event === null) throw new Error('runEventWrite must hand the update a record');
    return await operations.updateEvent({
      eventId: input.eventId as OpaqueRecordId,
      expectedRevision: revision,
      mutations: planEventFormMutations(event, input.values),
    });
  });
}

/** Delete the event the editor is showing, at the revision the surface was rendering. */
export async function deleteEventAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string },
): Promise<EventWriteOutcome> {
  return await runEventWriteFromSchedule(deps, 'delete', input.eventId, async (operations, revision) => await operations.deleteEvent({
    eventId: input.eventId as OpaqueRecordId,
    expectedRevision: revision,
  }));
}

/**
 * Move the event a block was dragged from.
 *
 * The gesture supplies the new start and nothing else: the duration is the record's, which is what
 * makes a drag and an agent's sentence the same request. A lost race re-reads, which is what puts
 * the block back where the store says it is instead of leaving it where the pointer did.
 */
export async function rescheduleEventAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string; readonly startDate: string },
): Promise<EventWriteOutcome> {
  return await runEventWriteFromSchedule(deps, 'reschedule', input.eventId, async (operations, revision) => await operations.rescheduleEvent({
    eventId: input.eventId as OpaqueRecordId,
    expectedRevision: revision,
    startDate: input.startDate,
  }));
}

/**
 * Resize the event whose bottom edge was dragged.
 *
 * The target is the end the pointer landed on. A gesture that would leave no duration is refused by
 * `eventGesture.ts` before it ever becomes a request, so this sequence is reached only with a span.
 */
export async function resizeEventAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string; readonly target: EventResizeTarget },
): Promise<EventWriteOutcome> {
  return await runEventWriteFromSchedule(deps, 'resize', input.eventId, async (operations, revision) => await operations.resizeEvent({
    eventId: input.eventId as OpaqueRecordId,
    expectedRevision: revision,
    target: input.target,
  }));
}
