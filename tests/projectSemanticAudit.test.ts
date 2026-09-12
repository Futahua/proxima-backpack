/**
 * The semantic envelope on the project lifecycle: five verbs, one sequence, and a refusal that is an answer.
 *
 * `createProjectAction`, `updateProjectAction`, `archiveProjectAction`, `restoreProjectAction` and
 * `deleteProjectAction` all run through `runLifecycle`, so the id is minted once and the journal names the verb
 * as `project.<verb>`. The interesting member is the last one: Delete refuses with the operation's own
 * `policy-not-decided` while the creator has not answered, and that refusal is a real answer rather than a
 * missing feature - so it leaves a correlated, machine-readable event like every other refusal, instead of
 * being the one path with nothing to trace.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  archiveProjectAction,
  createProjectAction,
  deleteProjectAction,
  restoreProjectAction,
  updateProjectAction,
  type ProjectLifecycleDependencies,
  type ProjectLifecycleOperations,
} from '../src/app/projectLifecycleActions.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  restoreProject,
  updateProject,
  type ProjectMutationDependencies,
} from '../src/app/projectMutations.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T14:30:00+07:00';

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
  bytes[14] = 0xa4;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

interface WorldOptions {
  readonly writesAvailable?: boolean;
}

async function world(options: WorldOptions = {}) {
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
  const mutationDeps: ProjectMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFor((serial += 1)),
  };
  const seeded = await createProject(mutationDeps, { name: 'Backpack' });
  if (!seeded.ok) throw new Error('seeding the project failed');

  const source = recordStoreStateSource(store);
  let state: ProximaState = (await source.load()).state;
  const audit = recordingAudit();
  const order: string[] = [];

  const operations: ProjectLifecycleOperations = {
    createProject: (request) => createProject(mutationDeps, request),
    updateProject: (input) => updateProject(mutationDeps, input),
    archiveProject: (input) => archiveProject(mutationDeps, input),
    restoreProject: (input) => restoreProject(mutationDeps, input),
    deleteProject: (input) => deleteProject(mutationDeps, input),
  };

  const deps: ProjectLifecycleDependencies = {
    get state() { return state; },
    writes: async () => (options.writesAvailable === false ? null : operations),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      state = (await source.load()).state;
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

  return {
    deps,
    audit,
    order,
    projectId: seeded.recordId as string,
    /** Somebody else edits the project through the store, so this shell's copy of it is stale. */
    bumpName: async (projectId: string, name: string): Promise<void> => {
      const fresh = (await source.load()).state;
      const current = fresh.projects.find((candidate) => candidate.id === projectId)!;
      const result = await updateProject(mutationDeps, {
        projectId: current.id as OpaqueRecordId,
        expectedRevision: current.source.revision,
        mutations: [{ kind: 'name', value: name }],
      });
      if (!result.ok) throw new Error(`the other writer was refused: ${result.reason}`);
    },
  };
}

describe('the semantic envelope on the project lifecycle', () => {
  it('mints an id on a create and journals it as project.create', async () => {
    const w = await world();
    const outcome = await createProjectAction(w.deps, { name: 'Second project' });

    expect(outcome.ok).toBe(true);
    expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'project.create',
      outcome: 'accepted',
      entityIds: [outcome.ok ? outcome.recordId : ''],
    });
    expect(w.order).toEqual(['refresh', 'render', 'audit:accepted']);
  });

  it('names each verb across the four writes that land', async () => {
    const w = await world();
    const updated = await updateProjectAction(w.deps, {
      projectId: w.projectId,
      mutations: [{ kind: 'name', value: 'Backpack (renamed)' }],
    });
    expect(updated.ok).toBe(true);

    const archived = await archiveProjectAction(w.deps, { projectId: w.projectId });
    expect(archived.ok).toBe(true);

    const restored = await restoreProjectAction(w.deps, { projectId: w.projectId });
    expect(restored.ok).toBe(true);

    expect(w.audit.events.map((event) => [event.actionType, event.outcome])).toEqual([
      ['project.update', 'accepted'],
      ['project.archive', 'accepted'],
      ['project.restore', 'accepted'],
    ]);
    expect(w.audit.events.map((event) => event.requestId)).toEqual([
      updated.requestId,
      archived.requestId,
      restored.requestId,
    ]);
  });

  it('treats the delete policy refusal as an answer: correlated, coded, and converging nothing', async () => {
    const w = await world();
    const refused = await deleteProjectAction(w.deps, { projectId: w.projectId });

    expect(refused).toMatchObject({ ok: false, verb: 'delete' });
    expect(refused.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: refused.requestId,
      actionType: 'project.delete',
      outcome: 'rejected',
      entityIds: [w.projectId],
    });
    // The operation's own machine-readable reason travels into the journal, so "why did nothing happen" is
    // answerable from the event alone rather than only from a sentence on screen.
    expect(w.audit.events[0]!.errorCode).toBeDefined();
    // Nothing was written, so nothing converged; the surface still redraws to show the answer.
    expect(w.order).toEqual(['render', 'audit:rejected']);
  });

  it('refuses a project the hub does not hold, with the envelope rather than without it', async () => {
    const w = await world();
    const outcome = await archiveProjectAction(w.deps, { projectId: 'pxr_missing' });

    expect(outcome).toMatchObject({ ok: false, reason: 'unknown-project' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'project.archive',
      outcome: 'rejected',
      entityIds: ['pxr_missing'],
      errorCode: 'unknown-project',
    });
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('correlates a create with no write path, naming no target because none exists yet', async () => {
    const w = await world({ writesAvailable: false });
    const outcome = await createProjectAction(w.deps, { name: 'Second project' });

    expect(outcome).toMatchObject({ ok: false, reason: 'writes-unavailable', verb: 'create' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'project.create',
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'writes-unavailable',
    });
  });

  it('correlates a lost race, and converges because the store moved under it', async () => {
    const w = await world();
    await w.bumpName(w.projectId, 'Somebody else got there first');
    w.order.length = 0;

    const lost = await updateProjectAction(w.deps, {
      projectId: w.projectId,
      mutations: [{ kind: 'name', value: 'Mine' }],
    });

    expect(lost).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(w.audit.events.at(-1)).toMatchObject({
      requestId: lost.requestId,
      actionType: 'project.update',
      outcome: 'rejected',
      entityIds: [w.projectId],
      errorCode: 'stale-revision',
    });
    // A lost race is the one refusal where the surface was already wrong, so it does re-read.
    expect(w.order).toEqual(['refresh', 'render', 'audit:rejected']);
  });
});
