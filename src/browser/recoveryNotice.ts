/**
 * What the boot's recovery reconciliation is allowed to say about itself.
 *
 * Gate 14 asks for a rollback/recovery story, and the machinery for one is real: a durable journal,
 * a classifier that separates "never applied" from "effect present" from "conflicted", and a
 * conditional restore that refuses to overwrite a record someone else has since changed. It runs on
 * every boot, before mutation authority is handed out — and until now its answer went nowhere a
 * person could see. It reached the acceptance report and stopped there.
 *
 * That is the failure mode this module exists to remove, and the honest default matters more than the
 * happy path: `not-run` is not `clean`. A boot that reconciled nothing must not look like a boot that
 * found nothing, because the difference between those two is exactly what a reader needs after a
 * crash. So every status renders, including the clean one, and `tone` is `attention` for everything
 * except a reconciliation that actually resolved everything it found.
 */
import type { StartupRecoveryInspection } from '../app/startupSession.js';

export interface RecoveryNoticeView {
  readonly status: StartupRecoveryInspection['status'];
  /** Whether this boot's reconciliation is a clean bill of health, or something to look at. */
  readonly tone: 'clean' | 'attention';
  /** The status again, for a selector: an agent should not have to parse the sentence. */
  readonly machineValue: StartupRecoveryInspection['status'];
  readonly mutationAuthority: 'available' | 'blocked' | 'unknown';
  readonly unresolved: number | null;
  readonly sentence: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The notice for one boot.
 *
 * `null` means the boot has not answered yet, which is `not-run` rather than a default worth trusting:
 * the recovery gate is a gate on mutation authority, so "we have not asked" and "we asked and it was
 * fine" must never render the same way.
 */
export function recoveryNoticeFor(recovery: StartupRecoveryInspection | null): RecoveryNoticeView {
  if (recovery === null || recovery.status === 'not-run') {
    return {
      status: 'not-run',
      tone: 'attention',
      machineValue: 'not-run',
      mutationAuthority: 'unknown',
      unresolved: null,
      sentence: 'Recovery: not run — this boot has not reconciled the journal',
    };
  }

  const authority = recovery.mutationAuthority;
  if (recovery.status === 'failed') {
    return {
      status: 'failed',
      tone: 'attention',
      machineValue: 'failed',
      mutationAuthority: authority,
      unresolved: recovery.unresolved,
      sentence: `Recovery: failed — ${recovery.reason ?? 'the journal could not be read'}`,
    };
  }

  if (recovery.status === 'blocked') {
    return {
      status: 'blocked',
      tone: 'attention',
      machineValue: 'blocked',
      mutationAuthority: authority,
      unresolved: recovery.unresolved,
      sentence: `Recovery: blocked — ${recovery.reason ?? 'an entry could not be reconciled'}; writes stay closed`,
    };
  }

  // Reconciled, but "reconciled" alone is not a clean bill of health: unresolved entries are the
  // ones a reader has to decide about, so a boot that leaves any is attention rather than clean.
  const unresolved = recovery.unresolved;
  const clean = unresolved === 0 && authority === 'available';
  return {
    status: 'reconciled',
    tone: clean ? 'clean' : 'attention',
    machineValue: 'reconciled',
    mutationAuthority: authority,
    unresolved,
    sentence: clean
      ? `Recovery: reconciled — ${plural(recovery.outcomes, 'outcome')}, nothing unresolved`
      : `Recovery: reconciled — ${plural(recovery.outcomes, 'outcome')}, ${unresolved} unresolved`,
  };
}
