import type {
  OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import {
  encodeCanonicalRecordV2,
  type CanonicalEventRecordV2,
  type CanonicalProjectRecordV2,
  type CanonicalRecordV2,
  type CanonicalTaskRecordV2,
} from '../domain/canonicalRecordV2.js';
import type {
  LegacyImportEventStagingResult,
} from './importEventStagingPlanner.js';
import type {
  LegacyImportPlan,
  LegacyImportProjectConversionPlan,
  LegacyImportTaskConversionPlan,
  LegacyImportEventConversionPlan,
} from './importPlanner.js';
import type {
  LegacyImportProjectStagingResult,
} from './importProjectStagingPlanner.js';
import type {
  LegacyImportRecordPropertyValuePlan,
} from './importPropertyPlanner.js';
import type {
  LegacyImportTaskStagingResult,
} from './importTaskStagingPlanner.js';
import type {
  LegacyImportWorkflowStageIdentityMappingManifest,
} from './importWorkflowStageStagingPlanner.js';

export const LEGACY_IMPORT_VERIFICATION_SCHEMA_VERSION =
  1 as const;

export type LegacyImportVerificationKind =
  | 'project'
  | 'task'
  | 'event';

export interface LegacyImportVerificationStore {
  readonly authority:
    'legacy-import-staging-only';

  readStagedRecord(
    recordId:
      OpaqueRecordId,
  ): Promise<
    CanonicalRecordV2 | null
  >;
}

export interface LegacyImportVerificationDisposition {
  readonly kind:
    LegacyImportVerificationKind;
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly disposition:
    | 'staged-verified'
    | 'blocked';
  readonly blockerReason:
    string | null;
}

export interface LegacyImportVerificationKindCounts {
  readonly planned:
    number;
  readonly stagedVerified:
    number;
  readonly blocked:
    number;
  readonly accounted:
    number;
}

export interface LegacyImportVerificationResult {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_VERIFICATION_SCHEMA_VERSION;
  readonly mode:
    'verification';
  readonly source:
    'legacy-import-plan-and-staging-results';
  readonly verdict:
    | 'verified'
    | 'blocked';

  readonly dispositions:
    readonly LegacyImportVerificationDisposition[];

  readonly counts: {
    readonly projects:
      LegacyImportVerificationKindCounts;
    readonly tasks:
      LegacyImportVerificationKindCounts;
    readonly events:
      LegacyImportVerificationKindCounts;
    readonly total:
      LegacyImportVerificationKindCounts;
  };

  /**
   * These remain explicit open dependencies.
   *
   * Verification of currently representable records must not be misreported
   * as a decision on migration semantics that are still creator-owned/open.
   *
   * `unsupported-frontmatter-importability` used to be one of them and is not any more: D65 answered it, and
   * a check this layer reports as deferred has to be a question nobody has answered rather than one that has
   * been implemented and left in the list.
   */
  readonly deferredChecks:
    readonly (
      | 'recurrence-migration'
      | 'event-all-day-intent'
    )[];

  readonly verifierWrites: {
    readonly legacyMarkdown:
      0;
    readonly staging:
      0;
    readonly recordStore:
      0;
    readonly externalArtifacts:
      0;
    readonly activation:
      0;
  };
}

export interface LegacyImportVerificationInput {
  readonly plan:
    LegacyImportPlan;
  readonly projectStaging:
    LegacyImportProjectStagingResult;
  readonly taskStaging:
    LegacyImportTaskStagingResult;
  readonly eventStaging:
    LegacyImportEventStagingResult;
  readonly workflowStageIdentities:
    LegacyImportWorkflowStageIdentityMappingManifest;
  readonly store:
    LegacyImportVerificationStore;
}

interface StagingEvidence {
  readonly kind:
    LegacyImportVerificationKind;
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly disposition:
    | 'staged-verified'
    | 'blocked';
  readonly blockerReason:
    string | null;
  readonly record:
    CanonicalRecordV2 | null;
}

interface StagingBlockerLike {
  readonly reason:
    string;
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
}

function evidenceKey(
  kind:
    LegacyImportVerificationKind,
  recordId:
    OpaqueRecordId,
  sourcePath:
    string,
): string {
  return JSON.stringify([
    kind,
    recordId,
    sourcePath,
  ]);
}

function stableValue(
  value:
    unknown,
): unknown {
  if (
    Array.isArray(
      value,
    )
  ) {
    return value.map(
      stableValue,
    );
  }

  if (
    typeof value
      === 'object'
    && value
      !== null
  ) {
    const source =
      value as Readonly<
        Record<
          string,
          unknown
        >
      >;

    const result:
      Record<
        string,
        unknown
      > = {};

    for (
      const key
      of Object.keys(
        source,
      ).sort()
    ) {
      result[key] =
        stableValue(
          source[key],
        );
    }

    return result;
  }

  return value;
}

function valuesEqual(
  left:
    unknown,
  right:
    unknown,
): boolean {
  return JSON.stringify(
    stableValue(
      left,
    ),
  ) === JSON.stringify(
    stableValue(
      right,
    ),
  );
}

function assertSame(
  label:
    string,
  actual:
    unknown,
  expected:
    unknown,
): void {
  if (
    !valuesEqual(
      actual,
      expected,
    )
  ) {
    throw new Error(
      `${label} mismatch.`,
    );
  }
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

function assertNoLegacyProjectType(
  record:
    CanonicalRecordV2,
): void {
  if (
    Object.prototype
      .hasOwnProperty.call(
        record,
        'projectType',
      )
  ) {
    throw new Error(
      `Import verification found legacy projectType on canonical ${record.kind} record ${record.id}.`,
    );
  }
}

async function assertStoredRecord(
  store:
    LegacyImportVerificationStore,
  record:
    CanonicalRecordV2,
): Promise<void> {
  const stored =
    await store
      .readStagedRecord(
        record.id,
      );

  if (
    stored
    === null
  ) {
    throw new Error(
      `Import verification cannot find staged record ${record.id}.`,
    );
  }

  if (
    canonicalRecordText(
      stored,
    ) !== canonicalRecordText(
      record,
    )
  ) {
    throw new Error(
      `Import verification staging-store record mismatch for ${record.id}.`,
    );
  }
}

function assertStagingEnvelope(
  label:
    string,
  planned:
    number,
  candidateCount:
    number,
  stagedCount:
    number,
  blockerCount:
    number,
  created:
    number,
  reusedIdentical:
    number,
  reportedBlocked:
    number,
  stagingWrites:
    number,
  legacyMarkdownWrites:
    number,
  recordStoreWrites:
    number,
  externalArtifactWrites:
    number,
  activationWrites:
    number,
  activation:
    string,
): void {
  if (
    candidateCount
    !== planned
  ) {
    throw new Error(
      `${label} staging candidate count does not match the import plan.`,
    );
  }

  if (
    stagedCount
      + blockerCount
    !== planned
  ) {
    throw new Error(
      `${label} staging candidate accounting mismatch.`,
    );
  }

  if (
    created
      + reusedIdentical
    !== stagedCount
  ) {
    throw new Error(
      `${label} staging staged count mismatch.`,
    );
  }

  if (
    reportedBlocked
    !== blockerCount
  ) {
    throw new Error(
      `${label} staging blocker count mismatch.`,
    );
  }

  if (
    stagingWrites
    !== created
  ) {
    throw new Error(
      `${label} staging write count mismatch.`,
    );
  }

  if (
    legacyMarkdownWrites
      !== 0
    || recordStoreWrites
      !== 0
    || externalArtifactWrites
      !== 0
    || activationWrites
      !== 0
    || activation
      !== 'not-performed'
  ) {
    throw new Error(
      `${label} staging escaped the accepted zero-live-write boundary.`,
    );
  }
}

function appendEvidence(
  evidence:
    Map<
      string,
      StagingEvidence
    >,
  entry:
    StagingEvidence,
): void {
  const key =
    evidenceKey(
      entry.kind,
      entry.recordId,
      entry.sourcePath,
    );

  if (
    evidence.has(
      key,
    )
  ) {
    throw new Error(
      `Import verification received duplicate ${entry.kind} staging evidence for ${entry.sourcePath}.`,
    );
  }

  evidence.set(
    key,
    entry,
  );
}

function appendBlockerEvidence(
  evidence:
    Map<
      string,
      StagingEvidence
    >,
  kind:
    LegacyImportVerificationKind,
  blocker:
    StagingBlockerLike,
): void {
  appendEvidence(
    evidence,
    {
      kind,
      recordId:
        blocker.recordId,
      sourcePath:
        blocker.sourcePath,
      disposition:
        'blocked',
      blockerReason:
        blocker.reason,
      record:
        null,
    },
  );
}

function workflowStageIds(
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
      'Import verification received an incompatible workflow-stage identity mapping.',
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
      JSON.stringify([
        entry.projectRecordId,
        entry.legacyStatusId,
      ]);

    if (
      byKey.has(
        key,
      )
    ) {
      throw new Error(
        `Import verification received duplicate workflow-stage key ${key}.`,
      );
    }

    const previousKey =
      keyByRecordId.get(
        entry.recordId,
      );

    if (
      previousKey
      !== undefined
      && previousKey
        !== key
    ) {
      throw new Error(
        `Import verification received workflow-stage id ${entry.recordId} for multiple stage keys.`,
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

function propertyRecordFor(
  plan:
    LegacyImportPlan,
  kind:
    'task'
    | 'event',
  recordId:
    OpaqueRecordId,
  sourcePath:
    string,
): LegacyImportRecordPropertyValuePlan {
  if (
    plan.propertyValues
    === null
  ) {
    throw new Error(
      `Import verification has no property-value plan for staged ${kind} ${sourcePath}.`,
    );
  }

  const matches =
    plan.propertyValues
      .records
      .filter(
        (record) =>
          record.kind
            === kind
          && record.recordId
            === recordId
          && record.sourcePath
            === sourcePath,
      );

  if (
    matches.length
    !== 1
  ) {
    throw new Error(
      `Import verification needs exactly one property-value plan for staged ${kind} ${sourcePath}.`,
    );
  }

  const record =
    matches[0];

  if (
    record
    === undefined
  ) {
    throw new Error(
      `Import verification lost property-value evidence for ${kind} ${sourcePath}.`,
    );
  }

  return record;
}

function verifyProjectRecord(
  plan:
    LegacyImportPlan,
  conversion:
    LegacyImportProjectConversionPlan,
  record:
    CanonicalRecordV2,
): CanonicalProjectRecordV2 {
  assertNoLegacyProjectType(
    record,
  );

  if (
    record.kind
    !== 'project'
  ) {
    throw new Error(
      `Project verification received canonical ${record.kind} for ${conversion.sourcePath}.`,
    );
  }

  assertSame(
    'Project verification id',
    record.id,
    conversion.recordId,
  );

  assertSame(
    'Project verification name',
    record.name,
    conversion.name,
  );

  assertSame(
    'Project verification description',
    record.description,
    conversion.description,
  );

  assertSame(
    'Project verification createdAt',
    record.createdAt,
    conversion.createdAt,
  );

  assertSame(
    'Project verification status',
    record.status,
    conversion.status,
  );

  assertSame(
    'Project verification archivedAt',
    record.archivedAt,
    conversion.archivedAt,
  );

  if (
    plan.externalArtifacts
    === null
  ) {
    throw new Error(
      `Project verification has no external-artifact plan for ${conversion.sourcePath}.`,
    );
  }

  const associations =
    plan.externalArtifacts
      .projects
      .filter(
        (project) =>
          project.projectRecordId
            === conversion.recordId
          && project.sourcePath
            === conversion.sourcePath,
      );

  if (
    associations.length
    !== 1
  ) {
    throw new Error(
      `Project verification needs exactly one artifact association for ${conversion.sourcePath}.`,
    );
  }

  const association =
    associations[0];

  if (
    association
    === undefined
  ) {
    throw new Error(
      `Project verification lost artifact association for ${conversion.sourcePath}.`,
    );
  }

  assertSame(
    'Project verification artifact bindings',
    record.artifactBindings,
    association
      .association
      .bindings,
  );

  return record;
}

function verifyTaskRecord(
  plan:
    LegacyImportPlan,
  conversion:
    LegacyImportTaskConversionPlan,
  record:
    CanonicalRecordV2,
  stageIds:
    ReadonlyMap<
      string,
      OpaqueRecordId
    >,
): CanonicalTaskRecordV2 {
  assertNoLegacyProjectType(
    record,
  );

  if (
    record.kind
    !== 'task'
  ) {
    throw new Error(
      `Task verification received canonical ${record.kind} for ${conversion.sourcePath}.`,
    );
  }

  let expectedProjectId:
    OpaqueRecordId | null =
      null;

  let expectedWorkflowStageId:
    OpaqueRecordId | null =
      null;

  if (
    conversion.workflowStage
      .resolution
    === 'candidate'
  ) {
    expectedProjectId =
      conversion.workflowStage
        .projectRecordId;

    const stageKey =
      JSON.stringify([
        expectedProjectId,
        conversion
          .legacyStatusId,
      ]);

    expectedWorkflowStageId =
      stageIds.get(
        stageKey,
      ) ?? null;

    if (
      expectedWorkflowStageId
      === null
    ) {
      throw new Error(
        `Task verification cannot find workflow-stage identity for ${conversion.sourcePath}.`,
      );
    }
  } else if (
    conversion.workflowStage
      .resolution
    !== 'none'
  ) {
    throw new Error(
      `Task verification received staged task with unresolved project/workflow reference for ${conversion.sourcePath}.`,
    );
  }

  const propertyRecord =
    propertyRecordFor(
      plan,
      'task',
      conversion.recordId,
      conversion.sourcePath,
    );

  if (
    propertyRecord
      .schemaDisposition
    !== 'mapped'
  ) {
    throw new Error(
      `Task verification received non-mapped property evidence for ${conversion.sourcePath}.`,
    );
  }

  assertSame(
    'Task verification id',
    record.id,
    conversion.recordId,
  );

  assertSame(
    'Task verification name',
    record.name,
    conversion.name,
  );

  assertSame(
    'Task verification description',
    record.description,
    conversion.description,
  );

  assertSame(
    'Task verification projectId',
    record.projectId,
    expectedProjectId,
  );

  assertSame(
    'Task verification executionState',
    record.executionState,
    conversion.executionState,
  );

  assertSame(
    'Task verification workflowStageId',
    record.workflowStageId,
    expectedWorkflowStageId,
  );

  assertSame(
    'Task verification executionOrder',
    record.executionOrder,
    conversion
      .scopedOrders
      .execution
      .position,
  );

  assertSame(
    'Task verification workflowOrder',
    record.workflowOrder,
    expectedWorkflowStageId
      === null
      ? null
      : conversion
          .scopedOrders
          .workflow
          ?.position
        ?? null,
  );

  assertSame(
    'Task verification weight',
    record.weight,
    conversion.weight,
  );

  assertSame(
    'Task verification isFixedDuration',
    record.isFixedDuration,
    conversion.isFixedDuration,
  );

  assertSame(
    'Task verification fixedDuration',
    record.fixedDuration,
    conversion.fixedDuration,
  );

  assertSame(
    'Task verification maxDuration',
    record.maxDuration,
    conversion.maxDuration,
  );

  assertSame(
    'Task verification isCompleted',
    record.isCompleted,
    conversion.isCompleted,
  );

  assertSame(
    'Task verification createdAt',
    record.createdAt,
    conversion.createdAt,
  );

  assertSame(
    'Task verification startDate',
    record.startDate,
    conversion.startDate,
  );

  assertSame(
    'Task verification deadline',
    record.deadline,
    conversion.deadline,
  );

  assertSame(
    'Task verification properties',
    record.properties,
    propertyRecord
      .canonicalReadyValues,
  );

  assertSame(
    'Task verification recurrence',
    record.recurrence,
    conversion.recurrence,
  );

  return record;
}

function verifyEventRecord(
  plan:
    LegacyImportPlan,
  conversion:
    LegacyImportEventConversionPlan,
  record:
    CanonicalRecordV2,
): CanonicalEventRecordV2 {
  assertNoLegacyProjectType(
    record,
  );

  if (
    record.kind
    !== 'event'
  ) {
    throw new Error(
      `Event verification received canonical ${record.kind} for ${conversion.sourcePath}.`,
    );
  }

  let expectedProjectId:
    OpaqueRecordId | null =
      null;

  if (
    conversion.project
      .resolution
    === 'resolved'
  ) {
    expectedProjectId =
      conversion.project
        .projectRecordId;
  } else if (
    conversion.project
      .resolution
    !== 'none'
  ) {
    throw new Error(
      `Event verification received staged event with unresolved project reference for ${conversion.sourcePath}.`,
    );
  }

  const propertyRecord =
    propertyRecordFor(
      plan,
      'event',
      conversion.recordId,
      conversion.sourcePath,
    );

  if (
    propertyRecord
      .schemaDisposition
    !== 'legacy-event-properties-untyped'
  ) {
    throw new Error(
      `Event verification received unexpected property evidence for ${conversion.sourcePath}.`,
    );
  }

  assertSame(
    'Event verification id',
    record.id,
    conversion.recordId,
  );

  assertSame(
    'Event verification name',
    record.name,
    conversion.name,
  );

  assertSame(
    'Event verification description',
    record.description,
    conversion.description,
  );

  assertSame(
    'Event verification projectId',
    record.projectId,
    expectedProjectId,
  );

  assertSame(
    'Event verification createdAt',
    record.createdAt,
    conversion.createdAt,
  );

  assertSame(
    'Event verification startDate',
    record.startDate,
    conversion.startDate,
  );

  assertSame(
    'Event verification deadline',
    record.deadline,
    conversion.deadline,
  );

  assertSame(
    'Event verification isCompleted',
    record.isCompleted,
    conversion.isCompleted,
  );

  assertSame(
    'Event verification properties',
    record.properties,
    propertyRecord
      .canonicalReadyValues,
  );

  assertSame(
    'Event verification recurrence',
    record.recurrence,
    conversion.recurrence,
  );

  return record;
}

function kindCounts(
  kind:
    LegacyImportVerificationKind,
  dispositions:
    readonly LegacyImportVerificationDisposition[],
): LegacyImportVerificationKindCounts {
  const scoped =
    dispositions.filter(
      (entry) =>
        entry.kind
        === kind,
    );

  const stagedVerified =
    scoped.filter(
      (entry) =>
        entry.disposition
        === 'staged-verified',
    ).length;

  const blocked =
    scoped.filter(
      (entry) =>
        entry.disposition
        === 'blocked',
    ).length;

  return {
    planned:
      scoped.length,
    stagedVerified,
    blocked,
    accounted:
      stagedVerified
      + blocked,
  };
}

function totalCounts(
  projects:
    LegacyImportVerificationKindCounts,
  tasks:
    LegacyImportVerificationKindCounts,
  events:
    LegacyImportVerificationKindCounts,
): LegacyImportVerificationKindCounts {
  return {
    planned:
      projects.planned
      + tasks.planned
      + events.planned,
    stagedVerified:
      projects.stagedVerified
      + tasks.stagedVerified
      + events.stagedVerified,
    blocked:
      projects.blocked
      + tasks.blocked
      + events.blocked,
    accounted:
      projects.accounted
      + tasks.accounted
      + events.accounted,
  };
}

export async function verifyLegacyImportStaging(
  input:
    LegacyImportVerificationInput,
): Promise<
  LegacyImportVerificationResult
> {
  if (
    input.plan.mode
    !== 'dry-run'
    || input.plan.writes
      .legacyMarkdown
      !== 0
    || input.plan.writes
      .recordStore
      !== 0
    || input.plan.writes
      .staging
      !== 0
  ) {
    throw new Error(
      'Import verification accepts only the zero-write dry-run import plan.',
    );
  }

  if (
    input.store.authority
    !== 'legacy-import-staging-only'
  ) {
    throw new Error(
      'Import verification received a store without staging-only authority.',
    );
  }

  const projectConversions =
    input.plan
      .conversions
      .filter(
        (
          conversion,
        ): conversion is LegacyImportProjectConversionPlan =>
          conversion.kind
          === 'project',
      );

  const taskConversions =
    input.plan
      .conversions
      .filter(
        (
          conversion,
        ): conversion is LegacyImportTaskConversionPlan =>
          conversion.kind
          === 'task',
      );

  const eventConversions =
    input.plan
      .conversions
      .filter(
        (
          conversion,
        ): conversion is LegacyImportEventConversionPlan =>
          conversion.kind
          === 'event',
      );

  if (
    input.plan.counts
      .projects
    !== projectConversions
      .length
    || input.plan.counts
      .tasks
      !== taskConversions
        .length
    || input.plan.counts
      .events
      !== eventConversions
        .length
    || input.plan.counts
      .physicalCandidates
      !== input.plan
        .conversions
        .length
  ) {
    throw new Error(
      'Import verification found conversion counts inconsistent with the dry-run census.',
    );
  }

  assertStagingEnvelope(
    'project',
    projectConversions.length,
    input.projectStaging
      .counts
      .projectCandidates,
    input.projectStaging
      .staged
      .length,
    input.projectStaging
      .blockers
      .length,
    input.projectStaging
      .counts
      .created,
    input.projectStaging
      .counts
      .reusedIdentical,
    input.projectStaging
      .counts
      .blocked,
    input.projectStaging
      .writes
      .staging,
    input.projectStaging
      .writes
      .legacyMarkdown,
    input.projectStaging
      .writes
      .recordStore,
    input.projectStaging
      .writes
      .externalArtifacts,
    input.projectStaging
      .writes
      .activation,
    input.projectStaging
      .activation,
  );

  assertStagingEnvelope(
    'task',
    taskConversions.length,
    input.taskStaging
      .counts
      .taskCandidates,
    input.taskStaging
      .staged
      .length,
    input.taskStaging
      .blockers
      .length,
    input.taskStaging
      .counts
      .created,
    input.taskStaging
      .counts
      .reusedIdentical,
    input.taskStaging
      .counts
      .blocked,
    input.taskStaging
      .writes
      .staging,
    input.taskStaging
      .writes
      .legacyMarkdown,
    input.taskStaging
      .writes
      .recordStore,
    input.taskStaging
      .writes
      .externalArtifacts,
    input.taskStaging
      .writes
      .activation,
    input.taskStaging
      .activation,
  );

  assertStagingEnvelope(
    'event',
    eventConversions.length,
    input.eventStaging
      .counts
      .eventCandidates,
    input.eventStaging
      .staged
      .length,
    input.eventStaging
      .blockers
      .length,
    input.eventStaging
      .counts
      .created,
    input.eventStaging
      .counts
      .reusedIdentical,
    input.eventStaging
      .counts
      .blocked,
    input.eventStaging
      .writes
      .staging,
    input.eventStaging
      .writes
      .legacyMarkdown,
    input.eventStaging
      .writes
      .recordStore,
    input.eventStaging
      .writes
      .externalArtifacts,
    input.eventStaging
      .writes
      .activation,
    input.eventStaging
      .activation,
  );

  const evidence =
    new Map<
      string,
      StagingEvidence
    >();

  for (
    const staged
    of input.projectStaging
      .staged
  ) {
    appendEvidence(
      evidence,
      {
        kind:
          'project',
        recordId:
          staged.recordId,
        sourcePath:
          staged.sourcePath,
        disposition:
          'staged-verified',
        blockerReason:
          null,
        record:
          staged.record,
      },
    );
  }

  for (
    const blocker
    of input.projectStaging
      .blockers
  ) {
    appendBlockerEvidence(
      evidence,
      'project',
      blocker,
    );
  }

  for (
    const staged
    of input.taskStaging
      .staged
  ) {
    appendEvidence(
      evidence,
      {
        kind:
          'task',
        recordId:
          staged.recordId,
        sourcePath:
          staged.sourcePath,
        disposition:
          'staged-verified',
        blockerReason:
          null,
        record:
          staged.record,
      },
    );
  }

  for (
    const blocker
    of input.taskStaging
      .blockers
  ) {
    appendBlockerEvidence(
      evidence,
      'task',
      blocker,
    );
  }

  for (
    const staged
    of input.eventStaging
      .staged
  ) {
    appendEvidence(
      evidence,
      {
        kind:
          'event',
        recordId:
          staged.recordId,
        sourcePath:
          staged.sourcePath,
        disposition:
          'staged-verified',
        blockerReason:
          null,
        record:
          staged.record,
      },
    );
  }

  for (
    const blocker
    of input.eventStaging
      .blockers
  ) {
    appendBlockerEvidence(
      evidence,
      'event',
      blocker,
    );
  }

  const stageIds =
    workflowStageIds(
      input.workflowStageIdentities,
    );

  const dispositions:
    LegacyImportVerificationDisposition[] =
      [];

  for (
    const conversion
    of input.plan
      .conversions
  ) {
    const key =
      evidenceKey(
        conversion.kind,
        conversion.recordId,
        conversion.sourcePath,
      );

    const item =
      evidence.get(
        key,
      );

    if (
      item
      === undefined
    ) {
      throw new Error(
        `Import verification has no explicit staging disposition for ${conversion.kind} ${conversion.sourcePath}.`,
      );
    }

    if (
      item.disposition
      === 'blocked'
    ) {
      dispositions.push({
        kind:
          conversion.kind,
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
        disposition:
          'blocked',
        blockerReason:
          item.blockerReason,
      });

      continue;
    }

    const record =
      item.record;

    if (
      record
      === null
    ) {
      throw new Error(
        `Import verification lost staged record evidence for ${conversion.sourcePath}.`,
      );
    }

    if (
      conversion.kind
      === 'project'
    ) {
      verifyProjectRecord(
        input.plan,
        conversion,
        record,
      );
    } else if (
      conversion.kind
      === 'task'
    ) {
      verifyTaskRecord(
        input.plan,
        conversion,
        record,
        stageIds,
      );
    } else {
      verifyEventRecord(
        input.plan,
        conversion,
        record,
      );
    }

    await assertStoredRecord(
      input.store,
      record,
    );

    dispositions.push({
      kind:
        conversion.kind,
      recordId:
        conversion.recordId,
      sourcePath:
        conversion.sourcePath,
      disposition:
        'staged-verified',
      blockerReason:
        null,
    });
  }

  if (
    evidence.size
    !== input.plan
      .conversions
      .length
  ) {
    throw new Error(
      'Import verification received staging evidence that does not correspond one-to-one with physical conversions.',
    );
  }

  dispositions.sort(
    (
      left,
      right,
    ) =>
      left.kind
        .localeCompare(
          right.kind,
        )
      || left.sourcePath
        .localeCompare(
          right.sourcePath,
        ),
  );

  const projects =
    kindCounts(
      'project',
      dispositions,
    );

  const tasks =
    kindCounts(
      'task',
      dispositions,
    );

  const events =
    kindCounts(
      'event',
      dispositions,
    );

  const total =
    totalCounts(
      projects,
      tasks,
      events,
    );

  if (
    total.accounted
    !== total.planned
  ) {
    throw new Error(
      'Import verification did not account for every physical conversion.',
    );
  }

  return {
    schemaVersion:
      LEGACY_IMPORT_VERIFICATION_SCHEMA_VERSION,
    mode:
      'verification',
    source:
      'legacy-import-plan-and-staging-results',
    verdict:
      total.blocked
      > 0
        ? 'blocked'
        : 'verified',

    dispositions,

    counts: {
      projects,
      tasks,
      events,
      total,
    },

    // The unsupported-frontmatter check is no longer deferred: D65 answered it (an otherwise readable record
    // is imported using the interpreted fields, with the construct reported against it), so it is not a
    // question this verification is waiting on. The two that remain are still questions, and stay named.
    deferredChecks: [
      'recurrence-migration',
      'event-all-day-intent',
    ],

    verifierWrites: {
      legacyMarkdown: 0,
      staging: 0,
      recordStore: 0,
      externalArtifacts: 0,
      activation: 0,
    },
  };
}
