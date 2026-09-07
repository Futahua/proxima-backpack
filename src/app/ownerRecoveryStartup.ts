import type { RecoveryRecord, RecoveryStore } from './vaultRecovery.js';
import { classifyRecoveryRecord, type RecoveryReadSource, type RecoveryClassification } from './vaultRecoveryReconcile.js';

export interface StartupRecoveryStore extends RecoveryStore { load(): Promise<void>; }

export interface StartupRecoveryOutcome {
  requestId: string;
  classification: RecoveryClassification | 'error';
  status: 'committed' | 'recovered' | 'blocked' | 'already-committed' | 'error';
  reason: string;
}

export interface StartupRecoveryResult {
  mutationAuthority: 'available' | 'blocked';
  outcomes: readonly StartupRecoveryOutcome[];
  unresolved: number;
  reason?: string;
}

function boundedReason(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 200) || 'recovery error';
}

/**
 * Load and reconcile durable recovery state before owner-mode mutations are
 * exposed. This changes journal status only; it never restores or writes vault
 * bytes. Any unreadable journal/classification/status write blocks authority.
 */
export async function reconcileOwnerRecoveryOnStartup(
  store: StartupRecoveryStore,
  reader: RecoveryReadSource,
  maxOutcomes = 128,
): Promise<StartupRecoveryResult> {
  try { await store.load(); }
  catch (error) { return { mutationAuthority: 'blocked', outcomes: [], unresolved: 0, reason: boundedReason(error) }; }

  const outcomes: StartupRecoveryOutcome[] = [];
  let unresolved = 0;
  for (const record of store.list()) {
    if (record.status === 'committed') {
      if (outcomes.length < maxOutcomes) outcomes.push({ requestId: record.requestId, classification: 'already-committed', status: 'already-committed', reason: 'journal already committed' });
      continue;
    }
    if (record.status !== undefined && record.status !== 'prepared' && record.status !== 'recovery-required') continue;
    unresolved += 1;
    let classification: RecoveryClassification;
    try { classification = (await classifyRecoveryRecord(record, reader)).classification; }
    catch (error) {
      if (outcomes.length < maxOutcomes) outcomes.push({ requestId: record.requestId, classification: 'error', status: 'error', reason: boundedReason(error) });
      return { mutationAuthority: 'blocked', outcomes, unresolved, reason: 'recovery classification failed' };
    }
    try {
      if (!store.updateStatus) throw new Error('recovery status persistence unavailable');
      if (classification === 'effect-present') await store.updateStatus(record.requestId, 'committed');
      else if (classification === 'not-applied') await store.updateStatus(record.requestId, 'recovered');
      else if (classification === 'conflict') await store.updateStatus(record.requestId, 'blocked');
      if (outcomes.length < maxOutcomes) outcomes.push({ requestId: record.requestId, classification, status: classification === 'effect-present' ? 'committed' : classification === 'not-applied' ? 'recovered' : classification === 'conflict' ? 'blocked' : 'already-committed', reason: classification });
    } catch (error) {
      if (outcomes.length < maxOutcomes) outcomes.push({ requestId: record.requestId, classification: 'error', status: 'error', reason: boundedReason(error) });
      return { mutationAuthority: 'blocked', outcomes, unresolved, reason: 'recovery status persistence failed' };
    }
  }
  return { mutationAuthority: 'available', outcomes, unresolved };
}

