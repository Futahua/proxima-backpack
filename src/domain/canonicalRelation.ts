import {
  parseOpaqueRecordId,
  type CanonicalRecordHeader,
  type OpaqueRecordId,
} from './canonicalIdentity.js';
import type {
  CanonicalPropertySchemaRecord,
  CanonicalRelatableRecordKind,
} from './canonicalSchema.js';

/**
 * Canonical relation value.
 *
 * A relation stores only stable canonical identity:
 * - the canonical relation-schema record id;
 * - canonical target record ids.
 *
 * Human names, Markdown links, filenames and source paths are deliberately absent.
 */
export interface CanonicalRelationValue {
  readonly relationSchemaId: OpaqueRecordId;
  readonly targetRecordIds: readonly OpaqueRecordId[];
}

export type CanonicalRelationTargetRecord =
  CanonicalRecordHeader<CanonicalRelatableRecordKind>;

function isCanonicalRelationTargetRecord(
  record: CanonicalRecordHeader,
): record is CanonicalRelationTargetRecord {
  return record.kind === 'task'
    || record.kind === 'project'
    || record.kind === 'event';
}

/** Runtime boundary for canonical relation values. */
export function defineCanonicalRelationValue(input: {
  relationSchemaId: OpaqueRecordId;
  targetRecordIds: readonly OpaqueRecordId[];
}): CanonicalRelationValue {
  const relationSchemaId = parseOpaqueRecordId(input.relationSchemaId);
  const seen = new Set<OpaqueRecordId>();
  const targetRecordIds = input.targetRecordIds.map((targetRecordId) => {
    const checked = parseOpaqueRecordId(targetRecordId);
    if (seen.has(checked)) {
      throw new Error(`Duplicate canonical relation target id: ${checked}`);
    }
    seen.add(checked);
    return checked;
  });

  return { relationSchemaId, targetRecordIds };
}

/** Read-only canonical relation resolution by opaque record identity. */
export function resolveCanonicalRelationTargets(
  value: CanonicalRelationValue,
  relationSchema: CanonicalPropertySchemaRecord,
  records: readonly CanonicalRecordHeader[],
): CanonicalRelationTargetRecord[] {
  if (relationSchema.id !== value.relationSchemaId) {
    throw new Error(
      `Canonical relation value references another schema: ${value.relationSchemaId}`,
    );
  }
  if (relationSchema.definition.type !== 'relation') {
    throw new Error(`Canonical schema is not a relation: ${relationSchema.id}`);
  }

  const allowedKinds = new Set<CanonicalRelatableRecordKind>(
    relationSchema.definition.targetKinds,
  );
  const byId = new Map<OpaqueRecordId, CanonicalRecordHeader>(
    records.map((record) => [record.id, record]),
  );

  return value.targetRecordIds.map((targetRecordId) => {
    const target = byId.get(targetRecordId);
    if (!target) {
      throw new Error(`Canonical relation target does not exist: ${targetRecordId}`);
    }
    if (!isCanonicalRelationTargetRecord(target) || !allowedKinds.has(target.kind)) {
      throw new Error(`Canonical relation target kind is not permitted: ${target.kind}`);
    }
    return target;
  });
}
