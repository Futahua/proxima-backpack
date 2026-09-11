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
import type { CalendarEvent } from '../domain/types.js';
import type { EventFieldMutation } from './eventMutations.js';

/** The values a form holds, as the record's own fields rather than as text. */
export interface EventFormValues {
  readonly name: string;
  readonly description: string;
  readonly projectId: string | null;
  readonly startDate: string;
  readonly deadline: string;
  readonly isCompleted: boolean;
}

function instant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

/** True when the form would write something, which is what makes a Save worth offering. */
export function eventFormIsDirty(
  event: Pick<CalendarEvent, 'name' | 'description' | 'projectId' | 'startDate' | 'deadline' | 'isCompleted'>,
  values: EventFormValues,
): boolean {
  return planEventFormMutations(event, values).length > 0;
}

/**
 * The values a newly seeded form starts with: the slot the reader clicked, and a one-hour proposal.
 *
 * The proposal is deliberate — an empty-cell click that created a zero-length event would be a write
 * nobody asked for — and the reader can change both ends before saving.
 */
export function seededEventValues(startDate: string, deadline: string, name = 'New event'): EventFormValues {
  return { name, description: '', projectId: null, startDate, deadline, isCompleted: false };
}

/** True when the two ends are a span at all, so a form can say so before it submits. */
export function eventSpanIsValid(startDate: string, deadline: string): boolean {
  const start = instant(startDate);
  const end = instant(deadline);
  return start !== null && end !== null && end > start;
}
