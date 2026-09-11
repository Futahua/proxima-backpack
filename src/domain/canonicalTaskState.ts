import type {
  CanonicalRecordHeader,
  OpaqueRecordId,
} from './canonicalIdentity.js';

/**
 * Global execution state is deliberately small and independent of project workflow.
 * A project may call a workflow stage Review, Done, Waiting or anything else without
 * changing what the task means to Elastic execution.
 */
export type CanonicalExecutionState =
  | 'backlog'
  | 'running'
  | 'finished';

/**
 * Future canonical workflow-stage record.
 *
 * Its display name is data. Tasks refer to the opaque stage id, never to that text.
 */
export interface CanonicalWorkflowStageStateRecord
  extends CanonicalRecordHeader<'workflow-stage'> {
  readonly projectId: OpaqueRecordId;
}

/**
 * Future canonical task state for HARD GATE A / A2.
 *
 * executionState answers the global Elastic question.
 * workflowStageId independently answers the project-workflow question.
 *
 * Neither field derives the other.
 */
export interface CanonicalTaskStateRecord
  extends CanonicalRecordHeader<'task'> {
  readonly projectId: OpaqueRecordId | null;
  readonly executionState: CanonicalExecutionState;
  readonly workflowStageId: OpaqueRecordId | null;
}

export interface CanonicalExecutionSurfaceEntry {
  readonly taskId: OpaqueRecordId;
  readonly executionState: CanonicalExecutionState;
}

export interface CanonicalWorkflowSurfaceEntry {
  readonly taskId: OpaqueRecordId;
  readonly workflowStageId: OpaqueRecordId;
  readonly workflowStageName: string;
}

/**
 * Read-only Elastic projection. Workflow identity is intentionally irrelevant here.
 */
export function projectCanonicalExecutionSurface(
  task: CanonicalTaskStateRecord,
): CanonicalExecutionSurfaceEntry {
  return {
    taskId: task.id,
    executionState: task.executionState,
  };
}

/**
 * Read-only project-workflow projection.
 *
 * Resolution is by stable opaque stage id. Display text is returned only after identity
 * resolution and therefore may change without changing the task's workflow identity.
 */
export function projectCanonicalWorkflowSurface(
  task: CanonicalTaskStateRecord,
  stages: readonly CanonicalWorkflowStageStateRecord[],
): CanonicalWorkflowSurfaceEntry | null {
  if (task.workflowStageId === null) {
    return null;
  }

  const stage = stages.find((candidate) => candidate.id === task.workflowStageId);
  if (!stage) {
    throw new Error(`Unknown canonical workflow stage: ${task.workflowStageId}`);
  }

  if (task.projectId === null || stage.projectId !== task.projectId) {
    throw new Error(
      `Canonical workflow stage ${stage.id} does not belong to task project.`,
    );
  }

  return {
    taskId: task.id,
    workflowStageId: stage.id,
    workflowStageName: stage.name,
  };
}
