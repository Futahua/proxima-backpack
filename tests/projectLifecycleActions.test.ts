/**
 * The Projects Hub's lifecycle sequences, over the real store and the real recovery gate.
 *
 * Two claims. The first is the one every write sequence in this tree makes: the revision written
 * against is the one the surface was *rendering*, a lost race is a refusal rather than an overwrite,
 * and an accepted write re-reads rather than redrawing from a guess. The second is this module's own:
 * **delete's refusal passes through unchanged**. The operation answers `policy-not-decided` with the
 * counts it would affect, and a reader who clicked Delete is given that answer rather than a wrapper
 * that says "unavailable" — which is also why the UI and an agent cannot answer differently for any
 * of the five verbs: there is one operation, and both callers reach it.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { archiveProject, createProject, deleteProject, restoreProject } from '../src/app/projectMutations.js';
import {
  archiveProjectAction,
  createProjectAction,
  deleteProjectAction,
  restoreProjectAction,
  type ProjectLifecycleDependencies,
  type ProjectLifecycleOutcome,
} from '../src/app/projectLifecycleActions.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T10:00:00+07:00';

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
  readonly refreshCalls: string[];
  readonly refusals: (string | null)[];
  state(): Promise<ProximaState>;
  /** The shell's dependencies, with the sinks recorded. */
  shell(options?: { readonly writesAvailable?: boolean; readonly rendered?: ProximaState }): ProjectLifecycleDependencies;
  seed(name: string, withTask?: boolean): Promise<{ projectId: OpaqueRecordId; revision: string }>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1300;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const source = recordStoreStateSource(store);
  const refreshCalls: string[] = [];
  const refusals: (string | null)[] = [];
  const read = async (): Promise<ProximaState> => (await source.load()).state;

  return {
    files,
    deps,
    refreshCalls,
    refusals,
    state: read,
    shell: (options = {}) => ({
      state: options.rendered ?? null,
      writes: async () => (options.writesAvailable === false
        ? null
        : {
            createProject: (request) => createProject(deps, request),
            updateProject: async () => { throw new Error('not used'); },
            archiveProject: (input) => archiveProject(deps, input),
            restoreProject: (input) => restoreProject(deps, input),
            deleteProject: (input) => deleteProject(deps, input),
          }),
      unavailableReason: () => 'record-writes-need-an-activated-store',
      refresh: async (reason) => {
        refreshCalls.push(reason);
        return await refreshFrom(source, reason);
      },
      setRefusal: (reason) => { refusals.push(reason); },
      render: () => undefined,
    }),
    seed: async (name, withTask = false) => {
      const created = await createProject(deps, { name });
      if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason}`);
      if (withTask) {
        const task = await createTask(deps, { name: `${name} task`, projectId: created.recordId, executionState: 'backlog' });
        if (!task.ok) throw new Error(`seeding the task failed: ${task.reason}`);
      }
      return { projectId: created.recordId, revision: created.revision };
    },
  };
}

async function refreshFrom(source: ReturnType<typeof recordStoreStateSource>, reason: Parameters<ProjectLifecycleDependencies['refresh']>[0]) {
  void reason;
  // The shell's refresh is the session's; here it is the source reloading, which is the same read.
  await source.load();
  return {
    ok: true,
    reason,
    outcome: 'changed' as const,
    changed: true,
    snapshot: {
      sourceRevision: 2,
      lastSuccessfulRefreshRevision: 2,
      refreshState: 'idle' as const,
      stale: false,
      lastRefreshReason: reason,
      lastRefreshProblemCode: null,
      pendingRefreshCount: 0,
      load: await source.load(),
    },
  };
}

/** What the projection shows for one project, so "the surfaces converged" is checkable. */
async function projectById(app: World, id: OpaqueRecordId) {
  return (await app.state()).projects.find((project) => project.id === id);
}

describe('Stage 11 lifecycle sequences', () => {
  it('creates a project through the sequence the New Project modal will call', async () => {
    const app = await world();
    const rendered = await app.state();

    const outcome = await createProjectAction(app.shell({ rendered }), { name: 'From the modal', description: 'Typed by hand' });

    expect(outcome).toMatchObject({ ok: true, verb: 'create', outcome: 'created', refreshed: true });
    expect(app.refreshCalls).toEqual(['manual']);
    expect(app.refusals).toEqual([null]);
    const created = (await app.state()).projects.find((project) => project.name === 'From the modal');
    expect(created).toMatchObject({ description: 'Typed by hand', status: 'active' });
  });

  it('archives and restores what the surface was showing, and answers the same either way', async () => {
    const ui = await world();
    const agent = await world();
    const uiProject = await ui.seed('Archives', true);
    const agentProject = await agent.seed('Archives', true);

    const rendered = await ui.state();
    const fromUi = await archiveProjectAction(ui.shell({ rendered }), { projectId: uiProject.projectId });
    const fromAgent = await archiveProject(agent.deps, { projectId: agentProject.projectId, expectedRevision: agentProject.revision });

    // Same verb, same outcome, same shape: the ids differ because the worlds allocate their own.
    expect(fromUi).toMatchObject({ ok: true, verb: 'archive', outcome: 'archived' });
    expect(fromAgent).toMatchObject({ ok: true, outcome: 'archived' });
    expect(await projectById(ui, uiProject.projectId)).toMatchObject({ status: 'archived' });
    expect(await projectById(agent, agentProject.projectId)).toMatchObject({ status: 'archived' });

    const restored = await restoreProjectAction(ui.shell({ rendered: await ui.state() }), { projectId: uiProject.projectId });
    expect(restored).toMatchObject({ ok: true, verb: 'restore', outcome: 'restored' });
    expect(await projectById(ui, uiProject.projectId)).toMatchObject({ status: 'active' });
  });

  it('passes delete\'s refusal through as the operation wrote it, and writes nothing', async () => {
    const app = await world();
    const project = await app.seed('Has members', true);

    const outcome: ProjectLifecycleOutcome = await deleteProjectAction(app.shell({ rendered: await app.state() }), { projectId: project.projectId });

    expect(outcome).toMatchObject({ ok: false, verb: 'delete', reason: 'policy-not-decided' });
    if (outcome.ok) return;
    // The sentence is the operation's own — the counts and the decision — not a wrapper's.
    expect(outcome.detail).toContain('1 task(s) and 0 event(s)');
    expect(outcome.detail).toContain('creator');
    expect(app.refusals).toEqual([null, 'policy-not-decided']);
    // A refusal that is not a lost race does not re-read: the world did not move.
    expect(app.refreshCalls).toEqual([]);
    expect(await projectById(app, project.projectId)).toMatchObject({ name: 'Has members' });
  });

  it('refuses a caller that lost a race, with the revision that beat it', async () => {
    const app = await world();
    const project = await app.seed('Raced');
    const rendered = await app.state();

    // Someone else archives it first, so the rendered revision is stale.
    const winner = await archiveProject(app.deps, { projectId: project.projectId, expectedRevision: project.revision });
    expect(winner).toMatchObject({ ok: true });

    const stale = await archiveProjectAction(app.shell({ rendered }), { projectId: project.projectId });

    expect(stale).toMatchObject({ ok: false, verb: 'archive', reason: 'stale-revision', refreshed: true });
    // The winner's state stands, and the surfaces were re-read so the card shows it.
    expect(await projectById(app, project.projectId)).toMatchObject({ status: 'archived' });
    expect(app.refreshCalls).toEqual(['manual']);
  });

  it('refuses without a write path, and does not resolve one for a project the hub is not showing', async () => {
    const app = await world();
    const project = await app.seed('No path');

    const unavailable = await archiveProjectAction(app.shell({ writesAvailable: false, rendered: await app.state() }), { projectId: project.projectId });
    expect(unavailable).toMatchObject({ ok: false, reason: 'writes-unavailable', detail: 'record-writes-need-an-activated-store' });
    expect(app.refreshCalls).toEqual([]);

    // A project the rendered hub does not hold: refused before any write path is resolved, because
    // there is no revision to write against and guessing one is how a surface overwrites an edit.
    const refusalsBefore = app.refusals.length;
    const unknown = await archiveProjectAction(app.shell({ rendered: await app.state() }), { projectId: idFromLastByte(199) });
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown-project' });
    expect(app.refusals).toHaveLength(refusalsBefore);
  });
});
