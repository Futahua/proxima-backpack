import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planTaskOptionalInsert, planTaskOptionalRemove, planTaskProjectPatch, planTaskScalarPatch, planTaskStatusPatch, type SourcePatchFailureReason, type TaskOptionalField } from './sourcePreservingMarkdown.js';
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

export type TaskOptionalMutation =
  | { kind: 'set'; field: 'project'; value: string }
  | { kind: 'set'; field: 'fixedDuration' | 'maxDuration'; value: number }
  | { kind: 'set'; field: 'startDate' | 'deadline'; value: string }
  | { kind: 'clear'; field: TaskOptionalField };
export type TaskOptionalMutationOutcome = VaultMutationOutcome | { ok: true; noOp: true; path: string; revision: string } | { ok: false; reason: SourcePatchFailureReason | 'binary-read-unavailable' | 'missing' };

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

interface UpdateTaskOptionalCommon {
  path: string;
  expectedRevision: string;
  reader: VaultReader;
  coordinator: VaultMutationCoordinator;
  maxBytes?: number;
}
export type UpdateTaskOptionalOptions = UpdateTaskOptionalCommon & { mutation: TaskOptionalMutation };

const TASK_OPTIONAL_FIELDS: readonly TaskOptionalField[] = ['project', 'fixedDuration', 'maxDuration', 'startDate', 'deadline'];

function validOptional(mutation: TaskOptionalMutation): boolean {
  if (mutation.kind === 'clear') return TASK_OPTIONAL_FIELDS.includes(mutation.field);
  if (mutation.field === 'project') return typeof mutation.value === 'string' && mutation.value.length > 0 && mutation.value.length <= 4096 && !/[\u0000-\u001F\u007F\r\n]/u.test(mutation.value);
  if (mutation.field === 'fixedDuration' || mutation.field === 'maxDuration') return typeof mutation.value === 'number' && Number.isFinite(mutation.value) && mutation.value > 0;
  const issues: FieldIssue[] = []; return typeof mutation.value === 'string' && readOptionalDate(mutation.value, mutation.field, issues) !== null && issues.length === 0;
}

/** Explicit optional-field set/clear; insertion/removal is never inferred from null or empty values. */
export async function updateTaskOptional(options: UpdateTaskOptionalOptions): Promise<TaskOptionalMutationOutcome> {
  const raw = (options as unknown as { mutation?: { kind?: unknown; field?: unknown } }).mutation;
  if (!raw || (raw.kind !== 'set' && raw.kind !== 'clear') || typeof raw.field !== 'string' || !TASK_OPTIONAL_FIELDS.includes(raw.field as TaskOptionalField)) return { ok: false, reason: 'field-not-allowed' };
  const mutation = options.mutation;
  if (!validOptional(mutation)) return { ok: false, reason: 'invalid-value' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  let file;
  try { file = await options.reader.readBinary(options.path, maxBytes); } catch { return { ok: false, reason: 'missing' }; }
  if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  let patch;
  if (mutation.kind === 'clear') patch = planTaskOptionalRemove(file.bytes, mutation.field, maxBytes);
  else if (mutation.field === 'project') patch = planTaskProjectPatch(file.bytes, mutation.value, maxBytes);
  else patch = planTaskScalarPatch(file.bytes, mutation.field, mutation.value, maxBytes);
  if (!patch.ok && patch.reason === 'target-missing' && mutation.kind === 'set') patch = planTaskOptionalInsert(file.bytes, mutation.field, mutation.value, maxBytes);
  if (!patch.ok && patch.reason === 'target-missing' && mutation.kind === 'clear') return { ok: true, noOp: true, path: options.path, revision: file.revision };
  if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path: options.path, bytes: patch.bytes, expectedRevision: options.expectedRevision });
}
