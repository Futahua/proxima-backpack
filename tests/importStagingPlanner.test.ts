import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import {
  materializeLegacyImportSchemaStaging,
  type LegacyImportStagingCreateResult,
  type LegacyImportStagingStore,
} from '../src/app/importStagingPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import type {
  LegacyInterpretedPropertySchemaSettingsSnapshot,
  LegacyImportSchemaIdentityAllocator,
} from '../src/app/importSchemaPlanner.js';
import {
  encodeCanonicalRecordV2,
  type CanonicalRecordV2,
} from '../src/domain/canonicalRecordV2.js';
import type {
  OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import type {
  CanonicalPropertySchemaRecord,
} from '../src/domain/canonicalSchema.js';

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

function opaqueOptionId(
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
  let next = 1;

  return {
    recordIdFor() {
      const id =
        opaqueRecordId(
          next,
        );

      next += 1;

      return id;
    },
  };
}

function sequentialSchemaAllocator():
  LegacyImportSchemaIdentityAllocator {
  let nextRecord = 100;
  let nextOption = 1;

  return {
    schemaRecordIdFor() {
      const id =
        opaqueRecordId(
          nextRecord,
        );

      nextRecord += 1;

      return id;
    },

    schemaOptionIdFor() {
      const id =
        opaqueOptionId(
          nextOption,
        );

      nextOption += 1;

      return id;
    },
  };
}

class MemoryLegacyImportStagingStore
implements LegacyImportStagingStore {
  readonly authority =
    'legacy-import-staging-only' as const;

  private readonly records =
    new Map<
      OpaqueRecordId,
      CanonicalRecordV2
    >();

  creates = 0;

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

    this.creates += 1;

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

async function schemaPlan(
  snapshot:
    LegacyInterpretedPropertySchemaSettingsSnapshot,
) {
  return planLegacyMarkdownImport(
    createMemoryVault({}),
    sequentialRecordAllocator(),
    {},
    null,
    {
      snapshot,
      allocator:
        sequentialSchemaAllocator(),
    },
    null,
  );
}

function readySchemaRecord(
  plan:
    Awaited<
      ReturnType<
        typeof schemaPlan
      >
    >,
  legacySchemaId:
    string,
): CanonicalPropertySchemaRecord {
  const conversion =
    plan.schemaSettings
      ?.conversions
      .find(
        (candidate) =>
          candidate
            .legacySchemaId
          === legacySchemaId,
      );

  if (
    conversion
    === undefined
    || conversion.disposition
      !== 'canonical-ready'
  ) {
    throw new Error(
      `Expected canonical-ready schema ${legacySchemaId}.`,
    );
  }

  return conversion.record;
}

describe(
  'Stage 8 slice 9 isolated schema staging materialization',
  () => {
    it(
      'materializes canonical-ready primitive, relation, formula, and slice-7 rollup schema records into staging only',
      async () => {
        const plan =
          await schemaPlan({
            taskSchema: [
              {
                id:
                  'points',
                name:
                  'Points',
                type:
                  'number',
              },
              {
                id:
                  'related',
                name:
                  'Related',
                type:
                  'relation',
                targetFolder:
                  'Proxima/tasks',
              },
              {
                id:
                  'total',
                name:
                  'Total',
                type:
                  'rollup',
                relationProperty:
                  'related',
                targetProperty:
                  'points',
                aggregation:
                  'sum',
              },
              {
                id:
                  'calc',
                name:
                  'Calc',
                type:
                  'formula',
                expression:
                  '1 + 1',
              },
            ],
            projectSchemas: {},
          });

        const store =
          new MemoryLegacyImportStagingStore();

        const result =
          await materializeLegacyImportSchemaStaging(
            plan,
            store,
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'staging-materialization',
            source:
              'legacy-import-plan-schema-conversions',
            scope:
              'schema-records-only',
            activation:
              'not-performed',
            counts: {
              eligibleSchemaRecords: 4,
              created: 4,
              reusedIdentical: 0,
              blocked: 0,
            },
            writes: {
              legacyMarkdown: 0,
              recordStore: 0,
              staging: 4,
              externalArtifacts: 0,
              activation: 0,
            },
          });

        expect(
          result.blockers,
        ).toEqual([]);

        expect(
          store.values(),
        ).toHaveLength(4);

        expect(
          store
            .values()
            .every(
              (record) =>
                record.kind
                === 'schema',
            ),
        ).toBe(true);

        const rollup =
          result.staged.find(
            (record) =>
              record.legacySchemaId
              === 'total',
          );

        expect(rollup)
          .toMatchObject({
            origin:
              'derived-rollup',
            outcome:
              'created',
            record: {
              kind:
                'schema',
              name:
                'Total',
              definition: {
                type:
                  'rollup',
                aggregation:
                  'sum',
              },
            },
          });
      },
    );

    it(
      'reuses an identical staged schema set on rerun without creating duplicate canonical records',
      async () => {
        const plan =
          await schemaPlan({
            taskSchema: [
              {
                id:
                  'title',
                name:
                  'Title',
                type:
                  'text',
              },
              {
                id:
                  'priority',
                name:
                  'Priority',
                type:
                  'number',
              },
            ],
            projectSchemas: {},
          });

        const store =
          new MemoryLegacyImportStagingStore();

        const first =
          await materializeLegacyImportSchemaStaging(
            plan,
            store,
          );

        const second =
          await materializeLegacyImportSchemaStaging(
            plan,
            store,
          );

        expect(first.counts)
          .toEqual({
            eligibleSchemaRecords: 2,
            created: 2,
            reusedIdentical: 0,
            blocked: 0,
          });

        expect(second.counts)
          .toEqual({
            eligibleSchemaRecords: 2,
            created: 0,
            reusedIdentical: 2,
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
        ).toBe(2);

        expect(
          store.values(),
        ).toHaveLength(2);
      },
    );

    it(
      'resumes after a partially materialized staging attempt by reusing the existing identical record and creating only the remainder',
      async () => {
        const plan =
          await schemaPlan({
            taskSchema: [
              {
                id:
                  'points',
                name:
                  'Points',
                type:
                  'number',
              },
              {
                id:
                  'label',
                name:
                  'Label',
                type:
                  'text',
              },
              {
                id:
                  'done',
                name:
                  'Done',
                type:
                  'checkbox',
              },
            ],
            projectSchemas: {},
          });

        const store =
          new MemoryLegacyImportStagingStore();

        store.seed(
          readySchemaRecord(
            plan,
            'points',
          ),
        );

        const result =
          await materializeLegacyImportSchemaStaging(
            plan,
            store,
          );

        expect(result.counts)
          .toEqual({
            eligibleSchemaRecords: 3,
            created: 2,
            reusedIdentical: 1,
            blocked: 0,
          });

        expect(
          result.staged
            .find(
              (entry) =>
                entry.legacySchemaId
                === 'points',
            ),
        ).toMatchObject({
          outcome:
            'reused-identical',
        });

        expect(
          store.creates,
        ).toBe(2);

        expect(
          store.values(),
        ).toHaveLength(3);
      },
    );

    it(
      'reports a different pre-existing staged payload as a blocker without overwriting it and still stages other valid schema records',
      async () => {
        const plan =
          await schemaPlan({
            taskSchema: [
              {
                id:
                  'first',
                name:
                  'First',
                type:
                  'text',
              },
              {
                id:
                  'second',
                name:
                  'Second',
                type:
                  'number',
              },
            ],
            projectSchemas: {},
          });

        const first =
          readySchemaRecord(
            plan,
            'first',
          );

        const store =
          new MemoryLegacyImportStagingStore();

        store.seed({
          ...first,
          name:
            'Conflicting staged name',
        });

        const result =
          await materializeLegacyImportSchemaStaging(
            plan,
            store,
          );

        expect(result.counts)
          .toEqual({
            eligibleSchemaRecords: 2,
            created: 1,
            reusedIdentical: 0,
            blocked: 1,
          });

        expect(result.blockers)
          .toEqual([
            expect.objectContaining({
              reason:
                'staging-record-conflict',
              recordId:
                first.id,
              legacySchemaId:
                'first',
            }),
          ]);

        expect(
          store
            .values()
            .find(
              (record) =>
                record.id
                === first.id,
            )
            ?.name,
        ).toBe(
          'Conflicting staged name',
        );

        expect(
          result.staged.map(
            (entry) =>
              entry.legacySchemaId,
          ),
        ).toEqual([
          'second',
        ]);
      },
    );

    it(
      'stages independent valid schemas while keeping pending relation and unresolved rollup schemas explicit blockers',
      async () => {
        const plan =
          await schemaPlan({
            taskSchema: [
              {
                id:
                  'points',
                name:
                  'Points',
                type:
                  'number',
              },
              {
                id:
                  'related',
                name:
                  'Related',
                type:
                  'relation',
                targetFolder:
                  'Outside/Unknown',
              },
              {
                id:
                  'total',
                name:
                  'Total',
                type:
                  'rollup',
                relationProperty:
                  'related',
                targetProperty:
                  'points',
                aggregation:
                  'sum',
              },
            ],
            projectSchemas: {},
          });

        const store =
          new MemoryLegacyImportStagingStore();

        const result =
          await materializeLegacyImportSchemaStaging(
            plan,
            store,
          );

        expect(result.counts)
          .toEqual({
            eligibleSchemaRecords: 1,
            created: 1,
            reusedIdentical: 0,
            blocked: 2,
          });

        expect(
          result.staged.map(
            (entry) =>
              entry.legacySchemaId,
          ),
        ).toEqual([
          'points',
        ]);

        expect(result.blockers)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                reason:
                  'schema-conversion-pending',
                legacySchemaId:
                  'related',
                pending: {
                  reason:
                    'relation-target-resolution-pending',
                  legacyTargetFolder:
                    'Outside/Unknown',
                },
              }),
              expect.objectContaining({
                reason:
                  'rollup-schema-unresolved',
                legacySchemaId:
                  'total',
                rollupReason:
                  'legacy-rollup-relation-reference-pending',
              }),
            ]),
          );

        expect(result.writes)
          .toEqual({
            legacyMarkdown: 0,
            recordStore: 0,
            staging: 1,
            externalArtifacts: 0,
            activation: 0,
          });
      },
    );
  },
);
