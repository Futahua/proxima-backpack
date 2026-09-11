/**
 * Project lifecycle operations, over the real store and the real recovery gate.
 *
 * The cases are about the two promises the module makes. **Archive is not a delete:** the members'
 * own bytes are snapshotted before and after, so a task or event that moved, or was marked, or lost
 * a field, would fail the case rather than merely look wrong in a projection. **Delete is an open
 * question:** the refusal is asserted to be deterministic, typed, informative about what it would
 * affect, and to have changed nothing at all — including the members and the project itself.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  restoreProject,
  updateProject,
} from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalEventRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:30:00+07:00';

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

interface World {
  readonly files: MemoryRecordFiles;
  readonly deps: TaskMutationDependencies;
  state(): Promise<ProximaState>;
  /** Every record file's exact text and revision: the durable store as bytes. */
  bytes(): Promise<Record<string, string>>;
  create(name: string): ReturnType<typeof createProject>;
  /** A project holding both a task and an event, which is the case A4 made ordinary. */
  combined(): Promise<{ projectId: OpaqueRecordId; revision: string }>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1200;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const source = recordStoreStateSource(store);

  return {
    files,
    deps,
    state: async () => (await source.load()).state,
    bytes: async () => {
      const names = await files.listRecordFiles();
      const snapshot: Record<string, string> = {};
      for (const name of names) {
        const file = await files.readRecordFile(name as never);
        if (file !== undefined) snapshot[name] = `${file.revision}\u0000${file.text}`;
      }
      return snapshot;
    },
    create: async (name) => await createProject(deps, { name }),
    combined: async () => {
      const created = await createProject(deps, { name: 'Combined project', description: 'Holds both kinds' });
      if (!created.ok) throw new Error(`creating the combined project failed: ${created.reason}`);
      const task = await createTask(deps, { name: 'Its task', projectId: created.recordId, executionState: 'backlog' });
      if (!task.ok) throw new Error(`creating the task failed: ${task.reason}`);
      const event: CanonicalEventRecordV2 = {
        ...defineCanonicalRecordHeader({ kind: 'event', id: idFromLastByte(1299), name: 'Its event' }),
        description: 'An event in the same project',
        projectId: created.recordId,
        startDate: '2026-10-01T09:00:00.000Z',
        deadline: '2026-10-01T10:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        isCompleted: false,
        properties: {},
        recurrence: null,
      };
      await store.createIfAbsent(event as CanonicalRecordV2);
      return { projectId: created.recordId, revision: created.revision };
    },
  };
}

describe('Stage 11 project lifecycle operations', () => {
  it('creates a project that is active and has never been archived', async () => {
    const app = await world();

    const created = await app.create('Fresh project');

    expect(created).toMatchObject({ ok: true, outcome: 'created' });
    if (!created.ok) return;
    expect(created.record).toMatchObject({
      kind: 'project',
      name: 'Fresh project',
      description: '',
      status: 'active',
      archivedAt: null,
      artifactBindings: [],
      createdAt: '2026-09-12T02:30:00.000Z',
    });

    // And the refusals happen before a byte moves.
    const before = await app.bytes();
    expect(await createProject(app.deps, { name: '   ' })).toMatchObject({ ok: false, reason: 'validation-refused', detail: 'a project needs a name' });
    expect(await createProject(app.deps, { name: 'x'.repeat(201) })).toMatchObject({ ok: false, reason: 'validation-refused' });
    expect(await createProject(app.deps, { name: 'Long description', description: 'y'.repeat(20_001) })).toMatchObject({ ok: false, reason: 'validation-refused' });
    expect(await app.bytes()).toEqual(before);
  });

  it('updates the fields a project has, and refuses a caller that lost a race', async () => {
    const app = await world();
    const created = await app.create('Before');
    if (!created.ok) throw new Error('create failed');

    const updated = await updateProject(app.deps, {
      projectId: created.recordId,
      expectedRevision: created.revision,
      mutations: [{ kind: 'name', value: 'After' }, { kind: 'description', value: 'Now with a description' }],
    });
    expect(updated).toMatchObject({ ok: true, outcome: 'updated' });
    if (!updated.ok) return;
    expect(updated.record).toMatchObject({ name: 'After', description: 'Now with a description', status: 'active' });

    // An empty mutation list is a caller bug, not a no-op write.
    expect(await updateProject(app.deps, { projectId: created.recordId, expectedRevision: updated.revision, mutations: [] }))
      .toMatchObject({ ok: false, reason: 'validation-refused' });

    // And a stale caller is told the revision that beat it rather than overwriting it.
    const stale = await updateProject(app.deps, {
      projectId: created.recordId,
      expectedRevision: created.revision,
      mutations: [{ kind: 'name', value: 'Too late' }],
    });
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision', actualRevision: updated.revision });
  });

  it('archives a project holding both tasks and events without touching either', async () => {
    const app = await world();
    const combined = await app.combined();
    const before = await app.bytes();

    const archived = await archiveProject(app.deps, { projectId: combined.projectId, expectedRevision: combined.revision });

    expect(archived).toMatchObject({ ok: true, outcome: 'archived' });
    if (!archived.ok) return;
    expect(archived.record).toMatchObject({ status: 'archived', archivedAt: '2026-09-12T02:30:00.000Z' });

    // Every member record is byte-identical: an archive that touched a task would be a delete with
    // another name, and the only way to assert that is against the members' own bytes.
    const after = await app.bytes();
    for (const [name, content] of Object.entries(before)) {
      if (name.startsWith(combined.projectId)) continue;
      expect(after[name]).toBe(content);
    }
    const state = await app.state();
    expect(state.tasks.map((task) => task.name)).toEqual(['Its task']);
    expect(state.events.map((event) => event.name)).toEqual(['Its event']);
    expect(state.projects[0]).toMatchObject({ status: 'archived' });

    // Archiving twice is a conflict rather than a silent second write; restoring brings it back and
    // clears the date that belonged to the archive.
    const again = await archiveProject(app.deps, { projectId: combined.projectId, expectedRevision: archived.revision });
    expect(again).toMatchObject({ ok: false, reason: 'semantic-conflict' });
    const restored = await restoreProject(app.deps, { projectId: combined.projectId, expectedRevision: archived.revision });
    expect(restored).toMatchObject({ ok: true, outcome: 'restored' });
    if (!restored.ok) return;
    expect(restored.record).toMatchObject({ status: 'active', archivedAt: null });
    expect(await restoreProject(app.deps, { projectId: combined.projectId, expectedRevision: restored.revision }))
      .toMatchObject({ ok: false, reason: 'semantic-conflict' });

    // The archive and the restore are two writes, and the members are still untouched by both: the
    // project's own file moved to its third revision while every member stayed where it was.
    const final = await app.bytes();
    expect(final[`${combined.projectId}.json`]).toContain('"status": "active"');
    expect(final[`${combined.projectId}.json`]).not.toBe(before[`${combined.projectId}.json`]);
    for (const [name, content] of Object.entries(before)) {
      if (name.startsWith(combined.projectId)) continue;
      expect(final[name]).toBe(content);
    }
  });

  it('refuses a delete as an open question, deterministically and without changing anything', async () => {
    const app = await world();
    const combined = await app.combined();
    const before = await app.bytes();

    const refused = await deleteProject(app.deps, { projectId: combined.projectId, expectedRevision: combined.revision });

    expect(refused).toMatchObject({ ok: false, reason: 'policy-not-decided' });
    if (refused.ok) return;
    // It names what the decision affects, so a reader can answer it, and it names no path: inferring
    // the old plugin's filesystem behaviour is exactly what the checklist forbids.
    expect(refused.detail).toContain('1 task(s) and 1 event(s)');
    expect(refused.detail).toContain('creator');
    const refusedDetail = refused.detail;
    expect(before[`${combined.projectId}.json`]).toBeDefined();
    expect((await app.bytes())).toEqual(before);

    // Deterministic: the same request refuses the same way, with the same words.
    const again = await deleteProject(app.deps, { projectId: combined.projectId, expectedRevision: combined.revision });
    expect(again).toMatchObject({ ok: false, reason: 'policy-not-decided' });
    if (!again.ok) expect(again.detail).toBe(refusedDetail);

    // A stale caller is refused as stale before the policy question is even reached.
    const stale = await deleteProject(app.deps, { projectId: combined.projectId, expectedRevision: `${combined.projectId}@99` });
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision' });
  });

  it('keeps a project with no members deletable-shaped: the refusal names zero members', async () => {
    const app = await world();
    const empty = await app.create('Empty project');
    if (!empty.ok) throw new Error('create failed');

    const refused = await deleteProject(app.deps, { projectId: empty.recordId, expectedRevision: empty.revision });

    // The refusal is about the policy, not about the members: an empty project is refused for the
    // same reason and with the same reason code as a full one, which is what makes the answer a
    // decision rather than a side effect of how many tasks happen to exist.
    expect(refused).toMatchObject({ ok: false, reason: 'policy-not-decided' });
    if (!refused.ok) expect(refused.detail).toContain('0 task(s) and 0 event(s)');
  });
});
