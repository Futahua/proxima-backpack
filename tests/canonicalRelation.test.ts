import { describe, expect, it } from 'vitest';
import {
  defineCanonicalRecordHeader,
  defineLegacyImportProvenance,
  opaqueRecordIdFromRandomBytes,
  pairCanonicalWithLegacyProvenance,
  type CanonicalRecordHeader,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  defineCanonicalRelationValue,
  resolveCanonicalRelationTargets,
} from '../src/domain/canonicalRelation.js';
import {
  defineCanonicalPropertySchema,
  type CanonicalPropertySchemaRecord,
  type CanonicalRelatableRecordKind,
} from '../src/domain/canonicalSchema.js';

function recordId(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

function relationSchema(
  id: OpaqueRecordId,
  targetKinds: readonly CanonicalRelatableRecordKind[],
): CanonicalPropertySchemaRecord {
  return defineCanonicalPropertySchema({
    header: defineCanonicalRecordHeader({
      kind: 'schema',
      id,
      name: 'Related records',
    }),
    definition: { type: 'relation', targetKinds },
  });
}

function record(
  kind: CanonicalRelatableRecordKind,
  id: OpaqueRecordId,
  name: string,
): CanonicalRecordHeader<CanonicalRelatableRecordKind> {
  return defineCanonicalRecordHeader({ kind, id, name });
}

describe('HARD GATE A / A6 canonical ID-based relations', () => {
  it('stores only canonical schema and target record ids as relation semantics', () => {
    const schema = relationSchema(recordId(1), ['task', 'project']);
    const targetId = recordId(2);
    const value = defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: [targetId] });
    expect(value).toEqual({ relationSchemaId: schema.id, targetRecordIds: [targetId] });
    expect(value).not.toHaveProperty('wikilink');
    expect(value).not.toHaveProperty('targetFilename');
    expect(value).not.toHaveProperty('targetFolder');
    expect(value).not.toHaveProperty('targetName');
    expect(schema.definition.type).toBe('relation');
    if (schema.definition.type !== 'relation') throw new Error('relation fixture changed type');
    expect(schema.definition).toEqual({ type: 'relation', targetKinds: ['task', 'project'] });
    expect(schema.definition).not.toHaveProperty('targetFolder');
  });

  it('resolves relation targets only through canonical opaque record identity', () => {
    const schema = relationSchema(recordId(3), ['task', 'project']);
    const task = record('task', recordId(4), 'Human task title');
    const project = record('project', recordId(5), 'Human project title');
    const value = defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: [task.id, project.id] });
    expect(resolveCanonicalRelationTargets(value, schema, [project, task])).toEqual([task, project]);
  });

  it('survives human-facing target rename because the relation contains no title', () => {
    const schema = relationSchema(recordId(6), ['task']);
    const original = record('task', recordId(7), 'Original human title');
    const renamed = { ...original, name: 'Completely renamed human title' };
    const value = defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: [original.id] });
    expect(value.targetRecordIds).toEqual([original.id]);
    expect(resolveCanonicalRelationTargets(value, schema, [renamed])).toEqual([renamed]);
    expect(renamed.id).toBe(original.id);
  });

  it('survives movement of a legacy human-facing representation', () => {
    const schema = relationSchema(recordId(8), ['task']);
    const target = record('task', recordId(9), 'Move me');
    const value = defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: [target.id] });
    const beforeMove = pairCanonicalWithLegacyProvenance(target, defineLegacyImportProvenance('Proxima/tasks/Old human file.md', [{ value: 'legacy-task-explicit-id', origin: 'frontmatter' }]));
    const afterMove = pairCanonicalWithLegacyProvenance(target, defineLegacyImportProvenance('Archive/renamed-folder/New human file.md', [{ value: 'legacy-task-explicit-id', origin: 'frontmatter' }]));
    expect(beforeMove.provenance.sourcePath).not.toBe(afterMove.provenance.sourcePath);
    expect(beforeMove.record.id).toBe(afterMove.record.id);
    expect(value.targetRecordIds).toEqual([target.id]);
    expect(resolveCanonicalRelationTargets(value, schema, [afterMove.record])[0]?.id).toBe(target.id);
  });

  it('refuses wikilink or filename text at the canonical relation-value boundary', () => {
    const schema = relationSchema(recordId(10), ['task']);
    expect(() => defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: ['[[Human Task]]' as OpaqueRecordId] })).toThrow(/Invalid opaque Proxima record id/);
    expect(() => defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: ['Human Task.md' as OpaqueRecordId] })).toThrow(/Invalid opaque Proxima record id/);
  });

  it('refuses unresolved or schema-disallowed target identities', () => {
    const schema = relationSchema(recordId(11), ['task']);
    const missingId = recordId(12);
    const project = record('project', recordId(13), 'Wrong kind');
    expect(() => resolveCanonicalRelationTargets(defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: [missingId] }), schema, [])).toThrow(`Canonical relation target does not exist: ${missingId}`);
    expect(() => resolveCanonicalRelationTargets(defineCanonicalRelationValue({ relationSchemaId: schema.id, targetRecordIds: [project.id] }), schema, [project])).toThrow('Canonical relation target kind is not permitted: project');
  });
});
