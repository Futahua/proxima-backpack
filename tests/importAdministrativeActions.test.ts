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
  type LegacyImportProjectSelection,
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

/**
 * Two physical project records share one legacy project id, so the task and the
 * event that name it are both ambiguous. The selection is what Stage 8 slice 19
 * resolves; omitting it leaves both references exactly as the vault presents
 * them.
 */
async function ambiguousProjectPlan(
  selection:
    LegacyImportProjectSelection | null =
      null,
): Promise<
  LegacyImportPlan
> {
  return planLegacyMarkdownImport(
    createMemoryVault({
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
        'name: References duplicate project',
        'project: shared-project',
        'status: running',
        '---',
        '',
      ].join(
        '\n',
      ),

      'Proxima/events/ref-event.md': [
        '---',
        'id: event-ref',
        'name: References duplicate project',
        'projectId: shared-project',
        'startDate: 2026-09-12T10:00:00.000Z',
        'deadline: 2026-09-12T11:00:00.000Z',
        '---',
        '',
      ].join(
        '\n',
      ),
    }),
    allocator(),
    {},
    null,
    null,
    null,
    selection,
  );
}

/**
 * The ambiguous-project fixture plus records the importer cannot convert: one
 * ordinary frontmatter parse failure and one frontmatter shape awaiting the
 * unsupported-frontmatter policy decision. The two refusal reasons are
 * independent, which is what the status and commit assertions pin down.
 */
async function ambiguousAndMalformedPlan(
  selection:
    LegacyImportProjectSelection | null =
      null,
): Promise<
  LegacyImportPlan
> {
  return planLegacyMarkdownImport(
    createMemoryVault({
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
        'name: References duplicate project',
        'project: shared-project',
        'status: running',
        '---',
        '',
      ].join(
        '\n',
      ),

      'Proxima/tasks/malformed.md': [
        '---',
        'id: malformed-task',
        'name: "unterminated',
        '---',
        'Readable body',
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
        'Readable body',
        '',
      ].join(
        '\n',
      ),
    }),
    allocator(),
    {},
    null,
    null,
    null,
    selection,
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
      'parses the five administrative action names and refuses premature payload shapes',
      () => {
        for (
          const type
          of [
            'import.plan',
            'import.inspect',
            'import.status',
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

        // import.resolve carries the selected candidate project record, so the
        // payload-less spelling is no longer a resolvable action.
        expect(
          parseLegacyImportAdministrativeAction({
            type:
              'import.resolve',
          }),
        ).toMatchObject({
          ok:
            false,
          error: {
            code:
              'invalid-action-input',
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

        expect(
          parseLegacyImportAdministrativeAction({
            type:
              'import.resolve',
            candidateProjectRecordId:
              opaque(
                7,
              ),
            extra:
              true,
          }),
        ).toMatchObject({
          ok:
            false,
          error: {
            code:
              'invalid-action-input',
          },
        });

        expect(
          parseLegacyImportAdministrativeAction({
            type:
              'import.resolve',
            candidateProjectRecordId:
              7,
          }),
        ).toMatchObject({
          ok:
            false,
          error: {
            code:
              'invalid-action-input',
          },
        });

        expect(
          parseLegacyImportAdministrativeAction({
            type:
              'import.resolve',
            candidateProjectRecordId:
              'project-a',
          }),
        ).toMatchObject({
          ok:
            false,
          error: {
            code:
              'invalid-action-input',
          },
        });

        expect(
          parseLegacyImportAdministrativeAction({
            type:
              'import.resolve',
            candidateProjectRecordId:
              opaque(
                7,
              ),
          }),
        ).toEqual({
          ok:
            true,
          action: {
            type:
              'import.resolve',
            candidateProjectRecordId:
              opaque(
                7,
              ),
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
      'keeps import.commit unavailable and refuses import.resolve without an accepted plan, invoking neither planning nor inspection',
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

        const commit =
          await actions.dispatch({
            type:
              'import.commit',
          });

        expect(commit)
          .toMatchObject({
            ok:
              false,
            actionType:
              'import.commit',
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

        // import.resolve is no longer unconditionally unavailable: it accepts a
        // selection, but has nothing to resolve it against until a plan is
        // accepted, and planning is still not invoked to find out.
        const resolve =
          await actions.dispatch({
            type:
              'import.resolve',
            candidateProjectRecordId:
              opaque(
                9,
              ),
          });

        expect(resolve)
          .toMatchObject({
            ok:
              false,
            actionType:
              'import.resolve',
            outcome:
              'unavailable',
            durableChange:
              false,
            error: {
              code:
                'action-not-available',
            },
          });

        const malformed =
          await actions.dispatch({
            type:
              'import.resolve',
          });

        expect(malformed)
          .toMatchObject({
            ok:
              false,
            actionType:
              'import.resolve',
            outcome:
              'validation-refused',
            durableChange:
              false,
            error: {
              code:
                'invalid-action-input',
            },
          });

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

    it(
      'resolves an explicitly selected candidate project record across every reference that names it, writing nothing',
      async () => {
        const planned =
          await ambiguousProjectPlan();

        expect(
          planned.counts,
        ).toMatchObject({
          projectReferences:
            2,
          unresolvedProjectReferences:
            2,
          ambiguousProjectReferences:
            2,
        });

        const candidates =
          planned.projectReferences
            .find(
              (reference) =>
                reference.sourceKind
                === 'task',
            )
            ?.candidateProjectRecordIds
          ?? [];

        expect(
          candidates,
        ).toHaveLength(
          2,
        );

        const selected =
          candidates[0];

        if (
          !selected
        ) {
          throw new Error(
            'fixture produced no ambiguous project candidate',
          );
        }

        let plannerCalls =
          0;

        const actions =
          createLegacyImportAdministrativeActions({
            async plan(
              selection,
            ) {
              plannerCalls +=
                1;

              return ambiguousProjectPlan(
                selection
                ?? null,
              );
            },

            async inspect(
              plan,
            ) {
              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        const plannedResult =
          await actions.dispatch({
            type:
              'import.plan',
          });

        expect(
          plannedResult.ok,
        ).toBe(
          true,
        );

        const result =
          await actions.dispatch({
            type:
              'import.resolve',
            candidateProjectRecordId:
              selected,
          });

        expect(result)
          .toMatchObject({
            ok:
              true,
            actionType:
              'import.resolve',
            outcome:
              'accepted',
            durableChange:
              false,
          });

        expect(
          plannerCalls,
        ).toBe(
          2,
        );

        if (
          !result.ok
          || result.data.kind
            !== 'plan'
        ) {
          throw new Error(
            'import.resolve did not return a plan',
          );
        }

        const resolved =
          result.data.plan;

        // The resolution produced a different in-memory plan; the accepted plan
        // it was derived from still reports the vault's ambiguity.
        expect(
          planned.counts
            .ambiguousProjectReferences,
        ).toBe(
          2,
        );

        expect(
          resolved.counts,
        ).toMatchObject({
          projectReferences:
            2,
          unresolvedProjectReferences:
            0,
          ambiguousProjectReferences:
            0,
        });

        expect(
          resolved.writes,
        ).toEqual({
          legacyMarkdown:
            0,
          recordStore:
            0,
          staging:
            0,
        });

        for (
          const reference
          of resolved.projectReferences
        ) {
          expect(reference)
            .toMatchObject({
              resolution:
                'resolved',
              projectRecordId:
                selected,
            });

          expect(
            reference
              .candidateProjectRecordIds,
          ).toBeUndefined();
        }

        const task =
          resolved.conversions.find(
            (conversion) =>
              conversion.kind
              === 'task',
          );

        if (
          task?.kind
          !== 'task'
        ) {
          throw new Error(
            'fixture produced no task conversion',
          );
        }

        expect(
          task.workflowStage,
        ).toMatchObject({
          resolution:
            'candidate',
          projectRecordId:
            selected,
        });

        expect(
          task.scopedOrders
            .workflow
            ?.scope,
        ).toMatchObject({
          kind:
            'project-workflow-stage-candidate',
          projectRecordId:
            selected,
        });

        const event =
          resolved.conversions.find(
            (conversion) =>
              conversion.kind
              === 'event',
          );

        if (
          event?.kind
          !== 'event'
        ) {
          throw new Error(
            'fixture produced no event conversion',
          );
        }

        expect(
          event.project,
        ).toMatchObject({
          resolution:
            'resolved',
          projectRecordId:
            selected,
        });
      },
    );

    it(
      'refuses a selection that is a candidate of no ambiguous project reference without re-planning',
      async () => {
        let plannerCalls =
          0;

        const actions =
          createLegacyImportAdministrativeActions({
            async plan(
              selection,
            ) {
              plannerCalls +=
                1;

              return ambiguousProjectPlan(
                selection
                ?? null,
              );
            },

            async inspect(
              plan,
            ) {
              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        await actions.dispatch({
          type:
            'import.plan',
        });

        expect(
          plannerCalls,
        ).toBe(
          1,
        );

        const result =
          await actions.dispatch({
            type:
              'import.resolve',
            candidateProjectRecordId:
              opaque(
                99,
              ),
          });

        expect(result)
          .toMatchObject({
            ok:
              false,
            actionType:
              'import.resolve',
            outcome:
              'validation-refused',
            durableChange:
              false,
            error: {
              code:
                'invalid-action-input',
            },
          });

        expect(
          plannerCalls,
        ).toBe(
          1,
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
                liveWritesAuthorized:
                  false,
              },
            },
          });
      },
    );

    it(
      'keeps import.commit unavailable after a resolution and inspects the resolved plan',
      async () => {
        const planned =
          await ambiguousProjectPlan();

        const selected =
          planned.projectReferences[0]
            ?.candidateProjectRecordIds
            ?.[0];

        if (
          !selected
        ) {
          throw new Error(
            'fixture produced no ambiguous project candidate',
          );
        }

        const inspected:
          LegacyImportPlan[] = [];

        const actions =
          createLegacyImportAdministrativeActions({
            async plan(
              selection,
            ) {
              return ambiguousProjectPlan(
                selection
                ?? null,
              );
            },

            async inspect(
              plan,
            ) {
              inspected.push(
                plan,
              );

              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        await actions.dispatch({
          type:
            'import.plan',
        });

        await actions.dispatch({
          type:
            'import.resolve',
          candidateProjectRecordId:
            selected,
        });

        const commit =
          await actions.dispatch({
            type:
              'import.commit',
          });

        expect(commit)
          .toMatchObject({
            ok:
              false,
            actionType:
              'import.commit',
            outcome:
              'unavailable',
            durableChange:
              false,
            error: {
              code:
                'action-not-available',
            },
          });

        const inspection =
          await actions.dispatch({
            type:
              'import.inspect',
          });

        expect(inspection)
          .toMatchObject({
            ok:
              true,
            actionType:
              'import.inspect',
            durableChange:
              false,
          });

        expect(
          inspected,
        ).toHaveLength(
          1,
        );

        expect(
          inspected[0]
            ?.counts
            .ambiguousProjectReferences,
        ).toBe(
          0,
        );
      },
    );

    it(
      'reports outstanding project references and the applied selection through import.status, and refuses commit for that reason',
      async () => {
        const planned =
          await ambiguousProjectPlan();

        const selected =
          planned.projectReferences[0]
            ?.candidateProjectRecordIds
            ?.[0];

        if (
          !selected
        ) {
          throw new Error(
            'fixture produced no ambiguous project candidate',
          );
        }

        const actions =
          createLegacyImportAdministrativeActions({
            async plan(
              selection,
            ) {
              return ambiguousProjectPlan(
                selection
                ?? null,
              );
            },

            async inspect(
              plan,
            ) {
              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        // Before any plan there is nothing outstanding and nothing applied.
        const before =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(
          before,
        ).toMatchObject({
          schemaVersion:
            2,
          ok:
            true,
          durableChange:
            false,
          data: {
            kind:
              'status',
            status: {
              phase:
                'not-planned',
              unresolvedProjectReferences:
                0,
              ambiguousProjectReferences:
                0,
              appliedProjectSelection:
                null,
              liveWritesAuthorized:
                false,
            },
          },
        });

        // With an accepted ambiguous plan the counts are visible, so no caller
        // can read the migration as clean.
        await actions.dispatch({
          type:
            'import.plan',
        });

        const ambiguous =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(
          ambiguous,
        ).toMatchObject({
          data: {
            kind:
              'status',
            status: {
              phase:
                'planned',
              unresolvedProjectReferences:
                2,
              ambiguousProjectReferences:
                2,
              appliedProjectSelection:
                null,
            },
          },
        });

        // A commit attempted here refuses *because* of those counts, and says so
        // in machine-readable form rather than only in prose.
        const refusedCommit =
          await actions.dispatch({
            type:
              'import.commit',
          });

        expect(
          refusedCommit,
        ).toMatchObject({
          ok:
            false,
          actionType:
            'import.commit',
          outcome:
            'unavailable',
          durableChange:
            false,
          error: {
            code:
              'action-not-available',
            outstandingProjectReferences: {
              ambiguous:
                2,
              unresolved:
                2,
            },
          },
        });

        // After the explicit selection the references are acknowledged and the
        // decision that acknowledged them is visible.
        const resolved =
          await actions.dispatch({
            type:
              'import.resolve',
            candidateProjectRecordId:
              selected,
          });

        expect(
          resolved,
        ).toMatchObject({
          schemaVersion:
            2,
          ok:
            true,
        });

        const settled =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(
          settled,
        ).toMatchObject({
          data: {
            kind:
              'status',
            status: {
              unresolvedProjectReferences:
                0,
              ambiguousProjectReferences:
                0,
              appliedProjectSelection:
                selected,
              liveWritesAuthorized:
                false,
            },
          },
        });

        // Commit is still unavailable — the policy and activation gates are
        // untouched — but no longer for this reason, so the ambiguity-specific
        // evidence is gone.
        const policyCommit =
          await actions.dispatch({
            type:
              'import.commit',
          });

        expect(
          policyCommit,
        ).toMatchObject({
          ok:
            false,
          actionType:
            'import.commit',
          outcome:
            'unavailable',
          error: {
            code:
              'action-not-available',
          },
        });

        if (
          policyCommit.ok
        ) {
          throw new Error(
            'import.commit unexpectedly succeeded',
          );
        }

        expect(
          policyCommit
            .error
            .outstandingProjectReferences,
        ).toBeUndefined();

        // A fresh plan clears the applied decision, so status never describes a
        // selection that no longer belongs to the plan in effect.
        await actions.dispatch({
          type:
            'import.plan',
        });

        const replanned =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(
          replanned,
        ).toMatchObject({
          data: {
            kind:
              'status',
            status: {
              ambiguousProjectReferences:
                2,
              appliedProjectSelection:
                null,
            },
          },
        });
      },
    );

    it(
      'refuses commit for unconvertible records independently of unacknowledged references',
      async () => {
        const planned =
          await ambiguousAndMalformedPlan();

        expect(
          planned.counts,
        ).toMatchObject({
          ambiguousProjectReferences:
            1,
          unresolvedProjectReferences:
            1,
          unsupportedFrontmatter:
            1,
        });

        // The fixture must really carry unconvertible records beyond the single
        // policy-pending shape, or the independence this test proves is vacuous.
        expect(
          planned.counts
            .readerProblems,
        ).toBeGreaterThan(
          1,
        );

        const selected =
          planned.projectReferences[0]
            ?.candidateProjectRecordIds
            ?.[0];

        if (
          !selected
        ) {
          throw new Error(
            'fixture produced no ambiguous project candidate',
          );
        }

        const actions =
          createLegacyImportAdministrativeActions({
            async plan(
              selection,
            ) {
              return ambiguousAndMalformedPlan(
                selection
                ?? null,
              );
            },

            async inspect(
              plan,
            ) {
              return verificationFor(
                plan,
                'verified',
              );
            },
          });

        await actions.dispatch({
          type:
            'import.plan',
        });

        // Both reasons are outstanding, and status reports both.
        const both =
          await actions.dispatch({
            type:
              'import.status',
          });

        expect(
          both,
        ).toMatchObject({
          data: {
            kind:
              'status',
            status: {
              ambiguousProjectReferences:
                1,
              unresolvedProjectReferences:
                1,
              readerProblems:
                planned.counts
                  .readerProblems,
              unsupportedFrontmatter:
                1,
            },
          },
        });

        const bothCommit =
          await actions.dispatch({
            type:
              'import.commit',
          });

        expect(
          bothCommit,
        ).toMatchObject({
          ok:
            false,
          outcome:
            'unavailable',
          durableChange:
            false,
          error: {
            code:
              'action-not-available',
            outstandingProjectReferences: {
              ambiguous:
                1,
              unresolved:
                1,
            },
            outstandingRecords: {
              readerProblems:
                planned.counts
                  .readerProblems,
              unsupportedFrontmatter:
                1,
            },
          },
        });

        // Acknowledging the references clears only the reference reason. The
        // unconvertible records are still unconverted, so an incomplete import
        // cannot be read as complete.
        await actions.dispatch({
          type:
            'import.resolve',
          candidateProjectRecordId:
            selected,
        });

        const afterResolve =
          await actions.dispatch({
            type:
              'import.commit',
          });

        expect(
          afterResolve,
        ).toMatchObject({
          ok:
            false,
          actionType:
            'import.commit',
          outcome:
            'unavailable',
          error: {
            code:
              'action-not-available',
            outstandingRecords: {
              readerProblems:
                planned.counts
                  .readerProblems,
              unsupportedFrontmatter:
                1,
            },
          },
        });

        if (
          afterResolve.ok
        ) {
          throw new Error(
            'import.commit unexpectedly succeeded',
          );
        }

        expect(
          afterResolve
            .error
            .outstandingProjectReferences,
        ).toBeUndefined();

        // The surviving reason is named rather than collapsing into the generic
        // policy sentence.
        expect(
          afterResolve
            .error
            .message,
        ).toContain(
          'reader problem(s)',
        );

        expect(
          afterResolve
            .error
            .message,
        ).toContain(
          'unsupported-frontmatter policy decision',
        );
      },
    );
  },
);
