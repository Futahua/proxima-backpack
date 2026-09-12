/**
 * The semantic envelope on the workflow-stage writes, including the case this family exists to answer.
 *
 * A stage write is the first one whose write is a *sequence of sequences*: deleting a stage moves its cards
 * through the task operation rather than by a rule of its own, and the record layer reports those card ids in
 * `remappedTaskIds`. So the run's event carries the stage **and every card that moved** - and a run where cards
 * moved and the stage write then refused is `partial` rather than either an acceptance or a rejection, because
 * the surface holds records it did not have before.
 *
 * The operations here are injected stubs around a real stage in the state, which is the seam the sequence
 * declares: what this file is about is the envelope the sequence owes, and the record layer's own behaviour is
 * covered by `tests/workflowStageMutations.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import {
  createWorkflowStageAction,
  deleteWorkflowStageAction,
  renameWorkflowStageAction,
  type WorkflowStageWriteDependencies,
  type WorkflowStageWriteOperations,
} from '../src/app/workflowStageWriteActions.js';
import {
  WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
  type WorkflowStageMutationResult,
} from '../src/app/workflowStageMutations.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { EMPTY_STATE, type ProximaState } from '../src/domain/types.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const STAGE = 'stage-backlog';
const STAGE_REVISION = 'stage-backlog@1';
const PROJECT = 'project-backpack';

function card(serial: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const MOVED = [card(1), card(2)] as const;

interface WorldOptions {
  readonly writesAvailable?: boolean;
  readonly answer?: 'ok' | 'refusing-stage' | 'refusing-after-moving' | 'stale';
}

function world(options: WorldOptions = {}) {
  const state: ProximaState = {
    ...EMPTY_STATE,
    workflowStages: [{ id: STAGE, projectId: PROJECT, name: 'Backlog', revision: STAGE_REVISION }],
  };

  const audit = recordingAudit();
  const order: string[] = [];
  /** The revisions the operations were handed, so "wrote against what it read" is asserted rather than assumed. */
  const revisions: string[] = [];
  let calls = 0;

  const succeeded = (outcome: 'created' | 'renamed' | 'deleted', recordId: string): WorkflowStageMutationResult => ({
    ok: true,
    schemaVersion: WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
    outcome,
    recordId: recordId as OpaqueRecordId,
    revision: `${recordId}@2`,
    record: null,
    remappedTaskIds: outcome === 'deleted' ? [...MOVED] : [],
  });

  const answer = options.answer ?? 'ok';
  const operations: WorkflowStageWriteOperations = {
    async createWorkflowStage() {
      calls += 1;
      return succeeded('created', 'stage-created');
    },
    async renameWorkflowStage(input) {
      calls += 1;
      revisions.push(input.expectedRevision);
      return answer === 'refusing-stage'
        ? refused('validation-refused')
        : succeeded('renamed', STAGE);
    },
    async deleteWorkflowStage(input) {
      calls += 1;
      revisions.push(input.expectedRevision);
      if (answer === 'refusing-after-moving') return refused('semantic-conflict', [...MOVED]);
      if (answer === 'refusing-stage') return refused('validation-refused');
      return succeeded('deleted', STAGE);
    },
  };

  function refused(reason: 'validation-refused' | 'semantic-conflict' | 'stale-revision', remappedTaskIds?: readonly OpaqueRecordId[]): WorkflowStageMutationResult {
    return {
      ok: false,
      schemaVersion: WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
      reason,
      detail: reason === 'semantic-conflict' ? 'the cards moved but the stage write was refused' : `refused: ${reason}`,
      ...(remappedTaskIds === undefined ? {} : { remappedTaskIds }),
    };
  }

  const deps: WorkflowStageWriteDependencies = {
    state,
    writes: async () => (options.writesAvailable === false ? null : operations),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      return null;
    },
    setRefusal: () => {},
    setFeedback: () => {},
    render: () => { order.push('render'); },
    ids: semanticIds(),
    audit: {
      append: (event) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  return { deps, audit, order, revisions, calls: () => calls, stale: () => refused('stale-revision') };
}

describe('the semantic envelope on the workflow-stage writes', () => {
  it('mints an id on a create and journals it as workflow.stage.create', async () => {
    const w = world();
    const outcome = await createWorkflowStageAction(w.deps, { projectId: PROJECT, name: 'Review' });

    expect(outcome.ok).toBe(true);
    expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'workflow.stage.create',
      outcome: 'accepted',
      entityIds: [outcome.ok ? outcome.recordId : ''],
    });
    expect(w.order).toEqual(['refresh', 'render', 'audit:accepted']);
  });

  it('names the rename, and its target', async () => {
    const w = world();
    const outcome = await renameWorkflowStageAction(w.deps, { stageId: STAGE, name: 'In progress' });

    expect(outcome.ok).toBe(true);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'workflow.stage.rename',
      outcome: 'accepted',
      entityIds: [STAGE],
    });
    // The operation was handed the revision the board was showing, not an empty one: the whole point of this
    // family's revision rule is that a stale board is refused rather than overwriting, and a sequence that
    // passed nothing would be refused by the store for the wrong reason on every write.
    expect(w.revisions).toEqual([STAGE_REVISION]);
  });

  it('carries the stage and every card a delete moved, because the run is about both', async () => {
    const w = world();
    const outcome = await deleteWorkflowStageAction(w.deps, { stageId: STAGE });

    expect(outcome.ok).toBe(true);
    expect(outcome.remappedTaskIds).toEqual([...MOVED]);
    // The whole point of this family's envelope: a reader can see which cards the run moved, not only that a
    // stage was deleted.
    expect(w.audit.events[0]).toMatchObject({
      actionType: 'workflow.stage.delete',
      outcome: 'accepted',
      entityIds: [STAGE, ...MOVED],
    });
  });

  it('journals a run that moved cards and then refused as partial, not as either end', async () => {
    const w = world({ answer: 'refusing-after-moving' });
    const outcome = await deleteWorkflowStageAction(w.deps, { stageId: STAGE });

    expect(outcome.ok).toBe(false);
    expect(outcome.remappedTaskIds).toEqual([...MOVED]);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'workflow.stage.delete',
      outcome: 'partial',
      entityIds: [STAGE, ...MOVED],
      errorCode: 'semantic-conflict',
    });
    // Cards landed, so the surfaces converged before the journal entry.
    expect(w.order).toEqual(['refresh', 'render', 'audit:partial']);
  });

  it('journals a refusal that moved nothing as a rejection', async () => {
    const w = world({ answer: 'refusing-stage' });
    const outcome = await renameWorkflowStageAction(w.deps, { stageId: STAGE, name: 'In progress' });

    expect(outcome.ok).toBe(false);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'workflow.stage.rename',
      outcome: 'rejected',
      entityIds: [STAGE],
      errorCode: 'validation-refused',
    });
    // The write path was resolved and the operation was reached, but nothing changed, so nothing converged.
    expect(w.order).toEqual(['render', 'audit:rejected']);
  });

  it('refuses a stage the board does not hold, with the envelope rather than without it', async () => {
    const w = world();
    const outcome = await renameWorkflowStageAction(w.deps, { stageId: 'stage-missing', name: 'Nope' });

    expect(outcome).toMatchObject({ ok: false, reason: 'unknown-stage' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'workflow.stage.rename',
      outcome: 'rejected',
      entityIds: ['stage-missing'],
      errorCode: 'unknown-stage',
    });
    expect(w.calls()).toBe(0);
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('correlates a create with no write path, naming no target because none exists yet', async () => {
    const w = world({ writesAvailable: false });
    const outcome = await createWorkflowStageAction(w.deps, { projectId: PROJECT, name: 'Review' });

    expect(outcome).toMatchObject({ ok: false, reason: 'writes-unavailable' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'workflow.stage.create',
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'writes-unavailable',
    });
  });
});
