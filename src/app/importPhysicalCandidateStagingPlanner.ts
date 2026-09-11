import type {
  OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import {
  readLegacyImportIdentityMapping,
  writeLegacyImportIdentityMapping,
  type LegacyImportCollisionPlan,
  type LegacyImportIdentityMappingEntry,
  type LegacyImportIdentityMappingManifest,
  type LegacyImportIdentityMappingStore,
  type LegacyImportIdentityPlan,
  type LegacyImportPlan,
} from './importPlanner.js';

export const LEGACY_IMPORT_PHYSICAL_CANDIDATE_STAGING_RESULT_SCHEMA_VERSION =
  1 as const;

export interface LegacyImportPhysicalCandidateIdentityStagingStore
extends LegacyImportIdentityMappingStore {
  readonly authority:
    'legacy-import-staging-metadata-only';
}

export interface LegacyImportPhysicalCandidateStagingEntry {
  readonly kind:
    LegacyImportIdentityMappingEntry['kind'];
  readonly legacyId:
    string;
  readonly recordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly sourceRevision:
    string;
  readonly idOrigin:
    LegacyImportIdentityMappingEntry['idOrigin'];
  readonly collisionDisposition:
    LegacyImportIdentityPlan['disposition'];
  readonly collisionCandidateRecordIds:
    readonly OpaqueRecordId[];
  /**
   * Slice 11 persists identity/accounting only.
   *
   * The canonical task/project/event payload has not yet been authored at this
   * boundary and must not be guessed from the identity manifest.
   */
  readonly payloadDisposition:
    'canonical-payload-pending';
}

export interface LegacyImportPhysicalCandidateStagingResult {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_PHYSICAL_CANDIDATE_STAGING_RESULT_SCHEMA_VERSION;
  readonly mode:
    'staging-materialization';
  readonly source:
    'legacy-import-physical-identity-mapping';
  readonly scope:
    'physical-candidate-identities-only';
  readonly payloadMaterialization:
    'not-performed';
  readonly activation:
    'not-performed';
  readonly identityMappingOutcome:
    | 'created'
    | 'reused-identical';

  readonly identityMapping:
    LegacyImportIdentityMappingManifest;

  readonly candidates:
    readonly LegacyImportPhysicalCandidateStagingEntry[];

  readonly collisions:
    readonly LegacyImportCollisionPlan[];

  readonly counts: {
    readonly physicalCandidates:
      number;
    readonly candidateIdentities:
      number;
    readonly duplicateAliasCandidates:
      number;
    readonly collisionGroups:
      number;
  };

  readonly writes: {
    readonly legacyMarkdown:
      0;
    readonly recordStore:
      0;
    readonly stagingRecords:
      0;
    readonly stagingIdentityMapping:
      0 | 1;
    readonly externalArtifacts:
      0;
    readonly activation:
      0;
  };
}

const KIND_ORDER:
  Readonly<
    Record<
      LegacyImportIdentityMappingEntry['kind'],
      number
    >
  > = {
    project: 0,
    task: 1,
    event: 2,
  };

function physicalKey(
  kind:
    LegacyImportIdentityMappingEntry['kind'],
  sourcePath:
    string,
): string {
  return `${kind}\u0000${sourcePath}`;
}

function collisionKey(
  kind:
    LegacyImportIdentityMappingEntry['kind'],
  legacyId:
    string,
): string {
  return `${kind}\u0000${legacyId}`;
}

function compareMappingEntry(
  left:
    LegacyImportIdentityMappingEntry,
  right:
    LegacyImportIdentityMappingEntry,
): number {
  return KIND_ORDER[
    left.kind
  ] - KIND_ORDER[
    right.kind
  ]
    || left.sourcePath
      .localeCompare(
        right.sourcePath,
      );
}

function compareCandidate(
  left:
    LegacyImportPhysicalCandidateStagingEntry,
  right:
    LegacyImportPhysicalCandidateStagingEntry,
): number {
  return KIND_ORDER[
    left.kind
  ] - KIND_ORDER[
    right.kind
  ]
    || left.sourcePath
      .localeCompare(
        right.sourcePath,
      );
}

function cloneIdentityMapping(
  mapping:
    LegacyImportIdentityMappingManifest,
): LegacyImportIdentityMappingManifest {
  return {
    schemaVersion:
      mapping.schemaVersion,
    entries:
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
              entry.recordId,
          }),
        )
        .sort(
          compareMappingEntry,
        ),
  };
}

function cloneCollisions(
  collisions:
    readonly LegacyImportCollisionPlan[],
): LegacyImportCollisionPlan[] {
  return collisions.map(
    (collision) => ({
      kind:
        collision.kind,
      legacyId:
        collision.legacyId,
      candidates:
        collision.candidates.map(
          (candidate) => ({
            recordId:
              candidate.recordId,
            sourcePath:
              candidate.sourcePath,
            sourceRevision:
              candidate.sourceRevision,
            idOrigin:
              candidate.idOrigin,
          }),
        ),
    }),
  );
}

function mappingText(
  mapping:
    LegacyImportIdentityMappingManifest,
): string {
  return JSON.stringify(
    cloneIdentityMapping(
      mapping,
    ),
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
      'Physical-candidate identity staging accepts only a zero-write dry-run import plan.',
    );
  }
}

function collectCandidates(
  plan:
    LegacyImportPlan,
): LegacyImportPhysicalCandidateStagingEntry[] {
  if (
    plan.mappings.length
    !== plan.counts
      .physicalCandidates
  ) {
    throw new Error(
      'Physical-candidate staging received a plan whose physical candidate count does not match its identity mappings.',
    );
  }

  if (
    plan.identityMapping
      .entries
      .length
    !== plan.mappings
      .length
  ) {
    throw new Error(
      'Physical-candidate staging received an incomplete durable identity mapping.',
    );
  }

  const durableByPhysical =
    new Map<
      string,
      LegacyImportIdentityMappingEntry
    >();

  const physicalByRecordId =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const entry
    of plan.identityMapping
      .entries
  ) {
    const key =
      physicalKey(
        entry.kind,
        entry.sourcePath,
      );

    if (
      durableByPhysical.has(
        key,
      )
    ) {
      throw new Error(
        `Physical-candidate staging received duplicate physical mapping ${entry.kind} ${entry.sourcePath}.`,
      );
    }

    const previousPhysical =
      physicalByRecordId.get(
        entry.recordId,
      );

    if (
      previousPhysical
      !== undefined
    ) {
      throw new Error(
        `Physical-candidate staging received canonical record id ${entry.recordId} for multiple physical sources.`,
      );
    }

    durableByPhysical.set(
      key,
      entry,
    );

    physicalByRecordId.set(
      entry.recordId,
      key,
    );
  }

  const collisionsByAlias =
    new Map<
      string,
      LegacyImportCollisionPlan
    >();

  for (
    const collision
    of plan.collisions
  ) {
    const key =
      collisionKey(
        collision.kind,
        collision.legacyId,
      );

    if (
      collisionsByAlias.has(
        key,
      )
    ) {
      throw new Error(
        `Physical-candidate staging received duplicate collision group ${collision.kind} ${collision.legacyId}.`,
      );
    }

    collisionsByAlias.set(
      key,
      collision,
    );
  }

  const candidates:
    LegacyImportPhysicalCandidateStagingEntry[] =
      [];

  for (
    const mapping
    of plan.mappings
  ) {
    const key =
      physicalKey(
        mapping.kind,
        mapping.source.path,
      );

    const durable =
      durableByPhysical.get(
        key,
      );

    if (
      durable
      === undefined
    ) {
      throw new Error(
        `Physical-candidate staging cannot find durable identity metadata for ${mapping.kind} ${mapping.source.path}.`,
      );
    }

    if (
      durable.recordId
        !== mapping.recordId
      || durable.legacyId
        !== mapping.legacyId
      || durable.sourceRevision
        !== mapping.source.revision
      || durable.idOrigin
        !== mapping.source.idOrigin
    ) {
      throw new Error(
        `Physical-candidate staging found mismatched identity metadata for ${mapping.kind} ${mapping.source.path}.`,
      );
    }

    const collision =
      collisionsByAlias.get(
        collisionKey(
          mapping.kind,
          mapping.legacyId,
        ),
      );

    if (
      mapping.disposition
        === 'duplicate-alias-collision'
      && collision
        === undefined
    ) {
      throw new Error(
        `Physical-candidate staging lost collision evidence for ${mapping.kind} ${mapping.legacyId}.`,
      );
    }

    if (
      mapping.disposition
        === 'candidate'
      && collision
        !== undefined
    ) {
      throw new Error(
        `Physical-candidate staging received collision evidence for a non-collision mapping ${mapping.kind} ${mapping.legacyId}.`,
      );
    }

    const collisionCandidateRecordIds =
      collision
        ?.candidates
        .map(
          (candidate) =>
            candidate.recordId,
        )
      ?? [];

    if (
      collision
      !== undefined
      && !collision
        .candidates
        .some(
          (candidate) =>
            candidate.recordId
              === mapping.recordId
            && candidate.sourcePath
              === mapping.source.path,
        )
    ) {
      throw new Error(
        `Physical-candidate staging collision evidence does not contain ${mapping.kind} ${mapping.source.path}.`,
      );
    }

    candidates.push({
      kind:
        mapping.kind,
      legacyId:
        mapping.legacyId,
      recordId:
        mapping.recordId,
      sourcePath:
        mapping.source.path,
      sourceRevision:
        mapping.source.revision,
      idOrigin:
        mapping.source.idOrigin,
      collisionDisposition:
        mapping.disposition,
      collisionCandidateRecordIds,
      payloadDisposition:
        'canonical-payload-pending',
    });
  }

  return candidates.sort(
    compareCandidate,
  );
}

export async function materializeLegacyImportPhysicalCandidateIdentities(
  plan:
    LegacyImportPlan,
  store:
    LegacyImportPhysicalCandidateIdentityStagingStore,
): Promise<
  LegacyImportPhysicalCandidateStagingResult
> {
  assertDryRunInput(
    plan,
  );

  if (
    store.authority
    !== 'legacy-import-staging-metadata-only'
  ) {
    throw new Error(
      'Physical-candidate identity staging received a store without staging-metadata-only authority.',
    );
  }

  const candidates =
    collectCandidates(
      plan,
    );

  const plannedMapping =
    cloneIdentityMapping(
      plan.identityMapping,
    );

  const existing =
    await readLegacyImportIdentityMapping(
      store,
    );

  let identityMappingOutcome:
    LegacyImportPhysicalCandidateStagingResult[
      'identityMappingOutcome'
    ];

  let stagingIdentityMapping:
    0 | 1;

  if (
    existing === null
  ) {
    await writeLegacyImportIdentityMapping(
      store,
      plannedMapping,
    );

    identityMappingOutcome =
      'created';

    stagingIdentityMapping =
      1;
  } else if (
    mappingText(
      existing,
    ) === mappingText(
      plannedMapping,
    )
  ) {
    identityMappingOutcome =
      'reused-identical';

    stagingIdentityMapping =
      0;
  } else {
    throw new Error(
      'Physical-candidate staging identity mapping conflicts with the current import plan; existing staging identity metadata was not overwritten.',
    );
  }

  return {
    schemaVersion:
      LEGACY_IMPORT_PHYSICAL_CANDIDATE_STAGING_RESULT_SCHEMA_VERSION,
    mode:
      'staging-materialization',
    source:
      'legacy-import-physical-identity-mapping',
    scope:
      'physical-candidate-identities-only',
    payloadMaterialization:
      'not-performed',
    activation:
      'not-performed',
    identityMappingOutcome,

    identityMapping:
      plannedMapping,

    candidates,

    collisions:
      cloneCollisions(
        plan.collisions,
      ),

    counts: {
      physicalCandidates:
        plan.counts
          .physicalCandidates,
      candidateIdentities:
        candidates.length,
      duplicateAliasCandidates:
        candidates.filter(
          (candidate) =>
            candidate
              .collisionDisposition
            === 'duplicate-alias-collision',
        ).length,
      collisionGroups:
        plan.collisions
          .length,
    },

    writes: {
      legacyMarkdown: 0,
      recordStore: 0,
      stagingRecords: 0,
      stagingIdentityMapping,
      externalArtifacts: 0,
      activation: 0,
    },
  };
}
