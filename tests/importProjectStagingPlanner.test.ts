import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import {
  type LegacyImportArtifactIdentityAllocator,
} from '../src/app/importArtifactPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import {
  materializeLegacyImportProjectStaging,
} from '../src/app/importProjectStagingPlanner.js';
import {
  type LegacyImportStagingCreateResult,
  type LegacyImportStagingStore,
} from '../src/app/importStagingPlanner.js';
import {
  parseOpaqueExternalArtifactId,
} from '../src/domain/canonicalArtifactAssociation.js';
import {
  encodeCanonicalRecordV2,
  type CanonicalRecordV2,
} from '../src/domain/canonicalRecordV2.js';
import type {
  OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';

function opaqueRecordId(
  value:
    number,
): string {
  return `pxr_${value
    .toString(16)
    .padStart(
      32,
      '0',
    )}`;
}

function opaqueArtifactId(
  value:
    number,
) {
  return parseOpaqueExternalArtifactId(
    `pxa_${value
      .toString(16)
      .padStart(
        32,
        '0',
      )}`,
  );
}

function sequentialRecordAllocator():
  LegacyImportIdentityAllocator {
  let next =
    1;

  return {
    recordIdFor() {
      const id =
        opaqueRecordId(
          next,
        );

      next +=
        1;

      return id;
    },
  };
}

function sequentialArtifactAllocator():
  LegacyImportArtifactIdentityAllocator {
  let next =
    1;

  return {
    artifactIdFor() {
      const id =
        opaqueArtifactId(
          next,
        );

      next +=
        1;

      return id;
    },
  };
}

class MemoryProjectStagingStore
implements LegacyImportStagingStore {
  readonly authority =
    'legacy-import-staging-only' as const;

  private readonly records =
    new Map<
      OpaqueRecordId,
      CanonicalRecordV2
    >();

  creates =
    0;

  async readStagedRecord(
    recordId:
      OpaqueRecordId,
  ): Promise<
    CanonicalRecordV2 | null
  > {
    return this.records.get(
      recordId,
    ) ?? null;
  }

  async createStagedRecord(
    record:
      CanonicalRecordV2,
  ): Promise<
    LegacyImportStagingCreateResult
  > {
    if (
      this.records.has(
        record.id,
      )
    ) {
      return {
        ok: false,
        reason:
          'already-exists',
      };
    }

    this.records.set(
      record.id,
      encodeCanonicalRecordV2(
        record,
      ),
    );

    this.creates +=
      1;

    return {
      ok: true,
    };
  }

  seed(
    record:
      CanonicalRecordV2,
  ): void {
    this.records.set(
      record.id,
      encodeCanonicalRecordV2(
        record,
      ),
    );
  }

  values():
    readonly CanonicalRecordV2[] {
    return [
      ...this.records
        .values(),
    ].sort(
      (
        left,
        right,
      ) =>
        left.id
          .localeCompare(
            right.id,
          ),
    );
  }
}

async function plan(
  files:
    Record<string, string>,
  withArtifacts =
    true,
) {
  return planLegacyMarkdownImport(
    createMemoryVault(
      files,
    ),
    sequentialRecordAllocator(),
    {},
    null,
    null,
    withArtifacts
      ? {
          allocator:
            sequentialArtifactAllocator(),
        }
      : null,
  );
}

describe(
  'Stage 8 slice 13 canonical project staging',
  () => {
    it(
      'stages a complete canonical project payload with slice-8 artifact bindings while legacy projectType remains non-canonical metadata',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              'name: Alpha',
              'description: Project description',
              'createdAt: 2026-01-02T03:04:05.000Z',
              'status: active',
              'projectType: schedule',
              'linkedFolders: Docs|Shared/Docs',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        expect(
          importPlan.schemaVersion,
        ).toBe(
          7,
        );

        const conversion =
          importPlan.conversions.find(
            (candidate) =>
              candidate.kind
              === 'project',
          );

        expect(conversion)
          .toMatchObject({
            kind:
              'project',
            recordId:
              opaqueRecordId(
                1,
              ),
            sourcePath:
              'Proxima/projects/alpha.md',
            name:
              'Alpha',
            description:
              'Project description',
            createdAt:
              '2026-01-02T03:04:05.000Z',
            status:
              'active',
            archivedAt:
              null,
            legacyProjectType:
              'schedule',
            disposition:
              'compatibility-import-metadata-only',
            canonicalCapabilityAuthority:
              'associated-data-and-workspace',
          });

        const store =
          new MemoryProjectStagingStore();

        const result =
          await materializeLegacyImportProjectStaging(
            importPlan,
            store,
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'staging-materialization',
            source:
              'legacy-import-project-conversions',
            scope:
              'project-records-only',
            activation:
              'not-performed',
            counts: {
              projectCandidates: 1,
              eligibleProjectRecords: 1,
              created: 1,
              reusedIdentical: 0,
              blocked: 0,
            },
            writes: {
              legacyMarkdown: 0,
              recordStore: 0,
              staging: 1,
              externalArtifacts: 0,
              activation: 0,
            },
          });

        const staged =
          result.staged[0];

        expect(staged)
          .toMatchObject({
            recordId:
              opaqueRecordId(
                1,
              ),
            sourcePath:
              'Proxima/projects/alpha.md',
            outcome:
              'created',
            record: {
              kind:
                'project',
              id:
                opaqueRecordId(
                  1,
                ),
              name:
                'Alpha',
              description:
                'Project description',
              createdAt:
                '2026-01-02T03:04:05.000Z',
              status:
                'active',
              archivedAt:
                null,
              artifactBindings: [
                {
                  role:
                    'artifact',
                  artifactId:
                    opaqueArtifactId(
                      1,
                    ),
                },
              ],
            },
          });

        expect(
          staged?.record,
        ).not.toHaveProperty(
          'projectType',
        );

        expect(
          store.values(),
        ).toEqual([
          staged?.record,
        ]);
      },
    );

    it(
      'preserves an interpreted archived project lifecycle and archivedAt timestamp',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/archive.md': [
              '---',
              'id: archive',
              'type: project',
              'name: Archive',
              'createdAt: 2025-01-01T00:00:00.000Z',
              'status: archived',
              'archivedAt: 2026-08-09T10:11:12.000Z',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const result =
          await materializeLegacyImportProjectStaging(
            importPlan,
            new MemoryProjectStagingStore(),
          );

        expect(
          result.staged[0]
            ?.record,
        ).toMatchObject({
          kind:
            'project',
          status:
            'archived',
          archivedAt:
            '2026-08-09T10:11:12.000Z',
        });
      },
    );

    it(
      'materializes duplicate-alias project files as distinct canonical project records using their already-assigned physical candidate ids',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/alpha.md': [
              '---',
              'id: shared',
              'type: project',
              'name: Alpha',
              '---',
              '',
            ].join(
              '\n',
            ),

            'Proxima/projects/beta.md': [
              '---',
              'id: shared',
              'type: project',
              'name: Beta',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        expect(
          importPlan.collisions,
        ).toHaveLength(
          1,
        );

        const store =
          new MemoryProjectStagingStore();

        const result =
          await materializeLegacyImportProjectStaging(
            importPlan,
            store,
          );

        expect(result.counts)
          .toEqual({
            projectCandidates: 2,
            eligibleProjectRecords: 2,
            created: 2,
            reusedIdentical: 0,
            blocked: 0,
          });

        expect(
          result.staged.map(
            (entry) =>
              ({
                sourcePath:
                  entry.sourcePath,
                id:
                  entry.record.id,
                name:
                  entry.record.name,
              }),
          ),
        ).toEqual([
          {
            sourcePath:
              'Proxima/projects/alpha.md',
            id:
              opaqueRecordId(
                1,
              ),
            name:
              'Alpha',
          },
          {
            sourcePath:
              'Proxima/projects/beta.md',
            id:
              opaqueRecordId(
                2,
              ),
            name:
              'Beta',
          },
        ]);

        expect(
          store.values(),
        ).toHaveLength(
          2,
        );
      },
    );

    it(
      'stages independent valid projects while malformed and unsupported-frontmatter projects remain explicit blockers',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/malformed.md': [
              '---',
              'id: malformed',
              'type: project',
              'name: "unterminated',
              '---',
              '',
            ].join(
              '\n',
            ),

            'Proxima/projects/unsupported.md': [
              '---',
              'id: unsupported',
              'type: project',
              'description: |',
              '  unsupported block value',
              '---',
              '',
            ].join(
              '\n',
            ),

            'Proxima/projects/valid.md': [
              '---',
              'id: valid',
              'type: project',
              'name: Valid',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const result =
          await materializeLegacyImportProjectStaging(
            importPlan,
            new MemoryProjectStagingStore(),
          );

        expect(result.counts)
          .toEqual({
            projectCandidates: 3,
            eligibleProjectRecords: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 2,
          });

        expect(result.blockers)
          .toEqual(
            expect.arrayContaining([
              {
                reason:
                  'malformed-project',
                recordId:
                  expect.any(
                    String,
                  ),
                sourcePath:
                  'Proxima/projects/malformed.md',
              },
              {
                reason:
                  'unsupported-frontmatter-policy-pending',
                recordId:
                  expect.any(
                    String,
                  ),
                sourcePath:
                  'Proxima/projects/unsupported.md',
              },
            ]),
          );

        expect(
          result.staged.map(
            (entry) =>
              entry.sourcePath,
          ),
        ).toEqual([
          'Proxima/projects/valid.md',
        ]);
      },
    );

    it(
      'blocks project payload staging when the accepted external-artifact association plan is absent rather than silently dropping project bindings',
      async () => {
        const importPlan =
          await plan(
            {
              'Proxima/projects/alpha.md': [
                '---',
                'id: alpha',
                'type: project',
                'name: Alpha',
                '---',
                '',
              ].join(
                '\n',
              ),
            },
            false,
          );

        expect(
          importPlan.externalArtifacts,
        ).toBeNull();

        const store =
          new MemoryProjectStagingStore();

        const result =
          await materializeLegacyImportProjectStaging(
            importPlan,
            store,
          );

        expect(result.counts)
          .toEqual({
            projectCandidates: 1,
            eligibleProjectRecords: 0,
            created: 0,
            reusedIdentical: 0,
            blocked: 1,
          });

        expect(result.blockers)
          .toEqual([
            {
              reason:
                'external-artifact-plan-missing',
              recordId:
                opaqueRecordId(
                  1,
                ),
              sourcePath:
                'Proxima/projects/alpha.md',
            },
          ]);

        expect(
          store.values(),
        ).toEqual([]);
      },
    );

    it(
      'reuses an identical staged project on rerun without creating a duplicate record',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              'name: Alpha',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const store =
          new MemoryProjectStagingStore();

        const first =
          await materializeLegacyImportProjectStaging(
            importPlan,
            store,
          );

        const second =
          await materializeLegacyImportProjectStaging(
            importPlan,
            store,
          );

        expect(first.counts)
          .toEqual({
            projectCandidates: 1,
            eligibleProjectRecords: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 0,
          });

        expect(second.counts)
          .toEqual({
            projectCandidates: 1,
            eligibleProjectRecords: 1,
            created: 0,
            reusedIdentical: 1,
            blocked: 0,
          });

        expect(second.writes)
          .toEqual({
            legacyMarkdown: 0,
            recordStore: 0,
            staging: 0,
            externalArtifacts: 0,
            activation: 0,
          });

        expect(
          store.creates,
        ).toBe(
          1,
        );

        expect(
          store.values(),
        ).toHaveLength(
          1,
        );
      },
    );

    it(
      'reports a different staged payload under the same project id as a blocker without overwriting it',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              'name: Alpha',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const firstStore =
          new MemoryProjectStagingStore();

        const first =
          await materializeLegacyImportProjectStaging(
            importPlan,
            firstStore,
          );

        const expected =
          first.staged[0]
            ?.record;

        if (
          expected
          === undefined
        ) {
          throw new Error(
            'Expected one staged project record.',
          );
        }

        const store =
          new MemoryProjectStagingStore();

        store.seed({
          ...expected,
          name:
            'Conflicting staged name',
        });

        const result =
          await materializeLegacyImportProjectStaging(
            importPlan,
            store,
          );

        expect(result.counts)
          .toEqual({
            projectCandidates: 1,
            eligibleProjectRecords: 1,
            created: 0,
            reusedIdentical: 0,
            blocked: 1,
          });

        expect(result.blockers)
          .toEqual([
            {
              reason:
                'staging-record-conflict',
              recordId:
                expected.id,
              sourcePath:
                'Proxima/projects/alpha.md',
            },
          ]);

        expect(
          store.values()[0]
            ?.name,
        ).toBe(
          'Conflicting staged name',
        );

        expect(
          store.creates,
        ).toBe(
          0,
        );
      },
    );
  },
);
