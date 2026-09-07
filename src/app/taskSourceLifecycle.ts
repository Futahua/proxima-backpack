import type { IdOrigin, SourceRef } from '../domain/records.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';

export interface TaskSourceIdentity { id: string; source: SourceRef; }
export interface RenameTaskSourceOptions { task: TaskSourceIdentity; newFileStem: string; coordinator: VaultMutationCoordinator; tasksDirectory?: string; }
export interface DeleteTaskSourceOptions { task: TaskSourceIdentity; coordinator: VaultMutationCoordinator; tasksDirectory?: string; }
export type TaskSourceLifecycleOutcome = VaultMutationOutcome | { ok: false; reason: 'invalid-provenance' | 'invalid-name' | 'rename-requires-explicit-id' };

const SAFE_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validSource(source: unknown): source is SourceRef {
  if (typeof source !== 'object' || source === null) return false;
  const candidate = source as Partial<SourceRef>;
  if (candidate.kind !== 'task' || (candidate.idOrigin !== 'frontmatter' && candidate.idOrigin !== 'filename')) return false;
  if (typeof candidate.path !== 'string' || candidate.path.length === 0 || candidate.path.length > 260 || typeof candidate.revision !== 'string' || candidate.revision.length === 0 || candidate.revision.length > 400) return false;
  const path = candidate.path.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) return false;
  return path.toLowerCase().endsWith('.md');
}

function validTask(task: unknown): task is TaskSourceIdentity {
  if (typeof task !== 'object' || task === null) return false;
  const candidate = task as Partial<TaskSourceIdentity>;
  return typeof candidate.id === 'string' && candidate.id.length > 0 && candidate.id.length <= 200 && validSource(candidate.source);
}

function taskPath(source: SourceRef): string { return source.path.replaceAll('\\', '/'); }
function sameDirectory(path: string, stem: string): string {
  const slash = path.lastIndexOf('/'); const directory = slash >= 0 ? path.slice(0, slash) : '';
  return `${directory ? `${directory}/` : ''}${stem}.md`;
}

function validDirectory(directory: string): boolean {
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 260 || directory.startsWith('/') || /^[A-Za-z]:\//.test(directory)) return false;
  return directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isImmediateTaskSource(path: string, directory: string): boolean {
  const prefix = `${directory.replaceAll('\\', '/')}/`;
  if (!path.startsWith(prefix)) return false;
  const leaf = path.slice(prefix.length);
  return leaf.length >= 4 && leaf.toLowerCase().endsWith('.md') && !leaf.slice(0, -3).includes('/');
}

function portableStem(stem: string): boolean {
  const upper = stem.toUpperCase();
  return !['CON', 'PRN', 'AUX', 'NUL'].includes(upper) && !/^(COM|LPT)[1-9]$/.test(upper);
}

/** Rename an explicitly identified task within its current flat task directory. */
export async function renameTaskSource(options: RenameTaskSourceOptions): Promise<TaskSourceLifecycleOutcome> {
  if (!validTask(options.task)) return { ok: false, reason: 'invalid-provenance' };
  if (options.task.source.idOrigin !== 'frontmatter') return { ok: false, reason: 'rename-requires-explicit-id' };
  const directory = (options.tasksDirectory ?? 'Proxima/tasks').replaceAll('\\', '/');
  if (!validDirectory(directory) || !isImmediateTaskSource(taskPath(options.task.source), directory)) return { ok: false, reason: 'invalid-provenance' };
  if (typeof options.newFileStem !== 'string' || !SAFE_STEM.test(options.newFileStem) || !portableStem(options.newFileStem)) return { ok: false, reason: 'invalid-name' };
  const path = taskPath(options.task.source); const destination = sameDirectory(path, options.newFileStem);
  return options.coordinator.execute({ kind: 'move', from: path, to: destination, expectedRevision: options.task.source.revision });
}

/** Delete exactly the observed task source; no cascade or recreation is attempted. */
export async function deleteTaskSource(options: DeleteTaskSourceOptions): Promise<TaskSourceLifecycleOutcome> {
  if (!validTask(options.task)) return { ok: false, reason: 'invalid-provenance' };
  const directory = (options.tasksDirectory ?? 'Proxima/tasks').replaceAll('\\', '/');
  if (!validDirectory(directory) || !isImmediateTaskSource(taskPath(options.task.source), directory)) return { ok: false, reason: 'invalid-provenance' };
  return options.coordinator.execute({ kind: 'delete', path: taskPath(options.task.source), expectedRevision: options.task.source.revision });
}
