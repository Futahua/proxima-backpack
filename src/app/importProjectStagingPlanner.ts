import {
  defineCanonicalRecordHeader,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import {
  encodeCanonicalRecordV2,
  type CanonicalProjectRecordV2,
  type CanonicalRecordV2,
} from '../domain/canonicalRecordV2.js';
import type {
  LegacyImportPlan,
  LegacyImportProjectConversionPlan,
} from './importPlanner.js';
import type {
  LegacyImportStagingStore,
} from './importStagingPlanner.js';

export const LEGACY_IMPORT_PROJECT_STAGING_RESULT_SCHEMA_VERSION =
  1 as const;

export type LegacyImportProjectStagingBlocker =
  | {
      readonly reason:
        'malformed-project';
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
        'external-artifact-plan-missing';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    }
  | {
      readonly reason:
        'external-artifact-association-missing';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    }
  | {
      readonly reason:
        'staging-record-conflict';
      readonly recordId:
        OpaqueRecordId;
      readonly sourcePath:
        string;
    };

export interface LegacyImportStagedProjectRecord {
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly outcome:
    | 'created'
    | 'reused-identical';
  readonly record:
    CanonicalProjectRecordV2;
}

export interface LegacyImportProjectStagingResult {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_PROJECT_STAGING_RESULT_SCHEMA_VERSION;
  readonly mode:
    'staging-materialization';
  readonly source:
    'legacy-import-project-conversions';
  readonly scope:
    'project-records-only';
  readonly activation:
    'not-performed';

  readonly staged:
    readonly LegacyImportStagedProjectRecord[];

  readonly blockers:
    readonly LegacyImportProjectStagingBlocker[];

  readonly counts: {
    readonly projectCandidates:
      number;
    readonly eligibleProjectRecords:
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

interface EligibleProject {
  readonly conversion:
    LegacyImportProjectConversionPlan;
  readonly record:
    CanonicalProjectRecordV2;
}

function projectConversions(
  plan:
    LegacyImportPlan,
): LegacyImportProjectConversionPlan[] {
  return plan.conversions
    .filter(
      (
        conversion,
      ): conversion is LegacyImportProjectConversionPlan =>
        conversion.kind
        === 'project',
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

function projectProblemReason(
  plan:
    LegacyImportPlan,
  conversion:
    LegacyImportProjectConversionPlan,
):
  | 'malformed-project'
  | 'unsupported-frontmatter-policy-pending'
  | null {
  const problems =
    plan.problems.filter(
      (problem) =>
        problem.kind
          === 'project'
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
    return 'malformed-project';
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

function defineProjectRecord(
  conversion:
    LegacyImportProjectConversionPlan,
  artifactBindings:
    CanonicalProjectRecordV2[
      'artifactBindings'
    ],
): CanonicalProjectRecordV2 {
  const candidate:
    CanonicalProjectRecordV2 = {
      ...defineCanonicalRecordHeader({
        kind:
          'project',
        id:
          conversion.recordId,
        name:
          conversion.name,
      }),
      description:
        conversion.description,
      createdAt:
        conversion.createdAt,
      status:
        conversion.status,
      archivedAt:
        conversion.archivedAt,
      artifactBindings:
        artifactBindings.map(
          (binding) => ({
            role:
              binding.role,
            artifactId:
              binding.artifactId,
          }),
        ),
    };

  const encoded =
    encodeCanonicalRecordV2(
      candidate,
    );

  if (
    encoded.kind
    !== 'project'
  ) {
    throw new Error(
      `Project staging codec returned a non-project record for ${conversion.recordId}.`,
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
      'Project staging accepts only a zero-write dry-run import plan.',
    );
  }
}

function collectEligibleProjects(
  plan:
    LegacyImportPlan,
): {
  readonly eligible:
    EligibleProject[];
  readonly blockers:
    LegacyImportProjectStagingBlocker[];
} {
  const eligible:
    EligibleProject[] =
      [];

  const blockers:
    LegacyImportProjectStagingBlocker[] =
      [];

  for (
    const conversion
    of projectConversions(
      plan,
    )
  ) {
    const problemReason =
      projectProblemReason(
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
      plan.externalArtifacts
      === null
    ) {
      blockers.push({
        reason:
          'external-artifact-plan-missing',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
      });

      continue;
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
      blockers.push({
        reason:
          'external-artifact-association-missing',
        recordId:
          conversion.recordId,
        sourcePath:
          conversion.sourcePath,
      });

      continue;
    }

    const association =
      associations[0];

    if (
      association
      === undefined
    ) {
      throw new Error(
        `Project staging lost the sole artifact association for ${conversion.sourcePath}.`,
      );
    }

    eligible.push({
      conversion,
      record:
        defineProjectRecord(
          conversion,
          association
            .association
            .bindings,
        ),
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

export async function materializeLegacyImportProjectStaging(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportStagingStore,
): Promise<
  LegacyImportProjectStagingResult
> {
  assertDryRunInput(
    plan,
  );

  if (
    store.authority
    !== 'legacy-import-staging-only'
  ) {
    throw new Error(
      'Project staging received a store without staging-only authority.',
    );
  }

  const collected =
    collectEligibleProjects(
      plan,
    );

  const staged:
    LegacyImportStagedProjectRecord[] =
      [];

  const blockers:
    LegacyImportProjectStagingBlocker[] = [
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
    const existing =
      await store
        .readStagedRecord(
          candidate
            .conversion
            .recordId,
        );

    if (
      existing
      !== null
    ) {
      if (
        sameCanonicalRecord(
          existing,
          candidate.record,
        )
      ) {
        reusedIdentical +=
          1;

        staged.push({
          recordId:
            candidate
              .conversion
              .recordId,
          sourcePath:
            candidate
              .conversion
              .sourcePath,
          outcome:
            'reused-identical',
          record:
            candidate.record,
        });

        continue;
      }

      blockers.push({
        reason:
          'staging-record-conflict',
        recordId:
          candidate
            .conversion
            .recordId,
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
          candidate.record,
        );

    if (
      creation.ok
    ) {
      created +=
        1;

      staged.push({
        recordId:
          candidate
            .conversion
            .recordId,
        sourcePath:
          candidate
            .conversion
            .sourcePath,
        outcome:
          'created',
        record:
          candidate.record,
      });

      continue;
    }

    const raced =
      await store
        .readStagedRecord(
          candidate
            .conversion
            .recordId,
        );

    if (
      raced
      === null
    ) {
      throw new Error(
        `Project staging store reported an existing record but returned no staged record for ${candidate.conversion.recordId}.`,
      );
    }

    if (
      sameCanonicalRecord(
        raced,
        candidate.record,
      )
    ) {
      reusedIdentical +=
        1;

      staged.push({
        recordId:
          candidate
            .conversion
            .recordId,
        sourcePath:
          candidate
            .conversion
            .sourcePath,
        outcome:
          'reused-identical',
        record:
          candidate.record,
      });

      continue;
    }

    blockers.push({
      reason:
        'staging-record-conflict',
      recordId:
        candidate
          .conversion
          .recordId,
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
      LEGACY_IMPORT_PROJECT_STAGING_RESULT_SCHEMA_VERSION,
    mode:
      'staging-materialization',
    source:
      'legacy-import-project-conversions',
    scope:
      'project-records-only',
    activation:
      'not-performed',

    staged,
    blockers,

    counts: {
      projectCandidates:
        projectConversions(
          plan,
        ).length,
      eligibleProjectRecords:
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
