import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import {
  type LegacyImportStagingCreateResult,
  type LegacyImportStagingStore,
} from '../src/app/importStagingPlanner.js';
import {
  materializeLegacyImportWorkflowStageStaging,
  type LegacyImportWorkflowStageIdentityAllocator,
  type LegacyImportWorkflowStageIdentityMappingManifest,
  type LegacyImportWorkflowStageIdentityMappingStore,
  type LegacyImportWorkflowStageIdentityRequest,
} from '../src/app/importWorkflowStageStagingPlanner.js';
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

function sequentialRecordAllocator():
  LegacyImportIdentityAllocator {
  let next = 1;

  return {
    recordIdFor() {
      const value =
        opaque(
          next,
        );

      next += 1;

      return value;
    },
  };
}

function sequentialWorkflowStageAllocator(
  requests:
    LegacyImportWorkflowStageIdentityRequest[] =
      [],
  start =
    100,
): LegacyImportWorkflowStageIdentityAllocator {
  let next =
    start;

  return {
    workflowStageRecordIdFor(
      request,
    ) {
      requests.push({
        ...request,
      });

      const value =
        opaque(
          next,
        );

      next += 1;

      return value;
    },
  };
}

class MemoryWorkflowStageIdentityStore
implements LegacyImportWorkflowStageIdentityMappingStore {
  private mapping:
    LegacyImportWorkflowStageIdentityMappingManifest | null;

  readonly events:
    string[];

  saves = 0;

  constructor(
    events:
      string[] =
        [],
    initial:
      LegacyImportWorkflowStageIdentityMappingManifest | null =
        null,
  ) {
    this.events =
      events;

    this.mapping =
      initial === null
        ? null
        : JSON.parse(
            JSON.stringify(
              initial,
            ),
          ) as LegacyImportWorkflowStageIdentityMappingManifest;
  }

  async load():
    Promise<
      LegacyImportWorkflowStageIdentityMappingManifest | null
    > {
    this.events.push(
      'mapping-load',
    );

    return this.mapping === null
      ? null
      : JSON.parse(
          JSON.stringify(
            this.mapping,
          ),
        ) as LegacyImportWorkflowStageIdentityMappingManifest;
  }

  async save(
    mapping:
      LegacyImportWorkflowStageIdentityMappingManifest,
  ): Promise<void> {
    this.mapping =
      JSON.parse(
        JSON.stringify(
          mapping,
        ),
      ) as LegacyImportWorkflowStageIdentityMappingManifest;

    this.saves += 1;

    this.events.push(
      'mapping-save',
    );
  }
}

class MemoryWorkflowStageStagingStore
implements LegacyImportStagingStore {
  readonly authority =
    'legacy-import-staging-only' as const;

  private readonly records =
    new Map<
      OpaqueRecordId,
      CanonicalRecordV2
    >();

  readonly events:
    string[];

  creates = 0;

  failNextCreate =
    false;

  constructor(
    events:
      string[] =
        [],
  ) {
    this.events =
      events;
  }

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
    this.events.push(
      `staging-create:${record.id}`,
    );

    if (
      this.failNextCreate
    ) {
      this.failNextCreate =
        false;

      throw new Error(
        'injected staging interruption',
      );
    }

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

    this.creates += 1;

    return {
      ok: true,
    };
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
) {
  return planLegacyMarkdownImport(
    createMemoryVault(
      files,
    ),
    sequentialRecordAllocator(),
  );
}

describe(
  'Stage 8 slice 10 durable workflow-stage identity and staging',
  () => {
    it(
      'allocates one canonical workflow-stage identity per project/status pair, saves identities before staging, and shares the stage across matching tasks',
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

            'Proxima/projects/beta.md': [
              '---',
              'id: beta',
              'type: project',
              'name: Beta',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/alpha-a.md': [
              '---',
              'id: alpha-a',
              'name: Alpha A',
              'project: alpha',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/alpha-b.md': [
              '---',
              'id: alpha-b',
              'name: Alpha B',
              'project: alpha',
              'status: review',
              'orderIndex: 2',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/beta-a.md': [
              '---',
              'id: beta-a',
              'name: Beta A',
              'project: beta',
              'status: review',
              'orderIndex: 3',
              '---',
              '',
            ].join('\n'),
          });

        const requests:
          LegacyImportWorkflowStageIdentityRequest[] =
            [];

        const events:
          string[] =
            [];

        const identityStore =
          new MemoryWorkflowStageIdentityStore(
            events,
          );

        const stagingStore =
          new MemoryWorkflowStageStagingStore(
            events,
          );

        const result =
          await materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            sequentialWorkflowStageAllocator(
              requests,
            ),
            identityStore,
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'staging-materialization',
            source:
              'legacy-import-task-workflow-stage-candidates',
            scope:
              'workflow-stage-records-only',
            activation:
              'not-performed',
            counts: {
              candidateStageKeys: 2,
              reservedStageIdentities: 2,
              created: 2,
              reusedIdentical: 0,
              blocked: 0,
            },
            writes: {
              legacyMarkdown: 0,
              recordStore: 0,
              staging: 2,
              identityMapping: 1,
              externalArtifacts: 0,
              activation: 0,
            },
          });

        expect(requests)
          .toHaveLength(
            2,
          );

        expect(
          new Set(
            requests.map(
              (request) =>
                request.projectRecordId,
            ),
          ).size,
        ).toBe(2);

        expect(
          requests.map(
            (request) =>
              request.legacyStatusId,
          ),
        ).toEqual([
          'review',
          'review',
        ]);

        expect(
          result.identityMapping.entries,
        ).toHaveLength(2);

        expect(
          result.staged,
        ).toHaveLength(2);

        for (
          const staged
          of result.staged
        ) {
          expect(
            staged.record.kind,
          ).toBe(
            'workflow-stage',
          );

          expect(
            staged.record.projectId,
          ).toBe(
            staged.projectRecordId,
          );

          const expected =
            requests.find(
              (request) =>
                request.projectRecordId
                  === staged.projectRecordId
                && request.legacyStatusId
                  === staged.legacyStatusId,
            );

          expect(expected)
            .toBeDefined();

          expect(
            staged.record.name,
          ).toBe(
            expected
              ?.suggestedName,
          );
        }

        const saveIndex =
          events.indexOf(
            'mapping-save',
          );

        const firstCreateIndex =
          events.findIndex(
            (event) =>
              event.startsWith(
                'staging-create:',
              ),
          );

        expect(saveIndex)
          .toBeGreaterThanOrEqual(
            0,
          );

        expect(firstCreateIndex)
          .toBeGreaterThan(
            saveIndex,
          );
      },
    );

    it(
      'reuses the durable workflow-stage mapping and identical staged records on rerun without reallocating or duplicating them',
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

            'Proxima/tasks/a.md': [
              '---',
              'id: a',
              'project: alpha',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/b.md': [
              '---',
              'id: b',
              'project: alpha',
              'status: waiting',
              'orderIndex: 2',
              '---',
              '',
            ].join('\n'),
          });

        const identityStore =
          new MemoryWorkflowStageIdentityStore();

        const stagingStore =
          new MemoryWorkflowStageStagingStore();

        const first =
          await materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            sequentialWorkflowStageAllocator(),
            identityStore,
          );

        const second =
          await materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            {
              workflowStageRecordIdFor() {
                throw new Error(
                  'durable workflow-stage identities must be reused',
                );
              },
            },
            identityStore,
          );

        expect(first.counts)
          .toMatchObject({
            candidateStageKeys: 2,
            created: 2,
            reusedIdentical: 0,
            blocked: 0,
          });

        expect(second.counts)
          .toMatchObject({
            candidateStageKeys: 2,
            created: 0,
            reusedIdentical: 2,
            blocked: 0,
          });

        expect(second.writes)
          .toEqual({
            legacyMarkdown: 0,
            recordStore: 0,
            staging: 0,
            identityMapping: 0,
            externalArtifacts: 0,
            activation: 0,
          });

        expect(
          identityStore.saves,
        ).toBe(1);

        expect(
          stagingStore.creates,
        ).toBe(2);

        expect(
          stagingStore.values(),
        ).toHaveLength(2);

        expect(
          second.identityMapping,
        ).toEqual(
          first.identityMapping,
        );
      },
    );

    it(
      'survives interruption after durable identity save but before the first stage record is created',
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

            'Proxima/tasks/a.md': [
              '---',
              'id: a',
              'project: alpha',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),
          });

        const events:
          string[] =
            [];

        const identityStore =
          new MemoryWorkflowStageIdentityStore(
            events,
          );

        const stagingStore =
          new MemoryWorkflowStageStagingStore(
            events,
          );

        stagingStore.failNextCreate =
          true;

        await expect(
          materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            sequentialWorkflowStageAllocator(),
            identityStore,
          ),
        ).rejects.toThrow(
          /injected staging interruption/,
        );

        expect(
          identityStore.saves,
        ).toBe(1);

        expect(
          stagingStore.values(),
        ).toHaveLength(0);

        expect(
          events.indexOf(
            'mapping-save',
          ),
        ).toBeLessThan(
          events.findIndex(
            (event) =>
              event.startsWith(
                'staging-create:',
              ),
          ),
        );

        const resumed =
          await materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            {
              workflowStageRecordIdFor() {
                throw new Error(
                  'resume must reuse the identity saved before interruption',
                );
              },
            },
            identityStore,
          );

        expect(resumed.counts)
          .toMatchObject({
            candidateStageKeys: 1,
            reservedStageIdentities: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 0,
          });

        expect(resumed.writes)
          .toMatchObject({
            staging: 1,
            identityMapping: 0,
          });

        expect(
          identityStore.saves,
        ).toBe(1);

        expect(
          stagingStore.values(),
        ).toHaveLength(1);
      },
    );

    it(
      'refuses a workflow-stage allocator result that collides with an already assigned physical canonical record identity before persisting or staging',
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

            'Proxima/tasks/a.md': [
              '---',
              'id: a',
              'project: alpha',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),
          });

        const reserved =
          importPlan.mappings[0]
            ?.recordId;

        if (
          reserved
          === undefined
        ) {
          throw new Error(
            'Expected reserved physical record identity.',
          );
        }

        const identityStore =
          new MemoryWorkflowStageIdentityStore();

        const stagingStore =
          new MemoryWorkflowStageStagingStore();

        await expect(
          materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            {
              workflowStageRecordIdFor() {
                return reserved;
              },
            },
            identityStore,
          ),
        ).rejects.toThrow(
          /collides with reserved canonical import record identity/,
        );

        expect(
          identityStore.saves,
        ).toBe(0);

        expect(
          stagingStore.creates,
        ).toBe(0);

        expect(
          stagingStore.values(),
        ).toHaveLength(0);
      },
    );

    it(
      'refuses one workflow-stage record id being allocated to two distinct project/status stage keys',
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

            'Proxima/projects/beta.md': [
              '---',
              'id: beta',
              'type: project',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/a.md': [
              '---',
              'id: a',
              'project: alpha',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/b.md': [
              '---',
              'id: b',
              'project: beta',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),
          });

        const reused =
          opaque(
            900,
          );

        const identityStore =
          new MemoryWorkflowStageIdentityStore();

        const stagingStore =
          new MemoryWorkflowStageStagingStore();

        await expect(
          materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            {
              workflowStageRecordIdFor() {
                return reused;
              },
            },
            identityStore,
          ),
        ).rejects.toThrow(
          /reused workflow-stage record id/,
        );

        expect(
          identityStore.saves,
        ).toBe(0);

        expect(
          stagingStore.creates,
        ).toBe(0);
      },
    );

    it(
      'keeps a stale durable stage identity reserved instead of silently reassigning it to a new stage key',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/new.md': [
              '---',
              'id: new-project',
              'type: project',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/new.md': [
              '---',
              'id: new-task',
              'project: new-project',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),
          });

        const reserved =
          opaque(
            888,
          );

        const prior:
          LegacyImportWorkflowStageIdentityMappingManifest = {
            schemaVersion: 1,
            reconciliationKey:
              'project-record-id+legacy-status-id',
            entries: [
              {
                projectRecordId:
                  opaque(
                    777,
                  ) as OpaqueRecordId,
                legacyStatusId:
                  'old-status',
                recordId:
                  reserved as OpaqueRecordId,
              },
            ],
          };

        const identityStore =
          new MemoryWorkflowStageIdentityStore(
            [],
            prior,
          );

        const stagingStore =
          new MemoryWorkflowStageStagingStore();

        await expect(
          materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            {
              workflowStageRecordIdFor() {
                return reserved;
              },
            },
            identityStore,
          ),
        ).rejects.toThrow(
          /already assigned to/,
        );

        expect(
          identityStore.saves,
        ).toBe(0);

        expect(
          stagingStore.creates,
        ).toBe(0);
      },
    );

    it(
      'stages valid workflow stages while missing and ambiguous project references remain explicit blockers and projectless tasks create no stage',
      async () => {
        const importPlan =
          await plan({
            'Proxima/projects/shared-a.md': [
              '---',
              'id: shared-project',
              'type: project',
              'name: Shared A',
              '---',
              '',
            ].join('\n'),

            'Proxima/projects/shared-b.md': [
              '---',
              'id: shared-project',
              'type: project',
              'name: Shared B',
              '---',
              '',
            ].join('\n'),

            'Proxima/projects/valid.md': [
              '---',
              'id: valid-project',
              'type: project',
              'name: Valid',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/ambiguous.md': [
              '---',
              'id: ambiguous',
              'project: shared-project',
              'status: review',
              'orderIndex: 1',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/missing.md': [
              '---',
              'id: missing',
              'project: missing-project',
              'status: waiting',
              'orderIndex: 2',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/valid.md': [
              '---',
              'id: valid',
              'project: valid-project',
              'status: review',
              'orderIndex: 3',
              '---',
              '',
            ].join('\n'),

            'Proxima/tasks/projectless.md': [
              '---',
              'id: projectless',
              'status: backlog',
              'orderIndex: 4',
              '---',
              '',
            ].join('\n'),
          });

        const requests:
          LegacyImportWorkflowStageIdentityRequest[] =
            [];

        const identityStore =
          new MemoryWorkflowStageIdentityStore();

        const stagingStore =
          new MemoryWorkflowStageStagingStore();

        const result =
          await materializeLegacyImportWorkflowStageStaging(
            importPlan,
            stagingStore,
            sequentialWorkflowStageAllocator(
              requests,
            ),
            identityStore,
          );

        expect(result.counts)
          .toEqual({
            candidateStageKeys: 1,
            reservedStageIdentities: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 2,
          });

        expect(requests)
          .toHaveLength(1);

        expect(result.blockers)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                reason:
                  'workflow-stage-project-unresolved',
                sourcePath:
                  'Proxima/tasks/ambiguous.md',
                legacyStatusId:
                  'review',
                resolution:
                  'ambiguous-project',
              }),

              expect.objectContaining({
                reason:
                  'workflow-stage-project-unresolved',
                sourcePath:
                  'Proxima/tasks/missing.md',
                legacyStatusId:
                  'waiting',
                resolution:
                  'missing-project',
              }),
            ]),
          );

        expect(
          result.blockers.some(
            (blocker) =>
              blocker.reason
                === 'workflow-stage-project-unresolved'
              && blocker.sourcePath
                === 'Proxima/tasks/projectless.md',
          ),
        ).toBe(false);

        expect(
          result.staged,
        ).toHaveLength(1);

        expect(
          result.staged[0],
        ).toMatchObject({
          legacyStatusId:
            'review',
          outcome:
            'created',
          record: {
            kind:
              'workflow-stage',
          },
        });

        expect(result.writes)
          .toEqual({
            legacyMarkdown: 0,
            recordStore: 0,
            staging: 1,
            identityMapping: 1,
            externalArtifacts: 0,
            activation: 0,
          });
      },
    );
  },
);
