/**
 * Stage 9's record editing, proven through the real store boundary and the real recovery
 * coordinator rather than against a stub of either.
 *
 * What these cases are for: a write path is only worth having if its refusals are real. So each
 * of them attacks something — an invalid request, an undeclared property, a project that does
 * not exist, a stage from another project, a caller that lost a race — and asserts both the
 * typed refusal *and* that nothing moved in the store.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import {
  createTask,
  deleteTask,
  updateTask,
  type TaskMutationDependencies,
  type TaskMutationResult,
} from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { canonicalOrderPosition, orderCanonicalWorkflowStage } from '../src/domain/canonicalOrdering.js';
import type { CanonicalEventRecordV2, CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { defineCanonicalPropertySchema, type CanonicalPropertySchemaRecord } from '../src/domain/canonicalSchema.js';
import type { CanonicalWorkflowStageStateRecord } from '../src/domain/canonicalTaskState.js';
import { projectRecordState } from '../src/app/recordStateProjection.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T03:00:00+07:00';

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  writes = 0;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.writes += 1;
    this.text = value;
  }

  /** The statuses the journal recorded, oldest first — prepared then committed, or not. */
  statuses(): string[] {
    if (this.text === undefined) return [];
    return (JSON.parse(this.text) as { status: string }[]).map((record) => record.status);
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(1);
const OTHER_PROJECT = idFromLastByte(2);
const STAGE_A = idFromLastByte(3);
const STAGE_B = idFromLastByte(4);
const EFFORT = idFromLastByte(5);
const PRIORITY = idFromLastByte(6);
const EVENT = idFromLastByte(7);

function projectRecord(id: OpaqueRecordId, name: string): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

function stageRecord(id: OpaqueRecordId, projectId: OpaqueRecordId, name: string): CanonicalWorkflowStageStateRecord {
  return { ...defineCanonicalRecordHeader({ kind: 'workflow-stage', id, name }), projectId };
}

function effortSchema(): CanonicalPropertySchemaRecord {
  return defineCanonicalPropertySchema({
    header: defineCanonicalRecordHeader({ kind: 'schema', id: EFFORT, name: 'Effort' }),
    definition: { type: 'number' },
  });
}

function taskRecord(id: OpaqueRecordId, name: string, executionOrder: number, workflowOrder: number): CanonicalTaskRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'task', id, name }),
    projectId: PROJECT,
    executionState: 'running',
    workflowStageId: STAGE_A,
    executionOrder: canonicalOrderPosition(executionOrder),
    workflowOrder: canonicalOrderPosition(workflowOrder),
    description: `${name} description`,
    weight: 1,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
    recurrence: null,
  };
}

async function world(): Promise<{
  files: MemoryRecordFiles;
  journal: MemoryJournal;
  deps: TaskMutationDependencies;
  ids: { next: () => OpaqueRecordId };
}> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const journal = new MemoryJournal();
  const recovery = createDurableRecoveryStore(journal);
  await recovery.load();
  let requestCounter = 0;
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: { next: (prefix = 'id') => `${prefix}-${++requestCounter}` },
  });
  let nextId = 100;
  const deps: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };

  for (const record of [
    projectRecord(PROJECT, 'Project') as CanonicalRecordV2,
    projectRecord(OTHER_PROJECT, 'Other project') as CanonicalRecordV2,
    stageRecord(STAGE_A, PROJECT, 'Review') as CanonicalRecordV2,
    stageRecord(STAGE_B, OTHER_PROJECT, 'Their review') as CanonicalRecordV2,
    effortSchema() as CanonicalRecordV2,
  ]) {
    const result = await store.createIfAbsent(record);
    expect(result.ok).toBe(true);
  }

  return { files, journal, deps, ids: { next: () => idFromLastByte(nextId++) } };
}

async function revisions(files: MemoryRecordFiles): Promise<string[]> {
  const names = await files.listRecordFiles();
  const out: string[] = [];
  for (const name of names) out.push((await files.readRecordFile(name as never))?.revision ?? '');
  return out;
}

function ok(result: TaskMutationResult): Extract<TaskMutationResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  return result;
}

function detailOf(result: TaskMutationResult): string {
  if (result.ok) throw new Error('expected a refusal');
  return `${result.reason}: ${result.detail}`;
}

describe('Stage 9 semantic task mutations', () => {
  it('creates a task through the store boundary, and refuses every invalid request before writing', async () => {
    const { deps, files } = await world();
    const before = await revisions(files);

    const created = ok(await createTask(deps, {
      name: 'Write the parity report',
      projectId: PROJECT,
      description: 'Records every column the checklist names',
      executionState: 'running',
      weight: 2,
      startDate: '2026-09-12T09:00:00.000Z',
      deadline: '2026-09-13T09:00:00.000Z',
      maxDuration: 240,
      executionOrder: 3,
      workflowStageId: STAGE_A,
      workflowOrder: 0,
      properties: { [EFFORT]: { type: 'number', value: 5 } },
    }));

    expect(created.outcome).toBe('created');
    expect(created.record).toMatchObject({
      name: 'Write the parity report',
      projectId: PROJECT,
      executionState: 'running',
      isCompleted: false,
      weight: 2,
      maxDuration: 240,
      workflowStageId: STAGE_A,
      createdAt: new Date(CLOCK_ISO).toISOString(),
    });
    expect(created.record?.executionOrder).toBe(3);

    // The record round-trips: reading the store back and projecting it is how a surface sees it.
    const projected = projectRecordState(await deps.store.list()).state;
    expect(projected.tasks.map((task) => task.name)).toContain('Write the parity report');
    expect(projected.tasks.find((task) => task.id === created.recordId)?.status).toBe('running');

    const refusals: [string, Promise<TaskMutationResult>][] = [
      ['a nameless task', createTask(deps, { name: '   ', projectId: PROJECT })],
      ['a task with no project record', createTask(deps, { name: 'Ghost', projectId: idFromLastByte(99) })],
      ['a negative weight', createTask(deps, { name: 'Heavy', projectId: PROJECT, weight: -1 })],
      ['a deadline before its start', createTask(deps, { name: 'Backwards', projectId: PROJECT, startDate: '2026-09-13T09:00:00.000Z', deadline: '2026-09-12T09:00:00.000Z' })],
      ['a fixed duration with no value', createTask(deps, { name: 'Fixed', projectId: PROJECT, isFixedDuration: true })],
      ['a cap below the fixed duration', createTask(deps, { name: 'Capped', projectId: PROJECT, isFixedDuration: true, fixedDuration: 90, maxDuration: 30 })],
      ['an undeclared property', createTask(deps, { name: 'Property', projectId: PROJECT, properties: { [PRIORITY]: { type: 'text', value: 'high' } } })],
      ['a stage from another project', createTask(deps, { name: 'Stage', projectId: PROJECT, workflowStageId: STAGE_B, workflowOrder: 0 })],
      ['a stage with no position in it', createTask(deps, { name: 'Stage', projectId: PROJECT, workflowStageId: STAGE_A })],
      ['a position with no stage', createTask(deps, { name: 'Position', projectId: PROJECT, workflowOrder: 3 })],
      ['a fractional order', createTask(deps, { name: 'Order', projectId: PROJECT, executionOrder: 1.5 })],
      ['an unreadable deadline', createTask(deps, { name: 'Date', projectId: PROJECT, deadline: 'next tuesday' })],
    ];
    for (const [label, promise] of refusals) {
      const result = await promise;
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(['validation-refused', 'not-found', 'semantic-conflict']).toContain(result.reason);
    }

    // Nothing above wrote: the store holds exactly the world's five records and the same revisions.
    expect((await deps.store.list())).toHaveLength(6);
    expect((await revisions(files)).slice(0, before.length)).toEqual(before);
  });

  it('updates with a closed field list, and refuses an update that changes nothing or names no schema', async () => {
    const { deps, files } = await world();
    const seeded = ok(await createTask(deps, { name: 'Seeded', projectId: PROJECT, executionState: 'backlog' }));
    const revision = seeded.revision;

    expect((await updateTask(deps, { taskId: seeded.recordId, expectedRevision: revision, mutations: [] })).ok).toBe(false);

    const updated = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: revision,
      mutations: [
        { kind: 'name', value: 'Renamed' },
        { kind: 'description', value: 'Now with a description' },
        { kind: 'weight', value: 4 },
        { kind: 'dates', startDate: '2026-09-12T09:00:00.000Z', deadline: null },
        { kind: 'fixed-duration', isFixedDuration: true, fixedDuration: 45 },
        { kind: 'max-duration', value: 120 },
        { kind: 'property', key: EFFORT, value: { type: 'number', value: 3 } },
        { kind: 'execution-order', value: 7 },
      ],
    }));
    expect(updated.outcome).toBe('updated');
    expect(updated.record).toMatchObject({
      name: 'Renamed',
      description: 'Now with a description',
      weight: 4,
      startDate: '2026-09-12T09:00:00.000Z',
      deadline: null,
      isFixedDuration: true,
      fixedDuration: 45,
      maxDuration: 120,
    });
    expect(updated.record?.executionOrder).toBe(7);
    expect(updated.revision).not.toBe(revision);

    // Clearing a property and a duration are updates too, and they remove rather than zero.
    const cleared = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: updated.revision,
      mutations: [
        { kind: 'property', key: EFFORT, value: null },
        { kind: 'fixed-duration', isFixedDuration: false, fixedDuration: null },
      ],
    }));
    expect(cleared.record?.properties[EFFORT]).toBeUndefined();
    expect(cleared.record?.fixedDuration).toBeNull();

    // A mutation that names an undeclared schema is refused, and the record is where it was.
    const beforeRefusal = await revisions(files);
    const refused = await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: cleared.revision,
      mutations: [{ kind: 'property', key: PRIORITY, value: { type: 'text', value: 'high' } }],
    });
    expect(detailOf(refused)).toContain('no schema record defines the property');
    expect(await revisions(files)).toEqual(beforeRefusal);
    expect((await deps.store.read(seeded.recordId))?.observedRevision).toBe(cleared.revision);
  });

  it('keeps completion and both orderings consistent when a task moves between states', async () => {
    const { deps } = await world();
    const seeded = ok(await createTask(deps, {
      name: 'Moves',
      projectId: PROJECT,
      executionState: 'running',
      executionOrder: 1,
      workflowStageId: STAGE_A,
      workflowOrder: 0,
    }));
    const withWorkflowOrder = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: seeded.revision,
      mutations: [{ kind: 'workflow-order', value: 2 }],
    }));

    // Into Finished: complete, and the workflow dimension is exactly as it was.
    const finished = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: withWorkflowOrder.revision,
      mutations: [{ kind: 'execution-state', value: 'finished' }],
    }));
    expect(finished.record).toMatchObject({ executionState: 'finished', isCompleted: true });
    expect(finished.record?.workflowStageId).toBe(STAGE_A);
    expect(finished.record?.workflowOrder).toBe(2);

    // Out of Finished: not complete, workflow untouched again.
    const back = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: finished.revision,
      mutations: [{ kind: 'execution-state', value: 'backlog' }],
    }));
    expect(back.record).toMatchObject({ executionState: 'backlog', isCompleted: false });
    expect(back.record?.workflowOrder).toBe(2);

    // Reordering Elastic does not alter workflow-stage order: the canonical projection of a
    // stage is the same list before and after an execution reorder.
    const beforeReorder = orderCanonicalWorkflowStage([back.record!], PROJECT, STAGE_A).map((task) => task.id);
    const reordered = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: back.revision,
      mutations: [{ kind: 'execution-order', value: 9 }],
    }));
    expect(reordered.record?.executionOrder).toBe(9);
    expect(reordered.record?.workflowOrder).toBe(2);
    expect(orderCanonicalWorkflowStage([reordered.record!], PROJECT, STAGE_A).map((task) => task.id)).toEqual(beforeReorder);

    // And the reverse: a workflow-order change leaves the Elastic position alone.
    const workflowMoved = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: reordered.revision,
      mutations: [{ kind: 'workflow-order', value: 5 }],
    }));
    expect(workflowMoved.record?.workflowOrder).toBe(5);
    expect(workflowMoved.record?.executionOrder).toBe(9);

    // A project change that kept a stage from the old project is refused before the store ever
    // sees the record, so the caller gets a sentence rather than "the write was rejected".
    const crossed = await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: workflowMoved.revision,
      mutations: [{ kind: 'project', value: OTHER_PROJECT }],
    });
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.reason).toBe('semantic-conflict');
    expect((await deps.store.read(seeded.recordId))?.observedRevision).toBe(workflowMoved.revision);

    // Leaving the stage takes the position with it, and the pair cannot be split.
    const left = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: workflowMoved.revision,
      mutations: [{ kind: 'project', value: OTHER_PROJECT }, { kind: 'workflow-stage', value: null, order: null }],
    }));
    expect(left.record?.projectId).toBe(OTHER_PROJECT);
    expect(left.record?.workflowStageId).toBeNull();
    expect(left.record?.workflowOrder).toBeNull();
    const splitPair = await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: left.revision,
      mutations: [{ kind: 'workflow-stage', value: null, order: 2 }],
    });
    expect(splitPair.ok).toBe(false);
  });

  it('tells the loser of a race it lost, with the revision that beat it, and lets it retry', async () => {
    const { deps, journal } = await world();
    const seeded = ok(await createTask(deps, { name: 'Contested', projectId: PROJECT }));
    const shared = seeded.revision;

    // Two callers read the same revision; the first write wins.
    const winner = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: shared,
      mutations: [{ kind: 'name', value: 'First writer' }],
    }));
    const loser = await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: shared,
      mutations: [{ kind: 'name', value: 'Second writer' }],
    });

    expect(winner.outcome).toBe('updated');
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(loser.reason).toBe('stale-revision');
    // The loser is told what to refetch rather than being left to guess, and its own value never
    // reached the record.
    expect(loser.actualRevision).toBe(winner.revision);
    expect((await deps.store.read(seeded.recordId))?.record).toMatchObject({ name: 'First writer' });

    // Retrying from the observed revision succeeds, which is what "the loser learns it lost"
    // is for.
    const retried = ok(await updateTask(deps, {
      taskId: seeded.recordId,
      expectedRevision: loser.actualRevision!,
      mutations: [{ kind: 'name', value: 'Second writer, after refetching' }],
    }));
    expect(retried.record?.name).toBe('Second writer, after refetching');

    // A stale delete is refused the same way, and the record survives it.
    const staleDelete = await deleteTask(deps, { taskId: seeded.recordId, expectedRevision: shared });
    expect(staleDelete.ok).toBe(false);
    expect((await deps.store.read(seeded.recordId))).toBeDefined();

    // Every accepted write passed through the journal: prepared before the effect, committed
    // after it.
    expect(journal.writes).toBeGreaterThan(0);
    expect(journal.statuses().every((status) => status === 'committed')).toBe(true);
  });

  it('deletes through the coordinator, and a deleted task leaves the projection', async () => {
    const { deps } = await world();
    const seeded = ok(await createTask(deps, { name: 'Doomed', projectId: PROJECT }));

    const deleted = ok(await deleteTask(deps, { taskId: seeded.recordId, expectedRevision: seeded.revision }));
    expect(deleted.outcome).toBe('deleted');
    expect(deleted.record).toBeNull();

    expect(await deps.store.read(seeded.recordId)).toBeUndefined();
    const projected = projectRecordState(await deps.store.list()).state;
    expect(projected.tasks.map((task) => task.name)).not.toContain('Doomed');

    // Deleting again is a not-found refusal rather than a second success.
    const again = await deleteTask(deps, { taskId: seeded.recordId, expectedRevision: seeded.revision });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('not-found');
  });
});
