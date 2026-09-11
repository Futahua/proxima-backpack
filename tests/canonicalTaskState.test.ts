import { describe, expect, it } from 'vitest';
import {
  defineCanonicalRecordHeader,
  opaqueRecordIdFromRandomBytes,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  projectCanonicalExecutionSurface,
  projectCanonicalWorkflowSurface,
  type CanonicalExecutionState,
  type CanonicalTaskStateRecord,
  type CanonicalWorkflowStageStateRecord,
} from '../src/domain/canonicalTaskState.js';

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT_ID = idFromLastByte(1);
const TASK_ID = idFromLastByte(2);
const REVIEW_ID = idFromLastByte(3);
const DONE_ID = idFromLastByte(4);

function stage(
  id: OpaqueRecordId,
  name: string,
): CanonicalWorkflowStageStateRecord {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'workflow-stage',
      id,
      name,
    }),
    projectId: PROJECT_ID,
  };
}

function task(
  overrides: Partial<CanonicalTaskStateRecord> = {},
): CanonicalTaskStateRecord {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'task',
      id: TASK_ID,
      name: 'Ship the Backpack',
    }),
    projectId: PROJECT_ID,
    executionState: 'running',
    workflowStageId: REVIEW_ID,
    ...overrides,
  };
}

describe('HARD GATE A / A2 execution and workflow separation', () => {
  it('represents Backlog, Running and Finished as explicit global execution states', () => {
    const states: readonly CanonicalExecutionState[] = [
      'backlog',
      'running',
      'finished',
    ];

    expect(
      states.map((executionState) =>
        projectCanonicalExecutionSurface(task({ executionState })),
      ),
    ).toEqual([
      { taskId: TASK_ID, executionState: 'backlog' },
      { taskId: TASK_ID, executionState: 'running' },
      { taskId: TASK_ID, executionState: 'finished' },
    ]);
  });

  it('projects one task as globally Running while independently in workflow Review', () => {
    const review = stage(REVIEW_ID, 'Review');
    const record = task({
      executionState: 'running',
      workflowStageId: review.id,
    });

    expect(projectCanonicalExecutionSurface(record)).toEqual({
      taskId: TASK_ID,
      executionState: 'running',
    });
    expect(projectCanonicalWorkflowSurface(record, [review])).toEqual({
      taskId: TASK_ID,
      workflowStageId: REVIEW_ID,
      workflowStageName: 'Review',
    });
  });

  it('moving global execution to Running does not erase the workflow-stage identity', () => {
    const review = stage(REVIEW_ID, 'Review');
    const backlogTask = task({
      executionState: 'backlog',
      workflowStageId: review.id,
    });
    const runningTask: CanonicalTaskStateRecord = {
      ...backlogTask,
      executionState: 'running',
    };

    expect(runningTask.workflowStageId).toBe(REVIEW_ID);
    expect(projectCanonicalExecutionSurface(runningTask).executionState).toBe(
      'running',
    );
    expect(projectCanonicalWorkflowSurface(runningTask, [review])).toEqual({
      taskId: TASK_ID,
      workflowStageId: REVIEW_ID,
      workflowStageName: 'Review',
    });
  });

  it('moving Review to a Done-like workflow stage does not change global execution', () => {
    const review = stage(REVIEW_ID, 'Review');
    const done = stage(DONE_ID, 'Done');
    const reviewTask = task({
      executionState: 'running',
      workflowStageId: review.id,
    });
    const doneTask: CanonicalTaskStateRecord = {
      ...reviewTask,
      workflowStageId: done.id,
    };

    expect(doneTask.executionState).toBe('running');
    expect(projectCanonicalExecutionSurface(doneTask)).toEqual({
      taskId: TASK_ID,
      executionState: 'running',
    });
    expect(projectCanonicalWorkflowSurface(doneTask, [review, done])).toEqual({
      taskId: TASK_ID,
      workflowStageId: DONE_ID,
      workflowStageName: 'Done',
    });
  });

  it('resolves workflow membership by stable stage id rather than display text', () => {
    const review = stage(REVIEW_ID, 'Review');
    const renamedReview: CanonicalWorkflowStageStateRecord = {
      ...review,
      name: 'Needs approval',
    };
    const record = task({ workflowStageId: review.id });

    expect(record.workflowStageId).toBe(REVIEW_ID);
    expect(projectCanonicalWorkflowSurface(record, [renamedReview])).toEqual({
      taskId: TASK_ID,
      workflowStageId: REVIEW_ID,
      workflowStageName: 'Needs approval',
    });
  });
});
