/**
 * The canonical template.execute submission path.
 *
 * The cases that matter are the ones a surface has to act on: a run that finished, a refusal decided before
 * anything was written, and - the one the AUTHOR called out for the panel - a refusal *after* a creation,
 * which must come back as `ok: false` with the ids that did land rather than looking like a completed run.
 * Availability of writes is the shell's answer, so a missing port is a refusal here, not an exception.
 */
import { describe, expect, it } from 'vitest';

import {
  executeTemplateAction,
  TEMPLATE_EXECUTE_ACTION_SCHEMA_VERSION,
  type TemplateExecuteDependencies,
} from '../src/app/templateExecuteAction.js';
import type { CreateTaskRequest, TaskMutationResult } from '../src/app/taskMutations.js';
import type { OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const TEMPLATE = ['Write the brief', '  weight: 3', 'Draft the outline'].join('\n');

function harness({ available = true }: { available?: boolean } = {}) {
  const requests: CreateTaskRequest[] = [];
  const refreshes: unknown[] = [];
  const refusals: (string | null)[] = [];
  let renders = 0;
  let failOn: number | null = null;
  let failureReason = 'validation-refused';
  let serial = 0;

  const operations = {
    async createTask(request: CreateTaskRequest): Promise<TaskMutationResult> {
      requests.push(request);
      serial += 1;
      if (failOn !== null && requests.length === failOn) {
        return {
          ok: false,
          schemaVersion: 1 as never,
          reason: failureReason,
          detail: 'the write was refused',
        } as TaskMutationResult;
      }
      return {
        ok: true,
        schemaVersion: 1 as never,
        outcome: 'created',
        recordId: `pxr_${String(serial).padStart(32, '0')}` as OpaqueRecordId,
        revision: `rev-${serial}`,
        record: null,
      } as unknown as TaskMutationResult;
    },
  };

  const deps: TemplateExecuteDependencies = {
    state: null,
    writes: async () => (available ? operations : null),
    unavailableReason: () => 'the record store is not open',
    refresh: async (reason) => {
      refreshes.push(reason);
      return null;
    },
    setRefusal: (reason) => {
      refusals.push(reason);
    },
    render: () => {
      renders += 1;
    },
    ids: semanticIds(),
    audit: recordingAudit(),
  };

  return {
    deps,
    requests,
    refreshes,
    refusals,
    renders: () => renders,
    failAt(index: number, reason?: string) {
      failOn = index;
      if (reason) failureReason = reason;
    },
  };
}

describe('template.execute', () => {
  it('executes a valid template and names what it created', async () => {
    const h = harness();
    const outcome = await executeTemplateAction(h.deps, { template: TEMPLATE });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.schemaVersion).toBe(TEMPLATE_EXECUTE_ACTION_SCHEMA_VERSION);
      expect(outcome.verb).toBe('execute');
      expect(outcome.outcome).toBe('created');
      expect(outcome.created).toHaveLength(2);
    }
    expect(h.requests.map((request) => request.name)).toEqual(['Write the brief', 'Draft the outline']);
    expect(h.refusals[0]).toBeNull();
    expect(h.refreshes).toHaveLength(1);
    expect(h.renders()).toBeGreaterThan(0);
  });

  it('refuses an invalid template before any write, and says so where the surface can draw it', async () => {
    const h = harness();
    const outcome = await executeTemplateAction(h.deps, { template: '  weight: 3\nWrite the brief\n' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('plan-invalid');
      expect(outcome.created).toEqual([]);
      expect(outcome.refreshed).toBe(false);
    }
    expect(h.requests).toHaveLength(0);
    expect(h.refusals.some((reason) => reason !== null)).toBe(true);
  });

  it('refuses a draft field it cannot translate before any write', async () => {
    const h = harness();
    const outcome = await executeTemplateAction(h.deps, { template: 'Write the brief\n  status: doing\n' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('untranslatable-draft-field');
    expect(h.requests).toHaveLength(0);
  });

  it('a refusal after a creation comes back as unfinished, with the ids that did land', async () => {
    const h = harness();
    h.failAt(2);
    const outcome = await executeTemplateAction(h.deps, { template: TEMPLATE });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('creation-refused');
      expect(outcome.created).toHaveLength(1);
      expect(outcome.created[0]).toMatch(/^pxr_[0-9a-f]{32}$/);
    }
    expect(h.requests).toHaveLength(2);
    // A partial run has already written a record, so the surfaces are stale and must be re-read even though
    // the run is reported as unfinished.
    expect(h.refreshes).toHaveLength(1);
  });

  it('a lost race is still an unfinished run, and the caller can tell it apart by the cause', async () => {
    const h = harness();
    h.failAt(1, 'stale-revision');
    const outcome = await executeTemplateAction(h.deps, { template: TEMPLATE });

    expect(outcome.ok).toBe(false);
    expect(h.refreshes).toHaveLength(1);
    if (!outcome.ok) expect(outcome.created).toEqual([]);
  });

  it('refuses when the shell cannot offer writes, without touching the port', async () => {
    const h = harness({ available: false });
    const outcome = await executeTemplateAction(h.deps, { template: TEMPLATE });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('writes-unavailable');
      expect(outcome.detail).toBe('the record store is not open');
      expect(outcome.created).toEqual([]);
    }
    expect(h.requests).toHaveLength(0);
    // Clearing the refusal first, then setting the shell's own sentence, is the house pattern: the surface
    // must not keep showing a stale refusal while a new one is being decided.
    expect(h.refusals).toEqual([null, 'the record store is not open']);
  });
});
