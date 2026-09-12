/**
 * The semantic request envelope, and the terminal event an applicable write owes.
 *
 * Two things every semantic action needs and none of them had, ruled by the AUTHOR on 2026-09-12 after
 * Stage 17's contract matrix showed the same two gaps on all thirty-six rows:
 *
 * - **A semantic request id**, minted at the public semantic-action boundary - before validation and before
 *   the write path is resolved - and returned on every result, success, refusal and partial alike. It is
 *   deliberately **not** the record-mutation coordinator's id: that one exists only once an update or delete
 *   reaches the coordinator, while this one has to cover refusals decided before storage, creates that go
 *   through `createIfAbsent`, a `writes-unavailable` outcome, and one template run spanning several child
 *   creations - and reusing one coordinator id for a batch would give several underlying mutations the same
 *   recovery identity. The record layer's contract is untouched; internal child writes keep their own ids.
 * - **A terminal audit event**, appended once per run through a sink the composition supplies, so the event
 *   carries the real observable state revision rather than one the record layer invented.
 *
 * Nothing here mints, stores or renders: it is the vocabulary two layers agree on, so an action can say what
 * happened without knowing what a ring is, and the shell can journal it without knowing what a template is.
 */
import type { IdGenerator } from '../domain/clock.js';

/** The prefix a minted semantic request id carries. It encodes no record kind and no action. */
export const SEMANTIC_REQUEST_PREFIX = 'semantic-request' as const;

/**
 * What a run's terminal event says happened.
 *
 * `partial` is its own outcome rather than a flavour of the other two: a run where one record landed and the
 * second was refused is neither an acceptance nor a rejection, and reporting it as either would be the lie
 * the panel rule exists to avoid.
 */
export type SemanticOutcome = 'accepted' | 'rejected' | 'partial';

/** One bounded sentence of audit: what ran, what it did, what it touched, and why it stopped. */
export interface SemanticAuditEvent {
  readonly requestId: string;
  readonly actionType: string;
  readonly outcome: SemanticOutcome;
  /**
   * The ids this event is about.
   *
   * For an acceptance or a partial run: every id that actually landed. For a rejection: the targets the run
   * was refused about, when they are known - a run with nothing marked has none - because a refusal nobody can
   * trace to a record is a dead end. A bulk run names them all, in the order they were requested.
   */
  readonly entityIds: readonly string[];
  /** The machine-readable refusal, when the run did not complete. */
  readonly errorCode?: string;
}

/** Where a terminal event goes. The shell supplies it; the record layer never does. */
export interface SemanticAuditSink {
  append(event: SemanticAuditEvent): void;
}

/** Mint the id for one semantic run. Called before validation, so a refused run is correlatable too. */
export function mintSemanticRequestId(ids: IdGenerator): string {
  return ids.next(SEMANTIC_REQUEST_PREFIX);
}

/**
 * The terminal outcome, from what the run wrote and whether it stopped.
 *
 * Written as one function rather than left to each action, because "wrote something and stopped" is exactly
 * the case that gets reported as an acceptance when each caller decides for itself.
 */
export function semanticOutcomeOf(run: { readonly wrote: number; readonly refused: boolean }): SemanticOutcome {
  if (run.wrote === 0) return run.refused ? 'rejected' : 'accepted';
  return run.refused ? 'partial' : 'accepted';
}
