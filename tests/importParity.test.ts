/**
 * Stage 8 parity: a dry-run import plan must account for every declared legacy
 * record and carry its facts across unchanged.
 *
 * These assertions are deliberately about the *plan*, not about a materialized
 * import, so they hold read-only against the compatibility reader. Where a
 * property cannot be proven without a real import run, the checklist box stays
 * open rather than being argued shut here.
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
  type LegacyImportConversionPlan,
  type LegacyImportIdentityAllocator,
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

function allocator():
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

const PROJECT_ID =
  'alpha-project';
const PROJECT_NAME =
  'Alpha Project';
const PROJECT_DESCRIPTION =
  'A single-line project description';
const PROJECT_CREATED_AT =
  '2026-01-02T03:04:05.000Z';

const TASK_ID =
  'alpha-task';
const TASK_NAME =
  'Alpha Task';
const TASK_DESCRIPTION =
  'A single-line task description';
const TASK_CREATED_AT =
  '2026-01-05T06:07:08.000Z';
const TASK_START =
  '2026-02-03T00:00:00.000Z';
const TASK_DEADLINE =
  '2026-02-10T00:00:00.000Z';

const EVENT_ID =
  'alpha-event';
const EVENT_NAME =
  'Alpha Event';
const EVENT_DESCRIPTION =
  'A single-line event description';
const EVENT_START =
  '2026-03-01T10:00:00.000Z';
const EVENT_DEADLINE =
  '2026-03-01T11:00:00.000Z';

const PROJECT_PATH =
  'Proxima/projects/alpha.md';
const TASK_PATH =
  'Proxima/tasks/alpha.md';
const EVENT_PATH =
  'Proxima/events/alpha.md';

/** The same instant, normalised, so a format change cannot fail a parity claim. */
function instant(
  value:
    string,
): string {
  return new Date(
    value,
  ).toISOString();
}

/**
 * One declared record per kind, every supported field set explicitly, so a
 * dropped field shows up as a parity failure rather than as absence nobody
 * notices.
 */
async function parityPlan():
  Promise<
    LegacyImportPlan
  > {
  return planLegacyMarkdownImport(
    createMemoryVault({
      [PROJECT_PATH]: [
        '---',
        `id: ${PROJECT_ID}`,
        'type: project',
        `name: ${PROJECT_NAME}`,
        `description: ${PROJECT_DESCRIPTION}`,
        'status: archived',
        `createdAt: ${PROJECT_CREATED_AT}`,
        '---',
        '',
      ].join(
        '\n',
      ),

      [TASK_PATH]: [
        '---',
        `id: ${TASK_ID}`,
        `name: ${TASK_NAME}`,
        `description: ${TASK_DESCRIPTION}`,
        `project: ${PROJECT_ID}`,
        'status: running',
        'weight: 3',
        'isFixedDuration: true',
        'fixedDuration: 90',
        'maxDuration: 120',
        'isCompleted: true',
        `startDate: ${TASK_START}`,
        `deadline: ${TASK_DEADLINE}`,
        `createdAt: ${TASK_CREATED_AT}`,
        '---',
        '',
      ].join(
        '\n',
      ),

      [EVENT_PATH]: [
        '---',
        `id: ${EVENT_ID}`,
        `name: ${EVENT_NAME}`,
        `description: ${EVENT_DESCRIPTION}`,
        `projectId: ${PROJECT_ID}`,
        `startDate: ${EVENT_START}`,
        `deadline: ${EVENT_DEADLINE}`,
        '---',
        '',
      ].join(
        '\n',
      ),
    }),
    allocator(),
  );
}

/**
 * The single conversion of one kind, narrowed to that kind so the parity claims
 * below read the fields the kind actually owns.
 */
function conversionOf<
  Kind extends
    'project'
    | 'task'
    | 'event',
>(
  plan:
    LegacyImportPlan,
  kind:
    Kind,
): Extract<
  LegacyImportConversionPlan,
  {
    kind:
      Kind;
  }
> {
  const found =
    plan.conversions.filter(
      (
        conversion,
      ): conversion is Extract<
        LegacyImportConversionPlan,
        {
          kind:
            Kind;
        }
      > =>
        conversion.kind
        === kind,
    );

  expect(
    found,
  ).toHaveLength(
    1,
  );

  return found[0]!;
}

describe(
  'Stage 8 import plan parity against the declared legacy records',
  () => {
    it(
      'accounts for every valid physical record of each kind, with no candidate disappearing unexplained',
      async () => {
        const plan =
          await parityPlan();

        for (
          const kind
          of [
            'project',
            'task',
            'event',
          ] as const
        ) {
          const kindCensus =
            plan.census[kind];

          // The directory was actually traversed, so "nothing found" is a
          // finding rather than a failure to look.
          expect(
            kindCensus.status,
          ).toBe(
            'complete',
          );

          expect(
            kindCensus.loadedRecords,
          ).toBe(
            1,
          );

          // Every accepted candidate either became a record or was refused for a
          // stated reason. A nonzero value here is a record vanishing silently.
          expect(
            kindCensus.unaccountedCandidates,
          ).toBe(
            0,
          );

          expect(
            kindCensus.loadedRecords
            + kindCensus
              .explicitlyRejected,
          ).toBe(
            kindCensus.recordCandidates,
          );

          // The plan's counts agree with the census it was built from.
          expect(
            plan.counts[`${kind}s`],
          ).toBe(
            kindCensus.loadedRecords,
          );

          expect(
            plan.conversions.filter(
              (conversion) =>
                conversion.kind
                === kind,
            ),
          ).toHaveLength(
            plan.counts[`${kind}s`],
          );
        }

        expect(
          plan.census.project
            .unaccountedCandidates
          + plan.census.task
            .unaccountedCandidates
          + plan.census.event
            .unaccountedCandidates,
        ).toBe(
          0,
        );
      },
    );

    it(
      'gives every imported source an explicit disposition',
      async () => {
        const plan =
          await parityPlan();

        const declared:
          string[] = [
            PROJECT_PATH,
            TASK_PATH,
            EVENT_PATH,
          ];

        const mapped =
          new Set(
            plan.identityMapping
              .entries
              .map(
                (entry) =>
                  entry.sourcePath,
              ),
          );

        const refused =
          new Set(
            plan.problems.map(
              (problem) =>
                problem.sourcePath,
            ),
          );

        for (
          const path
          of declared
        ) {
          const dispositioned =
            mapped.has(
              path,
            )
            || refused.has(
              path,
            );

          expect(
            dispositioned,
            `no disposition for ${path}`,
          ).toBe(
            true,
          );
        }

        // Every conversion is traceable to the source file it came from.
        for (
          const conversion
          of plan.conversions
        ) {
          expect(
            declared,
          ).toContain(
            conversion.sourcePath,
          );
        }
      },
    );

    it(
      'preserves names, descriptions and dates',
      async () => {
        const plan =
          await parityPlan();

        const project =
          conversionOf(
            plan,
            'project',
          );

        const task =
          conversionOf(
            plan,
            'task',
          );

        const event =
          conversionOf(
            plan,
            'event',
          );

        expect(
          project.name,
        ).toBe(
          PROJECT_NAME,
        );

        expect(
          project.description,
        ).toBe(
          PROJECT_DESCRIPTION,
        );

        expect(
          instant(
            project.createdAt,
          ),
        ).toBe(
          instant(
            PROJECT_CREATED_AT,
          ),
        );

        expect(
          task.name,
        ).toBe(
          TASK_NAME,
        );

        expect(
          task.description,
        ).toBe(
          TASK_DESCRIPTION,
        );

        expect(
          instant(
            task.createdAt,
          ),
        ).toBe(
          instant(
            TASK_CREATED_AT,
          ),
        );

        expect(
          instant(
            task.startDate
            ?? '',
          ),
        ).toBe(
          instant(
            TASK_START,
          ),
        );

        expect(
          instant(
            task.deadline
            ?? '',
          ),
        ).toBe(
          instant(
            TASK_DEADLINE,
          ),
        );

        expect(
          event.name,
        ).toBe(
          EVENT_NAME,
        );

        expect(
          event.description,
        ).toBe(
          EVENT_DESCRIPTION,
        );

        expect(
          instant(
            event.startDate,
          ),
        ).toBe(
          instant(
            EVENT_START,
          ),
        );

        expect(
          instant(
            event.deadline,
          ),
        ).toBe(
          instant(
            EVENT_DEADLINE,
          ),
        );
      },
    );

    it(
      'preserves task weight and durations',
      async () => {
        const plan =
          await parityPlan();

        const task =
          conversionOf(
            plan,
            'task',
          );

        expect(
          task.weight,
        ).toBe(
          3,
        );

        expect(
          task.isFixedDuration,
        ).toBe(
          true,
        );

        expect(
          task.fixedDuration,
        ).toBe(
          90,
        );

        expect(
          task.maxDuration,
        ).toBe(
          120,
        );
      },
    );

    it(
      'maps project associations to canonical identities instead of leaving them implicit',
      async () => {
        const plan =
          await parityPlan();

        const project =
          conversionOf(
            plan,
            'project',
          );

        const task =
          conversionOf(
            plan,
            'task',
          );

        const event =
          conversionOf(
            plan,
            'event',
          );

        // The task's workflow stage names the project record, and its workflow
        // order scope follows the same identity.
        expect(
          task.workflowStage,
        ).toMatchObject({
          resolution:
            'candidate',
          projectRecordId:
            project.recordId,
        });

        expect(
          task.scopedOrders
            .workflow
            ?.scope,
        ).toMatchObject({
          projectRecordId:
            project.recordId,
        });

        expect(
          event.project,
        ).toMatchObject({
          resolution:
            'resolved',
          projectRecordId:
            project.recordId,
        });

        // Both references resolved from the declared legacy project id, and the
        // plan records that provenance.
        for (
          const reference
          of plan.projectReferences
        ) {
          expect(
            reference.legacyProjectId,
          ).toBe(
            PROJECT_ID,
          );

          expect(
            reference.resolution,
          ).toBe(
            'resolved',
          );

          expect(
            reference.projectRecordId,
          ).toBe(
            project.recordId,
          );
        }

        expect(
          plan.counts
            .unresolvedProjectReferences,
        ).toBe(
          0,
        );
      },
    );

    it(
      'keeps recurrence explicit rather than silently absent',
      async () => {
        const plan =
          await parityPlan();

        // Recurrence is not representable in this slice, so every conversion
        // must say so with an explicit typed null. An omitted key would read as
        // "no recurrence" by accident rather than by decision.
        for (
          const conversion
          of plan.conversions
        ) {
          if (
            conversion.kind
            === 'project'
          ) {
            continue;
          }

          expect(
            Object.prototype
              .hasOwnProperty
              .call(
                conversion,
                'recurrence',
              ),
          ).toBe(
            true,
          );

          expect(
            conversion.recurrence,
          ).toBeNull();
        }
      },
    );

    it(
      'preserves archived and completed state',
      async () => {
        const plan =
          await parityPlan();

        const project =
          conversionOf(
            plan,
            'project',
          );

        const task =
          conversionOf(
            plan,
            'task',
          );

        expect(
          project.status,
        ).toBe(
          'archived',
        );

        expect(
          task.isCompleted,
        ).toBe(
          true,
        );

        // Completion is state, not a deletion: the record is still planned.
        expect(
          task.executionState,
        ).toBeDefined();
      },
    );

    it(
      'treats legacy projectType as compatibility metadata rather than a capability silo',
      async () => {
        const plan =
          await parityPlan();

        const project =
          conversionOf(
            plan,
            'project',
          );

        expect(
          project.disposition,
        ).toBe(
          'compatibility-import-metadata-only',
        );

        expect(
          project
            .canonicalCapabilityAuthority,
        ).toBe(
          'associated-data-and-workspace',
        );

        // Every kind survives planning: the project's legacy type does not
        // filter the tasks or events that hang off it.
        expect(
          plan.counts.projects,
        ).toBe(
          1,
        );

        expect(
          plan.counts.tasks,
        ).toBe(
          1,
        );

        expect(
          plan.counts.events,
        ).toBe(
          1,
        );
      },
    );

    it(
      'never derives record identity from the record title',
      async () => {
        const plan =
          await parityPlan();

        const opaquePattern =
          /^pxr_[0-9a-f]{32}$/;

        for (
          const conversion
          of plan.conversions
        ) {
          expect(
            conversion.recordId,
          ).toMatch(
            opaquePattern,
          );

          expect(
            conversion
              .recordId
              .includes(
                conversion.name,
              ),
          ).toBe(
            false,
          );

          // The legacy filename is carried as provenance beside the identity,
          // never as the identity.
          expect(
            conversion.sourcePath,
          ).toContain(
            '.md',
          );
        }

        // Two records that share a title still receive different identities,
        // which is the property that makes identity independent of the title.
        const sameTitle =
          await planLegacyMarkdownImport(
            createMemoryVault({
              'Proxima/projects/one.md': [
                '---',
                'id: twin-one',
                'type: project',
                'name: Shared Title',
                '---',
                '',
              ].join(
                '\n',
              ),

              'Proxima/projects/two.md': [
                '---',
                'id: twin-two',
                'type: project',
                'name: Shared Title',
                '---',
                '',
              ].join(
                '\n',
              ),
            }),
            allocator(),
          );

        const twins =
          sameTitle.conversions;

        expect(
          twins,
        ).toHaveLength(
          2,
        );

        expect(
          twins[0]!.name,
        ).toBe(
          twins[1]!.name,
        );

        expect(
          twins[0]!.recordId,
        ).not.toBe(
          twins[1]!.recordId,
        );

        for (
          const twin
          of twins
        ) {
          expect(
            twin.recordId,
          ).toMatch(
            opaquePattern,
          );
        }
      },
    );
  },
);
