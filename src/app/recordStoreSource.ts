/** The standalone record-store source, kept separate from the legacy vault source module. */
import type { CanonicalRecordV2 } from '../domain/canonicalRecordV2.js';
import type { RecordStore } from '../ports/recordStore.js';
import { loadRecordStoreState } from './recordStoreStateLoad.js';
import type { StateSource } from './stateSource.js';

export function recordStoreStateSource(store: RecordStore<CanonicalRecordV2>): StateSource {
  return {
    kind: 'record-store',
    async load() {
      const loaded = await loadRecordStoreState(store);
      return {
        state: loaded.state,
        problems: [],
        revisions: loaded.revisions,
      };
    },
  };
}
