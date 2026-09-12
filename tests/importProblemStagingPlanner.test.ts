import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import {
  DIAGNOSTIC_LIMITS,
} from '../src/app/diagnostics.js';
import {
  materializeLegacyImportProblemEvidence,
  type LegacyImportProblemStagingManifest,
  type LegacyImportProblemStagingStore,
} from '../src/app/importProblemStagingPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
  type LegacyImportPlan,
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

class MemoryProblemStagingStore
implements LegacyImportProblemStagingStore {
  readonly authority =
    'legacy-import-staging-metadata-only' as const;

  private manifest:
    LegacyImportProblemStagingManifest | null;

  saves =
    0;

  failNextSave =
    false;

  constructor(
    initial:
      LegacyImportProblemStagingManifest | null =
        null,
  ) {
    this.manifest =
      initial === null
        ? null
        : JSON.parse(
            JSON.stringify(
              initial,
            ),
          ) as LegacyImportProblemStagingManifest;
  }

  async load():
    Promise<
      LegacyImportProblemStagingManifest | null
    > {
    return this.manifest
      === null
      ? null
      : JSON.parse(
          JSON.stringify(
            this.manifest,
          ),
        ) as LegacyImportProblemStagingManifest;
  }

  async save(
    manifest:
      LegacyImportProblemStagingManifest,
  ): Promise<void> {
    if (
      this.failNextSave
    ) {
      this.failNextSave =
        false;

      throw new Error(
        'injected import-problem metadata interruption',
      );
    }

    this.manifest =
      JSON.parse(
        JSON.stringify(
          manifest,
        ),
      ) as LegacyImportProblemStagingManifest;

    this.saves +=
      1;
  }

  snapshot():
    LegacyImportProblemStagingManifest | null {
    return this.manifest
      === null
      ? null
      : JSON.parse(
          JSON.stringify(
            this.manifest,
          ),
        ) as LegacyImportProblemStagingManifest;
  }
}

async function malformedAndUnsupportedPlan() {
  const files = {
    'Proxima/tasks/malformed.md': [
      '---',
      'id: malformed-task',
      'name: "unterminated',
      '---',
      'Body remains legacy source.',
      '',
    ].join(
      '\n',
    ),

    'Proxima/tasks/unsupported.md': [
      '---',
      'id: unsupported-task',
      'description: |',
      '  multiline value',
      '---',
      'Readable body.',
      '',
    ].join(
      '\n',
    ),

    'Proxima/tasks/valid.md': [
      '---',
      'id: valid-task',
      'name: Valid',
      '---',
      '',
    ].join(
      '\n',
    ),
  };

  const vault =
    createMemoryVault(
      files,
    );

  const paths =
    Object.keys(
      files,
    ).sort();

  const before =
    await Promise.all(
      paths.map(
        (path) =>
          vault.read(
            path,
          ),
      ),
    );

  const plan =
    await planLegacyMarkdownImport(
      vault,
      sequentialAllocator(),
    );

  return {
    vault,
    paths,
    before,
    plan,
  };
}

describe(
  'Stage 8 slice 12 malformed-record staging evidence',
  () => {
    it(
      'persists malformed parse evidence as an unresolved record, reports unsupported frontmatter without resolving it, creates no canonical payload, and leaves source bytes unchanged',
      async () => {
        const input =
          await malformedAndUnsupportedPlan();

        const store =
          new MemoryProblemStagingStore();

        const result =
          await materializeLegacyImportProblemEvidence(
            input.plan,
            store,
          );

        const after =
          await Promise.all(
            input.paths.map(
              (path) =>
                input.vault.read(
                  path,
                ),
            ),
          );

        expect(after)
          .toEqual(
            input.before,
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'staging-materialization',
            source:
              'legacy-import-problem-plan',
            scope:
              'import-problem-evidence-only',
            payloadMaterialization:
              'not-performed',
            activation:
              'not-performed',
            manifestOutcome:
              'created',
            manifest: {
              counts: {
                unresolvedRecordCount: 1,
                malformedProblems: 1,
                unsupportedFrontmatterReportedRecords: 1,
                unsupportedFrontmatterProblems: 1,
              },
            },
            writes: {
              legacyMarkdown: 0,
              recordStore: 0,
              stagingRecords: 0,
              stagingProblemMetadata: 1,
              externalArtifacts: 0,
              activation: 0,
            },
          });

        const malformed =
          result.manifest
            .malformedRecords[0];

        expect(malformed)
          .toMatchObject({
            sourcePath:
              'Proxima/tasks/malformed.md',
            kind:
              'task',
            legacyId:
              'malformed-task',
            disposition:
              'unresolved-malformed-record',
            problems: [
              expect.objectContaining({
                code:
                  'frontmatter-parse-failure',
              }),
            ],
          });

        expect(
          malformed?.recordId,
        ).toBeDefined();

        expect(
          malformed?.sourceRevision,
        ).toBeDefined();

        const unsupported =
          result.manifest
            .unsupportedFrontmatter[0];

        expect(unsupported)
          .toMatchObject({
            sourcePath:
              'Proxima/tasks/unsupported.md',
            kind:
              'task',
            legacyId:
              'unsupported-task',
            disposition:
              'unsupported-frontmatter-reported',
            problems: [
              expect.objectContaining({
                code:
                  'unsupported-frontmatter',
              }),
            ],
          });

        expect(
          result.manifest
            .malformedRecords
            .some(
              (entry) =>
                entry.sourcePath
                === 'Proxima/tasks/valid.md',
            ),
        ).toBe(
          false,
        );
      },
    );

    it(
      'groups multiple malformed parse problems for one physical source under one unresolved record and bounds every diagnostic',
      async () => {
        const base =
          await planLegacyMarkdownImport(
            createMemoryVault({
              'Proxima/tasks/a.md': [
                '---',
                'id: a',
                '---',
                '',
              ].join(
                '\n',
              ),
            }),
            sequentialAllocator(),
          );

        const synthetic:
          LegacyImportPlan = {
            ...base,
            problems: [
              {
                code:
                  'frontmatter-parse-failure',
                severity:
                  'warning',
                sourcePath:
                  'Proxima/tasks/a.md',
                kind:
                  'task',
                legacyId:
                  'a',
                diagnostic:
                  'x'.repeat(
                    DIAGNOSTIC_LIMITS
                      .problemDetail
                    + 100,
                  ),
                disposition:
                  'reader-problem',
              },
              {
                code:
                  'frontmatter-parse-failure',
                severity:
                  'warning',
                sourcePath:
                  'Proxima/tasks/a.md',
                kind:
                  'task',
                legacyId:
                  'a',
                diagnostic:
                  'y'.repeat(
                    DIAGNOSTIC_LIMITS
                      .problemDetail
                    + 100,
                  ),
                disposition:
                  'reader-problem',
              },
            ],
            counts: {
              ...base.counts,
              readerProblems: 2,
              unsupportedFrontmatter: 0,
            },
          };

        const result =
          await materializeLegacyImportProblemEvidence(
            synthetic,
            new MemoryProblemStagingStore(),
          );

        expect(
          result.manifest
            .malformedRecords,
        ).toHaveLength(
          1,
        );

        expect(
          result.manifest
            .counts,
        ).toMatchObject({
          unresolvedRecordCount: 1,
          malformedProblems: 2,
        });

        expect(
          result.manifest
            .malformedRecords[0]
            ?.problems
            .map(
              (problem) =>
                problem
                  .diagnostic
                  .length,
            ),
        ).toEqual([
          DIAGNOSTIC_LIMITS
            .problemDetail,
          DIAGNOSTIC_LIMITS
            .problemDetail,
        ]);
      },
    );

    it(
      'does not silently promote unrelated compatibility warnings into malformed-record blockers',
      async () => {
        const base =
          await planLegacyMarkdownImport(
            createMemoryVault({
              'Proxima/tasks/a.md': [
                '---',
                'id: a',
                '---',
                '',
              ].join(
                '\n',
              ),
            }),
            sequentialAllocator(),
          );

        const synthetic:
          LegacyImportPlan = {
            ...base,
            problems: [
              {
                code:
                  'bad-date',
                severity:
                  'warning',
                sourcePath:
                  'Proxima/tasks/a.md',
                kind:
                  'task',
                legacyId:
                  'a',
                diagnostic:
                  'deadline: legacy date was not readable',
                disposition:
                  'reader-problem',
              },
            ],
            counts: {
              ...base.counts,
              readerProblems: 1,
              unsupportedFrontmatter: 0,
            },
          };

        const result =
          await materializeLegacyImportProblemEvidence(
            synthetic,
            new MemoryProblemStagingStore(),
          );

        expect(
          result.manifest
            .malformedRecords,
        ).toEqual([]);

        expect(
          result.manifest
            .unsupportedFrontmatter,
        ).toEqual([]);

        expect(
          result.manifest
            .counts,
        ).toEqual({
          unresolvedRecordCount: 0,
          malformedProblems: 0,
          unsupportedFrontmatterReportedRecords: 0,
          unsupportedFrontmatterProblems: 0,
        });

        expect(
          result.writes
            .stagingRecords,
        ).toBe(0);
      },
    );

    it(
      'reuses an identical staging problem manifest on rerun without a second metadata write',
      async () => {
        const input =
          await malformedAndUnsupportedPlan();

        const store =
          new MemoryProblemStagingStore();

        const first =
          await materializeLegacyImportProblemEvidence(
            input.plan,
            store,
          );

        const second =
          await materializeLegacyImportProblemEvidence(
            input.plan,
            store,
          );

        expect(
          first.manifestOutcome,
        ).toBe(
          'created',
        );

        expect(
          second.manifestOutcome,
        ).toBe(
          'reused-identical',
        );

        expect(
          second.manifest,
        ).toEqual(
          first.manifest,
        );

        expect(
          second.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          stagingRecords: 0,
          stagingProblemMetadata: 0,
          externalArtifacts: 0,
          activation: 0,
        });

        expect(
          store.saves,
        ).toBe(
          1,
        );
      },
    );

    it(
      'refuses conflicting staged problem evidence instead of overwriting it',
      async () => {
        const input =
          await malformedAndUnsupportedPlan();

        const firstStore =
          new MemoryProblemStagingStore();

        const first =
          await materializeLegacyImportProblemEvidence(
            input.plan,
            firstStore,
          );

        const malformed =
          first.manifest
            .malformedRecords[0];

        const problem =
          malformed
            ?.problems[0];

        if (
          malformed
          === undefined
          || problem
          === undefined
        ) {
          throw new Error(
            'Expected malformed staging evidence.',
          );
        }

        const conflicting:
          LegacyImportProblemStagingManifest = {
            ...first.manifest,
            malformedRecords: [
              {
                ...malformed,
                problems: [
                  {
                    ...problem,
                    diagnostic:
                      'different staged evidence',
                  },
                ],
              },
            ],
          };

        const store =
          new MemoryProblemStagingStore(
            conflicting,
          );

        await expect(
          materializeLegacyImportProblemEvidence(
            input.plan,
            store,
          ),
        ).rejects.toThrow(
          /conflicts with the current dry-run plan/,
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
      'retries the same problem manifest after an interrupted metadata save without losing unresolved evidence',
      async () => {
        const input =
          await malformedAndUnsupportedPlan();

        const store =
          new MemoryProblemStagingStore();

        store.failNextSave =
          true;

        await expect(
          materializeLegacyImportProblemEvidence(
            input.plan,
            store,
          ),
        ).rejects.toThrow(
          /injected import-problem metadata interruption/,
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
          await materializeLegacyImportProblemEvidence(
            input.plan,
            store,
          );

        expect(
          resumed.manifestOutcome,
        ).toBe(
          'created',
        );

        expect(
          resumed.manifest
            .counts,
        ).toMatchObject({
          unresolvedRecordCount: 1,
          unsupportedFrontmatterReportedRecords: 1,
        });

        expect(
          store.saves,
        ).toBe(
          1,
        );
      },
    );
  },
);
