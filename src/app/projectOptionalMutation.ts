import type { SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planProjectOptionalInsert, planProjectOptionalRemove, planProjectScalarPatch, type ProjectOptionalField, type SourcePatchFailureReason } from './sourcePreservingMarkdown.js';

export type ProjectOptionalMutation =
  | { kind: 'set'; field: ProjectOptionalField; value: string }
  | { kind: 'clear'; field: ProjectOptionalField };

interface Common { path: string; reader: VaultReader; coordinator: VaultMutationCoordinator; projectsDirectory?: string; maxBytes?: number; }
export type UpdateProjectOptionalOptions = Common & { project: { id: string; source: SourceRef }; mutation: ProjectOptionalMutation };
export type ProjectOptionalMutationOutcome = VaultMutationOutcome | { ok: true; noOp: true; path: string; revision: string } | { ok: false; reason: SourcePatchFailureReason | 'invalid-provenance' | 'invalid-value' | 'binary-read-unavailable' | 'missing' };

const FIELDS: readonly ProjectOptionalField[] = ['tabBgColor', 'tabTextColor']; const MAX_CHARS = 4096;
function validDirectory(directory: string): boolean { return typeof directory === 'string' && directory.length > 0 && directory.length <= 260 && !directory.startsWith('/') && !/^[A-Za-z]:\//.test(directory) && directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'); }
function validSource(source: unknown, directory: string): source is SourceRef {
  if (typeof source !== 'object' || source === null) return false;
  const s = source as Partial<SourceRef>; if (s.kind !== 'project' || typeof s.path !== 'string' || s.path.length === 0 || s.path.length > 260 || typeof s.revision !== 'string' || s.revision.length === 0 || s.revision.length > 400) return false;
  const path = s.path.replaceAll('\\', '/'); const prefix = `${directory.replaceAll('\\', '/')}/`; if (!path.startsWith(prefix) || path.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  const parts = path.slice(prefix.length).split('/'); return (parts.length === 1 && parts[0]!.toLowerCase().endsWith('.md')) || (parts.length === 2 && parts[1]!.toLowerCase() === 'index.md');
}
function validMutation(mutation: ProjectOptionalMutation): boolean { return FIELDS.includes(mutation.field) && (mutation.kind === 'clear' || (mutation.kind === 'set' && typeof mutation.value === 'string' && mutation.value.length > 0 && mutation.value.length <= MAX_CHARS && !/[\u0000-\u001F\u007F\r\n]/u.test(mutation.value))); }

/** Explicit set/clear for project presentation colors; clear is never inferred from empty values. */
export async function updateProjectOptional(options: UpdateProjectOptionalOptions): Promise<ProjectOptionalMutationOutcome> {
  const raw = (options as unknown as { mutation?: { kind?: unknown; field?: unknown } }).mutation;
  if (!raw || (raw.kind !== 'set' && raw.kind !== 'clear') || typeof raw.field !== 'string' || !FIELDS.includes(raw.field as ProjectOptionalField)) return { ok: false, reason: 'field-not-allowed' };
  const directory = (options.projectsDirectory ?? 'Proxima/projects').replaceAll('\\', '/');
  if (!validDirectory(directory) || typeof options.project !== 'object' || options.project === null || typeof options.project.id !== 'string' || options.project.id.length === 0 || options.project.id.length > 200 || !validSource(options.project.source, directory)) return { ok: false, reason: 'invalid-provenance' };
  if (typeof options.path !== 'string' || options.path.replaceAll('\\', '/') !== options.project.source.path.replaceAll('\\', '/')) return { ok: false, reason: 'invalid-provenance' };
  if (!validMutation(options.mutation)) return { ok: false, reason: 'invalid-value' };
  if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024)); let file;
  try { file = await options.reader.readBinary(options.path, maxBytes); } catch { return { ok: false, reason: 'missing' }; }
  if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  let patch = options.mutation.kind === 'set' ? planProjectScalarPatch(file.bytes, options.mutation.field, options.mutation.value, maxBytes) : planProjectOptionalRemove(file.bytes, options.mutation.field, maxBytes);
  if (!patch.ok && patch.reason === 'target-missing' && options.mutation.kind === 'set') patch = planProjectOptionalInsert(file.bytes, options.mutation.field, options.mutation.value, maxBytes);
  if (!patch.ok && patch.reason === 'target-missing' && options.mutation.kind === 'clear') return { ok: true, noOp: true, path: options.path, revision: file.revision };
  if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path: options.path, bytes: patch.bytes, expectedRevision: options.project.source.revision });
}
