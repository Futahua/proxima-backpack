/**
 * The agent submission boundary, tested the way the AUTHOR asked for it: submit through the entry with no
 * panel and no modal anywhere in the dependency set, and prove the records are created and that the ids
 * returned are the ids of the records that were made.
 *
 * The malformed cases are the other half of the boundary. An agent's input is untrusted shape, so every way
 * of getting the outer form wrong must be rejected *before* the execution machinery runs at all - which is
 * asserted with a counting port rather than by reading the code.
 */
import { describe, expect, it } from 'vitest';

import {
  parseTemplateExecuteSubmission,
  submitTemplateExecution,
  type TemplateExecuteSubmission,
} from '../src/app/templateSubmission.js';
import type { TemplateExecuteDependencies } from '../src/app/templateExecuteAction.js';
import type { CreateTaskRequest, TaskMutationResult } from '../src/app/taskMutations.js';
import type { OpaqueRecordId } from '../src/domain/canonicalIdentity.js';

const VALID = 'Write the brief\n  weight: 3\nDraft the outline';

function harness() {
  const requests: CreateTaskRequest[] = [];
  const created: OpaqueRecordId[] = [];
  let serial = 0;

  const operations = {
    async createTask(request: CreateTaskRequest): Promise<TaskMutationResult> {
      requests.push(request);
      serial += 1;
      const recordId = `pxr_${String(serial).padStart(32, '0')}` as OpaqueRecordId;
      created.push(recordId);
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

  // No panel, no modal, no view: the dependency set is the shell's write access and nothing else.
  const deps: TemplateExecuteDependencies = {
    state: null,
    writes: async () => operations,
    unavailableReason: () => null,
    refresh: async () => null,
    setRefusal: () => {},
    render: () => {},
  };

  return { deps, requests, created };
}

describe('template.execute submission', () => {
  it('creates records with no panel present, and returns the ids of the records it made', async () => {
    const h = harness();
    const submission: TemplateExecuteSubmission = { type: 'template.execute', template: VALID };

    const result = await submitTemplateExecution(h.deps, submission);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('created');
      expect(result.created).toEqual(h.created);
      expect(result.created).toHaveLength(2);
    }
    expect(h.requests.map((request) => request.name)).toEqual(['Write the brief', 'Draft the outline']);
    expect(h.requests[0]?.weight).toBe(3);
  });

  it('refuses a malformed submission before the execution machinery runs', async () => {
    const h = harness();
    const inputs: unknown[] = [
      null,
      'template.execute',
      [],
      {},
      { type: 'task.create', template: VALID },
      { type: 'template.execute' },
      { type: 'template.execute', template: 42 },
      { type: 'template.execute', template: VALID, projectId: 7 },
    ];

    for (const input of inputs) {
      const result = await submitTemplateExecution(h.deps, input);
      expect(result.ok).toBe(false);
      if (!result.ok && 'reason' in result) {
        expect(result.reason).toBe('malformed-submission');
      }
    }
    expect(h.requests).toHaveLength(0);
  });

  it('lets the execution layer answer for the template itself, rather than duplicating its rules', async () => {
    const h = harness();
    const result = await submitTemplateExecution(h.deps, {
      type: 'template.execute',
      template: '  weight: 3\nWrite the brief\n',
    });

    expect(result.ok).toBe(false);
    if (!result.ok && 'reason' in result) {
      expect(result.reason).toBe('plan-invalid');
    }
    expect(h.requests).toHaveLength(0);
  });

  it('parses the wire shape without trusting anything else in it', () => {
    const parsed = parseTemplateExecuteSubmission({
      type: 'template.execute',
      template: VALID,
      projectId: 'pxr_11111111111111111111111111111111',
      requestId: 'agent-supplied',
      outcome: 'created',
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.submission).sort()).toEqual(['projectId', 'template', 'type']);
    }
  });
});
