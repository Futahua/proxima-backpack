/**
 * Stage 8 identity idempotence: planning the same vault twice must assign the
 * same canonical identities, so a re-run or a resume cannot mint a second
 * record for a source that already has one.
 *
 * The proof rests on giving every run a *different* allocation range. If the
 * planner re-derived an identity instead of reusing the durable mapping, the
 * ids would differ and these assertions would fail; a shared counter would have
 * hidden exactly that mistake.
 */

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
  readLegacyImportIdentityMapping,
  writeLegacyImportIdentityMapping,
  type LegacyImportIdentityAllocator,
  type LegacyImportIdentityMappingManifest,
  type LegacyImportIdentityMappingStore,
  type LegacyImportPlan,
} from '../src/app/importPlanner.js';

function opaque(
  value:
    number,
): string {
  return `pxr_${value
    .toString(
      16,
    )
    .padStart(
      32,
      '0',
    )}`;
}

/** An allocator whose counter starts where told, so reuse cannot hide behind a shared sequence. */
function allocatorFrom(
  start:
    number,
): LegacyImportIdentityAllocator {
  let next =
    start;

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

/**
 * The planner's persistence boundary without a filesystem. A production store
 * must resolve `save` only after the manifest is durable; for this proof it is
 * enough that what was saved is what a later load returns.
 */
function durableStore():
  LegacyImportIdentityMappingStore
  & {
    current():
      LegacyImportIdentityMappingManifest | null;
  } {
  let held:
    LegacyImportIdentityMappingManifest | null =
      null;

  return {
    async load() {
      return held;
    },

    async save(
      mapping,
    ) {
      held =
        mapping;
    },

    current() {
      return held;
    },
  };
}

const FILES = {
  'Proxima/projects/alpha.md': [
    '---',
    'id: alpha',
    'type: project',
    'name: Alpha Project',
    'description: A project',
    'status: active',
    'createdAt: 2026-01-02T03:04:05.000Z',
    '---',
    '',
  ].join(
    '\n',
  ),

  'Proxima/tasks/one.md': [
    '---',
    'id: task-one',
    'name: Task One',
    'description: First task',
    'project: alpha',
    'status: running',
    'weight: 2',
    '---',
    '',
  ].join(
    '\n',
  ),

  'Proxima/tasks/two.md': [
    '---',
    'id: task-two',
    'name: Task Two',
    'description: Second task',
    'project: alpha',
    'status: backlog',
    'weight: 1',
    '---',
    '',
  ].join(
    '\n',
  ),

  'Proxima/events/one.md': [
    '---',
    'id: event-one',
    'name: Event One',
    'description: An event',
    'projectId: alpha',
    'startDate: 2026-03-01T10:00:00.000Z',
    'deadline: 2026-03-01T11:00:00.000Z',
    '---',
    '',
  ].join(
    '\n',
  ),
};

/** Two physical project records competing for one legacy alias. */
const DUPLICATE_FILES = {
  'Proxima/projects/a.md': [
    '---',
    'id: shared-project',
    'type: project',
    'name: Shared A',
    '---',
    '',
  ].join(
    '\n',
  ),

  'Proxima/projects/b.md': [
    '---',
    'id: shared-project',
    'type: project',
    'name: Shared B',
    '---',
    '',
  ].join(
    '\n',
  ),

  'Proxima/tasks/ref.md': [
    '---',
    'id: task-ref',
    'name: References the alias',
    'project: shared-project',
    'status: running',
    '---',
    '',
  ].join(
    '\n',
  ),
};

/** The durable facts of an assignment, order-independent. */
function identities(
  plan:
    LegacyImportPlan,
) {
  return [
    ...plan
      .identityMapping
      .entries,
  ]
    .map(
      (entry) => ({
        kind:
          entry.kind,
        sourcePath:
          entry.sourcePath,
        legacyId:
          entry.legacyId,
        recordId:
          entry.recordId,
      }),
    )
    .sort(
      (left, right) =>
        left.sourcePath
          .localeCompare(
            right.sourcePath,
          ),
    );
}

/**
 * No source may hold two identities, and no identity may be held by two
 * records — the duplicate that a broken resume would create.
 */
function assertOneIdentityPerRecord(
  plan:
    LegacyImportPlan,
): void {
  const mapped =
    plan.identityMapping
      .entries
      .map(
        (entry) =>
          entry.recordId,
      );

  expect(
    new Set(
      mapped,
    ).size,
  ).toBe(
    mapped.length,
  );

  const converted =
    plan.conversions.map(
      (conversion) =>
        conversion.recordId,
    );

  expect(
    new Set(
      converted,
    ).size,
  ).toBe(
    converted.length,
  );

  // Every conversion's identity is one the durable manifest also records, so a
  // resume has something to reuse.
  for (
    const recordId
    of converted
  ) {
    expect(
      mapped,
    ).toContain(
      recordId,
    );
  }
}

describe(
  'Stage 8 import identity idempotence',
  () => {
    it(
      're-plans the same vault to the same identities even when the allocator would hand out different ones',
      async () => {
        const first =
          await planLegacyMarkdownImport(
            createMemoryVault(
              FILES,
            ),
            allocatorFrom(
              1,
            ),
          );

        const second =
          await planLegacyMarkdownImport(
            createMemoryVault(
              FILES,
            ),
            allocatorFrom(
              1000,
            ),
            {},
            first
              .identityMapping,
          );

        expect(
          second
            .identityMapping
            .schemaVersion,
        ).toBe(
          first
            .identityMapping
            .schemaVersion,
        );

        expect(
          identities(
            second,
          ),
        ).toEqual(
          identities(
            first,
          ),
        );

        // The conversions carry the reused identities too, not just the manifest.
        expect(
          second.conversions
            .map(
              (conversion) =>
                conversion.recordId,
            )
            .sort(),
        ).toEqual(
          first.conversions
            .map(
              (conversion) =>
                conversion.recordId,
            )
            .sort(),
        );

        assertOneIdentityPerRecord(
          second,
        );
      },
    );

    it(
      'resumes an interrupted import from the durable mapping without producing duplicate records',
      async () => {
        const store =
          durableStore();

        // First attempt: plan, then persist the mapping — the only thing that
        // survives a run that stops before finishing.
        const interrupted =
          await planLegacyMarkdownImport(
            createMemoryVault(
              FILES,
            ),
            allocatorFrom(
              1,
            ),
          );

        await writeLegacyImportIdentityMapping(
          store,
          interrupted
            .identityMapping,
        );

        expect(
          store.current(),
        ).not.toBeNull();

        // Resume: nothing survives but the stored manifest and a fresh allocator
        // in a completely different range.
        const resumed =
          await planLegacyMarkdownImport(
            createMemoryVault(
              FILES,
            ),
            allocatorFrom(
              500,
            ),
            {},
            await readLegacyImportIdentityMapping(
              store,
            ),
          );

        expect(
          identities(
            resumed,
          ),
        ).toEqual(
          identities(
            interrupted,
          ),
        );

        assertOneIdentityPerRecord(
          resumed,
        );

        // A third pass from the resumed manifest is stable: assignment has
        // reached a fixed point rather than drifting once per run.
        const again =
          await planLegacyMarkdownImport(
            createMemoryVault(
              FILES,
            ),
            allocatorFrom(
              900,
            ),
            {},
            resumed
              .identityMapping,
          );

        expect(
          identities(
            again,
          ),
        ).toEqual(
          identities(
            interrupted,
          ),
        );

        assertOneIdentityPerRecord(
          again,
        );
      },
    );

    it(
      'keeps identities stable across a re-plan when a legacy alias is duplicated',
      async () => {
        const first =
          await planLegacyMarkdownImport(
            createMemoryVault(
              DUPLICATE_FILES,
            ),
            allocatorFrom(
              1,
            ),
          );

        const second =
          await planLegacyMarkdownImport(
            createMemoryVault(
              DUPLICATE_FILES,
            ),
            allocatorFrom(
              1000,
            ),
            {},
            first
              .identityMapping,
          );

        expect(
          identities(
            second,
          ),
        ).toEqual(
          identities(
            first,
          ),
        );

        // Both physical records keep their own identity, so the collision is
        // still represented rather than collapsed by the second run.
        expect(
          first
            .identityMapping
            .entries,
        ).toHaveLength(
          3,
        );

        assertOneIdentityPerRecord(
          second,
        );
      },
    );
  },
);
