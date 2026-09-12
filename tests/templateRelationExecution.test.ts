import { describe, expect, it } from 'vitest';
import { parseOpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { PropertySchema } from '../src/domain/types.js';
import { parseTemplatePlan } from '../src/app/templateComposer.js';
import { executeTemplatePlan } from '../src/app/templateExecution.js';
import { TASK_MUTATION_SCHEMA_VERSION, type TaskMutationResult } from '../src/app/taskMutations.js';

const FIRST = parseOpaqueRecordId('pxr_00000000000000000000000000000001');
const SECOND = parseOpaqueRecordId('pxr_00000000000000000000000000000002');
const THIRD = parseOpaqueRecordId('pxr_00000000000000000000000000000003');
const RELATION = parseOpaqueRecordId('pxr_000000000000000000000000000000aa');

const schema: PropertySchema = {
  id: RELATION,
  name: 'Depends on',
  type: 'relation',
  relationProperty: 'depends-on',
};

function success(
  outcome: 'created' | 'updated',
  recordId: typeof FIRST,
  revision: string,
): TaskMutationResult {
  return {
    ok: true,
    schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
    outcome,
    recordId,
    revision,
    record: null,
  };
}

describe('D86 template-local relations', () => {
  it('creates every task first, then stores the returned opaque ids rather than @N tokens', async () => {
    const plan = parseTemplatePlan([
      'Alpha',
      `  property.${RELATION}: @2, @3`,
      'Beta',
      'Gamma',
    ].join('\n'));

    const ids = [FIRST, SECOND, THIRD] as const;
    let created = 0;
    const updates: unknown[] = [];

    const result = await executeTemplatePlan({
      plan,
      schemas: [schema],
      tasks: {
        createTask: async () => {
          const index = created++;
          return success('created', ids[index]!, `r${index + 1}`);
        },
        updateTask: async (input) => {
          updates.push(input);
          return success('updated', input.taskId, 'r4');
        },
      },
    });

    expect(result).toEqual({
      kind: 'complete',
      schemaVersion: 1,
      created: [FIRST, SECOND, THIRD],
    });

    expect(updates).toEqual([{
      taskId: FIRST,
      expectedRevision: 'r1',
      mutations: [{
        kind: 'property',
        key: RELATION,
        value: {
          type: 'relation',
          value: {
            relationSchemaId: RELATION,
            targetRecordIds: [SECOND, THIRD],
          },
        },
      }],
    }]);

    expect(JSON.stringify(updates)).not.toContain('@2');
    expect(JSON.stringify(updates)).not.toContain('@3');
  });

  it('refuses an invalid local target before the first create', async () => {
    const plan = parseTemplatePlan([
      'Alpha',
      `  property.${RELATION}: @3`,
      'Beta',
    ].join('\n'));

    let calls = 0;
    const result = await executeTemplatePlan({
      plan,
      schemas: [schema],
      tasks: {
        createTask: async () => {
          calls += 1;
          return success('created', FIRST, 'r1');
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'refused',
      refusal: {
        reason: 'plan-invalid',
      },
    });
    expect(calls).toBe(0);
  });
});
