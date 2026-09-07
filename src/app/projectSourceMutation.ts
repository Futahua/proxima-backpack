import type { SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planProjectScalarPatch, type ProjectScalarField, type SourcePatchFailureReason } from './sourcePreservingMarkdown.js';

export type ProjectScalarMutation =
  | { field: 'name'; value: string }
  | { field: 'status'; value: 'active' | 'archived' }
  | { field: 'projectType'; value: 'task' | 'schedule' }
  | { field: 'tabBgColor'; value: string }
  | { field: 'tabTextColor'; value: string };

interface ProjectMutationCommon { path: string; expectedRevision: string; reader: VaultReader; coordinator: VaultMutationCoordinator; projectsDirectory?: string; maxBytes?: number; }
export type UpdateProjectScalarOptions = ProjectMutationCommon & { project: { id: string; source: SourceRef }; mutation: ProjectScalarMutation };
export type ProjectScalarMutationOutcome = VaultMutationOutcome | { ok: false; reason: SourcePatchFailureReason | 'invalid-provenance' | 'invalid-value' | 'binary-read-unavailable' | 'missing' };

const PROJECT_FIELDS: readonly ProjectScalarMutation['field'][] = ['name', 'status', 'projectType', 'tabBgColor', 'tabTextColor'];
const MAX_CHARS = 4096;

function validDirectory(directory: string): boolean {
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 260 || directory.startsWith('/') || /^[A-Za-z]:\//.test(directory)) return false;
  return directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function validProjectSource(source: unknown, directory: string): source is SourceRef {
  if (typeof source !== 'object' || source === null) return false;
  const candidate = source as Partial<SourceRef>; if (candidate.kind !== 'project' || typeof candidate.path !== 'string' || candidate.path.length === 0 || candidate.path.length > 260 || typeof candidate.revision !== 'string' || candidate.revision.length === 0 || candidate.revision.length > 400) return false;
  const path = candidate.path.replaceAll('\\', '/'); const prefix = `${directory.replaceAll('\\', '/')}/`; if (!path.startsWith(prefix) || path.split('/').some((part) => part === '.' || part === '..' || part.length === 0)) return false;
  const rest = path.slice(prefix.length); const parts = rest.split('/');
  return (parts.length === 1 && parts[0]!.toLowerCase().endsWith('.md')) || (parts.length === 2 && parts[1]!.toLowerCase() === 'index.md');
}

function validValue(mutation: ProjectScalarMutation): boolean {
  if (mutation.field === 'status') return mutation.value === 'active' || mutation.value === 'archived';
  if (mutation.field === 'projectType') return mutation.value === 'task' || mutation.value === 'schedule';
  return typeof mutation.value === 'string' && mutation.value.length > 0 && mutation.value.length <= MAX_CHARS && !/[\u0000-\u001F\u007F\r\n]/u.test(mutation.value);
}

/** Update one existing project scalar through the conditional mutation coordinator. */
export async function updateProjectScalar(options: UpdateProjectScalarOptions): Promise<ProjectScalarMutationOutcome> {
  const raw = (options as unknown as { mutation?: { field?: unknown } }).mutation;
  if (!raw || typeof raw.field !== 'string' || !PROJECT_FIELDS.includes(raw.field as ProjectScalarMutation['field'])) return { ok: false, reason: 'field-not-allowed' };
  const directory = (options.projectsDirectory ?? 'Proxima/projects').replaceAll('\\', '/');
  if (!validDirectory(directory) || typeof options.project !== 'object' || options.project === null || typeof options.project.id !== 'string' || options.project.id.length === 0 || options.project.id.length > 200 || !validProjectSource(options.project.source, directory)) return { ok: false, reason: 'invalid-provenance' };
  if (typeof options.path !== 'string' || options.path.replaceAll('\\', '/') !== options.project.source.path.replaceAll('\\', '/')) return { ok: false, reason: 'invalid-provenance' };
  if (!validValue(options.mutation)) return { ok: false, reason: 'invalid-value' };
  if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024)); let file;
  try { file = await options.reader.readBinary(options.path, maxBytes); } catch { return { ok: false, reason: 'missing' }; }
  if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  const patch = planProjectScalarPatch(file.bytes, options.mutation.field as ProjectScalarField, options.mutation.value, maxBytes);
  if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path: options.path, bytes: patch.bytes, expectedRevision: options.expectedRevision });
}
