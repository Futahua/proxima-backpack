/**
 * The recurrence scope modal's shell half: what happens between the reader's Save and the next
 * render.
 *
 * It is a module of its own because this surface's half is not the same shape as the others. The
 * scope is passed through exactly as chosen — an occurrence-scoped save writes one exception and
 * leaves the series alone, a series-scoped one moves the owner record and every occurrence with it —
 * and the *answer* is handed back to the shell, which owns the two facts only it can know: an
 * accepted write closes the modal and clears the occurrence it was about, because that occurrence is
 * no longer where the reader was looking; a refused one keeps both, with the dates they typed.
 *
 * Nothing here decides anything about the record. It runs the sequence and reports what it said.
 */
import type { OccurrenceChange, OccurrenceScope } from '../app/eventRecurrencePlan.js';
import { updateOccurrenceAction, type RecurrenceWriteOutcome } from '../app/eventRecurrenceActions.js';
import type { EventWriteDependencies } from '../app/eventWriteActions.js';

/** Save the scope the reader chose. The scope is a parameter, never an inference. */
export async function updateOccurrenceFromScope(input: {
  readonly eventId: string;
  readonly occurrenceStart: string;
  readonly scope: OccurrenceScope;
  readonly change: OccurrenceChange;
  readonly deps: EventWriteDependencies;
}): Promise<RecurrenceWriteOutcome> {
  return await updateOccurrenceAction(input.deps, {
    eventId: input.eventId,
    occurrenceStart: input.occurrenceStart,
    scope: input.scope,
    change: input.change,
  });
}

/**
 * Skip one occurrence: a cancelled exception, never a deleted record.
 *
 * The series-scoped delete stays a different action on purpose. "Skip this one" and "delete the
 * series" are different requests, and a reader who asked for the first must not lose the second.
 */
export async function skipOccurrenceFromScope(input: {
  readonly eventId: string;
  readonly occurrenceStart: string;
  readonly deps: EventWriteDependencies;
}): Promise<RecurrenceWriteOutcome> {
  return await updateOccurrenceAction(input.deps, {
    eventId: input.eventId,
    occurrenceStart: input.occurrenceStart,
    scope: 'occurrence',
    change: { kind: 'cancel' },
  });
}
