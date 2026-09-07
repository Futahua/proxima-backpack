import { coerceScalar } from '../domain/frontmatter.js';
import { readOptionalDate, type FieldIssue } from '../domain/validation.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';

export interface CreateTaskInput {
  id: string;
  name: string;
  createdAt: string;
  project?: string;
  status?: string;
  weight?: number;
  orderIndex?: number;
  isFixedDuration?: boolean;
  fixedDuration?: number;
  maxDuration?: number;
  isCompleted?: boolean;
  startDate?: string;
  deadline?: string;
  body?: string;
}

export interface CreateTaskOptions {
  input: CreateTaskInput;
  coordinator: VaultMutationCoordinator;
  tasksDirectory?: string;
  maxBytes?: number;
}

export type TaskCreationOutcome = VaultMutationOutcome | { ok: false; reason: 'invalid-value' | 'input-too-large' | 'invalid-path' };

const DEFAULT_TASKS_DIRECTORY = 'Proxima/tasks';
const MAX_FIELD_CHARS = 4096;

function safeText(value: unknown, nonEmpty = true): value is string {
  return typeof value === 'string' && (!nonEmpty || value.length > 0) && value.length <= MAX_FIELD_CHARS && !/[\u0000-\u001F\u007F\r\n]/u.test(value);
}

function safePlain(value: string): boolean {
  return value.length > 0 && !/^[\-?:,\[\]{}#&*!|>'"%@`]/.test(value) && !/[ \t]#/.test(value) && !/:[ \t]/.test(value) && typeof coerceScalar(value) === 'string' && coerceScalar(value) === value;
}

function yamlString(value: string): string {
  if (safePlain(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const issues: FieldIssue[] = [];
  return readOptionalDate(value, 'date', issues) !== null && issues.length === 0;
}

function validInput(input: unknown): input is CreateTaskInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as CreateTaskInput;
  if (!safeText(candidate.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.id)) return false;
  if (!safeText(candidate.name) || !safeText(candidate.createdAt) || !validDate(candidate.createdAt)) return false;
  if (candidate.project !== undefined && !safeText(candidate.project)) return false;
  if (candidate.status !== undefined && (!safeText(candidate.status) || candidate.status.trim() === '')) return false;
  if (candidate.weight !== undefined && (!(typeof candidate.weight === 'number') || !Number.isFinite(candidate.weight) || candidate.weight <= 0)) return false;
  if (candidate.orderIndex !== undefined && (!(typeof candidate.orderIndex === 'number') || !Number.isFinite(candidate.orderIndex))) return false;
  if (candidate.isFixedDuration !== undefined && typeof candidate.isFixedDuration !== 'boolean') return false;
  if (candidate.fixedDuration !== undefined && (!(typeof candidate.fixedDuration === 'number') || !Number.isFinite(candidate.fixedDuration) || candidate.fixedDuration <= 0)) return false;
  if (candidate.maxDuration !== undefined && (!(typeof candidate.maxDuration === 'number') || !Number.isFinite(candidate.maxDuration) || candidate.maxDuration <= 0)) return false;
  if (candidate.isCompleted !== undefined && typeof candidate.isCompleted !== 'boolean') return false;
  if (candidate.startDate !== undefined && !validDate(candidate.startDate)) return false;
  if (candidate.deadline !== undefined && !validDate(candidate.deadline)) return false;
  if (candidate.body !== undefined && (typeof candidate.body !== 'string' || /[\u0000\u007F]/u.test(candidate.body))) return false;
  return true;
}

function safeDirectory(directory: string): boolean {
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 260 || directory.startsWith('/') || /^[A-Za-z]:[\\/]/.test(directory)) return false;
  const parts = directory.replaceAll('\\', '/').split('/');
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function canonicalTaskBytes(input: CreateTaskInput, maxBytes: number): Uint8Array | null {
  const lines = [`id: ${yamlString(input.id)}`, `name: ${yamlString(input.name)}`, `createdAt: ${yamlString(input.createdAt)}`];
  if (input.project !== undefined) lines.push(`project: ${yamlString(input.project)}`);
  if (input.status !== undefined) lines.push(`status: ${yamlString(input.status.trim())}`);
  if (input.weight !== undefined) lines.push(`weight: ${String(input.weight)}`);
  if (input.orderIndex !== undefined) lines.push(`orderIndex: ${String(input.orderIndex)}`);
  if (input.isFixedDuration !== undefined) lines.push(`isFixedDuration: ${String(input.isFixedDuration)}`);
  if (input.fixedDuration !== undefined) lines.push(`fixedDuration: ${String(input.fixedDuration)}`);
  if (input.maxDuration !== undefined) lines.push(`maxDuration: ${String(input.maxDuration)}`);
  if (input.isCompleted !== undefined) lines.push(`isCompleted: ${String(input.isCompleted)}`);
  if (input.startDate !== undefined) lines.push(`startDate: ${yamlString(input.startDate)}`);
  if (input.deadline !== undefined) lines.push(`deadline: ${yamlString(input.deadline)}`);
  const source = `---\n${lines.join('\n')}\n---\n${input.body ?? ''}`;
  const bytes = new TextEncoder().encode(source);
  return bytes.byteLength <= maxBytes ? bytes : null;
}

/** Create exactly one canonical task file through the coordinator's exclusive create primitive. */
export async function createTask(options: CreateTaskOptions): Promise<TaskCreationOutcome> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  const input = options.input as unknown;
  const directory = options.tasksDirectory ?? DEFAULT_TASKS_DIRECTORY;
  if (!validInput(input)) return { ok: false, reason: 'invalid-value' };
  if (!safeDirectory(directory)) return { ok: false, reason: 'invalid-path' };
  if (input.body !== undefined && input.body.length > maxBytes) return { ok: false, reason: 'input-too-large' };
  const bytes = canonicalTaskBytes(input, maxBytes);
  if (!bytes) return { ok: false, reason: 'input-too-large' };
  return options.coordinator.execute({ kind: 'create', path: `${directory.replaceAll('\\', '/')}/${input.id}.md`, bytes });
}
