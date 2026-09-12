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
import { planEventFormMutations, type EventFormValues } from './eventFormPlan.js';
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

export interface EventWriteDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<EventWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export type EventWriteFailureReason =
  | 'unknown-event'
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
async function runEventWrite(
  deps: EventWriteDependencies,
  verb: EventWriteVerb,
  eventId: string | null,
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
    event = deps.state?.events.find((candidate) => candidate.id === eventId) ?? null;
    if (event === null) {
      audit('rejected', target, 'unknown-event');
      return refused(verb, 'unknown-event', 'the schedule has no event with that id', requestId);
    }
    revision = event.source.revision;
  }

  deps.setRefusal(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', target, 'writes-unavailable');
    return refused(verb, 'writes-unavailable', reason, requestId);
  }

  // The write is reached only once the event is known to exist, which is why the callback is handed the
  // record: a plan built from a missing event is exactly the refusal above, said once rather than twice.
  const written = await write(operations, revision, event);
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  deps.render();

  if (!written.ok) {
    audit(semanticOutcomeOf({ wrote: 0, refused: true }), target, written.reason);
    return refused(verb, written.reason, written.detail, requestId, convergence.refreshed);
  }

  audit(semanticOutcomeOf({ wrote: 1, refused: false }), [written.recordId]);
  return {
    ok: true,
    schemaVersion: EVENT_WRITE_ACTION_SCHEMA_VERSION,
    verb,
    outcome: written.outcome,
    requestId,
    recordId: written.recordId,
    revision: written.revision,
    refreshed: convergence.refreshed,
  };
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
  return await runEventWrite(deps, 'create', null, async (operations) => await operations.createEvent({
    name: values.name,
    projectId: values.projectId === null ? null : values.projectId as OpaqueRecordId,
    description: values.description,
    startDate: values.startDate,
    deadline: values.deadline,
    isCompleted: values.isCompleted,
  }));
}

/**
 * Save the Event editor's form.
 *
 * The mutations are the diff between the record and the form, so a save that changed nothing submits
 * nothing and is answered by the operation ("an update with no field to change is not an update")
 * rather than written as a record that says the same thing.
 */
export async function saveEventAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string; readonly values: EventFormValues },
): Promise<EventWriteOutcome> {
  // No pre-check here: `runEventWrite` refuses an event the schedule does not hold, with the envelope, and the
  // callback below is handed the record it found. Planning before the sequence would mean minting a second id
  // for a run that then refused, or refusing with no id at all.
  return await runEventWrite(deps, 'update', input.eventId, async (operations, revision, event) => {
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
  return await runEventWrite(deps, 'delete', input.eventId, async (operations, revision) => await operations.deleteEvent({
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
  return await runEventWrite(deps, 'reschedule', input.eventId, async (operations, revision) => await operations.rescheduleEvent({
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
  return await runEventWrite(deps, 'resize', input.eventId, async (operations, revision) => await operations.resizeEvent({
    eventId: input.eventId as OpaqueRecordId,
    expectedRevision: revision,
    target: input.target,
  }));
}
