import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import {
  materializeLegacyImportPhysicalCandidateIdentities,
  type LegacyImportPhysicalCandidateIdentityStagingStore,
} from '../src/app/importPhysicalCandidateStagingPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
  type LegacyImportIdentityMappingManifest,
} from '../src/app/importPlanner.js';

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

function sequentialAllocator():
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

class MemoryPhysicalCandidateIdentityStagingStore
implements LegacyImportPhysicalCandidateIdentityStagingStore {
  readonly authority =
    'legacy-import-staging-metadata-only' as const;

  private mapping:
    LegacyImportIdentityMappingManifest | null;

  saves =
    0;

  failNextSave =
    false;

  constructor(
    initial:
      LegacyImportIdentityMappingManifest | null =
        null,
  ) {
    this.mapping =
      initial === null
        ? null
        : JSON.parse(
            JSON.stringify(
              initial,
            ),
          ) as LegacyImportIdentityMappingManifest;
  }

  async load():
    Promise<
      LegacyImportIdentityMappingManifest | null
    > {
    return this.mapping
      === null
      ? null
      : JSON.parse(
          JSON.stringify(
            this.mapping,
          ),
        ) as LegacyImportIdentityMappingManifest;
  }

  async save(
    mapping:
      LegacyImportIdentityMappingManifest,
  ): Promise<void> {
    if (
      this.failNextSave
    ) {
      this.failNextSave =
        false;

      throw new Error(
        'injected staging metadata interruption',
      );
    }

    this.mapping =
      JSON.parse(
        JSON.stringify(
          mapping,
        ),
      ) as LegacyImportIdentityMappingManifest;

    this.saves +=
      1;
  }

  snapshot():
    LegacyImportIdentityMappingManifest | null {
    return this.mapping
      === null
      ? null
      : JSON.parse(
          JSON.stringify(
            this.mapping,
          ),
        ) as LegacyImportIdentityMappingManifest;
  }
}

async function duplicateProjectPlan() {
  return planLegacyMarkdownImport(
    createMemoryVault({
      'Proxima/projects/alpha.md': [
        '---',
        'id: shared-project',
        'type: project',
        'name: Alpha',
        '---',
        '',
      ].join(
        '\n',
      ),

      'Proxima/projects/beta.md': [
        '---',
        'id: shared-project',
        'type: project',
        'name: Beta',
        '---',
        '',
      ].join(
        '\n',
      ),
    }),
    sequentialAllocator(),
  );
}

async function singleProjectPlan() {
  return planLegacyMarkdownImport(
    createMemoryVault({
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
    }),
    sequentialAllocator(),
  );
}

describe(
  'Stage 8 slice 11 physical-candidate staging identities',
  () => {
    it(
      'persists every decodable duplicate physical source as a separate opaque candidate identity while retaining the shared legacy alias as collision evidence',
      async () => {
        const plan =
          await duplicateProjectPlan();

        expect(
          plan.mappings,
        ).toHaveLength(
          2,
        );

        expect(
          plan.collisions,
        ).toHaveLength(
          1,
        );

        const store =
          new MemoryPhysicalCandidateIdentityStagingStore();

        const result =
          await materializeLegacyImportPhysicalCandidateIdentities(
            plan,
            store,
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
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
            identityMappingOutcome:
              'created',
            counts: {
              physicalCandidates: 2,
              candidateIdentities: 2,
              duplicateAliasCandidates: 2,
              collisionGroups: 1,
            },
            writes: {
              legacyMarkdown: 0,
              recordStore: 0,
              stagingRecords: 0,
              stagingIdentityMapping: 1,
              externalArtifacts: 0,
              activation: 0,
            },
          });

        expect(
          result.candidates.map(
            (candidate) =>
              candidate.legacyId,
          ),
        ).toEqual([
          'shared-project',
          'shared-project',
        ]);

        expect(
          new Set(
            result.candidates.map(
              (candidate) =>
                candidate.recordId,
            ),
          ).size,
        ).toBe(
          2,
        );

        expect(
          result.candidates.map(
            (candidate) =>
              candidate.sourcePath,
          ),
        ).toEqual([
          'Proxima/projects/alpha.md',
          'Proxima/projects/beta.md',
        ]);

        expect(
          result.candidates.every(
            (candidate) =>
              candidate
                .collisionDisposition
              === 'duplicate-alias-collision'
              && candidate
                .payloadDisposition
              === 'canonical-payload-pending'
              && candidate
                .collisionCandidateRecordIds
                .length
              === 2,
          ),
        ).toBe(
          true,
        );

        expect(
          result.collisions[0],
        ).toMatchObject({
          kind:
            'project',
          legacyId:
            'shared-project',
        });

        expect(
          store.snapshot(),
        ).toEqual(
          plan.identityMapping,
        );

        expect(
          store.saves,
        ).toBe(
          1,
        );
      },
    );

    it(
      'persists exactly the already-authored physical identity metadata without allocating or rewriting identity from alias, path, name, or revision',
      async () => {
        const plan =
          await singleProjectPlan();

        const store =
          new MemoryPhysicalCandidateIdentityStagingStore();

        const result =
          await materializeLegacyImportPhysicalCandidateIdentities(
            plan,
            store,
          );

        const planned =
          plan.identityMapping
            .entries[0];

        const staged =
          result.candidates[0];

        if (
          planned
          === undefined
          || staged
          === undefined
        ) {
          throw new Error(
            'Expected one physical candidate identity.',
          );
        }

        expect(staged)
          .toMatchObject({
            kind:
              planned.kind,
            legacyId:
              planned.legacyId,
            recordId:
              planned.recordId,
            sourcePath:
              planned.sourcePath,
            sourceRevision:
              planned.sourceRevision,
            idOrigin:
              planned.idOrigin,
            collisionDisposition:
              'candidate',
            collisionCandidateRecordIds: [],
            payloadDisposition:
              'canonical-payload-pending',
          });

        expect(
          result.identityMapping,
        ).toEqual(
          plan.identityMapping,
        );

        expect(
          store.snapshot(),
        ).toEqual(
          plan.identityMapping,
        );
      },
    );

    it(
      'reuses an identical staging identity manifest on rerun without producing a second metadata write',
      async () => {
        const plan =
          await duplicateProjectPlan();

        const store =
          new MemoryPhysicalCandidateIdentityStagingStore();

        const first =
          await materializeLegacyImportPhysicalCandidateIdentities(
            plan,
            store,
          );

        const second =
          await materializeLegacyImportPhysicalCandidateIdentities(
            plan,
            store,
          );

        expect(
          first.identityMappingOutcome,
        ).toBe(
          'created',
        );

        expect(
          second.identityMappingOutcome,
        ).toBe(
          'reused-identical',
        );

        expect(second.writes)
          .toEqual({
            legacyMarkdown: 0,
            recordStore: 0,
            stagingRecords: 0,
            stagingIdentityMapping: 0,
            externalArtifacts: 0,
            activation: 0,
          });

        expect(
          store.saves,
        ).toBe(
          1,
        );

        expect(
          second.identityMapping,
        ).toEqual(
          first.identityMapping,
        );
      },
    );

    it(
      'refuses conflicting staging identity metadata instead of overwriting an already reserved physical candidate identity',
      async () => {
        const plan =
          await singleProjectPlan();

        const first =
          plan.identityMapping
            .entries[0];

        if (
          first
          === undefined
        ) {
          throw new Error(
            'Expected one physical identity mapping.',
          );
        }

        const conflicting:
          LegacyImportIdentityMappingManifest = {
            schemaVersion:
              plan.identityMapping
                .schemaVersion,
            entries: [
              {
                ...first,
                legacyId:
                  'different-legacy-alias',
              },
            ],
          };

        const store =
          new MemoryPhysicalCandidateIdentityStagingStore(
            conflicting,
          );

        await expect(
          materializeLegacyImportPhysicalCandidateIdentities(
            plan,
            store,
          ),
        ).rejects.toThrow(
          /conflicts with the current import plan/,
        );

        expect(
          store.saves,
        ).toBe(
          0,
        );

        expect(
          store.snapshot(),
        ).toEqual(
          conflicting,
        );
      },
    );

    it(
      'retries the same physical identity manifest after an interrupted staging-metadata save without changing candidate ids',
      async () => {
        const plan =
          await duplicateProjectPlan();

        const store =
          new MemoryPhysicalCandidateIdentityStagingStore();

        store.failNextSave =
          true;

        await expect(
          materializeLegacyImportPhysicalCandidateIdentities(
            plan,
            store,
          ),
        ).rejects.toThrow(
          /injected staging metadata interruption/,
        );

        expect(
          store.snapshot(),
        ).toBeNull();

        expect(
          store.saves,
        ).toBe(
          0,
        );

        const resumed =
          await materializeLegacyImportPhysicalCandidateIdentities(
            plan,
            store,
          );

        expect(
          resumed.identityMappingOutcome,
        ).toBe(
          'created',
        );

        expect(
          resumed.identityMapping,
        ).toEqual(
          plan.identityMapping,
        );

        expect(
          resumed.candidates.map(
            (candidate) =>
              candidate.recordId,
          ),
        ).toEqual(
          plan.mappings.map(
            (mapping) =>
              mapping.recordId,
          ),
        );

        expect(
          store.saves,
        ).toBe(
          1,
        );
      },
    );
  },
);
