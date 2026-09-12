/**
 * How wide a Timekeeping panel is, which is the reader's business and not the record's.
 *
 * This file exists because one box in the parity agenda asks for exactly one property and nothing else:
 * **panel sizing is local state**. Visibility became local state when the panels became compositional, and a
 * width is the same kind of fact - how wide this reader has a panel is not something a task, a project or an
 * event holds. The pattern is the Backlog's column resize, which the box itself points at: a pure clamp in the
 * app layer, the width held in disposable view state, clamped to a range and **never written**. So the two
 * functions here are pure, they return a new map rather than editing one, and nothing in this module can reach
 * a store - there is no import in it at all, which is the strongest form of "this writes nothing".
 *
 * The bounds are deliberately the same shape as the Backlog's and deliberately not the same numbers: a column
 * in a table and a panel in a stack are different things, and reusing one constant for both would make a later
 * change to either look safe when it is not.
 *
 * One thing a reader might expect here and will not find: **no height is tracked.** A panel's height is what
 * its content needs, and a reader who could drag it would be choosing to hide their own work. Width is the
 * axis that carries information here, because the Calendar and the Timeline both lay out in columns.
 */

/** How narrow a Timekeeping panel may be dragged, so a week column never becomes unreadable. */
export const TIMEEKEEPING_PANEL_MIN_WIDTH: number = 320;

/** How wide a Timekeeping panel may be dragged, so one panel cannot swallow the stack. */
export const TIMEEKEEPING_PANEL_MAX_WIDTH: number = 1280;

/** The width a panel starts at, before anybody has dragged it. */
export const TIMEEKEEPING_PANEL_DEFAULT_WIDTH: number = 640;

/**
 * Clamp a proposed panel width.
 *
 * A drag reports pixels, and a drag can go anywhere: off the left edge of the stack, or far past the right.
 * Rounding to whole pixels keeps a rendered width and a held width the same number, so a reload does not drift
 * a panel by a fraction each time - the same reason the Backlog's clamp rounds.
 *
 * @param width - the width the drag proposed, in pixels.
 * @returns a whole number of pixels inside the bounds, or the default when the proposal is not a number.
 */
export function clampTimekeepingPanelWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return TIMEEKEEPING_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(
    TIMEEKEEPING_PANEL_MAX_WIDTH,
    Math.max(
      TIMEEKEEPING_PANEL_MIN_WIDTH,
      Math.round(width),
    ),
  );
}

/**
 * Record one panel's width, leaving every other panel as it was.
 *
 * A width is how this reader is looking at the stack, not what the stack means, which is why it lives in view
 * state and why this returns a new map rather than editing one.
 *
 * @param widths - the widths in effect.
 * @param panel - the panel being resized.
 * @param width - the proposed width, which is clamped.
 * @returns the next widths, or a copy of the same ones when nothing changed.
 */
export function resizeTimekeepingPanel(
  widths: Readonly<Record<string, number>>,
  panel: string,
  width: number,
): Readonly<Record<string, number>> {
  const clamped = clampTimekeepingPanelWidth(width);
  if (widths[panel] === clamped) {
    return { ...widths };
  }

  return {
    ...widths,
    [panel]: clamped,
  };
}

/**
 * The width to draw a panel at.
 *
 * A panel nobody has resized has no entry, and every surface that draws one asks this rather than the map, so
 * the default lives in one place instead of at each call site.
 *
 * @param widths - the widths in effect.
 * @param panel - the panel being drawn.
 * @returns the width in pixels.
 */
export function timekeepingPanelWidth(
  widths: Readonly<Record<string, number>>,
  panel: string,
): number {
  return widths[panel] ?? TIMEEKEEPING_PANEL_DEFAULT_WIDTH;
}
