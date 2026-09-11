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
} from '../src/app/importPlanner.js';
import type {
  LegacyImportPropertyValueConversion,
  LegacyImportPropertyValuePlan,
  LegacyImportRecordPropertyValuePlan,
} from '../src/app/importPropertyPlanner.js';
import type {
  LegacyInterpretedPropertySchemaSettingsSnapshot,
  LegacyImportSchemaIdentityAllocator,
} from '../src/app/importSchemaPlanner.js';

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

function opaqueOption(
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
        opaque(
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
        opaque(
          nextRecord,
        );
      nextRecord += 1;
      return id;
    },

    schemaOptionIdFor() {
      const id =
        opaqueOption(
          nextOption,
        );
      nextOption += 1;
      return id;
    },
  };
}

function relationSnapshot(
  targetFolder:
    string = 'Proxima/tasks',
): LegacyInterpretedPropertySchemaSettingsSnapshot {
  return {
    taskSchema: [
      {
        id:
          'related',
        name:
          'Related',
        type:
          'relation',
        targetFolder,
      },
    ],
    projectSchemas: {},
  };
}

async function plan(
  files:
    Record<string, string>,
  snapshot:
    LegacyInterpretedPropertySchemaSettingsSnapshot = relationSnapshot(),
) {
  return planLegacyMarkdownImport(
    createMemoryVault(
      files,
    ),
    sequentialRecordAllocator(),
    {},
    null,
    {
      snapshot,
      allocator:
        sequentialSchemaAllocator(),
    },
  );
}

type ImportPlan =
  Awaited<
    ReturnType<
      typeof planLegacyMarkdownImport
    >
  >;

function requirePropertyPlan(
  value:
    LegacyImportPropertyValuePlan | null,
): LegacyImportPropertyValuePlan {
  if (value === null) {
    throw new Error(
      'Expected property-value plan.',
    );
  }

  return value;
}

function requireRecord(
  value:
    LegacyImportPropertyValuePlan,
  sourcePath:
    string,
): LegacyImportRecordPropertyValuePlan {
  const record =
    value.records.find(
      (candidate) =>
        candidate.sourcePath
        === sourcePath,
    );

  if (
    record === undefined
  ) {
    throw new Error(
      `Missing property-value record for ${sourcePath}.`,
    );
  }

  return record;
}

function requireRelationConversion(
  record:
    LegacyImportRecordPropertyValuePlan,
): LegacyImportPropertyValueConversion {
  const conversion =
    record.conversions.find(
      (candidate) =>
        candidate.legacySchemaId
        === 'related',
    );

  if (
    conversion === undefined
  ) {
    throw new Error(
      'Missing related conversion.',
    );
  }

  return conversion;
}

function recordIdForPath(
  value:
    ImportPlan,
  sourcePath:
    string,
) {
  const mapping =
    value.mappings.find(
      (candidate) =>
        candidate.source.path
        === sourcePath,
    );

  if (
    mapping === undefined
  ) {
    throw new Error(
      `Missing record mapping for ${sourcePath}.`,
    );
  }

  return mapping.recordId;
}

function requireCanonicalRelationSchema(
  value:
    ImportPlan,
) {
  const conversion =
    value.schemaSettings
      ?.conversions
      .find(
        (candidate) =>
          candidate.legacySchemaId
          === 'related',
      );

  if (
    conversion === undefined
    || conversion.disposition
      !== 'canonical-ready'
    || conversion.record
      .definition.type
      !== 'relation'
  ) {
    throw new Error(
      'Expected canonical-ready relation schema.',
    );
  }

  return conversion.record;
}

describe(
  'Stage 8 slice 6 relation target dry-run conversion planning',
  () => {
    it(
      'maps an unambiguous legacy wikilink to opaque canonical relation identity and target identity only',
      async () => {
        const result =
          await plan({
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              'related: "[[target]]"',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/target.md': [
              '---',
              'id: target',
              '---',
              '',
            ].join('\n'),
          });

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const source =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/source.md',
          );
        const conversion =
          requireRelationConversion(
            source,
          );
        const schema =
          requireCanonicalRelationSchema(
            result,
          );
        const targetRecordId =
          recordIdForPath(
            result,
            'Proxima/tasks/target.md',
          );

        expect(
          propertyPlan.schemaVersion,
        ).toBe(2);

        expect(
          schema.definition,
        ).toEqual({
          type:
            'relation',
          targetKinds: [
            'task',
          ],
        });

        expect(
          conversion,
        ).toEqual({
          scope: {
            kind:
              'task-schema',
          },
          legacySchemaId:
            'related',
          schemaRecordId:
            schema.id,
          legacyType:
            'relation',
          disposition:
            'canonical-ready',
          value: {
            type:
              'relation',
            value: {
              relationSchemaId:
                schema.id,
              targetRecordIds: [
                targetRecordId,
              ],
            },
          },
        });

        expect(
          source.canonicalReadyValues[
            schema.id
          ],
        ).toEqual(
          conversion.disposition
            === 'canonical-ready'
            ? conversion.value
            : null,
        );

        const canonicalJson =
          JSON.stringify(
            source
              .canonicalReadyValues[
                schema.id
              ],
          );

        expect(
          canonicalJson,
        ).not.toContain(
          '[[',
        );

        expect(
          canonicalJson,
        ).not.toContain(
          'Proxima/',
        );

        expect(
          canonicalJson,
        ).not.toContain(
          '.md',
        );
      },
    );

    it(
      'keeps a duplicate legacy relation alias explicitly ambiguous with every candidate opaque identity',
      async () => {
        const result =
          await plan({
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              'related: "[[dup]]"',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/a.md': [
              '---',
              'id: dup',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/b.md': [
              '---',
              'id: dup',
              '---',
              '',
            ].join('\n'),
          });

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const source =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/source.md',
          );
        const conversion =
          requireRelationConversion(
            source,
          );

        if (
          conversion.disposition
          !== 'unresolved'
        ) {
          throw new Error(
            'Expected ambiguous relation to remain unresolved.',
          );
        }

        expect(
          conversion.reason,
        ).toBe(
          'legacy-relation-target-ambiguous',
        );

        expect(
          conversion.relationTargets,
        ).toEqual([
          {
            legacyLink:
              '[[dup]]',
            linkPath:
              'dup',
            resolution:
              'ambiguous',
            candidateRecordIds: [
              recordIdForPath(
                result,
                'Proxima/tasks/a.md',
              ),
              recordIdForPath(
                result,
                'Proxima/tasks/b.md',
              ),
            ],
          },
        ]);

        expect(
          source
            .canonicalReadyValues,
        ).toEqual({});
      },
    );

    it(
      'allows an explicit physical wikilink path to disambiguate duplicate legacy aliases',
      async () => {
        const result =
          await plan({
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              'related: "[[Proxima/tasks/a]]"',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/a.md': [
              '---',
              'id: dup',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/b.md': [
              '---',
              'id: dup',
              '---',
              '',
            ].join('\n'),
          });

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const source =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/source.md',
          );
        const conversion =
          requireRelationConversion(
            source,
          );
        const schema =
          requireCanonicalRelationSchema(
            result,
          );

        if (
          conversion.disposition
          !== 'canonical-ready'
          || conversion.value.type
            !== 'relation'
        ) {
          throw new Error(
            'Expected explicit path relation to resolve.',
          );
        }

        expect(
          conversion.value.value,
        ).toEqual({
          relationSchemaId:
            schema.id,
          targetRecordIds: [
            recordIdForPath(
              result,
              'Proxima/tasks/a.md',
            ),
          ],
        });
      },
    );

    it(
      'keeps a missing wikilink target explicitly unresolved',
      async () => {
        const result =
          await plan({
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              'related: "[[missing]]"',
              '---',
              '',
            ].join('\n'),
          });

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const conversion =
          requireRelationConversion(
            requireRecord(
              propertyPlan,
              'Proxima/tasks/source.md',
            ),
          );

        if (
          conversion.disposition
          !== 'unresolved'
        ) {
          throw new Error(
            'Expected missing relation to remain unresolved.',
          );
        }

        expect(
          conversion.reason,
        ).toBe(
          'legacy-relation-target-missing',
        );

        expect(
          conversion.relationTargets,
        ).toEqual([
          {
            legacyLink:
              '[[missing]]',
            linkPath:
              'missing',
            resolution:
              'missing',
          },
        ]);
      },
    );

    it(
      'enforces the canonical relation target-kind contract instead of accepting a link to a disallowed record kind',
      async () => {
        const result =
          await plan(
            {
              'Proxima/tasks/source.md': [
                '---',
                'id: source',
                'related: "[[target-task]]"',
                '---',
                '',
              ].join('\n'),
              'Proxima/tasks/target-task.md': [
                '---',
                'id: target-task',
                '---',
                '',
              ].join('\n'),
            },
            relationSnapshot(
              'Proxima/projects',
            ),
          );

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const conversion =
          requireRelationConversion(
            requireRecord(
              propertyPlan,
              'Proxima/tasks/source.md',
            ),
          );
        const schema =
          requireCanonicalRelationSchema(
            result,
          );

        expect(
          schema.definition,
        ).toEqual({
          type:
            'relation',
          targetKinds: [
            'project',
          ],
        });

        if (
          conversion.disposition
          !== 'unresolved'
        ) {
          throw new Error(
            'Expected disallowed-kind relation to remain unresolved.',
          );
        }

        expect(
          conversion.reason,
        ).toBe(
          'legacy-relation-target-kind-not-permitted',
        );

        expect(
          conversion.relationTargets,
        ).toEqual([
          {
            legacyLink:
              '[[target-task]]',
            linkPath:
              'target-task',
            resolution:
              'kind-not-permitted',
            candidateRecordIds: [
              recordIdForPath(
                result,
                'Proxima/tasks/target-task.md',
              ),
            ],
          },
        ]);
      },
    );

    it(
      'leaves a relation schema and value pending when the legacy target folder is not an exact configured Proxima record directory',
      async () => {
        const result =
          await plan(
            {
              'Proxima/tasks/source.md': [
                '---',
                'id: source',
                'related: "[[target]]"',
                '---',
                '',
              ].join('\n'),
              'Proxima/tasks/target.md': [
                '---',
                'id: target',
                '---',
                '',
              ].join('\n'),
            },
            relationSnapshot(
              'Notes',
            ),
          );

        const schemaConversion =
          result.schemaSettings
            ?.conversions
            .find(
              (candidate) =>
                candidate
                  .legacySchemaId
                === 'related',
            );

        expect(
          schemaConversion,
        ).toMatchObject({
          disposition:
            'pending',
          pending: {
            reason:
              'relation-target-resolution-pending',
            legacyTargetFolder:
              'Notes',
          },
        });

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const conversion =
          requireRelationConversion(
            requireRecord(
              propertyPlan,
              'Proxima/tasks/source.md',
            ),
          );

        expect(
          conversion,
        ).toMatchObject({
          disposition:
            'deferred',
          reason:
            'relation-resolution-pending',
        });

        expect(
          result.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });

        expect(
          propertyPlan.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );
  },
);
