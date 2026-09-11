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
import { changeTaskDatesAction, type TimelineChangeDependencies } from '../src/app/timelineChangeAction.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
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
  const dependencies = (): TimelineChangeDependencies => ({
    state,
    writes: async () => ({ updateTask: async (input) => await updateTask(deps, input) }),
    unavailableReason: () => null,
    refresh: async (reason) => { refreshReasons.push(reason); return null; },
    setRefusal: (reason) => { refusals.push(reason); },
    render: () => undefined,
  });

  return {
    taskId: task.recordId,
    refreshReasons,
    refusals,
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
});
