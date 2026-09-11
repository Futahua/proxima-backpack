import {
  encodeCanonicalRecordV2,
  type CanonicalRecordV2,
} from '../domain/canonicalRecordV2.js';
import type {
  OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import type {
  LegacyImportRollupSchemaUnresolvedReason,
} from './importDerivedPropertyPlanner.js';
import type {
  LegacyImportPlan,
} from './importPlanner.js';
import type {
  LegacyImportPendingSchemaReason,
  LegacyImportSchemaScope,
} from './importSchemaPlanner.js';

export const LEGACY_IMPORT_SCHEMA_STAGING_RESULT_VERSION =
  1 as const;

export type LegacyImportStagingCreateResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly reason:
        'already-exists';
    };

/**
 * Deliberately narrower than the canonical Record Store.
 *
 * Slice 9 receives only an isolated import-staging capability. It can inspect
 * staged records and create absent staged records. It cannot update, delete,
 * activate, or address the live canonical Record Store.
 */
export interface LegacyImportStagingStore {
  readonly authority:
    'legacy-import-staging-only';

  readStagedRecord(
    recordId:
      OpaqueRecordId,
  ): Promise<
    CanonicalRecordV2 | null
  >;

  createStagedRecord(
    record:
      CanonicalRecordV2,
  ): Promise<
    LegacyImportStagingCreateResult
  >;
}

export type LegacyImportSchemaStagingBlocker =
  | {
      readonly reason:
        'schema-settings-plan-missing';
      readonly recordId:
        null;
      readonly scope:
        null;
      readonly legacySchemaId:
        null;
    }
  | {
      readonly reason:
        'schema-conversion-pending';
      readonly recordId:
        OpaqueRecordId;
      readonly scope:
        LegacyImportSchemaScope;
      readonly legacySchemaId:
        string;
      readonly pending:
        LegacyImportPendingSchemaReason;
    }
  | {
      readonly reason:
        'rollup-schema-unresolved';
      readonly recordId:
        OpaqueRecordId;
      readonly scope:
        LegacyImportSchemaScope;
      readonly legacySchemaId:
        string;
      readonly rollupReason:
        LegacyImportRollupSchemaUnresolvedReason;
    }
  | {
      readonly reason:
        'planning-record-conflict';
      readonly recordId:
        OpaqueRecordId;
      readonly scope:
        LegacyImportSchemaScope;
      readonly legacySchemaId:
        string;
    }
  | {
      readonly reason:
        'staging-record-conflict';
      readonly recordId:
        OpaqueRecordId;
      readonly scope:
        LegacyImportSchemaScope;
      readonly legacySchemaId:
        string;
    };

export interface LegacyImportStagedSchemaRecord {
  readonly recordId:
    OpaqueRecordId;
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly origin:
    | 'schema-settings'
    | 'derived-rollup';
  readonly outcome:
    | 'created'
    | 'reused-identical';
  readonly record:
    CanonicalRecordV2;
}

export interface LegacyImportSchemaStagingResult {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_SCHEMA_STAGING_RESULT_VERSION;
  readonly mode:
    'staging-materialization';
  readonly source:
    'legacy-import-plan-schema-conversions';
  readonly scope:
    'schema-records-only';
  readonly activation:
    'not-performed';

  readonly staged:
    readonly LegacyImportStagedSchemaRecord[];

  readonly blockers:
    readonly LegacyImportSchemaStagingBlocker[];

  readonly counts: {
    readonly eligibleSchemaRecords:
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

interface CanonicalSchemaStagingCandidate {
  readonly recordId:
    OpaqueRecordId;
  readonly scope:
    LegacyImportSchemaScope;
  readonly legacySchemaId:
    string;
  readonly origin:
    | 'schema-settings'
    | 'derived-rollup';
  readonly record:
    CanonicalRecordV2;
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

function compareCandidate(
  left:
    CanonicalSchemaStagingCandidate,
  right:
    CanonicalSchemaStagingCandidate,
): number {
  return left.recordId
    .localeCompare(
      right.recordId,
    );
}

function compareBlocker(
  left:
    LegacyImportSchemaStagingBlocker,
  right:
    LegacyImportSchemaStagingBlocker,
): number {
  const leftId =
    left.recordId
    ?? '';

  const rightId =
    right.recordId
    ?? '';

  return leftId
    .localeCompare(
      rightId,
    )
    || left.reason
      .localeCompare(
        right.reason,
      );
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
      'Legacy import schema staging accepts only a zero-write dry-run import plan.',
    );
  }
}

function collectSchemaCandidates(
  plan:
    LegacyImportPlan,
): {
  readonly candidates:
    CanonicalSchemaStagingCandidate[];
  readonly blockers:
    LegacyImportSchemaStagingBlocker[];
} {
  const schemaSettings =
    plan.schemaSettings;

  if (
    schemaSettings
    === null
  ) {
    return {
      candidates: [],
      blockers: [
        {
          reason:
            'schema-settings-plan-missing',
          recordId:
            null,
          scope:
            null,
          legacySchemaId:
            null,
        },
      ],
    };
  }

  const candidateById =
    new Map<
      OpaqueRecordId,
      CanonicalSchemaStagingCandidate
    >();

  const pendingById =
    new Map<
      OpaqueRecordId,
      LegacyImportSchemaStagingBlocker
    >();

  const planningConflictIds =
    new Set<
      OpaqueRecordId
    >();

  const planningConflicts:
    LegacyImportSchemaStagingBlocker[] =
      [];

  const appendCandidate = (
    candidate:
      CanonicalSchemaStagingCandidate,
  ): void => {
    if (
      planningConflictIds.has(
        candidate.recordId,
      )
    ) {
      return;
    }

    const previous =
      candidateById.get(
        candidate.recordId,
      );

    if (
      previous
      === undefined
    ) {
      candidateById.set(
        candidate.recordId,
        candidate,
      );

      return;
    }

    if (
      sameCanonicalRecord(
        previous.record,
        candidate.record,
      )
    ) {
      return;
    }

    candidateById.delete(
      candidate.recordId,
    );

    pendingById.delete(
      candidate.recordId,
    );

    planningConflictIds.add(
      candidate.recordId,
    );

    planningConflicts.push({
      reason:
        'planning-record-conflict',
      recordId:
        candidate.recordId,
      scope:
        cloneScope(
          candidate.scope,
        ),
      legacySchemaId:
        candidate.legacySchemaId,
    });
  };

  for (
    const conversion
    of schemaSettings
      .conversions
  ) {
    if (
      conversion.disposition
      === 'canonical-ready'
    ) {
      appendCandidate({
        recordId:
          conversion.record.id,
        scope:
          cloneScope(
            conversion.scope,
          ),
        legacySchemaId:
          conversion.legacySchemaId,
        origin:
          'schema-settings',
        record:
          conversion.record,
      });

      continue;
    }

    pendingById.set(
      conversion.recordId,
      {
        reason:
          'schema-conversion-pending',
        recordId:
          conversion.recordId,
        scope:
          cloneScope(
            conversion.scope,
          ),
        legacySchemaId:
          conversion.legacySchemaId,
        pending:
          conversion.pending,
      },
    );
  }

  const derived =
    plan.derivedProperties;

  if (
    derived
    !== null
  ) {
    for (
      const rollup
      of derived.rollupSchemas
    ) {
      if (
        rollup.disposition
        === 'canonical-ready'
      ) {
        pendingById.delete(
          rollup.schemaRecordId,
        );

        appendCandidate({
          recordId:
            rollup.schemaRecordId,
          scope:
            cloneScope(
              rollup.scope,
            ),
          legacySchemaId:
            rollup.legacySchemaId,
          origin:
            'derived-rollup',
          record:
            rollup.record,
        });

        continue;
      }

      candidateById.delete(
        rollup.schemaRecordId,
      );

      pendingById.set(
        rollup.schemaRecordId,
        {
          reason:
            'rollup-schema-unresolved',
          recordId:
            rollup.schemaRecordId,
          scope:
            cloneScope(
              rollup.scope,
            ),
          legacySchemaId:
            rollup.legacySchemaId,
          rollupReason:
            rollup.reason,
        },
      );
    }
  }

  for (
    const conflictId
    of planningConflictIds
  ) {
    pendingById.delete(
      conflictId,
    );
  }

  return {
    candidates:
      [
        ...candidateById
          .values(),
      ].sort(
        compareCandidate,
      ),
    blockers:
      [
        ...planningConflicts,
        ...pendingById
          .values(),
      ].sort(
        compareBlocker,
      ),
  };
}

/**
 * Materialize only already-authored canonical schema records into an isolated
 * staging store.
 *
 * Existing identical records are resumed/reused. Existing different records
 * become blockers and are never overwritten. A create race is reconciled by
 * reading the winning staged record and applying the same equality rule.
 */
export async function materializeLegacyImportSchemaStaging(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportStagingStore,
): Promise<
  LegacyImportSchemaStagingResult
> {
  assertDryRunInput(
    plan,
  );

  if (
    store.authority
    !== 'legacy-import-staging-only'
  ) {
    throw new Error(
      'Legacy import schema staging received a store without staging-only authority.',
    );
  }

  const collected =
    collectSchemaCandidates(
      plan,
    );

  const staged:
    LegacyImportStagedSchemaRecord[] =
      [];

  const blockers:
    LegacyImportSchemaStagingBlocker[] = [
      ...collected.blockers,
    ];

  let created = 0;
  let reusedIdentical = 0;

  for (
    const candidate
    of collected.candidates
  ) {
    const normalized =
      encodeCanonicalRecordV2(
        candidate.record,
      );

    const existing =
      await store
        .readStagedRecord(
          candidate.recordId,
        );

    if (
      existing
      !== null
    ) {
      if (
        sameCanonicalRecord(
          existing,
          normalized,
        )
      ) {
        reusedIdentical += 1;

        staged.push({
          recordId:
            candidate.recordId,
          scope:
            cloneScope(
              candidate.scope,
            ),
          legacySchemaId:
            candidate.legacySchemaId,
          origin:
            candidate.origin,
          outcome:
            'reused-identical',
          record:
            normalized,
        });

        continue;
      }

      blockers.push({
        reason:
          'staging-record-conflict',
        recordId:
          candidate.recordId,
        scope:
          cloneScope(
            candidate.scope,
          ),
        legacySchemaId:
          candidate.legacySchemaId,
      });

      continue;
    }

    const creation =
      await store
        .createStagedRecord(
          normalized,
        );

    if (
      creation.ok
    ) {
      created += 1;

      staged.push({
        recordId:
          candidate.recordId,
        scope:
          cloneScope(
            candidate.scope,
          ),
        legacySchemaId:
          candidate.legacySchemaId,
        origin:
          candidate.origin,
        outcome:
          'created',
        record:
          normalized,
      });

      continue;
    }

    const raced =
      await store
        .readStagedRecord(
          candidate.recordId,
        );

    if (
      raced
      === null
    ) {
      throw new Error(
        `Legacy import staging store reported an existing record but returned no staged record for ${candidate.recordId}.`,
      );
    }

    if (
      sameCanonicalRecord(
        raced,
        normalized,
      )
    ) {
      reusedIdentical += 1;

      staged.push({
        recordId:
          candidate.recordId,
        scope:
          cloneScope(
            candidate.scope,
          ),
        legacySchemaId:
          candidate.legacySchemaId,
        origin:
          candidate.origin,
        outcome:
          'reused-identical',
        record:
          normalized,
      });

      continue;
    }

    blockers.push({
      reason:
        'staging-record-conflict',
      recordId:
        candidate.recordId,
      scope:
        cloneScope(
          candidate.scope,
        ),
      legacySchemaId:
        candidate.legacySchemaId,
    });
  }

  blockers.sort(
    compareBlocker,
  );

  staged.sort(
    (
      left,
      right,
    ) =>
      left.recordId
        .localeCompare(
          right.recordId,
        ),
  );

  return {
    schemaVersion:
      LEGACY_IMPORT_SCHEMA_STAGING_RESULT_VERSION,
    mode:
      'staging-materialization',
    source:
      'legacy-import-plan-schema-conversions',
    scope:
      'schema-records-only',
    activation:
      'not-performed',

    staged,
    blockers,

    counts: {
      eligibleSchemaRecords:
        collected.candidates
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
