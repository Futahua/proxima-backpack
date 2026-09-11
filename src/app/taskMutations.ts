/**
 * Stage 9's record editing: `task.create`, `task.update` and `task.delete` as semantic
 * operations rather than a UI reaching into storage.
 *
 * Three rules shape everything here.
 *
 * **The request is closed and typed.** Not a JSON patch: a mutation says which field it
 * changes and what the value is, so a caller cannot invent a field, and this module owns what
 * each field means. An empty mutation list is refused rather than treated as a no-op write,
 * because a caller that asked for nothing has a bug and a silent success would hide it.
 *
 * **Nothing is written until everything is valid.** Every refusal below happens before the
 * first byte moves — the tests assert the store's revisions are untouched after a refused
 * request, which is the difference between validating and hoping.
 *
 * **Existing records change through the recovery coordinator.** Creates go through the store's
 * own `createIfAbsent`, which is idempotent and cannot leave a half-record; updates and deletes
 * are conditional and journaled, so a crash mid-write is recoverable and a caller that lost a
 * race is told so with the revision that beat it.
 *
 * Failures speak the action taxonomy's vocabulary on purpose — `validation-refused`,
 * `not-found`, `stale-revision`, `semantic-conflict`, `recovery-required`, `storage-failure` —
 * so the same operation can be reported identically whether a human clicked or an agent asked.
 */
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import { defineCanonicalRecordHeader } from '../domain/canonicalIdentity.js';
import { canonicalOrderPosition } from '../domain/canonicalOrdering.js';
import {
  type CanonicalRecordV2,
  type CanonicalStoredPropertyValue,
  type CanonicalStoredPropertyValues,
  type CanonicalTaskRecordV2,
} from '../domain/canonicalRecordV2.js';
import type { CanonicalRecurrenceSeries } from '../domain/canonicalRecurrence.js';
import type { CanonicalExecutionState } from '../domain/canonicalTaskState.js';
import type { RecordStore, RecordStoreFileName } from '../ports/recordStore.js';
import { canonicalRecordV2Codec } from './canonicalRecordCodec.js';
import { encodeRecordDocument, recordFileNameFor } from './jsonRecordStore.js';
import type { RecordMutationCoordinator } from './recordMutation.js';

export const TASK_MUTATION_SCHEMA_VERSION = 1 as const;

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 20_000;

/** The action taxonomy's non-accepted outcomes, so a failure is reportable as one. */
export type TaskMutationFailureReason =
  | 'validation-refused'
  | 'not-found'
  | 'stale-revision'
  | 'semantic-conflict'
  | 'recovery-required'
  | 'storage-failure';

export interface TaskMutationSuccess {
  readonly ok: true;
  readonly schemaVersion: typeof TASK_MUTATION_SCHEMA_VERSION;
  readonly outcome: 'created' | 'updated' | 'deleted';
  readonly recordId: OpaqueRecordId;
  readonly revision: string;
  /** The record as written; `null` for a delete. */
  readonly record: CanonicalTaskRecordV2 | null;
}

export interface TaskMutationFailure {
  readonly ok: false;
  readonly schemaVersion: typeof TASK_MUTATION_SCHEMA_VERSION;
  readonly reason: TaskMutationFailureReason;
  /** One bounded sentence, safe to show: never a path, a secret or a stack. */
  readonly detail: string;
  /** Present for a stale refusal, so the caller can refetch rather than guess. */
  readonly actualRevision?: string;
}

export type TaskMutationResult = TaskMutationSuccess | TaskMutationFailure;

export interface TaskMutationDependencies {
  readonly store: RecordStore<CanonicalRecordV2>;
  readonly coordinator: RecordMutationCoordinator;
  /** Injected: nothing here reads a clock. */
  readonly clock?: Clock;
  readonly allocateRecordId: () => OpaqueRecordId;
}

export interface CreateTaskRequest {
  readonly name: string;
  readonly projectId: OpaqueRecordId | null;
  readonly description?: string;
  readonly executionState?: CanonicalExecutionState;
  readonly weight?: number;
  readonly startDate?: string | null;
  readonly deadline?: string | null;
  readonly isFixedDuration?: boolean;
  readonly fixedDuration?: number | null;
  readonly maxDuration?: number | null;
  readonly executionOrder?: number;
  /**
   * The project workflow stage, and its position inside that stage.
   *
   * The two travel together because the canonical model refuses either half alone: a task with
   * a stage must have a workflow position, and a task without a stage must not have one. This
   * module could default the position, but silently choosing where a card lands in someone's
   * workflow is exactly the kind of decision a write path should not make for them.
   */
  readonly workflowStageId?: OpaqueRecordId | null;
  readonly workflowOrder?: number | null;
  readonly properties?: CanonicalStoredPropertyValues;
}

/** One field, named. Adding a field is a deliberate change to this union. */
export type TaskFieldMutation =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'description'; readonly value: string }
  | { readonly kind: 'project'; readonly value: OpaqueRecordId | null }
  | { readonly kind: 'execution-state'; readonly value: CanonicalExecutionState }
  | { readonly kind: 'weight'; readonly value: number }
  | { readonly kind: 'dates'; readonly startDate: string | null; readonly deadline: string | null }
  | { readonly kind: 'fixed-duration'; readonly isFixedDuration: boolean; readonly fixedDuration: number | null }
  | { readonly kind: 'max-duration'; readonly value: number | null }
  | { readonly kind: 'completion'; readonly value: boolean }
  | { readonly kind: 'execution-order'; readonly value: number }
  | { readonly kind: 'workflow-stage'; readonly value: OpaqueRecordId | null; readonly order: number | null }
  | { readonly kind: 'workflow-order'; readonly value: number }
  | { readonly kind: 'property'; readonly key: OpaqueRecordId; readonly value: CanonicalStoredPropertyValue | null }
  | { readonly kind: 'recurrence'; readonly value: CanonicalRecurrenceSeries | null };

function refused(detail: string): TaskMutationFailure {
  return { ok: false, schemaVersion: TASK_MUTATION_SCHEMA_VERSION, reason: 'validation-refused', detail };
}

function failed(reason: TaskMutationFailureReason, detail: string, actualRevision?: string): TaskMutationFailure {
  return {
    ok: false,
    schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
    reason,
    detail,
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
}

function instant(value: string, field: string): string | null {
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Null means "no such record of that kind", which is a refusal rather than an empty answer. */
async function requireRecord(
  deps: TaskMutationDependencies,
  id: OpaqueRecordId,
  kind: 'project' | 'workflow-stage' | 'schema',
): Promise<{ ok: true; record: { id: string; name: string; projectId?: string } } | { ok: false; failure: TaskMutationFailure }> {
  let observation;
  try {
    observation = await deps.store.read(id);
  } catch {
    return { ok: false, failure: failed('storage-failure', 'the record store could not be read') };
  }
  if (observation === undefined || observation.kind !== kind) {
    return { ok: false, failure: failed('not-found', `no ${kind} record ${id}`) };
  }
  const record = observation.record as unknown as { id: string; name: string; projectId?: string };
  return { ok: true, record };
}

/**
 * Everything a create must satisfy that the codec does not already enforce, in one place so a
 * refusal cannot be forgotten in one path and remembered in another.
 */
async function validateCreate(
  deps: TaskMutationDependencies,
  request: CreateTaskRequest,
): Promise<{ ok: true; record: CanonicalTaskRecordV2 } | { ok: false; failure: TaskMutationFailure }> {
  if (typeof request.name !== 'string' || request.name.trim().length === 0) return { ok: false, failure: refused('a task needs a name') };
  if (request.name.length > MAX_NAME_LENGTH) return { ok: false, failure: refused(`a task name may be at most ${MAX_NAME_LENGTH} characters`) };
  const description = request.description ?? '';
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) return { ok: false, failure: refused('the description is too long') };

  const executionState = request.executionState ?? 'backlog';
  if (executionState !== 'backlog' && executionState !== 'running' && executionState !== 'finished') {
    return { ok: false, failure: refused('an execution state is backlog, running or finished') };
  }

  const weight = request.weight ?? 1;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) return { ok: false, failure: refused('weight must be a number that is not negative') };

  const startDate = request.startDate ?? null;
  const deadline = request.deadline ?? null;
  if (startDate !== null && instant(startDate, 'startDate') === null) return { ok: false, failure: refused('the start date is not a readable instant') };
  if (deadline !== null && instant(deadline, 'deadline') === null) return { ok: false, failure: refused('the deadline is not a readable instant') };
  if (startDate !== null && deadline !== null && Date.parse(deadline) < Date.parse(startDate)) {
    return { ok: false, failure: refused('the deadline is before the start date') };
  }

  const isFixedDuration = request.isFixedDuration ?? false;
  const fixedDuration = request.fixedDuration ?? null;
  if (isFixedDuration) {
    if (!nonNegativeInteger(fixedDuration)) return { ok: false, failure: refused('a fixed-duration task needs a duration in whole minutes') };
  } else if (fixedDuration !== null && !nonNegativeInteger(fixedDuration)) {
    return { ok: false, failure: refused('a fixed duration is whole minutes, or nothing at all') };
  }
  const maxDuration = request.maxDuration ?? null;
  if (maxDuration !== null && !nonNegativeInteger(maxDuration)) return { ok: false, failure: refused('the maximum duration is whole minutes, or nothing at all') };
  if (maxDuration !== null && isFixedDuration && fixedDuration !== null && maxDuration < fixedDuration) {
    return { ok: false, failure: refused('the maximum duration is below the fixed duration') };
  }

  const executionOrder = request.executionOrder ?? 0;
  if (!nonNegativeInteger(executionOrder)) return { ok: false, failure: refused('the execution order is a position, so it is a whole number that is not negative') };

  const projectId = request.projectId ?? null;
  if (projectId !== null) {
    const project = await requireRecord(deps, projectId, 'project');
    if (!project.ok) return { ok: false, failure: project.failure };
  }

  const workflowStageId = request.workflowStageId ?? null;
  const workflowOrder = request.workflowOrder ?? null;
  if (workflowStageId === null && workflowOrder !== null) {
    return { ok: false, failure: refused('a task with no workflow stage has no workflow position') };
  }
  if (workflowStageId !== null) {
    if (!nonNegativeInteger(workflowOrder)) {
      return { ok: false, failure: refused('a task in a workflow stage needs its position in that stage') };
    }
    const stage = await requireRecord(deps, workflowStageId, 'workflow-stage');
    if (!stage.ok) return { ok: false, failure: stage.failure };
    // A stage belongs to one project, and a task in another project may not point at it: that
    // is a semantic conflict, not a missing record.
    if (projectId === null || stage.record.projectId !== projectId) {
      return { ok: false, failure: failed('semantic-conflict', 'that workflow stage belongs to another project') };
    }
  }

  const properties = request.properties ?? {};
  const propertiesChecked = await validatePropertyKeys(deps, properties);
  if (!propertiesChecked.ok) return { ok: false, failure: propertiesChecked.failure };

  const header = defineCanonicalRecordHeader({ kind: 'task', id: deps.allocateRecordId(), name: request.name });
  const record: CanonicalTaskRecordV2 = {
    ...header,
    projectId,
    executionState,
    workflowStageId,
    executionOrder: canonicalOrderPosition(executionOrder),
    workflowOrder: workflowStageId === null ? null : canonicalOrderPosition(workflowOrder!),
    description,
    weight,
    isFixedDuration,
    fixedDuration: isFixedDuration ? fixedDuration : null,
    maxDuration,
    // Derived, never supplied: a task in Finished is complete, and one that is not is not.
    isCompleted: executionState === 'finished',
    createdAt: new Date(deps.clock?.now() ?? systemClock.now()).toISOString(),
    startDate,
    deadline,
    properties,
    recurrence: null,
  };
  return { ok: true, record };
}

/** A stored property is keyed by the schema record that defines it; an undeclared key is a conflict. */
async function validatePropertyKeys(
  deps: TaskMutationDependencies,
  properties: CanonicalStoredPropertyValues,
): Promise<{ ok: true } | { ok: false; failure: TaskMutationFailure }> {
  for (const key of Object.keys(properties).sort()) {
    const schema = await requireRecord(deps, key as OpaqueRecordId, 'schema');
    if (!schema.ok) {
      return {
        ok: false,
        failure: failed('semantic-conflict', `no schema record defines the property ${key}`),
      };
    }
  }
  return { ok: true };
}

function applyFieldMutations(
  record: CanonicalTaskRecordV2,
  mutations: readonly TaskFieldMutation[],
): { ok: true; record: CanonicalTaskRecordV2 } | { ok: false; failure: TaskMutationFailure } {
  let next: CanonicalTaskRecordV2 = { ...record, properties: { ...record.properties } };

  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'name': {
        if (typeof mutation.value !== 'string' || mutation.value.trim().length === 0) return { ok: false, failure: refused('a task needs a name') };
        if (mutation.value.length > MAX_NAME_LENGTH) return { ok: false, failure: refused(`a task name may be at most ${MAX_NAME_LENGTH} characters`) };
        next = { ...next, name: mutation.value };
        break;
      }
      case 'description': {
        if (typeof mutation.value !== 'string' || mutation.value.length > MAX_DESCRIPTION_LENGTH) return { ok: false, failure: refused('the description is too long') };
        next = { ...next, description: mutation.value };
        break;
      }
      case 'project': {
        next = { ...next, projectId: mutation.value };
        break;
      }
      case 'execution-state': {
        // Completion follows the execution state rather than being set beside it, which is the
        // only way "moved into Finished" and "is complete" cannot disagree. The workflow stage
        // and its order are deliberately untouched: A2 keeps the two dimensions independent.
        next = { ...next, executionState: mutation.value, isCompleted: mutation.value === 'finished' };
        break;
      }
      case 'weight': {
        if (typeof mutation.value !== 'number' || !Number.isFinite(mutation.value) || mutation.value < 0) return { ok: false, failure: refused('weight must be a number that is not negative') };
        next = { ...next, weight: mutation.value };
        break;
      }
      case 'dates': {
        if (mutation.startDate !== null && instant(mutation.startDate, 'startDate') === null) return { ok: false, failure: refused('the start date is not a readable instant') };
        if (mutation.deadline !== null && instant(mutation.deadline, 'deadline') === null) return { ok: false, failure: refused('the deadline is not a readable instant') };
        if (mutation.startDate !== null && mutation.deadline !== null && Date.parse(mutation.deadline) < Date.parse(mutation.startDate)) {
          return { ok: false, failure: refused('the deadline is before the start date') };
        }
        next = { ...next, startDate: mutation.startDate, deadline: mutation.deadline };
        break;
      }
      case 'fixed-duration': {
        if (mutation.isFixedDuration) {
          if (!nonNegativeInteger(mutation.fixedDuration)) return { ok: false, failure: refused('a fixed-duration task needs a duration in whole minutes') };
        }
        next = {
          ...next,
          isFixedDuration: mutation.isFixedDuration,
          fixedDuration: mutation.isFixedDuration ? mutation.fixedDuration : null,
        };
        break;
      }
      case 'max-duration': {
        if (mutation.value !== null && !nonNegativeInteger(mutation.value)) return { ok: false, failure: refused('the maximum duration is whole minutes, or nothing at all') };
        next = { ...next, maxDuration: mutation.value };
        break;
      }
      case 'completion': {
        // The one place completion is settable on its own, and only as data: it does not move the
        // execution state, because a caller that wants the board to change says so separately.
        next = { ...next, isCompleted: mutation.value };
        break;
      }
      case 'execution-order': {
        if (!nonNegativeInteger(mutation.value)) return { ok: false, failure: refused('the execution order is a position, so it is a whole number that is not negative') };
        next = { ...next, executionOrder: canonicalOrderPosition(mutation.value) };
        break;
      }
      case 'workflow-stage': {
        // The stage and its position move together, so the record can never hold one without the
        // other. Leaving a stage clears the position with it.
        if (mutation.value === null) {
          if (mutation.order !== null) return { ok: false, failure: refused('leaving a workflow stage clears its position') };
          next = { ...next, workflowStageId: null, workflowOrder: null };
          break;
        }
        if (!nonNegativeInteger(mutation.order)) return { ok: false, failure: refused('a task in a workflow stage needs its position in that stage') };
        next = { ...next, workflowStageId: mutation.value, workflowOrder: canonicalOrderPosition(mutation.order!) };
        break;
      }
      case 'workflow-order': {
        if (!nonNegativeInteger(mutation.value)) return { ok: false, failure: refused('the workflow order is a position, so it is a whole number that is not negative') };
        if (next.workflowStageId === null) return { ok: false, failure: refused('a task with no workflow stage has no workflow position to change') };
        next = { ...next, workflowOrder: canonicalOrderPosition(mutation.value) };
        break;
      }
      case 'property': {
        const properties = { ...next.properties };
        if (mutation.value === null) delete properties[mutation.key];
        else properties[mutation.key] = mutation.value;
        next = { ...next, properties };
        break;
      }
      case 'recurrence': {
        next = { ...next, recurrence: mutation.value };
        break;
      }
      default: {
        return { ok: false, failure: refused('unknown task field mutation') };
      }
    }
  }

  return { ok: true, record: next };
}

function outcomeOf(result: { ok: boolean; reason?: string }, recordId: OpaqueRecordId, revision: string, record: CanonicalTaskRecordV2 | null, outcome: 'created' | 'updated' | 'deleted', actualRevision?: string): TaskMutationResult {
  if (result.ok) {
    return {
      ok: true,
      schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
      outcome,
      recordId,
      revision,
      record,
    };
  }
  switch (result.reason) {
    case 'stale':
      return failed('stale-revision', 'another writer changed this task first', actualRevision);
    case 'missing':
      return failed('not-found', 'the task record is not in the store');
    case 'already-exists':
      return failed('semantic-conflict', 'a record with that id already exists');
    case 'recovery-required':
      return failed('recovery-required', 'the store needs recovery before it accepts writes');
    case 'invalid-record-file-name':
      return failed('validation-refused', 'the record id cannot name a record file');
    default:
      return failed('storage-failure', 'the record store rejected the write');
  }
}

export async function createTask(
  deps: TaskMutationDependencies,
  request: CreateTaskRequest,
): Promise<TaskMutationResult> {
  const validated = await validateCreate(deps, request);
  if (!validated.ok) return validated.failure;

  // Creation is the store's own idempotent boundary rather than a journaled update: it either
  // creates the record or says it was already there, and there is no prior revision to lose.
  let result;
  try {
    result = await deps.store.createIfAbsent(validated.record);
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
    schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
    outcome: 'created',
    recordId: validated.record.id,
    revision: result.revision,
    record: validated.record,
  };
}

export async function updateTask(
  deps: TaskMutationDependencies,
  input: { taskId: OpaqueRecordId; expectedRevision: string; mutations: readonly TaskFieldMutation[] },
): Promise<TaskMutationResult> {
  if (input.mutations.length === 0) return refused('an update with no field to change is not an update');

  let observation;
  try {
    observation = await deps.store.read(input.taskId);
  } catch {
    return failed('storage-failure', 'the record store could not be read');
  }
  if (observation === undefined) return failed('not-found', 'the task record is not in the store');
  if (observation.observedRevision !== input.expectedRevision) {
    // Refused before anything is built on top of a revision the caller has not seen.
    return failed('stale-revision', 'another writer changed this task first', observation.observedRevision);
  }

  const current = observation.record as CanonicalTaskRecordV2;
  const applied = applyFieldMutations(current, input.mutations);
  if (!applied.ok) return applied.failure;

  for (const mutation of input.mutations) {
    if (mutation.kind === 'project' && mutation.value !== null) {
      const project = await requireRecord(deps, mutation.value, 'project');
      if (!project.ok) return project.failure;
    }
    if (mutation.kind === 'property') {
      const schema = await requireRecord(deps, mutation.key, 'schema');
      if (!schema.ok) return failed('semantic-conflict', `no schema record defines the property ${mutation.key}`);
    }
  }

  // The final record must still be internally consistent, whichever mutations produced it: a
  // project change on a task that kept a stage from the old project is refused here rather than
  // by the store's encoder, so the caller gets a sentence instead of "the write was rejected".
  if (applied.record.workflowStageId !== null) {
    const stage = await requireRecord(deps, applied.record.workflowStageId, 'workflow-stage');
    if (!stage.ok) return stage.failure;
    if (applied.record.projectId === null || stage.record.projectId !== applied.record.projectId) {
      return failed('semantic-conflict', 'that workflow stage belongs to another project');
    }
  }

  let text: string;
  try {
    text = encodeRecordDocument(applied.record, canonicalRecordV2Codec);
  } catch {
    return refused('the task record did not validate');
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'update',
      fileName: recordFileNameFor(input.taskId),
      text,
      expectedRevision: input.expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  return outcomeOf(
    result,
    input.taskId,
    result.ok ? result.revision : '',
    applied.record,
    'updated',
    result.ok ? undefined : result.actualRevision,
  );
}

export async function deleteTask(
  deps: TaskMutationDependencies,
  input: { taskId: OpaqueRecordId; expectedRevision: string },
): Promise<TaskMutationResult> {
  let observation;
  try {
    observation = await deps.store.read(input.taskId);
  } catch {
    return failed('storage-failure', 'the record store could not be read');
  }
  if (observation === undefined) return failed('not-found', 'the task record is not in the store');
  if (observation.observedRevision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this task first', observation.observedRevision);
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'delete',
      fileName: recordFileNameFor(input.taskId),
      expectedRevision: input.expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  return outcomeOf(result, input.taskId, result.ok ? result.revision : '', null, 'deleted', result.ok ? undefined : result.actualRevision);
}

/** The record file a task lives in, for a caller that needs to reason about the store's files. */
export function taskRecordFileName(taskId: OpaqueRecordId): RecordStoreFileName {
  return recordFileNameFor(taskId);
}
