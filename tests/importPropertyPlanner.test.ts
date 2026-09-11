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
  LegacyImportPropertyValuePlan,
  LegacyImportRecordPropertyValuePlan,
} from '../src/app/importPropertyPlanner.js';
import type {
  LegacyInterpretedPropertySchemaSettingsSnapshot,
  LegacyImportSchemaIdentityAllocator,
  LegacyImportSchemaScope,
  LegacyImportSchemaSettingsPlan,
} from '../src/app/importSchemaPlanner.js';
import {
  loadVaultState,
} from '../src/app/vaultRepository.js';

function opaque(
  value: number,
): string {
  return `pxr_${value
    .toString(16)
    .padStart(
      32,
      '0',
   )}`;
}

function opaqueOption(
  value: number,
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
        opaque(next);
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

async function plan(
  files:
    Record<string, string>,
  snapshot:
    LegacyInterpretedPropertySchemaSettingsSnapshot,
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

function requireSchemaPlan(
  value:
    LegacyImportSchemaSettingsPlan | null,
): LegacyImportSchemaSettingsPlan {
  if (value === null) {
    throw new Error(
      'Expected schema/settings plan.',
    );
  }
  return value;
}

function requireRecord(
  planValue:
    LegacyImportPropertyValuePlan,
  sourcePath:
    string,
): LegacyImportRecordPropertyValuePlan {
  const record =
    planValue.records.find(
      (candidate) =>
        candidate.sourcePath
        === sourcePath,
    );

  if (record === undefined) {
    throw new Error(
      `Missing property-value record for ${sourcePath}.`,
    );
  }

  return record;
}

function scopeMatches(
  actual:
    LegacyImportSchemaScope,
  kind:
    LegacyImportSchemaScope['kind'],
  legacyProjectId?:
    string,
): boolean {
  if (
    actual.kind
    !== kind
  ) {
    return false;
  }

  return (
    actual.kind
    === 'task-schema'
    || actual.legacyProjectId
      === legacyProjectId
  );
}

function schemaRecordId(
  planValue:
    LegacyImportSchemaSettingsPlan,
  kind:
    LegacyImportSchemaScope['kind'],
  legacySchemaId:
    string,
  legacyProjectId?:
    string,
) {
  const entry =
    planValue.identityMapping
      .schemaEntries
      .find(
        (candidate) =>
          candidate.legacySchemaId
            === legacySchemaId
          && scopeMatches(
            candidate.scope,
            kind,
            legacyProjectId,
          ),
      );

  if (entry === undefined) {
    throw new Error(
      `Missing schema identity for ${legacySchemaId}.`,
    );
  }

  return entry.recordId;
}

function optionId(
  planValue:
    LegacyImportSchemaSettingsPlan,
  kind:
    LegacyImportSchemaScope['kind'],
  legacySchemaId:
    string,
  legacyOptionId:
    string,
  legacyProjectId?:
    string,
) {
  const entry =
    planValue.identityMapping
      .optionEntries
      .find(
        (candidate) =>
          candidate.legacySchemaId
            === legacySchemaId
          && candidate.legacyOptionId
            === legacyOptionId
          && scopeMatches(
            candidate.scope,
            kind,
            legacyProjectId,
          ),
      );

  if (entry === undefined) {
    throw new Error(
      `Missing option identity for ${legacySchemaId}/${legacyOptionId}.`,
    );
  }

  return entry.optionId;
}

describe(
  'Stage 8 slice 5 legacy custom-property value conversion planning',
  () => {
    it(
      'captures interpreted task/event frontmatter for import without changing ordinary compatibility properties',
      async () => {
        const loaded =
          await loadVaultState(
            createMemoryVault({
              'Proxima/projects/alpha.md': [
                '---',
                'id: alpha',
                'type: project',
                'name: Alpha',
                '---',
                '',
              ].join('\n'),
              'Proxima/tasks/task.md': [
                '---',
                'id: task-a',
                'project: alpha',
                'effort: 3',
                'ready: true',
                'tags: [bug, ui]',
                '---',
                '',
              ].join('\n'),
              'Proxima/events/event.md': [
                '---',
                'id: event-a',
                'project: alpha',
                'mood: focused',
                '---',
                '',
              ].join('\n'),
            }),
          );

        const project =
          loaded.physicalCandidates
            .find(
              (candidate) =>
                candidate.kind
                === 'project',
            );
        const task =
          loaded.physicalCandidates
            .find(
              (candidate) =>
                candidate.kind
                === 'task',
            );
        const event =
          loaded.physicalCandidates
            .find(
              (candidate) =>
                candidate.kind
                === 'event',
            );

        expect(
          project?.compatibility
            .propertyValues,
        ).toBeNull();

        expect(
          task?.compatibility
            .propertyValues,
        ).toMatchObject({
          effort: 3,
          ready: true,
          tags: [
            'bug',
            'ui',
          ],
        });

        expect(
          event?.compatibility
            .propertyValues,
        ).toMatchObject({
          mood:
            'focused',
        });

        expect(
          loaded.state.tasks[0]
            ?.properties,
        ).toEqual({});

        expect(
          loaded.state.events[0]
            ?.properties,
        ).toEqual({});
      },
    );

    it(
      'maps primitive and select families to canonical schema/option identities without label identity leakage',
      async () => {
        const snapshot:
          LegacyInterpretedPropertySchemaSettingsSnapshot = {
            taskSchema: [
              {
                id:
                  'title_text',
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
                  'priority',
                name:
                  'Priority',
                type:
                  'select',
                options: [
                  {
                    id:
                      'p1',
                    name:
                      'P1',
                    color:
                      '#111111',
                  },
                  {
                    id:
                      'needs-review',
                    name:
                      'Needs Review',
                    color:
                      '#222222',
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
                      'bug',
                    name:
                      'Bug',
                    color:
                      '#333333',
                  },
                  {
                    id:
                      'ui',
                    name:
                      'UI',
                    color:
                      '#444444',
                  },
                ],
              },
            ],
            projectSchemas: {},
          };

        const result =
          await plan(
            {
              'Proxima/tasks/task.md': [
                '---',
                'id: task-a',
                'title_text: Hello',
                'effort: 3.5',
                'when: 2026-09-20',
                'ready: true',
                'priority: Needs Review',
                'tags: [bug, UI]',
                '---',
                '',
              ].join('\n'),
            },
            snapshot,
          );

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const schemaPlan =
          requireSchemaPlan(
            result.schemaSettings,
          );
        const record =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/task.md',
          );

        expect(
          result.schemaVersion,
        ).toBe(5);

        expect(
          record.schemaScope,
        ).toEqual({
          kind:
            'task-schema',
        });

        expect(
          record.canonicalReadyValues,
        ).toEqual({
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'title_text',
          )]: {
            type:
              'text',
            value:
              'Hello',
          },
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'effort',
          )]: {
            type:
              'number',
            value:
              3.5,
          },
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'when',
          )]: {
            type:
              'date',
            value:
              '2026-09-20',
          },
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'ready',
          )]: {
            type:
              'checkbox',
            value:
              true,
          },
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'priority',
          )]: {
            type:
              'select',
            optionId:
              optionId(
                schemaPlan,
                'task-schema',
                'priority',
                'needs-review',
              ),
          },
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'tags',
          )]: {
            type:
              'multi-select',
            optionIds: [
              optionId(
                schemaPlan,
                'task-schema',
                'tags',
                'bug',
              ),
              optionId(
                schemaPlan,
                'task-schema',
                'tags',
                'ui',
              ),
            ],
          },
        });

        expect(
          propertyPlan.counts,
        ).toEqual({
          records: 1,
          taskRecords: 1,
          eventRecords: 0,
          schemaBoundTaskRecords: 1,
          untypedEventRecords: 0,
          schemaProperties: 6,
          canonicalReady: 6,
          absent: 0,
          deferred: 0,
          unresolved: 0,
        });
      },
    );

    it(
      'keeps task schema scopes isolated and captures event values without inventing event schema authority',
      async () => {
        const snapshot:
          LegacyInterpretedPropertySchemaSettingsSnapshot = {
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
                      'global',
                    name:
                      'Global',
                    color:
                      '#111111',
                  },
                ],
              },
            ],
            projectSchemas: {
              alpha: [
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
                        'local',
                      name:
                        'Local',
                      color:
                        '#222222',
                    },
                  ],
                },
              ],
            },
          };

        const result =
          await plan(
            {
              'Proxima/projects/alpha.md': [
                '---',
                'id: alpha',
                'type: project',
                '---',
                '',
              ].join('\n'),
              'Proxima/tasks/global.md': [
                '---',
                'id: global-task',
                'priority: global',
                '---',
                '',
              ].join('\n'),
              'Proxima/tasks/project.md': [
                '---',
                'id: project-task',
                'project: alpha',
                'priority: local',
                '---',
                '',
              ].join('\n'),
              'Proxima/events/event.md': [
                '---',
                'id: event-a',
                'project: alpha',
                'mood: focused',
                '---',
                '',
              ].join('\n'),
            },
            snapshot,
          );

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const schemaPlan =
          requireSchemaPlan(
            result.schemaSettings,
          );
        const globalTask =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/global.md',
          );
        const projectTask =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/project.md',
          );
        const event =
          requireRecord(
            propertyPlan,
            'Proxima/events/event.md',
          );

        expect(
          globalTask.schemaScope,
        ).toEqual({
          kind:
            'task-schema',
        });

        expect(
          globalTask
            .canonicalReadyValues,
        ).toEqual({
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'priority',
          )]: {
            type:
              'select',
            optionId:
              optionId(
                schemaPlan,
                'task-schema',
                'priority',
                'global',
              ),
          },
        });

        expect(
          projectTask.schemaScope,
        ).toEqual({
          kind:
            'project-schema',
          legacyProjectId:
            'alpha',
        });

        expect(
          projectTask
            .canonicalReadyValues,
        ).toEqual({
          [schemaRecordId(
            schemaPlan,
            'project-schema',
            'priority',
            'alpha',
          )]: {
            type:
              'select',
            optionId:
              optionId(
                schemaPlan,
                'project-schema',
                'priority',
                'local',
                'alpha',
              ),
          },
        });

        expect(
          event.schemaDisposition,
        ).toBe(
          'legacy-event-properties-untyped',
        );

        expect(
          event.schemaScope,
        ).toBeNull();

        expect(
          event.legacyPropertyValues,
        ).toMatchObject({
          mood:
            'focused',
        });

        expect(
          event.conversions,
        ).toEqual([]);

        expect(
          event.canonicalReadyValues,
        ).toEqual({});

        expect(
          propertyPlan.counts,
        ).toMatchObject({
          records: 3,
          taskRecords: 2,
          eventRecords: 1,
          schemaBoundTaskRecords: 2,
          untypedEventRecords: 1,
        });
      },
    );

    it(
      'refuses malformed relation and ordinary values while deferring derived families instead of guessing',
      async () => {
        const snapshot:
          LegacyInterpretedPropertySchemaSettingsSnapshot = {
            taskSchema: [
              {
                id:
                  'wrong_text',
                name:
                  'Wrong Text',
                type:
                  'text',
              },
              {
                id:
                  'wrong_number',
                name:
                  'Wrong Number',
                type:
                  'number',
              },
              {
                id:
                  'bad_date',
                name:
                  'Bad Date',
                type:
                  'date',
              },
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
                      'known',
                    name:
                      'Known',
                    color:
                      '#111111',
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
                      'bug',
                    name:
                      'Bug',
                    color:
                      '#222222',
                  },
                ],
              },
              {
                id:
                  'related',
                name:
                  'Related',
                type:
                  'relation',
                targetFolder:
                  'Proxima/tasks',
              },
              {
                id:
                  'total',
                name:
                  'Total',
                type:
                  'rollup',
                relationProperty:
                  'related',
                targetProperty:
                  'points',
                aggregation:
                  'sum',
              },
              {
                id:
                  'calc',
                name:
                  'Calc',
                type:
                  'formula',
                expression:
                  "prop('points') * 2",
              },
            ],
            projectSchemas: {},
          };

        const result =
          await plan(
            {
              'Proxima/tasks/task.md': [
                '---',
                'id: task-a',
                'wrong_text: 42',
                'wrong_number: nope',
                'bad_date: not-a-date',
                'priority: mystery',
                'tags: [bug, bug]',
                'related: Other',
                'total: 99',
                'calc: 123',
                '---',
                '',
              ].join('\n'),
            },
            snapshot,
          );

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const record =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/task.md',
          );

        expect(
          record.conversions.map(
            (conversion) => [
              conversion
                .legacySchemaId,
              conversion
                .disposition,
              'reason' in conversion
                ? conversion.reason
                : null,
            ],
          ),
        ).toEqual([
          [
            'wrong_text',
            'unresolved',
            'legacy-value-type-mismatch',
          ],
          [
            'wrong_number',
            'unresolved',
            'legacy-value-type-mismatch',
          ],
          [
            'bad_date',
            'unresolved',
            'legacy-date-invalid',
          ],
          [
            'priority',
            'unresolved',
            'legacy-option-unresolved',
          ],
          [
            'tags',
            'unresolved',
            'duplicate-option-selection',
          ],
          [
            'related',
            'unresolved',
            'legacy-relation-link-invalid',
          ],
          [
            'total',
            'deferred',
            'rollup-derivation-pending',
          ],
          [
            'calc',
            'deferred',
            'formula-derivation-pending',
          ],
        ]);

        expect(
          record.canonicalReadyValues,
        ).toEqual({});

        expect(
          propertyPlan.counts,
        ).toMatchObject({
          schemaProperties: 8,
          canonicalReady: 0,
          absent: 0,
          deferred: 2,
          unresolved: 6,
        });
      },
    );

    it(
      'preserves legacy empty-value behavior for absent ordinary values and remains zero-write',
      async () => {
        const snapshot:
          LegacyInterpretedPropertySchemaSettingsSnapshot = {
            taskSchema: [
              {
                id:
                  'note',
                name:
                  'Note',
                type:
                  'text',
              },
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
                      'p1',
                    name:
                      'P1',
                    color:
                      '#111111',
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
                      'bug',
                    name:
                      'Bug',
                    color:
                      '#222222',
                  },
                ],
              },
            ],
            projectSchemas: {},
          };

        const result =
          await plan(
            {
              'Proxima/tasks/task.md': [
                '---',
                'id: task-a',
                'priority: ""',
                '---',
                '',
              ].join('\n'),
            },
            snapshot,
          );

        const propertyPlan =
          requirePropertyPlan(
            result.propertyValues,
          );
        const schemaPlan =
          requireSchemaPlan(
            result.schemaSettings,
          );
        const record =
          requireRecord(
            propertyPlan,
            'Proxima/tasks/task.md',
          );

        expect(
          record.conversions.map(
            (conversion) => [
              conversion
                .legacySchemaId,
              conversion
                .disposition,
            ],
          ),
        ).toEqual([
          [
            'note',
            'absent',
          ],
          [
            'priority',
            'absent',
          ],
          [
            'tags',
            'canonical-ready',
          ],
        ]);

        expect(
          record.canonicalReadyValues,
        ).toEqual({
          [schemaRecordId(
            schemaPlan,
            'task-schema',
            'tags',
          )]: {
            type:
              'multi-select',
            optionIds: [],
          },
        });

        expect(
          propertyPlan.counts,
        ).toMatchObject({
          schemaProperties: 3,
          canonicalReady: 1,
          absent: 2,
          deferred: 0,
          unresolved: 0,
        });

        expect(
          propertyPlan.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });

        expect(
          result.writes,
        ).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );
  },
);
