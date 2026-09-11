/**
 * What every accepted (or lost) record write owes the surface afterwards: a re-read.
 *
 * Two rules, and they are the whole file.
 *
 * An **accepted** write has changed the record, so the surfaces are stale by definition and
 * re-reading is how they stop being stale. A **lost race** is the one refusal where the surface
 * was already wrong — the board was showing a revision the store no longer holds — so that one
 * re-reads too, which is what puts a card back where the store says it is.
 *
 * Every **other** refusal left the world exactly as it was. Refreshing there would be a redraw
 * that implies something happened, so it does not.
 *
 * A failure to re-read is reported rather than thrown, and never rolled back into the write:
 * presentation catching up with a durable record is not the record.
 */
import type { RefreshReason, RefreshResult } from './refreshController.js';

export interface WriteConvergence {
  readonly refreshed: boolean;
  /** Set when the re-read did not happen: the write, if any, still stands. */
  readonly refreshFailure: string | null;
}

export interface WriteConvergenceDependencies {
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
}

export async function convergeAfterWrite(
  deps: WriteConvergenceDependencies,
  outcome: { readonly accepted: boolean; readonly lostRace?: boolean },
): Promise<WriteConvergence> {
  if (!outcome.accepted && outcome.lostRace !== true) {
    return { refreshed: false, refreshFailure: null };
  }

  try {
    const result = await deps.refresh('manual');
    return {
      refreshed: result !== null,
      refreshFailure: result === null ? 'the source session declined to refresh' : null,
    };
  } catch (error) {
    return {
      refreshed: false,
      refreshFailure: error instanceof Error ? error.message.slice(0, 120) : 'the refresh failed',
    };
  }
}
