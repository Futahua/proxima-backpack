/**
 * How a refusal is written down for a reader.
 *
 * Every write action reports a refusal to its surface through `setRefusal(reason: string)` — one
 * channel, and until now every caller passed the bare machine code through it. The producers already
 * write more than that: a `TaskMutationFailure` carries `detail`, one bounded sentence that is safe to
 * show, and `actualRevision`, the revision that beat the caller on a lost race. Both were being
 * dropped at the last hop, so a reader who lost a race was told `stale-revision` and left to work out
 * what had happened to their task.
 *
 * The code stays first, and that is deliberate rather than cosmetic: selectors and existing cases
 * match on the code, and an agent driving the product needs the stable token before the prose. What
 * follows it is the sentence the producer wrote and the revision that won, so the same string is both
 * machinable and explainable.
 *
 * This is presentation, not policy: it decides nothing about whether a write was allowed, and it can
 * only ever say more about a refusal that already happened.
 */
export interface RefusalPresentation {
  /** The stable machine code, always rendered first. */
  readonly code: string;
  /** The producer's bounded sentence, when it wrote one. */
  readonly detail?: string | null;
  /** The revision that beat the caller, when the refusal was a lost race. */
  readonly actualRevision?: string | null;
}

const SEPARATOR = ' \u2014 ';

export function refusalTextFor(refusal: RefusalPresentation): string {
  const detail = refusal.detail?.trim();
  const revision = refusal.actualRevision?.trim();
  let text = refusal.code;
  if (detail) text += SEPARATOR + detail;
  if (revision) text += ` (now at revision ${revision})`;
  return text;
}
