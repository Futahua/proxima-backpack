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
import type { CalendarEvent } from '../domain/types.js';
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
import { mintSemanticRequestId, semanticOutcomeOf, type SemanticOutcome } from './semanticAudit.js';
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
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
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
      /** Present on a refusal too, so a refused change is correlatable with the event it left behind. */
      readonly requestId: string;
      readonly refreshed: boolean;
    };

/**
 * The journal's name for a run, which is where the scope becomes visible.
 *
 * A one-occurrence change and a series change are the same record write with different meaning, so a journal
 * that flattened them would leave a reader unable to tell which one a selection meant.
 */
function journalActionType(verb: RecurrenceWriteVerb, scope: OccurrenceScope | null): string {
  switch (verb) {
    case 'recurrence-set':
      return 'event.recurrence.set';
    case 'recurrence-clear':
      return 'event.recurrence.clear';
    default:
      return scope === 'series' ? 'event.series.change' : 'event.occurrence.change';
  }
}

function refused(
  verb: RecurrenceWriteVerb,
  scope: OccurrenceScope | null,
  reason: RecurrenceWriteFailureReason,
  detail: string,
  requestId: string,
  refreshed = false,
): RecurrenceWriteOutcome {
  return { ok: false, schemaVersion: RECURRENCE_WRITE_SCHEMA_VERSION, verb, scope, reason, detail, requestId, refreshed };
}

function accepted(
  verb: RecurrenceWriteVerb,
  scope: OccurrenceScope | null,
  written: EventMutationResult & { readonly ok: true },
  requestId: string,
  refreshed: boolean,
): RecurrenceWriteOutcome {
  return {
    ok: true,
    schemaVersion: RECURRENCE_WRITE_SCHEMA_VERSION,
    verb,
    scope,
    outcome: written.outcome === 'deleted' ? 'deleted' : 'updated',
    requestId,
    recordId: written.recordId,
    revision: written.revision,
    refreshed,
  };
}

/**
 * What a run will do, decided from the record it is about - or the refusal that stops it before any write.
 *
 * The plan is a step inside the sequence rather than a pre-check in front of it, because a pre-check refuses
 * outside the envelope: it would either need its own id or leave the refusal uncorrelated.
 */
type RecurrencePlanStep =
  | {
      readonly ok: true;
      readonly submit: (operations: EventWriteOperations, revision: string) => Promise<EventMutationResult>;
    }
  | { readonly ok: false; readonly reason: RecurrenceWriteFailureReason; readonly detail: string };

/**
 * Run one recurrence write and converge the surfaces, under the semantic envelope.
 *
 * The revision comes from the event the surface was rendering, so a caller that lost a race is told so with
 * the revision that beat it - which for a series means the whole rule, not one occurrence. The id is minted
 * before the event lookup can refuse, and the run leaves one terminal event whose name carries the scope.
 */
async function runRecurrenceWrite(
  deps: EventWriteDependencies,
  verb: RecurrenceWriteVerb,
  scope: OccurrenceScope | null,
  eventId: string,
  prepare: (event: CalendarEvent) => RecurrencePlanStep,
): Promise<RecurrenceWriteOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: journalActionType(verb, scope),
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  const event = deps.state?.events.find((candidate) => candidate.id === eventId);
  if (event === undefined) {
    audit('rejected', [eventId], 'unknown-event');
    return refused(verb, scope, 'unknown-event', 'the schedule has no event with that id', requestId);
  }

  const step = prepare(event);
  if (!step.ok) {
    audit('rejected', [eventId], step.reason);
    return refused(verb, scope, step.reason, step.detail, requestId);
  }

  deps.setRefusal(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', [eventId], 'writes-unavailable');
    return refused(verb, scope, 'writes-unavailable', reason, requestId);
  }

  const written = await step.submit(operations, event.source.revision);
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  deps.render();

  if (!written.ok) {
    audit(semanticOutcomeOf({ wrote: 0, refused: true }), [eventId], written.reason);
    return refused(verb, scope, written.reason, written.detail, requestId, convergence.refreshed);
  }

  audit(semanticOutcomeOf({ wrote: 1, refused: false }), [written.recordId]);
  return accepted(verb, scope, written, requestId, convergence.refreshed);
}

/** `event.recurrence.set`: the record starts recurring, or starts recurring differently. */
export async function setRecurrenceAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string; readonly rule: CanonicalRecurrenceRule; readonly allocateSeriesId: () => OpaqueRecurrenceSeriesId },
): Promise<RecurrenceWriteOutcome> {
  return await runRecurrenceWrite(deps, 'recurrence-set', null, input.eventId, (event) => {
    const planned = planRecurrenceSet(event, input.rule, input.allocateSeriesId);
    return planned.ok
      ? {
          ok: true,
          submit: async (operations, revision) => await operations.updateEvent({
            eventId: input.eventId as OpaqueRecordId,
            expectedRevision: revision,
            mutations: planned.mutations,
          }),
        }
      : { ok: false, reason: planned.reason, detail: planned.detail };
  });
}

/** `event.recurrence.clear`: the record stops recurring. Occurrences already moved stay where they are. */
export async function clearRecurrenceAction(
  deps: EventWriteDependencies,
  input: { readonly eventId: string },
): Promise<RecurrenceWriteOutcome> {
  return await runRecurrenceWrite(deps, 'recurrence-clear', null, input.eventId, () => {
    const planned = planRecurrenceClear();
    return planned.ok
      ? {
          ok: true,
          submit: async (operations, revision) => await operations.updateEvent({
            eventId: input.eventId as OpaqueRecordId,
            expectedRevision: revision,
            mutations: planned.mutations,
          }),
        }
      : { ok: false, reason: planned.reason, detail: planned.detail };
  });
}

/**
 * One occurrence, or the whole series — the scope decides which, and the caller always says which.
 *
 * A series-scoped cancel deletes the owner record rather than writing an exception for every slot:
 * "delete this series" and "skip this occurrence" are different requests, and a caller that meant the
 * first must not get the second. The scope is also what the journal names, so the two cannot be confused
 * after the fact either.
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
  return await runRecurrenceWrite(deps, 'occurrence-update', input.scope, input.eventId, (event) => {
    if (input.scope === 'occurrence') {
      const planned = planOccurrenceException(event, input.occurrenceStart, input.change);
      return planned.ok
        ? {
            ok: true,
            submit: async (operations, revision) => await operations.updateEvent({
              eventId: input.eventId as OpaqueRecordId,
              expectedRevision: revision,
              mutations: planned.mutations,
            }),
          }
        : { ok: false, reason: planned.reason, detail: planned.detail };
    }

    if (input.change.kind === 'cancel') {
      return {
        ok: true,
        submit: async (operations, revision) => await operations.deleteEvent({
          eventId: input.eventId as OpaqueRecordId,
          expectedRevision: revision,
        }),
      };
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

    return {
      ok: true,
      submit: async (operations, revision) => await operations.updateEvent({
        eventId: input.eventId as OpaqueRecordId,
        expectedRevision: revision,
        mutations,
      }),
    };
  });
}

/** Exported for the surfaces: the rule an event carries today, so a form can open on it. */
export { recurrenceRuleOf };
