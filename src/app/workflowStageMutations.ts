/**
 * Stage 17's workflow-stage editing: `workflow-stage.create`, `.rename` and `.delete` as
 * semantic operations, in the shape `taskMutations` set.
 *
 * A workflow stage is a record like any other — `{ kind: 'workflow-stage', id, name, projectId }` —
 * and until this module existed the store could hold them while nothing could write one. The
 * projection has read them since HARD GATE A2, so a stage could be imported and drawn but never
 * created, renamed or removed in the tree itself.
 *
 * Three rules, the same three the task operations keep.
 *
 * **The request is closed and typed.** A stage is created by naming its project and its name, and
 * renamed by naming the stage and the new name. No partial record is accepted, and no caller
 * supplies an id for a create.
 *
 * **Nothing is written until everything is valid.** Every refusal below happens before the first
 * byte moves, so a refused request leaves every revision where it was.
 *
 * **A delete says what happens to the cards.** This is the one place a stage operation has to
 * answer a question about other records: a stage that still holds tasks cannot simply vanish,
 * because its tasks would name a stage the store no longer has — the gap the projection reports as
 * `task-workflow-stage-missing`. The caller therefore has to say where the members go, and the
 * operation refuses, naming how many are affected, when it has not been told. Moving them is
 * `updateTask`'s own `workflow-stage` mutation rather than a second implementation of the same
 * rule, so the canonical pair rule (a stage and its position travel together) cannot be broken by
 * a delete path that forgot it. The members move before the stage record goes, so a refusal
 * part-way leaves a stage that still exists, and the failure names the tasks that already moved.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import { defineCanonicalRecordHeader } from '../domain/canonicalIdentity.js';
import { canonicalOrderPosition } from '../domain/canonicalOrdering.js';
import type { CanonicalRecordV2 } from '../domain/canonicalRecordV2.js';
import type { CanonicalWorkflowStageStateRecord } from '../domain/canonicalTaskState.js';
import type { RecordStore, RecordStoreFileName } from '../ports/recordStore.js';
import { encodeRecordDocument, recordFileNameFor } from './jsonRecordStore.js';
import { canonicalRecordV2Codec } from './canonicalRecordCodec.js';
import type { RecordMutationCoordinator } from './recordMutation.js';
import { updateTask, type TaskMutationDependencies, type TaskMutationFailureReason } from './taskMutations.js';

export const WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION = 1 as const;

const MAX_NAME_LENGTH = 200;

export type WorkflowStageMutationFailureReason = TaskMutationFailureReason;

export interface WorkflowStageMutationSuccess {
  readonly ok: true;
  readonly schemaVersion: typeof WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION;
  readonly outcome: 'created' | 'renamed' | 'deleted';
  readonly recordId: OpaqueRecordId;
  readonly revision: string;
  /** The stage as written; `null` for a delete. */
  readonly record: CanonicalWorkflowStageStateRecord | null;
  /** The tasks a delete moved, in the order it moved them. Empty for every other outcome. */
  readonly remappedTaskIds: readonly OpaqueRecordId[];
}

export interface WorkflowStageMutationFailure {
  readonly ok: false;
  readonly schemaVersion: typeof WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION;
  readonly reason: WorkflowStageMutationFailureReason;
  /** One bounded sentence, safe to show: never a path, a secret or a stack. */
  readonly detail: string;
  /** Present for a stale refusal, so the caller can refetch rather than guess. */
  readonly actualRevision?: string;
  /** The tasks that had already moved when a remap stopped part-way. */
  readonly remappedTaskIds?: readonly OpaqueRecordId[];
}

export type WorkflowStageMutationResult =
  | WorkflowStageMutationSuccess
  | WorkflowStageMutationFailure;

export interface WorkflowStageMutationDependencies {
  readonly store: RecordStore<CanonicalRecordV2>;
  readonly coordinator: RecordMutationCoordinator;
  readonly allocateRecordId: () => OpaqueRecordId;
  /** The task operations, so a remap moves cards by the rule that owns the stage-and-order pair. */
  readonly taskDependencies: TaskMutationDependencies;
}

export interface CreateWorkflowStageRequest {
  readonly projectId: OpaqueRecordId;
  readonly name: string;
}

/** Where a deleted stage's tasks go: another stage of the same project, or out of the workflow. */
export type WorkflowStageRemapTarget =
  | { readonly kind: 'stage'; readonly stageId: OpaqueRecordId }
  | { readonly kind: 'no-stage' };

function refused(detail: string): WorkflowStageMutationFailure {
  return {
    ok: false,
    schemaVersion: WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
    reason: 'validation-refused',
    detail,
  };
}

function failed(
  reason: WorkflowStageMutationFailureReason,
  detail: string,
  actualRevision?: string,
  remappedTaskIds?: readonly OpaqueRecordId[],
): WorkflowStageMutationFailure {
  return {
    ok: false,
    schemaVersion: WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
    reason,
    detail,
    ...(actualRevision === undefined ? {} : { actualRevision }),
    ...(remappedTaskIds === undefined ? {} : { remappedTaskIds }),
  };
}

function stageNameFailure(value: unknown): WorkflowStageMutationFailure | null {
  if (typeof value !== 'string') return refused('a workflow stage needs a name');
  const name = value.trim();
  if (name.length === 0) return refused('a workflow stage needs a name');
  if (name.length > MAX_NAME_LENGTH) {
    return refused(`a workflow stage name may be at most ${MAX_NAME_LENGTH} characters`);
  }
  return null;
}

function stageName(value: string): string {
  return value.trim();
}

async function readOfKind(
  deps: WorkflowStageMutationDependencies,
  id: OpaqueRecordId,
  kind: 'workflow-stage' | 'project',
): Promise<
  | { ok: true; record: CanonicalRecordV2; revision: string }
  | { ok: false; failure: WorkflowStageMutationFailure }
> {
  let observation;
  try {
    observation = await deps.store.read(id);
  } catch {
    return { ok: false, failure: failed('storage-failure', 'the record store could not be read') };
  }
  if (observation === undefined || observation.kind !== kind) {
    return { ok: false, failure: failed('not-found', `no ${kind} record ${id}`) };
  }
  return {
    ok: true,
    record: observation.record as CanonicalRecordV2,
    revision: observation.observedRevision,
  };
}

export async function createWorkflowStage(
  deps: WorkflowStageMutationDependencies,
  request: CreateWorkflowStageRequest,
): Promise<WorkflowStageMutationResult> {
  const naming = stageNameFailure(request.name);
  if (naming !== null) return naming;

  const project = await readOfKind(deps, request.projectId, 'project');
  if (!project.ok) return project.failure;

  const record: CanonicalWorkflowStageStateRecord = {
    ...defineCanonicalRecordHeader({
      kind: 'workflow-stage',
      id: deps.allocateRecordId(),
      name: stageName(request.name),
    }),
    projectId: request.projectId,
  };

  let result;
  try {
    result = await deps.store.createIfAbsent(record);
  } catch {
    return failed('storage-failure', 'the record store rejected the write');
  }
  if (!result.ok) {
    return result.reason === 'already-exists'
      ? failed('semantic-conflict', 'a record with that id already exists')
      : failed('storage-failure', 'the record store rejected the write', result.actualRevision);
  }

  return {
    ok: true,
    schemaVersion: WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
    outcome: 'created',
    recordId: record.id,
    revision: result.revision,
    record,
    remappedTaskIds: [],
  };
}

export async function renameWorkflowStage(
  deps: WorkflowStageMutationDependencies,
  input: {
    readonly stageId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly name: string;
  },
): Promise<WorkflowStageMutationResult> {
  const naming = stageNameFailure(input.name);
  if (naming !== null) return naming;

  const stage = await readOfKind(deps, input.stageId, 'workflow-stage');
  if (!stage.ok) return stage.failure;
  if (stage.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this workflow stage first', stage.revision);
  }

  const current = stage.record as CanonicalWorkflowStageStateRecord;
  const next: CanonicalWorkflowStageStateRecord = {
    ...defineCanonicalRecordHeader({
      kind: 'workflow-stage',
      id: current.id,
      name: stageName(input.name),
    }),
    projectId: current.projectId,
  };

  let text: string;
  try {
    text = encodeRecordDocument(next, canonicalRecordV2Codec);
  } catch {
    return refused('the workflow stage record did not validate');
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'update',
      fileName: recordFileNameFor(input.stageId),
      text,
      expectedRevision: input.expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  if (!result.ok) {
    switch (result.reason) {
      case 'stale':
        return failed('stale-revision', 'another writer changed this workflow stage first', result.actualRevision);
      case 'missing':
        return failed('not-found', 'the workflow stage record is not in the store');
      case 'recovery-required':
        return failed('recovery-required', 'the store needs recovery before it accepts writes');
      case 'invalid-record-file-name':
        return refused('the record id cannot name a record file');
      default:
        return failed('storage-failure', 'the record store rejected the write');
    }
  }

  return {
    ok: true,
    schemaVersion: WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
    outcome: 'renamed',
    recordId: input.stageId,
    revision: result.revision,
    record: next,
    remappedTaskIds: [],
  };
}

export async function deleteWorkflowStage(
  deps: WorkflowStageMutationDependencies,
  input: {
    readonly stageId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly remapTo?: WorkflowStageRemapTarget;
  },
): Promise<WorkflowStageMutationResult> {
  const stage = await readOfKind(deps, input.stageId, 'workflow-stage');
  if (!stage.ok) return stage.failure;
  if (stage.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this workflow stage first', stage.revision);
  }
  const current = stage.record as CanonicalWorkflowStageStateRecord;

  let listed;
  try {
    listed = await deps.store.list();
  } catch {
    return failed('storage-failure', 'the record store could not be read');
  }

  const stageIdOf = (record: CanonicalRecordV2): string | null => {
    const value = (record as { workflowStageId?: string | null }).workflowStageId;
    return value === undefined ? null : value;
  };
  const orderOf = (record: CanonicalRecordV2): number | null => {
    const value = (record as { workflowOrder?: number | null }).workflowOrder;
    return typeof value === 'number' ? value : null;
  };

  const tasks = listed.filter((observation) => observation.kind === 'task');
  const members = tasks
    .filter((observation) => stageIdOf(observation.record) === input.stageId)
    .sort((left, right) => left.id.localeCompare(right.id));

  let target: CanonicalWorkflowStageStateRecord | null = null;
  let baseOrder = 0;
  if (input.remapTo !== undefined && input.remapTo.kind === 'stage') {
    const targetStageId = input.remapTo.stageId;
    if (targetStageId === input.stageId) return refused('a stage cannot be remapped to itself');
    const found = await readOfKind(deps, targetStageId, 'workflow-stage');
    if (!found.ok) return found.failure;
    target = found.record as CanonicalWorkflowStageStateRecord;
    if (target.projectId !== current.projectId) {
      return failed('semantic-conflict', 'that workflow stage belongs to another project');
    }
    // Appended after the cards already in the target stage, in a stable id order.
    baseOrder = tasks
      .filter((observation) => stageIdOf(observation.record) === targetStageId)
      .reduce((highest, observation) => {
        const order = orderOf(observation.record);
        return order === null ? highest : Math.max(highest, order + 1);
      }, 0);
  }

  if (members.length > 0 && input.remapTo === undefined) {
    return failed(
      'semantic-conflict',
      `the stage still holds ${members.length} task(s); say where they go before deleting it`,
    );
  }

  const moved: OpaqueRecordId[] = [];
  for (const [index, observation] of members.entries()) {
    const result = await updateTask(deps.taskDependencies, {
      taskId: observation.id,
      expectedRevision: observation.observedRevision,
      mutations: [
        target === null
          ? { kind: 'workflow-stage', value: null, order: null }
          : {
              kind: 'workflow-stage',
              value: target.id,
              order: canonicalOrderPosition(baseOrder + index),
            },
      ],
    });
    if (!result.ok) {
      const detail = result.reason === 'stale-revision'
        ? `task ${observation.id} changed while the stage was being emptied`
        : `task ${observation.id} could not leave the stage: ${result.detail}`;
      return failed(result.reason, detail, result.actualRevision, moved);
    }
    moved.push(observation.id);
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'delete',
      fileName: recordFileNameFor(input.stageId),
      expectedRevision: input.expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted', undefined, moved);
  }

  if (!result.ok) {
    switch (result.reason) {
      case 'stale':
        return failed('stale-revision', 'another writer changed this workflow stage first', result.actualRevision, moved);
      case 'missing':
        return failed('not-found', 'the workflow stage record is not in the store', undefined, moved);
      case 'recovery-required':
        return failed('recovery-required', 'the store needs recovery before it accepts writes', undefined, moved);
      case 'invalid-record-file-name':
        return refused('the record id cannot name a record file');
      default:
        return failed('storage-failure', 'the record store rejected the write', undefined, moved);
    }
  }

  return {
    ok: true,
    schemaVersion: WORKFLOW_STAGE_MUTATION_SCHEMA_VERSION,
    outcome: 'deleted',
    recordId: input.stageId,
    revision: result.revision,
    record: null,
    remappedTaskIds: moved,
  };
}

/** The record file a workflow stage lives in, for a caller reasoning about the store's files. */
export function workflowStageRecordFileName(stageId: OpaqueRecordId): RecordStoreFileName {
  return recordFileNameFor(stageId);
}
