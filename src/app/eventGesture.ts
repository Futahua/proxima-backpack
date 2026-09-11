/**
 * Gesture geometry becomes semantic requests here, and nowhere else.
 *
 * Stage 12's drag and resize boxes ask for two things that are easy to conflate: a block that follows
 * the pointer while it is being dragged, and a write that happens when it is released. This module is
 * the second half — the part that decides what a gesture *means* — and it is deliberately free of the
 * DOM: it takes the slot delta a gesture worked out and answers with the request an operation takes,
 * or with a typed reason there is no request at all.
 *
 * Three rules, each of which is a box in the checklist:
 *
 * - **Snapping is here, not in the write.** A pointer delta in pixels becomes a whole number of
 *   fifteen-minute slots, rounded to nearest, so a block can only ever be drawn or written on a slot
 *   boundary. An agent asking for 14:37 still gets 14:37 (see `eventMutations.ts`); it is the
 *   *gesture* that cannot express it, which is the difference between a snappy drag and a write path
 *   that second-guesses its callers.
 * - **A drag is arithmetic on instants, not a column lookup.** The new start is the old start plus
 *   the slot delta, so dragging past midnight crosses into the next civil day by itself and a
 *   cross-day drag is still one request. Nothing here clamps a move to the column it started in.
 * - **An impossible resize never becomes a request.** A drag that would leave no duration is refused
 *   with `invalid-duration` before anything is submitted, so the block snaps back with a reason
 *   rather than a round trip that the operation would refuse anyway.
 */
import type { EventResizeTarget } from './eventMutations.js';

export const SLOT_MINUTES = 15;
export const SLOTS_PER_DAY = 96;
export const MINUTES_PER_DAY = SLOT_MINUTES * SLOTS_PER_DAY;

export type ScheduleGestureFailure = 'unknown-instant' | 'invalid-duration';

export interface EventDragGesture {
  /** The event as the surface was rendering it: the gesture is relative to what the reader saw. */
  readonly startDate: string;
  readonly deadline: string;
  /** Whole slots the pointer moved, earlier being negative. */
  readonly slotDelta: number;
}

export interface EventResizeGesture {
  readonly startDate: string;
  /** The bottom edge as the surface was drawing it, which is what the pointer moved from. */
  readonly deadline: string;
  readonly slotDelta: number;
}

function instantMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pixels to slots, rounded to nearest.
 *
 * Ties go away from zero for the same reason the Gantt's do: a pointer exactly between two slots has
 * to land somewhere, and "always later" is a rule a reader can predict, while "whichever way the
 * floating point went" is not.
 */
export function snappedSlotDelta(pixelDelta: number, slotHeightPx: number): number {
  if (!Number.isFinite(pixelDelta) || !Number.isFinite(slotHeightPx) || slotHeightPx <= 0) return 0;
  const slots = pixelDelta / slotHeightPx;
  return slots < 0 ? -Math.round(-slots) : Math.round(slots);
}

/** The provisional span a drag would draw: the same arithmetic the request will use, before it is sent. */
export function provisionalSpan(
  gesture: EventDragGesture,
): { readonly startDate: string; readonly deadline: string } | { readonly reason: ScheduleGestureFailure } {
  const start = instantMs(gesture.startDate);
  const end = instantMs(gesture.deadline);
  if (start === null || end === null) return { reason: 'unknown-instant' };
  const shift = gesture.slotDelta * SLOT_MINUTES * 60_000;
  return {
    startDate: new Date(start + shift).toISOString(),
    deadline: new Date(end + shift).toISOString(),
  };
}

/**
 * A drag's request: the new start, with the duration left to the operation.
 *
 * The duration is deliberately *not* sent. `event.reschedule` takes it from the record, so a gesture
 * and an agent's sentence produce the same request even if the surface was rendering a stale end.
 */
export function rescheduleRequestFromDrag(
  gesture: EventDragGesture,
): { readonly ok: true; readonly startDate: string } | { readonly ok: false; readonly reason: ScheduleGestureFailure } {
  const span = provisionalSpan(gesture);
  if ('reason' in span) return { ok: false, reason: span.reason };
  return { ok: true, startDate: span.startDate };
}

/** True when a drag moved nothing, so a release can clear the provisional state without a request. */
export function dragIsNoop(gesture: EventDragGesture): boolean {
  return gesture.slotDelta === 0;
}

/**
 * A resize's request: the duration the bottom edge implies, in whole minutes.
 *
 * Refused here when the drag would leave no time at all, because "invalid duration refused before
 * storage" is a promise about what leaves the gesture, not about what the operation answers.
 */
export function resizeTargetFromDrag(
  gesture: EventResizeGesture,
): { readonly ok: true; readonly target: EventResizeTarget } | { readonly ok: false; readonly reason: ScheduleGestureFailure } {
  const start = instantMs(gesture.startDate);
  const end = instantMs(gesture.deadline);
  if (start === null || end === null) return { ok: false, reason: 'unknown-instant' };
  const duration = end - start + gesture.slotDelta * SLOT_MINUTES * 60_000;
  const minutes = Math.round(duration / 60_000);
  if (minutes <= 0) return { ok: false, reason: 'invalid-duration' };
  return { ok: true, target: { kind: 'duration', minutes } };
}

/**
 * The instant an empty-cell click stands for: a civil day and a slot, as the grid drew them.
 *
 * Null rather than a guess when either half is not something the grid can have produced.
 */
export function slotInstant(dayKey: string, slotIndex: number): string | null {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= SLOTS_PER_DAY) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (day === null) return null;
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + slotIndex * SLOT_MINUTES * 60_000).toISOString();
}

/** Which slot an instant falls in, for drawing a block or a drop target. Null when it is not an instant. */
export function slotIndexForInstant(instant: string): number | null {
  const parsed = instantMs(instant);
  if (parsed === null) return null;
  const midnight = Date.UTC(
    new Date(parsed).getUTCFullYear(),
    new Date(parsed).getUTCMonth(),
    new Date(parsed).getUTCDate(),
  );
  return Math.floor((parsed - midnight) / (SLOT_MINUTES * 60_000));
}
