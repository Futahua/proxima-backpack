/**
 * The semantic envelope on the workflow drop: `moveTaskToWorkflowStage`, and the board drop that wraps it.
 *
 * D79 names the two verbs a drop can be — `task.workflow.move` for entering or leaving a stage,
 * `task.workflow.reorder` for a position inside one — and this file is where that naming is behavioural
 * rather than structural: one terminal event per drop, after convergence where the store moved, carrying
 * the id the result carries.
 *
 * The wrapper is the reason this suite exists rather than the gesture's own cases alone. `performWorkflowDrop`
 * refuses twice before the gesture is ever reached — a card the board is not showing, and a run with no write
 * path — so it mints at its own boundary and hands the id down; a gesture that minted a second one would make
 * one drop two events, and a wrapper that minted none would make those two refusals invisible.
 *
 * The operations here are injected stubs around a card in the state, which is the seam both modules declare:
 * what this file is about is the envelope they owe. The record layer's own behaviour is covered by
 * `tests/workflowMoveGesture.test.ts` and `tests/projectWorkflowBoard.test.ts`, which write through a real store.
 */
import { describe, expect, it } from 'vitest';

import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { TASK_MUTATION_SCHEMA_VERSION, type TaskMutationResult } from '../src/app/taskMutations.js';
import { performWorkflowDrop, type WorkflowBoardDropDependencies, type WorkflowBoardDropIntent } from '../src/app/workflowBoardDrop.js';
import { moveTaskToWorkflowStage, type WorkflowMoveGestureDependencies, type WorkflowMoveGestureInput } from '../src/app/workflowMoveGesture.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { IdGenerator } from '../src/domain/clock.js';
import { EMPTY_STATE, type ProximaState, type Task } from '../src/domain/types.js';
import { recordingAudit } from './test-semantic-audit.js';

const DESIGN = 'stage-design';
const REVIEW = 'stage-review';
const REVISION = 'task@1';

function opaque(serial: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const CARD = opaque(1);

function task(overrides: Partial<Task> = {}): Task {
  return {
    source: { path: `Proxima/tasks/${CARD}.md`, revision: REVISION, kind: 'task', idOrigin: 'frontmatter' },
    id: CARD,
    name: 'Workflow card',
    description: '',
    projectId: 'project-1',
    status: 'running',
    weight: 1,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-01-02T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
    workflowStageId: DESIGN,
    workflowOrder: 1,
    ...overrides,
  };
}

interface WorldOptions {
  readonly writesAvailable?: boolean;
  readonly answer?: 'ok' | 'stale';
  /** The card the board is showing; null means the board holds no such card. */
  readonly card?: Task | null;
}

function world(options: WorldOptions = {}) {
  const state: ProximaState = {
    ...EMPTY_STATE,
    tasks: options.card === null ? [] : [options.card ?? task()],
  };

  const audit = recordingAudit();
  const order: string[] = [];
  /** The revisions the write was handed, so "wrote against what it read" is asserted rather than assumed. */
  const revisions: string[] = [];
  let writes = 0;

  const updateTask = async (input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly unknown[];
  }): Promise<TaskMutationResult> => {
    writes += 1;
    revisions.push(input.expectedRevision);
    if (options.answer === 'stale') {
      return {
        ok: false,
        schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
        reason: 'stale-revision',
        detail: 'another writer moved this card first',
        actualRevision: 'task@2',
      };
    }
    return {
      ok: true,
      schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
      outcome: 'updated',
      recordId: input.taskId,
      revision: 'task@2',
      record: null,
    };
  };

  // A counting id source rather than a sequential one, because the number of ids a drop consumes is the
  // claim: the wrapper mints one and hands it down, so an accepted drop consumes exactly one id. A gesture
  // that minted its own would consume two and no assertion about the event would notice.
  let minted = 0;
  const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-${(minted += 1)}` };

  const auditDeps = {
    ids,
    audit: {
      append: (event: Parameters<typeof audit.append>[0]) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  const gestureDeps: WorkflowMoveGestureDependencies = {
    updateTask,
    refresh: async () => {
      order.push('refresh');
      return null;
    },
    ...auditDeps,
  };

  const deps: WorkflowBoardDropDependencies = {
    state,
    writes: async () => (options.writesAvailable === false ? null : { updateTask }),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      return null;
    },
    setRefusal: () => {},
    render: () => { order.push('render'); },
    ...auditDeps,
  };

  return {
    deps,
    audit,
    order,
    revisions,
    writes: () => writes,
    /** How many semantic ids this world handed out: one per drop, not one per layer. */
    minted: () => minted,
    /** The gesture directly, for the cases that are about the gesture rather than about the wrapper. */
    gesture: async (input: WorkflowMoveGestureInput) => await moveTaskToWorkflowStage(gestureDeps, input),
    drop: async (intent: Partial<WorkflowBoardDropIntent> = {}) =>
      await performWorkflowDrop(deps, { taskId: CARD, targetStageId: REVIEW, targetIndex: 2, ...intent }),
  };
}

describe('the semantic envelope on the workflow drop', () => {
  it('mints an id on a stage change and journals it as task.workflow.move', async () => {
    const w = await world();

    const moved = await w.drop();

    expect(moved).toMatchObject({ ok: true, actionType: 'task.workflow.move', workflowAction: 'move' });
    if (!moved.ok) throw new Error('the drop was refused');
    expect(moved.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toEqual([
      {
        requestId: moved.requestId,
        actionType: 'task.workflow.move',
        outcome: 'accepted',
        entityIds: [CARD],
      },
    ]);
    // One event, and it follows the re-read: the gesture converges first, so the event reports a state a
    // reader can go and look at. The wrapper's own render comes after the sequence returns, which is why it
    // is last rather than between the two.
    expect(w.order).toEqual(['refresh', 'audit:accepted', 'render']);
  });

  it('names an in-stage drop as task.workflow.reorder rather than calling it a move', async () => {
    const w = await world();

    const reordered = await w.drop({ targetStageId: DESIGN, targetIndex: 0 });

    expect(reordered).toMatchObject({ ok: true, actionType: 'task.workflow.reorder', workflowAction: 'reorder' });
    if (!reordered.ok) throw new Error('the drop was refused');
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: reordered.requestId,
      actionType: 'task.workflow.reorder',
      outcome: 'accepted',
    });
  });

  it('names a drop out of the workflow as a move, because the stage changed rather than vanished', async () => {
    const w = await world();

    // The board reports a slot index for every column including the trailing one; the wrapper is what drops
    // it for a leave, because leaving the workflow has no position in it.
    const left = await w.drop({ targetStageId: null, targetIndex: 0 });

    expect(left).toMatchObject({ ok: true, actionType: 'task.workflow.move', workflowAction: 'leave' });
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]!.actionType).toBe('task.workflow.move');
  });

  it('journals a validation refusal before the record layer is asked', async () => {
    const w = await world();

    const refused = await w.gesture({
      taskId: CARD,
      from: DESIGN,
      to: null,
      targetIndex: 3,
      expectedRevision: REVISION,
    });

    expect(refused).toMatchObject({ ok: false, reason: 'validation-refused', actionType: 'task.workflow.move' });
    if (refused.ok) throw new Error('the gesture was accepted');
    expect(w.writes()).toBe(0);
    expect(w.audit.events).toEqual([
      {
        requestId: refused.requestId,
        actionType: 'task.workflow.move',
        outcome: 'rejected',
        entityIds: [CARD],
        errorCode: 'validation-refused',
      },
    ]);
  });

  it('journals a lost race as rejected, after the re-read rather than before it', async () => {
    const w = await world({ answer: 'stale' });

    const lost = await w.drop();

    // The re-read was attempted and declined by this harness's session stub, which is what the flag reports;
    // the ordering is the part the envelope owns, and it says the event came after the attempt.
    expect(lost).toMatchObject({ ok: false, reason: 'stale-revision', refreshed: false });
    if (lost.ok) throw new Error('the drop was accepted');
    expect(w.order).toEqual(['refresh', 'audit:rejected', 'render']);
    expect(w.audit.events).toEqual([
      {
        requestId: lost.requestId,
        actionType: 'task.workflow.move',
        outcome: 'rejected',
        entityIds: [CARD],
        errorCode: 'stale-revision',
      },
    ]);
  });

  it("journals the wrapper's own refusals with the same envelope, and hands its id down", async () => {
    const unknown = await world({ card: null });
    const noCard = await unknown.drop();
    expect(noCard).toMatchObject({ ok: false, reason: 'unknown-task', actionType: 'task.workflow.move' });
    if (noCard.ok) throw new Error('the drop was accepted');
    expect(unknown.writes()).toBe(0);
    // A card the board is not showing has no id to name, and the event says so rather than guessing one.
    expect(unknown.audit.events).toEqual([
      {
        requestId: noCard.requestId,
        actionType: 'task.workflow.move',
        outcome: 'rejected',
        entityIds: [],
        errorCode: 'unknown-task',
      },
    ]);

    const unavailable = await world({ writesAvailable: false });
    const noPath = await unavailable.drop();
    expect(noPath).toMatchObject({ ok: false, reason: 'writes-unavailable' });
    if (noPath.ok) throw new Error('the drop was accepted');
    expect(unavailable.audit.events).toEqual([
      {
        requestId: noPath.requestId,
        actionType: 'task.workflow.move',
        outcome: 'rejected',
        entityIds: [CARD],
        errorCode: 'writes-unavailable',
      },
    ]);

    // And on an accepted drop the id the wrapper minted is the id the gesture's event carries: one drop,
    // one id, one event - which is what handing the id down is for. The count is the assertion that carries
    // it: the gesture minting its own id instead would leave the same single event carrying a *different*
    // id, and everything above would still pass.
    const accepted = await world();
    const moved = await accepted.drop();
    if (!moved.ok) throw new Error('the drop was refused');
    expect(accepted.minted()).toBe(1);
    expect(accepted.audit.events).toHaveLength(1);
    expect(accepted.audit.events[0]!.requestId).toBe(moved.requestId);
    expect(accepted.audit.events[0]!.requestId).toMatch(/-1$/);
  });
});
