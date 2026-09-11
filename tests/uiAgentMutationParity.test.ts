/**
 * Stage 9's agent parity: one operation, two callers, the same everything.
 *
 * The checklist's five boxes under "Agent parity" compare a UI caller with the programmatic entry
 * point. That entry point is the semantic write path itself — `createTask`, `updateTask` and
 * `deleteTask` over the record store, which is what an agent-facing caller meets (the loopback
 * bridge is a read-only vault reader, so it is not one) — and the parity claim is that a human
 * gesture and a submitted request are the *same* operation: same acceptance, same validation, same
 * stale behaviour, same resulting revision, same resulting inspection state, and the same words
 * when something is refused.
 *
 * Each case therefore runs twice, in two identical worlds, once through the sequence the UI
 * executes and once through a directly submitted typed request. The two worlds allocate their own
 * record ids, so every comparison is made with the ids normalised away — the point is that the
 * *operation* is identical, not that two random ids are.
 */
import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { performElasticDrop } from '../src/app/elasticDropAction.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTaskAction, newTaskDraft } from '../src/app/taskCreate.js';
import { applyTaskEditorEdit, taskEditorDraftFor } from '../src/app/taskEditor.js';
import { deleteTaskAction, saveTaskAction } from '../src/app/taskEditorWrite.js';
import { createTask, deleteTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T06:00:00+07:00';
const BUILD = {
  proximaVersion: '0.1.0',
  gitSha: 'parity',
  buildMode: 'fixture',
  domainSchemaVersion: '2',
  controlSchemaVersion: '1',
  fixtureSchemaVersion: '1',
  fixtureHash: 'parity',
  lockfileHash: 'parity',
  fixedClock: CLOCK_ISO,
};

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

const PROJECT = idFromLastByte(51);

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

/**
 * The value with every opaque record id replaced, so two worlds can be compared.
 *
 * Identity is the one thing the two callers *should* differ in — each world allocates its own — and
 * a comparison that carried it would be testing the allocator rather than the operation.
 */
function oid(value: string): OpaqueRecordId {
  return value as OpaqueRecordId;
}

function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/pxr_[0-9a-f]{32}/g, '<id>'));
}

interface UiOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly detail?: string;
  readonly revision?: string;
  readonly actualRevision?: string;
  readonly recordId?: OpaqueRecordId;
}

interface World {
  readonly deps: TaskMutationDependencies;
  readonly store: ReturnType<typeof createCanonicalJsonRecordStore>;
  state(): Promise<ProximaState>;
  task(id: string): Promise<Task>;
  storedRevision(id: string): Promise<string | undefined>;
  seed(name: string): Promise<{ id: OpaqueRecordId; revision: string }>;
  inspection(): Promise<ReturnType<typeof createInspectionProjection>>;
  /** The sequences a UI gesture runs, with the shell's sinks left inert. */
  ui: {
    create(name: string): Promise<UiOutcome>;
    save(input: { taskId: string; fieldId: string; value: string; rendered?: ProximaState }): Promise<UiOutcome>;
    move(input: { taskId: string; to: 'backlog' | 'running' | 'finished'; index: number; rendered?: ProximaState }): Promise<UiOutcome>;
    remove(taskId: string): Promise<UiOutcome>;
  };
}

async function world(seedOffset: number): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = seedOffset;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  await store.createIfAbsent(projectRecord(PROJECT) as CanonicalRecordV2);

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const read = async (): Promise<ProximaState> => (await source.load()).state;
  const refreshFromSource = async (reason: RefreshReason): Promise<RefreshResult> => await refresh.refreshSource(reason);
  const sinks = { unavailableReason: () => null, refresh: refreshFromSource, setRefusal: () => undefined, render: () => undefined };

  const taskOf = async (id: string): Promise<Task> => {
    const state = await read();
    const found = state.tasks.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`task ${id} is not in the projection`);
    return found;
  };

  return {
    deps,
    store,
    state: read,
    task: taskOf,
    storedRevision: async (id) => (await store.read(oid(id)))?.observedRevision,
    seed: async (name) => {
      const created = await createTask(deps, { name, projectId: PROJECT, executionState: 'backlog', executionOrder: 0 });
      if (!created.ok) throw new Error(`seeding failed: ${created.reason}`);
      return { id: created.recordId, revision: created.revision };
    },
    inspection: async () => {
      const loaded = await source.load();
      const dispatcher = createActionDispatcher({
        state: loaded.state,
        problems: [],
        revisions: loaded.revisions,
        mode: 'fixture',
        clock: fixedClock(CLOCK_ISO),
        idGenerator: sequentialIdGenerator(),
      });
      return createInspectionProjection(dispatcher.snapshot(), BUILD);
    },
    ui: {
      create: async (name) => {
        const rendered = await read();
        const effect = await createTaskAction(
          { state: rendered, writes: async () => ({ createTask: (request) => createTask(deps, request) }), ...sinks },
          { draft: applyTaskEditorEdit(newTaskDraft(rendered, PROJECT), { fieldId: 'name', value: name }) },
        );
        return effect.outcome ?? { ok: false, reason: 'not-open' };
      },
      save: async (input) => {
        const rendered = input.rendered ?? await read();
        const effect = await saveTaskAction(
          {
            state: rendered,
            writes: async () => ({
              updateTask: (request) => updateTask(deps, request),
              deleteTask: async () => { throw new Error('not used'); },
            }),
            ...sinks,
          },
          { taskId: input.taskId, draft: applyTaskEditorEdit(taskEditorDraftFor(await taskOf(input.taskId)), { fieldId: input.fieldId, value: input.value }) },
        );
        return effect.outcome ?? { ok: false, reason: 'not-open' };
      },
      move: async (input) => {
        const rendered = input.rendered ?? await read();
        return await performElasticDrop(
          { state: rendered, writes: async () => ({ updateTask: (request) => updateTask(deps, request) }), ...sinks },
          { taskId: input.taskId, targetColumn: input.to, targetIndex: input.index },
        );
      },
      remove: async (taskId) => {
        const effect = await deleteTaskAction(
          {
            state: await read(),
            writes: async () => ({
              updateTask: async () => { throw new Error('not used'); },
              deleteTask: (request) => deleteTask(deps, request),
            }),
            ...sinks,
          },
          { taskId },
        );
        return effect.outcome ?? { ok: false, reason: 'not-open' };
      },
    },
  };
}

/** Only the fields both outcome shapes share, so a comparison cannot pass on a field one lacks. */
function shared(outcome: UiOutcome): { ok: boolean; reason?: string; detail?: string; actualRevision?: string } {
  return {
    ok: outcome.ok,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    ...(outcome.actualRevision === undefined ? {} : { actualRevision: outcome.actualRevision }),
  };
}

describe('Stage 9 agent parity', () => {
  it('accepts the same action through the programmatic entry point', async () => {
    const ui = await world(600);
    const agent = await world(700);

    // create
    expect(await ui.ui.create('Parity task')).toMatchObject({ ok: true });
    expect(await createTask(agent.deps, { name: 'Parity task', projectId: PROJECT, executionState: 'backlog', executionOrder: 0 })).toMatchObject({ ok: true });
    const uiTask = (await ui.state()).tasks.find((task) => task.name === 'Parity task')!;
    const agentTask = (await agent.state()).tasks.find((task) => task.name === 'Parity task')!;
    expect(canonical(agentTask)).toEqual(canonical(uiTask));

    // update
    expect(await ui.ui.save({ taskId: uiTask.id, fieldId: 'name', value: 'Renamed by parity' })).toMatchObject({ ok: true });
    expect(await updateTask(agent.deps, {
      taskId: oid(agentTask.id),
      expectedRevision: agentTask.source.revision,
      mutations: [{ kind: 'name', value: 'Renamed by parity' }],
    })).toMatchObject({ ok: true });
    expect(canonical(await agent.task(agentTask.id))).toEqual(canonical(await ui.task(uiTask.id)));

    // move between columns
    expect(await ui.ui.move({ taskId: uiTask.id, to: 'running', index: 2 })).toMatchObject({ ok: true });
    expect(await updateTask(agent.deps, {
      taskId: oid(agentTask.id),
      expectedRevision: (await agent.store.read(oid(agentTask.id)))!.observedRevision,
      mutations: [{ kind: 'execution-state', value: 'running' }, { kind: 'execution-order', value: 2 }],
    })).toMatchObject({ ok: true });
    expect(canonical(await agent.task(agentTask.id))).toEqual(canonical(await ui.task(uiTask.id)));

    // reorder inside the column
    expect(await ui.ui.move({ taskId: uiTask.id, to: 'running', index: 0 })).toMatchObject({ ok: true });
    expect(await updateTask(agent.deps, {
      taskId: oid(agentTask.id),
      expectedRevision: (await agent.store.read(oid(agentTask.id)))!.observedRevision,
      mutations: [{ kind: 'execution-state', value: 'running' }, { kind: 'execution-order', value: 0 }],
    })).toMatchObject({ ok: true });
    expect(canonical(await agent.task(agentTask.id))).toEqual(canonical(await ui.task(uiTask.id)));

    // delete
    expect(await ui.ui.remove(uiTask.id)).toMatchObject({ ok: true });
    expect(await deleteTask(agent.deps, { taskId: oid(agentTask.id), expectedRevision: (await agent.store.read(oid(agentTask.id)))!.observedRevision })).toMatchObject({ ok: true });
    expect(await ui.storedRevision(uiTask.id)).toBeUndefined();
    expect(await agent.storedRevision(agentTask.id)).toBeUndefined();
    expect((await ui.state()).tasks).toHaveLength(0);
    expect((await agent.state()).tasks).toHaveLength(0);
  });

  it('refuses the same invalid request with the same words', async () => {
    const ui = await world(800);
    const agent = await world(900);
    const uiTask = await ui.seed('Validate me');
    const agentTask = await agent.seed('Validate me');

    const uiRefused = await ui.ui.save({ taskId: uiTask.id, fieldId: 'name', value: '   ' });
    const agentRefused = await updateTask(agent.deps, {
      taskId: oid(agentTask.id),
      expectedRevision: agentTask.revision,
      mutations: [{ kind: 'name', value: '   ' }],
    });

    expect(uiRefused).toMatchObject({ ok: false, reason: 'validation-refused', detail: 'a task needs a name' });
    expect(shared(uiRefused)).toEqual(shared(agentRefused as UiOutcome));
    // Neither caller moved the record.
    expect(await ui.storedRevision(uiTask.id)).toBe(uiTask.revision);
    expect(await agent.storedRevision(agentTask.id)).toBe(agentTask.revision);
  });

  it('loses the same race in the same way, and says who won', async () => {
    const ui = await world(1000);
    const agent = await world(1100);
    const uiTask = await ui.seed('Raced by parity');
    const agentTask = await agent.seed('Raced by parity');

    // Each caller is holding the record as its own surface rendered it, and a winner writes first.
    const rendered = await ui.state();
    expect(await updateTask(ui.deps, { taskId: uiTask.id, expectedRevision: uiTask.revision, mutations: [{ kind: 'name', value: 'Winner' }] })).toMatchObject({ ok: true });
    expect(await updateTask(agent.deps, { taskId: oid(agentTask.id), expectedRevision: agentTask.revision, mutations: [{ kind: 'name', value: 'Winner' }] })).toMatchObject({ ok: true });

    const uiStale = await ui.ui.save({ taskId: uiTask.id, fieldId: 'weight', value: '5', rendered });
    const agentStale = await updateTask(agent.deps, {
      taskId: oid(agentTask.id),
      expectedRevision: agentTask.revision,
      mutations: [{ kind: 'weight', value: 5 }],
    });

    expect(uiStale).toMatchObject({ ok: false, reason: 'stale-revision' });
    // Both are told the revision that beat them, in the same words and with the same value shape:
    // the revision each world reports names its own record, so identity is normalised away.
    expect(canonical(shared(uiStale))).toEqual(canonical(shared(agentStale as UiOutcome)));
    expect(uiStale.actualRevision).toBe((await ui.store.read(oid(uiTask.id)))!.observedRevision);
    // The winner's value stands in both worlds and the loser's never landed.
    expect((await ui.state()).tasks[0]).toMatchObject({ name: 'Winner', weight: 1 });
    expect((await agent.state()).tasks[0]).toMatchObject({ name: 'Winner', weight: 1 });
  });

  it('reports the same resulting revision for the same accepted write', async () => {
    const ui = await world(1200);
    const agent = await world(1300);
    const uiTask = await ui.seed('Same revision');
    const agentTask = await agent.seed('Same revision');

    const uiOutcome = await ui.ui.save({ taskId: uiTask.id, fieldId: 'weight', value: '3' });
    const agentOutcome = await updateTask(agent.deps, {
      taskId: oid(agentTask.id),
      expectedRevision: agentTask.revision,
      mutations: [{ kind: 'weight', value: 3 }],
    });

    expect(uiOutcome).toMatchObject({ ok: true });
    expect(agentOutcome).toMatchObject({ ok: true });
    // Both were told the revision the store observed, and it is the same revision once identity
    // is normalised away: one accepted write, one revision, on both paths.
    expect(uiOutcome.revision).toBe(await ui.storedRevision(uiTask.id));
    expect(canonical(uiOutcome.revision)).toBe(canonical((agentOutcome as { revision: string }).revision));
    expect(canonical(uiOutcome.revision)).toBe(canonical(await agent.storedRevision(agentTask.id)));
  });

  it('produces the same inspection state, with the same record-store provenance', async () => {
    const ui = await world(1400);
    const agent = await world(1500);
    const uiTask = await ui.seed('Inspected');
    const agentTask = await agent.seed('Inspected');
    await ui.ui.move({ taskId: uiTask.id, to: 'running', index: 1 });
    await updateTask(agent.deps, {
      taskId: oid(agentTask.id),
      expectedRevision: agentTask.revision,
      mutations: [{ kind: 'execution-state', value: 'running' }, { kind: 'execution-order', value: 1 }],
    });

    const uiInspection = await ui.inspection();
    const agentInspection = await agent.inspection();
    const uiEntry = uiInspection.board.tasks.find((task) => task.id === uiTask.id)!;
    const agentEntry = agentInspection.board.tasks.find((task) => task.id === agentTask.id)!;

    expect(canonical(agentEntry)).toEqual(canonical(uiEntry));
    expect(uiEntry).toMatchObject({ column: 'running', provenance: { idOrigin: 'record-store' } });

    const uiRevision = uiInspection.recordRevisions.find((entry) => entry.id === uiTask.id)!;
    const agentRevision = agentInspection.recordRevisions.find((entry) => entry.id === agentTask.id)!;
    expect(canonical(agentRevision)).toEqual(canonical(uiRevision));
    expect(uiRevision.kind).toBe('task');
  });
});
