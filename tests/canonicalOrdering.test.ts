import { describe, expect, it } from 'vitest';
import { parseAction } from '../src/app/actionProtocol.js';
import {
  defineCanonicalRecordHeader,
  opaqueRecordIdFromRandomBytes,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  GANTT_ROW_PLACEMENT_CATEGORY,
  canonicalOrderPosition,
  orderCanonicalCalendarChronology,
  orderCanonicalExecutionQueue,
  orderCanonicalWorkflowStage,
  placeCanonicalGanttRow,
  type CanonicalChronologicalEventRecord,
  type CanonicalDurableOrderScope,
  type CanonicalOrderedTaskRecord,
} from '../src/domain/canonicalOrdering.js';

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT_A = idFromLastByte(1);
const PROJECT_B = idFromLastByte(2);
const REVIEW_A = idFromLastByte(3);
const DONE_A = idFromLastByte(4);
const REVIEW_B = idFromLastByte(5);
const TASK_A = idFromLastByte(10);
const TASK_B = idFromLastByte(11);
const TASK_C = idFromLastByte(12);

function task(input: {
  id: OpaqueRecordId;
  projectId?: OpaqueRecordId | null;
  workflowStageId?: OpaqueRecordId | null;
  executionOrder: number;
  workflowOrder: number | null;
}): CanonicalOrderedTaskRecord {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'task',
      id: input.id,
      name: 'Same display name is allowed',
    }),
    projectId: input.projectId ?? PROJECT_A,
    executionState: 'running',
    workflowStageId: input.workflowStageId ?? REVIEW_A,
    executionOrder: canonicalOrderPosition(input.executionOrder),
    workflowOrder:
      input.workflowOrder === null
        ? null
        : canonicalOrderPosition(input.workflowOrder),
  };
}

function event(
  id: OpaqueRecordId,
  startDate: string,
  deadline: string,
): CanonicalChronologicalEventRecord {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'event',
      id,
      name: 'Calendar event',
    }),
    startDate,
    deadline,
  };
}

describe('HARD GATE A / A3 scoped ordering', () => {
  it('keeps Elastic execution order independent from workflow order', () => {
    const first = task({
      id: TASK_A,
      executionOrder: 1,
      workflowOrder: 20,
    });
    const second = task({
      id: TASK_B,
      executionOrder: 2,
      workflowOrder: 10,
    });

    expect(
      orderCanonicalExecutionQueue([first, second], 'running')
        .map((record) => record.id),
    ).toEqual([TASK_A, TASK_B]);

    expect(
      orderCanonicalWorkflowStage(
        [first, second],
        PROJECT_A,
        REVIEW_A,
      ).map((record) => record.id),
    ).toEqual([TASK_B, TASK_A]);
  });

  it('reordering Elastic cannot silently reorder the project workflow board', () => {
    const first = task({
      id: TASK_A,
      executionOrder: 1,
      workflowOrder: 1,
    });
    const second = task({
      id: TASK_B,
      executionOrder: 2,
      workflowOrder: 2,
    });
    const elasticReordered: CanonicalOrderedTaskRecord[] = [
      {
        ...first,
        executionOrder: canonicalOrderPosition(2),
      },
      {
        ...second,
        executionOrder: canonicalOrderPosition(1),
      },
    ];

    expect(
      orderCanonicalExecutionQueue(elasticReordered, 'running')
        .map((record) => record.id),
    ).toEqual([TASK_B, TASK_A]);

    expect(
      orderCanonicalWorkflowStage(
        elasticReordered,
        PROJECT_A,
        REVIEW_A,
      ).map((record) => record.id),
    ).toEqual([TASK_A, TASK_B]);
  });

  it('reordering one project workflow stage cannot silently alter Elastic order', () => {
    const first = task({
      id: TASK_A,
      executionOrder: 1,
      workflowOrder: 1,
    });
    const second = task({
      id: TASK_B,
      executionOrder: 2,
      workflowOrder: 2,
    });
    const workflowReordered: CanonicalOrderedTaskRecord[] = [
      {
        ...first,
        workflowOrder: canonicalOrderPosition(2),
      },
      {
        ...second,
        workflowOrder: canonicalOrderPosition(1),
      },
    ];

    expect(
      orderCanonicalWorkflowStage(
        workflowReordered,
        PROJECT_A,
        REVIEW_A,
      ).map((record) => record.id),
    ).toEqual([TASK_B, TASK_A]);

    expect(
      orderCanonicalExecutionQueue(workflowReordered, 'running')
        .map((record) => record.id),
    ).toEqual([TASK_A, TASK_B]);
  });

  it('scopes workflow ordering by the exact project and stage ids', () => {
    const projectAReview = task({
      id: TASK_A,
      projectId: PROJECT_A,
      workflowStageId: REVIEW_A,
      executionOrder: 1,
      workflowOrder: 2,
    });
    const projectADone = task({
      id: TASK_B,
      projectId: PROJECT_A,
      workflowStageId: DONE_A,
      executionOrder: 2,
      workflowOrder: 1,
    });
    const projectBReview = task({
      id: TASK_C,
      projectId: PROJECT_B,
      workflowStageId: REVIEW_B,
      executionOrder: 3,
      workflowOrder: 1,
    });

    expect(
      orderCanonicalWorkflowStage(
        [projectAReview, projectADone, projectBReview],
        PROJECT_A,
        REVIEW_A,
      ).map((record) => record.id),
    ).toEqual([TASK_A]);

    expect(
      orderCanonicalWorkflowStage(
        [projectAReview, projectADone, projectBReview],
        PROJECT_A,
        DONE_A,
      ).map((record) => record.id),
    ).toEqual([TASK_B]);

    expect(
      orderCanonicalWorkflowStage(
        [projectAReview, projectADone, projectBReview],
        PROJECT_B,
        REVIEW_B,
      ).map((record) => record.id),
    ).toEqual([TASK_C]);
  });

  it('admits only the two current durable user-authored ordering scopes', () => {
    const scopes: readonly CanonicalDurableOrderScope[] = [
      {
        kind: 'elastic-execution',
        executionState: 'running',
      },
      {
        kind: 'project-workflow-stage',
        projectId: PROJECT_A,
        workflowStageId: REVIEW_A,
      },
    ];

    expect(scopes.map((scope) => scope.kind)).toEqual([
      'elastic-execution',
      'project-workflow-stage',
    ]);
  });

  it('orders calendar records by chronology rather than a manual rank', () => {
    const early = event(
      idFromLastByte(20),
      '2026-09-11T08:00:00.000Z',
      '2026-09-11T09:00:00.000Z',
    );
    const later = event(
      idFromLastByte(21),
      '2026-09-11T10:00:00.000Z',
      '2026-09-11T11:00:00.000Z',
    );
    const sameStartLonger = event(
      idFromLastByte(22),
      '2026-09-11T08:00:00.000Z',
      '2026-09-11T10:00:00.000Z',
    );

    expect(
      orderCanonicalCalendarChronology([
        later,
        sameStartLonger,
        early,
      ]).map((record) => record.id),
    ).toEqual([
      early.id,
      sameStartLonger.id,
      later.id,
    ]);

    expect(early).not.toHaveProperty('orderIndex');
    expect(early).not.toHaveProperty('executionOrder');
    expect(early).not.toHaveProperty('workflowOrder');
  });

  it('keeps Gantt row placement local while retaining the typed programmatic row target', () => {
    const first = task({
      id: TASK_A,
      executionOrder: 1,
      workflowOrder: 1,
    });
    const second = task({
      id: TASK_B,
      executionOrder: 2,
      workflowOrder: 2,
    });
    const before = [first, second];

    expect(GANTT_ROW_PLACEMENT_CATEGORY).toBe('local-state');
    expect(
      placeCanonicalGanttRow(
        before.map((record) => record.id),
        TASK_B,
        0,
      ),
    ).toEqual([TASK_B, TASK_A]);

    expect(before[0]!.executionOrder).toBe(
      canonicalOrderPosition(1),
    );
    expect(before[0]!.workflowOrder).toBe(
      canonicalOrderPosition(1),
    );
    expect(before[1]!.executionOrder).toBe(
      canonicalOrderPosition(2),
    );
    expect(before[1]!.workflowOrder).toBe(
      canonicalOrderPosition(2),
    );

    expect(parseAction({
      type: 'task.timeline.change',
      taskId: TASK_B,
      operation: 'move',
      proposedStartDate: '2026-09-12T08:00:00.000Z',
      proposedDeadline: '2026-09-12T09:00:00.000Z',
      targetRowIndex: 0,
    })).toEqual({
      ok: true,
      action: {
        type: 'task.timeline.change',
        taskId: TASK_B,
        operation: 'move',
        proposedStartDate: '2026-09-12T08:00:00.000Z',
        proposedDeadline: '2026-09-12T09:00:00.000Z',
        targetRowIndex: 0,
      },
    });
  });
});
