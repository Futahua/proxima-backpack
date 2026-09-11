import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type {
  CanonicalStoredPropertyValue,
  CanonicalStoredPropertyValues,
} from '../domain/canonicalRecordV2.js';
import type { OpaqueSchemaOptionId } from '../domain/canonicalSchema.js';
import type { RecordKind } from '../domain/records.js';
import type { PropertySchema } from '../domain/types.js';
import type { LegacyPhysicalRecordCandidate } from './vaultRepository.js';
import type {
  LegacyInterpretedPropertySchemaSettingsSnapshot,
  LegacyImportSchemaScope,
  LegacyImportSchemaSettingsPlan,
} from './importSchemaPlanner.js';

export const LEGACY_IMPORT_PROPERTY_VALUE_PLAN_SCHEMA_VERSION = 1 as const;

export interface LegacyImportPropertyRecordIdentity {
  readonly kind: RecordKind;
  readonly sourcePath: string;
  readonly recordId: OpaqueRecordId;
}

export type LegacyImportPropertyValueUnresolvedReason =
  | 'legacy-value-type-mismatch'
  | 'legacy-date-invalid'
  | 'legacy-option-unresolved'
  | 'legacy-option-ambiguous'
  | 'duplicate-option-selection';

interface LegacyImportPropertyValueConversionBase {
  readonly scope: LegacyImportSchemaScope;
  readonly legacySchemaId: string;
  readonly schemaRecordId: OpaqueRecordId;
  readonly legacyType: PropertySchema['type'];
}

export type LegacyImportPropertyValueConversion =
  | (LegacyImportPropertyValueConversionBase & {
      readonly disposition: 'canonical-ready';
      readonly value: CanonicalStoredPropertyValue;
    })
  | (LegacyImportPropertyValueConversionBase & {
      readonly disposition: 'absent';
      readonly reason: 'legacy-value-absent';
    })
  | (LegacyImportPropertyValueConversionBase & {
      readonly disposition: 'deferred';
      readonly reason:
        | 'relation-resolution-pending'
        | 'rollup-derivation-pending'
        | 'formula-derivation-pending';
    })
  | (LegacyImportPropertyValueConversionBase & {
      readonly disposition: 'unresolved';
      readonly reason: LegacyImportPropertyValueUnresolvedReason;
      readonly legacyValue: unknown;
    });

export interface LegacyImportRecordPropertyValuePlan {
  readonly kind: 'task' | 'event';
  readonly recordId: OpaqueRecordId;
  readonly sourcePath: string;
  /**
   * The already-interpreted frontmatter projection supplied by the compatibility reader.
   * It remains legacy import evidence; canonical values below contain only schema-addressed
   * values that this slice can convert without guessing.
   */
  readonly legacyPropertyValues: Readonly<Record<string, unknown>>;
  readonly schemaScope: LegacyImportSchemaScope | null;
  readonly schemaDisposition: 'mapped' | 'legacy-event-properties-untyped';
  readonly conversions: readonly LegacyImportPropertyValueConversion[];
  readonly canonicalReadyValues: CanonicalStoredPropertyValues;
}

export interface LegacyImportPropertyValuePlan {
  readonly schemaVersion: typeof LEGACY_IMPORT_PROPERTY_VALUE_PLAN_SCHEMA_VERSION;
  readonly mode: 'dry-run';
  readonly source: 'interpreted-legacy-property-values-and-schema-settings';
  readonly records: readonly LegacyImportRecordPropertyValuePlan[];
  readonly counts: {
    readonly records: number;
    readonly taskRecords: number;
    readonly eventRecords: number;
    readonly schemaBoundTaskRecords: number;
    readonly untypedEventRecords: number;
    readonly schemaProperties: number;
    readonly canonicalReady: number;
    readonly absent: number;
    readonly deferred: number;
    readonly unresolved: number;
  };
  readonly writes: {
    readonly legacyMarkdown: 0;
    readonly recordStore: 0;
    readonly staging: 0;
  };
}

export interface LegacyImportPropertyValuePlanningInput {
  readonly candidates: readonly LegacyPhysicalRecordCandidate[];
  readonly identities: readonly LegacyImportPropertyRecordIdentity[];
  readonly snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot;
  readonly schemaSettings: LegacyImportSchemaSettingsPlan;
}

function physicalKey(kind: RecordKind, sourcePath: string): string {
  return JSON.stringify([kind, sourcePath]);
}

function schemaIdentityKey(scope: LegacyImportSchemaScope, legacySchemaId: string): string {
  return JSON.stringify([
    scope.kind,
    scope.kind === 'project-schema' ? scope.legacyProjectId : null,
    legacySchemaId,
  ]);
}

function optionIdentityKey(
  scope: LegacyImportSchemaScope,
  legacySchemaId: string,
  legacyOptionId: string,
): string {
  return JSON.stringify([
    scope.kind,
    scope.kind === 'project-schema' ? scope.legacyProjectId : null,
    legacySchemaId,
    legacyOptionId,
  ]);
}

function cloneScope(scope: LegacyImportSchemaScope): LegacyImportSchemaScope {
  return scope.kind === 'task-schema'
    ? { kind: 'task-schema' }
    : { kind: 'project-schema', legacyProjectId: scope.legacyProjectId };
}

function cloneLegacyValue(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}

function cloneLegacyPropertyValues(
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    clone[key] = cloneLegacyValue(value);
  }
  return clone;
}

function taskSchemaFor(
  candidate: LegacyPhysicalRecordCandidate,
  snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot,
): {
  readonly scope: LegacyImportSchemaScope;
  readonly schemas: readonly PropertySchema[];
} {
  if (candidate.projectId !== null) {
    const projectSchema = snapshot.projectSchemas[candidate.projectId];
    if (projectSchema !== undefined) {
      return {
        scope: {
          kind: 'project-schema',
          legacyProjectId: candidate.projectId,
        },
        schemas: projectSchema,
      };
    }
  }

  return {
    scope: { kind: 'task-schema' },
    schemas: snapshot.taskSchema,
  };
}

type LegacyOptionResolution =
  | {
      readonly disposition: 'resolved';
      readonly optionId: OpaqueSchemaOptionId;
    }
  | {
      readonly disposition: 'unresolved';
      readonly reason: 'legacy-option-unresolved' | 'legacy-option-ambiguous';
    };

function resolveLegacyOption(
  value: string,
  schema: PropertySchema,
  scope: LegacyImportSchemaScope,
  optionIds: ReadonlyMap<string, OpaqueSchemaOptionId>,
): LegacyOptionResolution {
  const options = schema.options ?? [];
  const byId = options.filter((option) => option.id === value);

  if (byId.length > 1) {
    return {
      disposition: 'unresolved',
      reason: 'legacy-option-ambiguous',
    };
  }

  let selected = byId[0];

  if (selected === undefined) {
    const byName = options.filter((option) => option.name === value);

    if (byName.length > 1) {
      return {
        disposition: 'unresolved',
        reason: 'legacy-option-ambiguous',
      };
    }

    selected = byName[0];
  }

  if (selected === undefined) {
    return {
      disposition: 'unresolved',
      reason: 'legacy-option-unresolved',
    };
  }

  const key = optionIdentityKey(
    scope,
    schema.id,
    selected.id,
  );
  const optionId = optionIds.get(key);

  if (optionId === undefined) {
    throw new Error(
      `Property-value planner cannot find canonical option identity for ${key}.`,
    );
  }

  return {
    disposition: 'resolved',
    optionId,
  };
}

type LegacyMultiOptionResolution =
  | {
      readonly disposition: 'resolved';
      readonly optionIds: readonly OpaqueSchemaOptionId[];
    }
  | {
      readonly disposition: 'unresolved';
      readonly reason: LegacyImportPropertyValueUnresolvedReason;
    };

function resolveLegacyMultiOptions(
  value: unknown,
  schema: PropertySchema,
  scope: LegacyImportSchemaScope,
  optionIds: ReadonlyMap<string, OpaqueSchemaOptionId>,
): LegacyMultiOptionResolution {
  if (!Array.isArray(value)) {
    return {
      disposition: 'unresolved',
      reason: 'legacy-value-type-mismatch',
    };
  }

  const resolved: OpaqueSchemaOptionId[] = [];
  const seen = new Set<OpaqueSchemaOptionId>();

  for (const legacyOption of value) {
    if (typeof legacyOption !== 'string') {
      return {
        disposition: 'unresolved',
        reason: 'legacy-value-type-mismatch',
      };
    }

    const option = resolveLegacyOption(
      legacyOption,
      schema,
      scope,
      optionIds,
    );

    if (option.disposition === 'unresolved') {
      return option;
    }

    if (seen.has(option.optionId)) {
      return {
        disposition: 'unresolved',
        reason: 'duplicate-option-selection',
      };
    }

    seen.add(option.optionId);
    resolved.push(option.optionId);
  }

  return {
    disposition: 'resolved',
    optionIds: resolved,
  };
}

export function planLegacyPropertyValues(
  input: LegacyImportPropertyValuePlanningInput,
): LegacyImportPropertyValuePlan {
  const identityByPhysical =
    new Map<string, LegacyImportPropertyRecordIdentity>();

  for (const identity of input.identities) {
    const key = physicalKey(
      identity.kind,
      identity.sourcePath,
    );

    if (identityByPhysical.has(key)) {
      throw new Error(
        `Property-value planner received duplicate canonical identity for ${identity.sourcePath}.`,
      );
    }

    identityByPhysical.set(
      key,
      identity,
    );
  }

  const schemaIds =
    new Map<string, OpaqueRecordId>();

  for (const entry of input.schemaSettings.identityMapping.schemaEntries) {
    schemaIds.set(
      schemaIdentityKey(
        entry.scope,
        entry.legacySchemaId,
      ),
      entry.recordId,
    );
  }

  const optionIds =
    new Map<string, OpaqueSchemaOptionId>();

  for (const entry of input.schemaSettings.identityMapping.optionEntries) {
    optionIds.set(
      optionIdentityKey(
        entry.scope,
        entry.legacySchemaId,
        entry.legacyOptionId,
      ),
      entry.optionId,
    );
  }

  const records: LegacyImportRecordPropertyValuePlan[] = [];

  for (const candidate of input.candidates) {
    if (candidate.kind === 'project') {
      continue;
    }

    const identity = identityByPhysical.get(
      physicalKey(
        candidate.kind,
        candidate.source.path,
      ),
    );

    if (identity === undefined) {
      throw new Error(
        `Property-value planner cannot find canonical record identity for ${candidate.source.path}.`,
      );
    }

    const sourceValues =
      candidate.compatibility.propertyValues;

    if (sourceValues === null) {
      throw new Error(
        `Property-value planner lost interpreted legacy property values for ${candidate.source.path}.`,
      );
    }

    const legacyPropertyValues =
      cloneLegacyPropertyValues(sourceValues);

    if (candidate.kind === 'event') {
      records.push({
        kind: 'event',
        recordId: identity.recordId,
        sourcePath: candidate.source.path,
        legacyPropertyValues,
        schemaScope: null,
        schemaDisposition: 'legacy-event-properties-untyped',
        conversions: [],
        canonicalReadyValues: {},
      });

      continue;
    }

    const {
      scope,
      schemas,
    } = taskSchemaFor(
      candidate,
      input.snapshot,
    );

    const conversions:
      LegacyImportPropertyValueConversion[] = [];
    const canonicalReadyValues:
      Record<string, CanonicalStoredPropertyValue> = {};

    for (const schema of schemas) {
      const schemaKey =
        schemaIdentityKey(
          scope,
          schema.id,
        );
      const schemaRecordId =
        schemaIds.get(schemaKey);

      if (schemaRecordId === undefined) {
        throw new Error(
          `Property-value planner cannot find canonical schema identity for ${schemaKey}.`,
        );
      }

      const base:
        LegacyImportPropertyValueConversionBase = {
          scope: cloneScope(scope),
          legacySchemaId: schema.id,
          schemaRecordId,
          legacyType: schema.type,
        };

      if (schema.type === 'relation') {
        conversions.push({
          ...base,
          disposition: 'deferred',
          reason: 'relation-resolution-pending',
        });
        continue;
      }

      if (schema.type === 'rollup') {
        conversions.push({
          ...base,
          disposition: 'deferred',
          reason: 'rollup-derivation-pending',
        });
        continue;
      }

      if (schema.type === 'formula') {
        conversions.push({
          ...base,
          disposition: 'deferred',
          reason: 'formula-derivation-pending',
        });
        continue;
      }

      const hasValue =
        Object.prototype.hasOwnProperty.call(
          legacyPropertyValues,
          schema.id,
        );
      const legacyValue =
        legacyPropertyValues[schema.id];

      const appendReady = (
        value: CanonicalStoredPropertyValue,
      ): void => {
        conversions.push({
          ...base,
          disposition: 'canonical-ready',
          value,
        });
        canonicalReadyValues[schemaRecordId] =
          value;
      };

      const appendUnresolved = (
        reason: LegacyImportPropertyValueUnresolvedReason,
      ): void => {
        conversions.push({
          ...base,
          disposition: 'unresolved',
          reason,
          legacyValue:
            cloneLegacyValue(legacyValue),
        });
      };

      if (!hasValue) {
        if (schema.type === 'multi-select') {
          appendReady({
            type: 'multi-select',
            optionIds: [],
          });
        } else {
          conversions.push({
            ...base,
            disposition: 'absent',
            reason: 'legacy-value-absent',
          });
        }
        continue;
      }

      switch (schema.type) {
        case 'text':
          if (typeof legacyValue === 'string') {
            appendReady({
              type: 'text',
              value: legacyValue,
            });
          } else {
            appendUnresolved(
              'legacy-value-type-mismatch',
            );
          }
          break;

        case 'number':
          if (
            typeof legacyValue === 'number'
            && Number.isFinite(legacyValue)
          ) {
            appendReady({
              type: 'number',
              value: legacyValue,
            });
          } else {
            appendUnresolved(
              'legacy-value-type-mismatch',
            );
          }
          break;

        case 'date':
          if (typeof legacyValue !== 'string') {
            appendUnresolved(
              'legacy-value-type-mismatch',
            );
          } else if (
            legacyValue.trim() === ''
            || !Number.isFinite(
              Date.parse(legacyValue),
            )
          ) {
            appendUnresolved(
              'legacy-date-invalid',
            );
          } else {
            appendReady({
              type: 'date',
              value: legacyValue,
            });
          }
          break;

        case 'checkbox':
          if (typeof legacyValue === 'boolean') {
            appendReady({
              type: 'checkbox',
              value: legacyValue,
            });
          } else {
            appendUnresolved(
              'legacy-value-type-mismatch',
            );
          }
          break;

        case 'select':
          if (legacyValue === '') {
            conversions.push({
              ...base,
              disposition: 'absent',
              reason: 'legacy-value-absent',
            });
          } else if (typeof legacyValue !== 'string') {
            appendUnresolved(
              'legacy-value-type-mismatch',
            );
          } else {
            const option =
              resolveLegacyOption(
                legacyValue,
                schema,
                scope,
                optionIds,
              );

            if (option.disposition === 'resolved') {
              appendReady({
                type: 'select',
                optionId: option.optionId,
              });
            } else {
              appendUnresolved(
                option.reason,
              );
            }
          }
          break;

        case 'multi-select': {
          const options =
            resolveLegacyMultiOptions(
              legacyValue,
              schema,
              scope,
              optionIds,
            );

          if (options.disposition === 'resolved') {
            appendReady({
              type: 'multi-select',
              optionIds: options.optionIds,
            });
          } else {
            appendUnresolved(
              options.reason,
            );
          }
          break;
        }
      }
    }

    records.push({
      kind: 'task',
      recordId: identity.recordId,
      sourcePath: candidate.source.path,
      legacyPropertyValues,
      schemaScope: cloneScope(scope),
      schemaDisposition: 'mapped',
      conversions,
      canonicalReadyValues,
    });
  }

  const conversions =
    records.flatMap(
      (record) =>
        record.conversions,
    );

  return {
    schemaVersion:
      LEGACY_IMPORT_PROPERTY_VALUE_PLAN_SCHEMA_VERSION,
    mode: 'dry-run',
    source:
      'interpreted-legacy-property-values-and-schema-settings',
    records,
    counts: {
      records:
        records.length,
      taskRecords:
        records.filter(
          (record) =>
            record.kind === 'task',
        ).length,
      eventRecords:
        records.filter(
          (record) =>
            record.kind === 'event',
        ).length,
      schemaBoundTaskRecords:
        records.filter(
          (record) =>
            record.kind === 'task'
            && record.schemaDisposition === 'mapped',
        ).length,
      untypedEventRecords:
        records.filter(
          (record) =>
            record.schemaDisposition
            === 'legacy-event-properties-untyped',
        ).length,
      schemaProperties:
        conversions.length,
      canonicalReady:
        conversions.filter(
          (conversion) =>
            conversion.disposition === 'canonical-ready',
        ).length,
      absent:
        conversions.filter(
          (conversion) =>
            conversion.disposition === 'absent',
        ).length,
      deferred:
        conversions.filter(
          (conversion) =>
            conversion.disposition === 'deferred',
        ).length,
      unresolved:
        conversions.filter(
          (conversion) =>
            conversion.disposition === 'unresolved',
        ).length,
    },
    writes: {
      legacyMarkdown: 0,
      recordStore: 0,
      staging: 0,
    },
  };
}
