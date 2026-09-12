/**
 * Bulk actions over a marked selection, against the real store and the real recovery gate.
 *
 * The cases are the four promises the report makes: every marked task appears (so nothing is
 * silently omitted), the status cannot overstate a partial run, a stale member is one entity's
 * result rather than the action's end, and exactly one attempt is made per entity so a retry is the
 * caller's decision. The last one is asserted by *counting* the writes the coordinator saw, which is
 * the only way to tell "it retried internally" from "it did not".
 */
import { describe, expect, it } from 'vitest';
import { bulkCompleteTasks, bulkDeleteTasks } from '../src/app/bulkTaskActions.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { createTask, deleteTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T08:00:00+07:00';

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
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(91);

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

interface World {
  readonly files: MemoryRecordFiles;
  readonly journal: MemoryJournal;
  readonly deps: TaskMutationDependencies;
  readonly refreshCalls: string[];
  state(): Promise<ProximaState>;
  stored(id: OpaqueRecordId): Promise<CanonicalTaskRecordV2 | undefined>;
  seed(name: string, state?: 'backlog' | 'running' | 'finished'): Promise<{ id: OpaqueRecordId; revision: string }>;
  complete(taskIds: readonly string[], options?: { renders?: number[] }): ReturnType<typeof bulkCompleteTasks>;
  remove(taskIds: readonly string[]): ReturnType<typeof bulkDeleteTasks>;
  /** The same sequences with no write path, which is what a legacy run resolves to. */
  withoutWrites(): { complete: (taskIds: readonly string[]) => ReturnType<typeof bulkCompleteTasks>; remove: (taskIds: readonly string[]) => ReturnType<typeof bulkDeleteTasks> };
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const journal = new MemoryJournal();
  const recovery = createDurableRecoveryStore(journal);
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 950;
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
  const read = async (): Promise<ProximaState> => (await source.load()).state;
  const writes = {
    updateTask: (input: Parameters<typeof updateTask>[1]) => updateTask(deps, input),
    deleteTask: (input: Parameters<typeof deleteTask>[1]) => deleteTask(deps, input),
  };
  const depsWith = (available: boolean) => ({
    state: null as ProximaState | null,
    writes: async () => (available ? writes : null),
    unavailableReason: () => 'record-writes-need-an-activated-store',
    refresh: async (reason: RefreshReason): Promise<RefreshResult> => {
      refreshCalls.push(reason);
      return await refresh.refreshSource(reason);
    },
    render: () => undefined,
    ids: semanticIds(),
    audit: recordingAudit(),
  });

  return {
    files,
    journal,
    deps,
    refreshCalls,
    state: read,
    stored: async (id) => {
      const observation = await store.read(id);
      return observation === undefined ? undefined : observation.record as CanonicalTaskRecordV2;
    },
    seed: async (name, state = 'backlog') => {
      const created = await createTask(deps, { name, projectId: PROJECT, executionState: state, executionOrder: 0 });
      if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason}`);
      return { id: created.recordId, revision: created.revision };
    },
    complete: async (taskIds, options = {}) => await bulkCompleteTasks(
      { ...depsWith(true), state: await read(), render: () => { options.renders?.push(options.renders.length + 1); } },
      { taskIds },
    ),
    remove: async (taskIds) => await bulkDeleteTasks({ ...depsWith(true), state: await read() }, { taskIds }),
    withoutWrites: () => ({
      complete: async (taskIds) => await bulkCompleteTasks({ ...depsWith(false), state: null }, { taskIds }),
      remove: async (taskIds) => await bulkDeleteTasks({ ...depsWith(false), state: null }, { taskIds }),
    }),
  };
}

describe('Stage 10 bulk task actions', () => {
  it('completes every marked task and reports one entity per task, all accepted', async () => {
    const app = await world();
    const first = await app.seed('First');
    const second = await app.seed('Second', 'running');

    const report = await app.complete([first.id, second.id]);

    expect(report).toMatchObject({ action: 'task.bulk.complete', status: 'accepted', requested: 2, accepted: 2, refused: 0, refreshed: true });
    expect(report.entities.map((entity) => entity.taskId)).toEqual([first.id, second.id]);
    expect(report.entities.every((entity) => entity.ok)).toBe(true);
    expect(app.refreshCalls).toEqual(['manual']);
    // Complete means finished, and the write path derives completion from the execution state.
    expect(await app.stored(first.id)).toMatchObject({ executionState: 'finished', isCompleted: true });
    expect(await app.stored(second.id)).toMatchObject({ executionState: 'finished', isCompleted: true });
  });

  it('reports a partial run as partial, and never as an overall success', async () => {
    const app = await world();
    const first = await app.seed('Accepted');
    const second = await app.seed('Raced');
    const third = await app.seed('Also accepted');
    const rendered = await app.state();

    // Someone else writes the second task after the selection was rendered, so its revision is stale.
    expect(await updateTask(app.deps, {
      taskId: second.id,
      expectedRevision: second.revision,
      mutations: [{ kind: 'name', value: 'Moved on' }],
    })).toMatchObject({ ok: true });

    const report = await bulkCompleteTasks(
      {
        state: rendered,
        writes: async () => ({
          updateTask: (input) => updateTask(app.deps, input),
          deleteTask: (input) => deleteTask(app.deps, input),
        }),
        unavailableReason: () => null,
        refresh: async (reason: RefreshReason) => {
          app.refreshCalls.push(reason);
          return null;
        },
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      },
      { taskIds: [first.id, second.id, third.id] },
    );

    // The status cannot be read as "done": two of three were written, and the report says so.
    expect(report).toMatchObject({ status: 'partial', requested: 3, accepted: 2, refused: 1 });
    expect(report.entities).toHaveLength(3);
    const stale = report.entities.find((entity) => entity.taskId === second.id)!;
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision' });
    // A stale member is one member's result, not the end of the action: the others were still written.
    expect(await app.stored(first.id)).toMatchObject({ executionState: 'finished' });
    expect(await app.stored(third.id)).toMatchObject({ executionState: 'finished' });
    expect(await app.stored(second.id)).toMatchObject({ executionState: 'backlog', name: 'Moved on' });
  });

  it('attempts each entity exactly once, so a retry is the caller\'s decision', async () => {
    const app = await world();
    const first = await app.seed('Once');
    const second = await app.seed('Twice');
    const journalWritesBefore = app.journal.writes;

    const report = await app.complete([first.id, second.id]);

    expect(report.status).toBe('accepted');
    // Two accepted updates journal a prepared and a committed record each, and nothing more: an
    // internal retry would show up here as extra writes.
    expect(app.journal.writes - journalWritesBefore).toBe(4);
    expect(report.entities.map((entity) => entity.ok)).toEqual([true, true]);
  });

  it('names an unloaded member rather than dropping it from the report', async () => {
    const app = await world();
    const first = await app.seed('Loaded');
    const missing = idFromLastByte(199);

    const report = await app.complete([first.id, missing]);

    expect(report).toMatchObject({ status: 'partial', requested: 2, accepted: 1, refused: 1 });
    expect(report.entities.map((entity) => entity.taskId)).toEqual([first.id, missing]);
    expect(report.entities[1]).toMatchObject({ ok: false, reason: 'unknown-task' });
  });

  it('refuses an empty selection as a whole, because zero writes is not a success', async () => {
    const app = await world();

    const report = await app.complete([]);

    expect(report).toMatchObject({ status: 'refused', requested: 0, accepted: 0, refused: 0, entities: [], refreshed: false });
    expect(app.refreshCalls).toEqual([]);
  });

  it('reports every marked task as refused when this run has no write path', async () => {
    const app = await world();
    const first = await app.seed('No path');
    const second = await app.seed('Also no path');

    const report = await app.withoutWrites().complete([first.id, second.id]);

    expect(report).toMatchObject({ status: 'refused', requested: 2, accepted: 0, refused: 2, refreshed: false });
    expect(report.entities.every((entity) => !entity.ok && entity.reason === 'writes-unavailable')).toBe(true);
    expect(await app.stored(first.id)).toMatchObject({ executionState: 'backlog' });
  });

  it('deletes every marked task, and reports one that is already gone as a member result', async () => {
    const app = await world();
    const first = await app.seed('Delete me');
    const second = await app.seed('Delete me too');
    const third = await app.seed('Already gone');
    expect(await deleteTask(app.deps, { taskId: third.id, expectedRevision: third.revision })).toMatchObject({ ok: true });

    const report = await app.remove([first.id, second.id, third.id]);

    expect(report).toMatchObject({ action: 'task.bulk.delete', status: 'partial', requested: 3, accepted: 2, refused: 1 });
    // A task that was already gone when the world was read is an unloaded id, and says so.
    expect(report.entities[2]).toMatchObject({ ok: false, reason: 'unknown-task' });
    expect(await app.stored(first.id)).toBeUndefined();
    expect(await app.stored(second.id)).toBeUndefined();
    expect((await app.state()).tasks).toHaveLength(0);

    // A record that vanishes *after* the world was read is a different fact, and the write path's
    // own word for it: the selection knew about the task, so it is reported as a member that lost
    // its record rather than as an id nobody loaded.
    const fourth = await app.seed('Vanishes after the read');
    const rendered = await app.state();
    expect(await deleteTask(app.deps, { taskId: fourth.id, expectedRevision: fourth.revision })).toMatchObject({ ok: true });
    const vanished = await bulkDeleteTasks(
      {
        state: rendered,
        writes: async () => ({
          updateTask: (input) => updateTask(app.deps, input),
          deleteTask: (input) => deleteTask(app.deps, input),
        }),
        unavailableReason: () => null,
        refresh: async () => null,
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      },
      { taskIds: [fourth.id] },
    );
    expect(vanished).toMatchObject({ status: 'refused', requested: 1, accepted: 0, refused: 1 });
    expect(vanished.entities[0]).toMatchObject({ ok: false, reason: 'not-found' });
  });
});
