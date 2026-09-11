import { describe, expect, it } from 'vitest';
import {
  defineCanonicalRecordHeader,
  indexCanonicalRecords,
  opaqueRecordIdFromRandomBytes,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  SCHEMA_PRESENTATION_STATE_CATEGORY,
  defineCanonicalPropertySchema,
  opaqueSchemaOptionIdFromRandomBytes,
  type CanonicalPropertySchemaRecord,
  type SchemaPresentationState,
} from '../src/domain/canonicalSchema.js';

function recordId(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

function optionId(value: number) {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueSchemaOptionIdFromRandomBytes(bytes);
}

function schema(
  id: OpaqueRecordId,
  name: string,
  definition: CanonicalPropertySchemaRecord['definition'],
): CanonicalPropertySchemaRecord {
  return defineCanonicalPropertySchema({
    header: defineCanonicalRecordHeader({
      kind: 'schema',
      id,
      name,
    }),
    definition,
  });
}

describe('HARD GATE A / A5 canonical schema data', () => {
  it('represents a property schema as a normal opaque-id canonical Proxima record', () => {
    const property = schema(recordId(1), 'Priority', { type: 'text' });
    const indexed = indexCanonicalRecords([property]);

    expect(property.kind).toBe('schema');
    expect(indexed.get(property.id)).toBe(property);
    expect(property).not.toHaveProperty('sourcePath');
    expect(property).not.toHaveProperty('targetFolder');
  });

  it('keeps schema identity stable when its display name changes', () => {
    const original = schema(recordId(2), 'Priority', { type: 'number' });
    const renamed: CanonicalPropertySchemaRecord = {
      ...original,
      name: 'Importance',
    };

    expect(renamed.id).toBe(original.id);
    expect(renamed.name).not.toBe(original.name);
  });

  it('keeps select-option identity stable and separate from its label', () => {
    const stableOptionId = optionId(1);
    const original = schema(recordId(3), 'State', {
      type: 'select',
      options: [{ id: stableOptionId, label: 'Waiting' }],
    });
    const renamed = schema(original.id, original.name, {
      type: 'select',
      options: [{ id: stableOptionId, label: 'Ready later' }],
    });

    expect(original.definition.type).toBe('select');
    expect(renamed.definition.type).toBe('select');
    if (original.definition.type !== 'select' || renamed.definition.type !== 'select') {
      throw new Error('select fixture changed type');
    }
    expect(renamed.definition.options[0]?.id).toBe(original.definition.options[0]?.id);
    expect(renamed.definition.options[0]?.label).not.toBe(original.definition.options[0]?.label);
  });

  it('stores formula definitions inside canonical schema data', () => {
    const formula = schema(recordId(4), 'Weighted score', {
      type: 'formula',
      expression: 'priority * weight',
    });
    expect(formula.definition).toEqual({ type: 'formula', expression: 'priority * weight' });
  });

  it('stores rollup definitions by stable schema ids inside canonical data', () => {
    const relationSchemaId = recordId(5);
    const targetSchemaId = recordId(6);
    const rollup = schema(recordId(7), 'Total effort', {
      type: 'rollup',
      relationSchemaId,
      targetSchemaId,
      aggregation: 'sum',
    });
    expect(rollup.definition).toEqual({ relationSchemaId, targetSchemaId, aggregation: 'sum', type: 'rollup' });
  });

  it('stores relation definition semantics without a filesystem target', () => {
    const relation = schema(recordId(8), 'Related work', {
      type: 'relation',
      targetKinds: ['task', 'project', 'event'],
    });
    expect(relation.definition).toEqual({ type: 'relation', targetKinds: ['task', 'project', 'event'] });
    expect(relation.definition).not.toHaveProperty('targetFolder');
  });

  it('keeps colors, widths and collapsed presentation state outside canonical schema records', () => {
    const property = schema(recordId(9), 'Status', {
      type: 'select',
      options: [{ id: optionId(2), label: 'Active' }],
    });
    const presentation: SchemaPresentationState = {
      columnWidthBySchemaId: { [property.id]: 240 },
      collapsedSchemaIds: [property.id],
      optionColors: [{ schemaId: property.id, optionId: optionId(2), color: '#00b894' }],
    };

    expect(SCHEMA_PRESENTATION_STATE_CATEGORY).toBe('local-state');
    expect(presentation.columnWidthBySchemaId[property.id]).toBe(240);
    expect(property).not.toHaveProperty('columnWidth');
    expect(property).not.toHaveProperty('collapsed');
    expect(property).not.toHaveProperty('color');
    if (property.definition.type !== 'select') throw new Error('select fixture changed type');
    expect(property.definition.options[0]).not.toHaveProperty('color');
  });
});
