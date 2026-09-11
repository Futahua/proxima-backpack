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
import type { ProximaState } from '../domain/types.js';
import type {
  CreateEventRequest,
  EventFieldMutation,
  EventMutationFailureReason,
  EventMutationResult,
} from './eventMutations.js';
import { planEventFormMutations, type EventFormValues } from './eventFormPlan.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const EVENT_WRITE_ACTION_SCHEMA_VERSION = 1 as const;

export type EventWriteVerb = 'create' | 'update' | 'delete';

/** The operations the shell resolved, structurally: no store, no coordinator, no paths. */
export interface EventWriteOperations {
  createEvent(request: CreateEventRequest): Promise<EventMutationResult>;
  updateEvent(input: {
    eventId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly EventFieldMutation[];
  }): Promise<EventMutationResult>;
  deleteEvent(input: { eventId: OpaqueRecordId; expectedRevision: string }): Promise<EventMutationResult>;
}

export interface EventWriteDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<EventWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
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
      readonly outcome: 'created' | 'updated' | 'deleted';
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
      readonly refreshed: boolean;
    };

function refused(
  verb: EventWriteVerb,
  reason: EventWriteFailureReason,
  detail: string,
  refreshed = false,
): EventWriteOutcome {
  return { ok: false, schemaVersion: EVENT_WRITE_ACTION_SCHEMA_VERSION, verb, reason, detail, refreshed };
}

/**
 * Run one event write and converge the surfaces.
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
  write: (operations: EventWriteOperations, revision: string) => Promise<EventMutationResult>,
): Promise<EventWriteOutcome> {
  let revision = '';
  if (eventId !== null) {
    const event = deps.state?.events.find((candidate) => candidate.id === eventId);
    if (event === undefined) return refused(verb, 'unknown-event', 'the schedule has no event with that id');
    revision = event.source.revision;
  }

  deps.setRefusal(null);
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
  deps.render();

  return written.ok
    ? {
        ok: true,
        schemaVersion: EVENT_WRITE_ACTION_SCHEMA_VERSION,
        verb,
        outcome: written.outcome as 'created' | 'updated' | 'deleted',
        recordId: written.recordId,
        revision: written.revision,
        refreshed: convergence.refreshed,
      }
    : refused(verb, written.reason, written.detail, convergence.refreshed);
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
  const event = deps.state?.events.find((candidate) => candidate.id === input.eventId);
  if (event === undefined) return refused('update', 'unknown-event', 'the schedule has no event with that id');

  const mutations = planEventFormMutations(event, input.values);
  return await runEventWrite(deps, 'update', input.eventId, async (operations, revision) => await operations.updateEvent({
    eventId: input.eventId as OpaqueRecordId,
    expectedRevision: revision,
    mutations,
  }));
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
