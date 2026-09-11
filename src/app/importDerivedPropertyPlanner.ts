import {
  defineCanonicalRecordHeader,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import type {
  CanonicalStoredPropertyValue,
} from '../domain/canonicalRecordV2.js';
import {
  defineCanonicalPropertySchema,
  type CanonicalPropertySchemaRecord,
  type CanonicalRelatableRecordKind,
  type CanonicalRollupAggregation,
} from '../domain/canonicalSchema.js';
import type { PropertySchema } from '../domain/types.js';
import type {
  LegacyImportPropertyValueConversion,
  LegacyImportPropertyValuePlan,
  LegacyImportRecordPropertyValuePlan,
} from './importPropertyPlanner.js';
import type {
  LegacyInterpretedPropertySchemaSettingsSnapshot,
  LegacyImportSchemaConversionPlan,
  LegacyImportSchemaScope,
  LegacyImportSchemaSettingsPlan,
} from './importSchemaPlanner.js';

export const LEGACY_IMPORT_DERIVED_PROPERTY_PLAN_SCHEMA_VERSION = 1 as const;

export type LegacyImportRollupSchemaUnresolvedReason =
  | 'legacy-rollup-aggregation-missing'
  | 'legacy-rollup-relation-reference-missing'
  | 'legacy-rollup-relation-reference-ambiguous'
  | 'legacy-rollup-relation-reference-incompatible'
  | 'legacy-rollup-relation-reference-pending'
  | 'legacy-rollup-target-scope-incompatible'
  | 'legacy-rollup-target-reference-missing'
  | 'legacy-rollup-target-reference-ambiguous'
  | 'legacy-rollup-target-reference-incompatible'
  | 'legacy-rollup-target-reference-pending';

interface LegacyImportDerivedSchemaBase {
  readonly scope: LegacyImportSchemaScope;
  readonly legacySchemaId: string;
  readonly schemaRecordId: OpaqueRecordId;
  readonly name: string;
}

export type LegacyImportRollupSchemaPlan =
  | (LegacyImportDerivedSchemaBase & {
      readonly disposition: 'canonical-ready';
      readonly legacyRelationProperty: string;
      readonly legacyTargetProperty: string;
      readonly record: CanonicalPropertySchemaRecord;
    })
  | (LegacyImportDerivedSchemaBase & {
      readonly disposition: 'unresolved';
      readonly reason: LegacyImportRollupSchemaUnresolvedReason;
      readonly legacyRelationProperty: string | null;
      readonly legacyTargetProperty: string | null;
      readonly aggregation: CanonicalRollupAggregation | null;
      readonly candidateSchemaRecordIds?: readonly OpaqueRecordId[];
      readonly relationSchemaId?: OpaqueRecordId;
      readonly relationTargetKinds?: readonly CanonicalRelatableRecordKind[];
    });

interface LegacyImportFormulaScopeBindingBase {
  readonly ordinal: number;
  readonly legacySchemaId: string;
  readonly schemaRecordId: OpaqueRecordId;
  readonly name: string;
}

export type LegacyImportFormulaScopeBinding =
  | (LegacyImportFormulaScopeBindingBase & {
      readonly availability: 'available';
      readonly source: 'canonical-stored';
      readonly canonicalValue: CanonicalStoredPropertyValue;
    })
  | (LegacyImportFormulaScopeBindingBase & {
      readonly availability: 'available';
      readonly source: 'derived-rollup';
      readonly value: number;
    })
  | (LegacyImportFormulaScopeBindingBase & {
      readonly availability: 'unavailable';
    });

interface LegacyImportDerivedValueBase {
  readonly scope: LegacyImportSchemaScope;
  readonly legacySchemaId: string;
  readonly schemaRecordId: OpaqueRecordId;
  readonly legacyStoredValuePresent: boolean;
  readonly legacyStoredValue: unknown;
  readonly legacyStoredValueAuthority: 'evidence-only-not-authority';
}

export type LegacyImportDerivedValueConversion =
  | (LegacyImportDerivedValueBase & {
      readonly legacyType: 'rollup';
      readonly disposition: 'derived-ready';
      readonly relationSchemaId: OpaqueRecordId;
      readonly targetSchemaId: OpaqueRecordId;
      readonly targetRecordIds: readonly OpaqueRecordId[];
      readonly aggregation: CanonicalRollupAggregation;
      readonly value: number;
    })
  | (LegacyImportDerivedValueBase & {
      readonly legacyType: 'rollup';
      readonly disposition: 'unresolved';
      readonly reason:
        | 'rollup-schema-unresolved'
        | 'rollup-relation-value-unavailable'
        | 'rollup-target-record-unavailable'
        | 'rollup-target-scope-mismatch'
        | 'rollup-target-value-unavailable'
        | 'rollup-target-value-incompatible';
      readonly schemaReason?: LegacyImportRollupSchemaUnresolvedReason;
      readonly relationSchemaId?: OpaqueRecordId;
      readonly targetSchemaId?: OpaqueRecordId;
      readonly targetRecordIds?: readonly OpaqueRecordId[];
      readonly incompatibleTargetRecordIds?: readonly OpaqueRecordId[];
    })
  | (LegacyImportDerivedValueBase & {
      readonly legacyType: 'formula';
      readonly disposition: 'evaluation-planned';
      readonly expression: string;
      readonly evaluator: 'expr-eval';
      readonly execution: 'not-run-in-slice-7';
      readonly propLookup: 'first-schema-name-or-id-match';
      readonly directVariableBinding: 'schema-name-in-schema-order-last-write-wins';
      readonly schemaOrdinal: number;
      readonly priorFormulaSchemaIds: readonly OpaqueRecordId[];
      readonly bindings: readonly LegacyImportFormulaScopeBinding[];
    })
  | (LegacyImportDerivedValueBase & {
      readonly legacyType: 'formula';
      readonly disposition: 'unresolved';
      readonly reason: 'formula-schema-pending';
    });

export interface LegacyImportDerivedRecordPlan {
  readonly recordId: OpaqueRecordId;
  readonly sourcePath: string;
  readonly scope: LegacyImportSchemaScope;
  readonly conversions: readonly LegacyImportDerivedValueConversion[];
  readonly derivedRollupValues: Readonly<Record<string, number>>;
}

export interface LegacyImportDerivedPropertyPlan {
  readonly schemaVersion: typeof LEGACY_IMPORT_DERIVED_PROPERTY_PLAN_SCHEMA_VERSION;
  readonly mode: 'dry-run';
  readonly source: 'canonical-schema-and-property-import-plans';
  readonly rollupSchemas: readonly LegacyImportRollupSchemaPlan[];
  readonly records: readonly LegacyImportDerivedRecordPlan[];
  readonly counts: {
    readonly rollupSchemas: number;
    readonly canonicalReadyRollupSchemas: number;
    readonly unresolvedRollupSchemas: number;
    readonly taskRecords: number;
    readonly derivedRollupValues: number;
    readonly unresolvedRollupValues: number;
    readonly plannedFormulaEvaluations: number;
    readonly unresolvedFormulaEvaluations: number;
  };
  readonly writes: {
    readonly legacyMarkdown: 0;
    readonly recordStore: 0;
    readonly staging: 0;
  };
}

export interface LegacyImportDerivedPropertyPlanningInput {
  readonly snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot;
  readonly schemaSettings: LegacyImportSchemaSettingsPlan;
  readonly propertyValues: LegacyImportPropertyValuePlan;
}

interface LegacySchemaCandidate {
  readonly scope: LegacyImportSchemaScope;
  readonly schema: PropertySchema;
}

interface ResolvedLegacyPropertyReference {
  readonly resolution: 'resolved';
  readonly schema: PropertySchema;
  readonly schemaRecordId: OpaqueRecordId;
}

interface UnresolvedLegacyPropertyReference {
  readonly resolution: 'missing' | 'ambiguous';
  readonly candidateSchemaRecordIds: readonly OpaqueRecordId[];
}

type LegacyPropertyReferenceResolution =
  | ResolvedLegacyPropertyReference
  | UnresolvedLegacyPropertyReference;

function cloneScope(scope: LegacyImportSchemaScope): LegacyImportSchemaScope {
  return scope.kind === 'task-schema'
    ? { kind: 'task-schema' }
    : {
        kind: 'project-schema',
        legacyProjectId: scope.legacyProjectId,
      };
}

function sameScope(
  left: LegacyImportSchemaScope,
  right: LegacyImportSchemaScope,
): boolean {
  return left.kind === right.kind
    && (
      left.kind === 'task-schema'
      || (
        right.kind === 'project-schema'
        && left.legacyProjectId === right.legacyProjectId
      )
    );
}

function schemaIdentityKey(
  scope: LegacyImportSchemaScope,
  legacySchemaId: string,
): string {
  return JSON.stringify([
    scope.kind,
    scope.kind === 'project-schema'
      ? scope.legacyProjectId
      : null,
    legacySchemaId,
  ]);
}

function schemaCandidates(
  snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot,
): LegacySchemaCandidate[] {
  const candidates: LegacySchemaCandidate[] = snapshot.taskSchema.map((schema) => ({
    scope: { kind: 'task-schema' },
    schema,
  }));

  for (const legacyProjectId of Object.keys(snapshot.projectSchemas).sort()) {
    for (const schema of snapshot.projectSchemas[legacyProjectId] ?? []) {
      candidates.push({
        scope: {
          kind: 'project-schema',
          legacyProjectId,
        },
        schema,
      });
    }
  }

  return candidates;
}

function schemasForScope(
  snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot,
  scope: LegacyImportSchemaScope,
): readonly PropertySchema[] {
  return scope.kind === 'task-schema'
    ? snapshot.taskSchema
    : snapshot.projectSchemas[scope.legacyProjectId] ?? [];
}

function schemaRecordIdFor(
  schemaIds: ReadonlyMap<string, OpaqueRecordId>,
  scope: LegacyImportSchemaScope,
  legacySchemaId: string,
): OpaqueRecordId {
  const key = schemaIdentityKey(scope, legacySchemaId);
  const recordId = schemaIds.get(key);
  if (recordId === undefined) {
    throw new Error(
      `Derived-property planner cannot find canonical schema identity for ${key}.`,
    );
  }
  return recordId;
}

function schemaConversionFor(
  conversions: ReadonlyMap<string, LegacyImportSchemaConversionPlan>,
  scope: LegacyImportSchemaScope,
  legacySchemaId: string,
): LegacyImportSchemaConversionPlan {
  const key = schemaIdentityKey(scope, legacySchemaId);
  const conversion = conversions.get(key);
  if (conversion === undefined) {
    throw new Error(
      `Derived-property planner cannot find schema conversion for ${key}.`,
    );
  }
  return conversion;
}

function resolveLegacyPropertyReference(
  reference: string | undefined,
  schemas: readonly PropertySchema[],
  scope: LegacyImportSchemaScope,
  schemaIds: ReadonlyMap<string, OpaqueRecordId>,
): LegacyPropertyReferenceResolution {
  if (reference === undefined || reference.trim() === '') {
    return {
      resolution: 'missing',
      candidateSchemaRecordIds: [],
    };
  }

  const idMatches = schemas.filter((schema) => schema.id === reference);
  const matches = idMatches.length > 0
    ? idMatches
    : schemas.filter((schema) => schema.name === reference);
  const candidateSchemaRecordIds = matches.map((schema) =>
    schemaRecordIdFor(schemaIds, scope, schema.id));

  if (matches.length === 0) {
    return {
      resolution: 'missing',
      candidateSchemaRecordIds,
    };
  }
  if (matches.length > 1) {
    return {
      resolution: 'ambiguous',
      candidateSchemaRecordIds,
    };
  }

  const schema = matches[0];
  if (schema === undefined) {
    throw new Error('Derived-property planner narrowed a schema reference inconsistently.');
  }
  return {
    resolution: 'resolved',
    schema,
    schemaRecordId: schemaRecordIdFor(schemaIds, scope, schema.id),
  };
}

function unresolvedRollupSchema(
  input: {
    scope: LegacyImportSchemaScope;
    schema: PropertySchema;
    schemaRecordId: OpaqueRecordId;
    reason: LegacyImportRollupSchemaUnresolvedReason;
    candidateSchemaRecordIds?: readonly OpaqueRecordId[];
    relationSchemaId?: OpaqueRecordId;
    relationTargetKinds?: readonly CanonicalRelatableRecordKind[];
  },
): LegacyImportRollupSchemaPlan {
  return {
    disposition: 'unresolved',
    scope: cloneScope(input.scope),
    legacySchemaId: input.schema.id,
    schemaRecordId: input.schemaRecordId,
    name: input.schema.name,
    reason: input.reason,
    legacyRelationProperty: input.schema.relationProperty ?? null,
    legacyTargetProperty: input.schema.targetProperty ?? null,
    aggregation: input.schema.aggregation ?? null,
    ...(input.candidateSchemaRecordIds === undefined
      ? {}
      : { candidateSchemaRecordIds: [...input.candidateSchemaRecordIds] }),
    ...(input.relationSchemaId === undefined
      ? {}
      : { relationSchemaId: input.relationSchemaId }),
    ...(input.relationTargetKinds === undefined
      ? {}
      : { relationTargetKinds: [...input.relationTargetKinds] }),
  };
}

function planRollupSchemas(
  input: LegacyImportDerivedPropertyPlanningInput,
  schemaIds: ReadonlyMap<string, OpaqueRecordId>,
  conversions: ReadonlyMap<string, LegacyImportSchemaConversionPlan>,
): LegacyImportRollupSchemaPlan[] {
  const plans: LegacyImportRollupSchemaPlan[] = [];

  for (const candidate of schemaCandidates(input.snapshot)) {
    const { scope, schema } = candidate;
    if (schema.type !== 'rollup') {
      continue;
    }
    const schemaRecordId = schemaRecordIdFor(schemaIds, scope, schema.id);
    const aggregation = schema.aggregation;

    if (aggregation === undefined) {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: 'legacy-rollup-aggregation-missing',
      }));
      continue;
    }

    const schemas = schemasForScope(input.snapshot, scope);
    const relationReference = resolveLegacyPropertyReference(
      schema.relationProperty,
      schemas,
      scope,
      schemaIds,
    );
    if (relationReference.resolution !== 'resolved') {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: relationReference.resolution === 'missing'
          ? 'legacy-rollup-relation-reference-missing'
          : 'legacy-rollup-relation-reference-ambiguous',
        candidateSchemaRecordIds: relationReference.candidateSchemaRecordIds,
      }));
      continue;
    }
    if (relationReference.schema.type !== 'relation') {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: 'legacy-rollup-relation-reference-incompatible',
        candidateSchemaRecordIds: [relationReference.schemaRecordId],
      }));
      continue;
    }

    const relationConversion = schemaConversionFor(
      conversions,
      scope,
      relationReference.schema.id,
    );
    if (relationConversion.disposition !== 'canonical-ready') {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: 'legacy-rollup-relation-reference-pending',
        relationSchemaId: relationReference.schemaRecordId,
      }));
      continue;
    }
    if (relationConversion.record.definition.type !== 'relation') {
      throw new Error(
        `Derived-property planner expected canonical relation schema ${relationReference.schemaRecordId}.`,
      );
    }
    const relationTargetKinds = relationConversion.record.definition.targetKinds;
    if (
      relationTargetKinds.length !== 1
      || relationTargetKinds[0] !== 'task'
    ) {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: 'legacy-rollup-target-scope-incompatible',
        relationSchemaId: relationReference.schemaRecordId,
        relationTargetKinds,
      }));
      continue;
    }

    const targetReference = resolveLegacyPropertyReference(
      schema.targetProperty,
      schemas,
      scope,
      schemaIds,
    );
    if (targetReference.resolution !== 'resolved') {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: targetReference.resolution === 'missing'
          ? 'legacy-rollup-target-reference-missing'
          : 'legacy-rollup-target-reference-ambiguous',
        candidateSchemaRecordIds: targetReference.candidateSchemaRecordIds,
        relationSchemaId: relationReference.schemaRecordId,
        relationTargetKinds,
      }));
      continue;
    }

    const targetConversion = schemaConversionFor(
      conversions,
      scope,
      targetReference.schema.id,
    );
    if (
      targetReference.schema.type === 'rollup'
      || targetReference.schema.type === 'formula'
      || targetConversion.disposition !== 'canonical-ready'
    ) {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: 'legacy-rollup-target-reference-pending',
        candidateSchemaRecordIds: [targetReference.schemaRecordId],
        relationSchemaId: relationReference.schemaRecordId,
        relationTargetKinds,
      }));
      continue;
    }
    if (
      aggregation !== 'count'
      && aggregation !== 'unique'
      && targetReference.schema.type !== 'number'
    ) {
      plans.push(unresolvedRollupSchema({
        scope,
        schema,
        schemaRecordId,
        reason: 'legacy-rollup-target-reference-incompatible',
        candidateSchemaRecordIds: [targetReference.schemaRecordId],
        relationSchemaId: relationReference.schemaRecordId,
        relationTargetKinds,
      }));
      continue;
    }

    plans.push({
      disposition: 'canonical-ready',
      scope: cloneScope(scope),
      legacySchemaId: schema.id,
      schemaRecordId,
      name: schema.name,
      legacyRelationProperty: schema.relationProperty ?? '',
      legacyTargetProperty: schema.targetProperty ?? '',
      record: defineCanonicalPropertySchema({
        header: defineCanonicalRecordHeader({
          kind: 'schema',
          id: schemaRecordId,
          name: schema.name,
        }),
        definition: {
          type: 'rollup',
          relationSchemaId: relationReference.schemaRecordId,
          targetSchemaId: targetReference.schemaRecordId,
          aggregation,
        },
      }),
    });
  }

  return plans;
}

function cloneLegacyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneLegacyValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneLegacyValue(entry)]),
    );
  }
  return value;
}

function legacyStoredEvidence(
  record: LegacyImportRecordPropertyValuePlan,
  legacySchemaId: string,
): {
  readonly legacyStoredValuePresent: boolean;
  readonly legacyStoredValue: unknown;
  readonly legacyStoredValueAuthority: 'evidence-only-not-authority';
} {
  const present = Object.prototype.hasOwnProperty.call(
    record.legacyPropertyValues,
    legacySchemaId,
  );
  return {
    legacyStoredValuePresent: present,
    legacyStoredValue: present
      ? cloneLegacyValue(record.legacyPropertyValues[legacySchemaId])
      : null,
    legacyStoredValueAuthority: 'evidence-only-not-authority',
  };
}

function canonicalValueKey(value: CanonicalStoredPropertyValue): string {
  return JSON.stringify(value);
}

function deriveNumericRollup(
  aggregation: Extract<CanonicalRollupAggregation, 'sum' | 'average' | 'min' | 'max'>,
  values: readonly CanonicalStoredPropertyValue[],
): number | null {
  if (values.some((value) => value.type !== 'number')) {
    return null;
  }
  const numbers = values.map((value) => {
    if (value.type !== 'number') {
      throw new Error('Derived-property planner narrowed numeric rollup input inconsistently.');
    }
    return value.value;
  });

  if (aggregation === 'sum') {
    return numbers.reduce((total, value) => total + value, 0);
  }
  if (aggregation === 'average') {
    return numbers.length === 0
      ? 0
      : numbers.reduce((total, value) => total + value, 0) / numbers.length;
  }
  if (aggregation === 'min') {
    return numbers.length === 0 ? 0 : Math.min(...numbers);
  }
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}

function rollupSchemaKey(
  scope: LegacyImportSchemaScope,
  legacySchemaId: string,
): string {
  return schemaIdentityKey(scope, legacySchemaId);
}

function propertyConversionFor(
  record: LegacyImportRecordPropertyValuePlan,
  schemaRecordId: OpaqueRecordId,
): LegacyImportPropertyValueConversion {
  const conversion = record.conversions.find(
    (candidate) => candidate.schemaRecordId === schemaRecordId,
  );
  if (conversion === undefined) {
    throw new Error(
      `Derived-property planner cannot find property conversion ${schemaRecordId} for ${record.sourcePath}.`,
    );
  }
  return conversion;
}

function deriveRecordRollups(
  record: LegacyImportRecordPropertyValuePlan,
  schemas: readonly PropertySchema[],
  schemaIds: ReadonlyMap<string, OpaqueRecordId>,
  rollupBySchema: ReadonlyMap<string, LegacyImportRollupSchemaPlan>,
  recordById: ReadonlyMap<OpaqueRecordId, LegacyImportRecordPropertyValuePlan>,
): {
  readonly conversions: LegacyImportDerivedValueConversion[];
  readonly derivedRollupValues: Record<string, number>;
} {
  if (record.schemaScope === null) {
    throw new Error(`Derived-property planner cannot derive untyped record ${record.sourcePath}.`);
  }
  const scope = record.schemaScope;
  const conversions: LegacyImportDerivedValueConversion[] = [];
  const derivedRollupValues: Record<string, number> = {};

  for (const schema of schemas) {
    if (schema.type !== 'rollup') {
      continue;
    }
    const schemaRecordId = schemaRecordIdFor(schemaIds, scope, schema.id);
    const evidence = legacyStoredEvidence(record, schema.id);
    const rollup = rollupBySchema.get(rollupSchemaKey(scope, schema.id));
    if (rollup === undefined) {
      throw new Error(
        `Derived-property planner cannot find rollup schema plan for ${schemaIdentityKey(scope, schema.id)}.`,
      );
    }
    if (rollup.disposition !== 'canonical-ready') {
      conversions.push({
        scope: cloneScope(scope),
        legacySchemaId: schema.id,
        schemaRecordId,
        legacyType: 'rollup',
        disposition: 'unresolved',
        reason: 'rollup-schema-unresolved',
        schemaReason: rollup.reason,
        ...evidence,
      });
      continue;
    }
    if (rollup.record.definition.type !== 'rollup') {
      throw new Error(`Derived-property planner expected rollup definition for ${schemaRecordId}.`);
    }

    const definition = rollup.record.definition;
    const relationConversion = propertyConversionFor(
      record,
      definition.relationSchemaId,
    );
    let targetRecordIds: OpaqueRecordId[];
    if (relationConversion.disposition === 'absent') {
      targetRecordIds = [];
    } else if (relationConversion.disposition === 'canonical-ready') {
      const relationValue = relationConversion.value;
      if (
        relationValue.type !== 'relation'
        || relationValue.value.relationSchemaId !== definition.relationSchemaId
      ) {
        throw new Error(
          `Derived-property planner received incompatible canonical relation value ${definition.relationSchemaId}.`,
        );
      }
      targetRecordIds = [...relationValue.value.targetRecordIds];
    } else {
      conversions.push({
        scope: cloneScope(scope),
        legacySchemaId: schema.id,
        schemaRecordId,
        legacyType: 'rollup',
        disposition: 'unresolved',
        reason: 'rollup-relation-value-unavailable',
        relationSchemaId: definition.relationSchemaId,
        targetSchemaId: definition.targetSchemaId,
        ...evidence,
      });
      continue;
    }

    const presentValues: Array<{
      readonly targetRecordId: OpaqueRecordId;
      readonly value: CanonicalStoredPropertyValue;
    }> = [];
    let failed = false;

    for (const targetRecordId of targetRecordIds) {
      const target = recordById.get(targetRecordId);
      if (target === undefined || target.kind !== 'task' || target.schemaScope === null) {
        conversions.push({
          scope: cloneScope(scope),
          legacySchemaId: schema.id,
          schemaRecordId,
          legacyType: 'rollup',
          disposition: 'unresolved',
          reason: 'rollup-target-record-unavailable',
          relationSchemaId: definition.relationSchemaId,
          targetSchemaId: definition.targetSchemaId,
          targetRecordIds,
          ...evidence,
        });
        failed = true;
        break;
      }
      if (!sameScope(target.schemaScope, scope)) {
        conversions.push({
          scope: cloneScope(scope),
          legacySchemaId: schema.id,
          schemaRecordId,
          legacyType: 'rollup',
          disposition: 'unresolved',
          reason: 'rollup-target-scope-mismatch',
          relationSchemaId: definition.relationSchemaId,
          targetSchemaId: definition.targetSchemaId,
          targetRecordIds,
          ...evidence,
        });
        failed = true;
        break;
      }
      const targetConversion = propertyConversionFor(
        target,
        definition.targetSchemaId,
      );
      if (targetConversion.disposition === 'absent') {
        continue;
      }
      if (targetConversion.disposition !== 'canonical-ready') {
        conversions.push({
          scope: cloneScope(scope),
          legacySchemaId: schema.id,
          schemaRecordId,
          legacyType: 'rollup',
          disposition: 'unresolved',
          reason: 'rollup-target-value-unavailable',
          relationSchemaId: definition.relationSchemaId,
          targetSchemaId: definition.targetSchemaId,
          targetRecordIds,
          incompatibleTargetRecordIds: [targetRecordId],
          ...evidence,
        });
        failed = true;
        break;
      }
      presentValues.push({
        targetRecordId,
        value: targetConversion.value,
      });
    }
    if (failed) {
      continue;
    }

    let value: number;
    if (definition.aggregation === 'count') {
      value = presentValues.length;
    } else if (definition.aggregation === 'unique') {
      value = new Set(
        presentValues.map(({ value: targetValue }) => canonicalValueKey(targetValue)),
      ).size;
    } else {
      const numeric = deriveNumericRollup(
        definition.aggregation,
        presentValues.map(({ value: targetValue }) => targetValue),
      );
      if (numeric === null) {
        conversions.push({
          scope: cloneScope(scope),
          legacySchemaId: schema.id,
          schemaRecordId,
          legacyType: 'rollup',
          disposition: 'unresolved',
          reason: 'rollup-target-value-incompatible',
          relationSchemaId: definition.relationSchemaId,
          targetSchemaId: definition.targetSchemaId,
          targetRecordIds,
          incompatibleTargetRecordIds: presentValues
            .filter(({ value: targetValue }) => targetValue.type !== 'number')
            .map(({ targetRecordId }) => targetRecordId),
          ...evidence,
        });
        continue;
      }
      value = numeric;
    }

    derivedRollupValues[schemaRecordId] = value;
    conversions.push({
      scope: cloneScope(scope),
      legacySchemaId: schema.id,
      schemaRecordId,
      legacyType: 'rollup',
      disposition: 'derived-ready',
      relationSchemaId: definition.relationSchemaId,
      targetSchemaId: definition.targetSchemaId,
      targetRecordIds,
      aggregation: definition.aggregation,
      value,
      ...evidence,
    });
  }

  return {
    conversions,
    derivedRollupValues,
  };
}

function formulaBindings(
  record: LegacyImportRecordPropertyValuePlan,
  schemas: readonly PropertySchema[],
  schemaIds: ReadonlyMap<string, OpaqueRecordId>,
  derivedRollupValues: Readonly<Record<string, number>>,
): LegacyImportFormulaScopeBinding[] {
  if (record.schemaScope === null) {
    throw new Error(`Derived-property planner cannot bind formula scope for ${record.sourcePath}.`);
  }
  const scope = record.schemaScope;

  return schemas.map((schema, ordinal) => {
    const schemaRecordId = schemaRecordIdFor(schemaIds, scope, schema.id);
    const stored = record.canonicalReadyValues[schemaRecordId];
    if (stored !== undefined) {
      return {
        ordinal,
        legacySchemaId: schema.id,
        schemaRecordId,
        name: schema.name,
        availability: 'available',
        source: 'canonical-stored',
        canonicalValue: stored,
      } as const;
    }
    const rollup = derivedRollupValues[schemaRecordId];
    if (rollup !== undefined) {
      return {
        ordinal,
        legacySchemaId: schema.id,
        schemaRecordId,
        name: schema.name,
        availability: 'available',
        source: 'derived-rollup',
        value: rollup,
      } as const;
    }
    return {
      ordinal,
      legacySchemaId: schema.id,
      schemaRecordId,
      name: schema.name,
      availability: 'unavailable',
    } as const;
  });
}

function planRecordFormulas(
  record: LegacyImportRecordPropertyValuePlan,
  schemas: readonly PropertySchema[],
  schemaIds: ReadonlyMap<string, OpaqueRecordId>,
  conversions: ReadonlyMap<string, LegacyImportSchemaConversionPlan>,
  derivedRollupValues: Readonly<Record<string, number>>,
): LegacyImportDerivedValueConversion[] {
  if (record.schemaScope === null) {
    throw new Error(`Derived-property planner cannot plan formula for ${record.sourcePath}.`);
  }
  const scope = record.schemaScope;
  const formulaPlans: LegacyImportDerivedValueConversion[] = [];
  const bindings = formulaBindings(record, schemas, schemaIds, derivedRollupValues);

  const priorFormulaSchemaIds: OpaqueRecordId[] = [];
  for (const [schemaOrdinal, schema] of schemas.entries()) {
    if (schema.type !== 'formula') {
      continue;
    }
    const schemaRecordId = schemaRecordIdFor(schemaIds, scope, schema.id);
    const evidence = legacyStoredEvidence(record, schema.id);
    const conversion = schemaConversionFor(conversions, scope, schema.id);

    if (
      conversion.disposition !== 'canonical-ready'
      || conversion.record.definition.type !== 'formula'
    ) {
      formulaPlans.push({
        scope: cloneScope(scope),
        legacySchemaId: schema.id,
        schemaRecordId,
        legacyType: 'formula',
        disposition: 'unresolved',
        reason: 'formula-schema-pending',
        ...evidence,
      });
      priorFormulaSchemaIds.push(schemaRecordId);
      continue;
    }

    formulaPlans.push({
      scope: cloneScope(scope),
      legacySchemaId: schema.id,
      schemaRecordId,
      legacyType: 'formula',
      disposition: 'evaluation-planned',
      expression: conversion.record.definition.expression,
      evaluator: 'expr-eval',
      execution: 'not-run-in-slice-7',
      propLookup: 'first-schema-name-or-id-match',
      directVariableBinding: 'schema-name-in-schema-order-last-write-wins',
      schemaOrdinal,
      priorFormulaSchemaIds: [...priorFormulaSchemaIds],
      bindings,
      ...evidence,
    });
    priorFormulaSchemaIds.push(schemaRecordId);
  }

  return formulaPlans;
}

export function planLegacyDerivedProperties(
  input: LegacyImportDerivedPropertyPlanningInput,
): LegacyImportDerivedPropertyPlan {
  const schemaIds = new Map<string, OpaqueRecordId>();
  for (const entry of input.schemaSettings.identityMapping.schemaEntries) {
    const key = schemaIdentityKey(entry.scope, entry.legacySchemaId);
    if (schemaIds.has(key)) {
      throw new Error(`Derived-property planner received duplicate schema identity for ${key}.`);
    }
    schemaIds.set(key, entry.recordId);
  }

  const schemaConversions = new Map<string, LegacyImportSchemaConversionPlan>();
  for (const conversion of input.schemaSettings.conversions) {
    const key = schemaIdentityKey(conversion.scope, conversion.legacySchemaId);
    if (schemaConversions.has(key)) {
      throw new Error(`Derived-property planner received duplicate schema conversion for ${key}.`);
    }
    schemaConversions.set(key, conversion);
  }

  const rollupSchemas = planRollupSchemas(input, schemaIds, schemaConversions);
  const rollupBySchema = new Map<string, LegacyImportRollupSchemaPlan>();
  for (const plan of rollupSchemas) {
    rollupBySchema.set(rollupSchemaKey(plan.scope, plan.legacySchemaId), plan);
  }

  const recordById = new Map<OpaqueRecordId, LegacyImportRecordPropertyValuePlan>();
  for (const record of input.propertyValues.records) {
    if (recordById.has(record.recordId)) {
      throw new Error(`Derived-property planner received duplicate record ${record.recordId}.`);
    }
    recordById.set(record.recordId, record);
  }

  const records: LegacyImportDerivedRecordPlan[] = [];
  for (const record of input.propertyValues.records) {
    if (record.kind !== 'task' || record.schemaScope === null) {
      continue;
    }
    const schemas = schemasForScope(input.snapshot, record.schemaScope);
    const rollups = deriveRecordRollups(
      record,
      schemas,
      schemaIds,
      rollupBySchema,
      recordById,
    );
    const formulas = planRecordFormulas(
      record,
      schemas,
      schemaIds,
      schemaConversions,
      rollups.derivedRollupValues,
    );
    records.push({
      recordId: record.recordId,
      sourcePath: record.sourcePath,
      scope: cloneScope(record.schemaScope),
      conversions: [
        ...rollups.conversions,
        ...formulas,
      ],
      derivedRollupValues: { ...rollups.derivedRollupValues },
    });
  }

  const valueConversions = records.flatMap((record) => record.conversions);
  const rollupConversions = valueConversions.filter(
    (conversion) => conversion.legacyType === 'rollup',
  );
  const formulaConversions = valueConversions.filter(
    (conversion) => conversion.legacyType === 'formula',
  );
  const canonicalReadyRollupSchemas = rollupSchemas.filter(
    (plan) => plan.disposition === 'canonical-ready',
  ).length;

  return {
    schemaVersion: LEGACY_IMPORT_DERIVED_PROPERTY_PLAN_SCHEMA_VERSION,
    mode: 'dry-run',
    source: 'canonical-schema-and-property-import-plans',
    rollupSchemas,
    records,
    counts: {
      rollupSchemas: rollupSchemas.length,
      canonicalReadyRollupSchemas,
      unresolvedRollupSchemas: rollupSchemas.length - canonicalReadyRollupSchemas,
      taskRecords: records.length,
      derivedRollupValues: rollupConversions.filter(
        (conversion) => conversion.disposition === 'derived-ready',
      ).length,
      unresolvedRollupValues: rollupConversions.filter(
        (conversion) => conversion.disposition === 'unresolved',
      ).length,
      plannedFormulaEvaluations: formulaConversions.filter(
        (conversion) => conversion.disposition === 'evaluation-planned',
      ).length,
      unresolvedFormulaEvaluations: formulaConversions.filter(
        (conversion) => conversion.disposition === 'unresolved',
      ).length,
    },
    writes: {
      legacyMarkdown: 0,
      recordStore: 0,
      staging: 0,
    },
  };
}
