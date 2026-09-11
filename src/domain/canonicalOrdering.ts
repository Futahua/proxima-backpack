import type {
  CanonicalRecordHeader,
  OpaqueRecordId,
} from './canonicalIdentity.js';
import type {
  CanonicalExecutionState,
  CanonicalTaskStateRecord,
} from './canonicalTaskState.js';

declare const canonicalOrderPositionBrand: unique symbol;

/**
 * Position inside one explicit durable ordering scope.
 *
 * The number has no meaning outside the scope that owns it.
 */
export type CanonicalOrderPosition = number & {
  readonly [canonicalOrderPositionBrand]: 'CanonicalOrderPosition';
};

export function canonicalOrderPosition(value: number): CanonicalOrderPosition {
  if (
    !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error('Canonical order position needs a non-negative safe integer.');
  }

  return value as CanonicalOrderPosition;
}

/**
 * Future canonical task ordering.
 *
 * executionOrder is scoped by executionState.
 * workflowOrder is scoped by projectId + workflowStageId.
 *
 * There is deliberately no universal orderIndex.
 */
export interface CanonicalOrderedTaskRecord
  extends CanonicalTaskStateRecord {
  readonly executionOrder: CanonicalOrderPosition;
  readonly workflowOrder: CanonicalOrderPosition | null;
}

/**
 * The durable user-authored order scopes currently admitted by the canonical model.
 *
 * Calendar chronology is derived from time and Gantt row placement is disposable local
 * state, so neither belongs in this union.
 */
export type CanonicalDurableOrderScope =
  | {
      readonly kind: 'elastic-execution';
      readonly executionState: CanonicalExecutionState;
    }
  | {
      readonly kind: 'project-workflow-stage';
      readonly projectId: OpaqueRecordId;
      readonly workflowStageId: OpaqueRecordId;
    };

function byTaskId(
  left: CanonicalOrderedTaskRecord,
  right: CanonicalOrderedTaskRecord,
): number {
  return left.id.localeCompare(right.id);
}

/**
 * One global Elastic queue per execution state.
 *
 * workflowOrder is not consulted.
 */
export function orderCanonicalExecutionQueue(
  tasks: readonly CanonicalOrderedTaskRecord[],
  executionState: CanonicalExecutionState,
): CanonicalOrderedTaskRecord[] {
  return tasks
    .filter((task) => task.executionState === executionState)
    .slice()
    .sort(
      (left, right) =>
        left.executionOrder - right.executionOrder
        || byTaskId(left, right),
    );
}

/**
 * One workflow ordering scope per exact project + stage pair.
 *
 * executionOrder is not consulted.
 */
export function orderCanonicalWorkflowStage(
  tasks: readonly CanonicalOrderedTaskRecord[],
  projectId: OpaqueRecordId,
  workflowStageId: OpaqueRecordId,
): CanonicalOrderedTaskRecord[] {
  const scoped = tasks.filter(
    (task) =>
      task.projectId === projectId
      && task.workflowStageId === workflowStageId,
  );

  for (const task of scoped) {
    if (task.workflowOrder === null) {
      throw new Error(
        `Canonical workflow task has no workflow order: ${task.id}`,
      );
    }
  }

  return scoped
    .slice()
    .sort(
      (left, right) =>
        (left.workflowOrder as CanonicalOrderPosition)
        - (right.workflowOrder as CanonicalOrderPosition)
        || byTaskId(left, right),
    );
}

/**
 * Calendar order is chronology, not a third manual task-order field.
 */
export interface CanonicalChronologicalEventRecord
  extends CanonicalRecordHeader<'event'> {
  readonly startDate: string;
  readonly deadline: string;
}

function dateMilliseconds(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid canonical calendar ${field}: ${value}`);
  }
  return milliseconds;
}

export function orderCanonicalCalendarChronology(
  events: readonly CanonicalChronologicalEventRecord[],
): CanonicalChronologicalEventRecord[] {
  return events
    .slice()
    .sort((left, right) => {
      const startDifference =
        dateMilliseconds(left.startDate, 'startDate')
        - dateMilliseconds(right.startDate, 'startDate');
      if (startDifference !== 0) {
        return startDifference;
      }

      const deadlineDifference =
        dateMilliseconds(left.deadline, 'deadline')
        - dateMilliseconds(right.deadline, 'deadline');
      if (deadlineDifference !== 0) {
        return deadlineDifference;
      }

      return left.id.localeCompare(right.id);
    });
}

/**
 * HARD GATE A / A3 decision: Gantt row placement is disposable LOCAL STATE.
 *
 * This pure helper changes only the supplied local row list. It does not change any
 * canonical task field. The already-public task.timeline.change action continues to
 * carry targetRowIndex for programmatic parity while its eventual record changes remain
 * unavailable before record-store cutover.
 */
export const GANTT_ROW_PLACEMENT_CATEGORY = 'local-state' as const;

export function placeCanonicalGanttRow(
  currentRows: readonly OpaqueRecordId[],
  taskId: OpaqueRecordId,
  targetRowIndex: number,
): OpaqueRecordId[] {
  if (
    !Number.isInteger(targetRowIndex)
    || targetRowIndex < 0
    || targetRowIndex >= currentRows.length
  ) {
    throw new Error('Gantt target row index is outside the local row layout.');
  }

  const sourceIndex = currentRows.indexOf(taskId);
  if (sourceIndex < 0) {
    throw new Error(`Gantt local row layout does not contain task: ${taskId}`);
  }

  const next = [...currentRows];
  next.splice(sourceIndex, 1);
  next.splice(targetRowIndex, 0, taskId);
  return next;
}
