/**
 * The record store as a state source.
 *
 * `loadVaultState` is the legacy-Markdown source: it walks a vault and interprets bytes.
 * This is the other source, and it is deliberately the same *shape* of answer — a readable
 * world plus the revisions a caller needs to notice change — so a surface that renders one
 * cannot tell which it was given. HARD GATE C item 5 is that the UI does not care; this is
 * the store-side half of it.
 *
 * It reads through the canonical store boundary, so records are validated by the canonical
 * codec rather than trusted because they parsed as JSON. A store that holds something the
 * codec refuses fails loudly here instead of producing a half-believed world.
 */
import type { CanonicalRecordV2 } from '../domain/canonicalRecordV2.js';
import type { RecordOrigin } from '../domain/records.js';
import type { ProximaState } from '../domain/types.js';
import type { RecordStore } from '../ports/recordStore.js';
import {
  projectRecordState,
  type RecordStateProjectionReport,
} from './recordStateProjection.js';

export interface RecordStoreStateLoad {
  readonly state: ProximaState;
  readonly origin: Extract<RecordOrigin, 'record-store'>;
  /** Record id → observed revision at load time, mirroring the legacy source's revisions. */
  readonly revisions: Readonly<Record<string, string>>;
  /** Everything the readable shape could not carry, named rather than dropped. */
  readonly report: RecordStateProjectionReport;
}

/**
 * Read the whole store and project it into the readable world.
 *
 * One `list()` call means one observed revision per record, so a caller comparing two loads
 * is comparing two real snapshots rather than two reads of different moments.
 */
export async function loadRecordStoreState(
  store: RecordStore<CanonicalRecordV2>,
): Promise<RecordStoreStateLoad> {
  const observations = await store.list();
  const projection = projectRecordState(observations);

  return {
    state: projection.state,
    origin: 'record-store',
    revisions: projection.report.revisions,
    report: projection.report,
  };
}
