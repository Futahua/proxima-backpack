/**
 * What the Event editor's form says, and the mutations a save would submit.
 *
 * The Event editor is a `FormDraft`: field-id keyed text, one check per flag. The record is a
 * `CalendarEvent` from the world the surface was rendering. This module is the bridge, and it is
 * deliberately pure — no store, no clock, no DOM — so "what changed" is a computation over two
 * values rather than a reading of whatever the markup happens to hold.
 *
 * Two things are deliberate.
 *
 * **Only what changed is submitted.** A save that rewrites every field is a save that can overwrite
 * a change somebody else made to a field the reader never looked at; the mutations are the diff, and
 * an empty diff is refused downstream as a no-op rather than written.
 *
 * **A form's two ends travel as one mutation.** The editor shows a start and an end, and a reader who
 * fixes both is describing one new span rather than a reschedule plus a resize. `event.reschedule`
 * and `event.resize` remain the verbs a *gesture* and an *agent sentence* compile to (they name one
 * end and let the operation carry the other); the form sends both ends it can see, and all three
 * reach the same validated write.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import {
  defineCanonicalRecurrenceRule,
  type CanonicalRecurrenceRule,
  type CanonicalRecurrenceWeekday,
} from '../domain/canonicalRecurrence.js';
import type { CalendarEvent } from '../domain/types.js';
import type { EventRecurrenceFrequency } from './eventEditor.js';
import type { EventFieldMutation } from './eventMutations.js';

/**
 * The recurrence a form holds, in the editor's own terms.
 *
 * `none` is an event that does not recur, `series` is a rule the reader can see and change, and
 * `unsupported` is a recurrence the record carries that this vocabulary cannot express — a weekly rule on
 * several weekdays, which the projection reports as a gap rather than dropping. **The third case is why this
 * is a union rather than a nullable rule**: a form that read an unexpressible recurrence as "does not recur"
 * would clear it on the next save, which is the silent loss the projection's gap exists to prevent.
 */
export type EventFormRecurrenceEnd =
  | { readonly kind: 'never' }
  | { readonly kind: 'until'; readonly until: string }
  | { readonly kind: 'count'; readonly count: number };

export type EventFormRecurrence =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'series';
      readonly frequency: EventRecurrenceFrequency;
      readonly interval: number;
      readonly end: EventFormRecurrenceEnd;
    }
  | { readonly kind: 'unsupported' };

/** The values a form holds, as the record's own fields rather than as text. */
export interface EventFormValues {
  readonly name: string;
  readonly description: string;
  readonly projectId: string | null;
  readonly startDate: string;
  readonly deadline: string;
  readonly isCompleted: boolean;
  readonly recurrence: EventFormRecurrence;
}

function instant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The recurrence a record carries, as the form reads it.
 *
 * The canonical rule the projection carries is the authority; a record that has recurrence state but no
 * readable rule is `unsupported`, because that is a fact about the record rather than the absence of one.
 */
function recurrenceValuesOf(event: Pick<CalendarEvent, 'properties'>): EventFormRecurrence {
  // The projection's own marker for "this record recurs in a way the readable rule cannot carry" comes first:
  // it is the only answer that distinguishes that from "does not recur", and the difference decides whether a
  // save may clear the rule.
  if (event.properties.recurrenceUnreadable === true) return { kind: 'unsupported' };
  const rule = event.properties.recurrenceRule as CanonicalRecurrenceRule | undefined;
  if (rule !== undefined) {
    return {
      kind: 'series',
      frequency: rule.frequency,
      interval: rule.interval,
      end: { ...rule.end },
    };
  }
  return event.properties.recurrence === undefined && event.properties.recurrenceSeries === undefined
    ? { kind: 'none' }
    : { kind: 'unsupported' };
}

/** The weekday an instant falls on, in the rule's own vocabulary, computed in UTC like the anchor math. */
function weekdayOf(iso: string): CanonicalRecurrenceWeekday {
  const days: readonly CanonicalRecurrenceWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days[new Date(iso).getUTCDay()] ?? 'mon';
}

/**
 * The rule a form's recurrence amounts to, or the sentence saying why it amounts to none.
 *
 * Three of the rule's parts are **not asked for, and derived from the record's own start** instead: a weekly
 * rule's weekday, a monthly rule's day, and a yearly rule's month and day. That is not a default — the
 * domain states that the series owner's start *is* the anchor, sequence zero is the event exactly as it was
 * written, and the expansion applies the rule to it; so a weekly rule that repeats "on the day this event is
 * already on" says the same instants the anchor implies, and asking a reader to retype their own start date
 * would be asking for a chance to disagree with it.
 */
export function eventRecurrenceRuleFor(
  recurrence: EventFormRecurrence,
  anchor: string,
): { readonly ok: true; readonly rule: CanonicalRecurrenceRule } | { readonly ok: false; readonly detail: string } {
  if (recurrence.kind !== 'series') {
    return { ok: false, detail: 'this event does not recur, so there is no rule to write' };
  }
  if (!Number.isFinite(Date.parse(anchor))) {
    return { ok: false, detail: 'a recurrence needs the event to start at a readable instant' };
  }
  const shape = {
    daily: () => ({ frequency: 'daily' as const, interval: recurrence.interval, end: recurrence.end }),
    weekly: () => ({ frequency: 'weekly' as const, interval: recurrence.interval, weekdays: [weekdayOf(anchor)], end: recurrence.end }),
    monthly: () => ({ frequency: 'monthly' as const, interval: recurrence.interval, dayOfMonth: new Date(anchor).getUTCDate(), end: recurrence.end }),
    yearly: () => ({
      frequency: 'yearly' as const,
      interval: recurrence.interval,
      month: new Date(anchor).getUTCMonth() + 1,
      dayOfMonth: new Date(anchor).getUTCDate(),
      end: recurrence.end,
    }),
  };
  try {
    return { ok: true, rule: defineCanonicalRecurrenceRule(shape[recurrence.frequency]()) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether the form's recurrence differs from the record's, which is what decides if there is a second write. */
export function eventRecurrenceChanged(
  event: Pick<CalendarEvent, 'properties'>,
  values: EventFormValues,
): boolean {
  const current = recurrenceValuesOf(event);
  if (current.kind !== values.recurrence.kind) return true;
  if (current.kind !== 'series' || values.recurrence.kind !== 'series') return false;
  return current.frequency !== values.recurrence.frequency
    || current.interval !== values.recurrence.interval
    || current.end.kind !== values.recurrence.end.kind
    || (current.end.kind === 'until' && values.recurrence.end.kind === 'until' && current.end.until !== values.recurrence.end.until)
    || (current.end.kind === 'count' && values.recurrence.end.kind === 'count' && current.end.count !== values.recurrence.end.count);
}


/**
 * The values an editor opens on: the record, read.
 *
 * Null when the event is not in the world the surface was rendering, because a form for a record
 * nobody can see is a form with nothing to save.
 */
export function eventFormValuesFor(state: { readonly events: readonly CalendarEvent[] }, eventId: string): EventFormValues | null {
  const event = state.events.find((candidate) => candidate.id === eventId);
  if (event === undefined) return null;
  return {
    name: event.name,
    description: event.description,
    projectId: event.projectId,
    startDate: event.startDate,
    deadline: event.deadline,
    isCompleted: event.isCompleted,
    recurrence: recurrenceValuesOf(event),
  };
}

/**
 * The mutations a save would submit — only the fields the form actually changed.
 *
 * The span goes as one `span` mutation when either end moved, and never as two: a start without its
 * end would be a record that momentarily means a different duration, and the operation refuses a
 * span that is not a span, so the pair is what a caller has to state.
 */
export function planEventFormMutations(
  event: Pick<CalendarEvent, 'name' | 'description' | 'projectId' | 'startDate' | 'deadline' | 'isCompleted'>,
  values: EventFormValues,
): EventFieldMutation[] {
  const mutations: EventFieldMutation[] = [];
  if (values.name !== event.name) mutations.push({ kind: 'name', value: values.name });
  if (values.description !== event.description) mutations.push({ kind: 'description', value: values.description });
  if (values.projectId !== event.projectId) mutations.push({ kind: 'project', value: values.projectId as OpaqueRecordId | null });
  if (values.isCompleted !== event.isCompleted) mutations.push({ kind: 'completion', value: values.isCompleted });
  if (values.startDate !== event.startDate || values.deadline !== event.deadline) {
    mutations.push({ kind: 'span', startDate: values.startDate, deadline: values.deadline });
  }
  return mutations;
}

/**
 * What a save does about the rule, if anything.
 *
 * Four answers, and the third is the one worth having: a record whose recurrence this vocabulary cannot read
 * is **refused rather than cleared**, because the form cannot express what is stored, so a save that treated
 * it as "does not recur" would delete a rule nobody could see. The reader is told instead.
 */
export type EventRecurrenceWritePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'set'; readonly rule: CanonicalRecurrenceRule }
  | { readonly kind: 'clear' }
  | { readonly kind: 'refused'; readonly detail: string };

/**
 * Decide whether a save changes the rule, and to what.
 *
 * @param event - the record the surface was rendering.
 * @param values - the form's values, the span included: a rule is anchored on the record's own start, so a save
 *   that moves the start and changes the rule together derives the rule's weekday or day from the **new**
 *   start - which is the span the reader is looking at, and the one the record will carry.
 */
export function planEventRecurrenceWrite(
  event: Pick<CalendarEvent, 'properties'>,
  values: EventFormValues,
): EventRecurrenceWritePlan {
  const current = recurrenceValuesOf(event);
  if (current.kind === 'unsupported') {
    return {
      kind: 'refused',
      detail: 'the stored recurrence cannot be read here, so this form will not rewrite it',
    };
  }
  if (!eventRecurrenceChanged(event, values)) return { kind: 'none' };
  if (values.recurrence.kind === 'none') return { kind: 'clear' };
  const built = eventRecurrenceRuleFor(values.recurrence, values.startDate);
  return built.ok ? { kind: 'set', rule: built.rule } : { kind: 'refused', detail: built.detail };
}

/** True when the form would write something, which is what makes a Save worth offering. */
export function eventFormIsDirty(
  event: Pick<CalendarEvent, 'name' | 'description' | 'projectId' | 'startDate' | 'deadline' | 'isCompleted' | 'properties'>,
  values: EventFormValues,
): boolean {
  return planEventFormMutations(event, values).length > 0 || eventRecurrenceChanged(event, values);
}

/**
 * The values a newly seeded form starts with: the slot the reader clicked, and a one-hour proposal.
 *
 * The proposal is deliberate — an empty-cell click that created a zero-length event would be a write
 * nobody asked for — and the reader can change both ends before saving.
 */
export function seededEventValues(startDate: string, deadline: string, name = 'New event'): EventFormValues {
  return { name, description: '', projectId: null, startDate, deadline, isCompleted: false, recurrence: { kind: 'none' } };
}

/** True when the two ends are a span at all, so a form can say so before it submits. */
export function eventSpanIsValid(startDate: string, deadline: string): boolean {
  const start = instant(startDate);
  const end = instant(deadline);
  return start !== null && end !== null && end > start;
}
