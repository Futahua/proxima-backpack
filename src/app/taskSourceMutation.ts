import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planTaskProjectPatch, planTaskScalarPatch, planTaskStatusPatch, type SourcePatchFailureReason } from './sourcePreservingMarkdown.js';
import { readOptionalDate, type FieldIssue } from '../domain/validation.js';

export interface UpdateTaskStatusOptions {
  path: string;
  expectedRevision: string;
  status: string;
  reader: VaultReader;
  coordinator: VaultMutationCoordinator;
  maxBytes?: number;
}

export type TaskStatusMutationOutcome = VaultMutationOutcome | { ok: false; reason: SourcePatchFailureReason | 'binary-read-unavailable' | 'missing' };

export type TaskScalarMutation =
  | { field: 'name'; value: string }
  | { field: 'project'; value: string }
  | { field: 'status'; value: string }
  | { field: 'weight'; value: number }
  | { field: 'orderIndex'; value: number }
  | { field: 'isFixedDuration'; value: boolean }
  | { field: 'fixedDuration'; value: number }
  | { field: 'maxDuration'; value: number }
  | { field: 'isCompleted'; value: boolean }
  | { field: 'startDate'; value: string }
  | { field: 'deadline'; value: string };

export type TaskScalarMutationOutcome = VaultMutationOutcome | { ok: false; reason: SourcePatchFailureReason | 'binary-read-unavailable' | 'missing' };

/** Read exact source bytes, patch only the existing status scalar, then CAS them through the coordinator. */
export async function updateTaskStatus(options: UpdateTaskStatusOptions): Promise<TaskStatusMutationOutcome> {
  return updateTaskScalar({ ...options, field: 'status', value: options.status });
}

interface UpdateTaskScalarCommon {
  path: string;
  expectedRevision: string;
  reader: VaultReader;
  coordinator: VaultMutationCoordinator;
  maxBytes?: number;
}
export type UpdateTaskScalarOptions = UpdateTaskScalarCommon & TaskScalarMutation;

const TASK_SCALAR_FIELDS: readonly TaskScalarMutation['field'][] = ['name', 'project', 'status', 'weight', 'orderIndex', 'isFixedDuration', 'fixedDuration', 'maxDuration', 'isCompleted', 'startDate', 'deadline'];

function validValue(mutation: TaskScalarMutation): boolean {
  const { field, value } = mutation;
  if (field === 'weight') return Number.isFinite(value) && value > 0;
  if (field === 'fixedDuration' || field === 'maxDuration') return Number.isFinite(value) && value > 0;
  if (field === 'orderIndex') return Number.isFinite(value);
  if (field === 'isFixedDuration' || field === 'isCompleted') return typeof value === 'boolean';
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F\r\n]/u.test(value)) return false;
  if ((field === 'name' || field === 'project') && value.length === 0) return false;
  if (field === 'status') return value.trim() !== '';
  if (field === 'startDate' || field === 'deadline') { const issues: FieldIssue[] = []; return readOptionalDate(value, field, issues) !== null && issues.length === 0; }
  return value.length <= 4096;
}

/** Apply one closed, typed task scalar mutation through the existing CAS coordinator. */
export async function updateTaskScalar(options: UpdateTaskScalarOptions): Promise<TaskScalarMutationOutcome> {
  const rawField = (options as unknown as { field?: unknown }).field;
  if (typeof rawField !== 'string' || !TASK_SCALAR_FIELDS.includes(rawField as TaskScalarMutation['field'])) return { ok: false, reason: 'field-not-allowed' };
  const mutation = options as TaskScalarMutation;
  if (!validValue(mutation)) return { ok: false, reason: 'invalid-value' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  let file;
  try { file = await options.reader.readBinary(options.path, maxBytes); }
  catch { return { ok: false, reason: 'missing' }; }
  if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  let patch;
  if (options.field === 'status') patch = planTaskStatusPatch(file.bytes, options.value as string, maxBytes);
  else if (options.field === 'project') patch = planTaskProjectPatch(file.bytes, options.value as string, maxBytes);
  else patch = planTaskScalarPatch(file.bytes, options.field, options.value as string | number | boolean, maxBytes);
  if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path: options.path, bytes: patch.bytes, expectedRevision: options.expectedRevision });
}
