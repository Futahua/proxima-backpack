/**
 * The project workflow board's gesture, over the real store and the real recovery gate.
 *
 * The claim these cases exist to protect is A2, and it is a claim about what *does not* change: a
 * workflow drop moves a task between project stages, and the execution state, the Elastic order and
 * completion are all exactly what they were. A task in Review is still Running — that is the
 * sentence the stage's acceptance box uses, and the case asserts it as data rather than as prose.
 *
 * The other half is that the three moves are three different mutations: into a stage writes the
 * stage *and* its position (the canonical record refuses either alone), inside a stage writes only
 * the order, and out of the workflow clears both. A gesture that got that wrong would either lose
 * the position or leave a task pointing at a stage it left.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { moveTaskToWorkflowStage, workflowMoveAction, workflowMutationsFor } from '../src/app/workflowMoveGesture.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { CanonicalWorkflowStageStateRecord } from '../src/domain/canonicalTaskState.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds, type RecordingAudit } from './test-semantic-audit.js';

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

const PROJECT = idFromLastByte(71);
const OTHER_PROJECT = idFromLastByte(72);
const DESIGN = idFromLastByte(73);
const REVIEW = idFromLastByte(74);
const FOREIGN = idFromLastByte(75);

function projectRecord(id: OpaqueRecordId, name: string): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

function stageRecord(id: OpaqueRecordId, projectId: OpaqueRecordId, name: string): CanonicalWorkflowStageStateRecord {
  return { ...defineCanonicalRecordHeader({ kind: 'workflow-stage', id, name }), projectId };
}

interface World {
  readonly deps: TaskMutationDependencies;
  readonly refreshCalls: string[];
  /** The run's terminal events, so a case asserts what a drop owed rather than assuming it. */
  readonly audit: RecordingAudit;
  seedTask(): Promise<{ id: OpaqueRecordId; revision: string }>;
  task(id: OpaqueRecordId): Promise<CanonicalTaskRecordV2>;
  projected(id: OpaqueRecordId): Promise<{ executionState?: string; workflowStageId?: string | null; workflowOrder?: number | null; orderIndex?: number } | undefined>;
  move(input: {
    taskId: OpaqueRecordId;
    from: string | null;
    to: string | null;
    targetIndex: number | null;
    expectedRevision: string;
  }): ReturnType<typeof moveTaskToWorkflowStage>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 500;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };

  for (const record of [
    projectRecord(PROJECT, 'Project'),
    projectRecord(OTHER_PROJECT, 'Other project'),
    stageRecord(DESIGN, PROJECT, 'Design'),
    stageRecord(REVIEW, PROJECT, 'Review'),
    stageRecord(FOREIGN, OTHER_PROJECT, 'Foreign stage'),
  ]) {
    await store.createIfAbsent(record as CanonicalRecordV2);
  }

  const source = recordStoreStateSource(store);
  const refresh = createRefreshController({ initial: await source.load(), source });
  const refreshCalls: string[] = [];
  const audit = recordingAudit();

  return {
    audit,
    deps,
    refreshCalls,
    seedTask: async () => {
      // A task in Design, Running, with an Elastic order of its own: everything the independence
      // case needs to be able to see survive a workflow drop.
      const created = await createTask(deps, {
        name: 'Workflow task',
        projectId: PROJECT,
        executionState: 'running',
        executionOrder: 4,
        workflowStageId: DESIGN,
        workflowOrder: 1,
      });
      if (!created.ok) throw new Error(`seeding failed: ${created.reason}`);
      return { id: created.recordId, revision: created.revision };
    },
    task: async (id) => {
      const observation = await deps.store.read(id);
      if (observation === undefined) throw new Error(`task ${id} is not in the store`);
      return observation.record as CanonicalTaskRecordV2;
    },
    projected: async (id) => {
      const loaded = await source.load();
      const task = loaded.state.tasks.find((candidate) => candidate.id === id);
      return task === undefined
        ? undefined
        : { executionState: task.status, workflowStageId: task.workflowStageId, workflowOrder: task.workflowOrder, orderIndex: task.orderIndex };
    },
    move: async (input) => await moveTaskToWorkflowStage(
      {
        updateTask: (request) => updateTask(deps, request),
        refresh: async (reason: RefreshReason): Promise<RefreshResult> => {
          refreshCalls.push(reason);
          return await refresh.refreshSource(reason);
        },
        ids: semanticIds(),
        audit,
      },
      input,
    ),
  };
}

describe('Stage 10 workflow drop', () => {
  it('names the move from the two stages, and writes the mutation that move is', () => {
    expect(workflowMoveAction(DESIGN, REVIEW)).toBe('move');
    expect(workflowMoveAction(DESIGN, DESIGN)).toBe('reorder');
    expect(workflowMoveAction(DESIGN, null)).toBe('leave');
    expect(workflowMoveAction(null, DESIGN)).toBe('move');

    // Into a stage: the stage and its position together, because the record refuses either alone.
    expect(workflowMutationsFor(DESIGN, REVIEW, 2)).toEqual([{ kind: 'workflow-stage', value: REVIEW, order: 2 }]);
    // Inside a stage: an order change and nothing else.
    expect(workflowMutationsFor(REVIEW, REVIEW, 0)).toEqual([{ kind: 'workflow-order', value: 0 }]);
    // Out of the workflow: both cleared.
    expect(workflowMutationsFor(REVIEW, null, null)).toEqual([{ kind: 'workflow-stage', value: null, order: null }]);
  });

  it('moves a card between stages without touching the execution dimension', async () => {
    const app = await world();
    const task = await app.seedTask();

    const moved = await app.move({ taskId: task.id, from: DESIGN, to: REVIEW, targetIndex: 2, expectedRevision: task.revision });

    // The verb the drop is, D79: a stage change, not a flattened `task.update` - and one event, whose
    // id is the one the result carries, emitted after convergence rather than before it.
    expect(moved).toMatchObject({ ok: true, outcome: 'moved', actionType: 'task.workflow.move', workflowAction: 'move', refreshed: true });
    expect(app.refreshCalls).toEqual(['manual']);
    const accepted = moved.ok ? moved.requestId : 'no request id';
    expect(app.audit.events).toEqual([
      {
        requestId: accepted,
        actionType: 'task.workflow.move',
        outcome: 'accepted',
        entityIds: [task.id],
      },
    ]);

    const stored = await app.task(task.id);
    expect(stored).toMatchObject({
      workflowStageId: REVIEW,
      workflowOrder: 2,
      // A2, as data: a task in Review is still Running, and nothing Elastic moved.
      executionState: 'running',
      executionOrder: 4,
      isCompleted: false,
    });
    // And the surfaces read it back through the projection the store-as-source produces.
    expect(await app.projected(task.id)).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 2, executionState: 'running', orderIndex: 4 });
  });

  it('reorders inside a stage without disturbing the stage or the Elastic order', async () => {
    const app = await world();
    const task = await app.seedTask();

    const reordered = await app.move({ taskId: task.id, from: DESIGN, to: DESIGN, targetIndex: 0, expectedRevision: task.revision });

    expect(reordered).toMatchObject({ ok: true, workflowAction: 'reorder' });
    expect(await app.task(task.id)).toMatchObject({ workflowStageId: DESIGN, workflowOrder: 0, executionState: 'running', executionOrder: 4 });
  });

  it('takes a card out of the workflow, and refuses a position for a drop that has none', async () => {
    const app = await world();
    const task = await app.seedTask();

    const left = await app.move({ taskId: task.id, from: DESIGN, to: null, targetIndex: null, expectedRevision: task.revision });

    expect(left).toMatchObject({ ok: true, workflowAction: 'leave' });
    expect(await app.task(task.id)).toMatchObject({ workflowStageId: null, workflowOrder: null, executionState: 'running', executionOrder: 4 });

    // A caller that supplied a position for a leave has a bug, and is refused rather than ignored.
    const second = await app.task(task.id);
    const revision = (await app.deps.store.read(task.id))!.observedRevision;
    const refused = await app.move({ taskId: task.id, from: null, to: null, targetIndex: 3, expectedRevision: revision });
    expect(refused).toMatchObject({ ok: false, reason: 'validation-refused', workflowAction: 'leave' });
    expect(await app.task(task.id)).toEqual(second);
  });

  it('refuses a stage that belongs to another project rather than taking the card out of its own', async () => {
    const app = await world();
    const task = await app.seedTask();

    const refused = await app.move({ taskId: task.id, from: DESIGN, to: FOREIGN, targetIndex: 0, expectedRevision: task.revision });

    expect(refused).toMatchObject({ ok: false, outcome: 'refused', reason: 'semantic-conflict' });
    expect(await app.task(task.id)).toMatchObject({ workflowStageId: DESIGN, workflowOrder: 1 });
  });

  it('sends a card back to where the store says it is when the drop lost a race', async () => {
    const app = await world();
    const task = await app.seedTask();

    // Someone else moves the card first, so the board's revision is stale.
    const winner = await updateTask(app.deps, {
      taskId: task.id,
      expectedRevision: task.revision,
      mutations: [{ kind: 'workflow-stage', value: REVIEW, order: 0 }],
    });
    expect(winner.ok).toBe(true);

    const refused = await app.move({ taskId: task.id, from: DESIGN, to: REVIEW, targetIndex: 5, expectedRevision: task.revision });

    expect(refused).toMatchObject({ ok: false, reason: 'stale-revision', refreshed: true });
    if (refused.ok) return;
    expect(refused.actualRevision).toBe(winner.ok ? winner.revision : undefined);
    // The winner's position stands, and the loser's five never landed.
    expect(await app.task(task.id)).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 0 });
    expect(await app.projected(task.id)).toMatchObject({ workflowStageId: REVIEW, workflowOrder: 0 });
  });

  it('lets a card with no stage enter one', async () => {
    const app = await world();
    const created = await createTask(app.deps, { name: 'Stageless', projectId: PROJECT, executionState: 'backlog', executionOrder: 0 });
    if (!created.ok) throw new Error('create failed');

    const moved = await app.move({ taskId: created.recordId, from: null, to: DESIGN, targetIndex: 1, expectedRevision: created.revision });

    expect(moved).toMatchObject({ ok: true, workflowAction: 'move' });
    expect(await app.task(created.recordId)).toMatchObject({ workflowStageId: DESIGN, workflowOrder: 1, executionState: 'backlog' });
  });
});
