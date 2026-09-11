import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createMemoryVault,
} from '../src/adapters/memoryVault.js';
import type {
  LegacyImportDerivedPropertyPlan,
  LegacyImportDerivedValueConversion,
  LegacyImportRollupSchemaPlan,
} from '../src/app/importDerivedPropertyPlanner.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import type {
  LegacyInterpretedPropertySchemaSettingsSnapshot,
  LegacyImportSchemaIdentityAllocator,
  LegacyImportSchemaScope,
} from '../src/app/importSchemaPlanner.js';

function opaque(value: number): string {
  return `pxr_${value.toString(16).padStart(32, '0')}`;
}

function opaqueOption(value: number): string {
  return `pxo_${value.toString(16).padStart(32, '0')}`;
}

function sequentialRecordAllocator(): LegacyImportIdentityAllocator {
  let next = 1;
  return {
    recordIdFor() {
      const id = opaque(next);
      next += 1;
      return id;
    },
  };
}

function sequentialSchemaAllocator(): LegacyImportSchemaIdentityAllocator {
  let nextRecord = 100;
  let nextOption = 1;
  return {
    schemaRecordIdFor() {
      const id = opaque(nextRecord);
      nextRecord += 1;
      return id;
    },
    schemaOptionIdFor() {
      const id = opaqueOption(nextOption);
      nextOption += 1;
      return id;
    },
  };
}

async function plan(
  files: Record<string, string>,
  snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot,
) {
  return planLegacyMarkdownImport(
    createMemoryVault(files),
    sequentialRecordAllocator(),
    {},
    null,
    {
      snapshot,
      allocator: sequentialSchemaAllocator(),
    },
  );
}

function requireDerivedPlan(
  value: LegacyImportDerivedPropertyPlan | null,
): LegacyImportDerivedPropertyPlan {
  if (value === null) {
    throw new Error('Expected derived-property plan.');
  }
  return value;
}

function scopeMatches(
  actual: LegacyImportSchemaScope,
  kind: LegacyImportSchemaScope['kind'],
  legacyProjectId?: string,
): boolean {
  return actual.kind === kind
    && (
      actual.kind === 'task-schema'
      || actual.legacyProjectId === legacyProjectId
    );
}

function schemaRecordId(
  result: Awaited<ReturnType<typeof plan>>,
  legacySchemaId: string,
  kind: LegacyImportSchemaScope['kind'] = 'task-schema',
  legacyProjectId?: string,
) {
  const entry = result.schemaSettings
    ?.identityMapping.schemaEntries.find(
      (candidate) => candidate.legacySchemaId === legacySchemaId
        && scopeMatches(candidate.scope, kind, legacyProjectId),
    );
  if (entry === undefined) {
    throw new Error(`Missing schema identity for ${legacySchemaId}.`);
  }
  return entry.recordId;
}

function recordIdForPath(
  result: Awaited<ReturnType<typeof plan>>,
  sourcePath: string,
) {
  const mapping = result.mappings.find(
    (candidate) => candidate.source.path === sourcePath,
  );
  if (mapping === undefined) {
    throw new Error(`Missing record mapping for ${sourcePath}.`);
  }
  return mapping.recordId;
}

function requireRollupSchema(
  planValue: LegacyImportDerivedPropertyPlan,
  legacySchemaId: string,
  kind: LegacyImportSchemaScope['kind'] = 'task-schema',
  legacyProjectId?: string,
): LegacyImportRollupSchemaPlan {
  const value = planValue.rollupSchemas.find(
    (candidate) => candidate.legacySchemaId === legacySchemaId
      && scopeMatches(candidate.scope, kind, legacyProjectId),
  );
  if (value === undefined) {
    throw new Error(`Missing rollup schema plan for ${legacySchemaId}.`);
  }
  return value;
}

function requireDerivedConversion(
  planValue: LegacyImportDerivedPropertyPlan,
  sourcePath: string,
  legacySchemaId: string,
): LegacyImportDerivedValueConversion {
  const record = planValue.records.find(
    (candidate) => candidate.sourcePath === sourcePath,
  );
  const conversion = record?.conversions.find(
    (candidate) => candidate.legacySchemaId === legacySchemaId,
  );
  if (conversion === undefined) {
    throw new Error(`Missing derived conversion ${sourcePath}/${legacySchemaId}.`);
  }
  return conversion;
}

describe(
  'Stage 8 slice 7 canonical rollup references and derived dry-run planning',
  () => {
    it(
      'resolves rollup relation/target names to canonical schema ids, derives from slice-6 relation ids, and treats stored derived values as evidence only',
      async () => {
        const snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot = {
          taskSchema: [
            {
              id: 'points',
              name: 'Points',
              type: 'number',
            },
            {
              id: 'related',
              name: 'Related',
              type: 'relation',
              targetFolder: 'Proxima/tasks',
            },
            {
              id: 'total',
              name: 'Total',
              type: 'rollup',
              relationProperty: 'Related',
              targetProperty: 'Points',
              aggregation: 'sum',
            },
            {
              id: 'calc',
              name: 'Calc',
              type: 'formula',
              expression: "prop('Points') + prop('Total')",
            },
            {
              id: 'calc2',
              name: 'Calc 2',
              type: 'formula',
              expression: "prop('Calc') + 1",
            },
          ],
          projectSchemas: {},
        };
        const result = await plan(
          {
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              'points: 2',
              'related: "[[target]]"',
              'total: 999',
              'calc: 777',
              'calc2: 888',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/target.md': [
              '---',
              'id: target',
              'points: 5',
              '---',
              '',
            ].join('\n'),
          },
          snapshot,
        );
        const derived = requireDerivedPlan(result.derivedProperties);
        const relationSchemaId = schemaRecordId(result, 'related');
        const pointsSchemaId = schemaRecordId(result, 'points');
        const totalSchemaId = schemaRecordId(result, 'total');
        const calcSchemaId = schemaRecordId(result, 'calc');
        const calc2SchemaId = schemaRecordId(result, 'calc2');
        const targetRecordId = recordIdForPath(
          result,
          'Proxima/tasks/target.md',
        );
        const rollupSchema = requireRollupSchema(derived, 'total');

        expect(result.schemaVersion).toBe(6);
        expect(derived.schemaVersion).toBe(1);
        expect(rollupSchema).toMatchObject({
          disposition: 'canonical-ready',
          legacyRelationProperty: 'Related',
          legacyTargetProperty: 'Points',
          record: {
            id: totalSchemaId,
            definition: {
              type: 'rollup',
              relationSchemaId,
              targetSchemaId: pointsSchemaId,
              aggregation: 'sum',
            },
          },
        });

        const rollup = requireDerivedConversion(
          derived,
          'Proxima/tasks/source.md',
          'total',
        );
        expect(rollup).toEqual({
          scope: { kind: 'task-schema' },
          legacySchemaId: 'total',
          schemaRecordId: totalSchemaId,
          legacyType: 'rollup',
          disposition: 'derived-ready',
          relationSchemaId,
          targetSchemaId: pointsSchemaId,
          targetRecordIds: [targetRecordId],
          aggregation: 'sum',
          value: 5,
          legacyStoredValuePresent: true,
          legacyStoredValue: 999,
          legacyStoredValueAuthority: 'evidence-only-not-authority',
        });

        expect(
          requireDerivedConversion(
            derived,
            'Proxima/tasks/target.md',
            'total',
          ),
        ).toMatchObject({
          legacyType: 'rollup',
          disposition: 'derived-ready',
          targetRecordIds: [],
          value: 0,
          legacyStoredValuePresent: false,
          legacyStoredValueAuthority: 'evidence-only-not-authority',
        });

        const formula = requireDerivedConversion(
          derived,
          'Proxima/tasks/source.md',
          'calc',
        );
        if (formula.legacyType !== 'formula' || formula.disposition !== 'evaluation-planned') {
          throw new Error('Expected formula evaluation plan.');
        }
        expect(formula).toMatchObject({
          expression: "prop('Points') + prop('Total')",
          evaluator: 'expr-eval',
          execution: 'not-run-in-slice-7',
          propLookup: 'first-schema-name-or-id-match',
          directVariableBinding: 'schema-name-in-schema-order-last-write-wins',
          schemaOrdinal: 3,
          priorFormulaSchemaIds: [],
          legacyStoredValuePresent: true,
          legacyStoredValue: 777,
          legacyStoredValueAuthority: 'evidence-only-not-authority',
        });
        expect(formula.bindings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              legacySchemaId: 'points',
              schemaRecordId: pointsSchemaId,
              availability: 'available',
              source: 'canonical-stored',
              canonicalValue: {
                type: 'number',
                value: 2,
              },
            }),
            expect.objectContaining({
              legacySchemaId: 'total',
              schemaRecordId: totalSchemaId,
              availability: 'available',
              source: 'derived-rollup',
              value: 5,
            }),
          ]),
        );

        const secondFormula = requireDerivedConversion(
          derived,
          'Proxima/tasks/source.md',
          'calc2',
        );
        expect(secondFormula).toMatchObject({
          legacyType: 'formula',
          disposition: 'evaluation-planned',
          schemaRecordId: calc2SchemaId,
          expression: "prop('Calc') + 1",
          evaluator: 'expr-eval',
          execution: 'not-run-in-slice-7',
          schemaOrdinal: 4,
          priorFormulaSchemaIds: [calcSchemaId],
          legacyStoredValuePresent: true,
          legacyStoredValue: 888,
          legacyStoredValueAuthority: 'evidence-only-not-authority',
        });

        expect(derived.writes).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
        expect(result.writes).toEqual({
          legacyMarkdown: 0,
          recordStore: 0,
          staging: 0,
        });
      },
    );

    it(
      'keeps missing, ambiguous, and non-relation rollup references explicitly unresolved',
      async () => {
        const snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot = {
          taskSchema: [
            {
              id: 'not_relation',
              name: 'Not Relation',
              type: 'number',
            },
            {
              id: 'rel_a',
              name: 'Related',
              type: 'relation',
              targetFolder: 'Proxima/tasks',
            },
            {
              id: 'rel_b',
              name: 'Related',
              type: 'relation',
              targetFolder: 'Proxima/tasks',
            },
            {
              id: 'points_a',
              name: 'Points',
              type: 'number',
            },
            {
              id: 'points_b',
              name: 'Points',
              type: 'number',
            },
            {
              id: 'label',
              name: 'Label',
              type: 'text',
            },
            {
              id: 'missing_rel',
              name: 'Missing relation',
              type: 'rollup',
              relationProperty: 'Missing',
              targetProperty: 'points_a',
              aggregation: 'sum',
            },
            {
              id: 'ambiguous_rel',
              name: 'Ambiguous relation',
              type: 'rollup',
              relationProperty: 'Related',
              targetProperty: 'points_a',
              aggregation: 'sum',
            },
            {
              id: 'incompatible_rel',
              name: 'Incompatible relation',
              type: 'rollup',
              relationProperty: 'not_relation',
              targetProperty: 'points_a',
              aggregation: 'sum',
            },
            {
              id: 'ambiguous_target',
              name: 'Ambiguous target',
              type: 'rollup',
              relationProperty: 'rel_a',
              targetProperty: 'Points',
              aggregation: 'sum',
            },
            {
              id: 'incompatible_target',
              name: 'Incompatible target',
              type: 'rollup',
              relationProperty: 'rel_a',
              targetProperty: 'label',
              aggregation: 'sum',
            },
          ],
          projectSchemas: {},
        };
        const result = await plan(
          {
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              '---',
              '',
            ].join('\n'),
          },
          snapshot,
        );
        const derived = requireDerivedPlan(result.derivedProperties);

        expect(requireRollupSchema(derived, 'missing_rel')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-relation-reference-missing',
        });
        expect(requireRollupSchema(derived, 'ambiguous_rel')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-relation-reference-ambiguous',
          candidateSchemaRecordIds: [
            schemaRecordId(result, 'rel_a'),
            schemaRecordId(result, 'rel_b'),
          ],
        });
        expect(requireRollupSchema(derived, 'incompatible_rel')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-relation-reference-incompatible',
          candidateSchemaRecordIds: [
            schemaRecordId(result, 'not_relation'),
          ],
        });
        expect(requireRollupSchema(derived, 'ambiguous_target')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-target-reference-ambiguous',
          candidateSchemaRecordIds: [
            schemaRecordId(result, 'points_a'),
            schemaRecordId(result, 'points_b'),
          ],
        });
        expect(requireRollupSchema(derived, 'incompatible_target')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-target-reference-incompatible',
          candidateSchemaRecordIds: [
            schemaRecordId(result, 'label'),
          ],
        });
      },
    );

    it(
      'keeps pending relation schemas, non-task relation target scopes, and derived target properties unresolved instead of guessing',
      async () => {
        const snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot = {
          taskSchema: [
            {
              id: 'unknown_rel',
              name: 'Unknown Rel',
              type: 'relation',
              targetFolder: 'Notes',
            },
            {
              id: 'project_rel',
              name: 'Project Rel',
              type: 'relation',
              targetFolder: 'Proxima/projects',
            },
            {
              id: 'task_rel',
              name: 'Task Rel',
              type: 'relation',
              targetFolder: 'Proxima/tasks',
            },
            {
              id: 'points',
              name: 'Points',
              type: 'number',
            },
            {
              id: 'calc',
              name: 'Calc',
              type: 'formula',
              expression: '1 + 1',
            },
            {
              id: 'unknown_rollup',
              name: 'Unknown Rollup',
              type: 'rollup',
              relationProperty: 'unknown_rel',
              targetProperty: 'points',
              aggregation: 'sum',
            },
            {
              id: 'project_rollup',
              name: 'Project Rollup',
              type: 'rollup',
              relationProperty: 'project_rel',
              targetProperty: 'points',
              aggregation: 'sum',
            },
            {
              id: 'formula_target_rollup',
              name: 'Formula Target Rollup',
              type: 'rollup',
              relationProperty: 'task_rel',
              targetProperty: 'calc',
              aggregation: 'sum',
            },
          ],
          projectSchemas: {},
        };
        const result = await plan(
          {
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              '---',
              '',
            ].join('\n'),
          },
          snapshot,
        );
        const derived = requireDerivedPlan(result.derivedProperties);

        expect(requireRollupSchema(derived, 'unknown_rollup')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-relation-reference-pending',
          relationSchemaId: schemaRecordId(result, 'unknown_rel'),
        });
        expect(requireRollupSchema(derived, 'project_rollup')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-target-scope-incompatible',
          relationSchemaId: schemaRecordId(result, 'project_rel'),
          relationTargetKinds: ['project'],
        });
        expect(requireRollupSchema(derived, 'formula_target_rollup')).toMatchObject({
          disposition: 'unresolved',
          reason: 'legacy-rollup-target-reference-pending',
          relationSchemaId: schemaRecordId(result, 'task_rel'),
          candidateSchemaRecordIds: [
            schemaRecordId(result, 'calc'),
          ],
        });
      },
    );

    it(
      'refuses to apply one project-scoped target schema id to a related task in another project schema scope',
      async () => {
        const schema = [
          {
            id: 'points',
            name: 'Points',
            type: 'number' as const,
          },
          {
            id: 'related',
            name: 'Related',
            type: 'relation' as const,
            targetFolder: 'Proxima/tasks',
          },
          {
            id: 'total',
            name: 'Total',
            type: 'rollup' as const,
            relationProperty: 'related',
            targetProperty: 'points',
            aggregation: 'sum' as const,
          },
        ];
        const snapshot: LegacyInterpretedPropertySchemaSettingsSnapshot = {
          taskSchema: [],
          projectSchemas: {
            alpha: schema,
            beta: schema,
          },
        };
        const result = await plan(
          {
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              '---',
              '',
            ].join('\n'),
            'Proxima/projects/beta.md': [
              '---',
              'id: beta',
              'type: project',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/source.md': [
              '---',
              'id: source',
              'project: alpha',
              'related: "[[target]]"',
              'total: 999',
              '---',
              '',
            ].join('\n'),
            'Proxima/tasks/target.md': [
              '---',
              'id: target',
              'project: beta',
              'points: 5',
              '---',
              '',
            ].join('\n'),
          },
          snapshot,
        );
        const derived = requireDerivedPlan(result.derivedProperties);
        const conversion = requireDerivedConversion(
          derived,
          'Proxima/tasks/source.md',
          'total',
        );

        expect(conversion).toMatchObject({
          legacyType: 'rollup',
          disposition: 'unresolved',
          reason: 'rollup-target-scope-mismatch',
          schemaRecordId: schemaRecordId(
            result,
            'total',
            'project-schema',
            'alpha',
          ),
          targetRecordIds: [
            recordIdForPath(result, 'Proxima/tasks/target.md'),
          ],
          legacyStoredValuePresent: true,
          legacyStoredValue: 999,
          legacyStoredValueAuthority: 'evidence-only-not-authority',
        });
      },
    );
  },
);
