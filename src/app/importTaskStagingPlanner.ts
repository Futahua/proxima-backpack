import {
  defineCanonicalRecordHeader,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import {
  encodeCanonicalRecordV2,
  type CanonicalRecordV2,
  type CanonicalStoredPropertyValues,
  type CanonicalTaskRecordV2,
} from '../domain/canonicalRecordV2.js';
import type {
  LegacyImportPropertyValueConversion,
  LegacyImportRecordPropertyValuePlan,
} from './importPropertyPlanner.js';
import type {
  LegacyImportPlan,
  LegacyImportTaskConversionPlan,
} from './importPlanner.js';
import type {
  LegacyImportStagingStore,
} from './importStagingPlanner.js';
import type {
  LegacyImportWorkflowStageIdentityMappingManifest,
} from './importWorkflowStageStagingPlanner.js';

export const LEGACY_IMPORT_TASK_STAGING_RESULT_SCHEMA_VERSION =
  1 as const;

export type LegacyImportTaskStagingBlocker =
  | {
      readonly reason:
        'malformed-task';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    }
  | {
      readonly reason:
        'unsupported-frontmatter-policy-pending';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    }
  | {
      readonly reason:
        'project-reference-unresolved';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly resolution:
        'missing-project'
        | 'ambiguous-project';
    }
  | {
      readonly reason:
        'project-record-missing';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly projectRecordId:
        OpaqueRecordId;
    }
  | {
      readonly reason:
        'project-record-incompatible';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly projectRecordId:
        OpaqueRecordId;
    }
  | {
      readonly reason:
        'workflow-stage-identity-missing';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly projectRecordId:
        OpaqueRecordId;
      readonly legacyStatusId:
        string;
    }
  | {
      readonly reason:
        'workflow-stage-record-missing';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly workflowStageId:
        OpaqueRecordId;
    }
  | {
      readonly reason:
        'workflow-stage-record-incompatible';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly workflowStageId:
        OpaqueRecordId;
    }
  | {
      readonly reason:
        'property-value-plan-missing';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    }
  | {
      readonly reason:
        'property-value-record-missing';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    }
  | {
      readonly reason:
        'property-value-unresolved';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly schemaRecordIds:
        readonly OpaqueRecordId[];
    }
  | {
      readonly reason:
        'staging-record-conflict';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    };

export interface LegacyImportStagedTaskRecord {
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly outcome:
    | 'created'
    | 'reused-identical';
  readonly record:
    CanonicalTaskRecordV2;
}

export interface LegacyImportTaskStagingResult {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_TASK_STAGING_RESULT_SCHEMA_VERSION;
  readonly mode:
    'staging-materialization';
  readonly source:
    'legacy-import-task-conversions';
  readonly scope:
    'task-records-only';
  readonly activation:
    'not-performed';

  readonly staged:
    readonly LegacyImportStagedTaskRecord[];

  readonly blockers:
    readonly LegacyImportTaskStagingBlocker[];

  readonly counts: {
    readonly taskCandidates:
      number;
    readonly eligibleTaskRecords:
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
    readonly externalArtifacts:
      0;
    readonly activation:
      0;
  };
}

interface ResolvedTaskCandidate {
  readonly conversion:
    LegacyImportTaskConversionPlan;
  readonly projectId:
    OpaqueRecordId | null;
  readonly workflowStageId:
    OpaqueRecordId | null;
  readonly properties:
    CanonicalStoredPropertyValues;
}

function taskConversions(
  plan:
    LegacyImportPlan,
): LegacyImportTaskConversionPlan[] {
  return plan.conversions
    .filter(
      (
        conversion,
      ): conversion is LegacyImportTaskConversionPlan =>
        conversion.kind
        === 'task',
    )
    .sort(
      (
        left,
        right,
      ) =>
        left.sourcePath
          .localeCompare(
            right.sourcePath,
          ),
    );
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

function workflowIdentityByKey(
  mapping:
    LegacyImportWorkflowStageIdentityMappingManifest,
): Map<
  string,
  OpaqueRecordId
> {
  if (
    mapping.schemaVersion
      !== 1
    || mapping.reconciliationKey
      !== 'project-record-id+legacy-status-id'
  ) {
    throw new Error(
      'Task staging received an incompatible workflow-stage identity mapping.',
    );
  }

  const byKey =
    new Map<
      string,
      OpaqueRecordId
    >();

  const keyByRecordId =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const entry
    of mapping.entries
  ) {
    const key =
      stageKey(
        entry.projectRecordId,
        entry.legacyStatusId,
      );

    if (
      byKey.has(
        key,
      )
    ) {
      throw new Error(
        `Task staging received duplicate workflow-stage identity key ${key}.`,
      );
    }

    const priorKey =
      keyByRecordId.get(
        entry.recordId,
      );

    if (
      priorKey
      !== undefined
      && priorKey
        !== key
    ) {
      throw new Error(
        `Task staging received workflow-stage record id ${entry.recordId} for multiple stage keys.`,
      );
    }

    byKey.set(
      key,
      entry.recordId,
    );

    keyByRecordId.set(
      entry.recordId,
      key,
    );
  }

  return byKey;
}

function taskProblemReason(
  plan:
    LegacyImportPlan,
  conversion:
    LegacyImportTaskConversionPlan,
):
  | 'malformed-task'
  | 'unsupported-frontmatter-policy-pending'
  | null {
  const problems =
    plan.problems.filter(
      (problem) =>
        problem.kind
          === 'task'
        && problem.sourcePath
          === conversion.sourcePath,
    );

  if (
    problems.some(
      (problem) =>
        problem.code
        === 'frontmatter-parse-failure',
    )
  ) {
    return 'malformed-task';
  }

  if (
    problems.some(
      (problem) =>
        problem.code
        === 'unsupported-frontmatter',
    )
  ) {
    return 'unsupported-frontmatter-policy-pending';
  }

  return null;
}

function propertyRecordFor(
  plan:
    LegacyImportPlan,
  conversion:
    LegacyImportTaskConversionPlan,
): LegacyImportRecordPropertyValuePlan | null {
  if (
    plan.propertyValues
    === null
  ) {
    return null;
  }

  const matches =
    plan.propertyValues
      .records
      .filter(
        (record) =>
          record.kind
            === 'task'
          && record.recordId
            === conversion.recordId
          && record.sourcePath
            === conversion.sourcePath,
      );

  if (
    matches.length
    > 1
  ) {
    throw new Error(
      `Task staging found duplicate property-value plans for ${conversion.sourcePath}.`,
    );
  }

  return matches[0]
    ?? null;
}

function unresolvedStoredPropertyConversions(
  record:
    LegacyImportRecordPropertyValuePlan,
): LegacyImportPropertyValueConversion[] {
  return record.conversions.filter(
    (conversion) =>
      conversion.disposition
        === 'unresolved'
      || (
        conversion.disposition
          === 'deferred'
        && conversion.reason
          === 'relation-resolution-pending'
      ),
  );
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

function defineTaskRecord(
  candidate:
    ResolvedTaskCandidate,
): CanonicalTaskRecordV2 {
  const conversion =
    candidate.conversion;

  const task:
    CanonicalTaskRecordV2 = {
      ...defineCanonicalRecordHeader({
        kind:
          'task',
        id:
          conversion.recordId,
        name:
          conversion.name,
      }),
      description:
        conversion.description,
      projectId:
        candidate.projectId,
      executionState:
        conversion.executionState,
      workflowStageId:
        candidate.workflowStageId,
      executionOrder:
        conversion.scopedOrders
          .execution
          .position,
      workflowOrder:
        candidate.workflowStageId
          === null
          ? null
          : conversion
              .scopedOrders
              .workflow
              ?.position
            ?? null,
      weight:
        conversion.weight,
      isFixedDuration:
        conversion.isFixedDuration,
      fixedDuration:
        conversion.fixedDuration,
      maxDuration:
        conversion.maxDuration,
      isCompleted:
        conversion.isCompleted,
      createdAt:
        conversion.createdAt,
      startDate:
        conversion.startDate,
      deadline:
        conversion.deadline,
      properties: {
        ...candidate.properties,
      },
      recurrence:
        conversion.recurrence,
    };

  const encoded =
    encodeCanonicalRecordV2(
      task,
    );

  if (
    encoded.kind
    !== 'task'
  ) {
    throw new Error(
      `Task staging codec returned a non-task record for ${conversion.recordId}.`,
    );
  }

  return encoded;
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
      'Task staging accepts only a zero-write dry-run import plan.',
    );
  }
}

async function collectEligibleTasks(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportStagingStore,
  workflowStageIdentities:
    LegacyImportWorkflowStageIdentityMappingManifest,
): Promise<{
  readonly eligible:
    ResolvedTaskCandidate[];
  readonly blockers:
    LegacyImportTaskStagingBlocker[];
}> {
  const stageIds =
    workflowIdentityByKey(
      workflowStageIdentities,
    );

  const eligible:
    ResolvedTaskCandidate[] =
      [];

  const blockers:
    LegacyImportTaskStagingBlocker[] =
      [];

  for (
    const conversion
    of taskConversions(
      plan,
    )
  ) {
    const problemReason =
      taskProblemReason(
        plan,
        conversion,
      );

    if (
      problemReason
      !== null
    ) {
      blockers.push({
        reason:
          problemReason,
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
      });

      continue;
    }

    let projectId:
      OpaqueRecordId | null =
        null;

    let workflowStageId:
      OpaqueRecordId | null =
        null;

    if (
      conversion.workflowStage
        .resolution
      === 'missing-project'
      || conversion.workflowStage
        .resolution
      === 'ambiguous-project'
    ) {
      blockers.push({
        reason:
          'project-reference-unresolved',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
        resolution:
          conversion.workflowStage
            .resolution,
      });

      continue;
    }

    if (
      conversion.workflowStage
        .resolution
      === 'candidate'
    ) {
      projectId =
        conversion.workflowStage
          .projectRecordId;

      const projectRecord =
        await store
          .readStagedRecord(
            projectId,
          );

      if (
        projectRecord
        === null
      ) {
        blockers.push({
          reason:
            'project-record-missing',
          recordId:
            conversion.recordId,
          sourcePath:
            conversion.sourcePath,
          projectRecordId:
            projectId,
        });

        continue;
      }

      if (
        projectRecord.kind
          !== 'project'
        || projectRecord.id
          !== projectId
      ) {
        blockers.push({
          reason:
            'project-record-incompatible',
          recordId:
            conversion.recordId,
          sourcePath:
            conversion.sourcePath,
          projectRecordId:
            projectId,
        });

        continue;
      }

      const key =
        stageKey(
          projectId,
          conversion
            .legacyStatusId,
        );

      workflowStageId =
        stageIds.get(
          key,
        )
        ?? null;

      if (
        workflowStageId
        === null
      ) {
        blockers.push({
          reason:
            'workflow-stage-identity-missing',
          recordId:
            conversion.recordId,
          sourcePath:
            conversion.sourcePath,
          projectRecordId:
            projectId,
          legacyStatusId:
            conversion.legacyStatusId,
        });

        continue;
      }

      const workflowStageRecord =
        await store
          .readStagedRecord(
            workflowStageId,
          );

      if (
        workflowStageRecord
        === null
      ) {
        blockers.push({
          reason:
            'workflow-stage-record-missing',
          recordId:
            conversion.recordId,
          sourcePath:
            conversion.sourcePath,
          workflowStageId,
        });

        continue;
      }

      if (
        workflowStageRecord.kind
          !== 'workflow-stage'
        || workflowStageRecord.id
          !== workflowStageId
        || workflowStageRecord.projectId
          !== projectId
      ) {
        blockers.push({
          reason:
            'workflow-stage-record-incompatible',
          recordId:
            conversion.recordId,
          sourcePath:
            conversion.sourcePath,
          workflowStageId,
        });

        continue;
      }
    }

    if (
      plan.propertyValues
      === null
    ) {
      blockers.push({
        reason:
          'property-value-plan-missing',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
      });

      continue;
    }

    const propertyRecord =
      propertyRecordFor(
        plan,
        conversion,
      );

    if (
      propertyRecord
      === null
    ) {
      blockers.push({
        reason:
          'property-value-record-missing',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
      });

      continue;
    }

    const unresolved =
      unresolvedStoredPropertyConversions(
        propertyRecord,
      );

    if (
      unresolved.length
      > 0
    ) {
      blockers.push({
        reason:
          'property-value-unresolved',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
        schemaRecordIds:
          [
            ...new Set(
              unresolved.map(
                (property) =>
                  property
                    .schemaRecordId,
              ),
            ),
          ].sort(),
      });

      continue;
    }

    eligible.push({
      conversion,
      projectId,
      workflowStageId,
      properties: {
        ...propertyRecord
          .canonicalReadyValues,
      },
    });
  }

  blockers.sort(
    (
      left,
      right,
    ) =>
      left.sourcePath
        .localeCompare(
          right.sourcePath,
        )
      || left.reason
        .localeCompare(
          right.reason,
        ),
  );

  return {
    eligible,
    blockers,
  };
}

export async function materializeLegacyImportTaskStaging(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportStagingStore,
  workflowStageIdentities:
    LegacyImportWorkflowStageIdentityMappingManifest,
): Promise<
  LegacyImportTaskStagingResult
> {
  assertDryRunInput(
    plan,
  );

  if (
    store.authority
    !== 'legacy-import-staging-only'
  ) {
    throw new Error(
      'Task staging received a store without staging-only authority.',
    );
  }

  const collected =
    await collectEligibleTasks(
      plan,
      store,
      workflowStageIdentities,
    );

  const staged:
    LegacyImportStagedTaskRecord[] =
      [];

  const blockers:
    LegacyImportTaskStagingBlocker[] = [
      ...collected.blockers,
    ];

  let created =
    0;

  let reusedIdentical =
    0;

  for (
    const candidate
    of collected.eligible
  ) {
    const record =
      defineTaskRecord(
        candidate,
      );

    const existing =
      await store
        .readStagedRecord(
          record.id,
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
        reusedIdentical +=
          1;

        staged.push({
          recordId:
            record.id,
          sourcePath:
            candidate
              .conversion
              .sourcePath,
          outcome:
            'reused-identical',
          record,
        });

        continue;
      }

      blockers.push({
        reason:
          'staging-record-conflict',
        recordId:
          record.id,
        sourcePath:
          candidate
            .conversion
            .sourcePath,
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
      created +=
        1;

      staged.push({
        recordId:
          record.id,
        sourcePath:
          candidate
            .conversion
            .sourcePath,
        outcome:
          'created',
        record,
      });

      continue;
    }

    const raced =
      await store
        .readStagedRecord(
          record.id,
        );

    if (
      raced
      === null
    ) {
      throw new Error(
        `Task staging store reported an existing record but returned no staged record for ${record.id}.`,
      );
    }

    if (
      sameCanonicalRecord(
        raced,
        record,
      )
    ) {
      reusedIdentical +=
        1;

      staged.push({
        recordId:
          record.id,
        sourcePath:
          candidate
            .conversion
            .sourcePath,
        outcome:
          'reused-identical',
        record,
      });

      continue;
    }

    blockers.push({
      reason:
        'staging-record-conflict',
      recordId:
        record.id,
      sourcePath:
        candidate
          .conversion
          .sourcePath,
    });
  }

  staged.sort(
    (
      left,
      right,
    ) =>
      left.sourcePath
        .localeCompare(
          right.sourcePath,
        ),
  );

  blockers.sort(
    (
      left,
      right,
    ) =>
      left.sourcePath
        .localeCompare(
          right.sourcePath,
        )
      || left.reason
        .localeCompare(
          right.reason,
        ),
  );

  return {
    schemaVersion:
      LEGACY_IMPORT_TASK_STAGING_RESULT_SCHEMA_VERSION,
    mode:
      'staging-materialization',
    source:
      'legacy-import-task-conversions',
    scope:
      'task-records-only',
    activation:
      'not-performed',

    staged,
    blockers,

    counts: {
      taskCandidates:
        taskConversions(
          plan,
        ).length,
      eligibleTaskRecords:
        collected.eligible
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
      externalArtifacts: 0,
      activation: 0,
    },
  };
}
