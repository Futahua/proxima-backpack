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
} from '../src/app/importPlanner.js';
import {
  planLegacySchemaSettings,
  readLegacyImportSchemaIdentityMapping,
  writeLegacyImportSchemaIdentityMapping,
  type LegacyImportSchemaIdentityAllocator,
  type LegacyImportSchemaIdentityMappingManifest,
  type LegacyImportSchemaIdentityMappingStore,
} from '../src/app/importSchemaPlanner.js';
import {
  parseOpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';

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

function sequentialSchemaAllocator(
  firstRecord:
    number = 100,
): LegacyImportSchemaIdentityAllocator {
  let nextRecord =
    firstRecord;

  let nextOption =
    1;

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

class MemorySchemaIdentityMappingStore
implements LegacyImportSchemaIdentityMappingStore {
  private mapping:
    LegacyImportSchemaIdentityMappingManifest | null =
      null;

  saves = 0;

  async load():
    Promise<
      LegacyImportSchemaIdentityMappingManifest | null
    > {
    return this.mapping === null
      ? null
      : JSON.parse(
          JSON.stringify(
            this.mapping,
          ),
        ) as LegacyImportSchemaIdentityMappingManifest;
  }

  async save(
    mapping:
      LegacyImportSchemaIdentityMappingManifest,
  ): Promise<void> {
    this.mapping =
      JSON.parse(
        JSON.stringify(
          mapping,
        ),
      ) as LegacyImportSchemaIdentityMappingManifest;

    this.saves += 1;
  }
}

describe(
  'Stage 8 slice 4 schema/settings conversion planning',
  () => {
    it(
      'produces canonical-ready primitive, select, multi-select, and non-empty formula schema records while keeping option colors local-only',
      () => {
        const plan =
          planLegacySchemaSettings({
            snapshot: {
              taskSchema: [
                {
                  id:
                    'title-text',
                  name:
                    'Title Text',
                  type:
                    'text',
                },
                {
                  id:
                    'effort',
                  name:
                    'Effort',
                  type:
                    'number',
                },
                {
                  id:
                    'when',
                  name:
                    'When',
                  type:
                    'date',
                },
                {
                  id:
                    'ready',
                  name:
                    'Ready',
                  type:
                    'checkbox',
                },
                {
                  id:
                    'choice',
                  name:
                    'Choice',
                  type:
                    'select',
                  options: [
                    {
                      id:
                        'option-a',
                      name:
                        'A',
                      color:
                        '#ff0000',
                    },
                    {
                      id:
                        'option-b',
                      name:
                        'B',
                      color:
                        '#00ff00',
                    },
                  ],
                },
                {
                  id:
                    'tags',
                  name:
                    'Tags',
                  type:
                    'multi-select',
                  options: [
                    {
                      id:
                        'option-c',
                      name:
                        'C',
                      color:
                        '#0000ff',
                    },
                  ],
                },
                {
                  id:
                    'score',
                  name:
                    'Score',
                  type:
                    'formula',
                  expression:
                    'effort * 2',
                },
              ],
              projectSchemas: {},
            },
            allocator:
              sequentialSchemaAllocator(),
          });

        expect(
          plan.counts,
        ).toEqual({
          schemaCandidates: 7,
          canonicalReady: 7,
          pending: 0,
          optionCandidates: 3,
          optionColors: 3,
        });

        expect(
          plan.conversions.find(
            (conversion) =>
              conversion.legacySchemaId
              === 'choice',
          ),
        ).toMatchObject({
          disposition:
            'canonical-ready',
          record: {
            id:
              opaque(
                104,
              ),
            name:
              'Choice',
            definition: {
              type:
                'select',
              options: [
                {
                  id:
                    opaqueOption(
                      1,
                    ),
                  label:
                    'A',
                },
                {
                  id:
                    opaqueOption(
                      2,
                    ),
                  label:
                    'B',
                },
              ],
            },
          },
        });

        expect(
          plan.conversions.find(
            (conversion) =>
              conversion.legacySchemaId
              === 'tags',
          ),
        ).toMatchObject({
          disposition:
            'canonical-ready',
          record: {
            id:
              opaque(
                105,
              ),
            definition: {
              type:
                'multi-select',
              options: [
                {
                  id:
                    opaqueOption(
                      3,
                    ),
                  label:
                    'C',
                },
              ],
            },
          },
        });

        expect(
          plan.conversions.find(
            (conversion) =>
              conversion.legacySchemaId
              === 'score',
          ),
        ).toMatchObject({
          disposition:
            'canonical-ready',
          record: {
            id:
              opaque(
                106,
              ),
            definition: {
              type:
                'formula',
              expression:
                'effort * 2',
            },
          },
        });

        expect(
          JSON.stringify(
            plan.conversions,
          ),
        ).not.toContain(
          '#ff0000',
        );

        expect(
          plan.presentation,
        ).toEqual({
          category:
            'local-state',
          optionColors: [
            {
              schemaId:
                opaque(
                  104,
                ),
              optionId:
                opaqueOption(
                  1,
                ),
              color:
                '#ff0000',
            },
            {
              schemaId:
                opaque(
                  104,
                ),
              optionId:
                opaqueOption(
                  2,
                ),
              color:
                '#00ff00',
            },
            {
              schemaId:
                opaque(
                  105,
                ),
              optionId:
                opaqueOption(
                  3,
                ),
              color:
                '#0000ff',
            },
          ],
        });

        expect(
          plan.writes,
        ).toEqual({
          legacySettings: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );

    it(
      'keeps relation targets, rollup property-name references, and incomplete formulas explicitly pending',
      () => {
        const plan =
          planLegacySchemaSettings({
            snapshot: {
              taskSchema: [
                {
                  id:
                    'relation',
                  name:
                    'Assignee',
                  type:
                    'relation',
                  targetFolder:
                    'People',
                },
                {
                  id:
                    'rollup',
                  name:
                    'Hours Rollup',
                  type:
                    'rollup',
                  relationProperty:
                    'assignee',
                  targetProperty:
                    'hours',
                  aggregation:
                    'sum',
                },
                {
                  id:
                    'unfinished-formula',
                  name:
                    'Unfinished Formula',
                  type:
                    'formula',
                  expression:
                    '   ',
                },
              ],
              projectSchemas: {},
            },
            allocator:
              sequentialSchemaAllocator(),
          });

        expect(
          plan.conversions,
        ).toEqual([
          {
            disposition:
              'pending',
            scope: {
              kind:
                'task-schema',
            },
            legacySchemaId:
              'relation',
            recordId:
              opaque(
                100,
              ),
            name:
              'Assignee',
            pending: {
              reason:
                'relation-target-resolution-pending',
              legacyTargetFolder:
                'People',
            },
          },
          {
            disposition:
              'pending',
            scope: {
              kind:
                'task-schema',
            },
            legacySchemaId:
              'rollup',
            recordId:
              opaque(
                101,
              ),
            name:
              'Hours Rollup',
            pending: {
              reason:
                'rollup-property-reference-resolution-pending',
              legacyRelationProperty:
                'assignee',
              legacyTargetProperty:
                'hours',
              aggregation:
                'sum',
            },
          },
          {
            disposition:
              'pending',
            scope: {
              kind:
                'task-schema',
            },
            legacySchemaId:
              'unfinished-formula',
            recordId:
              opaque(
                102,
              ),
            name:
              'Unfinished Formula',
            pending: {
              reason:
                'formula-expression-incomplete',
              legacyExpression:
                '   ',
            },
          },
        ]);

        expect(
          plan.counts,
        ).toMatchObject({
          canonicalReady: 0,
          pending: 3,
        });

        expect(
          plan.conversions.every(
            (conversion) =>
              conversion.disposition
                === 'pending'
              && !(
                'record'
                in conversion
              ),
          ),
        ).toBe(true);
      },
    );

    it(
      'reuses durable schema and option identities across schema-name, option-label, color, and ordering changes',
      () => {
        const first =
          planLegacySchemaSettings({
            snapshot: {
              taskSchema: [
                {
                  id:
                    'priority',
                  name:
                    'Priority',
                  type:
                    'select',
                  options: [
                    {
                      id:
                        'high',
                      name:
                        'High',
                      color:
                        '#ff0000',
                    },
                    {
                      id:
                        'low',
                      name:
                        'Low',
                      color:
                        '#00ff00',
                    },
                  ],
                },
              ],
              projectSchemas: {},
            },
            allocator:
              sequentialSchemaAllocator(),
          });

        const second =
          planLegacySchemaSettings({
            snapshot: {
              taskSchema: [
                {
                  id:
                    'priority',
                  name:
                    'Importance',
                  type:
                    'select',
                  options: [
                    {
                      id:
                        'low',
                      name:
                        'Later',
                      color:
                        '#111111',
                    },
                    {
                      id:
                        'high',
                      name:
                        'Now',
                      color:
                        '#222222',
                    },
                  ],
                },
              ],
              projectSchemas: {},
            },
            allocator: {
              schemaRecordIdFor() {
                throw new Error(
                  'existing schema identity must be reused',
                );
              },
              schemaOptionIdFor() {
                throw new Error(
                  'existing option identity must be reused',
                );
              },
            },
            priorIdentityMapping:
              first.identityMapping,
          });

        expect(
          second.identityMapping,
        ).toEqual(
          first.identityMapping,
        );

        expect(
          second.conversions[0],
        ).toMatchObject({
          disposition:
            'canonical-ready',
          record: {
            id:
              opaque(
                100,
              ),
            name:
              'Importance',
            definition: {
              type:
                'select',
              options: [
                {
                  id:
                    opaqueOption(
                      2,
                    ),
                  label:
                    'Later',
                },
                {
                  id:
                    opaqueOption(
                      1,
                    ),
                  label:
                    'Now',
                },
              ],
            },
          },
        });

        expect(
          second.presentation
            .optionColors,
        ).toEqual([
          {
            schemaId:
              opaque(
                100,
              ),
            optionId:
              opaqueOption(
                2,
              ),
            color:
              '#111111',
          },
          {
            schemaId:
              opaque(
                100,
              ),
            optionId:
              opaqueOption(
                1,
              ),
            color:
              '#222222',
          },
        ]);
      },
    );

    it(
      'keeps identical legacy schema and option aliases distinct across task and project settings scopes',
      () => {
        const plan =
          planLegacySchemaSettings({
            snapshot: {
              taskSchema: [
                {
                  id:
                    'priority',
                  name:
                    'Task Priority',
                  type:
                    'select',
                  options: [
                    {
                      id:
                        'high',
                      name:
                        'High',
                      color:
                        '#111111',
                    },
                  ],
                },
              ],
              projectSchemas: {
                'project-b': [
                  {
                    id:
                      'priority',
                    name:
                      'B Priority',
                    type:
                      'select',
                    options: [
                      {
                        id:
                          'high',
                        name:
                          'High',
                        color:
                          '#222222',
                      },
                    ],
                  },
                ],
                'project-a': [
                  {
                    id:
                      'priority',
                    name:
                      'A Priority',
                    type:
                      'select',
                    options: [
                      {
                        id:
                          'high',
                        name:
                          'High',
                        color:
                          '#333333',
                      },
                    ],
                  },
                ],
              },
            },
            allocator:
              sequentialSchemaAllocator(),
          });

        expect(
          plan.conversions.map(
            (conversion) =>
              conversion.scope,
          ),
        ).toEqual([
          {
            kind:
              'task-schema',
          },
          {
            kind:
              'project-schema',
            legacyProjectId:
              'project-a',
          },
          {
            kind:
              'project-schema',
            legacyProjectId:
              'project-b',
          },
        ]);

        expect(
          new Set(
            plan.identityMapping
              .schemaEntries
              .map(
                (entry) =>
                  entry.recordId,
              ),
          ).size,
        ).toBe(3);

        expect(
          new Set(
            plan.identityMapping
              .optionEntries
              .map(
                (entry) =>
                  entry.optionId,
              ),
          ).size,
        ).toBe(3);
      },
    );

    it(
      'refuses a schema allocator result that collides with an already claimed canonical record identity',
      () => {
        expect(
          () =>
            planLegacySchemaSettings(
              {
                snapshot: {
                  taskSchema: [
                    {
                      id:
                        'priority',
                      name:
                        'Priority',
                      type:
                        'text',
                    },
                  ],
                  projectSchemas: {},
                },
                allocator:
                  sequentialSchemaAllocator(),
              },
              [
                parseOpaqueRecordId(
                  opaque(
                    100,
                  ),
                ),
              ],
            ),
        ).toThrow(
          /collides with reserved canonical import record identity/,
        );
      },
    );

    it(
      'round-trips the schema identity manifest through its explicit durable mapping boundary',
      async () => {
        const store =
          new MemorySchemaIdentityMappingStore();

        expect(
          await readLegacyImportSchemaIdentityMapping(
            store,
          ),
        ).toBeNull();

        const plan =
          planLegacySchemaSettings({
            snapshot: {
              taskSchema: [
                {
                  id:
                    'priority',
                  name:
                    'Priority',
                  type:
                    'select',
                  options: [
                    {
                      id:
                        'high',
                      name:
                        'High',
                      color:
                        '#ff0000',
                    },
                  ],
                },
              ],
              projectSchemas: {},
            },
            allocator:
              sequentialSchemaAllocator(),
          });

        await writeLegacyImportSchemaIdentityMapping(
          store,
          plan.identityMapping,
        );

        expect(
          store.saves,
        ).toBe(1);

        expect(
          await readLegacyImportSchemaIdentityMapping(
            store,
          ),
        ).toEqual(
          plan.identityMapping,
        );
      },
    );

    it(
      'refuses duplicate schema aliases or duplicate option aliases inside the same interpreted settings scope',
      () => {
        expect(
          () =>
            planLegacySchemaSettings({
              snapshot: {
                taskSchema: [
                  {
                    id:
                      'duplicate',
                    name:
                      'First',
                    type:
                      'text',
                  },
                  {
                    id:
                      'duplicate',
                    name:
                      'Second',
                    type:
                      'number',
                  },
                ],
                projectSchemas: {},
              },
              allocator:
                sequentialSchemaAllocator(),
            }),
        ).toThrow(
          /reuses legacy schema id duplicate in the same scope/,
        );

        expect(
          () =>
            planLegacySchemaSettings({
              snapshot: {
                taskSchema: [
                  {
                    id:
                      'select',
                    name:
                      'Select',
                    type:
                      'select',
                    options: [
                      {
                        id:
                          'duplicate-option',
                        name:
                          'First',
                        color:
                          '#111111',
                      },
                      {
                        id:
                          'duplicate-option',
                        name:
                          'Second',
                        color:
                          '#222222',
                      },
                    ],
                  },
                ],
                projectSchemas: {},
              },
              allocator:
                sequentialSchemaAllocator(),
            }),
        ).toThrow(
          /reuses legacy option id duplicate-option within schema select in the same scope/,
        );
      },
    );

    it(
      'attaches the schema/settings dry-run plan to the existing Markdown import plan without adding any write authority',
      async () => {
        const plan =
          await planLegacyMarkdownImport(
            createMemoryVault({
              'Proxima/projects/one.md': [
                '---',
                'id: project-one',
                'type: project',
                'name: Project One',
                '---',
                '',
              ].join(
                '\n',
              ),
            }),
            {
              recordIdFor() {
                return opaque(
                  1,
                );
              },
            },
            {},
            null,
            {
              snapshot: {
                taskSchema: [
                  {
                    id:
                      'effort',
                    name:
                      'Effort',
                    type:
                      'number',
                  },
                ],
                projectSchemas: {},
              },
              allocator:
                sequentialSchemaAllocator(),
            },
          );

        expect(
          plan.schemaVersion,
        ).toBe(3);

        expect(
          plan.mappings,
        ).toHaveLength(
          1,
        );

        expect(
          plan.schemaSettings,
        ).toMatchObject({
          schemaVersion: 1,
          mode:
            'dry-run',
          source:
            'explicitly-interpreted-legacy-property-schema-settings',
          counts: {
            schemaCandidates: 1,
            canonicalReady: 1,
            pending: 0,
          },
          writes: {
            legacySettings: 0,
            recordStore: 0,
            staging: 0,
          },
        });

        expect(
          plan.schemaSettings
            ?.conversions[0],
        ).toMatchObject({
          disposition:
            'canonical-ready',
          legacySchemaId:
            'effort',
          record: {
            id:
              opaque(
                100,
              ),
            kind:
              'schema',
            name:
              'Effort',
            definition: {
              type:
                'number',
            },
          },
        });

        expect(
          plan.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );
  },
);
