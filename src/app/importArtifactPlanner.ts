import {
  defineExternalArtifactReference,
  defineProjectArtifactAssociations,
  parseOpaqueExternalArtifactId,
  type CanonicalProjectArtifactAssociations,
  type ExternalArtifactLocator,
  type ExternalArtifactReference,
  type OpaqueExternalArtifactId,
} from '../domain/canonicalArtifactAssociation.js';
import type {
  OpaqueRecordId,
} from '../domain/canonicalIdentity.js';
import type {
  RecordKind,
} from '../domain/records.js';
import type {
  LegacyPhysicalRecordCandidate,
} from './vaultRepository.js';

export const LEGACY_IMPORT_ARTIFACT_PLAN_SCHEMA_VERSION =
  1 as const;

export const LEGACY_IMPORT_ARTIFACT_IDENTITY_MAPPING_SCHEMA_VERSION =
  1 as const;

export interface LegacyImportArtifactIdentityRequest {
  readonly legacyLocatorPath:
    string;
}

export interface LegacyImportArtifactIdentityAllocator {
  artifactIdFor(
    request:
      LegacyImportArtifactIdentityRequest,
  ): string;
}

export interface LegacyImportArtifactIdentityMappingEntry {
  readonly legacyLocatorPath:
    string;
  readonly artifactId:
    OpaqueExternalArtifactId;
}

export interface LegacyImportArtifactIdentityMappingManifest {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_ARTIFACT_IDENTITY_MAPPING_SCHEMA_VERSION;
  /**
   * This is only the one-time import reconciliation key.
   *
   * It does not claim that Proxima can recognize the same external artifact
   * after an out-of-band rename. That question remains explicitly open.
   */
  readonly reconciliationKey:
    'exact-legacy-locator-path';
  readonly entries:
    readonly LegacyImportArtifactIdentityMappingEntry[];
}

export interface LegacyImportArtifactPlanningInput {
  readonly allocator:
    LegacyImportArtifactIdentityAllocator;
  readonly priorIdentityMapping?:
    LegacyImportArtifactIdentityMappingManifest | null;
}

export interface LegacyImportArtifactRecordIdentity {
  readonly kind:
    RecordKind;
  readonly sourcePath:
    string;
  readonly recordId:
    OpaqueRecordId;
}

export interface LegacyImportProjectArtifactLinkPlan {
  readonly legacyName:
    string;
  readonly legacyLocatorPath:
    string;
  readonly artifactId:
    OpaqueExternalArtifactId;
}

export interface LegacyImportProjectArtifactPlan {
  readonly projectRecordId:
    OpaqueRecordId;
  readonly sourcePath:
    string;
  readonly association:
    CanonicalProjectArtifactAssociations;
  readonly legacyLinks:
    readonly LegacyImportProjectArtifactLinkPlan[];
}

export interface LegacyImportExternalArtifactPlan {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_ARTIFACT_PLAN_SCHEMA_VERSION;
  readonly mode:
    'dry-run';
  readonly source:
    'interpreted-legacy-project-linked-folders';
  readonly contentPolicy:
    'reference-only-no-copy';
  readonly externalRenameContinuity:
    'not-claimed';
  readonly identityMapping:
    LegacyImportArtifactIdentityMappingManifest;
  readonly references:
    readonly ExternalArtifactReference[];
  readonly projects:
    readonly LegacyImportProjectArtifactPlan[];
  readonly counts: {
    readonly projectCandidates:
      number;
    readonly projectLinks:
      number;
    readonly externalArtifactReferences:
      number;
    readonly reservedArtifactIdentities:
      number;
  };
  readonly writes: {
    readonly legacyMarkdown:
      0;
    readonly recordStore:
      0;
    readonly staging:
      0;
    readonly externalArtifacts:
      0;
  };
}

export interface LegacyImportExternalArtifactPlanningRequest {
  readonly candidates:
    readonly LegacyPhysicalRecordCandidate[];
  readonly identities:
    readonly LegacyImportArtifactRecordIdentity[];
  readonly planning:
    LegacyImportArtifactPlanningInput;
}

function comparePath(
  left:
    string,
  right:
    string,
): number {
  return left.localeCompare(
    right,
  );
}

function physicalKey(
  kind:
    RecordKind,
  sourcePath:
    string,
): string {
  return `${kind}\u0000${sourcePath}`;
}

function normalizeIdentityMapping(
  mapping:
    LegacyImportArtifactIdentityMappingManifest | null,
): LegacyImportArtifactIdentityMappingManifest {
  if (mapping === null) {
    return {
      schemaVersion:
        LEGACY_IMPORT_ARTIFACT_IDENTITY_MAPPING_SCHEMA_VERSION,
      reconciliationKey:
        'exact-legacy-locator-path',
      entries: [],
    };
  }

  if (
    mapping.schemaVersion
    !== LEGACY_IMPORT_ARTIFACT_IDENTITY_MAPPING_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported legacy import artifact identity mapping schema: ${String(mapping.schemaVersion)}`,
    );
  }

  if (
    mapping.reconciliationKey
    !== 'exact-legacy-locator-path'
  ) {
    throw new Error(
      `Unsupported legacy import artifact reconciliation key: ${String(mapping.reconciliationKey)}`,
    );
  }

  const byPath =
    new Map<
      string,
      OpaqueExternalArtifactId
    >();

  const pathById =
    new Map<
      OpaqueExternalArtifactId,
      string
    >();

  const entries =
    mapping.entries
      .map(
        (entry) => ({
          legacyLocatorPath:
            entry.legacyLocatorPath,
          artifactId:
            parseOpaqueExternalArtifactId(
              entry.artifactId,
            ),
        }),
      )
      .sort(
        (left, right) =>
          comparePath(
            left.legacyLocatorPath,
            right.legacyLocatorPath,
          ),
      );

  for (
    const entry
    of entries
  ) {
    if (
      entry.legacyLocatorPath
        .trim()
        .length
      === 0
    ) {
      throw new Error(
        'Legacy import artifact identity mapping entries need a non-empty legacy locator path.',
      );
    }

    if (
      byPath.has(
        entry.legacyLocatorPath,
      )
    ) {
      throw new Error(
        `Legacy import artifact identity mapping contains duplicate locator path ${entry.legacyLocatorPath}.`,
      );
    }

    const existingPath =
      pathById.get(
        entry.artifactId,
      );

    if (
      existingPath
      !== undefined
    ) {
      throw new Error(
        `Legacy import artifact identity mapping reuses external-artifact id ${entry.artifactId} for ${entry.legacyLocatorPath}; already assigned to ${existingPath}.`,
      );
    }

    byPath.set(
      entry.legacyLocatorPath,
      entry.artifactId,
    );

    pathById.set(
      entry.artifactId,
      entry.legacyLocatorPath,
    );
  }

  return {
    schemaVersion:
      LEGACY_IMPORT_ARTIFACT_IDENTITY_MAPPING_SCHEMA_VERSION,
    reconciliationKey:
      'exact-legacy-locator-path',
    entries,
  };
}

function locatorForLegacyPath(
  path:
    string,
): ExternalArtifactLocator {
  const machinePath =
    /^[A-Za-z]:[\\/]/.test(
      path,
    )
    || /^\\\\/.test(
      path,
    )
    || path.startsWith(
      '/',
    );

  return {
    kind:
      machinePath
        ? 'machine-path'
        : 'vault-relative-path',
    path,
  };
}

export function planLegacyExternalArtifacts(
  input:
    LegacyImportExternalArtifactPlanningRequest,
): LegacyImportExternalArtifactPlan {
  const prior =
    normalizeIdentityMapping(
      input.planning
        .priorIdentityMapping
      ?? null,
    );

  const identityEntries:
    LegacyImportArtifactIdentityMappingEntry[] =
      prior.entries.map(
        (entry) => ({
          ...entry,
        }),
      );

  const artifactIdByPath =
    new Map<
      string,
      OpaqueExternalArtifactId
    >();

  const pathByArtifactId =
    new Map<
      OpaqueExternalArtifactId,
      string
    >();

  for (
    const entry
    of identityEntries
  ) {
    artifactIdByPath.set(
      entry.legacyLocatorPath,
      entry.artifactId,
    );

    pathByArtifactId.set(
      entry.artifactId,
      entry.legacyLocatorPath,
    );
  }

  const recordIdByPhysical =
    new Map<
      string,
      OpaqueRecordId
    >();

  for (
    const identity
    of input.identities
  ) {
    const key =
      physicalKey(
        identity.kind,
        identity.sourcePath,
      );

    if (
      recordIdByPhysical.has(
        key,
      )
    ) {
      throw new Error(
        `Legacy import artifact planner received duplicate physical record identity ${identity.kind} ${identity.sourcePath}.`,
      );
    }

    recordIdByPhysical.set(
      key,
      identity.recordId,
    );
  }

  const projectCandidates =
    input.candidates
      .filter(
        (candidate) =>
          candidate.kind
          === 'project',
      )
      .sort(
        (left, right) =>
          comparePath(
            left.source.path,
            right.source.path,
          ),
      );

  const currentPaths =
    new Set<
      string
    >();

  for (
    const candidate
    of projectCandidates
  ) {
    const linkedFolders =
      candidate.compatibility
        .projectLinkedFolders;

    if (
      linkedFolders
      === null
    ) {
      throw new Error(
        `Legacy import artifact planner is missing interpreted linked folders for project ${candidate.source.path}.`,
      );
    }

    for (
      const folder
      of linkedFolders
    ) {
      if (
        folder.path
          .trim()
          .length
        === 0
      ) {
        throw new Error(
          `Legacy import artifact planner received an empty linked-folder path for project ${candidate.source.path}.`,
        );
      }

      currentPaths.add(
        folder.path,
      );
    }
  }

  const sortedCurrentPaths =
    [
      ...currentPaths,
    ].sort(
      comparePath,
    );

  for (
    const legacyLocatorPath
    of sortedCurrentPaths
  ) {
    if (
      artifactIdByPath.has(
        legacyLocatorPath,
      )
    ) {
      continue;
    }

    const artifactId =
      parseOpaqueExternalArtifactId(
        input.planning
          .allocator
          .artifactIdFor({
            legacyLocatorPath,
          }),
      );

    const existingPath =
      pathByArtifactId.get(
        artifactId,
      );

    if (
      existingPath
      !== undefined
      && existingPath
        !== legacyLocatorPath
    ) {
      throw new Error(
        `Legacy import artifact identity allocator reused external-artifact id ${artifactId} for ${legacyLocatorPath}; already assigned to ${existingPath}.`,
      );
    }

    const entry:
      LegacyImportArtifactIdentityMappingEntry = {
        legacyLocatorPath,
        artifactId,
      };

    identityEntries.push(
      entry,
    );

    artifactIdByPath.set(
      legacyLocatorPath,
      artifactId,
    );

    pathByArtifactId.set(
      artifactId,
      legacyLocatorPath,
    );
  }

  identityEntries.sort(
    (left, right) =>
      comparePath(
        left.legacyLocatorPath,
        right.legacyLocatorPath,
      ),
  );

  const references:
    ExternalArtifactReference[] =
      [];

  for (
    const legacyLocatorPath
    of sortedCurrentPaths
  ) {
    const artifactId =
      artifactIdByPath.get(
        legacyLocatorPath,
      );

    if (
      artifactId
      === undefined
    ) {
      throw new Error(
        `Legacy import artifact planner lost identity for ${legacyLocatorPath}.`,
      );
    }

    references.push(
      defineExternalArtifactReference({
        id:
          artifactId,
        kind:
          'folder',
        locator:
          locatorForLegacyPath(
            legacyLocatorPath,
          ),
      }),
    );
  }

  const projects:
    LegacyImportProjectArtifactPlan[] =
      [];

  for (
    const candidate
    of projectCandidates
  ) {
    const projectRecordId =
      recordIdByPhysical.get(
        physicalKey(
          'project',
          candidate.source.path,
        ),
      );

    if (
      projectRecordId
      === undefined
    ) {
      throw new Error(
        `Legacy import artifact planner cannot find canonical project identity for ${candidate.source.path}.`,
      );
    }

    const linkedFolders =
      candidate.compatibility
        .projectLinkedFolders;

    if (
      linkedFolders
      === null
    ) {
      throw new Error(
        `Legacy import artifact planner lost interpreted linked folders for project ${candidate.source.path}.`,
      );
    }

    const legacyLinks:
      LegacyImportProjectArtifactLinkPlan[] =
        linkedFolders.map(
          (folder) => {
            const artifactId =
              artifactIdByPath.get(
                folder.path,
              );

            if (
              artifactId
              === undefined
            ) {
              throw new Error(
                `Legacy import artifact planner lost identity for project link ${candidate.source.path} -> ${folder.path}.`,
              );
            }

            return {
              legacyName:
                folder.name,
              legacyLocatorPath:
                folder.path,
              artifactId,
            };
          },
        );

    projects.push({
      projectRecordId,
      sourcePath:
        candidate.source.path,
      association:
        defineProjectArtifactAssociations({
          projectId:
            projectRecordId,
          bindings:
            legacyLinks.map(
              (link) => ({
                role:
                  'artifact',
                artifactId:
                  link.artifactId,
              }),
            ),
        }),
      legacyLinks,
    });
  }

  return {
    schemaVersion:
      LEGACY_IMPORT_ARTIFACT_PLAN_SCHEMA_VERSION,
    mode:
      'dry-run',
    source:
      'interpreted-legacy-project-linked-folders',
    contentPolicy:
      'reference-only-no-copy',
    externalRenameContinuity:
      'not-claimed',
    identityMapping: {
      schemaVersion:
        LEGACY_IMPORT_ARTIFACT_IDENTITY_MAPPING_SCHEMA_VERSION,
      reconciliationKey:
        'exact-legacy-locator-path',
      entries:
        identityEntries,
    },
    references,
    projects,
    counts: {
      projectCandidates:
        projectCandidates.length,
      projectLinks:
        projects.reduce(
          (
            count,
            project,
          ) =>
            count
            + project
              .legacyLinks
              .length,
          0,
        ),
      externalArtifactReferences:
        references.length,
      reservedArtifactIdentities:
        identityEntries.length,
    },
    writes: {
      legacyMarkdown: 0,
      recordStore: 0,
      staging: 0,
      externalArtifacts: 0,
    },
  };
}
