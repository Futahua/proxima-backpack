import {
  defineCanonicalRecordHeader,
  defineLegacyImportProvenance,
  pairCanonicalWithLegacyProvenance,
  parseOpaqueRecordId,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import type {
  ProblemCode,
  ProblemSeverity,
} from '../domain/problems.js';
import {
  canonicalOrderPosition,
  type CanonicalOrderPosition,
} from '../domain/canonicalOrdering.js';
import type {
  CanonicalExecutionState,
} from '../domain/canonicalTaskState.js';
import type {
  IdOrigin,
  RecordKind,
} from '../domain/records.js';
import type {
  VaultReader,
} from '../ports/vault.js';
import {
  loadVaultState,
  type KindCensus,
  type LegacyPhysicalRecordCandidate,
  type LoadOptions,
} from './vaultRepository.js';
import {
  planLegacySchemaSettings,
  type LegacyImportSchemaPlanningInput,
  type LegacyImportSchemaSettingsPlan,
} from './importSchemaPlanner.js';

export const LEGACY_IMPORT_PLAN_SCHEMA_VERSION =
  2 as const;

export interface LegacyImportIdentityRequest {
  readonly kind: RecordKind;
  readonly legacyId: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly idOrigin: IdOrigin;
}

/**
 * Identity allocation is an explicit boundary.
 *
 * The planner decides which legacy physical record needs an identity and
 * validates the supplied value against HARD GATE A. It does not derive
 * canonical identity from legacy id, filename, path or display name.
 */
export interface LegacyImportIdentityAllocator {
  recordIdFor(
    request:
      LegacyImportIdentityRequest,
  ): string;
}

export const LEGACY_IMPORT_IDENTITY_MAPPING_SCHEMA_VERSION =
  1 as const;

/**
 * Durable import identity metadata.
 *
 * The physical source is the reconciliation key because a duplicate legacy alias cannot
 * itself identify one physical candidate. Legacy ids remain provenance only.
 */
export interface LegacyImportIdentityMappingEntry {
  readonly kind: RecordKind;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly idOrigin: IdOrigin;
  readonly legacyId: string;
  readonly recordId: OpaqueRecordId;
}

export interface LegacyImportIdentityMappingManifest {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_IDENTITY_MAPPING_SCHEMA_VERSION;
  readonly entries:
    readonly LegacyImportIdentityMappingEntry[];
}

/**
 * Persistence boundary for the identity manifest.
 *
 * A production implementation must resolve `save` only after the supplied manifest is
 * durably stored. This slice defines and exercises that boundary but does not select or
 * materialize a staging-store location.
 */
export interface LegacyImportIdentityMappingStore {
  load():
    Promise<
      LegacyImportIdentityMappingManifest | null
    >;

  save(
    mapping:
      LegacyImportIdentityMappingManifest,
  ): Promise<void>;
}

export interface LegacyImportIdentityPlan {
  readonly kind: RecordKind;
  readonly legacyId: string;
  readonly recordId:
    OpaqueRecordId;
  readonly name: string;
  readonly disposition:
    | 'candidate'
    | 'duplicate-alias-collision';
  readonly source: {
    readonly path: string;
    readonly revision: string;
    readonly idOrigin:
      IdOrigin;
  };
}

export interface LegacyImportCollisionCandidate {
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly sourceRevision:
    string;
  readonly idOrigin:
    IdOrigin;
}

export interface LegacyImportCollisionPlan {
  readonly kind:
    RecordKind;
  readonly legacyId:
    string;
  readonly candidates:
    readonly LegacyImportCollisionCandidate[];
}

export interface LegacyImportProjectReferencePlan {
  readonly sourceKind:
    'task' | 'event';
  readonly sourceLegacyId:
    string;
  readonly sourceRecordId:
    OpaqueRecordId;
  readonly legacyProjectId:
    string;
  readonly projectRecordId:
    OpaqueRecordId | null;
  readonly candidateProjectRecordIds?:
    readonly OpaqueRecordId[];
  readonly resolution:
    | 'resolved'
    | 'missing'
    | 'ambiguous';
}

export type LegacyImportWorkflowStagePlan =
  | {
      readonly resolution:
        'candidate';
      readonly legacyStatusId:
        string;
      readonly suggestedName:
        string;
      readonly projectRecordId:
        OpaqueRecordId;
    }
  | {
      readonly resolution:
        'none';
      readonly legacyStatusId:
        string;
      readonly suggestedName:
        string;
      readonly projectRecordId:
        null;
    }
  | {
      readonly resolution:
        'missing-project';
      readonly legacyStatusId:
        string;
      readonly suggestedName:
        string;
      readonly projectRecordId:
        null;
    }
  | {
      readonly resolution:
        'ambiguous-project';
      readonly legacyStatusId:
        string;
      readonly suggestedName:
        string;
      readonly projectRecordId:
        null;
      readonly candidateProjectRecordIds:
        readonly OpaqueRecordId[];
    };

export interface LegacyImportExecutionOrderPlan {
  readonly scope: {
    readonly kind:
      'elastic-execution';
    readonly executionState:
      CanonicalExecutionState;
  };
  readonly position:
    CanonicalOrderPosition;
}

export interface LegacyImportWorkflowOrderPlan {
  /**
   * This is a conversion-plan scope, not yet a materialized canonical
   * CanonicalDurableOrderScope: final workflowStageId allocation belongs to staging.
   */
  readonly scope: {
    readonly kind:
      'project-workflow-stage-candidate';
    readonly projectRecordId:
      OpaqueRecordId;
    readonly legacyStatusId:
      string;
  };
  readonly position:
    CanonicalOrderPosition;
}

export interface LegacyImportTaskConversionPlan {
  readonly kind:
    'task';
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly legacyStatusId:
    string;
  readonly executionState:
    CanonicalExecutionState;
  readonly workflowStage:
    LegacyImportWorkflowStagePlan;
  readonly scopedOrders: {
    readonly execution:
      LegacyImportExecutionOrderPlan;
    readonly workflow:
      LegacyImportWorkflowOrderPlan | null;
  };
}

export interface LegacyImportProjectConversionPlan {
  readonly kind:
    'project';
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly legacyProjectType:
    'task' | 'schedule';
  readonly disposition:
    'compatibility-import-metadata-only';
  readonly canonicalCapabilityAuthority:
    'associated-data-and-workspace';
}

export interface LegacyImportEventConversionPlan {
  readonly kind:
    'event';
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
}

export type LegacyImportConversionPlan =
  | LegacyImportTaskConversionPlan
  | LegacyImportProjectConversionPlan
  | LegacyImportEventConversionPlan;

export type LegacyImportProblemDisposition =
  | 'reader-problem'
  | 'unsupported-frontmatter-policy-pending';

export interface LegacyImportProblemPlan {
  readonly code:
    ProblemCode;
  readonly severity:
    ProblemSeverity;
  readonly sourcePath:
    string;
  readonly kind:
    RecordKind | null;
  readonly legacyId:
    string | null;
  readonly diagnostic:
    string;
  readonly disposition:
    LegacyImportProblemDisposition;
}

export interface LegacyImportPlan {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_PLAN_SCHEMA_VERSION;
  readonly mode:
    'dry-run';
  readonly source:
    'legacy-markdown-compatibility-reader';

  readonly mappings:
    readonly LegacyImportIdentityPlan[];

  readonly conversions:
    readonly LegacyImportConversionPlan[];

  readonly schemaSettings:
    LegacyImportSchemaSettingsPlan | null;

  readonly identityMapping:
    LegacyImportIdentityMappingManifest;

  readonly collisions:
    readonly LegacyImportCollisionPlan[];

  readonly projectReferences:
    readonly LegacyImportProjectReferencePlan[];

  readonly problems:
    readonly LegacyImportProblemPlan[];

  readonly census:
    Readonly<
      Record<
        RecordKind,
        KindCensus
      >
    >;

  readonly counts: {
    readonly projects:
      number;
    readonly tasks:
      number;
    readonly events:
      number;
    readonly physicalCandidates:
      number;
    readonly mappings:
      number;
    readonly collisions:
      number;
    readonly projectReferences:
      number;
    readonly unresolvedProjectReferences:
      number;
    readonly ambiguousProjectReferences:
      number;
    readonly readerProblems:
      number;
    readonly unsupportedFrontmatter:
      number;
  };

  readonly writes: {
    readonly legacyMarkdown:
      0;
    readonly recordStore:
      0;
    readonly staging:
      0;
  };
}

const KIND_ORDER:
  Readonly<
    Record<
      RecordKind,
      number
    >
  > = {
    project: 0,
    task: 1,
    event: 2,
  };

function sortedCandidates(
  candidates:
    readonly LegacyPhysicalRecordCandidate[],
): LegacyPhysicalRecordCandidate[] {
  return [...candidates]
    .sort(
      (left, right) =>
        KIND_ORDER[left.kind]
        - KIND_ORDER[right.kind]
        || left.source.path
          .localeCompare(
            right.source.path,
          ),
    );
}

function mappingKey(
  kind:
    RecordKind,
  legacyId:
    string,
): string {
  return `${kind}\u0000${legacyId}`;
}

function physicalKey(
  kind:
    RecordKind,
  sourcePath:
    string,
): string {
  return `${kind}\u0000${sourcePath}`;
}

function compareIdentityMappingEntries(
  left:
    LegacyImportIdentityMappingEntry,
  right:
    LegacyImportIdentityMappingEntry,
): number {
  return (
    KIND_ORDER[left.kind]
    - KIND_ORDER[right.kind]
    || left.sourcePath
      .localeCompare(
        right.sourcePath,
      )
  );
}

function normalizeIdentityMapping(
  mapping:
    LegacyImportIdentityMappingManifest | null,
): LegacyImportIdentityMappingManifest {
  if (mapping === null) {
    return {
      schemaVersion:
        LEGACY_IMPORT_IDENTITY_MAPPING_SCHEMA_VERSION,
      entries: [],
    };
  }

  if (
    mapping.schemaVersion
    !== LEGACY_IMPORT_IDENTITY_MAPPING_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported legacy import identity mapping schema: ${String(mapping.schemaVersion)}`,
    );
  }

  const entries =
    mapping.entries
      .map(
        (entry) => ({
          kind:
            entry.kind,
          sourcePath:
            entry.sourcePath,
          sourceRevision:
            entry.sourceRevision,
          idOrigin:
            entry.idOrigin,
          legacyId:
            entry.legacyId,
          recordId:
            parseOpaqueRecordId(
              entry.recordId,
            ),
        }),
      )
      .sort(
        compareIdentityMappingEntries,
      );

  const byPhysical =
    new Map<
      string,
      LegacyImportIdentityMappingEntry
    >();

  const byRecordId =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const entry
    of entries
  ) {
    if (
      entry.sourcePath.length
      === 0
      || entry.legacyId.length
        === 0
    ) {
      throw new Error(
        'Legacy import identity mapping entries must include non-empty sourcePath and legacyId.',
      );
    }

    const candidateKey =
      physicalKey(
        entry.kind,
        entry.sourcePath,
      );

    if (
      byPhysical.has(
        candidateKey,
      )
    ) {
      throw new Error(
        `Legacy import identity mapping contains duplicate physical candidate ${entry.kind} ${entry.sourcePath}.`,
      );
    }

    const existingSource =
      byRecordId.get(
        entry.recordId,
      );

    if (
      existingSource !== undefined
    ) {
      throw new Error(
        `Legacy import identity mapping reuses canonical record id ${entry.recordId} for ${entry.sourcePath}; already assigned to ${existingSource}.`,
      );
    }

    byPhysical.set(
      candidateKey,
      entry,
    );

    byRecordId.set(
      entry.recordId,
      entry.sourcePath,
    );
  }

  return {
    schemaVersion:
      LEGACY_IMPORT_IDENTITY_MAPPING_SCHEMA_VERSION,
    entries,
  };
}

export async function readLegacyImportIdentityMapping(
  store:
    LegacyImportIdentityMappingStore,
): Promise<
  LegacyImportIdentityMappingManifest | null
> {
  const loaded =
    await store.load();

  return loaded === null
    ? null
    : normalizeIdentityMapping(
        loaded,
      );
}

export async function writeLegacyImportIdentityMapping(
  store:
    LegacyImportIdentityMappingStore,
  mapping:
    LegacyImportIdentityMappingManifest,
): Promise<void> {
  await store.save(
    normalizeIdentityMapping(
      mapping,
    ),
  );
}

function cloneCensus(
  census:
    Record<
      RecordKind,
      KindCensus
    >,
): Record<
  RecordKind,
  KindCensus
> {
  return {
    project: {
      ...census.project,
    },
    task: {
      ...census.task,
    },
    event: {
      ...census.event,
    },
  };
}

/**
 * Build a read-only migration plan from the existing compatibility reader.
 *
 * This function has no writer argument. It cannot mutate legacy Markdown,
 * staging, or the Record Store. Its output is the machine-readable input to
 * later Stage 8 reconciliation/materialization slices.
 */
export async function planLegacyMarkdownImport(
  vault:
    VaultReader,
  allocator:
    LegacyImportIdentityAllocator,
  options:
    LoadOptions = {},
  priorIdentityMapping:
    LegacyImportIdentityMappingManifest | null =
      null,
  schemaPlanning:
    LegacyImportSchemaPlanningInput | null =
      null,
): Promise<
  LegacyImportPlan
> {
  const loaded =
    await loadVaultState(
      vault,
      options,
    );

  const candidates =
    sortedCandidates(
      loaded.physicalCandidates,
    );

  const priorMapping =
    normalizeIdentityMapping(
      priorIdentityMapping,
    );

  const reconciledByPhysical =
    new Map<
      string,
      LegacyImportIdentityMappingEntry
    >();

  const claimedCanonicalIds =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const entry
    of priorMapping.entries
  ) {
    const candidateKey =
      physicalKey(
        entry.kind,
        entry.sourcePath,
      );

    reconciledByPhysical.set(
      candidateKey,
      entry,
    );

    claimedCanonicalIds.set(
      entry.recordId,
      candidateKey,
    );
  }

  const aliasCounts =
    new Map<
      string,
      number
    >();

  for (
    const candidate
    of candidates
  ) {
    const aliasKey =
      mappingKey(
        candidate.kind,
        candidate.legacyId,
      );

    aliasCounts.set(
      aliasKey,
      (
        aliasCounts.get(
          aliasKey,
        )
        ?? 0
      ) + 1,
    );
  }

  const mappings:
    LegacyImportIdentityPlan[] =
      [];

  for (
    const candidate
    of candidates
  ) {
    const candidateKey =
      physicalKey(
        candidate.kind,
        candidate.source.path,
      );

    const prior =
      reconciledByPhysical.get(
        candidateKey,
      );

    const request:
      LegacyImportIdentityRequest = {
        kind:
          candidate.kind,
        legacyId:
          candidate.legacyId,
        sourcePath:
          candidate.source.path,
        sourceRevision:
          candidate.source.revision,
        idOrigin:
          candidate.source.idOrigin,
      };

    const recordId =
      prior
        ? parseOpaqueRecordId(
            prior.recordId,
          )
        : parseOpaqueRecordId(
            allocator
              .recordIdFor(
                request,
              ),
          );

    const existing =
      claimedCanonicalIds.get(
        recordId,
      );

    if (
      existing !== undefined
      && existing
        !== candidateKey
    ) {
      throw new Error(
        `Import identity allocator reused canonical record id ${recordId} for ${request.sourcePath}; already assigned to ${existing}.`,
      );
    }

    const assignment =
      pairCanonicalWithLegacyProvenance(
        defineCanonicalRecordHeader({
          kind:
            candidate.kind,
          id:
            recordId,
          name:
            candidate.name,
        }),
        defineLegacyImportProvenance(
          candidate.source.path,
          [
            {
              value:
                candidate.legacyId,
              origin:
                candidate.source
                  .idOrigin,
            },
          ],
        ),
      );

    const mappingEntry:
      LegacyImportIdentityMappingEntry = {
        kind:
          candidate.kind,
        sourcePath:
          candidate.source.path,
        sourceRevision:
          candidate.source.revision,
        idOrigin:
          candidate.source.idOrigin,
        legacyId:
          candidate.legacyId,
        recordId:
          assignment.record.id,
      };

    reconciledByPhysical.set(
      candidateKey,
      mappingEntry,
    );

    claimedCanonicalIds.set(
      assignment.record.id,
      candidateKey,
    );

    mappings.push({
      kind:
        candidate.kind,
      legacyId:
        candidate.legacyId,
      recordId:
        assignment
          .record
          .id,
      name:
        assignment
          .record
          .name,
      source: {
        path:
          assignment
            .provenance
            .sourcePath,
        revision:
          candidate.source
            .revision,
        idOrigin:
          candidate.source
            .idOrigin,
      },
      disposition:
        (
          aliasCounts.get(
            mappingKey(
              candidate.kind,
              candidate.legacyId,
            ),
          )
          ?? 0
        ) > 1
          ? 'duplicate-alias-collision'
          : 'candidate',
    });
  }

  const identityMapping:
    LegacyImportIdentityMappingManifest = {
      schemaVersion:
        LEGACY_IMPORT_IDENTITY_MAPPING_SCHEMA_VERSION,
      entries: [
        ...reconciledByPhysical
          .values(),
      ].sort(
        compareIdentityMappingEntries,
      ),
    };

  const schemaSettings = schemaPlanning === null ? null : planLegacySchemaSettings(
    schemaPlanning,
    [
      ...claimedCanonicalIds.keys(),
    ],
  );

  const mappingByPhysical =
    new Map<
      string,
      LegacyImportIdentityPlan
    >();

  const mappingByLegacy =
    new Map<
      string,
      LegacyImportIdentityPlan[]
    >();

  for (
    const mapping
    of mappings
  ) {
    mappingByPhysical.set(
      physicalKey(
        mapping.kind,
        mapping.source.path,
      ),
      mapping,
    );

    const aliasKey =
      mappingKey(
        mapping.kind,
        mapping.legacyId,
      );

    const existing =
      mappingByLegacy.get(
        aliasKey,
      )
      ?? [];

    existing.push(
      mapping,
    );

    mappingByLegacy.set(
      aliasKey,
      existing,
    );
  }

  const collisions:
    LegacyImportCollisionPlan[] =
      [];

  for (
    const [
      aliasKey,
      aliasMappings,
    ]
    of mappingByLegacy
  ) {
    if (
      aliasMappings.length
      < 2
    ) {
      continue;
    }

    const first =
      aliasMappings[0];

    if (!first) {
      continue;
    }

    collisions.push({
      kind:
        first.kind,
      legacyId:
        first.legacyId,
      candidates:
        aliasMappings
          .map(
            (mapping) => ({
              recordId:
                mapping.recordId,
              sourcePath:
                mapping.source.path,
              sourceRevision:
                mapping.source
                  .revision,
              idOrigin:
                mapping.source
                  .idOrigin,
            }),
          )
          .sort(
            (left, right) =>
              left.sourcePath
                .localeCompare(
                  right.sourcePath,
                ),
          ),
    });

    void aliasKey;
  }

  collisions.sort(
    (left, right) =>
      KIND_ORDER[left.kind]
      - KIND_ORDER[right.kind]
      || left.legacyId
        .localeCompare(
          right.legacyId,
        ),
  );

  const projectReferences:
    LegacyImportProjectReferencePlan[] =
      [];

  for (
    const candidate
    of candidates
  ) {
    if (
      candidate.kind
      === 'project'
      || candidate.projectId
        === null
    ) {
      continue;
    }

    const sourceMapping =
      mappingByPhysical.get(
        physicalKey(
          candidate.kind,
          candidate.source.path,
        ),
      );

    if (!sourceMapping) {
      throw new Error(
        `Import planner lost identity mapping for ${candidate.kind} ${candidate.source.path}.`,
      );
    }

    const projectMappings =
      mappingByLegacy.get(
        mappingKey(
          'project',
          candidate.projectId,
        ),
      )
      ?? [];

    if (
      projectMappings.length
      === 0
    ) {
      projectReferences.push({
        sourceKind:
          candidate.kind,
        sourceLegacyId:
          candidate.legacyId,
        sourceRecordId:
          sourceMapping.recordId,
        legacyProjectId:
          candidate.projectId,
        projectRecordId:
          null,
        resolution:
          'missing',
      });

      continue;
    }

    if (
      projectMappings.length
      > 1
    ) {
      projectReferences.push({
        sourceKind:
          candidate.kind,
        sourceLegacyId:
          candidate.legacyId,
        sourceRecordId:
          sourceMapping.recordId,
        legacyProjectId:
          candidate.projectId,
        projectRecordId:
          null,
        candidateProjectRecordIds:
          projectMappings
            .map(
              (mapping) =>
                mapping.recordId,
            ),
        resolution:
          'ambiguous',
      });

      continue;
    }

    const projectMapping =
      projectMappings[0];

    if (!projectMapping) {
      throw new Error(
        `Import planner lost the sole project mapping for ${candidate.projectId}.`,
      );
    }

    projectReferences.push({
      sourceKind:
        candidate.kind,
      sourceLegacyId:
        candidate.legacyId,
      sourceRecordId:
        sourceMapping
          .recordId,
      legacyProjectId:
        candidate.projectId,
      projectRecordId:
        projectMapping.recordId,
      resolution:
        'resolved',
    });
  }

  const projectReferenceBySourceRecordId =
    new Map(
      projectReferences.map(
        (reference) => [
          reference.sourceRecordId,
          reference,
        ] as const,
      ),
    );

  const statusNameById =
    new Map(
      loaded.state.statuses.map(
        (status) => [
          status.id,
          status.name,
        ] as const,
      ),
    );

  const conversions:
    LegacyImportConversionPlan[] =
      [];

  for (
    const candidate
    of candidates
  ) {
    const mapping =
      mappingByPhysical.get(
        physicalKey(
          candidate.kind,
          candidate.source.path,
        ),
      );

    if (!mapping) {
      throw new Error(
        `Import planner lost conversion identity for ${candidate.kind} ${candidate.source.path}.`,
      );
    }

    if (
      candidate.kind
      === 'project'
    ) {
      const legacyProjectType =
        candidate.compatibility
          .projectType;

      if (
        legacyProjectType
        === null
      ) {
        throw new Error(
          `Import planner lost interpreted project type for ${candidate.source.path}.`,
        );
      }

      conversions.push({
        kind: 'project',
        recordId:
          mapping.recordId,
        sourcePath:
          candidate.source.path,
        legacyProjectType,
        disposition:
          'compatibility-import-metadata-only',
        canonicalCapabilityAuthority:
          'associated-data-and-workspace',
      });

      continue;
    }

    if (
      candidate.kind
      === 'event'
    ) {
      conversions.push({
        kind: 'event',
        recordId:
          mapping.recordId,
        sourcePath:
          candidate.source.path,
      });

      continue;
    }

    const legacyStatusId =
      candidate.compatibility
        .taskStatus;

    const legacyOrderIndex =
      candidate.compatibility
        .taskOrderIndex;

    const executionState =
      candidate.compatibility
        .taskExecutionState;

    if (
      legacyStatusId
        === null
      || legacyOrderIndex
        === null
      || executionState
        === null
    ) {
      throw new Error(
        `Import planner lost interpreted task conversion input for ${candidate.source.path}.`,
      );
    }

    const canonicalExecutionState:
      CanonicalExecutionState =
        executionState;

    const suggestedName =
      statusNameById.get(
        legacyStatusId,
      )
      ?? legacyStatusId;

    const projectReference =
      projectReferenceBySourceRecordId.get(
        mapping.recordId,
      );

    let workflowStage:
      LegacyImportWorkflowStagePlan;

    if (
      candidate.projectId
      === null
    ) {
      workflowStage = {
        resolution:
          'none',
        legacyStatusId,
        suggestedName,
        projectRecordId:
          null,
      };
    } else if (
      !projectReference
    ) {
      throw new Error(
        `Import planner lost project-reference conversion input for ${candidate.source.path}.`,
      );
    } else if (
      projectReference.resolution
      === 'resolved'
    ) {
      if (
        projectReference
          .projectRecordId
        === null
      ) {
        throw new Error(
          `Import planner received a resolved project reference without a canonical project id for ${candidate.source.path}.`,
        );
      }

      workflowStage = {
        resolution:
          'candidate',
        legacyStatusId,
        suggestedName,
        projectRecordId:
          projectReference
            .projectRecordId,
      };
    } else if (
      projectReference.resolution
      === 'ambiguous'
    ) {
      workflowStage = {
        resolution:
          'ambiguous-project',
        legacyStatusId,
        suggestedName,
        projectRecordId:
          null,
        candidateProjectRecordIds:
          projectReference
            .candidateProjectRecordIds
          ?? [],
      };
    } else {
      workflowStage = {
        resolution:
          'missing-project',
        legacyStatusId,
        suggestedName,
        projectRecordId:
          null,
      };
    }

    const position =
      canonicalOrderPosition(
        legacyOrderIndex,
      );

    conversions.push({
      kind: 'task',
      recordId:
        mapping.recordId,
      sourcePath:
        candidate.source.path,
      legacyStatusId,
      executionState:
        canonicalExecutionState,
      workflowStage,
      scopedOrders: {
        execution: {
          scope: {
            kind:
              'elastic-execution',
            executionState:
              canonicalExecutionState,
          },
          position,
        },
        workflow:
          workflowStage.resolution
          === 'candidate'
            ? {
                scope: {
                  kind:
                    'project-workflow-stage-candidate',
                  projectRecordId:
                    workflowStage
                      .projectRecordId,
                  legacyStatusId,
                },
                position,
              }
            : null,
      },
    });
  }

  const problems:
    LegacyImportProblemPlan[] =
      loaded.problems.map(
        (problem) => ({
          code:
            problem.code,
          severity:
            problem.severity,
          sourcePath:
            problem.path,
          kind:
            problem.kind
            ?? null,
          legacyId:
            problem.id
            ?? null,
          diagnostic:
            problem.detail,
          disposition:
            problem.code
              === 'unsupported-frontmatter'
              ? 'unsupported-frontmatter-policy-pending'
              : 'reader-problem',
        }),
      );

  return {
    schemaVersion:
      LEGACY_IMPORT_PLAN_SCHEMA_VERSION,
    mode:
      'dry-run',
    source:
      'legacy-markdown-compatibility-reader',

    mappings,
    identityMapping,
    collisions,
    conversions,
    schemaSettings,
    projectReferences,
    problems,

    census:
      cloneCensus(
        loaded.census,
      ),

    counts: {
      projects:
        loaded.state
          .projects
          .length,
      tasks:
        loaded.state
          .tasks
          .length,
      events:
        loaded.state
          .events
          .length,
      physicalCandidates:
        candidates.length,
      mappings:
        mappings.length,
      collisions:
        collisions.length,
      projectReferences:
        projectReferences.length,
      unresolvedProjectReferences:
        projectReferences
          .filter(
            (reference) =>
              reference.resolution
              !== 'resolved',
          )
          .length,
      ambiguousProjectReferences:
        projectReferences
          .filter(
            (reference) =>
              reference.resolution
              === 'ambiguous',
          )
          .length,
      readerProblems:
        problems.length,
      unsupportedFrontmatter:
        problems
          .filter(
            (problem) =>
              problem.code
              === 'unsupported-frontmatter',
          )
          .length,
    },

    writes: {
      legacyMarkdown: 0,
      recordStore: 0,
      staging: 0,
    },
  };
}
