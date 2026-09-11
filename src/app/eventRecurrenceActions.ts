/**
 * Stage 13's write sequences: `event.recurrence.set`, `event.recurrence.clear` and the
 * occurrence-scoped edit.
 *
 * The scope is a parameter, never an inference. A caller that acts on one occurrence says so, and a
 * caller that means the whole series says that instead — which is what lets an agent and a reader
 * produce the same state rather than two states that happen to look alike. The four combinations are
 * four different writes:
 *
 * | scope | change | what is written |
 * | --- | --- | --- |
 * | occurrence | reschedule | one `rescheduled` exception on the series |
 * | occurrence | cancel | one `cancelled` exception, so the slot stays a hole |
 * | series | reschedule | the owner record's span, and the series' exceptions are dropped |
 * | series | cancel | the owner record itself is deleted, explicitly |
 *
 * The series-scoped move drops the overrides on purpose: they were answers about the old schedule,
 * and keeping them would leave a series whose exceptions describe instants its rule no longer
 * generates. That is stated in the outcome rather than left for a reader to discover.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CanonicalRecurrenceRule, OpaqueRecurrenceSeriesId, CanonicalRecurrenceSeries } from '../domain/canonicalRecurrence.js';
import { defineCanonicalRecurrenceSeries } from '../domain/canonicalRecurrence.js';
import type { EventMutationResult } from './eventMutations.js';
import type { EventFieldMutation } from './eventMutations.js';
import {
  planOccurrenceException,
  planRecurrenceClear,
  planRecurrenceSet,
  recurrenceRuleOf,
  seriesOf,
  type OccurrenceChange,
  type OccurrenceScope,
  type RecurrencePlanFailure,
} from './eventRecurrencePlan.js';
import type { EventWriteDependencies, EventWriteOperations } from './eventWriteActions.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const RECURRENCE_WRITE_SCHEMA_VERSION = 1 as const;

export type RecurrenceWriteVerb = 'recurrence-set' | 'recurrence-clear' | 'occurrence-update';

export type RecurrenceWriteFailureReason =
  | 'unknown-event'
  | 'writes-unavailable'
  | RecurrencePlanFailure
  | 'validation-refused'
  | 'not-found'
  | 'stale-revision'
  | 'semantic-conflict'
  | 'recovery-required'
  | 'storage-failure';

export type RecurrenceWriteOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof RECURRENCE_WRITE_SCHEMA_VERSION;
      readonly verb: RecurrenceWriteVerb;
      readonly scope: OccurrenceScope | null;
      readonly outcome: 'updated' | 'deleted';
      readonly recordId: OpaqueRecordId;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof RECURRENCE_WRITE_SCHEMA_VERSION;
      readonly verb: RecurrenceWriteVerb;
      readonly scope: OccurrenceScope | null;
      readonly reason: RecurrenceWriteFailureReason;
      readonly detail: string;
      readonly refreshed: boolean;
    };

function refused(
  verb: RecurrenceWriteVerb,
  scope: OccurrenceScope | null,
  reason: RecurrenceWriteFailureReason,
  detail: string,
  refreshed = false,
): RecurrenceWriteOutcome {
  return { ok: false, schemaVersion: RECURRENCE_WRITE_SCHEMA_VERSION, verb, scope, reason, detail, refreshed };
}

function accepted(
  verb: RecurrenceWriteVerb,
  scope: OccurrenceScope | null,
  written: EventMutationResult & { readonly ok: true },
  refreshed: boolean,
): RecurrenceWriteOutcome {
  return {
    ok: true,
    schemaVersion: RECURRENCE_WRITE_SCHEMA_VERSION,
    verb,
    scope,
    outcome: written.outcome === 'deleted' ? 'deleted' : 'updated',
    recordId: written.recordId,
    revision: written.revision,
    refreshed,
  };
}

/**
 * Run one recurrence write and converge the surfaces.
 *
 * The revision comes from the event the surface was rendering, so a caller that lost a race is told
 * so with the revision that beat it — which for a series means the whole rule, not one occurrence.
 */
async function runRecurrenceWrite(
  deps: EventWriteDependencies,
  verb: RecurrenceWriteVerb,
  scope: OccurrenceScope | null,
  eventId: string,
  write: (operations: EventWriteOperations, revision: string) => Promise<EventMutationResult>,
): Promise<RecurrenceWriteOutcome> {
  const event = deps.state?.events.find((candidate) => candidate.id === eventId);
  if (event === undefined) return refused(verb, scope, 'unknown-event', 'the schedule has no event with that id');
  const revision = event.source.revision;

  deps.setRefusal(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    return refused(verb, scope, 'writes-unavailable', reason);
  }

  const written = await write(operations, revision);
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  deps.render();

  return written.ok
    ? accepted(verb, scope, written, convergence.refreshed)
    : refused(verb, scope, written.reason, written.detail, convergence.refreshed);
}

/** The mutations `event.update` is given, submitted as one accepted write. */
async function submitMutations(
  deps: EventWriteDependencies,
  verb: RecurrenceWriteVerb,
  scope: OccurrenceScope | null,
  eventId: string,
  plan: (event: NonNullable<EventWriteDependencies['state']>['events'][number]) => { readonly ok: true; readonly mutations: readonly EventFieldMutation[] } | { readonly ok: false; readonly reason: RecurrencePlanFailure; readonly detail: string },
): Promise<RecurrenceWriteOutcome> {
  const event = deps.state?.events.find((candidate) => candidate.id === eventId);
  if (event === undefined) return refused(verb, scope, 'unknown-event', 'the schedule has no event with that id');
  const planned = plan(event);
  if (!planned.ok) return refused(verb, scope, planned.reason, planned.detail);

  return await runRecurrenceWrite(deps, verb, scope, eventId, async (operations, revision) => await operations.updateEvent({
    eventId: eventId as OpaqueRecordId,
    expectedRevision: revision,
    mutations: planned.mutations,
  }));
}

/** `event.recurrence.set`: the record starts recurring, or starts recurring differently. */
export async function setRecurrenceAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string; readonly rule: CanonicalRecurrenceRule; readonly allocateSeriesId: () => OpaqueRecurrenceSeriesId },
): Promise<RecurrenceWriteOutcome> {
  return await submitMutations(deps, 'recurrence-set', null, input.eventId, (event) => planRecurrenceSet(event, input.rule, input.allocateSeriesId));
}

/** `event.recurrence.clear`: the record stops recurring. Occurrences already moved stay where they are. */
export async function clearRecurrenceAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string },
): Promise<RecurrenceWriteOutcome> {
  return await submitMutations(deps, 'recurrence-clear', null, input.eventId, () => planRecurrenceClear());
}

/**
 * One occurrence, or the whole series — the scope decides which, and the caller always says which.
 *
 * A series-scoped cancel deletes the owner record rather than writing an exception for every slot:
 * "delete this series" and "skip this occurrence" are different requests, and a caller that meant the
 * first must not get the second.
 */
export async function updateOccurrenceAction(
  deps: EventWriteDependencies,
  input: {
    readonly eventId: string;
    readonly occurrenceStart: string;
    readonly scope: OccurrenceScope;
    readonly change: OccurrenceChange;
  },
): Promise<RecurrenceWriteOutcome> {
  const event = deps.state?.events.find((candidate) => candidate.id === input.eventId);
  if (event === undefined) return refused('occurrence-update', input.scope, 'unknown-event', 'the schedule has no event with that id');

  if (input.scope === 'occurrence') {
    const planned = planOccurrenceException(event, input.occurrenceStart, input.change);
    if (!planned.ok) return refused('occurrence-update', input.scope, planned.reason, planned.detail);
    return await runRecurrenceWrite(deps, 'occurrence-update', input.scope, input.eventId, async (operations, revision) => await operations.updateEvent({
      eventId: input.eventId as OpaqueRecordId,
      expectedRevision: revision,
      mutations: planned.mutations,
    }));
  }

  if (input.change.kind === 'cancel') {
    return await runRecurrenceWrite(deps, 'occurrence-update', input.scope, input.eventId, async (operations, revision) => await operations.deleteEvent({
      eventId: input.eventId as OpaqueRecordId,
      expectedRevision: revision,
    }));
  }

  // A series-scoped move: the owner record's span changes, and the overrides it carried are dropped
  // because they describe instants the moved rule no longer generates.
  const series = seriesOf(event);
  const mutations: EventFieldMutation[] = [
    { kind: 'span', startDate: input.change.startDate, deadline: input.change.deadline },
    ...(series === null
      ? []
      : [{
          kind: 'recurrence' as const,
          value: defineCanonicalRecurrenceSeries({
            seriesId: series.seriesId,
            ownerKind: 'event',
            ownerRecordId: series.ownerRecordId,
            rule: series.rule,
            exceptions: [],
          }) as CanonicalRecurrenceSeries,
        }]),
  ];

  return await runRecurrenceWrite(deps, 'occurrence-update', input.scope, input.eventId, async (operations, revision) => await operations.updateEvent({
    eventId: input.eventId as OpaqueRecordId,
    expectedRevision: revision,
    mutations,
  }));
}

/** Exported for the surfaces: the rule an event carries today, so a form can open on it. */
export { recurrenceRuleOf };
