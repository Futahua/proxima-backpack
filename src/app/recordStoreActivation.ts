/**
 * What makes a record store canonical.
 *
 * Stage 8 fills an isolated staging store. HARD GATE C then needs a durable, checkable answer
 * to "has that store been activated?" — because without one, the only available rule would be
 * "the store holds records, so trust it", and a staging store holds records too. That rule is
 * exactly the failure the gate's own note describes: two apparent truths, and an accepted
 * action that appears to revert.
 *
 * So activation is an act with a marker, and the marker says enough to be refused:
 *
 * - **when** it happened, from an injected instant rather than a clock read;
 * - **which import** the activated records came from, so a marker cannot be adopted by a
 *   different import later;
 * - **how many** records of each kind were activated, so "the store is not what was
 *   activated" is visible rather than imagined.
 *
 * The marker is stored as text through a one-method seam and validated on read: this file
 * never trusts parsed JSON because TypeScript says it is a marker.
 */
import type { CanonicalRecordKind } from '../domain/canonicalIdentity.js';
import type { CanonicalRecordV2 } from '../domain/canonicalRecordV2.js';
import type { RecordStore } from '../ports/recordStore.js';

export const RECORD_STORE_ACTIVATION_SCHEMA_VERSION = 1 as const;

export interface RecordStoreActivationMarker {
  readonly schemaVersion: typeof RECORD_STORE_ACTIVATION_SCHEMA_VERSION;
  /** Injected instant: nothing here reads a clock. */
  readonly activatedAt: string;
  /** The import identity the activated records came from. */
  readonly sourceImport: string;
  readonly counts: Readonly<Record<CanonicalRecordKind, number>>;
}

/**
 * Where the marker lives.
 *
 * Text in, text out: the same shape as the recovery-journal seam, so a caller that owns a
 * directory can supply it and this module owns the meaning.
 */
export interface RecordStoreActivationStorage {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

export type RecordStoreActivationStatus = 'absent' | 'invalid' | 'present';

export interface RecordStoreActivationState {
  readonly status: RecordStoreActivationStatus;
  readonly marker: RecordStoreActivationMarker | null;
  /** Why a marker was refused, when it was. Empty for `absent` and `present`. */
  readonly detail: string;
}

const RECORD_KINDS: readonly CanonicalRecordKind[] = [
  'task',
  'project',
  'event',
  'schema',
  'workflow-stage',
];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate a marker, or refuse it. There is no partial acceptance. */
export function parseRecordStoreActivationMarker(value: unknown): RecordStoreActivationMarker | null {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  const candidate = record(parsed);
  if (candidate === null) return null;
  if (candidate.schemaVersion !== RECORD_STORE_ACTIVATION_SCHEMA_VERSION) return null;
  if (typeof candidate.activatedAt !== 'string' || candidate.activatedAt.length === 0) return null;
  if (typeof candidate.sourceImport !== 'string' || candidate.sourceImport.length === 0) return null;
  const counts = record(candidate.counts);
  if (counts === null) return null;

  const normalised: Record<CanonicalRecordKind, number> = {
    task: 0,
    project: 0,
    event: 0,
    schema: 0,
    'workflow-stage': 0,
  };
  for (const kind of RECORD_KINDS) {
    const count = counts[kind];
    if (count === undefined) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
    normalised[kind] = count;
  }

  return {
    schemaVersion: RECORD_STORE_ACTIVATION_SCHEMA_VERSION,
    activatedAt: candidate.activatedAt,
    sourceImport: candidate.sourceImport,
    counts: normalised,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read and validate the marker. An unreadable storage is `invalid`, not `absent`. */
export async function readRecordStoreActivation(
  storage: RecordStoreActivationStorage,
): Promise<RecordStoreActivationState> {
  let text: string | undefined;
  try {
    text = await storage.read();
  } catch (error) {
    return {
      status: 'invalid',
      marker: null,
      detail: `activation storage could not be read: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
    };
  }
  if (text === undefined || text.trim().length === 0) {
    return { status: 'absent', marker: null, detail: '' };
  }
  const marker = parseRecordStoreActivationMarker(text);
  if (marker === null) {
    return {
      status: 'invalid',
      marker: null,
      detail: 'activation marker is not a marker this build understands',
    };
  }
  return { status: 'present', marker, detail: '' };
}

export type RecordStoreActivationResult =
  | {
      readonly ok: true;
      readonly outcome: 'activated' | 'already-activated';
      readonly marker: RecordStoreActivationMarker;
    }
  | {
      readonly ok: false;
      readonly reason: 'store-empty' | 'different-import' | 'unreadable-marker';
      readonly detail: string;
    };

/**
 * Make the store canonical, or refuse and say why.
 *
 * Refusals are the point of the function: an empty store is not activated (there is nothing
 * to be canonical about), a marker that cannot be read is not overwritten (that would hide
 * whatever wrote it), and a store activated by a different import is not stolen.
 */
export async function activateRecordStore(input: {
  store: RecordStore<CanonicalRecordV2>;
  storage: RecordStoreActivationStorage;
  activatedAt: string;
  sourceImport: string;
}): Promise<RecordStoreActivationResult> {
  const existing = await readRecordStoreActivation(input.storage);
  if (existing.status === 'invalid') {
    return { ok: false, reason: 'unreadable-marker', detail: existing.detail };
  }
  if (existing.marker !== null && existing.marker.sourceImport !== input.sourceImport) {
    return {
      ok: false,
      reason: 'different-import',
      detail: `store was activated by ${existing.marker.sourceImport}`,
    };
  }

  const observations = await input.store.list();
  if (observations.length === 0) {
    return { ok: false, reason: 'store-empty', detail: 'no records to activate' };
  }

  if (existing.marker !== null) {
    return { ok: true, outcome: 'already-activated', marker: existing.marker };
  }

  const counts: Record<CanonicalRecordKind, number> = {
    task: 0,
    project: 0,
    event: 0,
    schema: 0,
    'workflow-stage': 0,
  };
  for (const observation of observations) counts[observation.kind] += 1;

  const marker: RecordStoreActivationMarker = {
    schemaVersion: RECORD_STORE_ACTIVATION_SCHEMA_VERSION,
    activatedAt: input.activatedAt,
    sourceImport: input.sourceImport,
    counts,
  };
  await input.storage.write(JSON.stringify(marker));
  return { ok: true, outcome: 'activated', marker };
}
