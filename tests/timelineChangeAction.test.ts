/**
 * The Gantt's write, over a real store: what a bar gesture comes to.
 *
 * Stage 14's acceptance boxes are about three things, and each is asserted where it can break.
 *
 * - **A gesture is a date request, not a geometry.** The sequence takes the two dates the bar would
 *   draw, refuses a range that is not a range *before* anything is written, and submits one `dates`
 *   mutation at the revision the bar was drawn from — so the agent's request and the drag's proposal
 *   are the same call.
 * - **The row is local.** A3 settled that Gantt row placement is not a third durable task order, so
 *   the case moves a bar between rows and asserts the record's `executionOrder`, workflow stage and
 *   workflow order are all exactly what they were, while the outcome says `rowApplied: false`.
 * - **Every surface follows one read.** The tasks' new dates are read back through the projection the
 *   Countdowns and the Deadline Calendar are built from, so "updates immediately" is a claim about the
 *   source rather than about a redraw.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { changeTaskDatesAction, changeTaskSpan, type TimelineChangeDependencies, type TimelineSpanWriteDependencies } from '../src/app/timelineChangeAction.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:30:00+07:00';
const START = '2026-09-10T09:00:00.000Z';
const DEADLINE = '2026-09-12T17:00:00.000Z';

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

async function world() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 2300;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project = await createProject(deps, { name: 'Timeline project' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);
  const task = await createTask(deps, {
    name: 'Drawn task',
    projectId: project.recordId,
    startDate: START,
    deadline: DEADLINE,
    executionState: 'backlog',
    executionOrder: 3,
  });
  if (!task.ok) throw new Error(`seeding the task failed: ${task.reason}`);

  const source = recordStoreStateSource(store);
  let state = (await source.load()).state;

  const refreshReasons: string[] = [];
  const refusals: Array<string | null> = [];
  // The write path, spelled once: the cockpit's entry and the cockpit-free operation below are handed the
  // same one, which is what makes "the same call" mean the same record write rather than the same sentence.
  const writes = async () => ({ updateTask: async (input: Parameters<typeof updateTask>[1]) => await updateTask(deps, input) });
  const dependencies = (): TimelineChangeDependencies => ({
    state,
    writes,
    unavailableReason: () => null,
    refresh: async (reason) => { refreshReasons.push(reason); return null; },
    setRefusal: (reason) => { refusals.push(reason); },
    render: () => undefined,
  });

  return {
    taskId: task.recordId,
    refreshReasons,
    refusals,
    writes,
    current: () => state,
    sync: async () => { state = (await source.load()).state; return state; },
    dependencies,
    /** The world the surface was rendering, kept apart so a lost race can be staged. */
    staleDependencies: (): TimelineChangeDependencies => ({ ...dependencies(), state }),
    task: () => state.tasks.find((candidate) => candidate.id === task.recordId)!,
    /** Another writer, over the same store: what a lost race is made of. */
    otherWriter: async (mutations: Parameters<typeof updateTask>[1]['mutations']): Promise<void> => {
      const fresh = (await source.load()).state.tasks.find((candidate) => candidate.id === task.recordId)!;
      const written = await updateTask(deps, { taskId: task.recordId, expectedRevision: fresh.source.revision, mutations });
      if (!written.ok) throw new Error(`the other writer was refused: ${written.reason}`);
      state = (await source.load()).state;
    },
    record: async () => {
      const observation = await store.read(task.recordId);
      return observation?.record;
    },
    projection: async (): Promise<ProximaState> => (await source.load()).state,
  };
}

describe('Stage 14 the Gantt date change', () => {
  it('writes both ends for a move, one end for a resize, and refuses a range that is not a range', async () => {
    const app = await world();
    const moved = await changeTaskDatesAction(app.dependencies(), {
      taskId: app.taskId,
      operation: 'move',
      proposedStartDate: '2026-09-15T09:00:00.000Z',
      proposedDeadline: '2026-09-17T17:00:00.000Z',
      targetRowIndex: 2,
    });
    expect(moved).toMatchObject({ ok: true, operation: 'move', rowApplied: false, startDate: '2026-09-15T09:00:00.000Z', deadline: '2026-09-17T17:00:00.000Z' });
    await app.sync();
    expect(app.task()).toMatchObject({ startDate: '2026-09-15T09:00:00.000Z', deadline: '2026-09-17T17:00:00.000Z' });

    // A span of zero is not a span: the boundary is "after", so a deadline that equals its start is refused
    // exactly like one that precedes it. Equality is the whole case - a deadline a millisecond later is
    // simply a very short task, and is accepted - and it is asserted here, before the resizes below move the
    // record on, so the refusal is the range rule's rather than a revision that has already moved.
    expect(await changeTaskDatesAction(app.dependencies(), {
      taskId: app.taskId,
      operation: 'move',
      proposedStartDate: '2026-09-25T09:00:00.000Z',
      proposedDeadline: '2026-09-25T09:00:00.000Z',
      targetRowIndex: 0,
    })).toMatchObject({ ok: false, reason: 'invalid-range', detail: 'a task must end after it starts' });

    // A start-edge resize moves the start and keeps the record's deadline, which is what makes the
    // gesture mean what it looks like.
    const resizedStart = await changeTaskDatesAction(app.dependencies(), {
      taskId: app.taskId,
      operation: 'resize-start',
      proposedStartDate: '2026-09-14T09:00:00.000Z',
      proposedDeadline: null,
      targetRowIndex: 0,
    });
    expect(resizedStart).toMatchObject({ ok: true, operation: 'resize-start', startDate: '2026-09-14T09:00:00.000Z', deadline: '2026-09-17T17:00:00.000Z' });
    await app.sync();

    const resizedEnd = await changeTaskDatesAction(app.dependencies(), {
      taskId: app.taskId,
      operation: 'resize-end',
      proposedStartDate: null,
      proposedDeadline: '2026-09-20T17:00:00.000Z',
      targetRowIndex: 0,
    });
    expect(resizedEnd).toMatchObject({ ok: true, operation: 'resize-end', startDate: '2026-09-14T09:00:00.000Z', deadline: '2026-09-20T17:00:00.000Z' });

    // Inverted and unreal ranges are refused before storage, with the record untouched.
    const before = await app.record();
    const rejections: Array<[string, Parameters<typeof changeTaskDatesAction>[1]]> = [
      ['a task must end after it starts', { taskId: app.taskId, operation: 'move', proposedStartDate: '2026-09-21T09:00:00.000Z', proposedDeadline: '2026-09-20T09:00:00.000Z', targetRowIndex: 0 }],
      ['a task must end after it starts', { taskId: app.taskId, operation: 'resize-start', proposedStartDate: '2026-09-25T09:00:00.000Z', proposedDeadline: null, targetRowIndex: 0 }],
      ['the start is not a real instant', { taskId: app.taskId, operation: 'move', proposedStartDate: 'sometime', proposedDeadline: '2026-09-25T09:00:00.000Z', targetRowIndex: 0 }],
      ['the end is not a real instant', { taskId: app.taskId, operation: 'resize-end', proposedStartDate: null, proposedDeadline: '', targetRowIndex: 0 }],
    ];
    for (const [detail, request] of rejections) {
      expect(await changeTaskDatesAction(app.dependencies(), request)).toMatchObject({ ok: false, reason: 'invalid-range', detail });
    }
    expect(await app.record()).toEqual(before);
  });

  it('reports the row it was dropped in without writing it, so a scoped move cannot reorder the board', async () => {
    const app = await world();
    const before = await app.record();
    const moved = await changeTaskDatesAction(app.dependencies(), {
      taskId: app.taskId,
      operation: 'move',
      proposedStartDate: '2026-09-16T09:00:00.000Z',
      proposedDeadline: '2026-09-18T17:00:00.000Z',
      targetRowIndex: 5,
    });
    expect(moved).toMatchObject({ ok: true, rowApplied: false });

    // The dates moved and nothing else did: a Gantt row is the surface's, not the record's.
    const after = await app.record() as { executionOrder?: unknown; workflowStageId?: unknown; workflowOrder?: unknown; properties?: unknown };
    expect(after).not.toEqual(before);
    const beforeFields = before as { executionOrder?: unknown; workflowStageId?: unknown; workflowOrder?: unknown; properties?: unknown };
    expect(after.executionOrder).toEqual(beforeFields.executionOrder);
    expect(after.workflowStageId).toEqual(beforeFields.workflowStageId);
    expect(after.workflowOrder).toEqual(beforeFields.workflowOrder);
    expect(after.properties).toEqual(beforeFields.properties);
  });

  it('refuses a caller that lost a race with the revision that beat it, and re-reads for it', async () => {
    const app = await world();
    const stale = app.dependencies();                    // the world the bar was drawn from

    // Somebody else moves the dates first, from the same revision.
    await app.otherWriter([{ kind: 'dates', startDate: '2026-09-20T09:00:00.000Z', deadline: '2026-09-22T17:00:00.000Z' }]);

    const loser = await changeTaskDatesAction(stale, {
      taskId: app.taskId,
      operation: 'move',
      proposedStartDate: '2026-09-25T09:00:00.000Z',
      proposedDeadline: '2026-09-27T17:00:00.000Z',
      targetRowIndex: 0,
    });
    expect(loser).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(loser.ok ? '' : loser.detail).toContain('another writer changed this task first');
    // A lost race is the one refusal that re-reads: that is what restores the authoritative bar.
    expect(app.refreshReasons).toContain('manual');
    expect(app.task()).toMatchObject({ startDate: '2026-09-20T09:00:00.000Z', deadline: '2026-09-22T17:00:00.000Z' });
  });

  it('reads the new dates back through the projection every other surface is built from', async () => {
    const app = await world();
    const projection = await app.projection();
    expect(projection.tasks.find((task) => task.id === app.taskId)).toMatchObject({ startDate: START, deadline: DEADLINE });

    const proposed = { startDate: '2026-09-28T09:00:00.000Z', deadline: '2026-09-30T17:00:00.000Z' };
    expect(await changeTaskDatesAction(app.dependencies(), {
      taskId: app.taskId,
      operation: 'move',
      proposedStartDate: proposed.startDate,
      proposedDeadline: proposed.deadline,
      targetRowIndex: 1,
    })).toMatchObject({ ok: true, refreshed: false });

    // The write is durable, so the Countdowns and the Deadline Calendar — which read this same
    // projection — see the new dates on their next read rather than on a redraw.
    const after = await app.projection();
    expect(after.tasks.find((task) => task.id === app.taskId)).toMatchObject(proposed);
  });

  it('refuses without a write path, naming the reason, and does not resolve one for a task the timeline is not showing', async () => {
    const app = await world();
    const withoutWrites: TimelineChangeDependencies = {
      ...app.dependencies(),
      writes: async () => null,
      unavailableReason: () => 'record-writes-need-an-activated-store',
    };
    expect(await changeTaskDatesAction(withoutWrites, {
      taskId: app.taskId,
      operation: 'move',
      proposedStartDate: '2026-09-15T09:00:00.000Z',
      proposedDeadline: '2026-09-16T09:00:00.000Z',
      targetRowIndex: 0,
    })).toMatchObject({ ok: false, reason: 'writes-unavailable', detail: 'record-writes-need-an-activated-store' });

    expect(await changeTaskDatesAction(app.dependencies(), {
      taskId: 'not-in-the-world',
      operation: 'move',
      proposedStartDate: '2026-09-15T09:00:00.000Z',
      proposedDeadline: '2026-09-16T09:00:00.000Z',
      targetRowIndex: 0,
    })).toMatchObject({ ok: false, reason: 'unknown-task' });
  });

  it('runs the same write as a cockpit-free operation, from the record facts as parameters', async () => {
    const app = await world();
    const before = await app.task();

    // The dependency set, spelled out rather than spread from the cockpit's: the four things the operation
    // takes, and not one of them is a projection, a refusal sink or a render. This is the whole claim of the
    // split - a caller with no cockpit can build this object and reach the same write.
    const withoutCockpit = {
      writes: app.writes,
      unavailableReason: () => null,
      refresh: async () => null,
      ids: sequentialIdGenerator(),
      audit: { append: () => undefined },
    } satisfies TimelineSpanWriteDependencies;

    const moved = await changeTaskSpan(withoutCockpit, {
      taskId: app.taskId,
      operation: 'move',
      proposedStartDate: '2026-10-01T09:00:00.000Z',
      proposedDeadline: '2026-10-03T17:00:00.000Z',
      targetRowIndex: 3,
      expectedRevision: before.source.revision,
    });
    expect(moved).toMatchObject({
      ok: true,
      outcome: 'changed',
      actionType: 'task.timeline.change',
      operation: 'move',
      rowApplied: false,
      startDate: '2026-10-01T09:00:00.000Z',
      deadline: '2026-10-03T17:00:00.000Z',
      refreshed: false,
      // The write landed and this caller's refresh declined, which is the one combination where a result
      // carries both: presentation catching up with a durable record is not the record.
      refreshFailure: 'the source session declined to refresh',
    });
    expect(moved.requestId).toMatch(/^semantic-request/);
    await app.sync();
    expect(app.task()).toMatchObject({ startDate: '2026-10-01T09:00:00.000Z', deadline: '2026-10-03T17:00:00.000Z' });

    // The three gestures over one record fact set: a start resize moves one end, an end resize moves the other,
    // and neither is a shape the caller could get wrong by naming the wrong end - the span carries both. Each
    // revision comes from a re-read, because the operation deliberately does not keep a projection for you.
    const resizedStart = await changeTaskSpan(withoutCockpit, {
      taskId: app.taskId,
      operation: 'resize-start',
      proposedStartDate: '2026-09-28T09:00:00.000Z',
      proposedDeadline: '2026-10-03T17:00:00.000Z',
      targetRowIndex: 0,
      expectedRevision: app.task().source.revision,
    });
    expect(resizedStart).toMatchObject({ ok: true, operation: 'resize-start', startDate: '2026-09-28T09:00:00.000Z', deadline: '2026-10-03T17:00:00.000Z' });
    await app.sync();

    const resizedEnd = await changeTaskSpan(withoutCockpit, {
      taskId: app.taskId,
      operation: 'resize-end',
      proposedStartDate: '2026-09-28T09:00:00.000Z',
      proposedDeadline: '2026-10-09T17:00:00.000Z',
      targetRowIndex: 0,
      expectedRevision: app.task().source.revision,
    });
    expect(resizedEnd).toMatchObject({ ok: true, operation: 'resize-end', startDate: '2026-09-28T09:00:00.000Z', deadline: '2026-10-09T17:00:00.000Z' });

    // ...and what actually landed, read back out of the store rather than taken from the result: each resize
    // moved exactly one end and left the other at what it wrote. This is the assertion that tells the two
    // ends apart - a probe that swapped them left both results `ok: true` and only this read-back noticed.
    await app.sync();
    const stored = await app.record() as { startDate: string; deadline: string };
    expect(stored.startDate).toBe('2026-09-28T09:00:00.000Z');
    expect(stored.deadline).toBe('2026-10-09T17:00:00.000Z');

    // The operation draws nothing and has nothing to draw with: the only record of the run is the event its
    // caller's sink chose to keep, which is why the sink is injected rather than reached for.
    expect(Object.keys(withoutCockpit).sort()).toEqual(['audit', 'ids', 'refresh', 'unavailableReason', 'writes']);
  });
});
