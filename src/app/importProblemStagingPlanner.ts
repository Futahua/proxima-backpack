import type {
  OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import {
  DIAGNOSTIC_LIMITS,
} from './diagnostics.js';
import {
  LEGACY_IMPORT_PLAN_SCHEMA_VERSION,
  type LegacyImportIdentityPlan,
  type LegacyImportPlan,
  type LegacyImportProblemPlan,
} from './importPlanner.js';

export const LEGACY_IMPORT_PROBLEM_STAGING_MANIFEST_SCHEMA_VERSION =
  1 as const;

export interface LegacyImportStagedProblemEvidence {
  readonly code:
    | 'frontmatter-parse-failure'
    | 'unsupported-frontmatter';
  readonly severity:
    LegacyImportProblemPlan['severity'];
  readonly diagnostic:
    string;
}

export interface LegacyImportMalformedRecordStagingEntry {
  readonly sourcePath:
    string;
  readonly sourceRevision:
    string | null;
  readonly kind:
    LegacyImportProblemPlan['kind'];
  readonly legacyId:
    string | null;
  readonly recordId:
    OpaqueRecordId | null;
  readonly disposition:
    'unresolved-malformed-record';
  readonly problems:
    readonly LegacyImportStagedProblemEvidence[];
}

export interface LegacyImportUnsupportedFrontmatterStagingEntry {
  readonly sourcePath:
    string;
  readonly sourceRevision:
    string | null;
  readonly kind:
    LegacyImportProblemPlan['kind'];
  readonly legacyId:
    string | null;
  readonly recordId:
    OpaqueRecordId | null;
  readonly disposition:
    'unsupported-frontmatter-policy-pending';
  readonly problems:
    readonly LegacyImportStagedProblemEvidence[];
}

export interface LegacyImportProblemStagingManifest {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_PROBLEM_STAGING_MANIFEST_SCHEMA_VERSION;
  readonly sourcePlanSchemaVersion:
    typeof LEGACY_IMPORT_PLAN_SCHEMA_VERSION;
  readonly malformedRecords:
    readonly LegacyImportMalformedRecordStagingEntry[];
  readonly unsupportedFrontmatter:
    readonly LegacyImportUnsupportedFrontmatterStagingEntry[];
  readonly counts: {
    readonly unresolvedRecordCount:
      number;
    readonly malformedProblems:
      number;
    readonly unsupportedFrontmatterPolicyPendingRecords:
      number;
    readonly unsupportedFrontmatterProblems:
      number;
  };
}

export interface LegacyImportProblemStagingStore {
  readonly authority:
    'legacy-import-staging-metadata-only';

  load():
    Promise<
      LegacyImportProblemStagingManifest | null
    >;

  save(
    manifest:
      LegacyImportProblemStagingManifest,
  ): Promise<void>;
}

export interface LegacyImportProblemStagingResult {
  readonly schemaVersion:
    1;
  readonly mode:
    'staging-materialization';
  readonly source:
    'legacy-import-problem-plan';
  readonly scope:
    'import-problem-evidence-only';
  readonly payloadMaterialization:
    'not-performed';
  readonly activation:
    'not-performed';
  readonly manifestOutcome:
    | 'created'
    | 'reused-identical';

  readonly manifest:
    LegacyImportProblemStagingManifest;

  readonly writes: {
    readonly legacyMarkdown:
      0;
    readonly recordStore:
      0;
    readonly stagingRecords:
      0;
    readonly stagingProblemMetadata:
      0 | 1;
    readonly externalArtifacts:
      0;
    readonly activation:
      0;
  };
}

interface MutableProblemGroup {
  readonly sourcePath:
    string;
  readonly sourceRevision:
    string | null;
  readonly kind:
    LegacyImportProblemPlan['kind'];
  readonly legacyId:
    string | null;
  readonly recordId:
    OpaqueRecordId | null;
  readonly problems:
    LegacyImportStagedProblemEvidence[];
}

function physicalProblemKey(
  kind:
    LegacyImportProblemPlan['kind'],
  sourcePath:
    string,
): string {
  return JSON.stringify([
    kind,
    sourcePath,
  ]);
}

function compareProblemEvidence(
  left:
    LegacyImportStagedProblemEvidence,
  right:
    LegacyImportStagedProblemEvidence,
): number {
  return left.code
    .localeCompare(
      right.code,
    )
    || left.diagnostic
      .localeCompare(
        right.diagnostic,
      );
}

function compareProblemGroup(
  left:
    {
      readonly kind:
        LegacyImportProblemPlan['kind'];
      readonly sourcePath:
        string;
    },
  right:
    {
      readonly kind:
        LegacyImportProblemPlan['kind'];
      readonly sourcePath:
        string;
    },
): number {
  return String(
    left.kind
    ?? '',
  ).localeCompare(
    String(
      right.kind
      ?? '',
    ),
  )
    || left.sourcePath
      .localeCompare(
        right.sourcePath,
      );
}

function mappingForProblem(
  plan:
    LegacyImportPlan,
  problem:
    LegacyImportProblemPlan,
): LegacyImportIdentityPlan | null {
  if (
    problem.kind
    === null
  ) {
    return null;
  }

  const matches =
    plan.mappings.filter(
      (mapping) =>
        mapping.kind
          === problem.kind
        && mapping.source.path
          === problem.sourcePath,
    );

  if (
    matches.length
    > 1
  ) {
    throw new Error(
      `Import problem staging found multiple candidate identities for ${problem.kind} ${problem.sourcePath}.`,
    );
  }

  return matches[0]
    ?? null;
}

function boundedProblemEvidence(
  problem:
    LegacyImportProblemPlan,
): LegacyImportStagedProblemEvidence {
  if (
    problem.code
      !== 'frontmatter-parse-failure'
    && problem.code
      !== 'unsupported-frontmatter'
  ) {
    throw new Error(
      `Import problem staging cannot encode non-target problem code ${problem.code}.`,
    );
  }

  return {
    code:
      problem.code,
    severity:
      problem.severity,
    diagnostic:
      problem.diagnostic.slice(
        0,
        DIAGNOSTIC_LIMITS
          .problemDetail,
      ),
  };
}

function appendProblem(
  groups:
    Map<
      string,
      MutableProblemGroup
    >,
  plan:
    LegacyImportPlan,
  problem:
    LegacyImportProblemPlan,
): void {
  const mapping =
    mappingForProblem(
      plan,
      problem,
    );

  const key =
    physicalProblemKey(
      problem.kind,
      problem.sourcePath,
    );

  const existing =
    groups.get(
      key,
    );

  const sourceRevision =
    mapping?.source.revision
    ?? null;

  const legacyId =
    mapping?.legacyId
    ?? problem.legacyId;

  const recordId =
    mapping?.recordId
    ?? null;

  if (
    existing
    !== undefined
  ) {
    if (
      existing.sourceRevision
        !== sourceRevision
      || existing.legacyId
        !== legacyId
      || existing.recordId
        !== recordId
    ) {
      throw new Error(
        `Import problem staging found inconsistent source identity evidence for ${problem.sourcePath}.`,
      );
    }

    existing.problems.push(
      boundedProblemEvidence(
        problem,
      ),
    );

    return;
  }

  groups.set(
    key,
    {
      sourcePath:
        problem.sourcePath,
      sourceRevision,
      kind:
        problem.kind,
      legacyId,
      recordId,
      problems: [
        boundedProblemEvidence(
          problem,
        ),
      ],
    },
  );
}

function collectTargetProblems(
  plan:
    LegacyImportPlan,
): {
  readonly malformedRecords:
    LegacyImportMalformedRecordStagingEntry[];
  readonly unsupportedFrontmatter:
    LegacyImportUnsupportedFrontmatterStagingEntry[];
} {
  const malformed =
    new Map<
      string,
      MutableProblemGroup
    >();

  const unsupported =
    new Map<
      string,
      MutableProblemGroup
    >();

  for (
    const problem
    of plan.problems
  ) {
    if (
      problem.code
      === 'frontmatter-parse-failure'
    ) {
      appendProblem(
        malformed,
        plan,
        problem,
      );

      continue;
    }

    if (
      problem.code
      === 'unsupported-frontmatter'
    ) {
      if (
        problem.disposition
        !== 'unsupported-frontmatter-policy-pending'
      ) {
        throw new Error(
          `Import problem staging received unsupported-frontmatter without policy-pending disposition for ${problem.sourcePath}.`,
        );
      }

      appendProblem(
        unsupported,
        plan,
        problem,
      );
    }
  }

  const malformedRecords =
    [
      ...malformed.values(),
    ]
      .map(
        (
          group,
        ): LegacyImportMalformedRecordStagingEntry => ({
          sourcePath:
            group.sourcePath,
          sourceRevision:
            group.sourceRevision,
          kind:
            group.kind,
          legacyId:
            group.legacyId,
          recordId:
            group.recordId,
          disposition:
            'unresolved-malformed-record',
          problems:
            [
              ...group.problems,
            ].sort(
              compareProblemEvidence,
            ),
        }),
      )
      .sort(
        compareProblemGroup,
      );

  const unsupportedFrontmatter =
    [
      ...unsupported.values(),
    ]
      .map(
        (
          group,
        ): LegacyImportUnsupportedFrontmatterStagingEntry => ({
          sourcePath:
            group.sourcePath,
          sourceRevision:
            group.sourceRevision,
          kind:
            group.kind,
          legacyId:
            group.legacyId,
          recordId:
            group.recordId,
          disposition:
            'unsupported-frontmatter-policy-pending',
          problems:
            [
              ...group.problems,
            ].sort(
              compareProblemEvidence,
            ),
        }),
      )
      .sort(
        compareProblemGroup,
      );

  return {
    malformedRecords,
    unsupportedFrontmatter,
  };
}

function cloneMalformedRecord(
  entry:
    LegacyImportMalformedRecordStagingEntry,
): LegacyImportMalformedRecordStagingEntry {
  return {
    sourcePath:
      entry.sourcePath,
    sourceRevision:
      entry.sourceRevision,
    kind:
      entry.kind,
    legacyId:
      entry.legacyId,
    recordId:
      entry.recordId,
    disposition:
      'unresolved-malformed-record',
    problems:
      entry.problems
        .map(
          (problem) => ({
            code:
              problem.code,
            severity:
              problem.severity,
            diagnostic:
              problem.diagnostic,
          }),
        )
        .sort(
          compareProblemEvidence,
        ),
  };
}

function cloneUnsupportedFrontmatter(
  entry:
    LegacyImportUnsupportedFrontmatterStagingEntry,
): LegacyImportUnsupportedFrontmatterStagingEntry {
  return {
    sourcePath:
      entry.sourcePath,
    sourceRevision:
      entry.sourceRevision,
    kind:
      entry.kind,
    legacyId:
      entry.legacyId,
    recordId:
      entry.recordId,
    disposition:
      'unsupported-frontmatter-policy-pending',
    problems:
      entry.problems
        .map(
          (problem) => ({
            code:
              problem.code,
            severity:
              problem.severity,
            diagnostic:
              problem.diagnostic,
          }),
        )
        .sort(
          compareProblemEvidence,
        ),
  };
}

function normalizeManifest(
  manifest:
    LegacyImportProblemStagingManifest,
): LegacyImportProblemStagingManifest {
  if (
    manifest.schemaVersion
    !== LEGACY_IMPORT_PROBLEM_STAGING_MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported import problem staging manifest schema ${String(manifest.schemaVersion)}.`,
    );
  }

  if (
    manifest.sourcePlanSchemaVersion
    !== LEGACY_IMPORT_PLAN_SCHEMA_VERSION
  ) {
    throw new Error(
      `Import problem staging manifest belongs to import plan schema ${String(manifest.sourcePlanSchemaVersion)}, not ${LEGACY_IMPORT_PLAN_SCHEMA_VERSION}.`,
    );
  }

  const malformedRecords =
    manifest.malformedRecords
      .map(
        cloneMalformedRecord,
      )
      .sort(
        compareProblemGroup,
      );

  const unsupportedFrontmatter =
    manifest.unsupportedFrontmatter
      .map(
        cloneUnsupportedFrontmatter,
      )
      .sort(
        compareProblemGroup,
      );

  return {
    schemaVersion:
      LEGACY_IMPORT_PROBLEM_STAGING_MANIFEST_SCHEMA_VERSION,
    sourcePlanSchemaVersion:
      LEGACY_IMPORT_PLAN_SCHEMA_VERSION,
    malformedRecords,
    unsupportedFrontmatter,
    counts: {
      unresolvedRecordCount:
        malformedRecords.length,
      malformedProblems:
        malformedRecords.reduce(
          (
            total,
            record,
          ) =>
            total
            + record.problems.length,
          0,
        ),
      unsupportedFrontmatterPolicyPendingRecords:
        unsupportedFrontmatter.length,
      unsupportedFrontmatterProblems:
        unsupportedFrontmatter.reduce(
          (
            total,
            record,
          ) =>
            total
            + record.problems.length,
          0,
        ),
    },
  };
}

function manifestText(
  manifest:
    LegacyImportProblemStagingManifest,
): string {
  return JSON.stringify(
    normalizeManifest(
      manifest,
    ),
  );
}

function plannedManifest(
  plan:
    LegacyImportPlan,
): LegacyImportProblemStagingManifest {
  const collected =
    collectTargetProblems(
      plan,
    );

  return normalizeManifest({
    schemaVersion:
      LEGACY_IMPORT_PROBLEM_STAGING_MANIFEST_SCHEMA_VERSION,
    sourcePlanSchemaVersion:
      LEGACY_IMPORT_PLAN_SCHEMA_VERSION,
    malformedRecords:
      collected.malformedRecords,
    unsupportedFrontmatter:
      collected.unsupportedFrontmatter,
    counts: {
      unresolvedRecordCount: 0,
      malformedProblems: 0,
      unsupportedFrontmatterPolicyPendingRecords: 0,
      unsupportedFrontmatterProblems: 0,
    },
  });
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
      'Import problem staging accepts only a zero-write dry-run import plan.',
    );
  }
}

export async function materializeLegacyImportProblemEvidence(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportProblemStagingStore,
): Promise<
  LegacyImportProblemStagingResult
> {
  assertDryRunInput(
    plan,
  );

  if (
    store.authority
    !== 'legacy-import-staging-metadata-only'
  ) {
    throw new Error(
      'Import problem staging received a store without staging-metadata-only authority.',
    );
  }

  const planned =
    plannedManifest(
      plan,
    );

  const existing =
    await store.load();

  let manifestOutcome:
    LegacyImportProblemStagingResult[
      'manifestOutcome'
    ];

  let stagingProblemMetadata:
    0 | 1;

  if (
    existing
    === null
  ) {
    await store.save(
      planned,
    );

    manifestOutcome =
      'created';

    stagingProblemMetadata =
      1;
  } else if (
    manifestText(
      existing,
    )
    === manifestText(
      planned,
    )
  ) {
    manifestOutcome =
      'reused-identical';

    stagingProblemMetadata =
      0;
  } else {
    throw new Error(
      'Import problem staging metadata conflicts with the current dry-run plan and was not overwritten.',
    );
  }

  return {
    schemaVersion: 1,
    mode:
      'staging-materialization',
    source:
      'legacy-import-problem-plan',
    scope:
      'import-problem-evidence-only',
    payloadMaterialization:
      'not-performed',
    activation:
      'not-performed',
    manifestOutcome,
    manifest:
      planned,
    writes: {
      legacyMarkdown: 0,
      recordStore: 0,
      stagingRecords: 0,
      stagingProblemMetadata,
      externalArtifacts: 0,
      activation: 0,
    },
  };
}
