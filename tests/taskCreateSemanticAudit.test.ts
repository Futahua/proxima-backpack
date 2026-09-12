/**
 * The semantic envelope on the New Task form: `task.create` is the second family wired to it.
 *
 * Stage 17's matrix found no system-generated request id on any result and no semantic event on any write
 * path; the contract that closes those gaps lives in `src/app/semanticAudit.ts` and was wired to the template
 * action first. This file is the evidence for the task-create half, and it is deliberately about the envelope
 * rather than about the form - `tests/taskCreate.test.ts` already covers what the form plans and what a save
 * effects.
 *
 * What is proved here: the id is minted as soon as there is a run and returned on **every** result, including
 * the refusals decided before the write path is asked; exactly one terminal event is appended per run, after
 * convergence where there was a write; and a caller cannot supply the id.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { createTaskAction, newTaskDraft, type TaskCreateDependencies } from '../src/app/taskCreate.js';
import { applyTaskEditorEdit } from '../src/app/taskEditor.js';
import {
  createTask,
  TASK_MUTATION_SCHEMA_VERSION,
  type CreateTaskRequest,
  type TaskMutationDependencies,
  type TaskMutationResult,
} from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { EMPTY_STATE, type ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T11:30:00+07:00';

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFor(serial: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[14] = 0x9e;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

interface WorldOptions {
  readonly state?: ProximaState | null;
  readonly available?: boolean;
  readonly refuseWrite?: boolean;
}

function world(options: WorldOptions = {}) {
  const files = new MemoryRecordFiles();
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: sequentialIdGenerator(),
  });
  const store = createCanonicalJsonRecordStore(files);
  let serial = 0;
  const dependencies: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFor((serial += 1)),
  };

  const audit = recordingAudit();
  const order: string[] = [];
  const state = options.state === undefined ? ({ ...EMPTY_STATE } as ProximaState) : options.state;

  const operations = {
    async createTask(request: CreateTaskRequest): Promise<TaskMutationResult> {
      if (options.refuseWrite === true) {
        return {
          ok: false,
          schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
          reason: 'validation-refused',
          detail: 'the record was refused by the store',
        };
      }
      return await createTask(dependencies, request);
    },
  };

  const deps: TaskCreateDependencies = {
    state,
    writes: async () => (options.available === false ? null : operations),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      return null;
    },
    setRefusal: () => {},
    render: () => { order.push('render'); },
    ids: semanticIds(),
    audit: {
      append: (event) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  return { deps, audit, order };
}

/** A filled New Task form, the way the surface fills it. */
function draft(state: ProximaState, name: string) {
  const seeded = newTaskDraft(state, '');
  return name.length === 0 ? seeded : applyTaskEditorEdit(seeded, { fieldId: 'name', value: name });
}

describe('the semantic envelope on task.create', () => {
  it('mints an id at the boundary and journals one acceptance after convergence', async () => {
    const w = world();
    const state = w.deps.state!;
    const effect = await createTaskAction(w.deps, { draft: draft(state, 'Write the brief') });

    expect(effect.outcome?.ok).toBe(true);
    const outcome = effect.outcome!;
    expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(effect.closeEditor).toBe(true);

    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'task.create',
      outcome: 'accepted',
      entityIds: [outcome.ok ? outcome.recordId : ''],
    });
    expect(w.order).toEqual(['refresh', 'render', 'audit:accepted']);
  });

  it('correlates the refusal the form decided, before the write path is asked', async () => {
    const w = world();
    const effect = await createTaskAction(w.deps, { draft: draft(w.deps.state!, '') });

    expect(effect.outcome?.ok).toBe(false);
    expect(effect.outcome?.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: effect.outcome!.requestId,
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'validation-refused',
    });
    // Nothing was written, so nothing converged and nothing redrew: the event is the only trace.
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('correlates a refusal for a missing state, which never reaches the form plan', async () => {
    const w = world({ state: null });
    const seeded = newTaskDraft({ ...EMPTY_STATE } as ProximaState, '');
    const filled = applyTaskEditorEdit(seeded, { fieldId: 'name', value: 'Write the brief' });
    const effect = await createTaskAction(w.deps, { draft: filled });

    expect(effect.outcome).toMatchObject({ ok: false, reason: 'not-open' });
    expect(w.audit.events[0]).toMatchObject({ outcome: 'rejected', errorCode: 'not-open', entityIds: [] });
    expect(w.audit.events[0]!.requestId).toBe(effect.outcome!.requestId);
  });

  it('correlates a refused write, and does not claim a convergence it did not do', async () => {
    const w = world({ refuseWrite: true });
    const effect = await createTaskAction(w.deps, { draft: draft(w.deps.state!, 'Write the brief') });

    expect(effect.outcome).toMatchObject({ ok: false, reason: 'validation-refused' });
    expect(w.audit.events[0]).toMatchObject({
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'validation-refused',
    });
    // A refused write changed nothing, so `convergeAfterWrite` declines the re-read; the render still happens
    // because the surface has a refusal to draw.
    expect(w.order).toEqual(['render', 'audit:rejected']);
  });

  it('correlates a run with no write path at all', async () => {
    const w = world({ available: false });
    const effect = await createTaskAction(w.deps, { draft: draft(w.deps.state!, 'Write the brief') });

    expect(effect.outcome).toMatchObject({ ok: false, reason: 'writes-unavailable' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: effect.outcome!.requestId,
      outcome: 'rejected',
      errorCode: 'writes-unavailable',
    });
  });

  it('gives every run its own id, and a caller cannot supply one', async () => {
    const w = world();
    const state = w.deps.state!;
    const first = await createTaskAction(w.deps, { draft: draft(state, 'First') });
    const second = await createTaskAction(w.deps, { draft: draft(state, 'Second') });

    expect(first.outcome!.requestId).not.toBe(second.outcome!.requestId);
    expect(w.audit.events.map((event) => event.requestId))
      .toEqual([first.outcome!.requestId, second.outcome!.requestId]);

    // The input type has no such field, and a smuggled one is ignored rather than trusted.
    const smuggled = { draft: draft(state, 'Third'), requestId: 'caller-supplied' } as unknown as {
      readonly draft: ReturnType<typeof draft>;
    };
    const third = await createTaskAction(w.deps, smuggled);
    expect(third.outcome!.requestId).not.toBe('caller-supplied');
    expect(w.audit.events[2]!.requestId).toBe(third.outcome!.requestId);
  });

  it('appends nothing when there is no run at all', async () => {
    const w = world();
    const effect = await createTaskAction(w.deps, { draft: null });

    expect(effect.outcome).toBeNull();
    expect(w.audit.events).toHaveLength(0);
    expect(w.order).toEqual([]);
  });
});
