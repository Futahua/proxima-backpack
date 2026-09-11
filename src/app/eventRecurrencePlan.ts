/**
 * Recurrence and occurrence-scope writes, planned before anything is submitted.
 *
 * Stage 13's question is what "this occurrence" means, and the answer this module implements is the
 * one the canonical model already declares: a series is a rule on its owner's record, and an
 * occurrence-scoped edit is an **exception** on that series, keyed by the instant the *rule*
 * generated. Three consequences follow, and each is a box in the checklist.
 *
 * - **An occurrence override cannot invent a slot.** The planner regenerates the occurrence with
 *   `canonicalOccurrenceSequence`, so an override is accepted only for an instant the rule actually
 *   generates. Without that check, an occurrence the calendar merely *drew* could become a durable
 *   exception on the next save, which is exactly the "persisted because it was displayed" failure.
 * - **The override is keyed by the scheduled instant, not by where it moved to.** Moving an
 *   occurrence twice edits the same exception rather than accumulating two, and the series keeps one
 *   entry per rule slot — which is what `defineCanonicalRecurrenceSeries` refuses duplicates for.
 * - **Series scope is explicit and different.** A series-scoped edit moves the owner record (every
 *   occurrence derives from it) or deletes it; it never writes an exception, and nothing here infers
 *   the scope from which surface the reader used.
 *
 * The planner is pure: it takes the event as the surface was rendering it and answers with the
 * mutations a save would submit, or with a typed reason there are none.
 */
import {
  canonicalOccurrenceSequence,
  defineCanonicalRecurrenceSeries,
  type CanonicalRecurrenceException,
  type CanonicalRecurrenceRule,
  type CanonicalRecurrenceSeries,
  type CanonicalRecurrenceWeekday,
  type OpaqueRecurrenceSeriesId,
} from '../domain/canonicalRecurrence.js';
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CalendarEvent } from '../domain/types.js';
import type { EventFieldMutation } from './eventMutations.js';

export type OccurrenceScope = 'occurrence' | 'series';

/** What a scope is being asked to do. A cancel deletes; a reschedule moves. */
export type OccurrenceChange =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'reschedule'; readonly startDate: string; readonly deadline: string };

export type RecurrencePlanFailure =
  | 'no-series'
  | 'no-rule'
  | 'not-a-generated-occurrence'
  | 'invalid-span'
  | 'unknown-exception';

export type RecurrencePlanResult =
  | { readonly ok: true; readonly mutations: readonly EventFieldMutation[] }
  | { readonly ok: false; readonly reason: RecurrencePlanFailure; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical series the projection carried for this event, or null when it does not recur. */
export function seriesOf(event: Pick<CalendarEvent, 'id' | 'properties'>): CanonicalRecurrenceSeries | null {
  const raw = event.properties.recurrenceSeries;
  if (!isRecord(raw) || typeof raw.seriesId !== 'string') return null;
  const rule = recurrenceRuleOf(event);
  if (rule === null) return null;
  const exceptions = Array.isArray(raw.exceptions) ? raw.exceptions : [];
  try {
    return defineCanonicalRecurrenceSeries({
      seriesId: raw.seriesId as OpaqueRecurrenceSeriesId,
      ownerKind: 'event',
      ownerRecordId: event.id as OpaqueRecordId,
      rule,
      exceptions: exceptions as readonly CanonicalRecurrenceException[],
    });
  } catch {
    return null;
  }
}

/** The canonical rule the projection carried, or null when the event does not recur. */
export function recurrenceRuleOf(event: Pick<CalendarEvent, 'properties'>): CanonicalRecurrenceRule | null {
  const raw = event.properties.recurrenceRule;
  if (!isRecord(raw)) return null;
  const interval = raw.interval;
  const end = raw.end;
  if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1) return null;
  if (!isRecord(end) || typeof end.kind !== 'string') return null;
  const canonicalEnd = end.kind === 'never'
    ? { kind: 'never' as const }
    : end.kind === 'count' && typeof end.count === 'number'
      ? { kind: 'count' as const, count: end.count }
      : end.kind === 'until' && typeof end.until === 'string'
        ? { kind: 'until' as const, until: end.until }
        : null;
  if (canonicalEnd === null) return null;

  switch (raw.frequency) {
    case 'daily': return { frequency: 'daily', interval, end: canonicalEnd };
    case 'weekly': return Array.isArray(raw.weekdays)
      ? { frequency: 'weekly', interval, weekdays: raw.weekdays as readonly CanonicalRecurrenceWeekday[], end: canonicalEnd }
      : null;
    case 'monthly': return typeof raw.dayOfMonth === 'number'
      ? { frequency: 'monthly', interval, dayOfMonth: raw.dayOfMonth, end: canonicalEnd }
      : null;
    case 'yearly': return typeof raw.month === 'number' && typeof raw.dayOfMonth === 'number'
      ? { frequency: 'yearly', interval, month: raw.month, dayOfMonth: raw.dayOfMonth, end: canonicalEnd }
      : null;
    default: return null;
  }
}

/**
 * Set or replace the series rule — `event.recurrence.set`.
 *
 * An existing series keeps its id and its exceptions: changing how often something repeats is not a
 * reason to forget that two of its occurrences were moved, and a new series id would detach every
 * override the reader had made.
 */
export function planRecurrenceSet(
  event: Pick<CalendarEvent, 'id' | 'properties'>,
  rule: CanonicalRecurrenceRule,
  allocateSeriesId: () => OpaqueRecurrenceSeriesId,
): RecurrencePlanResult {
  const existing = seriesOf(event);
  const series = defineCanonicalRecurrenceSeries({
    seriesId: existing === null ? allocateSeriesId() : existing.seriesId,
    ownerKind: 'event',
    ownerRecordId: (existing === null ? event.id : existing.ownerRecordId) as OpaqueRecordId,
    rule,
    exceptions: existing === null ? [] : existing.exceptions,
  });
  return { ok: true, mutations: [{ kind: 'recurrence', value: series }] };
}

/** Clear the series — `event.recurrence.clear`. The record stops recurring; its history is not rewritten. */
export function planRecurrenceClear(): RecurrencePlanResult {
  return { ok: true, mutations: [{ kind: 'recurrence', value: null }] };
}

/**
 * Plan an occurrence-scoped edit: one exception on the series, replacing any for the same slot.
 *
 * @param event - the event as the surface was rendering it.
 * @param occurrenceStart - the instant the reader acted on, which must be one the rule generates.
 * @param change - what to do to that occurrence.
 * @returns the mutation, or a typed reason there is none.
 */
export function planOccurrenceException(
  event: Pick<CalendarEvent, 'id' | 'startDate' | 'properties'>,
  occurrenceStart: string,
  change: OccurrenceChange,
): RecurrencePlanResult {
  const series = seriesOf(event);
  if (series === null) return { ok: false, reason: 'no-series', detail: 'this event does not carry a series to override' };

  // The anchor is the record's own start: sequence zero is the event exactly as it was written, and
  // every later slot is the rule applied to it.
  const anchor = event.startDate;
  if (!Number.isFinite(Date.parse(anchor))) return { ok: false, reason: 'no-rule', detail: 'the record has no start for its rule to generate from' };

  const sequence = canonicalOccurrenceSequence(anchor, series.rule, occurrenceStart);
  if (sequence === null) {
    return {
      ok: false,
      reason: 'not-a-generated-occurrence',
      detail: 'that instant is not one this series generates, so an override for it would be a record nobody asked for',
    };
  }

  let exception: CanonicalRecurrenceException;
  if (change.kind === 'cancel') {
    exception = { occurrence: { seriesId: series.seriesId, scheduledStart: occurrenceStart }, state: 'cancelled' };
  } else {
    if (!Number.isFinite(Date.parse(change.startDate)) || !Number.isFinite(Date.parse(change.deadline))) {
      return { ok: false, reason: 'invalid-span', detail: 'a moved occurrence needs a real start and end' };
    }
    if (Date.parse(change.deadline) <= Date.parse(change.startDate)) {
      return { ok: false, reason: 'invalid-span', detail: 'an event must end after it starts' };
    }
    exception = {
      occurrence: { seriesId: series.seriesId, scheduledStart: occurrenceStart },
      state: 'rescheduled',
      startDate: change.startDate,
      deadline: change.deadline,
    };
  }

  const kept = series.exceptions.filter((candidate) => candidate.occurrence.scheduledStart !== occurrenceStart);
  return {
    ok: true,
    mutations: [{
      kind: 'recurrence',
      value: defineCanonicalRecurrenceSeries({
        seriesId: series.seriesId,
        ownerKind: 'event',
        ownerRecordId: series.ownerRecordId,
        rule: series.rule,
        // The replaced exception goes last, so a series reads as its rule, the overrides it already
        // had, and the one just made.
        exceptions: [...kept, exception],
      }),
    }],
  };
}

/** The exceptions a series carries today, which a scope modal shows before the reader picks one. */
export function occurrenceExceptionsOf(event: Pick<CalendarEvent, 'id' | 'properties'>): readonly CanonicalRecurrenceException[] {
  return seriesOf(event)?.exceptions ?? [];
}
