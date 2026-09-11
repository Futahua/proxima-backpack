import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  type LegacyImportArtifactIdentityAllocator,
} from '../src/app/importArtifactPlanner.js';
import {
  materializeLegacyImportEventStaging,
  type LegacyImportEventStagingResult,
} from '../src/app/importEventStagingPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import {
  materializeLegacyImportProjectStaging,
  type LegacyImportProjectStagingResult,
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
  type LegacyImportTaskStagingResult,
} from '../src/app/importTaskStagingPlanner.js';
import {
  verifyLegacyImportStaging,
} from '../src/app/importVerification.js';
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
  type CanonicalProjectRecordV2,
  type CanonicalRecordV2,
  type CanonicalTaskRecordV2,
} from '../src/domain/canonicalRecordV2.js';
import type {
  OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';

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

function schemaAllocator():
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

function artifactAllocator():
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

function stageAllocator():
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

class MemoryStageIdentityStore
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

class MemoryVerificationStore
implements LegacyImportStagingStore {
  readonly authority =
    'legacy-import-staging-only' as const;

  private readonly records =
    new Map<
      OpaqueRecordId,
      CanonicalRecordV2
    >();

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

    return {
      ok: true,
    };
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
    Record<
      string,
      string
    >,
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
        schemaAllocator(),
    },
    {
      allocator:
        artifactAllocator(),
    },
  );
}

async function stageAll(
  importPlan:
    Awaited<
      ReturnType<
        typeof plan
      >
    >,
  store:
    MemoryVerificationStore,
) {
  const projectStaging =
    await materializeLegacyImportProjectStaging(
      importPlan,
      store,
    );

  const identityStore =
    new MemoryStageIdentityStore();

  const workflowStage =
    await materializeLegacyImportWorkflowStageStaging(
      importPlan,
      store,
      stageAllocator(),
      identityStore,
    );

  const taskStaging =
    await materializeLegacyImportTaskStaging(
      importPlan,
      store,
      workflowStage
        .identityMapping,
    );

  const eventStaging =
    await materializeLegacyImportEventStaging(
      importPlan,
      store,
    );

  return {
    projectStaging,
    taskStaging,
    eventStaging,
    workflowStageIdentities:
      workflowStage
        .identityMapping,
  };
}

function fullFiles():
  Record<
    string,
    string
  > {
  return {
    'Proxima/projects/alpha.md': [
      '---',
      'id: alpha',
      'type: project',
      'name: Alpha',
      'description: Project description',
      'createdAt: 2025-01-01T00:00:00.000Z',
      'status: archived',
      'archivedAt: 2026-08-09T10:11:12.000Z',
      'projectType: schedule',
      'linkedFolders: Docs|Shared/Docs',
      '---',
      '',
    ].join(
      '\n',
    ),

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
      'isCompleted: true',
      'createdAt: 2026-01-02T03:04:05.000Z',
      'startDate: 2026-09-12T10:00:00.000Z',
      'deadline: 2026-09-12T12:00:00.000Z',
      'effort: 5',
      '---',
      '',
    ].join(
      '\n',
    ),

    'Proxima/events/event.md': [
      '---',
      'id: event',
      'name: Event',
      'description: Event description',
      'project: alpha',
      'createdAt: 2026-02-03T04:05:06.000Z',
      'startDate: 2026-09-13T10:00:00.000Z',
      'deadline: 2026-09-13T11:00:00.000Z',
      'isCompleted: true',
      '---',
      '',
    ].join(
      '\n',
    ),
  };
}

async function prepareFull() {
  const importPlan =
    await plan(
      fullFiles(),
    );

  const store =
    new MemoryVerificationStore();

  const staged =
    await stageAll(
      importPlan,
      store,
    );

  return {
    importPlan,
    store,
    ...staged,
  };
}

describe(
  'Stage 8 slice 17 read-only import semantic verification',
  () => {
    it(
      'verifies project, task and event accounting plus preserved semantic fields while keeping unresolved migration policy explicitly deferred',
      async () => {
        const prepared =
          await prepareFull();

        const result =
          await verifyLegacyImportStaging({
            plan:
              prepared.importPlan,
            projectStaging:
              prepared.projectStaging,
            taskStaging:
              prepared.taskStaging,
            eventStaging:
              prepared.eventStaging,
            workflowStageIdentities:
              prepared
                .workflowStageIdentities,
            store:
              prepared.store,
          });

        expect(result)
          .toEqual({
            schemaVersion: 1,
            mode:
              'verification',
            source:
              'legacy-import-plan-and-staging-results',
            verdict:
              'verified',
            dispositions: [
              {
                kind:
                  'event',
                recordId:
                  opaque(
                    3,
                  ),
                sourcePath:
                  'Proxima/events/event.md',
                disposition:
                  'staged-verified',
                blockerReason:
                  null,
              },
              {
                kind:
                  'project',
                recordId:
                  opaque(
                    1,
                  ),
                sourcePath:
                  'Proxima/projects/alpha.md',
                disposition:
                  'staged-verified',
                blockerReason:
                  null,
              },
              {
                kind:
                  'task',
                recordId:
                  opaque(
                    2,
                  ),
                sourcePath:
                  'Proxima/tasks/task.md',
                disposition:
                  'staged-verified',
                blockerReason:
                  null,
              },
            ],
            counts: {
              projects: {
                planned: 1,
                stagedVerified: 1,
                blocked: 0,
                accounted: 1,
              },
              tasks: {
                planned: 1,
                stagedVerified: 1,
                blocked: 0,
                accounted: 1,
              },
              events: {
                planned: 1,
                stagedVerified: 1,
                blocked: 0,
                accounted: 1,
              },
              total: {
                planned: 3,
                stagedVerified: 3,
                blocked: 0,
                accounted: 3,
              },
            },
            deferredChecks: [
              'unsupported-frontmatter-importability',
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
          });

        const project =
          prepared.store
            .values()
            .find(
              (record) =>
                record.kind
                === 'project',
            );

        const task =
          prepared.store
            .values()
            .find(
              (record) =>
                record.kind
                === 'task',
            );

        const event =
          prepared.store
            .values()
            .find(
              (record) =>
                record.kind
                === 'event',
            );

        expect(project)
          .toMatchObject({
            status:
              'archived',
            archivedAt:
              '2026-08-09T10:11:12.000Z',
          });

        expect(task)
          .toMatchObject({
            isCompleted:
              true,
            weight:
              3,
            fixedDuration:
              45,
            maxDuration:
              90,
          });

        expect(event)
          .toMatchObject({
            isCompleted:
              true,
          });

        expect(
          prepared.store
            .values()
            .some(
              (record) =>
                Object.prototype
                  .hasOwnProperty.call(
                    record,
                    'projectType',
                  ),
            ),
        ).toBe(
          false,
        );
      },
    );

    it(
      'reports every blocked physical conversion with an explicit blocker disposition instead of treating omitted records as migrated',
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

            'Proxima/tasks/missing.md': [
              '---',
              'id: missing',
              'project: nowhere',
              'status: running',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),

            'Proxima/events/custom.md': [
              '---',
              'id: custom',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              'color: red',
              '---',
              '',
            ].join('\n'),
          });

        const store =
          new MemoryVerificationStore();

        const staged =
          await stageAll(
            importPlan,
            store,
          );

        const result =
          await verifyLegacyImportStaging({
            plan:
              importPlan,
            ...staged,
            store,
          });

        expect(
          result.verdict,
        ).toBe(
          'blocked',
        );

        expect(
          result.counts.total,
        ).toEqual({
          planned: 3,
          stagedVerified: 1,
          blocked: 2,
          accounted: 3,
        });

        expect(result.dispositions)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind:
                  'task',
                sourcePath:
                  'Proxima/tasks/missing.md',
                disposition:
                  'blocked',
                blockerReason:
                  'project-reference-unresolved',
              }),
              expect.objectContaining({
                kind:
                  'event',
                sourcePath:
                  'Proxima/events/custom.md',
                disposition:
                  'blocked',
                blockerReason:
                  'legacy-event-properties-untyped',
              }),
            ]),
          );
      },
    );

    it(
      'rejects a staged project whose canonical name no longer matches its authored conversion',
      async () => {
        const prepared =
          await prepareFull();

        const entry =
          prepared
            .projectStaging
            .staged[0];

        if (
          entry
          === undefined
        ) {
          throw new Error(
            'Expected staged project.',
          );
        }

        const tampered:
          LegacyImportProjectStagingResult = {
            ...prepared
              .projectStaging,
            staged: [
              {
                ...entry,
                record: {
                  ...entry.record,
                  name:
                    'Tampered project',
                },
              },
            ],
          };

        await expect(
          verifyLegacyImportStaging({
            plan:
              prepared.importPlan,
            projectStaging:
              tampered,
            taskStaging:
              prepared.taskStaging,
            eventStaging:
              prepared.eventStaging,
            workflowStageIdentities:
              prepared
                .workflowStageIdentities,
            store:
              prepared.store,
          }),
        ).rejects.toThrow(
          /Project verification name mismatch/,
        );
      },
    );

    it(
      'rejects a staged task whose canonical custom-property value no longer matches the accepted property-value plan',
      async () => {
        const prepared =
          await prepareFull();

        const entry =
          prepared
            .taskStaging
            .staged[0];

        if (
          entry
          === undefined
        ) {
          throw new Error(
            'Expected staged task.',
          );
        }

        const propertyKey =
          Object.keys(
            entry.record
              .properties,
          )[0];

        if (
          propertyKey
          === undefined
        ) {
          throw new Error(
            'Expected staged task property.',
          );
        }

        const record:
          CanonicalTaskRecordV2 = {
            ...entry.record,
            properties: {
              ...entry.record
                .properties,
              [propertyKey]: {
                type:
                  'number',
                value:
                  999,
              },
            },
          };

        const tampered:
          LegacyImportTaskStagingResult = {
            ...prepared
              .taskStaging,
            staged: [
              {
                ...entry,
                record,
              },
            ],
          };

        await expect(
          verifyLegacyImportStaging({
            plan:
              prepared.importPlan,
            projectStaging:
              prepared
                .projectStaging,
            taskStaging:
              tampered,
            eventStaging:
              prepared
                .eventStaging,
            workflowStageIdentities:
              prepared
                .workflowStageIdentities,
            store:
              prepared.store,
          }),
        ).rejects.toThrow(
          /Task verification properties mismatch/,
        );
      },
    );

    it(
      'rejects a staged event whose completion state differs from the interpreted legacy conversion',
      async () => {
        const prepared =
          await prepareFull();

        const entry =
          prepared
            .eventStaging
            .staged[0];

        if (
          entry
          === undefined
        ) {
          throw new Error(
            'Expected staged event.',
          );
        }

        const tampered:
          LegacyImportEventStagingResult = {
            ...prepared
              .eventStaging,
            staged: [
              {
                ...entry,
                record: {
                  ...entry.record,
                  isCompleted:
                    false,
                },
              },
            ],
          };

        await expect(
          verifyLegacyImportStaging({
            plan:
              prepared.importPlan,
            projectStaging:
              prepared
                .projectStaging,
            taskStaging:
              prepared
                .taskStaging,
            eventStaging:
              tampered,
            workflowStageIdentities:
              prepared
                .workflowStageIdentities,
            store:
              prepared.store,
          }),
        ).rejects.toThrow(
          /Event verification isCompleted mismatch/,
        );
      },
    );

    it(
      'rejects verification when a reported staged record is absent from the staging store',
      async () => {
        const prepared =
          await prepareFull();

        await expect(
          verifyLegacyImportStaging({
            plan:
              prepared.importPlan,
            projectStaging:
              prepared
                .projectStaging,
            taskStaging:
              prepared
                .taskStaging,
            eventStaging:
              prepared
                .eventStaging,
            workflowStageIdentities:
              prepared
                .workflowStageIdentities,
            store:
              new MemoryVerificationStore(),
          }),
        ).rejects.toThrow(
          /cannot find staged record/,
        );
      },
    );

    it(
      'rejects incomplete staging accounting instead of allowing a physical source to disappear from verification',
      async () => {
        const prepared =
          await prepareFull();

        const incomplete:
          LegacyImportEventStagingResult = {
            ...prepared
              .eventStaging,
            staged: [],
          };

        await expect(
          verifyLegacyImportStaging({
            plan:
              prepared.importPlan,
            projectStaging:
              prepared
                .projectStaging,
            taskStaging:
              prepared
                .taskStaging,
            eventStaging:
              incomplete,
            workflowStageIdentities:
              prepared
                .workflowStageIdentities,
            store:
              prepared.store,
          }),
        ).rejects.toThrow(
          /event staging candidate accounting mismatch|event staging staged count mismatch/,
        );
      },
    );

    it(
      'rejects any legacy projectType field leaking into a canonical staged project',
      async () => {
        const prepared =
          await prepareFull();

        const entry =
          prepared
            .projectStaging
            .staged[0];

        if (
          entry
          === undefined
        ) {
          throw new Error(
            'Expected staged project.',
          );
        }

        const leaked =
          {
            ...entry.record,
            projectType:
              'schedule',
          } as unknown as CanonicalProjectRecordV2;

        const tampered:
          LegacyImportProjectStagingResult = {
            ...prepared
              .projectStaging,
            staged: [
              {
                ...entry,
                record:
                  leaked,
              },
            ],
          };

        await expect(
          verifyLegacyImportStaging({
            plan:
              prepared.importPlan,
            projectStaging:
              tampered,
            taskStaging:
              prepared
                .taskStaging,
            eventStaging:
              prepared
                .eventStaging,
            workflowStageIdentities:
              prepared
                .workflowStageIdentities,
            store:
              prepared.store,
          }),
        ).rejects.toThrow(
          /legacy projectType/,
        );
      },
    );
  },
);
