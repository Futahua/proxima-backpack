import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import type {
  LegacyImportArtifactIdentityAllocator,
} from '../src/app/importArtifactPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import {
  materializeLegacyImportProjectStaging,
} from '../src/app/importProjectStagingPlanner.js';
import type {
  LegacyImportSchemaIdentityAllocator,
} from '../src/app/importSchemaPlanner.js';
import {
  type LegacyImportStagingCreateResult,
  type LegacyImportStagingStore,
} from '../src/app/importStagingPlanner.js';
import {
  materializeLegacyImportTaskStaging,
} from '../src/app/importTaskStagingPlanner.js';
import {
  materializeLegacyImportWorkflowStageStaging,
  type LegacyImportWorkflowStageIdentityAllocator,
  type LegacyImportWorkflowStageIdentityMappingManifest,
  type LegacyImportWorkflowStageIdentityMappingStore,
} from '../src/app/importWorkflowStageStagingPlanner.js';
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

function opaque(
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

function opaqueOption(
  value:
    number,
): string {
  return `pxo_${value
    .toString(16)
    .padStart(
      32,
      '0',
    )}`;
}

function sequentialRecordAllocator():
  LegacyImportIdentityAllocator {
  let next =
    1;

  return {
    recordIdFor() {
      const id =
        opaque(
          next,
        );

      next +=
        1;

      return id;
    },
  };
}

function sequentialSchemaAllocator():
  LegacyImportSchemaIdentityAllocator {
  let nextRecord =
    100;

  let nextOption =
    1;

  return {
    schemaRecordIdFor() {
      const id =
        opaque(
          nextRecord,
        );

      nextRecord +=
        1;

      return id;
    },

    schemaOptionIdFor() {
      const id =
        opaqueOption(
          nextOption,
        );

      nextOption +=
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
        parseOpaqueExternalArtifactId(
          `pxa_${next
            .toString(16)
            .padStart(
              32,
              '0',
            )}`,
        );

      next +=
        1;

      return id;
    },
  };
}

function sequentialStageAllocator():
  LegacyImportWorkflowStageIdentityAllocator {
  let next =
    500;

  return {
    workflowStageRecordIdFor() {
      const id =
        opaque(
          next,
        );

      next +=
        1;

      return id;
    },
  };
}

class MemoryIdentityStore
implements LegacyImportWorkflowStageIdentityMappingStore {
  private mapping:
    LegacyImportWorkflowStageIdentityMappingManifest | null =
      null;

  async load():
    Promise<
      LegacyImportWorkflowStageIdentityMappingManifest | null
    > {
    return this.mapping;
  }

  async save(
    mapping:
      LegacyImportWorkflowStageIdentityMappingManifest,
  ): Promise<void> {
    this.mapping =
      mapping;
  }
}

class MemoryTaskStagingStore
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
    ];
  }
}

const schemaSnapshot = {
  taskSchema: [
    {
      id:
        'effort',
      name:
        'Effort',
      type:
        'number' as const,
    },
  ],
  projectSchemas: {},
};

async function plan(
  files:
    Record<string, string>,
) {
  return planLegacyMarkdownImport(
    createMemoryVault(
      files,
    ),
    sequentialRecordAllocator(),
    {},
    null,
    {
      snapshot:
        schemaSnapshot,
      allocator:
        sequentialSchemaAllocator(),
    },
    {
      allocator:
        sequentialArtifactAllocator(),
    },
  );
}

async function prepareDependencies(
  importPlan:
    Awaited<
      ReturnType<
        typeof plan
      >
    >,
  store:
    MemoryTaskStagingStore,
): Promise<
  LegacyImportWorkflowStageIdentityMappingManifest
> {
  await materializeLegacyImportProjectStaging(
    importPlan,
    store,
  );

  const identityStore =
    new MemoryIdentityStore();

  const workflow =
    await materializeLegacyImportWorkflowStageStaging(
      importPlan,
      store,
      sequentialStageAllocator(),
      identityStore,
    );

  return workflow.identityMapping;
}

describe(
  'Stage 8 slice 14 canonical task staging',
  () => {
    it(
      'stages the complete representable canonical task payload with resolved project, workflow-stage identity, independent orders and canonical stored properties',
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
            ].join('\n'),

            'Proxima/tasks/task.md': [
              '---',
              'id: task',
              'name: Task',
              'description: Task description',
              'project: alpha',
              'status: running',
              'orderIndex: 7',
              'weight: 3',
              'isFixedDuration: true',
              'fixedDuration: 45',
              'maxDuration: 90',
              'isCompleted: false',
              'createdAt: 2026-01-02T03:04:05.000Z',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T12:00:00.000Z',
              'effort: 5',
              '---',
              '',
            ].join('\n'),
          });

        expect(
          importPlan.schemaVersion,
        ).toBe(
          8,
        );

        const conversion =
          importPlan.conversions.find(
            (candidate) =>
              candidate.kind
              === 'task',
          );

        expect(conversion)
          .toMatchObject({
            kind:
              'task',
            recordId:
              opaque(
                2,
              ),
            sourcePath:
              'Proxima/tasks/task.md',
            name:
              'Task',
            description:
              'Task description',
            weight:
              3,
            isFixedDuration:
              true,
            fixedDuration:
              45,
            maxDuration:
              90,
            isCompleted:
              false,
            createdAt:
              '2026-01-02T03:04:05.000Z',
            startDate:
              '2026-09-12T10:00:00.000Z',
            deadline:
              '2026-09-12T12:00:00.000Z',
            recurrence:
              null,
            executionState:
              'running',
          });

        const store =
          new MemoryTaskStagingStore();

        const workflowMapping =
          await prepareDependencies(
            importPlan,
            store,
          );

        const result =
          await materializeLegacyImportTaskStaging(
            importPlan,
            store,
            workflowMapping,
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'staging-materialization',
            source:
              'legacy-import-task-conversions',
            scope:
              'task-records-only',
            activation:
              'not-performed',
            counts: {
              taskCandidates: 1,
              eligibleTaskRecords: 1,
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

        const task =
          result.staged[0]
            ?.record;

        expect(task)
          .toMatchObject({
            kind:
              'task',
            id:
              opaque(
                2,
              ),
            name:
              'Task',
            description:
              'Task description',
            projectId:
              opaque(
                1,
              ),
            executionState:
              'running',
            executionOrder:
              7,
            workflowOrder:
              7,
            weight:
              3,
            isFixedDuration:
              true,
            fixedDuration:
              45,
            maxDuration:
              90,
            isCompleted:
              false,
            createdAt:
              '2026-01-02T03:04:05.000Z',
            startDate:
              '2026-09-12T10:00:00.000Z',
            deadline:
              '2026-09-12T12:00:00.000Z',
            recurrence:
              null,
          });

        expect(
          task?.workflowStageId,
        ).toBe(
          workflowMapping
            .entries[0]
            ?.recordId,
        );

        expect(
          Object.values(
            task?.properties
            ?? {},
          ),
        ).toEqual([
          {
            type:
              'number',
            value:
              5,
          },
        ]);
      },
    );

    it(
      'stages a projectless task with null project/workflow identity and null workflow order while retaining its independent execution order',
      async () => {
        const importPlan =
          await plan({
            'Proxima/tasks/task.md': [
              '---',
              'id: task',
              'name: Loose Task',
              'status: backlog',
              'orderIndex: 4',
              '---',
              '',
            ].join('\n'),
          });

        const store =
          new MemoryTaskStagingStore();

        const result =
          await materializeLegacyImportTaskStaging(
            importPlan,
            store,
            {
              schemaVersion: 1,
              reconciliationKey:
                'project-record-id+legacy-status-id',
              entries: [],
            },
          );

        expect(result.counts)
          .toEqual({
            taskCandidates: 1,
            eligibleTaskRecords: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 0,
          });

        expect(
          result.staged[0]
            ?.record,
        ).toMatchObject({
          kind:
            'task',
          projectId:
            null,
          workflowStageId:
            null,
          executionState:
            'backlog',
          executionOrder:
            4,
          workflowOrder:
            null,
          recurrence:
            null,
        });
      },
    );

    it(
      'blocks missing and ambiguous project references instead of inventing project or workflow-stage identity',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/a.md': [
              '---',
              'id: shared',
              'type: project',
              '---',
              '',
            ].join('\n'),

            'Proxima/projects/b.md': [
              '---',
              'id: shared',
              'type: project',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/ambiguous.md': [
              '---',
              'id: ambiguous',
              'project: shared',
              'status: running',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/missing.md': [
              '---',
              'id: missing',
              'project: nowhere',
              'status: running',
              'orderIndex: 2',
              '---',
              '',
            ].join('\n'),
          });

        const result =
          await materializeLegacyImportTaskStaging(
            importPlan,
            new MemoryTaskStagingStore(),
            {
              schemaVersion: 1,
              reconciliationKey:
                'project-record-id+legacy-status-id',
              entries: [],
            },
          );

        expect(result.counts)
          .toEqual({
            taskCandidates: 2,
            eligibleTaskRecords: 0,
            created: 0,
            reusedIdentical: 0,
            blocked: 2,
          });

        expect(result.blockers)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                reason:
                  'project-reference-unresolved',
                sourcePath:
                  'Proxima/tasks/ambiguous.md',
                resolution:
                  'ambiguous-project',
              }),
              expect.objectContaining({
                reason:
                  'project-reference-unresolved',
                sourcePath:
                  'Proxima/tasks/missing.md',
                resolution:
                  'missing-project',
              }),
            ]),
          );
      },
    );

    it(
      'blocks a task whose stored custom property conversion is unresolved instead of dropping the legacy value',
      async () => {
        const importPlan =
          await plan({
            'Proxima/tasks/task.md': [
              '---',
              'id: task',
              'status: running',
              'orderIndex: 1',
              'effort: not-a-number',
              '---',
              '',
            ].join('\n'),
          });

        const result =
          await materializeLegacyImportTaskStaging(
            importPlan,
            new MemoryTaskStagingStore(),
            {
              schemaVersion: 1,
              reconciliationKey:
                'project-record-id+legacy-status-id',
              entries: [],
            },
          );

        expect(result.counts)
          .toEqual({
            taskCandidates: 1,
            eligibleTaskRecords: 0,
            created: 0,
            reusedIdentical: 0,
            blocked: 1,
          });

        expect(result.blockers)
          .toEqual([
            expect.objectContaining({
              reason:
                'property-value-unresolved',
              sourcePath:
                'Proxima/tasks/task.md',
              schemaRecordIds: [
                opaque(
                  100,
                ),
              ],
            }),
          ]);
      },
    );

    it(
      'keeps malformed and unsupported-frontmatter tasks out of canonical staging while an independent valid task still stages',
      async () => {
        const importPlan =
          await plan({
            'Proxima/tasks/malformed.md': [
              '---',
              'id: malformed',
              'name: "unterminated',
              'status: running',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/unsupported.md': [
              '---',
              'id: unsupported',
              'description: |',
              '  unsupported',
              'status: running',
              'orderIndex: 2',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/valid.md': [
              '---',
              'id: valid',
              'status: running',
              'orderIndex: 3',
              '---',
              '',
            ].join('\n'),
          });

        const result =
          await materializeLegacyImportTaskStaging(
            importPlan,
            new MemoryTaskStagingStore(),
            {
              schemaVersion: 1,
              reconciliationKey:
                'project-record-id+legacy-status-id',
              entries: [],
            },
          );

        expect(result.counts)
          .toEqual({
            taskCandidates: 3,
            eligibleTaskRecords: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 2,
          });

        expect(
          result.staged.map(
            (entry) =>
              entry.sourcePath,
          ),
        ).toEqual([
          'Proxima/tasks/valid.md',
        ]);

        expect(result.blockers)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                reason:
                  'malformed-task',
                sourcePath:
                  'Proxima/tasks/malformed.md',
              }),
              expect.objectContaining({
                reason:
                  'unsupported-frontmatter-policy-pending',
                sourcePath:
                  'Proxima/tasks/unsupported.md',
              }),
            ]),
          );
      },
    );

    it(
      'does not stage a project task before its exact project and workflow-stage dependency records exist',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/task.md': [
              '---',
              'id: task',
              'project: alpha',
              'status: running',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),
          });

        const stageIdentity:
          LegacyImportWorkflowStageIdentityMappingManifest = {
            schemaVersion: 1,
            reconciliationKey:
              'project-record-id+legacy-status-id',
            entries: [
              {
                projectRecordId:
                  opaque(
                    1,
                  ) as OpaqueRecordId,
                legacyStatusId:
                  'running',
                recordId:
                  opaque(
                    500,
                  ) as OpaqueRecordId,
              },
            ],
          };

        const missingProject =
          await materializeLegacyImportTaskStaging(
            importPlan,
            new MemoryTaskStagingStore(),
            stageIdentity,
          );

        expect(
          missingProject.blockers[0],
        ).toMatchObject({
          reason:
            'project-record-missing',
          sourcePath:
            'Proxima/tasks/task.md',
          projectRecordId:
            opaque(
              1,
            ),
        });

        const store =
          new MemoryTaskStagingStore();

        await materializeLegacyImportProjectStaging(
          importPlan,
          store,
        );

        const missingStage =
          await materializeLegacyImportTaskStaging(
            importPlan,
            store,
            stageIdentity,
          );

        expect(
          missingStage.blockers[0],
        ).toMatchObject({
          reason:
            'workflow-stage-record-missing',
          sourcePath:
            'Proxima/tasks/task.md',
          workflowStageId:
            opaque(
              500,
            ),
        });
      },
    );

    it(
      'reuses an identical staged task on rerun and refuses a conflicting payload without overwriting it',
      async () => {
        const importPlan =
          await plan({
            'Proxima/tasks/task.md': [
              '---',
              'id: task',
              'name: Task',
              'status: running',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),
          });

        const emptyStages:
          LegacyImportWorkflowStageIdentityMappingManifest = {
            schemaVersion: 1,
            reconciliationKey:
              'project-record-id+legacy-status-id',
            entries: [],
          };

        const store =
          new MemoryTaskStagingStore();

        const first =
          await materializeLegacyImportTaskStaging(
            importPlan,
            store,
            emptyStages,
          );

        const second =
          await materializeLegacyImportTaskStaging(
            importPlan,
            store,
            emptyStages,
          );

        expect(first.counts)
          .toMatchObject({
            created: 1,
            reusedIdentical: 0,
            blocked: 0,
          });

        expect(second.counts)
          .toMatchObject({
            created: 0,
            reusedIdentical: 1,
            blocked: 0,
          });

        expect(
          store.creates,
        ).toBe(
          1,
        );

        const expected =
          first.staged[0]
            ?.record;

        if (
          expected
          === undefined
        ) {
          throw new Error(
            'Expected one staged task.',
          );
        }

        const conflictStore =
          new MemoryTaskStagingStore();

        conflictStore.seed({
          ...expected,
          name:
            'Conflicting staged task',
        });

        const conflict =
          await materializeLegacyImportTaskStaging(
            importPlan,
            conflictStore,
            emptyStages,
          );

        expect(conflict.counts)
          .toMatchObject({
            created: 0,
            reusedIdentical: 0,
            blocked: 1,
          });

        expect(conflict.blockers)
          .toEqual([
            {
              reason:
                'staging-record-conflict',
              recordId:
                expected.id,
              sourcePath:
                'Proxima/tasks/task.md',
            },
          ]);

        expect(
          conflictStore
            .values()[0]
            ?.name,
        ).toBe(
          'Conflicting staged task',
        );
      },
    );
  },
);
