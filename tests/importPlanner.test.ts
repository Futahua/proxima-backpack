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
  type LegacyImportIdentityRequest,
} from '../src/app/importPlanner.js';
import {
  fixtureFiles,
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
            schemaVersion: 1,
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
  },
);
