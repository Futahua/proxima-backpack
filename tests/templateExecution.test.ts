/**
 * The template executor's acceptance conditions, as the AUTHOR scoped them on 2026-09-12.
 *
 * The tests below check the seven things that slice was accepted against: zero calls when preflight
 * refuses, the exact semantic requests emitted, deterministic output with an injected clock, a refusal
 * reported as partial rather than complete, no RecordStore anywhere in the module, refusing rather than
 * dropping a field whose canonical meaning is undecided, and no id allocation of the executor's own.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixedClock } from '../src/domain/clock.js';
import type { OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { parseTemplatePlan } from '../src/app/templateComposer.js';
import { executeTemplatePlan, TEMPLATE_EXECUTION_SCHEMA_VERSION } from '../src/app/templateExecution.js';
import type { CreateTaskRequest, TaskMutationResult } from '../src/app/taskMutations.js';

const PROJECT = 'pxr_11111111111111111111111111111111' as OpaqueRecordId;

function recorder() {
  const requests: CreateTaskRequest[] = [];
  let failOn: number | null = null;
  let refusalDetail = 'the write was refused';
  let serial = 0;
  const port = {
    async createTask(request: CreateTaskRequest): Promise<TaskMutationResult> {
      requests.push(request);
      serial += 1;
      if (failOn !== null && requests.length === failOn) {
        return {
          ok: false,
          schemaVersion: 1 as never,
          reason: 'validation-refused',
          detail: refusalDetail,
        } as TaskMutationResult;
      }
      const recordId = `pxr_${String(serial).padStart(32, '0')}` as OpaqueRecordId;
      return {
        ok: true,
        schemaVersion: 1 as never,
        outcome: 'created',
        recordId,
        revision: `rev-${serial}`,
        record: null,
      } as unknown as TaskMutationResult;
    },
  };
  return {
    port,
    requests,
    failAt(index: number, detail?: string) {
      failOn = index;
      if (detail) refusalDetail = detail;
    },
  };
}

const clock = fixedClock('2026-09-12T09:00:00+07:00');

describe('template execution', () => {
  it('refuses an invalid plan with zero calls', async () => {
    const sink = recorder();
    const plan = parseTemplatePlan('  weight: 3\nWrite the brief\n');
    expect(plan.errors.length).toBeGreaterThan(0);

    const outcome = await executeTemplatePlan({ plan, tasks: sink.port, clock });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('plan-invalid');
      expect(outcome.refusal.detail).toMatch(/line 1/);
    }
    expect(sink.requests.length).toBe(0);
  });

  it('emits exactly the ordinary create requests, in order', async () => {
    const sink = recorder();
    const plan = parseTemplatePlan(
      'Write the brief\n  weight: 3\n  start: 2026-09-01\n  deadline: 2026-09-30\n  fixed: 45\n  max: 90\nDraft the outline\n',
    );
    expect(plan.errors).toEqual([]);

    const outcome = await executeTemplatePlan({ plan, tasks: sink.port, clock, projectId: PROJECT });

    expect(outcome.kind).toBe('complete');
    expect(sink.requests).toEqual([
      {
        name: 'Write the brief',
        projectId: PROJECT,
        weight: 3,
        startDate: '2026-09-01',
        deadline: '2026-09-30',
        isFixedDuration: true,
        fixedDuration: 45,
        maxDuration: 90,
      },
      {
        name: 'Draft the outline',
        projectId: PROJECT,
        startDate: null,
        deadline: null,
      },
    ]);
    if (outcome.kind === 'complete') {
      expect(outcome.created).toHaveLength(2);
      expect(outcome.schemaVersion).toBe(TEMPLATE_EXECUTION_SCHEMA_VERSION);
    }
  });

  it('refuses a custom property, whose canonical value shape is a decision nobody has made', async () => {
    const sink = recorder();
    const plan = parseTemplatePlan('Write the brief\n  property.area: writing\n');
    expect(plan.errors).toEqual([]);

    const outcome = await executeTemplatePlan({ plan, tasks: sink.port, clock });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('untranslatable-draft-field');
      expect(outcome.refusal.detail).toMatch(/properties/);
    }
    // A field it cannot translate stops the batch before the first call.\n    expect(sink.requests.length).toBe(0);
  });

  it('refuses a draft field whose canonical meaning is undecided, before any call', async () => {
    const sink = recorder();
    const plan = parseTemplatePlan('Write the brief\n  status: doing\nDraft the outline\n');
    expect(plan.errors).toEqual([]);

    const outcome = await executeTemplatePlan({ plan, tasks: sink.port, clock });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('untranslatable-draft-field');
      expect(outcome.refusal.detail).toMatch(/status/);
      // The draft line is the line its name is on, not the line of the field.\n      expect(outcome.refusal.line).toBe(1);
      expect(outcome.refusal.name).toBe('Write the brief');
    }
    expect(sink.requests.length).toBe(0);
  });

  it('reports a refusal after a creation as partial, never as complete', async () => {
    const sink = recorder();
    const plan = parseTemplatePlan('First\nSecond\nThird\n');
    sink.failAt(2, 'a task with that name already exists');

    const outcome = await executeTemplatePlan({ plan, tasks: sink.port, clock });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind === 'partial') {
      expect(outcome.created).toHaveLength(1);
      expect(outcome.refusal.reason).toBe('creation-refused');
      expect(outcome.refusal.name).toBe('Second');
      expect(outcome.refusal.detail).toBe('a task with that name already exists');
    }
    expect(sink.requests.map((request) => request.name)).toEqual(['First', 'Second']);
  });

  it('refuses without creating anything when the first creation is refused', async () => {
    const sink = recorder();
    const plan = parseTemplatePlan('First\nSecond\n');
    sink.failAt(1);

    const outcome = await executeTemplatePlan({ plan, tasks: sink.port, clock });

    expect(outcome.kind).toBe('refused');
    expect(sink.requests.map((request) => request.name)).toEqual(['First']);
  });

  it('is deterministic: the same plan run twice produces the same outcome', async () => {
    const plan = parseTemplatePlan('Write the brief\n  weight: 3\nDraft the outline\n');
    const first = recorder();
    const second = recorder();

    const one = await executeTemplatePlan({ plan, tasks: first.port, clock, projectId: PROJECT });
    const two = await executeTemplatePlan({ plan, tasks: second.port, clock, projectId: PROJECT });

    expect(one).toEqual(two);
    expect(first.requests).toEqual(second.requests);
  });

  it('carries no RecordStore authority and allocates no ids of its own', () => {
    const source = readFileSync(new URL('../src/app/templateExecution.ts', import.meta.url), 'utf8');
    // Imports and code only: the module's own doc comment names what it refuses to do, and a scan that
    // counted those words would forbid explaining the rule.
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/recordStore/);
    expect(code).not.toMatch(/RecordStore/);
    expect(code).not.toMatch(/RecordMutationCoordinator/);
    expect(code).not.toMatch(/allocateRecordId/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/ports\//);
  });
});
