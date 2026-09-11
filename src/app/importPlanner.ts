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
import type {
  IdOrigin,
  RecordKind,
} from '../domain/records.js';
import type {
  CalendarEvent,
  Project,
  ProximaState,
  Task,
} from '../domain/types.js';
import type {
  VaultReader,
} from '../ports/vault.js';
import {
  loadVaultState,
  type KindCensus,
  type LoadOptions,
} from './vaultRepository.js';

export const LEGACY_IMPORT_PLAN_SCHEMA_VERSION =
  1 as const;

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

export interface LegacyImportIdentityPlan {
  readonly kind: RecordKind;
  readonly legacyId: string;
  readonly recordId:
    OpaqueRecordId;
  readonly name: string;
  readonly source: {
    readonly path: string;
    readonly revision: string;
    readonly idOrigin:
      IdOrigin;
  };
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
  readonly resolution:
    'resolved' | 'missing';
}

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
    readonly mappings:
      number;
    readonly projectReferences:
      number;
    readonly unresolvedProjectReferences:
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

type LegacyEntry =
  | {
      readonly kind:
        'project';
      readonly record:
        Project;
    }
  | {
      readonly kind:
        'task';
      readonly record:
        Task;
    }
  | {
      readonly kind:
        'event';
      readonly record:
        CalendarEvent;
    };

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

function entriesOf(
  state:
    ProximaState,
): LegacyEntry[] {
  const entries:
    LegacyEntry[] = [
      ...state.projects.map(
        (record) => ({
          kind:
            'project' as const,
          record,
        }),
      ),
      ...state.tasks.map(
        (record) => ({
          kind:
            'task' as const,
          record,
        }),
      ),
      ...state.events.map(
        (record) => ({
          kind:
            'event' as const,
          record,
        }),
      ),
    ];

  return entries.sort(
    (left, right) =>
      KIND_ORDER[left.kind]
      - KIND_ORDER[right.kind]
      || left.record.source.path
        .localeCompare(
          right.record
            .source
            .path,
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
): Promise<
  LegacyImportPlan
> {
  const loaded =
    await loadVaultState(
      vault,
      options,
    );

  const entries =
    entriesOf(
      loaded.state,
    );

  const mappings:
    LegacyImportIdentityPlan[] =
      [];

  const claimedCanonicalIds =
    new Map<
      OpaqueRecordId,
      string
    >();

  for (
    const entry
    of entries
  ) {
    const request:
      LegacyImportIdentityRequest = {
        kind:
          entry.kind,
        legacyId:
          entry.record.id,
        sourcePath:
          entry.record
            .source
            .path,
        sourceRevision:
          entry.record
            .source
            .revision,
        idOrigin:
          entry.record
            .source
            .idOrigin,
      };

    const recordId =
      parseOpaqueRecordId(
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
    ) {
      throw new Error(
        `Import identity allocator reused canonical record id ${recordId} for ${request.sourcePath}; already assigned to ${existing}.`,
      );
    }

    const assignment =
      pairCanonicalWithLegacyProvenance(
        defineCanonicalRecordHeader({
          kind:
            entry.kind,
          id:
            recordId,
          name:
            entry.record
              .name,
        }),
        defineLegacyImportProvenance(
          entry.record
            .source
            .path,
          [
            {
              value:
                entry.record
                  .id,
              origin:
                entry.record
                  .source
                  .idOrigin,
            },
          ],
        ),
      );

    claimedCanonicalIds.set(
      assignment.record.id,
      request.sourcePath,
    );

    mappings.push({
      kind:
        entry.kind,
      legacyId:
        entry.record.id,
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
          entry.record
            .source
            .revision,
        idOrigin:
          entry.record
            .source
            .idOrigin,
      },
    });
  }

  const mappingByLegacy =
    new Map<
      string,
      LegacyImportIdentityPlan
    >();

  for (
    const mapping
    of mappings
  ) {
    mappingByLegacy.set(
      mappingKey(
        mapping.kind,
        mapping.legacyId,
      ),
      mapping,
    );
  }

  const projectReferences:
    LegacyImportProjectReferencePlan[] =
      [];

  for (
    const entry
    of entries
  ) {
    if (
      entry.kind
      === 'project'
      || entry.record
        .projectId
        === null
    ) {
      continue;
    }

    const sourceMapping =
      mappingByLegacy.get(
        mappingKey(
          entry.kind,
          entry.record.id,
        ),
      );

    if (!sourceMapping) {
      throw new Error(
        `Import planner lost identity mapping for ${entry.kind} ${entry.record.id}.`,
      );
    }

    const projectMapping =
      mappingByLegacy.get(
        mappingKey(
          'project',
          entry.record
            .projectId,
        ),
      );

    projectReferences.push({
      sourceKind:
        entry.kind,
      sourceLegacyId:
        entry.record.id,
      sourceRecordId:
        sourceMapping
          .recordId,
      legacyProjectId:
        entry.record
          .projectId,
      projectRecordId:
        projectMapping
          ?.recordId
        ?? null,
      resolution:
        projectMapping
          ? 'resolved'
          : 'missing',
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
      mappings:
        mappings.length,
      projectReferences:
        projectReferences.length,
      unresolvedProjectReferences:
        projectReferences
          .filter(
            (reference) =>
              reference
                .resolution
              === 'missing',
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
