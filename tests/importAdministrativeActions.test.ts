import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import {
  createLegacyImportAdministrativeActions,
  parseLegacyImportAdministrativeAction,
} from '../src/app/importAdministrativeActions.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
  type LegacyImportPlan,
} from '../src/app/importPlanner.js';
import type {
  LegacyImportVerificationKindCounts,
  LegacyImportVerificationResult,
} from '../src/app/importVerification.js';

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

async function oneProjectPlan():
  Promise<
    LegacyImportPlan
  > {
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
    allocator(),
  );
}

function countsFor(
  plan:
    LegacyImportPlan,
  kind:
    'project'
    | 'task'
    | 'event',
  blocked:
    boolean,
): LegacyImportVerificationKindCounts {
  const planned =
    plan.conversions
      .filter(
        (conversion) =>
          conversion.kind
          === kind,
      )
      .length;

  return {
    planned,
    stagedVerified:
      blocked
        ? 0
        : planned,
    blocked:
      blocked
        ? planned
        : 0,
    accounted:
      planned,
  };
}

function verificationFor(
  plan:
    LegacyImportPlan,
  verdict:
    'verified'
    | 'blocked',
): LegacyImportVerificationResult {
  const blocked =
    verdict
    === 'blocked';

  const projects =
    countsFor(
      plan,
      'project',
      blocked,
    );

  const tasks =
    countsFor(
      plan,
      'task',
      blocked,
    );

  const events =
    countsFor(
      plan,
      'event',
      blocked,
    );

  const total:
    LegacyImportVerificationKindCounts = {
      planned:
        projects.planned
        + tasks.planned
        + events.planned,
      stagedVerified:
        projects.stagedVerified
        + tasks.stagedVerified
        + events.stagedVerified,
      blocked:
        projects.blocked
        + tasks.blocked
        + events.blocked,
      accounted:
        projects.accounted
        + tasks.accounted
        + events.accounted,
    };

  return {
    schemaVersion:
      1,
    mode:
      'verification',
    source:
      'legacy-import-plan-and-staging-results',
    verdict,
    dispositions:
      plan.conversions.map(
        (conversion) => ({
          kind:
            conversion.kind,
          recordId:
            conversion.recordId,
          sourcePath:
            conversion.sourcePath,
          disposition:
            blocked
              ? 'blocked'
              : 'staged-verified',
          blockerReason:
            blocked
              ? 'synthetic-blocker'
              : null,
        }),
      ),
    counts: {
      projects,
      tasks,
      events,
      total,
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
  };
}

describe(
  'Stage 8 slice 18 read-only import administrative actions',
  () => {
    it(
      'parses exactly the five administrative action names and refuses premature payload shapes',
      () => {
        for (
          const type
          of [
            'import.plan',
            'import.inspect',
            'import.status',
            'import.resolve',
            'import.commit',
          ] as const
        ) {
          expect(
            parseLegacyImportAdministrativeAction({
              type,
            }),
          ).toEqual({
            ok:
              true,
            action: {
              type,
            },
          });
        }

        expect(
          parseLegacyImportAdministrativeAction({
            type:
              'import.unknown',
          }),
        ).toMatchObject({
          ok:
            false,
          error: {
            code:
              'invalid-action',
          },
        });

        expect(
          parseLegacyImportAdministrativeAction({
            type:
              'import.resolve',
            mapping: {
              old:
                'new',
            },
          }),
        ).toMatchObject({
          ok:
            false,
          error: {
            code:
              'invalid-action-input',
          },
        });
      },
    );

    it(
      'runs the accepted dry-run planner programmatically and exposes planned status without authorizing durable writes',
      async () => {
        const plan =
          await oneProjectPlan();

        let plannerCalls =
          0;

        let inspectorCalls =
          0;

        const actions =
          createLegacyImportAdministrativeActions({
            async plan() {
              plannerCalls +=
                1;

              return plan;
            },

            async inspect() {
              inspectorCalls +=
                1;

              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        const before =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(before)
          .toMatchObject({
            ok:
              true,
            actionType:
              'import.status',
            outcome:
              'accepted',
            durableChange:
              false,
            data: {
              kind:
                'status',
              status: {
                phase:
                  'not-planned',
                liveWritesAuthorized:
                  false,
              },
            },
          });

        const planned =
          await actions.dispatch({
            type:
              'import.plan',
          });

        expect(planned)
          .toMatchObject({
            ok:
              true,
            actionType:
              'import.plan',
            outcome:
              'accepted',
            durableChange:
              false,
            data: {
              kind:
                'plan',
              plan: {
                mode:
                  'dry-run',
                writes: {
                  legacyMarkdown:
                    0,
                  recordStore:
                    0,
                  staging:
                    0,
                },
              },
            },
          });

        expect(
          plannerCalls,
        ).toBe(
          1,
        );

        expect(
          inspectorCalls,
        ).toBe(
          0,
        );

        const status =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(status)
          .toMatchObject({
            ok:
              true,
            data: {
              kind:
                'status',
              status: {
                phase:
                  'planned',
                plannedPhysicalRecords:
                  1,
                verifiedPhysicalRecords:
                  0,
                blockedPhysicalRecords:
                  0,
                liveWritesAuthorized:
                  false,
              },
            },
          });
      },
    );

    it(
      'refuses import.inspect before a successful import.plan and does not call the inspector dependency',
      async () => {
        let inspectorCalls =
          0;

        const actions =
          createLegacyImportAdministrativeActions({
            plan:
              oneProjectPlan,

            async inspect(
              plan,
            ) {
              inspectorCalls +=
                1;

              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        const result =
          await actions.dispatch({
            type:
              'import.inspect',
          });

        expect(result)
          .toMatchObject({
            ok:
              false,
            actionType:
              'import.inspect',
            outcome:
              'unavailable',
            durableChange:
              false,
            error: {
              code:
                'action-not-available',
            },
          });

        expect(
          inspectorCalls,
        ).toBe(
          0,
        );
      },
    );

    it(
      'runs read-only inspection after planning and reports verified status while preserving every deferred migration check',
      async () => {
        const plan =
          await oneProjectPlan();

        const actions =
          createLegacyImportAdministrativeActions({
            async plan() {
              return plan;
            },

            async inspect(
              acceptedPlan,
            ) {
              expect(
                acceptedPlan,
              ).toBe(
                plan,
              );

              return verificationFor(
                acceptedPlan,
                'verified',
              );
            },
          });

        await actions.dispatch({
          type:
            'import.plan',
        });

        const inspected =
          await actions.dispatch({
            type:
              'import.inspect',
          });

        expect(inspected)
          .toMatchObject({
            ok:
              true,
            actionType:
              'import.inspect',
            outcome:
              'accepted',
            durableChange:
              false,
            data: {
              kind:
                'inspection',
              verification: {
                verdict:
                  'verified',
                verifierWrites: {
                  legacyMarkdown:
                    0,
                  staging:
                    0,
                  recordStore:
                    0,
                  externalArtifacts:
                    0,
                  activation:
                    0,
                },
              },
            },
          });

        const status =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(status)
          .toMatchObject({
            ok:
              true,
            data: {
              kind:
                'status',
              status: {
                phase:
                  'verified',
                verificationVerdict:
                  'verified',
                plannedPhysicalRecords:
                  1,
                verifiedPhysicalRecords:
                  1,
                blockedPhysicalRecords:
                  0,
                deferredChecks: [
                  'unsupported-frontmatter-importability',
                  'recurrence-migration',
                  'event-all-day-intent',
                ],
                liveWritesAuthorized:
                  false,
              },
            },
          });
      },
    );

    it(
      'reports blocked inspection as blocked administrative status rather than success by omission',
      async () => {
        const plan =
          await oneProjectPlan();

        const actions =
          createLegacyImportAdministrativeActions({
          async plan() {
            return plan;
          },

          async inspect(
            acceptedPlan,
          ) {
            return verificationFor(
              acceptedPlan,
              'blocked',
            );
          },
        });

        await actions.dispatch({
          type:
            'import.plan',
        });

        const inspected =
          await actions.dispatch({
            type:
              'import.inspect',
          });

        expect(inspected)
          .toMatchObject({
            ok:
              true,
            data: {
              kind:
                'inspection',
              verification: {
                verdict:
                  'blocked',
              },
            },
          });

        const status =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(status)
          .toMatchObject({
            ok:
              true,
            data: {
              kind:
                'status',
              status: {
                phase:
                  'blocked',
                verificationVerdict:
                  'blocked',
                plannedPhysicalRecords:
                  1,
                verifiedPhysicalRecords:
                  0,
                blockedPhysicalRecords:
                  1,
                liveWritesAuthorized:
                  false,
              },
            },
          });
      },
    );

    it(
      'rejects planner evidence that escapes the accepted zero-write dry-run contract',
      async () => {
        const safe =
          await oneProjectPlan();

        const unsafe =
          {
            ...safe,
            writes: {
              ...safe.writes,
              staging:
                1,
            },
          } as unknown as LegacyImportPlan;

        const actions =
          createLegacyImportAdministrativeActions({
            async plan() {
              return unsafe;
            },

            async inspect(
              acceptedPlan,
            ) {
              return verificationFor(
                acceptedPlan,
                'verified',
              );
            },
          });

        const result =
          await actions.dispatch({
            type:
              'import.plan',
          });

        expect(result)
          .toMatchObject({
            ok:
              false,
            outcome:
              'invalid-evidence',
            error: {
              code:
                'invalid-evidence',
            },
          });

        const status =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(status)
          .toMatchObject({
            ok:
              true,
            data: {
              status: {
                phase:
                  'not-planned',
              },
            },
          });
      },
    );

    it(
      'rejects inspection evidence that claims a write or silently drops an open migration check',
      async () => {
        const plan =
          await oneProjectPlan();

        const unsafe =
          {
            ...verificationFor(
              plan,
              'verified',
            ),
            deferredChecks: [
              'recurrence-migration',
              'event-all-day-intent',
            ],
            verifierWrites: {
              legacyMarkdown:
                0,
              staging:
                0,
              recordStore:
                0,
              externalArtifacts:
                0,
              activation:
                1,
            },
          } as unknown as LegacyImportVerificationResult;

        const actions =
          createLegacyImportAdministrativeActions({
            async plan() {
              return plan;
            },

            async inspect() {
              return unsafe;
            },
          });

        await actions.dispatch({
          type:
            'import.plan',
        });

        const result =
          await actions.dispatch({
            type:
              'import.inspect',
          });

        expect(result)
          .toMatchObject({
            ok:
              false,
            outcome:
              'invalid-evidence',
            error: {
              code:
                'invalid-evidence',
              deferredChecks: [
                'unsupported-frontmatter-importability',
                'recurrence-migration',
                'event-all-day-intent',
              ],
            },
          });

        const status =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(status)
          .toMatchObject({
            ok:
              true,
            data: {
              status: {
                phase:
                  'planned',
                verificationVerdict:
                  null,
              },
            },
          });
      },
    );

    it(
      'recognizes import.resolve and import.commit as typed unavailable actions without invoking planning or inspection',
      async () => {
        let plannerCalls =
          0;

        let inspectorCalls =
          0;

        const actions =
          createLegacyImportAdministrativeActions({
            async plan() {
              plannerCalls +=
                1;

              return oneProjectPlan();
            },

            async inspect(
              plan,
            ) {
              inspectorCalls +=
                1;

              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        for (
          const type
          of [
            'import.resolve',
            'import.commit',
          ] as const
        ) {
          const result =
            await actions.dispatch({
              type,
            });

          expect(result)
            .toMatchObject({
              ok:
                false,
              actionType:
                type,
              outcome:
                'unavailable',
              durableChange:
                false,
              error: {
                code:
                  'action-not-available',
                deferredChecks: [
                  'unsupported-frontmatter-importability',
                  'recurrence-migration',
                  'event-all-day-intent',
                ],
              },
            });
        }

        expect(
          plannerCalls,
        ).toBe(
          0,
        );

        expect(
          inspectorCalls,
        ).toBe(
          0,
        );
      },
    );
  },
);
