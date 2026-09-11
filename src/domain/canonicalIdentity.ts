import { CANONICAL_DOMAIN_SCHEMA_VERSION } from './canonicalDataOwnership.js';
import type { IdOrigin } from './records.js';

/**
 * Shared identity header for canonical-domain schema version 2.
 *
 * Complete persisted record shapes are defined by `canonicalRecordV2.ts`; this
 * header remains the common opaque-identity prefix for every record kind.
 */
export const CANONICAL_RECORD_SCHEMA_VERSION = CANONICAL_DOMAIN_SCHEMA_VERSION;

const OPAQUE_RECORD_ID_PATTERN = /^pxr_[0-9a-f]{32}$/;
declare const opaqueRecordIdBrand: unique symbol;

/**
 * Canonical record identity.
 *
 * The value deliberately encodes no record kind, name, source path or storage filename.
 * `pxr_` only identifies the value as a Proxima record id.
 */
export type OpaqueRecordId = string & {
  readonly [opaqueRecordIdBrand]: 'OpaqueRecordId';
};

export type CanonicalRecordKind =
  | 'task'
  | 'project'
  | 'event'
  | 'schema'
  | 'workflow-stage';

/**
 * Identity-bearing header shared by every future canonical record kind.
 *
 * Storage/source location is intentionally absent. A record is looked up by `id`, not
 * by whichever JSON filename or legacy file happened to contain it.
 */
export interface CanonicalRecordHeader<
  K extends CanonicalRecordKind = CanonicalRecordKind,
> {
  readonly schemaVersion: typeof CANONICAL_RECORD_SCHEMA_VERSION;
  readonly kind: K;
  readonly id: OpaqueRecordId;
  /**
   * Human-facing title/name. It is ordinary canonical data, never identity.
   *
   * Storage filenames and legacy Markdown/YAML syntax do not constrain this value.
   * Standard JSON encoding preserves it without filename or source-syntax normalization.
   */
  readonly name: string;
}

export type CanonicalTaskRecordHeader = CanonicalRecordHeader<'task'>;
export type CanonicalProjectRecordHeader = CanonicalRecordHeader<'project'>;
export type CanonicalEventRecordHeader = CanonicalRecordHeader<'event'>;
export type CanonicalSchemaRecordHeader = CanonicalRecordHeader<'schema'>;
export type CanonicalWorkflowStageRecordHeader =
  CanonicalRecordHeader<'workflow-stage'>;

export function parseOpaqueRecordId(value: string): OpaqueRecordId {
  if (!OPAQUE_RECORD_ID_PATTERN.test(value)) {
    throw new Error(`Invalid opaque Proxima record id: ${value}`);
  }
  return value as OpaqueRecordId;
}

/**
 * Formats exactly 128 random bits supplied by the allocation boundary.
 *
 * This function does not read names, source paths or filenames and does not itself
 * perform persistence or mutation.
 */
export function opaqueRecordIdFromRandomBytes(bytes: Uint8Array): OpaqueRecordId {
  if (bytes.length !== 16) {
    throw new Error('Opaque Proxima record ids need exactly 16 random bytes.');
  }

  const body = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return parseOpaqueRecordId(`pxr_${body}`);
}

export function defineCanonicalRecordHeader<K extends CanonicalRecordKind>(input: {
  kind: K;
  id: OpaqueRecordId;
  name: string;
}): CanonicalRecordHeader<K> {
  return {
    schemaVersion: CANONICAL_RECORD_SCHEMA_VERSION,
    kind: input.kind,
    id: input.id,
    name: input.name,
  };
}

/**
 * Read-only canonical lookup. Storage filenames are not an input to this index.
 */
export function indexCanonicalRecords<T extends CanonicalRecordHeader>(
  records: readonly T[],
): ReadonlyMap<OpaqueRecordId, T> {
  const byId = new Map<OpaqueRecordId, T>();

  for (const record of records) {
    if (byId.has(record.id)) {
      throw new Error(`Duplicate canonical record id: ${record.id}`);
    }
    byId.set(record.id, record);
  }

  return byId;
}

/**
 * A legacy id is retained only as provenance/alias information for import
 * reconciliation. It never supplies canonical identity.
 */
export interface LegacyIdentityAlias {
  readonly value: string;
  readonly origin: IdOrigin;
}

export interface LegacyImportProvenance {
  readonly sourcePath: string;
  readonly aliases: readonly LegacyIdentityAlias[];
}

export function defineLegacyImportProvenance(
  sourcePath: string,
  aliases: readonly LegacyIdentityAlias[],
): LegacyImportProvenance {
  if (sourcePath.length === 0) {
    throw new Error('Legacy import provenance requires a source path.');
  }
  if (aliases.some((alias) => alias.value.length === 0)) {
    throw new Error('Legacy identity aliases must not be empty.');
  }

  return {
    sourcePath,
    aliases: aliases.map((alias) => ({ ...alias })),
  };
}

export interface CanonicalImportIdentityAssignment<
  K extends CanonicalRecordKind = CanonicalRecordKind,
> {
  readonly record: CanonicalRecordHeader<K>;
  readonly provenance: LegacyImportProvenance;
}

/**
 * Keeps a canonical identity beside, never derived from, its legacy provenance.
 *
 * Even a legacy explicit id that happens to have valid opaque-id syntax remains an
 * alias. Equality is refused so an importer cannot silently promote it.
 */
export function pairCanonicalWithLegacyProvenance<K extends CanonicalRecordKind>(
  record: CanonicalRecordHeader<K>,
  provenance: LegacyImportProvenance,
): CanonicalImportIdentityAssignment<K> {
  if (provenance.aliases.some((alias) => alias.value === record.id)) {
    throw new Error(
      'Legacy identity aliases are provenance only and must not equal the canonical record id.',
    );
  }

  return { record, provenance };
}
