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
  materializeLegacyImportEventStaging,
} from '../src/app/importEventStagingPlanner.js';
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

class MemoryEventStagingStore
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
      snapshot: {
        taskSchema: [],
        projectSchemas: {},
      },
      allocator:
        schemaAllocator(),
    },
    {
      allocator:
        artifactAllocator(),
    },
  );
}

describe(
  'Stage 8 slice 15 canonical event staging',
  () => {
    it(
      'stages a complete representable project event through canonical project identity with no guessed recurrence or property data',
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

            'Proxima/events/event.md': [
              '---',
              'id: event',
              'name: Event',
              'description: Event description',
              'project: alpha',
              'createdAt: 2026-01-02T03:04:05.000Z',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:30:00.000Z',
              'isCompleted: true',
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
              === 'event',
          );

        expect(conversion)
          .toMatchObject({
            kind:
              'event',
            recordId:
              opaque(
                2,
              ),
            sourcePath:
              'Proxima/events/event.md',
            name:
              'Event',
            description:
              'Event description',
            createdAt:
              '2026-01-02T03:04:05.000Z',
            startDate:
              '2026-09-12T10:00:00.000Z',
            deadline:
              '2026-09-12T11:30:00.000Z',
            isCompleted:
              true,
            recurrence:
              null,
            project: {
              resolution:
                'resolved',
              projectRecordId:
                opaque(
                  1,
                ),
            },
          });

        const store =
          new MemoryEventStagingStore();

        await materializeLegacyImportProjectStaging(
          importPlan,
          store,
        );

        const result =
          await materializeLegacyImportEventStaging(
            importPlan,
            store,
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'staging-materialization',
            source:
              'legacy-import-event-conversions',
            scope:
              'event-records-only',
            activation:
              'not-performed',
            counts: {
              eventCandidates: 1,
              eligibleEventRecords: 1,
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

        expect(
          result.staged[0]
            ?.record,
        ).toEqual({
          schemaVersion: 2,
          kind:
            'event',
          id:
            opaque(
              2,
            ),
          name:
            'Event',
          description:
            'Event description',
          projectId:
            opaque(
              1,
            ),
          createdAt:
            '2026-01-02T03:04:05.000Z',
          startDate:
            '2026-09-12T10:00:00.000Z',
          deadline:
            '2026-09-12T11:30:00.000Z',
          isCompleted:
            true,
          properties: {},
          recurrence:
            null,
        });
      },
    );

    it(
      'stages a projectless ordinary event with null project identity',
      async () => {
        const importPlan =
          await plan({
            'Proxima/events/event.md': [
              '---',
              'id: event',
              'name: Loose Event',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),
          });

        const result =
          await materializeLegacyImportEventStaging(
            importPlan,
            new MemoryEventStagingStore(),
          );

        expect(result.counts)
          .toEqual({
            eventCandidates: 1,
            eligibleEventRecords: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 0,
            reported: 0,
          });

        expect(
          result.staged[0]
            ?.record,
        ).toMatchObject({
          kind:
            'event',
          name:
            'Loose Event',
          projectId:
            null,
          recurrence:
            null,
          properties: {},
        });
      },
    );

    it(
      'blocks missing and ambiguous project references instead of selecting a project by alias order',
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

            'Proxima/events/ambiguous.md': [
              '---',
              'id: ambiguous',
              'project: shared',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),

            'Proxima/events/missing.md': [
              '---',
              'id: missing',
              'project: nowhere',
              'startDate: 2026-09-12T12:00:00.000Z',
              'deadline: 2026-09-12T13:00:00.000Z',
              '---',
              '',
            ].join('\n'),
          });

        const result =
          await materializeLegacyImportEventStaging(
            importPlan,
            new MemoryEventStagingStore(),
          );

        expect(result.counts)
          .toEqual({
            eventCandidates: 2,
            eligibleEventRecords: 0,
            created: 0,
            reusedIdentical: 0,
            blocked: 2,
            reported: 0,
          });

        expect(result.blockers)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                reason:
                  'project-reference-unresolved',
                sourcePath:
                  'Proxima/events/ambiguous.md',
                resolution:
                  'ambiguous',
              }),
              expect.objectContaining({
                reason:
                  'project-reference-unresolved',
                sourcePath:
                  'Proxima/events/missing.md',
                resolution:
                  'missing',
              }),
            ]),
          );
      },
    );

    it(
      'blocks a project event until its exact canonical project record is staged',
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

            'Proxima/events/event.md': [
              '---',
              'id: event',
              'project: alpha',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),
          });

        const store =
          new MemoryEventStagingStore();

        const blocked =
          await materializeLegacyImportEventStaging(
            importPlan,
            store,
          );

        expect(
          blocked.blockers[0],
        ).toMatchObject({
          reason:
            'project-record-missing',
          sourcePath:
            'Proxima/events/event.md',
          projectRecordId:
            opaque(
              1,
            ),
        });

        await materializeLegacyImportProjectStaging(
          importPlan,
          store,
        );

        const staged =
          await materializeLegacyImportEventStaging(
            importPlan,
            store,
          );

        expect(staged.counts)
          .toMatchObject({
            created: 1,
            blocked: 0,
            reported: 0,
          });
      },
    );

    it(
      'keeps malformed, unsupported-frontmatter, invalid-range, and untyped-extra-property events out of canonical staging while an independent valid event stages',
      async () => {
        const importPlan =
          await plan({
            'Proxima/events/malformed.md': [
              '---',
              'id: malformed',
              'name: "unterminated',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),

            'Proxima/events/unsupported.md': [
              '---',
              'id: unsupported',
              'description: |',
              '  unsupported',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),

            'Proxima/events/inverted.md': [
              '---',
              'id: inverted',
              'startDate: 2026-09-12T12:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),

            'Proxima/events/custom.md': [
              '---',
              'id: custom',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              'color: "#ff0000"',
              '---',
              '',
            ].join('\n'),

            'Proxima/events/valid.md': [
              '---',
              'id: valid',
              'startDate: 2026-09-12T14:00:00.000Z',
              'deadline: 2026-09-12T15:00:00.000Z',
              '---',
              '',
            ].join('\n'),
          });

        const result =
          await materializeLegacyImportEventStaging(
            importPlan,
            new MemoryEventStagingStore(),
          );

        expect(result.counts)
          .toEqual({
            eventCandidates: 5,
            eligibleEventRecords: 2,
            created: 2,
            reusedIdentical: 0,
            blocked: 3,
            reported: 1,
          });

        // Only the unreadable one is blocked by frontmatter: D65 makes the record with an unsupported construct
        // importable using the interpreted fields, with the construct reported against it.
        expect(
          result.staged.map(
            (entry) =>
              entry.sourcePath,
          ),
        ).toEqual([
          'Proxima/events/unsupported.md',
          'Proxima/events/valid.md',
        ]);

        expect(result.blockers)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                reason:
                  'malformed-event',
                sourcePath:
                  'Proxima/events/malformed.md',
              }),
              expect.objectContaining({
                reason:
                  'event-time-range-unrepresentable',
                sourcePath:
                  'Proxima/events/inverted.md',
              }),
              expect.objectContaining({
                reason:
                  'legacy-event-properties-untyped',
                sourcePath:
                  'Proxima/events/custom.md',
                legacyPropertyKeys: [
                  'color',
                ],
              }),
            ]),
          );
        // Exactly three: the unsupported construct is no longer one of them.
        expect(result.blockers)
          .toHaveLength(3);

        expect(result.reported)
          .toHaveLength(1);
        expect(result.reported[0])
          .toMatchObject({
            sourcePath:
              'Proxima/events/unsupported.md',
          });
        expect(result.reported[0]!
          .diagnostics
          .length)
          .toBeGreaterThan(0);
      },
    );

    it(
      'materializes duplicate-alias event files independently under their already-assigned physical candidate ids',
      async () => {
        const importPlan =
          await plan({
            'Proxima/events/a.md': [
              '---',
              'id: shared-event',
              'name: A',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),

            'Proxima/events/b.md': [
              '---',
              'id: shared-event',
              'name: B',
              'startDate: 2026-09-12T12:00:00.000Z',
              'deadline: 2026-09-12T13:00:00.000Z',
              '---',
              '',
            ].join('\n'),
          });

        expect(
          importPlan.collisions,
        ).toHaveLength(
          1,
        );

        const result =
          await materializeLegacyImportEventStaging(
            importPlan,
            new MemoryEventStagingStore(),
          );

        expect(result.counts)
          .toEqual({
            eventCandidates: 2,
            eligibleEventRecords: 2,
            created: 2,
            reusedIdentical: 0,
            blocked: 0,
            reported: 0,
          });

        expect(
          result.staged.map(
            (entry) => ({
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
              'Proxima/events/a.md',
            id:
              opaque(
                1,
              ),
            name:
              'A',
          },
          {
            sourcePath:
              'Proxima/events/b.md',
            id:
              opaque(
                2,
              ),
            name:
              'B',
          },
        ]);
      },
    );

    it(
      'reuses an identical staged event on rerun and refuses a conflicting payload without overwriting it',
      async () => {
        const importPlan =
          await plan({
            'Proxima/events/event.md': [
              '---',
              'id: event',
              'name: Event',
              'startDate: 2026-09-12T10:00:00.000Z',
              'deadline: 2026-09-12T11:00:00.000Z',
              '---',
              '',
            ].join('\n'),
          });

        const store =
          new MemoryEventStagingStore();

        const first =
          await materializeLegacyImportEventStaging(
            importPlan,
            store,
          );

        const second =
          await materializeLegacyImportEventStaging(
            importPlan,
            store,
          );

        expect(first.counts)
          .toMatchObject({
            created: 1,
            reusedIdentical: 0,
            blocked: 0,
            reported: 0,
          });

        expect(second.counts)
          .toMatchObject({
            created: 0,
            reusedIdentical: 1,
            blocked: 0,
            reported: 0,
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
            'Expected one staged event.',
          );
        }

        const conflictStore =
          new MemoryEventStagingStore();

        conflictStore.seed({
          ...expected,
          name:
            'Conflicting staged event',
        });

        const conflict =
          await materializeLegacyImportEventStaging(
            importPlan,
            conflictStore,
          );

        expect(conflict.counts)
          .toMatchObject({
            created: 0,
            reusedIdentical: 0,
            blocked: 1,
            reported: 0,
          });

        expect(conflict.blockers)
          .toEqual([
            {
              reason:
                'staging-record-conflict',
              recordId:
                expected.id,
              sourcePath:
                'Proxima/events/event.md',
            },
          ]);

        expect(
          conflictStore
            .values()[0]
            ?.name,
        ).toBe(
          'Conflicting staged event',
        );
      },
    );
  },
);
