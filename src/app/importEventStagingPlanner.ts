import {
  defineCanonicalRecordHeader,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import {
  encodeCanonicalRecordV2,
  type CanonicalEventRecordV2,
  type CanonicalRecordV2,
} from '../domain/canonicalRecordV2.js';
import type {
  LegacyImportRecordPropertyValuePlan,
} from './importPropertyPlanner.js';
import type {
  LegacyImportEventConversionPlan,
  LegacyImportPlan,
} from './importPlanner.js';
import type {
  LegacyImportStagingStore,
} from './importStagingPlanner.js';

export const LEGACY_IMPORT_EVENT_STAGING_RESULT_SCHEMA_VERSION =
  1 as const;

const LEGACY_EVENT_CORE_FRONTMATTER_KEYS =
  new Set([
    'id',
    'type',
    'name',
    'description',
    'project',
    'projectId',
    'createdAt',
    'startDate',
    'deadline',
    'isCompleted',
  ]);

export type LegacyImportEventStagingBlocker =
  | {
      readonly reason:
        'malformed-event';
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
        'missing'
        | 'ambiguous';
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
        'event-time-range-unrepresentable';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly startDate:
        string;
      readonly deadline:
        string;
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
        'legacy-event-properties-untyped';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
      readonly legacyPropertyKeys:
        readonly string[];
    }
  | {
      readonly reason:
        'staging-record-conflict';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    };

export interface LegacyImportStagedEventRecord {
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly outcome:
    | 'created'
    | 'reused-identical';
  readonly record:
    CanonicalEventRecordV2;
}

export interface LegacyImportEventStagingResult {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_EVENT_STAGING_RESULT_SCHEMA_VERSION;
  readonly mode:
    'staging-materialization';
  readonly source:
    'legacy-import-event-conversions';
  readonly scope:
    'event-records-only';
  readonly activation:
    'not-performed';

  readonly staged:
    readonly LegacyImportStagedEventRecord[];

  readonly blockers:
    readonly LegacyImportEventStagingBlocker[];

  readonly counts: {
    readonly eventCandidates:
      number;
    readonly eligibleEventRecords:
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

interface EligibleEvent {
  readonly conversion:
    LegacyImportEventConversionPlan;
  readonly projectId:
    OpaqueRecordId | null;
}

function eventConversions(
  plan:
    LegacyImportPlan,
): LegacyImportEventConversionPlan[] {
  return plan.conversions
    .filter(
      (
        conversion,
      ): conversion is LegacyImportEventConversionPlan =>
        conversion.kind
        === 'event',
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

function eventProblemReason(
  plan:
    LegacyImportPlan,
  conversion:
    LegacyImportEventConversionPlan,
):
  | 'malformed-event'
  | 'unsupported-frontmatter-policy-pending'
  | null {
  const problems =
    plan.problems.filter(
      (problem) =>
        problem.kind
          === 'event'
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
    return 'malformed-event';
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
    LegacyImportEventConversionPlan,
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
            === 'event'
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
      `Event staging found duplicate property-value plans for ${conversion.sourcePath}.`,
    );
  }

  return matches[0]
    ?? null;
}

function untypedLegacyEventPropertyKeys(
  record:
    LegacyImportRecordPropertyValuePlan,
): string[] {
  if (
    record.schemaDisposition
    !== 'legacy-event-properties-untyped'
    || record.schemaScope
    !== null
    || record.conversions
      .length
    !== 0
    || Object.keys(
      record.canonicalReadyValues,
    ).length
      !== 0
  ) {
    throw new Error(
      `Event staging received incompatible event property evidence for ${record.sourcePath}.`,
    );
  }

  return Object.keys(
    record.legacyPropertyValues,
  )
    .filter(
      (key) =>
        !LEGACY_EVENT_CORE_FRONTMATTER_KEYS.has(
          key,
        ),
    )
    .sort();
}

function timeRangeIsRepresentable(
  conversion:
    LegacyImportEventConversionPlan,
): boolean {
  if (
    conversion.startDate
      .trim()
      .length
    === 0
    || conversion.deadline
      .trim()
      .length
    === 0
  ) {
    return false;
  }

  const start =
    Date.parse(
      conversion.startDate,
    );

  const deadline =
    Date.parse(
      conversion.deadline,
    );

  return !Number.isNaN(
    start,
  )
    && !Number.isNaN(
      deadline,
    )
    && deadline
      >= start;
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

function defineEventRecord(
  candidate:
    EligibleEvent,
): CanonicalEventRecordV2 {
  const conversion =
    candidate.conversion;

  const event:
    CanonicalEventRecordV2 = {
      ...defineCanonicalRecordHeader({
        kind:
          'event',
        id:
          conversion.recordId,
        name:
          conversion.name,
      }),
      description:
        conversion.description,
      projectId:
        candidate.projectId,
      createdAt:
        conversion.createdAt,
      startDate:
        conversion.startDate,
      deadline:
        conversion.deadline,
      isCompleted:
        conversion.isCompleted,
      properties: {},
      recurrence:
        conversion.recurrence,
    };

  const encoded =
    encodeCanonicalRecordV2(
      event,
    );

  if (
    encoded.kind
    !== 'event'
  ) {
    throw new Error(
      `Event staging codec returned a non-event record for ${conversion.recordId}.`,
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
      'Event staging accepts only a zero-write dry-run import plan.',
    );
  }
}

async function collectEligibleEvents(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportStagingStore,
): Promise<{
  readonly eligible:
    EligibleEvent[];
  readonly blockers:
    LegacyImportEventStagingBlocker[];
}> {
  const eligible:
    EligibleEvent[] =
      [];

  const blockers:
    LegacyImportEventStagingBlocker[] =
      [];

  for (
    const conversion
    of eventConversions(
      plan,
    )
  ) {
    const problemReason =
      eventProblemReason(
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

    if (
      !timeRangeIsRepresentable(
        conversion,
      )
    ) {
      blockers.push({
        reason:
          'event-time-range-unrepresentable',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
        startDate:
          conversion.startDate,
        deadline:
          conversion.deadline,
      });

      continue;
    }

    let projectId:
      OpaqueRecordId | null =
        null;

    if (
      conversion.project.resolution
      === 'missing'
      || conversion.project.resolution
        === 'ambiguous'
    ) {
      blockers.push({
        reason:
          'project-reference-unresolved',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
        resolution:
          conversion.project
            .resolution,
      });

      continue;
    }

    if (
      conversion.project.resolution
      === 'resolved'
    ) {
      projectId =
        conversion.project
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

    const untypedPropertyKeys =
      untypedLegacyEventPropertyKeys(
        propertyRecord,
      );

    if (
      untypedPropertyKeys
        .length
      > 0
    ) {
      blockers.push({
        reason:
          'legacy-event-properties-untyped',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
        legacyPropertyKeys:
          untypedPropertyKeys,
      });

      continue;
    }

    eligible.push({
      conversion,
      projectId,
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

export async function materializeLegacyImportEventStaging(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportStagingStore,
): Promise<
  LegacyImportEventStagingResult
> {
  assertDryRunInput(
    plan,
  );

  if (
    store.authority
    !== 'legacy-import-staging-only'
  ) {
    throw new Error(
      'Event staging received a store without staging-only authority.',
    );
  }

  const collected =
    await collectEligibleEvents(
      plan,
      store,
    );

  const staged:
    LegacyImportStagedEventRecord[] =
      [];

  const blockers:
    LegacyImportEventStagingBlocker[] = [
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
      defineEventRecord(
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
        `Event staging store reported an existing record but returned no staged record for ${record.id}.`,
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
      LEGACY_IMPORT_EVENT_STAGING_RESULT_SCHEMA_VERSION,
    mode:
      'staging-materialization',
    source:
      'legacy-import-event-conversions',
    scope:
      'event-records-only',
    activation:
      'not-performed',

    staged,
    blockers,

    counts: {
      eventCandidates:
        eventConversions(
          plan,
        ).length,
      eligibleEventRecords:
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
