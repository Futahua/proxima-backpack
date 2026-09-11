import {
  defineCanonicalRecordHeader,
  parseOpaqueRecordId,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import {
  defineCanonicalPropertySchema,
  parseOpaqueSchemaOptionId,
  SCHEMA_PRESENTATION_STATE_CATEGORY,
  type CanonicalPropertyDefinition,
  type CanonicalPropertySchemaRecord,
  type CanonicalRelatableRecordKind,
  type OpaqueSchemaOptionId,
} from '../domain/canonicalSchema.js';
import type {
  PropertySchema,
} from '../domain/types.js';
import type {
  VaultLayout,
} from './vaultLayout.js';

export const LEGACY_IMPORT_SCHEMA_SETTINGS_PLAN_SCHEMA_VERSION =
  1 as const;

export const LEGACY_IMPORT_SCHEMA_IDENTITY_MAPPING_SCHEMA_VERSION =
  1 as const;

export type LegacyImportSchemaScope =
  | {
      readonly kind:
        'task-schema';
    }
  | {
      readonly kind:
        'project-schema';
      readonly legacyProjectId:
        string;
    };

/**
 * Explicitly interpreted legacy settings input.
 *
 * This is deliberately not a parser contract. The caller supplies the two
 * schema-bearing settings fields after legacy settings interpretation has
 * already happened elsewhere.
 */
export interface LegacyInterpretedPropertySchemaSettingsSnapshot {
  readonly taskSchema:
    readonly PropertySchema[];
  readonly projectSchemas:
    Readonly<
      Record<
        string,
        readonly PropertySchema[]
      >
    >;
}

export interface LegacyImportSchemaIdentityRequest {
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly legacyType:
    PropertySchema['type'];
}

export interface LegacyImportSchemaOptionIdentityRequest {
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly schemaRecordId:
    OpaqueRecordId;
  readonly legacyOptionId:
    string;
}

/**
 * Opaque identity allocation stays outside conversion semantics.
 *
 * Names, labels, colors, paths and folder targets are deliberately absent
 * from this request surface so none can accidentally become identity input.
 */
export interface LegacyImportSchemaIdentityAllocator {
  schemaRecordIdFor(
    request:
      LegacyImportSchemaIdentityRequest,
  ): string;

  schemaOptionIdFor(
    request:
      LegacyImportSchemaOptionIdentityRequest,
  ): string;
}

export interface LegacyImportSchemaIdentityMappingEntry {
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly recordId:
    OpaqueRecordId;
}

export interface LegacyImportSchemaOptionIdentityMappingEntry {
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly legacyOptionId:
    string;
  readonly optionId:
    OpaqueSchemaOptionId;
}

export interface LegacyImportSchemaIdentityMappingManifest {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_SCHEMA_IDENTITY_MAPPING_SCHEMA_VERSION;
  readonly schemaEntries:
    readonly LegacyImportSchemaIdentityMappingEntry[];
  readonly optionEntries:
    readonly LegacyImportSchemaOptionIdentityMappingEntry[];
}

/**
 * Durability boundary for schema/settings import identities.
 *
 * No physical location is selected here. A later owner may persist this
 * mapping beside the existing import identity evidence, but this planner
 * receives and emits only the versioned manifest.
 */
export interface LegacyImportSchemaIdentityMappingStore {
  load():
    Promise<
      LegacyImportSchemaIdentityMappingManifest | null
    >;

  save(
    mapping:
      LegacyImportSchemaIdentityMappingManifest,
  ): Promise<void>;
}

export interface LegacyImportSchemaPlanningInput {
  readonly snapshot:
    LegacyInterpretedPropertySchemaSettingsSnapshot;
  readonly allocator:
    LegacyImportSchemaIdentityAllocator;
  readonly priorIdentityMapping?:
    LegacyImportSchemaIdentityMappingManifest | null;
}

export interface LegacyImportCanonicalReadySchemaPlan {
  readonly disposition:
    'canonical-ready';
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly record:
    CanonicalPropertySchemaRecord;
}

export type LegacyImportPendingSchemaReason =
  | {
      readonly reason:
        'relation-target-resolution-pending';
      readonly legacyTargetFolder:
        string | null;
    }
  | {
      readonly reason:
        'rollup-property-reference-resolution-pending';
      readonly legacyRelationProperty:
        string | null;
      readonly legacyTargetProperty:
        string | null;
      readonly aggregation:
        NonNullable<
          PropertySchema['aggregation']
        > | null;
    }
  | {
      readonly reason:
        'formula-expression-incomplete';
      readonly legacyExpression:
        string | null;
    };

export interface LegacyImportPendingSchemaPlan {
  readonly disposition:
    'pending';
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly recordId:
    OpaqueRecordId;
  readonly name:
    string;
  readonly pending:
    LegacyImportPendingSchemaReason;
}

export type LegacyImportSchemaConversionPlan =
  | LegacyImportCanonicalReadySchemaPlan
  | LegacyImportPendingSchemaPlan;

export interface LegacyImportSchemaSettingsPlan {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_SCHEMA_SETTINGS_PLAN_SCHEMA_VERSION;
  readonly mode:
    'dry-run';
  readonly source:
    'explicitly-interpreted-legacy-property-schema-settings';
  readonly identityMapping:
    LegacyImportSchemaIdentityMappingManifest;
  readonly conversions:
    readonly LegacyImportSchemaConversionPlan[];
  readonly presentation: {
    readonly category:
      typeof SCHEMA_PRESENTATION_STATE_CATEGORY;
    readonly optionColors:
      readonly {
        readonly schemaId:
          OpaqueRecordId;
        readonly optionId:
          OpaqueSchemaOptionId;
        readonly color:
          string;
      }[];
  };
  readonly counts: {
    readonly schemaCandidates:
      number;
    readonly canonicalReady:
      number;
    readonly pending:
      number;
    readonly optionCandidates:
      number;
    readonly optionColors:
      number;
  };
  readonly writes: {
    readonly legacySettings:
      0;
    readonly recordStore:
      0;
    readonly staging:
      0;
  };
}

interface LegacySchemaCandidate {
  readonly scope:
    LegacyImportSchemaScope;
  readonly schema:
    PropertySchema;
}

function cloneScope(
  scope:
    LegacyImportSchemaScope,
): LegacyImportSchemaScope {
  return scope.kind
    === 'task-schema'
    ? {
        kind:
          'task-schema',
      }
    : {
        kind:
          'project-schema',
        legacyProjectId:
          scope.legacyProjectId,
      };
}

function schemaIdentityKey(
  scope:
    LegacyImportSchemaScope,
  legacySchemaId:
    string,
): string {
  return JSON.stringify([
    scope.kind,
    scope.kind
      === 'project-schema'
      ? scope.legacyProjectId
      : null,
    legacySchemaId,
  ]);
}

function optionIdentityKey(
  scope:
    LegacyImportSchemaScope,
  legacySchemaId:
    string,
  legacyOptionId:
    string,
): string {
  return JSON.stringify([
    scope.kind,
    scope.kind
      === 'project-schema'
      ? scope.legacyProjectId
      : null,
    legacySchemaId,
    legacyOptionId,
  ]);
}

function compareSchemaIdentityEntries(
  left:
    LegacyImportSchemaIdentityMappingEntry,
  right:
    LegacyImportSchemaIdentityMappingEntry,
): number {
  return schemaIdentityKey(
    left.scope,
    left.legacySchemaId,
  ).localeCompare(
    schemaIdentityKey(
      right.scope,
      right.legacySchemaId,
    ),
  );
}

function compareOptionIdentityEntries(
  left:
    LegacyImportSchemaOptionIdentityMappingEntry,
  right:
    LegacyImportSchemaOptionIdentityMappingEntry,
): number {
  return optionIdentityKey(
    left.scope,
    left.legacySchemaId,
    left.legacyOptionId,
  ).localeCompare(
    optionIdentityKey(
      right.scope,
      right.legacySchemaId,
      right.legacyOptionId,
    ),
  );
}

function normalizeSchemaIdentityMapping(
  mapping:
    LegacyImportSchemaIdentityMappingManifest | null,
): LegacyImportSchemaIdentityMappingManifest {
  if (mapping === null) {
    return {
      schemaVersion:
        LEGACY_IMPORT_SCHEMA_IDENTITY_MAPPING_SCHEMA_VERSION,
      schemaEntries: [],
      optionEntries: [],
    };
  }

  if (
    mapping.schemaVersion
    !== LEGACY_IMPORT_SCHEMA_IDENTITY_MAPPING_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported legacy schema import identity mapping schema: ${String(mapping.schemaVersion)}`,
    );
  }

  const schemaEntries:
    LegacyImportSchemaIdentityMappingEntry[] =
      mapping.schemaEntries.map(
        (entry) => ({
          scope:
            cloneScope(
              entry.scope,
            ),
          legacySchemaId:
            entry.legacySchemaId,
          recordId:
            parseOpaqueRecordId(
              entry.recordId,
            ),
        }),
      );

  const schemaByKey =
    new Map<
      string,
      LegacyImportSchemaIdentityMappingEntry
    >();

  const schemaByRecordId =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const entry
    of schemaEntries
  ) {
    const key =
      schemaIdentityKey(
        entry.scope,
        entry.legacySchemaId,
      );

    if (
      schemaByKey.has(
        key,
      )
    ) {
      throw new Error(
        `Legacy schema import identity mapping contains duplicate schema alias ${entry.legacySchemaId} in ${key}.`,
      );
    }

    if (
      entry.legacySchemaId
      === entry.recordId
    ) {
      throw new Error(
        `Legacy schema id ${entry.legacySchemaId} is provenance only and must not equal its canonical schema record id.`,
      );
    }

    const previous =
      schemaByRecordId.get(
        entry.recordId,
      );

    if (
      previous !== undefined
    ) {
      throw new Error(
        `Legacy schema import identity mapping reuses canonical schema record id ${entry.recordId}; already assigned to ${previous}.`,
      );
    }

    schemaByKey.set(
      key,
      entry,
    );

    schemaByRecordId.set(
      entry.recordId,
      key,
    );
  }

  const optionEntries:
    LegacyImportSchemaOptionIdentityMappingEntry[] =
      mapping.optionEntries.map(
        (entry) => ({
          scope:
            cloneScope(
              entry.scope,
            ),
          legacySchemaId:
            entry.legacySchemaId,
          legacyOptionId:
            entry.legacyOptionId,
          optionId:
            parseOpaqueSchemaOptionId(
              entry.optionId,
            ),
        }),
      );

  const optionByKey =
    new Map<
      string,
      LegacyImportSchemaOptionIdentityMappingEntry
    >();

  const optionById =
    new Map<
      OpaqueSchemaOptionId,
      string
    >();

  for (
    const entry
    of optionEntries
  ) {
    const parentKey =
      schemaIdentityKey(
        entry.scope,
        entry.legacySchemaId,
      );

    if (
      !schemaByKey.has(
        parentKey,
      )
    ) {
      throw new Error(
        `Legacy schema option identity mapping has no parent schema mapping for ${entry.legacySchemaId}.`,
      );
    }

    const key =
      optionIdentityKey(
        entry.scope,
        entry.legacySchemaId,
        entry.legacyOptionId,
      );

    if (
      optionByKey.has(
        key,
      )
    ) {
      throw new Error(
        `Legacy schema import identity mapping contains duplicate option alias ${entry.legacyOptionId} in ${key}.`,
      );
    }

    if (
      entry.legacyOptionId
      === entry.optionId
    ) {
      throw new Error(
        `Legacy schema option id ${entry.legacyOptionId} is provenance only and must not equal its canonical option id.`,
      );
    }

    const previous =
      optionById.get(
        entry.optionId,
      );

    if (
      previous !== undefined
    ) {
      throw new Error(
        `Legacy schema import identity mapping reuses canonical option id ${entry.optionId}; already assigned to ${previous}.`,
      );
    }

    optionByKey.set(
      key,
      entry,
    );

    optionById.set(
      entry.optionId,
      key,
    );
  }

  return {
    schemaVersion:
      LEGACY_IMPORT_SCHEMA_IDENTITY_MAPPING_SCHEMA_VERSION,
    schemaEntries:
      schemaEntries.sort(
        compareSchemaIdentityEntries,
      ),
    optionEntries:
      optionEntries.sort(
        compareOptionIdentityEntries,
      ),
  };
}

export async function readLegacyImportSchemaIdentityMapping(
  store:
    LegacyImportSchemaIdentityMappingStore,
): Promise<
  LegacyImportSchemaIdentityMappingManifest | null
> {
  const loaded =
    await store.load();

  return loaded === null
    ? null
    : normalizeSchemaIdentityMapping(
        loaded,
      );
}

export async function writeLegacyImportSchemaIdentityMapping(
  store:
    LegacyImportSchemaIdentityMappingStore,
  mapping:
    LegacyImportSchemaIdentityMappingManifest,
): Promise<void> {
  await store.save(
    normalizeSchemaIdentityMapping(
      mapping,
    ),
  );
}

function schemaCandidates(
  snapshot:
    LegacyInterpretedPropertySchemaSettingsSnapshot,
): LegacySchemaCandidate[] {
  const candidates:
    LegacySchemaCandidate[] =
      snapshot.taskSchema.map(
        (schema) => ({
          scope: {
            kind:
              'task-schema',
          },
          schema,
        }),
      );

  for (
    const legacyProjectId
    of Object.keys(
      snapshot.projectSchemas,
    ).sort()
  ) {
    const schemas =
      snapshot.projectSchemas[
        legacyProjectId
      ]
      ?? [];

    for (
      const schema
      of schemas
    ) {
      candidates.push({
        scope: {
          kind:
            'project-schema',
          legacyProjectId,
        },
        schema,
      });
    }
  }

  return candidates;
}

function normalizeLegacyTargetFolder(
  value:
    string,
): string {
  return value
    .split('\\')
    .join('/')
    .replace(
      /^\/+|\/+$/g,
      '',
    );
}

function relationTargetKindsForFolder(
  legacyTargetFolder:
    string | undefined,
  layout:
    VaultLayout | null,
): readonly CanonicalRelatableRecordKind[] | null {
  if (
    layout === null
    || legacyTargetFolder === undefined
  ) {
    return null;
  }

  const target =
    normalizeLegacyTargetFolder(
      legacyTargetFolder,
    );

  if (target === '') {
    return null;
  }

  const configured = [
    {
      kind:
        'task',
      directory:
        layout.tasks,
    },
    {
      kind:
        'project',
      directory:
        layout.projects,
    },
    {
      kind:
        'event',
      directory:
        layout.events,
    },
  ] as const;

  const targetKinds =
    configured
      .filter(
        (candidate) =>
          normalizeLegacyTargetFolder(
            candidate.directory,
          ) === target,
      )
      .map(
        (candidate) =>
          candidate.kind,
      );

  return targetKinds.length === 0
    ? null
    : targetKinds;
}

/**
 * Convert explicitly interpreted legacy property-schema settings into a
 * zero-write canonical conversion plan.
 *
 * When the caller supplies the exact interpreted vault layout, a legacy
 * relation target folder that exactly names one or more configured Proxima
 * record directories becomes canonical target-kind semantics. Unknown
 * folders remain pending rather than being guessed. Rollup property-name
 * references and incomplete formulas remain pending. Custom property values
 * are not read or converted here.
 */
export function planLegacySchemaSettings(
  input:
    LegacyImportSchemaPlanningInput,
  reservedRecordIds:
    readonly OpaqueRecordId[] = [],
  relationTargetLayout:
    VaultLayout | null = null,
): LegacyImportSchemaSettingsPlan {
  const prior =
    normalizeSchemaIdentityMapping(
      input.priorIdentityMapping
      ?? null,
    );

  const candidates =
    schemaCandidates(
      input.snapshot,
    );

  const schemaEntries:
    LegacyImportSchemaIdentityMappingEntry[] = [
      ...prior.schemaEntries,
    ];

  const optionEntries:
    LegacyImportSchemaOptionIdentityMappingEntry[] = [
      ...prior.optionEntries,
    ];

  const schemaEntryByKey =
    new Map(
      schemaEntries.map(
        (entry) => [
          schemaIdentityKey(
            entry.scope,
            entry.legacySchemaId,
          ),
          entry,
        ] as const,
      ),
    );

  const optionEntryByKey =
    new Map(
      optionEntries.map(
        (entry) => [
          optionIdentityKey(
            entry.scope,
            entry.legacySchemaId,
            entry.legacyOptionId,
          ),
          entry,
        ] as const,
      ),
    );

  const claimedRecordIds =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const recordId
    of reservedRecordIds
  ) {
    claimedRecordIds.set(
      recordId,
      'reserved canonical import record identity',
    );
  }

  for (
    const entry
    of schemaEntries
  ) {
    const key =
      schemaIdentityKey(
        entry.scope,
        entry.legacySchemaId,
      );

    const previous =
      claimedRecordIds.get(
        entry.recordId,
      );

    if (
      previous !== undefined
    ) {
      throw new Error(
        `Legacy schema identity ${entry.recordId} for ${key} collides with ${previous}.`,
      );
    }

    claimedRecordIds.set(
      entry.recordId,
      key,
    );
  }

  const claimedOptionIds =
    new Map<
      OpaqueSchemaOptionId,
      string
    >();

  for (
    const entry
    of optionEntries
  ) {
    claimedOptionIds.set(
      entry.optionId,
      optionIdentityKey(
        entry.scope,
        entry.legacySchemaId,
        entry.legacyOptionId,
      ),
    );
  }

  const seenCurrentSchemas =
    new Set<string>();

  const seenCurrentOptions =
    new Set<string>();

  const conversions:
    LegacyImportSchemaConversionPlan[] =
      [];

  const optionColors:
    {
      readonly schemaId:
        OpaqueRecordId;
      readonly optionId:
        OpaqueSchemaOptionId;
      readonly color:
        string;
    }[] =
      [];

  let optionCandidates = 0;

  for (
    const candidate
    of candidates
  ) {
    const {
      scope,
      schema,
    } = candidate;

    const currentSchemaKey =
      schemaIdentityKey(
        scope,
        schema.id,
      );

    if (
      seenCurrentSchemas.has(
        currentSchemaKey,
      )
    ) {
      throw new Error(
        `Interpreted legacy schema/settings snapshot reuses legacy schema id ${schema.id} in the same scope.`,
      );
    }

    seenCurrentSchemas.add(
      currentSchemaKey,
    );

    let schemaEntry =
      schemaEntryByKey.get(
        currentSchemaKey,
      );

    if (
      schemaEntry === undefined
    ) {
      const recordId =
        parseOpaqueRecordId(
          input.allocator
            .schemaRecordIdFor({
              scope:
                cloneScope(
                  scope,
                ),
              legacySchemaId:
                schema.id,
              legacyType:
                schema.type,
            }),
        );

      if (
        recordId
        === schema.id
      ) {
        throw new Error(
          `Legacy schema id ${schema.id} is provenance only and must not be promoted to canonical schema identity.`,
        );
      }

      const previous =
        claimedRecordIds.get(
          recordId,
        );

      if (
        previous !== undefined
      ) {
        throw new Error(
          `Schema identity allocator reused canonical record id ${recordId} for ${currentSchemaKey}; collides with ${previous}.`,
        );
      }

      schemaEntry = {
        scope:
          cloneScope(
            scope,
          ),
        legacySchemaId:
          schema.id,
        recordId,
      };

      schemaEntries.push(
        schemaEntry,
      );

      schemaEntryByKey.set(
        currentSchemaKey,
        schemaEntry,
      );

      claimedRecordIds.set(
        recordId,
        currentSchemaKey,
      );
    }

    const recordId =
      schemaEntry.recordId;

    const appendReady =
      (
        definition:
          CanonicalPropertyDefinition,
      ): void => {
        conversions.push({
          disposition:
            'canonical-ready',
          scope:
            cloneScope(
              scope,
            ),
          legacySchemaId:
            schema.id,
          record:
            defineCanonicalPropertySchema({
              header:
                defineCanonicalRecordHeader({
                  kind:
                    'schema',
                  id:
                    recordId,
                  name:
                    schema.name,
                }),
              definition,
            }),
        });
      };

    switch (
      schema.type
    ) {
      case 'text':
        appendReady({
          type:
            'text',
        });
        break;

      case 'number':
        appendReady({
          type:
            'number',
        });
        break;

      case 'date':
        appendReady({
          type:
            'date',
        });
        break;

      case 'checkbox':
        appendReady({
          type:
            'checkbox',
        });
        break;

      case 'select':
      case 'multi-select': {
        const canonicalOptions =
          (
            schema.options
            ?? []
          ).map(
            (option) => {
              optionCandidates += 1;

              const currentOptionKey =
                optionIdentityKey(
                  scope,
                  schema.id,
                  option.id,
                );

              if (
                seenCurrentOptions.has(
                  currentOptionKey,
                )
              ) {
                throw new Error(
                  `Interpreted legacy schema/settings snapshot reuses legacy option id ${option.id} within schema ${schema.id} in the same scope.`,
                );
              }

              seenCurrentOptions.add(
                currentOptionKey,
              );

              let optionEntry =
                optionEntryByKey.get(
                  currentOptionKey,
                );

              if (
                optionEntry === undefined
              ) {
                const optionId =
                  parseOpaqueSchemaOptionId(
                    input.allocator
                      .schemaOptionIdFor({
                        scope:
                          cloneScope(
                            scope,
                          ),
                        legacySchemaId:
                          schema.id,
                        schemaRecordId:
                          recordId,
                        legacyOptionId:
                          option.id,
                      }),
                  );

                if (
                  optionId
                  === option.id
                ) {
                  throw new Error(
                    `Legacy schema option id ${option.id} is provenance only and must not be promoted to canonical option identity.`,
                  );
                }

                const previous =
                  claimedOptionIds.get(
                    optionId,
                  );

                if (
                  previous !== undefined
                ) {
                  throw new Error(
                    `Schema option identity allocator reused canonical option id ${optionId} for ${currentOptionKey}; already assigned to ${previous}.`,
                  );
                }

                optionEntry = {
                  scope:
                    cloneScope(
                      scope,
                    ),
                  legacySchemaId:
                    schema.id,
                  legacyOptionId:
                    option.id,
                  optionId,
                };

                optionEntries.push(
                  optionEntry,
                );

                optionEntryByKey.set(
                  currentOptionKey,
                  optionEntry,
                );

                claimedOptionIds.set(
                  optionId,
                  currentOptionKey,
                );
              }

              optionColors.push({
                schemaId:
                  recordId,
                optionId:
                  optionEntry.optionId,
                color:
                  option.color,
              });

              return {
                id:
                  optionEntry.optionId,
                label:
                  option.name,
              };
            },
          );

        appendReady({
          type:
            schema.type,
          options:
            canonicalOptions,
        });
        break;
      }

      case 'formula':
        if (
          schema.expression
          === undefined
          || schema.expression
            .trim()
            .length
            === 0
        ) {
          conversions.push({
            disposition:
              'pending',
            scope:
              cloneScope(
                scope,
              ),
            legacySchemaId:
              schema.id,
            recordId,
            name:
              schema.name,
            pending: {
              reason:
                'formula-expression-incomplete',
              legacyExpression:
                schema.expression
                ?? null,
            },
          });
        } else {
          appendReady({
            type:
              'formula',
            expression:
              schema.expression,
          });
        }
        break;

      case 'relation': {
        const targetKinds =
          relationTargetKindsForFolder(
            schema.targetFolder,
            relationTargetLayout,
          );

        if (targetKinds === null) {
          conversions.push({
            disposition:
              'pending',
            scope:
              cloneScope(
                scope,
              ),
            legacySchemaId:
              schema.id,
            recordId,
            name:
              schema.name,
            pending: {
              reason:
                'relation-target-resolution-pending',
              legacyTargetFolder:
                schema.targetFolder
                ?? null,
            },
          });
        } else {
          appendReady({
            type:
              'relation',
            targetKinds,
          });
        }
        break;
      }

      case 'rollup':
        conversions.push({
          disposition:
            'pending',
          scope:
            cloneScope(
              scope,
            ),
          legacySchemaId:
            schema.id,
          recordId,
          name:
            schema.name,
          pending: {
            reason:
              'rollup-property-reference-resolution-pending',
            legacyRelationProperty:
              schema.relationProperty
              ?? null,
            legacyTargetProperty:
              schema.targetProperty
              ?? null,
            aggregation:
              schema.aggregation
              ?? null,
          },
        });
        break;
    }
  }

  const identityMapping =
    normalizeSchemaIdentityMapping({
      schemaVersion:
        LEGACY_IMPORT_SCHEMA_IDENTITY_MAPPING_SCHEMA_VERSION,
      schemaEntries,
      optionEntries,
    });

  const canonicalReady =
    conversions.filter(
      (conversion) =>
        conversion.disposition
        === 'canonical-ready',
    ).length;

  const pending =
    conversions.length
    - canonicalReady;

  return {
    schemaVersion:
      LEGACY_IMPORT_SCHEMA_SETTINGS_PLAN_SCHEMA_VERSION,
    mode:
      'dry-run',
    source:
      'explicitly-interpreted-legacy-property-schema-settings',
    identityMapping,
    conversions,
    presentation: {
      category:
        SCHEMA_PRESENTATION_STATE_CATEGORY,
      optionColors,
    },
    counts: {
      schemaCandidates:
        candidates.length,
      canonicalReady,
      pending,
      optionCandidates,
      optionColors:
        optionColors.length,
    },
    writes: {
      legacySettings: 0,
      recordStore: 0,
      staging: 0,
    },
  };
}
