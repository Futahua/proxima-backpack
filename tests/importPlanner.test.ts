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
  type LegacyImportIdentityRequest,
} from '../src/app/importPlanner.js';
import {
  fixtureFiles,
  fixtureVault,
} from './fixtures.js';

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

function sequentialAllocator(
  requests:
    LegacyImportIdentityRequest[] =
      [],
): LegacyImportIdentityAllocator {
  let next = 1;

  return {
    recordIdFor(
      request,
    ) {
      requests.push({
        ...request,
      });

      const id =
        opaque(next);

      next += 1;

      return id;
    },
  };
}

class MemoryDurableIdentityMappingStore
implements LegacyImportIdentityMappingStore {
  private mapping:
    LegacyImportIdentityMappingManifest | null =
      null;

  saves = 0;

  async load():
    Promise<
      LegacyImportIdentityMappingManifest | null
    > {
    return this.mapping === null
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
    this.mapping =
      JSON.parse(
        JSON.stringify(
          mapping,
        ),
      ) as LegacyImportIdentityMappingManifest;

    this.saves += 1;
  }
}

describe(
  'Stage 8 slice 1 legacy import planning',
  () => {
    it(
      'builds a machine-readable dry-run plan with final opaque identities and translated project references',
      async () => {
        const files = {
          'Proxima/projects/alpha.md': [
            '---',
            'id: legacy-project',
            'type: project',
            'name: Alpha Project',
            '---',
            'Project body',
            '',
          ].join('\n'),

          'Proxima/tasks/a.md': [
            '---',
            'id: legacy-task-a',
            'name: Task A',
            'project: legacy-project',
            'status: running',
            '---',
            'Task A body',
            '',
          ].join('\n'),

          'Proxima/tasks/b.md': [
            '---',
            'id: legacy-task-b',
            'name: Task B',
            'project: missing-project',
            '---',
            'Task B body',
            '',
          ].join('\n'),

          'Proxima/events/event-a.md': [
            '---',
            'id: legacy-event',
            'name: Event A',
            'projectId: legacy-project',
            'startDate: 2026-09-12T10:00:00.000Z',
            'deadline: 2026-09-12T11:00:00.000Z',
            '---',
            'Event body',
            '',
          ].join('\n'),
        };

        const requests:
          LegacyImportIdentityRequest[] =
            [];

        const plan =
          await planLegacyMarkdownImport(
            createMemoryVault(
              files,
            ),
            sequentialAllocator(
              requests,
            ),
          );

        expect(plan)
          .toMatchObject({
            schemaVersion: 6,
            mode:
              'dry-run',
            source:
              'legacy-markdown-compatibility-reader',
            counts: {
              projects: 1,
              tasks: 2,
              events: 1,
              mappings: 4,
              projectReferences:
                3,
              unresolvedProjectReferences:
                1,
            },
            writes: {
              legacyMarkdown: 0,
              recordStore: 0,
              staging: 0,
            },
          });

        expect(
          plan.mappings.map(
            (mapping) => ({
              kind:
                mapping.kind,
              legacyId:
                mapping.legacyId,
              recordId:
                mapping.recordId,
            }),
          ),
        ).toEqual([
          {
            kind:
              'project',
            legacyId:
              'legacy-project',
            recordId:
              opaque(1),
          },
          {
            kind:
              'task',
            legacyId:
              'legacy-task-a',
            recordId:
              opaque(2),
          },
          {
            kind:
              'task',
            legacyId:
              'legacy-task-b',
            recordId:
              opaque(3),
          },
          {
            kind:
              'event',
            legacyId:
              'legacy-event',
            recordId:
              opaque(4),
          },
        ]);

        expect(
          plan.projectReferences,
        ).toEqual([
          {
            sourceKind:
              'task',
            sourceLegacyId:
              'legacy-task-a',
            sourceRecordId:
              opaque(2),
            legacyProjectId:
              'legacy-project',
            projectRecordId:
              opaque(1),
            resolution:
              'resolved',
          },
          {
            sourceKind:
              'task',
            sourceLegacyId:
              'legacy-task-b',
            sourceRecordId:
              opaque(3),
            legacyProjectId:
              'missing-project',
            projectRecordId:
              null,
            resolution:
              'missing',
          },
          {
            sourceKind:
              'event',
            sourceLegacyId:
              'legacy-event',
            sourceRecordId:
              opaque(4),
            legacyProjectId:
              'legacy-project',
            projectRecordId:
              opaque(1),
            resolution:
              'resolved',
          },
        ]);

        expect(
          plan.problems.some(
            (problem) =>
              problem.code
                === 'missing-project'
              && problem.legacyId
                === 'legacy-task-b',
          ),
        ).toBe(true);

        expect(
          requests.map(
            (request) => ({
              kind:
                request.kind,
              legacyId:
                request.legacyId,
              sourcePath:
                request.sourcePath,
              idOrigin:
                request.idOrigin,
            }),
          ),
        ).toEqual([
          {
            kind:
              'project',
            legacyId:
              'legacy-project',
            sourcePath:
              'Proxima/projects/alpha.md',
            idOrigin:
              'frontmatter',
          },
          {
            kind:
              'task',
            legacyId:
              'legacy-task-a',
            sourcePath:
              'Proxima/tasks/a.md',
            idOrigin:
              'frontmatter',
          },
          {
            kind:
              'task',
            legacyId:
              'legacy-task-b',
            sourcePath:
              'Proxima/tasks/b.md',
            idOrigin:
              'frontmatter',
          },
          {
            kind:
              'event',
            legacyId:
              'legacy-event',
            sourcePath:
              'Proxima/events/event-a.md',
            idOrigin:
              'frontmatter',
          },
        ]);

        expect(
          JSON.parse(
            JSON.stringify(
              plan,
            ),
          ),
        ).toEqual(
          plan,
        );
      },
    );

    it(
      'leaves existing legacy fixture bytes and revisions unchanged during planning',
      async () => {
        const files =
          fixtureFiles(
            'vault-basic',
          );

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

        const after =
          await Promise.all(
            paths.map(
              (path) =>
                vault.read(
                  path,
                ),
            ),
          );

        expect(after)
          .toEqual(
            before,
          );

        expect(plan.writes)
          .toEqual({
            legacyMarkdown: 0,
            recordStore: 0,
            staging: 0,
          });

        expect(
          plan.mappings.length,
        ).toBe(
          plan.counts.projects
          + plan.counts.tasks
          + plan.counts.events,
        );
      },
    );

    it(
      'reports unsupported frontmatter distinctly from ordinary parse failure without choosing import policy',
      async () => {
        const vault =
          createMemoryVault({
            'Proxima/tasks/unsupported.md': [
              '---',
              'id: unsupported-task',
              'description: |',
              '  multiline value',
              '---',
              'Readable body',
              '',
            ].join('\n'),

            'Proxima/tasks/malformed.md': [
              '---',
              'id: malformed-task',
              'name: "unterminated',
              '---',
              'Readable body',
              '',
            ].join('\n'),
          });

        const plan =
          await planLegacyMarkdownImport(
            vault,
            sequentialAllocator(),
          );

        const unsupported =
          plan.problems.find(
            (problem) =>
              problem.code
              === 'unsupported-frontmatter',
          );

        const malformed =
          plan.problems.find(
            (problem) =>
              problem.code
              === 'frontmatter-parse-failure',
          );

        expect(unsupported)
          .toMatchObject({
            code:
              'unsupported-frontmatter',
            sourcePath:
              'Proxima/tasks/unsupported.md',
            disposition:
              'unsupported-frontmatter-policy-pending',
          });

        expect(malformed)
          .toMatchObject({
            code:
              'frontmatter-parse-failure',
            sourcePath:
              'Proxima/tasks/malformed.md',
            disposition:
              'reader-problem',
          });

        expect(
          plan.counts
            .unsupportedFrontmatter,
        ).toBe(1);

        expect(
          plan.mappings.map(
            (mapping) =>
              mapping.legacyId,
          ).sort(),
        ).toEqual([
          'malformed-task',
          'unsupported-task',
        ]);
      },
    );

    it(
      'refuses invalid, reused, or silently promoted canonical identities',
      async () => {
        const single =
          createMemoryVault({
            'Proxima/projects/one.md': [
              '---',
              'id: legacy-one',
              'type: project',
              'name: One',
              '---',
              '',
            ].join('\n'),
          });

        await expect(
          planLegacyMarkdownImport(
            single,
            {
              recordIdFor() {
                return 'legacy-one';
              },
            },
          ),
        ).rejects.toThrow(
          /Invalid opaque Proxima record id/,
        );

        const duplicate =
          createMemoryVault({
            'Proxima/projects/one.md': [
              '---',
              'id: legacy-one',
              'type: project',
              'name: One',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/two.md': [
              '---',
              'id: legacy-two',
              'name: Two',
              '---',
              '',
            ].join('\n'),
          });

        await expect(
          planLegacyMarkdownImport(
            duplicate,
            {
              recordIdFor() {
                return opaque(8);
              },
            },
          ),
        ).rejects.toThrow(
          /reused canonical record id/,
        );

        const promotedId =
          opaque(9);

        const promotion =
          createMemoryVault({
            'Proxima/projects/promoted.md': [
              '---',
              `id: ${promotedId}`,
              'type: project',
              'name: Legacy opaque-looking id',
              '---',
              '',
            ].join('\n'),
          });

        await expect(
          planLegacyMarkdownImport(
            promotion,
            {
              recordIdFor() {
                return promotedId;
              },
            },
          ),
        ).rejects.toThrow(
          /Legacy identity aliases are provenance only/,
        );
      },
    );

    it(
      'plans every readable physical duplicate candidate separately and records alias collisions',
      async () => {
        const plan =
          await planLegacyMarkdownImport(
            fixtureVault(
              'vault-duplicates',
            ),
            sequentialAllocator(),
          );

        expect(
          plan.counts,
        ).toMatchObject({
          projects: 1,
          tasks: 1,
          events: 1,
          physicalCandidates: 5,
          mappings: 5,
          collisions: 2,
        });

        expect(
          plan.collisions.map(
            (collision) => ({
              kind:
                collision.kind,
              legacyId:
                collision.legacyId,
              sourcePaths:
                collision.candidates
                  .map(
                    (candidate) =>
                      candidate.sourcePath,
                  ),
            }),
          ),
        ).toEqual([
          {
            kind:
              'project',
            legacyId:
              'proj-twin',
            sourcePaths: [
              'Proxima/projects/proj-twin.md',
              'Proxima/projects/proj-twin/index.md',
            ],
          },
          {
            kind:
              'task',
            legacyId:
              'task-shared',
            sourcePaths: [
              'Proxima/tasks/Another file.md',
              'Proxima/tasks/task-shared.md',
            ],
          },
        ]);

        const collisionMappings =
          plan.mappings.filter(
            (mapping) =>
              mapping.disposition
              === 'duplicate-alias-collision',
          );

        expect(
          collisionMappings,
        ).toHaveLength(4);

        expect(
          new Set(
            plan.mappings.map(
              (mapping) =>
                mapping.recordId,
            ),
          ).size,
        ).toBe(5);

        expect(
          plan.identityMapping.entries,
        ).toHaveLength(5);

        expect(
          plan.identityMapping.entries
            .map(
              (entry) => ({
                kind:
                  entry.kind,
                legacyId:
                  entry.legacyId,
                sourcePath:
                  entry.sourcePath,
                sourceRevision:
                  entry.sourceRevision,
                idOrigin:
                  entry.idOrigin,
                recordId:
                  entry.recordId,
              }),
            ),
        ).toEqual(
          plan.identityMapping.entries,
        );

        expect(
          plan.problems.filter(
            (problem) =>
              problem.code
              === 'duplicate-id',
          ),
        ).toHaveLength(2);

        expect(
          plan.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );

    it(
      'reuses a durable physical-candidate mapping and refuses to pick through an ambiguous duplicate project alias',
      async () => {
        const files = {
          'Proxima/projects/a.md': [
            '---',
            'id: shared-project',
            'type: project',
            'name: Shared A',
            '---',
            '',
          ].join('\n'),

          'Proxima/projects/b.md': [
            '---',
            'id: shared-project',
            'type: project',
            'name: Shared B',
            '---',
            '',
          ].join('\n'),

          'Proxima/tasks/ref.md': [
            '---',
            'id: task-ref',
            'name: References duplicate project',
            'project: shared-project',
            '---',
            '',
          ].join('\n'),
        };

        const durableStore =
          new MemoryDurableIdentityMappingStore();

        const first =
          await planLegacyMarkdownImport(
            createMemoryVault(
              files,
            ),
            sequentialAllocator(),
            {},
            await readLegacyImportIdentityMapping(
              durableStore,
            ),
          );

        expect(
          first.counts,
        ).toMatchObject({
          physicalCandidates: 3,
          mappings: 3,
          collisions: 1,
          projectReferences: 1,
          unresolvedProjectReferences: 1,
          ambiguousProjectReferences: 1,
        });

        const projectCollision =
          first.collisions.find(
            (collision) =>
              collision.kind
                === 'project'
              && collision.legacyId
                === 'shared-project',
          );

        expect(
          projectCollision,
        ).toBeDefined();

        const reference =
          first.projectReferences[0];

        expect(
          reference,
        ).toMatchObject({
          sourceKind:
            'task',
          sourceLegacyId:
            'task-ref',
          legacyProjectId:
            'shared-project',
          projectRecordId:
            null,
          resolution:
            'ambiguous',
        });

        expect(
          reference
            ?.candidateProjectRecordIds,
        ).toEqual(
          projectCollision
            ?.candidates
            .map(
              (candidate) =>
                candidate.recordId,
            ),
        );

        await writeLegacyImportIdentityMapping(
          durableStore,
          first.identityMapping,
        );

        expect(
          durableStore.saves,
        ).toBe(1);

        const persisted =
          await readLegacyImportIdentityMapping(
            durableStore,
          );

        expect(persisted)
          .toEqual(
            first.identityMapping,
          );

        const second =
          await planLegacyMarkdownImport(
            createMemoryVault(
              files,
            ),
            {
              recordIdFor() {
                throw new Error(
                  'durable identity reconciliation must reuse existing candidate ids',
                );
              },
            },
            {},
            persisted,
          );

        expect(
          second.mappings.map(
            (mapping) => ({
              kind:
                mapping.kind,
              sourcePath:
                mapping.source.path,
              recordId:
                mapping.recordId,
            }),
          ),
        ).toEqual(
          first.mappings.map(
            (mapping) => ({
              kind:
                mapping.kind,
              sourcePath:
                mapping.source.path,
              recordId:
                mapping.recordId,
            }),
          ),
        );

        expect(
          second.identityMapping,
        ).toEqual(
          first.identityMapping,
        );

        expect(
          second.projectReferences,
        ).toEqual(
          first.projectReferences,
        );

        expect(
          durableStore.saves,
        ).toBe(1);
      },
    );

    it(
      'separates legacy task status into execution and project-workflow conversion semantics',
      async () => {
        const plan =
          await planLegacyMarkdownImport(
            createMemoryVault({
              'Proxima/projects/alpha.md': [
                '---',
                'id: alpha',
                'type: project',
                'name: Alpha',
                'projectType: schedule',
                '---',
                '',
              ].join('\n'),

              'Proxima/tasks/a-backlog.md': [
                '---',
                'id: a-backlog',
                'name: Backlog task',
                'project: alpha',
                'status: backlog',
                'orderIndex: 30',
                '---',
                '',
              ].join('\n'),

              'Proxima/tasks/b-waiting.md': [
                '---',
                'id: b-waiting',
                'name: Waiting task',
                'project: alpha',
                'status: waiting',
                'orderIndex: 10',
                '---',
                '',
              ].join('\n'),

              'Proxima/tasks/c-completed.md': [
                '---',
                'id: c-completed',
                'name: Completed task',
                'project: alpha',
                'status: running',
                'orderIndex: 20',
                'isCompleted: true',
                '---',
                '',
              ].join('\n'),
            }),
            sequentialAllocator(),
          );

        const tasks =
          plan.conversions
            .filter(
              (
                conversion,
              ): conversion is Extract<
                typeof conversion,
                {
                  kind:
                    'task';
                }
              > =>
                conversion.kind
                === 'task',
            );

        const bySource =
          new Map(
            tasks.map(
              (task) => [
                task.sourcePath,
                task,
              ] as const,
            ),
          );

        expect(
          bySource.get(
            'Proxima/tasks/a-backlog.md',
          ),
        ).toMatchObject({
          legacyStatusId:
            'backlog',
          executionState:
            'backlog',
          workflowStage: {
            resolution:
              'candidate',
            legacyStatusId:
              'backlog',
            suggestedName:
              'Elastic Backlog',
          },
          scopedOrders: {
            execution: {
              scope: {
                kind:
                  'elastic-execution',
                executionState:
                  'backlog',
              },
              position: 30,
            },
            workflow: {
              scope: {
                kind:
                  'project-workflow-stage-candidate',
                legacyStatusId:
                  'backlog',
              },
              position: 30,
            },
          },
        });

        expect(
          bySource.get(
            'Proxima/tasks/b-waiting.md',
          ),
        ).toMatchObject({
          legacyStatusId:
            'waiting',
          executionState:
            'running',
          workflowStage: {
            resolution:
              'candidate',
            legacyStatusId:
              'waiting',
            suggestedName:
              'waiting',
          },
          scopedOrders: {
            execution: {
              scope: {
                executionState:
                  'running',
              },
              position: 10,
            },
            workflow: {
              scope: {
                legacyStatusId:
                  'waiting',
              },
              position: 10,
            },
          },
        });

        expect(
          bySource.get(
            'Proxima/tasks/c-completed.md',
          ),
        ).toMatchObject({
          legacyStatusId:
            'running',
          executionState:
            'finished',
          workflowStage: {
            resolution:
              'candidate',
            legacyStatusId:
              'running',
            suggestedName:
              'Elastic Running',
          },
          scopedOrders: {
            execution: {
              scope: {
                executionState:
                  'finished',
              },
              position: 20,
            },
            workflow: {
              scope: {
                legacyStatusId:
                  'running',
              },
              position: 20,
            },
          },
        });

        const projectIds =
          new Set(
            tasks.map(
              (task) =>
                task.workflowStage
                  .projectRecordId,
            ),
          );

        expect(projectIds.size).toBe(1);
        expect(projectIds.has(null)).toBe(false);
        expect(
          JSON.stringify(
            plan.conversions,
          ),
        ).not.toContain(
          '"orderIndex"',
        );

        expect(plan.writes).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );

    it(
      'keeps legacy projectType as compatibility metadata with identical canonical capability authority',
      async () => {
        const plan =
          await planLegacyMarkdownImport(
            createMemoryVault({
              'Proxima/projects/task-project.md': [
                '---',
                'id: task-project',
                'type: project',
                'name: Task-labelled project',
                'projectType: task',
                '---',
                '',
              ].join('\n'),

              'Proxima/projects/schedule-project.md': [
                '---',
                'id: schedule-project',
                'type: project',
                'name: Schedule-labelled project',
                'projectType: schedule',
                '---',
                '',
              ].join('\n'),
            }),
            sequentialAllocator(),
          );

        const projects =
          plan.conversions
            .filter(
              (
                conversion,
              ): conversion is Extract<
                typeof conversion,
                {
                  kind:
                    'project';
                }
              > =>
                conversion.kind
                === 'project',
            )
            .map(
              (project) => ({
                legacyProjectType:
                  project
                    .legacyProjectType,
                disposition:
                  project.disposition,
                canonicalCapabilityAuthority:
                  project
                    .canonicalCapabilityAuthority,
              }),
            )
            .sort(
              (left, right) =>
                left
                  .legacyProjectType
                  .localeCompare(
                    right
                      .legacyProjectType,
                  ),
            );

        expect(projects)
          .toEqual([
            {
              legacyProjectType:
                'schedule',
              disposition:
                'compatibility-import-metadata-only',
              canonicalCapabilityAuthority:
                'associated-data-and-workspace',
            },
            {
              legacyProjectType:
                'task',
              disposition:
                'compatibility-import-metadata-only',
              canonicalCapabilityAuthority:
                'associated-data-and-workspace',
            },
          ]);
      },
    );

    it(
      'keeps execution conversion usable while ambiguous project identity blocks workflow-stage and workflow-order selection',
      async () => {
        const plan =
          await planLegacyMarkdownImport(
            createMemoryVault({
              'Proxima/projects/a.md': [
                '---',
                'id: shared-project',
                'type: project',
                'name: Shared A',
                '---',
                '',
              ].join('\n'),

              'Proxima/projects/b.md': [
                '---',
                'id: shared-project',
                'type: project',
                'name: Shared B',
                '---',
                '',
              ].join('\n'),

              'Proxima/tasks/ref.md': [
                '---',
                'id: task-ref',
                'name: Ambiguous workflow task',
                'project: shared-project',
                'status: review',
                'orderIndex: 7',
                '---',
                '',
              ].join('\n'),
            }),
            sequentialAllocator(),
          );

        const task =
          plan.conversions.find(
            (
              conversion,
            ): conversion is Extract<
              typeof conversion,
              {
                kind:
                  'task';
              }
            > =>
              conversion.kind
              === 'task',
          );

        expect(task).toBeDefined();

        expect(task).toMatchObject({
          legacyStatusId:
            'review',
          executionState:
            'finished',
          workflowStage: {
            resolution:
              'ambiguous-project',
            legacyStatusId:
              'review',
            suggestedName:
              'Finished',
            projectRecordId:
              null,
          },
          scopedOrders: {
            execution: {
              scope: {
                kind:
                  'elastic-execution',
                executionState:
                  'finished',
              },
              position: 7,
            },
            workflow:
              null,
          },
        });

        expect(
          task
            ?.workflowStage
            .resolution
          === 'ambiguous-project'
            ? task
                .workflowStage
                .candidateProjectRecordIds
                .length
            : 0,
        ).toBe(2);
      },
    );
  },
);
