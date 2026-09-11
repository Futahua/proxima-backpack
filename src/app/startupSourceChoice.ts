/**
 * Which source startup should choose, and why.
 *
 * HARD GATE C item 1 says startup chooses the record store "after successful migration
 * activation". This is that decision as one testable function, with every answer named —
 * including the ones that mean "stay on the legacy reader", because a fallback that does not
 * say why is how a cutover becomes invisible.
 *
 * The rule is deliberately conservative: the store is chosen only when a valid activation
 * marker is present **and** the store still holds the records that marker counted. Anything
 * else keeps the product on the legacy reader and reports the reason, because an empty
 * canonical store renders an empty application, and that is worse than reading Markdown.
 */
import type { CanonicalRecordKind } from '../domain/canonicalIdentity.js';
import type { CanonicalRecordV2 } from '../domain/canonicalRecordV2.js';
import type { RecordStore } from '../ports/recordStore.js';
import {
  readRecordStoreActivation,
  type RecordStoreActivationMarker,
  type RecordStoreActivationStorage,
} from './recordStoreActivation.js';

export const STARTUP_SOURCE_DECISION_VERSION = 1 as const;

export type StartupSourceReason =
  | 'activated'
  | 'no-activation-marker'
  | 'invalid-activation-marker'
  | 'empty-store-after-activation'
  | 'store-short-of-activation'
  | 'store-unreadable';

export interface StartupSourceDecision {
  readonly schemaVersion: typeof STARTUP_SOURCE_DECISION_VERSION;
  readonly kind: 'record-store' | 'legacy';
  readonly reason: StartupSourceReason;
  /** Present exactly when the store was chosen. */
  readonly marker: RecordStoreActivationMarker | null;
  /** One bounded sentence for the startup inspection. Empty when nothing went wrong. */
  readonly detail: string;
  /** What the store holds now, per kind, when it could be read. */
  readonly counts: Readonly<Record<CanonicalRecordKind, number>> | null;
}

const EMPTY_COUNTS: Record<CanonicalRecordKind, number> = {
  task: 0,
  project: 0,
  event: 0,
  schema: 0,
  'workflow-stage': 0,
};

function countsOf(observations: readonly { kind: CanonicalRecordKind }[]): Record<CanonicalRecordKind, number> {
  const counts = { ...EMPTY_COUNTS };
  for (const observation of observations) counts[observation.kind] += 1;
  return counts;
}

/**
 * Choose. A store that cannot be read is not chosen, and the failure is reported rather than
 * swallowed: `store-unreadable` is a different answer from `no-activation-marker`.
 */
export async function chooseStartupSource(input: {
  store: RecordStore<CanonicalRecordV2>;
  activation: RecordStoreActivationStorage;
}): Promise<StartupSourceDecision> {
  const activation = await readRecordStoreActivation(input.activation);

  if (activation.status === 'absent') {
    return {
      schemaVersion: STARTUP_SOURCE_DECISION_VERSION,
      kind: 'legacy',
      reason: 'no-activation-marker',
      marker: null,
      detail: 'the record store has never been activated',
      counts: null,
    };
  }

  if (activation.status === 'invalid' || activation.marker === null) {
    return {
      schemaVersion: STARTUP_SOURCE_DECISION_VERSION,
      kind: 'legacy',
      reason: 'invalid-activation-marker',
      marker: null,
      detail: activation.detail,
      counts: null,
    };
  }

  let observations: readonly { kind: CanonicalRecordKind }[];
  try {
    observations = await input.store.list();
  } catch (error) {
    return {
      schemaVersion: STARTUP_SOURCE_DECISION_VERSION,
      kind: 'legacy',
      reason: 'store-unreadable',
      marker: activation.marker,
      detail: `record store could not be read: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
      counts: null,
    };
  }

  const counts = countsOf(observations);
  const held = observations.length;
  const activated = Object.values(activation.marker.counts).reduce((total, count) => total + count, 0);

  if (held === 0) {
    return {
      schemaVersion: STARTUP_SOURCE_DECISION_VERSION,
      kind: 'legacy',
      reason: 'empty-store-after-activation',
      marker: activation.marker,
      detail: `store was activated with ${activated} record(s) and now holds none`,
      counts,
    };
  }

  if (held < activated) {
    return {
      schemaVersion: STARTUP_SOURCE_DECISION_VERSION,
      kind: 'legacy',
      reason: 'store-short-of-activation',
      marker: activation.marker,
      detail: `store was activated with ${activated} record(s) and now holds ${held}`,
      counts,
    };
  }

  return {
    schemaVersion: STARTUP_SOURCE_DECISION_VERSION,
    kind: 'record-store',
    reason: 'activated',
    marker: activation.marker,
    detail: '',
    counts,
  };
}
