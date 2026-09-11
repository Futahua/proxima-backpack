/**
 * Where the product's state comes from, as one seam instead of two.
 *
 * Before this, the only source was a `VaultReader`: the refresh controller reloaded by
 * walking a vault and the session could switch between a fixture and an external vault,
 * both of which are the *same* source with different bytes behind them. HARD GATE C's
 * cutover needs a genuinely different source — the Proxima record store — so the reload
 * becomes "ask the source", and a source says what kind it is.
 *
 * A source deliberately does not know how to write, where its bytes live, or whether it has
 * any bytes at all. It answers one question: read the world now, and tell me the revisions
 * so a caller can notice what changed.
 */
import type { CanonicalRecordV2 } from '../domain/canonicalRecordV2.js';
import type { LoadProblem } from '../domain/problems.js';
import type { ProximaState } from '../domain/types.js';
import type { RecordStore } from '../ports/recordStore.js';
import type { VaultReader } from '../ports/vault.js';
import { loadRecordStoreState } from './recordStoreStateLoad.js';
import { loadVaultState, type LoadOptions } from './vaultRepository.js';
import type { VaultLayout } from './vaultLayout.js';

export type StateSourceKind = 'legacy-vault' | 'record-store';

/** What any source can answer, whatever it read. */
export interface StateSourceLoad {
  readonly state: ProximaState;
  /** Everything the source could not interpret, or interpreted with a caveat. */
  readonly problems: LoadProblem[];
  /** Identity key → revision at load time, so a caller can detect what changed. */
  readonly revisions: Record<string, string>;
  /**
   * The legacy layout a vault read used. Absent for a source that has no vault: the record
   * store is not a directory of Markdown and must not pretend to have a layout.
   */
  readonly layout?: VaultLayout;
}

export interface StateSource {
  readonly kind: StateSourceKind;
  load(): Promise<StateSourceLoad>;
}

/** The legacy Markdown source: a vault, read the way it has always been read. */
export function vaultStateSource(
  vault: VaultReader,
  options: LoadOptions = {},
): StateSource {
  return {
    kind: 'legacy-vault',
    load: () => loadVaultState(vault, options),
  };
}

/**
 * The Proxima record store as a source.
 *
 * The store's own boundary validates records, so a source that reads through it cannot hand
 * back a world built from JSON that merely parsed. Everything the readable shape cannot
 * carry is in `report.gaps`, and this source reports the store's problems as **none**: a
 * canonical record is valid by construction, so a "problem" here would be a projection gap
 * rather than a reader complaint, and conflating the two would make a degraded-source banner
 * mean two different things.
 */
export function recordStoreStateSource(
  store: RecordStore<CanonicalRecordV2>,
): StateSource & { lastReport(): Awaited<ReturnType<typeof loadRecordStoreState>>['report'] | null; } {
  let lastReport: Awaited<ReturnType<typeof loadRecordStoreState>>['report'] | null = null;
  return {
    kind: 'record-store',
    async load(): Promise<StateSourceLoad> {
      const loaded = await loadRecordStoreState(store);
      lastReport = loaded.report;
      return {
        state: loaded.state,
        problems: [],
        revisions: loaded.revisions,
      };
    },
    lastReport: () => lastReport,
  };
}
