/**
 * The browser's record-store source, resolved behind a read-only seam.
 *
 * HARD GATE C wants startup to choose the store, and `recordMutationContainment` wants the
 * browser shell to hold **no** RecordStore authority — both are right, and the way to satisfy
 * both is to keep the composition here rather than in `main.ts`. The shell asks one question
 * and receives a `StateSource`, whose type has no mutation method on it at all: the store
 * object itself never crosses this boundary, so the shell could not write a record even by
 * mistake.
 *
 * Everything here is best-effort. A browser without OPFS, a store whose marker this build
 * cannot read, or an activation this build does not understand all resolve to `source: null`
 * with a reason, which the caller reports and then reads the legacy vault as before.
 */
import { createCanonicalJsonRecordStore } from '../app/canonicalRecordCodec.js';
import { chooseStartupSource } from '../app/startupSourceChoice.js';
import { recordStoreStateSource, type StateSource } from '../app/stateSource.js';
import {
  createBrowserOpfsRecordStoreActivationStorage,
  createBrowserOpfsRecordStoreFileBackend,
} from './opfsRecordStoreFileBackend.js';

export interface BrowserRecordStoreResolution {
  /** The store as a source, or null when the legacy reader should keep the records. */
  readonly source: StateSource | null;
  readonly decision: {
    readonly kind: 'record-store' | 'legacy';
    readonly reason: string;
    readonly detail: string;
  };
}

export async function resolveBrowserRecordStoreSource(): Promise<BrowserRecordStoreResolution> {
  try {
    const backend = await createBrowserOpfsRecordStoreFileBackend();
    const activation = await createBrowserOpfsRecordStoreActivationStorage();
    const store = createCanonicalJsonRecordStore(backend);
    const decision = await chooseStartupSource({ store, activation });

    return {
      source: decision.kind === 'record-store' ? recordStoreStateSource(store) : null,
      decision: { kind: decision.kind, reason: decision.reason, detail: decision.detail },
    };
  } catch (error) {
    return {
      source: null,
      decision: {
        kind: 'legacy',
        reason: 'store-unreadable',
        detail: `record store unavailable: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
      },
    };
  }
}
