/**
 * Stage 10's acceptance claims that are about *durability and identity* rather than about a gesture.
 *
 * Three of the stage's acceptance boxes name properties a mutation must not destroy: a query must not
 * be a write, a relation must not depend on the title of the record it points at, and a deletion must
 * survive the store being reopened. None of them needs a new mechanism — they need the claim asserted
 * where it could quietly stop being true.
 *
 * The first one is asserted by snapshotting every record file's exact bytes and revision before and
 * after, because "presentation only" means the durable store did not move at all, not that the
 * projection looked right. The third is asserted by rebuilding the store and the projection from the
 * same durable files with nothing carried in memory, which is what a restart is at this level.
 */
import { describe, expect, it } from 'vitest';
import { applyBacklogControl } from '../src/app/backlogControls.js';
import { EMPTY_BACKLOG_VIEW, projectBacklog, type BacklogViewState } from '../src/app/backlogView.js';
import { bulkDeleteTasks } from '../src/app/bulkTaskActions.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, deleteTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { defineCanonicalPropertySchema } from '../src/domain/canonicalSchema.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { Project, ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T08:30:00+07:00';

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

const PROJECT = idFromLastByte(101);
const BLOCKS = idFromLastByte(102);

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
  readonly deps: TaskMutationDependencies;
  state(): Promise<ProximaState>;
  project(): Promise<Project>;
  stored(id: OpaqueRecordId): Promise<CanonicalTaskRecordV2 | undefined>;
  seed(name: string, properties?: CanonicalTaskRecordV2['properties']): Promise<{ id: OpaqueRecordId; revision: string }>;
  /** Every record file's exact text and revision: the durable store as bytes. */
  bytes(): Promise<Record<string, string>>;
  /** A store and source rebuilt over the same durable files, with nothing carried in memory. */
  reopen(): Promise<ProximaState>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1000;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };

  await store.createIfAbsent(projectRecord(PROJECT) as CanonicalRecordV2);
  await store.createIfAbsent(defineCanonicalPropertySchema({
    header: defineCanonicalRecordHeader({ kind: 'schema', id: BLOCKS, name: 'Blocks' }),
    definition: { type: 'relation', targetKinds: ['task'] },
  }) as CanonicalRecordV2);

  const source = recordStoreStateSource(store);
  const read = async (): Promise<ProximaState> => (await source.load()).state;

  return {
    files,
    deps,
    state: read,
    project: async () => {
      const found = (await read()).projects.find((candidate) => candidate.id === PROJECT);
      if (found === undefined) throw new Error('project is not in the projection');
      return found;
    },
    stored: async (id) => {
      const observation = await store.read(id);
      return observation === undefined ? undefined : observation.record as CanonicalTaskRecordV2;
    },
    seed: async (name, properties = {}) => {
      const created = await createTask(deps, { name, projectId: PROJECT, executionState: 'backlog', executionOrder: 0, properties });
      if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason}`);
      return { id: created.recordId, revision: created.revision };
    },
    bytes: async () => {
      const names = await files.listRecordFiles();
      const snapshot: Record<string, string> = {};
      for (const name of names) {
        const file = await files.readRecordFile(name as never);
        if (file !== undefined) snapshot[name] = `${file.revision}\u0000${file.text}`;
      }
      return snapshot;
    },
    reopen: async () => {
      // New store, new source, nothing shared but the durable files themselves.
      const reopened = createCanonicalJsonRecordStore(files);
      return (await recordStoreStateSource(reopened).load()).state;
    },
  };
}

describe('Stage 10 acceptance: what a mutation must not destroy', () => {
  it('leaves every record byte-identical through a search, a filter and a sort', async () => {
    const app = await world();
    await app.seed('Alpha task');
    await app.seed('Beta task');
    await app.seed('Gamma task');
    // A task the query must hide, so "the query did something" is not assumed: the filter below
    // keeps only names containing an "a", and this one has none.
    await app.seed('Hidden one');
    const before = await app.bytes();

    // The whole query engine, as a caller would drive it: type, filter, sort — then project.
    let view: BacklogViewState = { ...EMPTY_BACKLOG_VIEW, projectId: PROJECT };
    view = { ...view, query: applyBacklogControl(view.query, { kind: 'set-search', search: 'task' }) };
    view = { ...view, query: applyBacklogControl(view.query, { kind: 'add-filter', filter: { id: 'filter-1', field: 'name', operator: 'contains', value: 'a' } }) };
    view = { ...view, query: applyBacklogControl(view.query, { kind: 'sort-by', field: 'name' }) };

    const projection = projectBacklog(await app.state(), await app.project(), view);
    // The query is real — one of the four tasks is filtered out — and the store still did not move.
    expect(projection.rows.map((row) => row.name)).toEqual(['Alpha task', 'Beta task', 'Gamma task']);
    expect(projection.rows.some((row) => row.name === 'Hidden one')).toBe(false);
    expect(projection.search).toBe('task');
    expect(projection.filterChips).toHaveLength(1);
    expect(projection.sortIndicator).not.toBeNull();

    // Presentation only, asserted at the durable store rather than at the projection: every record
    // file is the same bytes at the same revision as before the query existed.
    expect(await app.bytes()).toEqual(before);
  });

  it('keeps a relation intact when the record it points at is renamed', async () => {
    const app = await world();
    const target = await app.seed('Target task');
    const source = await app.seed('Blocking task', { [BLOCKS]: { type: 'relation', value: { relationSchemaId: BLOCKS, targetRecordIds: [target.id] } } });

    const before = (await app.stored(source.id))!.properties[BLOCKS];
    expect(before).toEqual({ type: 'relation', value: { relationSchemaId: BLOCKS, targetRecordIds: [target.id] } });

    const renamed = await updateTask(app.deps, {
      taskId: target.id,
      expectedRevision: target.revision,
      mutations: [{ kind: 'name', value: 'Renamed target' }],
    });
    expect(renamed).toMatchObject({ ok: true });

    // A6 in one assertion: the relation stored is the target's id, so the target's title is not part
    // of it — renaming the target leaves the blocking task's property byte-identical, and the
    // projection still resolves the same id.
    const after = (await app.stored(source.id))!.properties[BLOCKS];
    expect(after).toEqual(before);
    const state = await app.state();
    expect(state.tasks.find((task) => task.id === target.id)?.name).toBe('Renamed target');
    expect(state.tasks.find((task) => task.id === source.id)?.properties[BLOCKS]).toEqual(target.id);
  });

  it('keeps a bulk deletion through a store reopened from the same files', async () => {
    const app = await world();
    const first = await app.seed('Delete one');
    const second = await app.seed('Delete two');
    const survivor = await app.seed('Survivor');
    const survivorRevision = (await app.state()).tasks.find((task) => task.id === survivor.id)?.source.revision;

    const report = await bulkDeleteTasks(
      {
        state: await app.state(),
        writes: async () => ({
          updateTask: async () => { throw new Error('not used'); },
          deleteTask: (input) => deleteTask(app.deps, input),
        }),
        unavailableReason: () => null,
        refresh: async () => null,
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      },
      { taskIds: [first.id, second.id] },
    );
    expect(report).toMatchObject({ status: 'accepted', requested: 2, accepted: 2 });

    // Nothing carried in memory: a fresh store over the same durable files is what a restart is here.
    const reopened = await app.reopen();
    expect(reopened.tasks.map((task) => task.id)).toEqual([survivor.id]);
    expect(reopened.tasks[0]!.source.revision).toBe(survivorRevision);
    expect(await app.stored(first.id)).toBeUndefined();
    expect(await app.stored(second.id)).toBeUndefined();
  });
});
