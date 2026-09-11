/**
 * Stage 17's workflow-stage writes, proven through the real store boundary and the real recovery
 * coordinator rather than against a stub of either.
 *
 * The cases attack the path rather than describe it. A create is refused four ways before it is
 * allowed once; a rename is raced; a delete is asked to remove a stage that still holds cards; a
 * remap is pointed at the stage being deleted and at another project's stage; and one case makes a
 * card change mid-sequence so that the partial remap has to be reported instead of hidden.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { encodeRecordDocument, recordFileNameFor } from '../src/app/jsonRecordStore.js';
import { canonicalRecordV2Codec } from '../src/app/canonicalRecordCodec.js';
import { projectRecordState } from '../src/app/recordStateProjection.js';
import {
  createTask,
  type TaskMutationDependencies,
} from '../src/app/taskMutations.js';
import {
  createWorkflowStage,
  deleteWorkflowStage,
  renameWorkflowStage,
  type WorkflowStageMutationDependencies,
  type WorkflowStageMutationResult,
} from '../src/app/workflowStageMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import {
  defineCanonicalRecordHeader,
  opaqueRecordIdFromRandomBytes,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import { canonicalOrderPosition } from '../src/domain/canonicalOrdering.js';
import type {
  CanonicalProjectRecordV2,
  CanonicalRecordV2,
  CanonicalTaskRecordV2,
} from '../src/domain/canonicalRecordV2.js';
import type { CanonicalWorkflowStageStateRecord } from '../src/domain/canonicalTaskState.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T07:00:00+07:00';

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
const OTHER_PROJECT = idFromLastByte(2);
const REVIEW = idFromLastByte(3);
const DONE = idFromLastByte(4);
const THEIR_STAGE = idFromLastByte(5);
const FIRST_TASK = idFromLastByte(20);
const SECOND_TASK = idFromLastByte(21);
const THIRD_TASK = idFromLastByte(22);

function projectRecord(id: OpaqueRecordId, name: string): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'project',
      id,
      name,
    }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

function stageRecord(
  id: OpaqueRecordId,
  projectId: OpaqueRecordId,
  name: string,
): CanonicalWorkflowStageStateRecord {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'workflow-stage',
      id,
      name,
    }),
    projectId,
  };
}

function taskRecord(
  id: OpaqueRecordId,
  name: string,
  projectId: OpaqueRecordId,
  workflowStageId: OpaqueRecordId | null,
  workflowOrder: number | null,
): CanonicalTaskRecordV2 {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'task',
      id,
      name,
    }),
    projectId,
    executionState: 'running',
    workflowStageId,
    executionOrder: canonicalOrderPosition(1),
    workflowOrder: workflowOrder === null ? null : canonicalOrderPosition(workflowOrder),
    description: '',
    weight: 1,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-08-02T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
    recurrence: null,
  };
}

interface World {
  files: MemoryRecordFiles;
  store: ReturnType<typeof createCanonicalJsonRecordStore>;
  deps: WorkflowStageMutationDependencies;
}

async function world(
  seed: readonly CanonicalRecordV2[] = [],
): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  await recovery.load();
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: {
      next: (prefix = 'id') => `${prefix}-request`,
    },
  });
  let nextId = 100;
  const taskDependencies: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const deps: WorkflowStageMutationDependencies = {
    store,
    coordinator,
    allocateRecordId: () => idFromLastByte(nextId++),
    taskDependencies,
  };

  for (const record of [
    projectRecord(PROJECT, 'Project') as CanonicalRecordV2,
    projectRecord(OTHER_PROJECT, 'Other project') as CanonicalRecordV2,
    stageRecord(REVIEW, PROJECT, 'Review') as CanonicalRecordV2,
    stageRecord(DONE, PROJECT, 'Done') as CanonicalRecordV2,
    stageRecord(THEIR_STAGE, OTHER_PROJECT, 'Their review') as CanonicalRecordV2,
    ...seed,
  ]) {
    const created = await store.createIfAbsent(record);
    expect(created.ok).toBe(true);
  }

  return { files, store, deps };
}

/** Every record file's revision, so "nothing moved" is a comparison rather than a claim. */
async function revisions(files: MemoryRecordFiles): Promise<Record<string, string>> {
  const names = await files.listRecordFiles();
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = (await files.readRecordFile(name as never))?.revision ?? '';
  }
  return out;
}

function ok(result: WorkflowStageMutationResult): Extract<WorkflowStageMutationResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  return result;
}

function refusalOf(result: WorkflowStageMutationResult): Extract<WorkflowStageMutationResult, { ok: false }> {
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

async function stageOf(worldValue: World, id: OpaqueRecordId): Promise<CanonicalWorkflowStageStateRecord | undefined> {
  const observation = await worldValue.store.read(id);
  return observation?.kind === 'workflow-stage'
    ? observation.record as CanonicalWorkflowStageStateRecord
    : undefined;
}

async function taskOf(worldValue: World, id: OpaqueRecordId): Promise<CanonicalTaskRecordV2 | undefined> {
  const observation = await worldValue.store.read(id);
  return observation?.kind === 'task'
    ? observation.record as CanonicalTaskRecordV2
    : undefined;
}

async function revisionOf(worldValue: World, id: OpaqueRecordId): Promise<string> {
  const observation = await worldValue.store.read(id);
  if (observation === undefined) throw new Error(`no record ${id}`);
  return observation.observedRevision;
}

describe('Stage 17 workflow-stage writes', () => {
  it('creates a stage through the store boundary, and refuses every invalid request before writing', async () => {
    const worldValue = await world();
    const before = await revisions(worldValue.files);

    expect(refusalOf(await createWorkflowStage(worldValue.deps, {
      projectId: PROJECT,
      name: '   ',
    }))).toMatchObject({
      reason: 'validation-refused',
      detail: 'a workflow stage needs a name',
    });
    expect(refusalOf(await createWorkflowStage(worldValue.deps, {
      projectId: PROJECT,
      name: 'x'.repeat(201),
    })).reason).toBe('validation-refused');
    expect(refusalOf(await createWorkflowStage(worldValue.deps, {
      projectId: idFromLastByte(90),
      name: 'Blocked',
    }))).toMatchObject({
      reason: 'not-found',
    });
    // A stage id is not a project id: the kind is part of the answer, not an afterthought.
    expect(refusalOf(await createWorkflowStage(worldValue.deps, {
      projectId: REVIEW,
      name: 'Blocked',
    })).reason).toBe('not-found');

    expect(await revisions(worldValue.files)).toEqual(before);

    const created = ok(await createWorkflowStage(worldValue.deps, {
      projectId: PROJECT,
      name: '  Waiting  ',
    }));
    expect(created.outcome).toBe('created');
    expect(created.record).toMatchObject({
      kind: 'workflow-stage',
      name: 'Waiting',
      projectId: PROJECT,
    });
    expect(created.remappedTaskIds).toEqual([]);
    expect(await stageOf(worldValue, created.recordId)).toMatchObject({
      name: 'Waiting',
      projectId: PROJECT,
    });

    // The projection the surfaces read draws it as a stage of that project, with no gaps.
    const projection = projectRecordState(await worldValue.store.list());
    expect(projection.state.workflowStages?.map((stage) => stage.name)).toContain('Waiting');
    expect(projection.report.gaps).toEqual([]);
  });

  it('renames a stage, and refuses a rename built on a revision someone else has already changed', async () => {
    const worldValue = await world();
    const original = await revisionOf(worldValue, REVIEW);

    const renamed = ok(await renameWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: original,
      name: 'In review',
    }));
    expect(renamed.outcome).toBe('renamed');
    expect(renamed.recordId).toBe(REVIEW);
    expect(await stageOf(worldValue, REVIEW)).toMatchObject({
      id: REVIEW,
      name: 'In review',
      projectId: PROJECT,
    });

    // The loser is told the revision that beat it rather than guessing, and the name stands.
    const refused = refusalOf(await renameWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: original,
      name: 'Renamed by the loser',
    }));
    expect(refused.reason).toBe('stale-revision');
    expect(refused.actualRevision).toBe(renamed.revision);
    expect(await stageOf(worldValue, REVIEW)).toMatchObject({ name: 'In review' });

    expect(refusalOf(await renameWorkflowStage(worldValue.deps, {
      stageId: idFromLastByte(91),
      expectedRevision: original,
      name: 'Nowhere',
    })).reason).toBe('not-found');
  });

  it('refuses to delete a stage that still holds cards without being told where they go', async () => {
    const worldValue = await world([
      taskRecord(FIRST_TASK, 'First', PROJECT, REVIEW, 0) as CanonicalRecordV2,
      taskRecord(SECOND_TASK, 'Second', PROJECT, REVIEW, 1) as CanonicalRecordV2,
    ]);
    const before = await revisions(worldValue.files);

    const refused = refusalOf(await deleteWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: await revisionOf(worldValue, REVIEW),
    }));
    expect(refused.reason).toBe('semantic-conflict');
    expect(refused.detail).toBe('the stage still holds 2 task(s); say where they go before deleting it');
    expect(await revisions(worldValue.files)).toEqual(before);
    expect(await stageOf(worldValue, REVIEW)).toBeDefined();
    expect(await taskOf(worldValue, FIRST_TASK)).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 0 });
  });

  it('remaps the cards into another stage and only then deletes it', async () => {
    const worldValue = await world([
      taskRecord(FIRST_TASK, 'First', PROJECT, REVIEW, 0) as CanonicalRecordV2,
      taskRecord(SECOND_TASK, 'Second', PROJECT, REVIEW, 1) as CanonicalRecordV2,
      taskRecord(THIRD_TASK, 'Already done', PROJECT, DONE, 4) as CanonicalRecordV2,
    ]);

    const deleted = ok(await deleteWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: await revisionOf(worldValue, REVIEW),
      remapTo: { kind: 'stage', stageId: DONE },
    }));
    expect(deleted.outcome).toBe('deleted');
    expect(deleted.record).toBeNull();
    // The tasks move in a stable id order, so the same request twice produces the same layout.
    expect(deleted.remappedTaskIds).toEqual([FIRST_TASK, SECOND_TASK]);
    expect(await stageOf(worldValue, REVIEW)).toBeUndefined();
    // Appended after the card the target stage already had, not over it.
    expect(await taskOf(worldValue, FIRST_TASK)).toMatchObject({ workflowStageId: DONE, workflowOrder: 5 });
    expect(await taskOf(worldValue, SECOND_TASK)).toMatchObject({ workflowStageId: DONE, workflowOrder: 6 });
    expect(await taskOf(worldValue, THIRD_TASK)).toMatchObject({ workflowStageId: DONE, workflowOrder: 4 });

    // No card is left naming a stage that is gone.
    const projection = projectRecordState(await worldValue.store.list());
    expect(projection.report.gaps).toEqual([]);
    expect(projection.state.workflowStages?.map((stage) => stage.id)).toEqual([DONE, THEIR_STAGE]);
    expect(projection.state.tasks.filter((task) => task.workflowStageId === DONE).map((task) => task.id))
      .toEqual([FIRST_TASK, SECOND_TASK, THIRD_TASK].sort());
  });

  it('takes the cards out of the workflow when the caller says there is no stage for them', async () => {
    const worldValue = await world([
      taskRecord(FIRST_TASK, 'First', PROJECT, REVIEW, 0) as CanonicalRecordV2,
    ]);

    const deleted = ok(await deleteWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: await revisionOf(worldValue, REVIEW),
      remapTo: { kind: 'no-stage' },
    }));
    expect(deleted.remappedTaskIds).toEqual([FIRST_TASK]);
    expect(await taskOf(worldValue, FIRST_TASK)).toMatchObject({
      workflowStageId: null,
      workflowOrder: null,
      executionState: 'running',
    });
    expect(await stageOf(worldValue, REVIEW)).toBeUndefined();
    expect(projectRecordState(await worldValue.store.list()).report.gaps).toEqual([]);
  });

  it('refuses a remap pointed at the stage itself or at another project, and refuses a stale delete', async () => {
    const worldValue = await world([
      taskRecord(FIRST_TASK, 'First', PROJECT, REVIEW, 0) as CanonicalRecordV2,
    ]);
    const revision = await revisionOf(worldValue, REVIEW);
    const before = await revisions(worldValue.files);

    expect(refusalOf(await deleteWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: revision,
      remapTo: { kind: 'stage', stageId: REVIEW },
    }))).toMatchObject({
      reason: 'validation-refused',
      detail: 'a stage cannot be remapped to itself',
    });
    expect(refusalOf(await deleteWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: revision,
      remapTo: { kind: 'stage', stageId: THEIR_STAGE },
    }))).toMatchObject({
      reason: 'semantic-conflict',
      detail: 'that workflow stage belongs to another project',
    });
    const stale = refusalOf(await deleteWorkflowStage(worldValue.deps, {
      stageId: REVIEW,
      expectedRevision: 'invented-revision',
      remapTo: { kind: 'no-stage' },
    }));
    expect(stale.reason).toBe('stale-revision');
    expect(stale.actualRevision).toBe(revision);
    expect(await revisions(worldValue.files)).toEqual(before);

    // An empty stage needs no target at all.
    const emptied = ok(await deleteWorkflowStage(worldValue.deps, {
      stageId: DONE,
      expectedRevision: await revisionOf(worldValue, DONE),
    }));
    expect(emptied.remappedTaskIds).toEqual([]);
    expect(await stageOf(worldValue, DONE)).toBeUndefined();
  });

  it('stops part-way when a card changes while the stage is being emptied, and names the ones that moved', async () => {
    const worldValue = await world([
      taskRecord(FIRST_TASK, 'First', PROJECT, REVIEW, 0) as CanonicalRecordV2,
      taskRecord(SECOND_TASK, 'Second', PROJECT, REVIEW, 1) as CanonicalRecordV2,
    ]);

    // A peer renames the second card after the first has moved: the listed revision is now stale,
    // so the sequence must stop rather than write over the peer's change.
    let executes = 0;
    const peer = {
      execute: async (mutation: Parameters<typeof worldValue.deps.coordinator.execute>[0]) => {
        const result = await worldValue.deps.coordinator.execute(mutation);
        executes += 1;
        if (executes === 1) {
          const current = await revisionOf(worldValue, SECOND_TASK);
          const renamed = { ...(await taskOf(worldValue, SECOND_TASK))!, name: 'Renamed by a peer' };
          const written = await worldValue.files.writeRecordFileIfUnchanged(
            recordFileNameFor(SECOND_TASK),
            encodeRecordDocument(renamed, canonicalRecordV2Codec),
            current,
          );
          expect(written.ok).toBe(true);
        }
        return result;
      },
    };
    // The member writes go through the task dependencies, so that is the coordinator the peer
    // has to race — replacing only the stage's own would leave the case testing nothing.
    const peerDeps: WorkflowStageMutationDependencies = {
      ...worldValue.deps,
      coordinator: peer,
      taskDependencies: {
        ...worldValue.deps.taskDependencies,
        coordinator: peer,
      },
    };

    const refused = refusalOf(await deleteWorkflowStage(peerDeps, {
      stageId: REVIEW,
      expectedRevision: await revisionOf(worldValue, REVIEW),
      remapTo: { kind: 'stage', stageId: DONE },
    }));
    expect(refused.reason).toBe('stale-revision');
    expect(refused.detail).toBe(`task ${SECOND_TASK} changed while the stage was being emptied`);
    expect(refused.remappedTaskIds).toEqual([FIRST_TASK]);
    // The stage is still there, because a delete that could not empty it must not happen.
    expect(await stageOf(worldValue, REVIEW)).toBeDefined();
    expect(await taskOf(worldValue, FIRST_TASK)).toMatchObject({ workflowStageId: DONE, workflowOrder: 0 });
    expect(await taskOf(worldValue, SECOND_TASK)).toMatchObject({
      workflowStageId: REVIEW,
      name: 'Renamed by a peer',
    });
  });
});

describe('Stage 17 workflow-stage writes alongside the task operations', () => {
  it('creates a stage and a card into it with the same dependencies, and reads both back', async () => {
    const worldValue = await world();
    const stage = ok(await createWorkflowStage(worldValue.deps, {
      projectId: PROJECT,
      name: 'Waiting',
    }));

    const created = await createTask(worldValue.deps.taskDependencies, {
      name: 'Blocked on the creator',
      projectId: PROJECT,
      workflowStageId: stage.recordId,
      workflowOrder: 0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await taskOf(worldValue, created.recordId)).toMatchObject({
      workflowStageId: stage.recordId,
      workflowOrder: 0,
    });
    expect(projectRecordState(await worldValue.store.list()).report.gaps).toEqual([]);
  });
});
