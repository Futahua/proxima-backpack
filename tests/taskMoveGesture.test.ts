/**
 * A dropped card, end to end: the real recovery gate, the real store, the real refresh.
 *
 * Stage 9's claim is not "the card looks moved". It is that a gesture produces exactly one
 * durable write and that the surfaces then converge from the store — and that a refused gesture
 * produces no write and no redraw, because the authoritative state never moved and a card is
 * therefore already where it belongs.
 *
 * The refresh here is the product's own controller over the product's own state source, so
 * "the surfaces converged" means the projection was genuinely re-read, not that a callback fired.
 */
import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { elasticExecutionPresentation, shouldTickElasticProgress } from '../src/browser/elasticCockpit.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRefreshController, type RefreshResult } from '../src/app/refreshController.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { moveTaskByGesture, taskMoveActionType, type TaskMoveGestureInput } from '../src/app/taskMoveGesture.js';
import {
  createTask,
  deleteTask,
  taskRecordFileName,
  updateTask,
  type TaskMutationDependencies,
} from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { CanonicalExecutionState } from '../src/domain/canonicalTaskState.js';
import type { Task } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T04:00:00+07:00';

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

const PROJECT = idFromLastByte(1);

function projectRecord(id: OpaqueRecordId): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name: 'Project' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

interface Harness {
  readonly files: MemoryRecordFiles;
  readonly deps: TaskMutationDependencies;
  /** Every refresh the gesture asked for, in order. */
  readonly refreshCalls: string[];
  gesture(input: TaskMoveGestureInput): ReturnType<typeof moveTaskByGesture>;
  /** The task as the store holds it — the authority the surfaces are supposed to follow. */
  stored(id: OpaqueRecordId): Promise<CanonicalTaskRecordV2>;
  /** The task as a fresh projection of the store sees it, which is what a surface renders. */
  projected(id: OpaqueRecordId): Promise<Task | undefined>;
}

/**
 * The composition the browser resolves, minus OPFS: record files, a durable journal, Stage 7's
 * recovery gate and the store-as-source behind a real refresh controller.
 */
async function harness(): Promise<Harness> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the harness: ${authority.reason}`);

  let nextId = 100;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  await store.createIfAbsent(projectRecord(PROJECT) as CanonicalRecordV2);

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const refreshCalls: string[] = [];

  return {
    files,
    deps,
    refreshCalls,
    gesture: (input) => moveTaskByGesture(
      {
        updateTask: (request) => updateTask(deps, request),
        refresh: async (reason): Promise<RefreshResult> => {
          refreshCalls.push(reason);
          return await refresh.refreshSource(reason);
        },
      },
      input,
    ),
    stored: async (id) => {
      const observation = await deps.store.read(id);
      if (observation === undefined) throw new Error(`task ${id} is not in the store`);
      return observation.record as CanonicalTaskRecordV2;
    },
    projected: async (id) => {
      const loaded = await source.load();
      return loaded.state.tasks.find((task) => task.id === id);
    },
  };
}

async function seeded(
  deps: TaskMutationDependencies,
  name: string,
  executionState: CanonicalExecutionState,
  executionOrder: number,
): Promise<{ id: OpaqueRecordId; revision: string }> {
  const created = await createTask(deps, { name, projectId: PROJECT, executionState, executionOrder });
  if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason} ${created.detail}`);
  return { id: created.recordId, revision: created.revision };
}

describe('Stage 9 drop wiring', () => {
  it('names the operation the drop is: a column change moves, a within-column drop reorders', () => {
    expect(taskMoveActionType('backlog', 'running')).toBe('task.execution.move');
    expect(taskMoveActionType('running', 'finished')).toBe('task.execution.move');
    expect(taskMoveActionType('backlog', 'finished')).toBe('task.execution.move');
    expect(taskMoveActionType('running', 'running')).toBe('task.execution.reorder');
  });

  it('writes one accepted mutation for a column drop, then converges the surfaces from the store', async () => {
    const app = await harness();
    const task = await seeded(app.deps, 'Drop me', 'backlog', 0);

    const moved = await app.gesture({ taskId: task.id, from: 'backlog', to: 'running', targetIndex: 2, expectedRevision: task.revision });

    expect(moved).toMatchObject({ ok: true, outcome: 'moved', actionType: 'task.execution.move', refreshed: true, refreshFailure: null });
    expect(app.refreshCalls).toEqual(['manual']);

    // One accepted write, not two: the store file is at its second revision since creation.
    const stored = await app.stored(task.id);
    expect(stored).toMatchObject({ executionState: 'running', executionOrder: 2, isCompleted: false });
    const observation = await app.deps.store.read(task.id);
    expect(observation?.observedRevision).toBe(`${taskRecordFileName(task.id)}@2`);

    // And the surfaces read it back rather than being told: a fresh projection agrees.
    expect(await app.projected(task.id)).toMatchObject({ status: 'running', orderIndex: 2 });
  });

  it('carries a card into Finished with its completion', async () => {
    const app = await harness();
    const task = await seeded(app.deps, 'Finish me', 'running', 1);

    const moved = await app.gesture({ taskId: task.id, from: 'running', to: 'finished', targetIndex: 0, expectedRevision: task.revision });

    expect(moved).toMatchObject({ ok: true, actionType: 'task.execution.move', refreshed: true });
    expect(await app.stored(task.id)).toMatchObject({ executionState: 'finished', executionOrder: 0, isCompleted: true });
    expect(await app.projected(task.id)).toMatchObject({ status: 'finished', isCompleted: true });
  });

  it('reorders inside a column without pretending it was a move', async () => {
    const app = await harness();
    const task = await seeded(app.deps, 'Reorder me', 'running', 4);

    const reordered = await app.gesture({ taskId: task.id, from: 'running', to: 'running', targetIndex: 1, expectedRevision: task.revision });

    expect(reordered).toMatchObject({ ok: true, outcome: 'moved', actionType: 'task.execution.reorder', refreshed: true });
    // The column is unchanged, which is the whole difference between the two operations.
    expect(await app.stored(task.id)).toMatchObject({ executionState: 'running', executionOrder: 1 });
  });

  it('returns a raced card to the store\'s location: the stale caller re-reads and is told who won', async () => {
    const app = await harness();
    const task = await seeded(app.deps, 'Contested', 'backlog', 0);

    // Someone else writes first, so this gesture's revision is no longer the observed one.
    const winner = await updateTask(app.deps, {
      taskId: task.id,
      expectedRevision: task.revision,
      mutations: [{ kind: 'name', value: 'Renamed by someone else' }],
    });
    expect(winner.ok).toBe(true);

    const refused = await app.gesture({ taskId: task.id, from: 'backlog', to: 'running', targetIndex: 0, expectedRevision: task.revision });

    expect(refused).toMatchObject({ ok: false, outcome: 'refused', actionType: 'task.execution.move', reason: 'stale-revision', refreshed: true, refreshFailure: null });
    if (refused.ok) return;
    // The winner's revision travels back so the surface can report it rather than guess.
    expect(refused.actualRevision).toBe(winner.ok ? winner.revision : undefined);
    // A lost race is the one refusal worth a redraw: the board was showing a record that is no
    // longer there, so the gesture re-reads rather than leaving the card at a location that
    // only this caller believes in.
    expect(app.refreshCalls).toEqual(['manual']);
    // Nothing was written by the loser, and the card the surfaces now show is the winner's.
    expect(await app.stored(task.id)).toMatchObject({ executionState: 'backlog', executionOrder: 0, name: 'Renamed by someone else' });
    expect(await app.projected(task.id)).toMatchObject({ name: 'Renamed by someone else', status: 'backlog' });
  });

  it('refuses a drop with no position before the store is touched, and does not redraw', async () => {
    const app = await harness();
    const task = await seeded(app.deps, 'Nowhere to land', 'backlog', 0);

    const refused = await app.gesture({ taskId: task.id, from: 'backlog', to: 'running', targetIndex: -1, expectedRevision: task.revision });

    expect(refused).toMatchObject({ ok: false, reason: 'validation-refused', refreshed: false, refreshFailure: null });
    // Nothing changed underneath the caller, so there is nothing to re-read and nothing to redraw.
    expect(app.refreshCalls).toEqual([]);
    const observation = await app.deps.store.read(task.id);
    expect(observation?.observedRevision).toBe(`${taskRecordFileName(task.id)}@1`);
    expect(await app.stored(task.id)).toMatchObject({ executionState: 'backlog', executionOrder: 0 });
  });

  it('keeps the accepted write when the refresh itself fails, because a redraw is not the write', async () => {
    const app = await harness();
    const task = await seeded(app.deps, 'Refresh will fail', 'backlog', 0);

    const moved = await moveTaskByGesture(
      {
        updateTask: (request) => updateTask(app.deps, request),
        refresh: () => { throw new Error('the source went away'); },
      },
      { taskId: task.id, from: 'backlog', to: 'running', targetIndex: 0, expectedRevision: task.revision },
    );

    expect(moved).toMatchObject({ ok: true, outcome: 'moved', refreshed: false, refreshFailure: 'the source went away' });
    expect(await app.stored(task.id)).toMatchObject({ executionState: 'running' });
  });

  it('does not let a deleted card be moved into a column', async () => {
    const app = await harness();
    const task = await seeded(app.deps, 'Gone', 'backlog', 0);
    const removed = await deleteTask(app.deps, { taskId: task.id, expectedRevision: task.revision });
    expect(removed.ok).toBe(true);

    const refused = await app.gesture({ taskId: task.id, from: 'backlog', to: 'running', targetIndex: 0, expectedRevision: task.revision });

    expect(refused).toMatchObject({ ok: false, reason: 'not-found', refreshed: false });
    expect(app.refreshCalls).toEqual([]);
  });

  it('keeps the Elastic lock, its target and a progress tick out of the record store', async () => {
    const app = await harness();
    const running = await seeded(app.deps, 'Being worked on', 'running', 0);
    const backlog = await seeded(app.deps, 'Waiting', 'backlog', 1);
    const before = await Promise.all([running, backlog].map(async (task) => (await app.deps.store.read(task.id))?.observedRevision));

    // The lock is session state, not a record: locking the run, moving the target and drawing
    // the progress they produce are the same local state, and none of it may cost a durable
    // task revision.
    const projection = await recordStoreStateSource(app.deps.store).load();
    const dispatcher = createActionDispatcher({
      state: projection.state,
      clock: fixedClock(CLOCK_ISO),
      idGenerator: sequentialIdGenerator(),
      initialElasticTargetTime: '2026-09-12T05:00:00.000Z',
    });
    expect(dispatcher.dispatch({ type: 'elastic.target.set', targetTime: '2026-09-12T06:00:00.000Z' })).toMatchObject({ ok: true, changed: true });
    expect(dispatcher.dispatch({ type: 'elastic.lock' })).toMatchObject({ ok: true, changed: true, snapshot: { elasticLockedAt: '2026-09-11T21:00:00.000Z' } });

    // A tick: a live run asks for one, a deterministic run derives the same numbers on demand.
    const session = { targetTime: dispatcher.snapshot().elasticTargetTime, lockedAt: dispatcher.snapshot().elasticLockedAt };
    expect(shouldTickElasticProgress('external', 'tasks', 'elastic', session.lockedAt)).toBe(true);
    const presentation = elasticExecutionPresentation(
      projection.state.tasks.filter((task) => task.status === 'running'),
      session,
      new Date(CLOCK_ISO),
    );
    expect(presentation.overallProgress).toBeGreaterThanOrEqual(0);
    expect(presentation.overallProgress).toBeLessThanOrEqual(1);

    expect(dispatcher.dispatch({ type: 'elastic.unlock' })).toMatchObject({ ok: true, changed: true });

    const after = await Promise.all([running, backlog].map(async (task) => (await app.deps.store.read(task.id))?.observedRevision));
    expect(after).toEqual(before);
    expect(app.files.size).toBe(3);
    expect(app.refreshCalls).toEqual([]);
  });

  it('makes a drag and the equivalent direct semantic action land on identical durable state', async () => {
    const app = await harness();
    const dragged = await seeded(app.deps, 'Dragged', 'backlog', 0);
    const asked = await seeded(app.deps, 'Asked directly', 'backlog', 0);

    // The human path: one drop.
    const moved = await app.gesture({ taskId: dragged.id, from: 'backlog', to: 'running', targetIndex: 1, expectedRevision: dragged.revision });
    expect(moved).toMatchObject({ ok: true, actionType: 'task.execution.move' });

    // The direct path: the same semantic operation a caller would submit, with the same
    // expected revision. Stage 9's parity is that these are one operation, not two.
    const direct = await updateTask(app.deps, {
      taskId: asked.id,
      expectedRevision: asked.revision,
      mutations: [{ kind: 'execution-state', value: 'running' }, { kind: 'execution-order', value: 1 }],
    });
    expect(direct).toMatchObject({ ok: true, outcome: 'updated' });

    // Identity and the title a human typed are the only fields that differ; everything the move
    // decided is the same, including the resulting revision the caller is told about.
    const [{ id: draggedId, name: draggedName, ...draggedRest }, { id: askedId, name: askedName, ...askedRest }] = [
      await app.stored(dragged.id),
      await app.stored(asked.id),
    ];
    expect(draggedId).not.toBe(askedId);
    expect(draggedName).not.toBe(askedName);
    expect(draggedRest).toEqual(askedRest);
    expect((await app.deps.store.read(dragged.id))?.observedRevision).toBe(`${taskRecordFileName(dragged.id)}@2`);
    expect((await app.deps.store.read(asked.id))?.observedRevision).toBe(`${taskRecordFileName(asked.id)}@2`);
    // And both are visible to the surfaces through the same projection.
    expect(await app.projected(dragged.id)).toMatchObject({ status: 'running', orderIndex: 1 });
    expect(await app.projected(asked.id)).toMatchObject({ status: 'running', orderIndex: 1 });
  });
});
