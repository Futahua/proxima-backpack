import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import {
  type LegacyImportArtifactIdentityAllocator,
  type LegacyImportArtifactIdentityMappingManifest,
  type LegacyImportArtifactIdentityRequest,
  type LegacyImportArtifactPlanningInput,
  type LegacyImportExternalArtifactPlan,
} from '../src/app/importArtifactPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import {
  parseOpaqueExternalArtifactId,
} from '../src/domain/canonicalArtifactAssociation.js';

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

function opaqueArtifactId(
  value:
    number,
) {
  return parseOpaqueExternalArtifactId(
    `pxa_${value
      .toString(16)
      .padStart(
        32,
        '0',
      )}`,
  );
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

function sequentialArtifactAllocator(
  requests:
    LegacyImportArtifactIdentityRequest[] =
      [],
): LegacyImportArtifactIdentityAllocator {
  let next = 1;

  return {
    artifactIdFor(
      request,
    ) {
      requests.push({
        ...request,
      });

      const id =
        opaqueArtifactId(
          next,
        );

      next += 1;

      return id;
    },
  };
}

function requireArtifactPlan(
  value:
    LegacyImportExternalArtifactPlan | null,
): LegacyImportExternalArtifactPlan {
  if (
    value === null
  ) {
    throw new Error(
      'Expected external-artifact import plan.',
    );
  }

  return value;
}

async function plan(
  files:
    Record<string, string>,
  artifactPlanning:
    LegacyImportArtifactPlanningInput,
) {
  return planLegacyMarkdownImport(
    createMemoryVault(
      files,
    ),
    sequentialRecordAllocator(),
    {},
    null,
    null,
    artifactPlanning,
  );
}

describe(
  'Stage 8 slice 8 external-artifact import planning',
  () => {
    it(
      'converts interpreted linked folders into reference-only canonical artifact associations without copying external contents',
      async () => {
        const files = {
          'Proxima/projects/alpha.md': [
            '---',
            'id: alpha',
            'type: project',
            'name: Alpha',
            'linkedFolder: Notes/Alpha',
            'linkedFolders: Drawings|Drawings/Alpha;Attachments|Attachments/Alpha',
            '---',
            '',
          ].join(
            '\n',
          ),
          'Notes/Alpha/secret.md':
            'SECRET-NOTE-CONTENT',
          'Drawings/Alpha/sketch.canvas':
            'CANVAS-CONTENT',
          'Attachments/Alpha/file.bin':
            'ATTACHMENT-CONTENT',
        };

        const vault =
          createMemoryVault(
            files,
          );

        const externalPaths = [
          'Notes/Alpha/secret.md',
          'Drawings/Alpha/sketch.canvas',
          'Attachments/Alpha/file.bin',
        ];

        const before =
          await Promise.all(
            externalPaths.map(
              (path) =>
                vault.read(
                  path,
                ),
            ),
          );

        const requests:
          LegacyImportArtifactIdentityRequest[] =
            [];

        const result =
          await planLegacyMarkdownImport(
            vault,
            sequentialRecordAllocator(),
            {},
            null,
            null,
            {
              allocator:
                sequentialArtifactAllocator(
                  requests,
                ),
            },
          );

        const artifactPlan =
          requireArtifactPlan(
            result.externalArtifacts,
          );

        const after =
          await Promise.all(
            externalPaths.map(
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

        expect(
          result.schemaVersion,
        ).toBe(5);

        expect(artifactPlan)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'dry-run',
            source:
              'interpreted-legacy-project-linked-folders',
            contentPolicy:
              'reference-only-no-copy',
            externalRenameContinuity:
              'not-claimed',
            writes: {
              legacyMarkdown: 0,
              recordStore: 0,
              staging: 0,
              externalArtifacts: 0,
            },
          });

        expect(
          requests.map(
            (request) =>
              request
                .legacyLocatorPath,
          ),
        ).toEqual([
          'Attachments/Alpha',
          'Drawings/Alpha',
          'Notes/Alpha',
        ]);

        expect(
          artifactPlan.references,
        ).toEqual([
          {
            id:
              opaqueArtifactId(
                1,
              ),
            kind:
              'folder',
            locator: {
              kind:
                'vault-relative-path',
              path:
                'Attachments/Alpha',
            },
          },
          {
            id:
              opaqueArtifactId(
                2,
              ),
            kind:
              'folder',
            locator: {
              kind:
                'vault-relative-path',
              path:
                'Drawings/Alpha',
            },
          },
          {
            id:
              opaqueArtifactId(
                3,
              ),
            kind:
              'folder',
            locator: {
              kind:
                'vault-relative-path',
              path:
                'Notes/Alpha',
            },
          },
        ]);

        const project =
          artifactPlan
            .projects[0];

        if (
          project
          === undefined
        ) {
          throw new Error(
            'Expected project artifact plan.',
          );
        }

        expect(
          project.association,
        ).toEqual({
          projectId:
            opaqueRecordId(
              1,
            ),
          bindings: [
            {
              role:
                'artifact',
              artifactId:
                opaqueArtifactId(
                  3,
                ),
            },
            {
              role:
                'artifact',
              artifactId:
                opaqueArtifactId(
                  2,
                ),
            },
            {
              role:
                'artifact',
              artifactId:
                opaqueArtifactId(
                  1,
                ),
            },
          ],
        });

        expect(
          project.legacyLinks,
        ).toEqual([
          {
            legacyName:
              'Alpha',
            legacyLocatorPath:
              'Notes/Alpha',
            artifactId:
              opaqueArtifactId(
                3,
              ),
          },
          {
            legacyName:
              'Drawings',
            legacyLocatorPath:
              'Drawings/Alpha',
            artifactId:
              opaqueArtifactId(
                2,
              ),
          },
          {
            legacyName:
              'Attachments',
            legacyLocatorPath:
              'Attachments/Alpha',
            artifactId:
              opaqueArtifactId(
                1,
              ),
          },
        ]);

        const serialized =
          JSON.stringify(
            artifactPlan,
          );

        expect(serialized)
          .not
          .toContain(
            'SECRET-NOTE-CONTENT',
          );

        expect(serialized)
          .not
          .toContain(
            'CANVAS-CONTENT',
          );

        expect(serialized)
          .not
          .toContain(
            'ATTACHMENT-CONTENT',
          );

        expect(
          result.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );

    it(
      'classifies only syntactically absolute machine paths as machine locators and never rewrites the interpreted path',
      async () => {
        const result =
          await plan(
            {
              'Proxima/projects/paths.md': [
                '---',
                'id: paths',
                'type: project',
                'linkedFolders: Win|C:\\Creator\\Files;UNC|\\\\server\\share;Posix|/home/creator/files;Vault|Shared/Files',
                '---',
                '',
              ].join(
                '\n',
              ),
            },
            {
              allocator:
                sequentialArtifactAllocator(),
            },
          );

        const artifactPlan =
          requireArtifactPlan(
            result.externalArtifacts,
          );

        const kindsByPath =
          Object.fromEntries(
            artifactPlan
              .references
              .map(
                (reference) => [
                  reference
                    .locator
                    .path,
                  reference
                    .locator
                    .kind,
                ],
              ),
          );

        expect(
          kindsByPath,
        ).toEqual({
          'C:\\Creator\\Files':
            'machine-path',
          '\\\\server\\share':
            'machine-path',
          '/home/creator/files':
            'machine-path',
          'Shared/Files':
            'vault-relative-path',
        });

        expect(
          new Set(
            artifactPlan
              .references
              .map(
                (reference) =>
                  reference
                    .locator
                    .path,
              ),
          ),
        ).toEqual(
          new Set([
            'C:\\Creator\\Files',
            '\\\\server\\share',
            '/home/creator/files',
            'Shared/Files',
          ]),
        );
      },
    );

    it(
      'shares one external-artifact identity when multiple projects reference the same exact legacy locator',
      async () => {
        const requests:
          LegacyImportArtifactIdentityRequest[] =
            [];

        const result =
          await plan(
            {
              'Proxima/projects/a.md': [
                '---',
                'id: a',
                'type: project',
                'linkedFolders: Alpha Link|Shared/Folder',
                '---',
                '',
              ].join(
                '\n',
              ),
              'Proxima/projects/b.md': [
                '---',
                'id: b',
                'type: project',
                'linkedFolders: Beta Link|Shared/Folder',
                '---',
                '',
              ].join(
                '\n',
              ),
            },
            {
              allocator:
                sequentialArtifactAllocator(
                  requests,
                ),
            },
          );

        const artifactPlan =
          requireArtifactPlan(
            result.externalArtifacts,
          );

        expect(requests)
          .toHaveLength(
            1,
          );

        expect(
          artifactPlan.references,
        ).toHaveLength(
          1,
        );

        expect(
          artifactPlan.projects,
        ).toHaveLength(
          2,
        );

        const ids =
          artifactPlan
            .projects
            .map(
              (project) =>
                project
                  .association
                  .bindings[0]
                  ?.artifactId,
            );

        expect(ids)
          .toEqual([
            opaqueArtifactId(
              1,
            ),
            opaqueArtifactId(
              1,
            ),
          ]);

        expect(
          artifactPlan
            .projects
            .map(
              (project) =>
                project
                  .legacyLinks[0]
                  ?.legacyName,
            ),
        ).toEqual([
          'Alpha Link',
          'Beta Link',
        ]);
      },
    );

    it(
      'reuses an exact-path prior artifact mapping without reallocating identity and does not claim rename continuity',
      async () => {
        const files = {
          'Proxima/projects/a.md': [
            '---',
            'id: a',
            'type: project',
            'linkedFolders: Shared|Shared/Folder',
            '---',
            '',
          ].join(
            '\n',
          ),
        };

        const first =
          requireArtifactPlan(
            (
              await plan(
                files,
                {
                  allocator:
                    sequentialArtifactAllocator(),
                },
              )
            ).externalArtifacts,
          );

        const second =
          requireArtifactPlan(
            (
              await plan(
                files,
                {
                  allocator: {
                    artifactIdFor() {
                      throw new Error(
                        'Artifact identity must have been reused.',
                      );
                    },
                  },
                  priorIdentityMapping:
                    first.identityMapping,
                },
              )
            ).externalArtifacts,
          );

        expect(
          second.identityMapping,
        ).toEqual(
          first.identityMapping,
        );

        expect(
          second.references,
        ).toEqual(
          first.references,
        );

        expect(
          second.externalRenameContinuity,
        ).toBe(
          'not-claimed',
        );
      },
    );

    it(
      'refuses one newly allocated external-artifact id for two distinct current legacy locators',
      async () => {
        const reused =
          opaqueArtifactId(
            9,
          );

        await expect(
          plan(
            {
              'Proxima/projects/a.md': [
                '---',
                'id: a',
                'type: project',
                'linkedFolders: First|One/Folder;Second|Two/Folder',
                '---',
                '',
              ].join(
                '\n',
              ),
            },
            {
              allocator: {
                artifactIdFor() {
                  return reused;
                },
              },
            },
          ),
        ).rejects.toThrow(
          /reused external-artifact id/,
        );
      },
    );

    it(
      'keeps stale prior locator reservations from being silently reassigned to a different current locator',
      async () => {
        const reserved =
          opaqueArtifactId(
            7,
          );

        const prior:
          LegacyImportArtifactIdentityMappingManifest = {
            schemaVersion: 1,
            reconciliationKey:
              'exact-legacy-locator-path',
            entries: [
              {
                legacyLocatorPath:
                  'Old/Folder',
                artifactId:
                  reserved,
              },
            ],
          };

        await expect(
          plan(
            {
              'Proxima/projects/a.md': [
                '---',
                'id: a',
                'type: project',
                'linkedFolders: New|New/Folder',
                '---',
                '',
              ].join(
                '\n',
              ),
            },
            {
              allocator: {
                artifactIdFor() {
                  return reserved;
                },
              },
              priorIdentityMapping:
                prior,
            },
          ),
        ).rejects.toThrow(
          /already assigned to Old\/Folder/,
        );
      },
    );
  },
);
