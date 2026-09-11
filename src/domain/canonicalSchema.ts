import type {
  CanonicalRecordHeader,
  CanonicalRecordKind,
  OpaqueRecordId,
} from './canonicalIdentity.js';

const OPAQUE_SCHEMA_OPTION_ID_PATTERN = /^pxo_[0-9a-f]{32}$/;
declare const opaqueSchemaOptionIdBrand: unique symbol;

/**
 * Stable identity for an option inside canonical select/multi-select schema data.
 *
 * The label is deliberately not part of this value, so renaming an option cannot
 * change references to that option.
 */
export type OpaqueSchemaOptionId = string & {
  readonly [opaqueSchemaOptionIdBrand]: 'OpaqueSchemaOptionId';
};

export function parseOpaqueSchemaOptionId(value: string): OpaqueSchemaOptionId {
  if (!OPAQUE_SCHEMA_OPTION_ID_PATTERN.test(value)) {
    throw new Error(`Invalid opaque Proxima schema-option id: ${value}`);
  }
  return value as OpaqueSchemaOptionId;
}

export function opaqueSchemaOptionIdFromRandomBytes(
  bytes: Uint8Array,
): OpaqueSchemaOptionId {
  if (bytes.length !== 16) {
    throw new Error('Opaque Proxima schema-option ids need exactly 16 random bytes.');
  }

  const body = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

  return parseOpaqueSchemaOptionId(`pxo_${body}`);
}

export interface CanonicalSelectOption {
  readonly id: OpaqueSchemaOptionId;
  readonly label: string;
}

export type CanonicalRelatableRecordKind = Extract<
  CanonicalRecordKind,
  'task' | 'project' | 'event'
>;

export type CanonicalRollupAggregation =
  | 'sum'
  | 'average'
  | 'count'
  | 'unique'
  | 'min'
  | 'max';

export type CanonicalPropertyDefinition =
  | { readonly type: 'text' }
  | { readonly type: 'number' }
  | { readonly type: 'date' }
  | { readonly type: 'checkbox' }
  | { readonly type: 'select'; readonly options: readonly CanonicalSelectOption[] }
  | { readonly type: 'multi-select'; readonly options: readonly CanonicalSelectOption[] }
  | { readonly type: 'relation'; readonly targetKinds: readonly CanonicalRelatableRecordKind[] }
  | {
      readonly type: 'rollup';
      readonly relationSchemaId: OpaqueRecordId;
      readonly targetSchemaId: OpaqueRecordId;
      readonly aggregation: CanonicalRollupAggregation;
    }
  | { readonly type: 'formula'; readonly expression: string };

/**
 * Future canonical property-schema record.
 *
 * The complete semantic property definition lives with a normal canonical Proxima
 * record. Backpack-local presentation/settings state is not part of this record.
 */
export interface CanonicalPropertySchemaRecord
  extends CanonicalRecordHeader<'schema'> {
  readonly definition: CanonicalPropertyDefinition;
}

function copyOptions(
  options: readonly CanonicalSelectOption[],
): CanonicalSelectOption[] {
  const seen = new Set<OpaqueSchemaOptionId>();

  return options.map((option) => {
    if (seen.has(option.id)) {
      throw new Error(`Duplicate canonical schema-option id: ${option.id}`);
    }
    seen.add(option.id);
    return {
      id: option.id,
      label: option.label,
    };
  });
}

function copyDefinition(
  definition: CanonicalPropertyDefinition,
): CanonicalPropertyDefinition {
  switch (definition.type) {
    case 'select':
    case 'multi-select':
      return {
        type: definition.type,
        options: copyOptions(definition.options),
      };
    case 'relation':
      if (definition.targetKinds.length === 0) {
        throw new Error('Canonical relation schema needs at least one target record kind.');
      }
      return {
        type: 'relation',
        targetKinds: [...definition.targetKinds],
      };
    case 'rollup':
      return {
        type: 'rollup',
        relationSchemaId: definition.relationSchemaId,
        targetSchemaId: definition.targetSchemaId,
        aggregation: definition.aggregation,
      };
    case 'formula':
      if (definition.expression.trim() === '') {
        throw new Error('Canonical formula schema needs a non-empty expression.');
      }
      return {
        type: 'formula',
        expression: definition.expression,
      };
    default:
      return { type: definition.type };
  }
}

export function defineCanonicalPropertySchema(input: {
  header: CanonicalRecordHeader<'schema'>;
  definition: CanonicalPropertyDefinition;
}): CanonicalPropertySchemaRecord {
  return {
    ...input.header,
    definition: copyDefinition(input.definition),
  };
}

/**
 * A5 classification boundary. These values may exist in disposable Backpack-local
 * presentation state, but they are not canonical schema data.
 */
export const SCHEMA_PRESENTATION_STATE_CATEGORY = 'local-state' as const;

export interface SchemaPresentationState {
  readonly columnWidthBySchemaId: Readonly<Record<string, number>>;
  readonly collapsedSchemaIds: readonly OpaqueRecordId[];
  readonly optionColors: readonly {
    readonly schemaId: OpaqueRecordId;
    readonly optionId: OpaqueSchemaOptionId;
    readonly color: string;
  }[];
}
