import {
  encodeCanonicalRecordV2,
  type CanonicalRecordV2,
} from '../domain/canonicalRecordV2.js';
import {
  defineCanonicalRecordHeader,
  parseOpaqueRecordId,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import type {
  CanonicalWorkflowStageStateRecord,
} from '../domain/canonicalTaskState.js';
import type {
  LegacyImportPlan,
  LegacyImportTaskConversionPlan,
} from './importPlanner.js';
import type {
  LegacyImportStagingStore,
} from './importStagingPlanner.js';

export const LEGACY_IMPORT_WORKFLOW_STAGE_IDENTITY_MAPPING_SCHEMA_VERSION =
  1 as const;

export const LEGACY_IMPORT_WORKFLOW_STAGE_STAGING_RESULT_SCHEMA_VERSION =
  1 as const;

export interface LegacyImportWorkflowStageIdentityRequest {
  readonly projectRecordId:
    OpaqueRecordId;
  readonly legacyStatusId:
    string;
  readonly suggestedName:
    string;
}

export interface LegacyImportWorkflowStageIdentityAllocator {
  workflowStageRecordIdFor(
    request:
      LegacyImportWorkflowStageIdentityRequest,
  ): string;
}

export interface LegacyImportWorkflowStageIdentityMappingEntry {
  readonly projectRecordId:
    OpaqueRecordId;
  readonly legacyStatusId:
    string;
  readonly recordId:
    OpaqueRecordId;
}

export interface LegacyImportWorkflowStageIdentityMappingManifest {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_WORKFLOW_STAGE_IDENTITY_MAPPING_SCHEMA_VERSION;
  readonly reconciliationKey:
    'project-record-id+legacy-status-id';
  readonly entries:
    readonly LegacyImportWorkflowStageIdentityMappingEntry[];
}

export interface LegacyImportWorkflowStageIdentityMappingStore {
  load():
    Promise<
      LegacyImportWorkflowStageIdentityMappingManifest | null
    >;

  /**
   * Resolution means the supplied mapping is durably stored.
   *
   * The staging materializer calls this before creating any newly mapped
   * workflow-stage record so interruption cannot lose the assigned identity.
   */
  save(
    mapping:
      LegacyImportWorkflowStageIdentityMappingManifest,
  ): Promise<void>;
}

export type LegacyImportWorkflowStageStagingBlocker =
  | {
      readonly reason:
        'workflow-stage-project-unresolved';
      readonly taskRecordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly legacyStatusId:
        string;
      readonly resolution:
        'missing-project'
        | 'ambiguous-project';
      readonly candidateProjectRecordIds:
        readonly OpaqueRecordId[];
    }
  | {
      readonly reason:
        'workflow-stage-name-conflict';
      readonly projectRecordId:
        OpaqueRecordId;
      readonly legacyStatusId:
        string;
      readonly suggestedNames:
        readonly string[];
    }
  | {
      readonly reason:
        'staging-record-conflict';
      readonly projectRecordId:
        OpaqueRecordId;
      readonly legacyStatusId:
        string;
      readonly recordId:
        OpaqueRecordId;
    };

export interface LegacyImportStagedWorkflowStageRecord {
  readonly projectRecordId:
    OpaqueRecordId;
  readonly legacyStatusId:
    string;
  readonly recordId:
    OpaqueRecordId;
  readonly outcome:
    | 'created'
    | 'reused-identical';
  readonly record:
    CanonicalWorkflowStageStateRecord;
}

export interface LegacyImportWorkflowStageStagingResult {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_WORKFLOW_STAGE_STAGING_RESULT_SCHEMA_VERSION;
  readonly mode:
    'staging-materialization';
  readonly source:
    'legacy-import-task-workflow-stage-candidates';
  readonly scope:
    'workflow-stage-records-only';
  readonly activation:
    'not-performed';

  readonly identityMapping:
    LegacyImportWorkflowStageIdentityMappingManifest;

  readonly staged:
    readonly LegacyImportStagedWorkflowStageRecord[];

  readonly blockers:
    readonly LegacyImportWorkflowStageStagingBlocker[];

  readonly counts: {
    readonly candidateStageKeys:
      number;
    readonly reservedStageIdentities:
      number;
    readonly created:
      number;
    readonly reusedIdentical:
      number;
    readonly blocked:
      number;
  };

  readonly writes: {
    readonly legacyMarkdown:
      0;
    readonly recordStore:
      0;
    readonly staging:
      number;
    readonly identityMapping:
      0 | 1;
    readonly externalArtifacts:
      0;
    readonly activation:
      0;
  };
}

interface WorkflowStageCandidate {
  readonly projectRecordId:
    OpaqueRecordId;
  readonly legacyStatusId:
    string;
  readonly suggestedName:
    string;
}

function stageKey(
  projectRecordId:
    OpaqueRecordId,
  legacyStatusId:
    string,
): string {
  return JSON.stringify([
    projectRecordId,
    legacyStatusId,
  ]);
}

function compareStageKey(
  left:
    {
      readonly projectRecordId:
        OpaqueRecordId;
      readonly legacyStatusId:
        string;
    },
  right:
    {
      readonly projectRecordId:
        OpaqueRecordId;
      readonly legacyStatusId:
        string;
    },
): number {
  return left.projectRecordId
    .localeCompare(
      right.projectRecordId,
    )
    || left.legacyStatusId
      .localeCompare(
        right.legacyStatusId,
      );
}

function normalizeIdentityMapping(
  value:
    LegacyImportWorkflowStageIdentityMappingManifest | null,
): LegacyImportWorkflowStageIdentityMappingManifest {
  if (
    value === null
  ) {
    return {
      schemaVersion:
        LEGACY_IMPORT_WORKFLOW_STAGE_IDENTITY_MAPPING_SCHEMA_VERSION,
      reconciliationKey:
        'project-record-id+legacy-status-id',
      entries: [],
    };
  }

  if (
    value.schemaVersion
    !== LEGACY_IMPORT_WORKFLOW_STAGE_IDENTITY_MAPPING_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported workflow-stage import identity mapping schema: ${String(value.schemaVersion)}`,
    );
  }

  if (
    value.reconciliationKey
    !== 'project-record-id+legacy-status-id'
  ) {
    throw new Error(
      `Unsupported workflow-stage import reconciliation key: ${String(value.reconciliationKey)}`,
    );
  }

  const keySet =
    new Set<
      string
    >();

  const keyByRecordId =
    new Map<
      OpaqueRecordId,
      string
    >();

  const entries =
    value.entries
      .map(
        (entry) => {
          const projectRecordId =
            parseOpaqueRecordId(
              entry.projectRecordId,
            );

          const recordId =
            parseOpaqueRecordId(
              entry.recordId,
            );

          if (
            entry.legacyStatusId
              .trim()
              .length
            === 0
          ) {
            throw new Error(
              'Workflow-stage import identity mapping needs a non-empty legacy status id.',
            );
          }

          return {
            projectRecordId,
            legacyStatusId:
              entry.legacyStatusId,
            recordId,
          };
        },
      )
      .sort(
        compareStageKey,
      );

  for (
    const entry
    of entries
  ) {
    const key =
      stageKey(
        entry.projectRecordId,
        entry.legacyStatusId,
      );

    if (
      keySet.has(
        key,
      )
    ) {
      throw new Error(
        `Workflow-stage import identity mapping contains duplicate stage key ${key}.`,
      );
    }

    const existingKey =
      keyByRecordId.get(
        entry.recordId,
      );

    if (
      existingKey
      !== undefined
    ) {
      throw new Error(
        `Workflow-stage import identity mapping reuses workflow-stage record id ${entry.recordId} for ${key}; already assigned to ${existingKey}.`,
      );
    }

    keySet.add(
      key,
    );

    keyByRecordId.set(
      entry.recordId,
      key,
    );
  }

  return {
    schemaVersion:
      LEGACY_IMPORT_WORKFLOW_STAGE_IDENTITY_MAPPING_SCHEMA_VERSION,
    reconciliationKey:
      'project-record-id+legacy-status-id',
    entries,
  };
}

function canonicalRecordText(
  record:
    CanonicalRecordV2,
): string {
  return JSON.stringify(
    encodeCanonicalRecordV2(
      record,
    ),
  );
}

function sameCanonicalRecord(
  left:
    CanonicalRecordV2,
  right:
    CanonicalRecordV2,
): boolean {
  return canonicalRecordText(
    left,
  ) === canonicalRecordText(
    right,
  );
}

function taskConversions(
  plan:
    LegacyImportPlan,
): readonly LegacyImportTaskConversionPlan[] {
  return plan.conversions.filter(
    (
      conversion,
    ): conversion is LegacyImportTaskConversionPlan =>
      conversion.kind
      === 'task',
  );
}

function reservedCanonicalRecordIds(
  plan:
    LegacyImportPlan,
): Set<
  OpaqueRecordId
> {
  const ids =
    new Set<
      OpaqueRecordId
    >();

  for (
    const mapping
    of plan.mappings
  ) {
    ids.add(
      mapping.recordId,
    );
  }

  if (
    plan.schemaSettings
    !== null
  ) {
    for (
      const entry
      of plan.schemaSettings
        .identityMapping
        .schemaEntries
    ) {
      ids.add(
        entry.recordId,
      );
    }
  }

  return ids;
}

function collectWorkflowStages(
  plan:
    LegacyImportPlan,
): {
  readonly candidates:
    WorkflowStageCandidate[];
  readonly blockers:
    LegacyImportWorkflowStageStagingBlocker[];
} {
  const byKey =
    new Map<
      string,
      WorkflowStageCandidate
    >();

  const conflictingNames =
    new Map<
      string,
      Set<
        string
      >
    >();

  const blockers:
    LegacyImportWorkflowStageStagingBlocker[] =
      [];

  for (
    const task
    of taskConversions(
      plan,
    )
  ) {
    const workflowStage =
      task.workflowStage;

    if (
      workflowStage.resolution
      === 'none'
    ) {
      continue;
    }

    if (
      workflowStage.resolution
      === 'missing-project'
      || workflowStage.resolution
      === 'ambiguous-project'
    ) {
      blockers.push({
        reason:
          'workflow-stage-project-unresolved',
        taskRecordId:
          task.recordId,
        sourcePath:
          task.sourcePath,
        legacyStatusId:
          workflowStage.legacyStatusId,
        resolution:
          workflowStage.resolution,
        candidateProjectRecordIds:
          workflowStage.resolution
          === 'ambiguous-project'
            ? [
                ...workflowStage
                  .candidateProjectRecordIds,
              ]
            : [],
      });

      continue;
    }

    const key =
      stageKey(
        workflowStage
          .projectRecordId,
        workflowStage
          .legacyStatusId,
      );

    const candidate:
      WorkflowStageCandidate = {
        projectRecordId:
          workflowStage
            .projectRecordId,
        legacyStatusId:
          workflowStage
            .legacyStatusId,
        suggestedName:
          workflowStage
            .suggestedName,
      };

    const existing =
      byKey.get(
        key,
      );

    if (
      existing
      === undefined
    ) {
      byKey.set(
        key,
        candidate,
      );

      continue;
    }

    if (
      existing.suggestedName
      === candidate.suggestedName
    ) {
      continue;
    }

    let names =
      conflictingNames.get(
        key,
      );

    if (
      names
      === undefined
    ) {
      names =
        new Set([
          existing.suggestedName,
        ]);

      conflictingNames.set(
        key,
        names,
      );
    }

    names.add(
      candidate.suggestedName,
    );
  }

  for (
    const [
      key,
      names,
    ]
    of conflictingNames
      .entries()
  ) {
    const candidate =
      byKey.get(
        key,
      );

    if (
      candidate
      === undefined
    ) {
      throw new Error(
        `Workflow-stage import staging lost conflicting candidate ${key}.`,
      );
    }

    byKey.delete(
      key,
    );

    blockers.push({
      reason:
        'workflow-stage-name-conflict',
      projectRecordId:
        candidate.projectRecordId,
      legacyStatusId:
        candidate.legacyStatusId,
      suggestedNames:
        [
          ...names,
        ].sort(),
    });
  }

  const candidates =
    [
      ...byKey
        .values(),
    ].sort(
      compareStageKey,
    );

  blockers.sort(
    (
      left,
      right,
    ) => {
      if (
        left.reason
        === 'workflow-stage-project-unresolved'
        && right.reason
        === 'workflow-stage-project-unresolved'
      ) {
        return left.sourcePath
          .localeCompare(
            right.sourcePath,
          );
      }

      const leftProjectId =
        'projectRecordId'
        in left
          ? left.projectRecordId
          : '';

      const rightProjectId =
        'projectRecordId'
        in right
          ? right.projectRecordId
          : '';

      return leftProjectId
        .localeCompare(
          rightProjectId,
        )
        || left.reason
          .localeCompare(
            right.reason,
          );
    },
  );

  return {
    candidates,
    blockers,
  };
}

function defineWorkflowStageRecord(
  candidate:
    WorkflowStageCandidate,
  recordId:
    OpaqueRecordId,
): CanonicalWorkflowStageStateRecord {
  return encodeCanonicalRecordV2({
    ...defineCanonicalRecordHeader({
      kind:
        'workflow-stage',
      id:
        recordId,
      name:
        candidate.suggestedName,
    }),
    projectId:
      candidate.projectRecordId,
  }) as CanonicalWorkflowStageStateRecord;
}

function assertDryRunInput(
  plan:
    LegacyImportPlan,
): void {
  if (
    plan.mode
    !== 'dry-run'
    || plan.writes
      .legacyMarkdown
      !== 0
    || plan.writes
      .recordStore
      !== 0
    || plan.writes
      .staging
      !== 0
  ) {
    throw new Error(
      'Workflow-stage import staging accepts only a zero-write dry-run import plan.',
    );
  }
}

export async function materializeLegacyImportWorkflowStageStaging(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportStagingStore,
  allocator:
    LegacyImportWorkflowStageIdentityAllocator,
  identityStore:
    LegacyImportWorkflowStageIdentityMappingStore,
): Promise<
  LegacyImportWorkflowStageStagingResult
> {
  assertDryRunInput(
    plan,
  );

  if (
    store.authority
    !== 'legacy-import-staging-only'
  ) {
    throw new Error(
      'Workflow-stage import staging received a store without staging-only authority.',
    );
  }

  const collected =
    collectWorkflowStages(
      plan,
    );

  const prior =
    normalizeIdentityMapping(
      await identityStore.load(),
    );

  const entries:
    LegacyImportWorkflowStageIdentityMappingEntry[] =
      prior.entries.map(
        (entry) => ({
          ...entry,
        }),
      );

  const entryByKey =
    new Map<
      string,
      LegacyImportWorkflowStageIdentityMappingEntry
    >();

  const keyByRecordId =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const entry
    of entries
  ) {
    const key =
      stageKey(
        entry.projectRecordId,
        entry.legacyStatusId,
      );

    entryByKey.set(
      key,
      entry,
    );

    keyByRecordId.set(
      entry.recordId,
      key,
    );
  }

  const reservedIds =
    reservedCanonicalRecordIds(
      plan,
    );

  for (
    const entry
    of entries
  ) {
    if (
      reservedIds.has(
        entry.recordId,
      )
    ) {
      throw new Error(
        `Workflow-stage import identity ${entry.recordId} collides with reserved canonical import record identity.`,
      );
    }
  }

  let mappingChanged =
    false;

  for (
    const candidate
    of collected.candidates
  ) {
    const key =
      stageKey(
        candidate.projectRecordId,
        candidate.legacyStatusId,
      );

    if (
      entryByKey.has(
        key,
      )
    ) {
      continue;
    }

    const recordId =
      parseOpaqueRecordId(
        allocator
          .workflowStageRecordIdFor({
            projectRecordId:
              candidate.projectRecordId,
            legacyStatusId:
              candidate.legacyStatusId,
            suggestedName:
              candidate.suggestedName,
          }),
      );

    if (
      reservedIds.has(
        recordId,
      )
    ) {
      throw new Error(
        `Workflow-stage import identity allocator produced ${recordId}, which collides with reserved canonical import record identity.`,
      );
    }

    const existingKey =
      keyByRecordId.get(
        recordId,
      );

    if (
      existingKey
      !== undefined
      && existingKey
      !== key
    ) {
      throw new Error(
        `Workflow-stage import identity allocator reused workflow-stage record id ${recordId} for ${key}; already assigned to ${existingKey}.`,
      );
    }

    const entry:
      LegacyImportWorkflowStageIdentityMappingEntry = {
        projectRecordId:
          candidate.projectRecordId,
        legacyStatusId:
          candidate.legacyStatusId,
        recordId,
      };

    entries.push(
      entry,
    );

    entryByKey.set(
      key,
      entry,
    );

    keyByRecordId.set(
      recordId,
      key,
    );

    mappingChanged =
      true;
  }

  entries.sort(
    compareStageKey,
  );

  const identityMapping:
    LegacyImportWorkflowStageIdentityMappingManifest = {
      schemaVersion:
        LEGACY_IMPORT_WORKFLOW_STAGE_IDENTITY_MAPPING_SCHEMA_VERSION,
      reconciliationKey:
        'project-record-id+legacy-status-id',
      entries,
    };

  if (
    mappingChanged
  ) {
    await identityStore.save(
      identityMapping,
    );
  }

  const staged:
    LegacyImportStagedWorkflowStageRecord[] =
      [];

  const blockers:
    LegacyImportWorkflowStageStagingBlocker[] = [
      ...collected.blockers,
    ];

  let created = 0;
  let reusedIdentical = 0;

  for (
    const candidate
    of collected.candidates
  ) {
    const key =
      stageKey(
        candidate.projectRecordId,
        candidate.legacyStatusId,
      );

    const identity =
      entryByKey.get(
        key,
      );

    if (
      identity
      === undefined
    ) {
      throw new Error(
        `Workflow-stage import staging lost durable identity for ${key}.`,
      );
    }

    const record =
      defineWorkflowStageRecord(
        candidate,
        identity.recordId,
      );

    const existing =
      await store
        .readStagedRecord(
          identity.recordId,
        );

    if (
      existing
      !== null
    ) {
      if (
        sameCanonicalRecord(
          existing,
          record,
        )
      ) {
        reusedIdentical += 1;

        staged.push({
          projectRecordId:
            candidate.projectRecordId,
          legacyStatusId:
            candidate.legacyStatusId,
          recordId:
            identity.recordId,
          outcome:
            'reused-identical',
          record,
        });

        continue;
      }

      blockers.push({
        reason:
          'staging-record-conflict',
        projectRecordId:
          candidate.projectRecordId,
        legacyStatusId:
          candidate.legacyStatusId,
        recordId:
          identity.recordId,
      });

      continue;
    }

    const creation =
      await store
        .createStagedRecord(
          record,
        );

    if (
      creation.ok
    ) {
      created += 1;

      staged.push({
        projectRecordId:
          candidate.projectRecordId,
        legacyStatusId:
          candidate.legacyStatusId,
        recordId:
          identity.recordId,
        outcome:
          'created',
        record,
      });

      continue;
    }

    const raced =
      await store
        .readStagedRecord(
          identity.recordId,
        );

    if (
      raced
      === null
    ) {
      throw new Error(
        `Workflow-stage staging store reported an existing record but returned no staged record for ${identity.recordId}.`,
      );
    }

    if (
      sameCanonicalRecord(
        raced,
        record,
      )
    ) {
      reusedIdentical += 1;

      staged.push({
        projectRecordId:
          candidate.projectRecordId,
        legacyStatusId:
          candidate.legacyStatusId,
        recordId:
          identity.recordId,
        outcome:
          'reused-identical',
        record,
      });

      continue;
    }

    blockers.push({
      reason:
        'staging-record-conflict',
      projectRecordId:
        candidate.projectRecordId,
      legacyStatusId:
        candidate.legacyStatusId,
      recordId:
        identity.recordId,
    });
  }

  staged.sort(
    (
      left,
      right,
    ) =>
      compareStageKey(
        left,
        right,
      ),
  );

  blockers.sort(
    (
      left,
      right,
    ) => {
      if (
        left.reason
        === 'workflow-stage-project-unresolved'
        && right.reason
        === 'workflow-stage-project-unresolved'
      ) {
        return left.sourcePath
          .localeCompare(
            right.sourcePath,
          );
      }

      const leftProjectId =
        'projectRecordId'
        in left
          ? left.projectRecordId
          : '';

      const rightProjectId =
        'projectRecordId'
        in right
          ? right.projectRecordId
          : '';

      return leftProjectId
        .localeCompare(
          rightProjectId,
        )
        || left.reason
          .localeCompare(
            right.reason,
          );
    },
  );

  return {
    schemaVersion:
      LEGACY_IMPORT_WORKFLOW_STAGE_STAGING_RESULT_SCHEMA_VERSION,
    mode:
      'staging-materialization',
    source:
      'legacy-import-task-workflow-stage-candidates',
    scope:
      'workflow-stage-records-only',
    activation:
      'not-performed',

    identityMapping,

    staged,
    blockers,

    counts: {
      candidateStageKeys:
        collected.candidates
          .length,
      reservedStageIdentities:
        identityMapping
          .entries
          .length,
      created,
      reusedIdentical,
      blocked:
        blockers.length,
    },

    writes: {
      legacyMarkdown: 0,
      recordStore: 0,
      staging:
        created,
      identityMapping:
        mappingChanged
          ? 1
          : 0,
      externalArtifacts: 0,
      activation: 0,
    },
  };
}
