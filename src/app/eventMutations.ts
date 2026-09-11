/**
 * Stage 12's record editing: `event.create`, `event.update`, `event.delete`, `event.reschedule`
 * and `event.resize` as semantic operations rather than a calendar reaching into storage.
 *
 * The same boundary every other canonical write uses, and for the same reasons: the request is
 * closed and typed rather than a JSON patch, nothing is written until everything is valid, creates
 * go through the store's idempotent `createIfAbsent`, and existing records change through the
 * recovery coordinator with the revision the caller read.
 *
 * **Why a move and a resize are their own verbs.** They are not field updates wearing different
 * names. A reschedule keeps the duration and moves the start; a resize keeps the start and moves the
 * end. An agent asked to "move event E to 2026-09-10 14:30, retaining its current duration" should
 * say exactly that, and a drag gesture should compile to exactly that — so both callers say
 * *reschedule*, and neither has to know what a calendar column width is. The two share this module's
 * single date-writing path with `event.update`, so the verbs differ in shape, not in outcome.
 *
 * **Date validation belongs to this layer, not to the caller.** An event must have a start and an
 * end, both real instants, with the end strictly after the start; a reschedule or resize that would
 * break that is refused before any byte moves. Snapping to fifteen minutes is deliberately *not*
 * here: that is a gesture rule, and an agent that asks for 14:37 gets 14:37 rather than a silently
 * rounded answer (Stage 12's snapping box lives with the drag, not with the write).
 *
 * Failures speak the action taxonomy's vocabulary — `validation-refused`, `not-found`,
 * `stale-revision`, `semantic-conflict`, `recovery-required`, `storage-failure` — so the same
 * operation is reported identically whether a person dragged a block or an agent asked in a
 * sentence.
 */
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import { defineCanonicalRecordHeader, type OpaqueRecordId } from '../domain/canonicalIdentity.js';
import {
  type CanonicalEventRecordV2,
  type CanonicalRecordV2,
  type CanonicalStoredPropertyValue,
  type CanonicalStoredPropertyValues,
} from '../domain/canonicalRecordV2.js';
import type { CanonicalRecurrenceSeries } from '../domain/canonicalRecurrence.js';
import type { RecordStore } from '../ports/recordStore.js';
import { canonicalRecordV2Codec } from './canonicalRecordCodec.js';
import { encodeRecordDocument, recordFileNameFor } from './jsonRecordStore.js';
import type { RecordMutationCoordinator } from './recordMutation.js';

export const EVENT_MUTATION_SCHEMA_VERSION = 1 as const;

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_DURATION_MINUTES = 525_600;

/** The action taxonomy's non-accepted outcomes, so a failure is reportable as one. */
export type EventMutationFailureReason =
  | 'validation-refused'
  | 'not-found'
  | 'stale-revision'
  | 'semantic-conflict'
  | 'recovery-required'
  | 'storage-failure';

export interface EventMutationSuccess {
  readonly ok: true;
  readonly schemaVersion: typeof EVENT_MUTATION_SCHEMA_VERSION;
  readonly outcome: 'created' | 'updated' | 'deleted' | 'rescheduled' | 'resized';
  readonly recordId: OpaqueRecordId;
  readonly revision: string;
  /** The record as written; `null` for a delete. */
  readonly record: CanonicalEventRecordV2 | null;
}

export interface EventMutationFailure {
  readonly ok: false;
  readonly schemaVersion: typeof EVENT_MUTATION_SCHEMA_VERSION;
  readonly reason: EventMutationFailureReason;
  /** One bounded sentence, safe to show: never a path, a secret or a stack. */
  readonly detail: string;
  /** Present for a stale refusal, so the caller can refetch rather than guess. */
  readonly actualRevision?: string;
}

export type EventMutationResult = EventMutationSuccess | EventMutationFailure;

export interface EventMutationDependencies {
  readonly store: RecordStore<CanonicalRecordV2>;
  readonly coordinator: RecordMutationCoordinator;
  /** Injected: nothing here reads a clock. */
  readonly clock?: Clock;
  readonly allocateRecordId: () => OpaqueRecordId;
}

export interface CreateEventRequest {
  readonly name: string;
  readonly projectId: OpaqueRecordId | null;
  readonly description?: string;
  /** Both ends are required: an event without a span is not an event. */
  readonly startDate: string;
  readonly deadline: string;
  readonly isCompleted?: boolean;
  readonly recurrence?: CanonicalRecurrenceSeries | null;
  readonly properties?: CanonicalStoredPropertyValues;
}

/**
 * One field of an event, named. The dates are *not* in this union: they move through
 * `event.reschedule` and `event.resize`, which are the verbs a gesture and an agent sentence both
 * compile to, and one place that writes them is what keeps the three from disagreeing.
 */
export type EventFieldMutation =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'description'; readonly value: string }
  | { readonly kind: 'project'; readonly value: OpaqueRecordId | null }
  | { readonly kind: 'completion'; readonly value: boolean }
  | { readonly kind: 'recurrence'; readonly value: CanonicalRecurrenceSeries | null }
  | { readonly kind: 'property'; readonly key: OpaqueRecordId; readonly value: CanonicalStoredPropertyValue | null };

/** A resize names either the new end or the duration it should have, never both and never neither. */
export type EventResizeTarget =
  | { readonly kind: 'end'; readonly value: string }
  | { readonly kind: 'duration'; readonly minutes: number };

function refused(detail: string): EventMutationFailure {
  return { ok: false, schemaVersion: EVENT_MUTATION_SCHEMA_VERSION, reason: 'validation-refused', detail };
}

function failed(reason: EventMutationFailureReason, detail: string, actualRevision?: string): EventMutationFailure {
  return {
    ok: false,
    schemaVersion: EVENT_MUTATION_SCHEMA_VERSION,
    reason,
    detail,
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
}

/** A real instant, or null. The value is kept as written: nothing here reformats a caller's date. */
function instant(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function spanFailure(startDate: string, deadline: string): EventMutationFailure | null {
  const start = Date.parse(startDate);
  const end = Date.parse(deadline);
  if (!Number.isFinite(start)) return refused('the start is not a real instant');
  if (!Number.isFinite(end)) return refused('the end is not a real instant');
  if (end <= start) return refused('an event must end after it starts');
  return null;
}

/** Null means "no such record of that kind", which is a refusal rather than an empty answer. */
async function requireRecord(
  deps: EventMutationDependencies,
  id: OpaqueRecordId,
  kind: 'project' | 'schema',
): Promise<{ ok: true } | { ok: false; failure: EventMutationFailure }> {
  let observation;
  try {
    observation = await deps.store.read(id);
  } catch {
    return { ok: false, failure: failed('storage-failure', 'the record store could not be read') };
  }
  if (observation === undefined || observation.kind !== kind) {
    return { ok: false, failure: failed('semantic-conflict', `no ${kind} record ${id}`) };
  }
  return { ok: true };
}

function success(
  outcome: EventMutationSuccess['outcome'],
  recordId: OpaqueRecordId,
  revision: string,
  record: CanonicalEventRecordV2 | null,
): EventMutationSuccess {
  return { ok: true, schemaVersion: EVENT_MUTATION_SCHEMA_VERSION, outcome, recordId, revision, record };
}

function outcomeOf(
  result: { ok: boolean; reason?: string },
  recordId: OpaqueRecordId,
  revision: string,
  record: CanonicalEventRecordV2 | null,
  outcome: 'updated' | 'deleted' | 'rescheduled' | 'resized',
  actualRevision?: string,
): EventMutationResult {
  if (result.ok) return success(outcome, recordId, revision, record);
  switch (result.reason) {
    case 'stale':
      return failed('stale-revision', 'another writer changed this event first', actualRevision);
    case 'missing':
      return failed('not-found', 'the event record is not in the store');
    case 'recovery-required':
      return failed('recovery-required', 'the store needs recovery before it accepts writes');
    case 'invalid-record-file-name':
      return failed('validation-refused', 'the record id cannot name a record file');
    default:
      return failed('storage-failure', 'the record store rejected the write');
  }
}

/**
 * Read an event at the revision the caller saw, refusing before anything is built on a record the
 * caller has not read.
 */
async function readAtRevision(
  deps: EventMutationDependencies,
  eventId: OpaqueRecordId,
  expectedRevision: string,
): Promise<{ ok: true; record: CanonicalEventRecordV2 } | { ok: false; failure: EventMutationFailure }> {
  let observation;
  try {
    observation = await deps.store.read(eventId);
  } catch {
    return { ok: false, failure: failed('storage-failure', 'the record store could not be read') };
  }
  if (observation === undefined) return { ok: false, failure: failed('not-found', 'the event record is not in the store') };
  if (observation.kind !== 'event') return { ok: false, failure: failed('not-found', 'the record at that id is not an event') };
  if (observation.observedRevision !== expectedRevision) {
    return {
      ok: false,
      failure: failed('stale-revision', 'another writer changed this event first', observation.observedRevision),
    };
  }
  return { ok: true, record: observation.record as CanonicalEventRecordV2 };
}

/** The one place an event's own bytes are written. Every date verb above shares it. */
async function writeEvent(
  deps: EventMutationDependencies,
  record: CanonicalEventRecordV2,
  expectedRevision: string,
  outcome: 'updated' | 'rescheduled' | 'resized',
): Promise<EventMutationResult> {
  let text: string;
  try {
    text = encodeRecordDocument(record, canonicalRecordV2Codec);
  } catch {
    return refused('the event record did not validate');
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'update',
      fileName: recordFileNameFor(record.id),
      text,
      expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  return outcomeOf(result, record.id, result.ok ? result.revision : '', record, outcome, result.ok ? undefined : result.actualRevision);
}

export async function createEvent(
  deps: EventMutationDependencies,
  request: CreateEventRequest,
): Promise<EventMutationResult> {
  if (typeof request.name !== 'string' || request.name.trim().length === 0) return refused('an event needs a name');
  if (request.name.length > MAX_NAME_LENGTH) return refused(`an event name may be at most ${MAX_NAME_LENGTH} characters`);
  const description = request.description ?? '';
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) return refused('the description is too long');

  const startDate = instant(request.startDate);
  if (startDate === null) return refused('an event needs a start that is a real instant');
  const deadline = instant(request.deadline);
  if (deadline === null) return refused('an event needs an end that is a real instant');
  const span = spanFailure(startDate, deadline);
  if (span !== null) return span;

  if (request.projectId !== null) {
    const project = await requireRecord(deps, request.projectId, 'project');
    if (!project.ok) return project.failure;
  }

  const record: CanonicalEventRecordV2 = {
    ...defineCanonicalRecordHeader({ kind: 'event', id: deps.allocateRecordId(), name: request.name }),
    description,
    projectId: request.projectId,
    createdAt: new Date(deps.clock?.now() ?? systemClock.now()).toISOString(),
    isCompleted: request.isCompleted ?? false,
    properties: request.properties ?? {},
    recurrence: request.recurrence ?? null,
    startDate,
    deadline,
  };

  // Creation is the store's own idempotent boundary, exactly as it is for a task or a project: it
  // either creates the record or says it was already there, and there is no prior revision to lose.
  let result;
  try {
    result = await deps.store.createIfAbsent(record as CanonicalRecordV2);
  } catch {
    return failed('storage-failure', 'the record store rejected the write');
  }
  if (!result.ok) {
    return result.reason === 'already-exists'
      ? failed('semantic-conflict', 'a record with that id already exists')
      : failed('storage-failure', 'the record store rejected the write', result.actualRevision);
  }

  return success('created', record.id, result.revision, record);
}

function applyFieldMutations(
  current: CanonicalEventRecordV2,
  mutations: readonly EventFieldMutation[],
): { ok: true; record: CanonicalEventRecordV2 } | { ok: false; failure: EventMutationFailure } {
  let next = current;
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'name': {
        if (typeof mutation.value !== 'string' || mutation.value.trim().length === 0) return { ok: false, failure: refused('an event needs a name') };
        if (mutation.value.length > MAX_NAME_LENGTH) return { ok: false, failure: refused(`an event name may be at most ${MAX_NAME_LENGTH} characters`) };
        next = { ...next, name: mutation.value };
        break;
      }
      case 'description': {
        if (typeof mutation.value !== 'string' || mutation.value.length > MAX_DESCRIPTION_LENGTH) return { ok: false, failure: refused('the description is too long') };
        next = { ...next, description: mutation.value };
        break;
      }
      case 'project': {
        next = { ...next, projectId: mutation.value };
        break;
      }
      case 'completion': {
        next = { ...next, isCompleted: mutation.value === true };
        break;
      }
      case 'recurrence': {
        next = { ...next, recurrence: mutation.value };
        break;
      }
      case 'property': {
        const properties = { ...next.properties };
        if (mutation.value === null) delete properties[mutation.key];
        else properties[mutation.key] = mutation.value;
        next = { ...next, properties };
        break;
      }
      default: {
        return { ok: false, failure: refused('unknown event field mutation') };
      }
    }
  }

  return { ok: true, record: next };
}

export async function updateEvent(
  deps: EventMutationDependencies,
  input: { eventId: OpaqueRecordId; expectedRevision: string; mutations: readonly EventFieldMutation[] },
): Promise<EventMutationResult> {
  if (input.mutations.length === 0) return refused('an update with no field to change is not an update');

  const found = await readAtRevision(deps, input.eventId, input.expectedRevision);
  if (!found.ok) return found.failure;

  const applied = applyFieldMutations(found.record, input.mutations);
  if (!applied.ok) return applied.failure;

  for (const mutation of input.mutations) {
    if (mutation.kind === 'project' && mutation.value !== null) {
      const project = await requireRecord(deps, mutation.value, 'project');
      if (!project.ok) return project.failure;
    }
    if (mutation.kind === 'property') {
      const schema = await requireRecord(deps, mutation.key, 'schema');
      if (!schema.ok) return failed('semantic-conflict', `no schema record defines the property ${mutation.key}`);
    }
  }

  return await writeEvent(deps, applied.record, input.expectedRevision, 'updated');
}

export async function deleteEvent(
  deps: EventMutationDependencies,
  input: { eventId: OpaqueRecordId; expectedRevision: string },
): Promise<EventMutationResult> {
  const found = await readAtRevision(deps, input.eventId, input.expectedRevision);
  if (!found.ok) return found.failure;

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'delete',
      fileName: recordFileNameFor(input.eventId),
      expectedRevision: input.expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  return outcomeOf(result, input.eventId, result.ok ? result.revision : '', null, 'deleted', result.ok ? undefined : result.actualRevision);
}

/**
 * Move an event: the start moves and the duration is preserved.
 *
 * The duration is taken from the record, not from the caller, which is what makes the agent's
 * sentence and a drag gesture the same request — neither has to compute the new end.
 */
export async function rescheduleEvent(
  deps: EventMutationDependencies,
  input: { eventId: OpaqueRecordId; expectedRevision: string; startDate: string },
): Promise<EventMutationResult> {
  const startDate = instant(input.startDate);
  if (startDate === null) return refused('the new start is not a real instant');

  const found = await readAtRevision(deps, input.eventId, input.expectedRevision);
  if (!found.ok) return found.failure;

  const duration = Date.parse(found.record.deadline) - Date.parse(found.record.startDate);
  const deadline = new Date(Date.parse(startDate) + duration).toISOString();
  const span = spanFailure(startDate, deadline);
  if (span !== null) return span;

  return await writeEvent(deps, { ...found.record, startDate, deadline }, input.expectedRevision, 'rescheduled');
}

/**
 * Resize an event: the start stays and the end moves, named either as an end or as a duration.
 *
 * Both spellings are accepted because both are things a caller actually knows: a drag gesture knows
 * where the bottom edge landed, and an agent asked for "90 minutes" knows the duration. Whichever it
 * is, the resulting span is validated here rather than by the gesture.
 */
export async function resizeEvent(
  deps: EventMutationDependencies,
  input: { eventId: OpaqueRecordId; expectedRevision: string; target: EventResizeTarget },
): Promise<EventMutationResult> {
  const found = await readAtRevision(deps, input.eventId, input.expectedRevision);
  if (!found.ok) return found.failure;

  let deadline: string;
  if (input.target.kind === 'end') {
    const end = instant(input.target.value);
    if (end === null) return refused('the new end is not a real instant');
    deadline = end;
  } else {
    const minutes = input.target.minutes;
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0) return refused('a duration must be a whole number of minutes greater than zero');
    if (minutes > MAX_DURATION_MINUTES) return refused(`a duration may be at most ${MAX_DURATION_MINUTES} minutes`);
    deadline = new Date(Date.parse(found.record.startDate) + minutes * 60_000).toISOString();
  }

  const span = spanFailure(found.record.startDate, deadline);
  if (span !== null) return span;

  return await writeEvent(deps, { ...found.record, deadline }, input.expectedRevision, 'resized');
}
