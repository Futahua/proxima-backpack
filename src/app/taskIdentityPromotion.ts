import type { SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planTaskIdentityPromotion } from './sourcePreservingMarkdown.js';

export interface PromoteTaskIdentityOptions { task: { id: string; source: SourceRef }; reader: VaultReader; coordinator: VaultMutationCoordinator; tasksDirectory?: string; maxBytes?: number; }
export type TaskIdentityPromotionOutcome = VaultMutationOutcome | { ok: true; noOp: true; path: string; revision: string } | { ok: false; reason: 'invalid-provenance' | 'identity-mismatch' | 'binary-read-unavailable' | 'missing' | 'invalid-value' | 'target-unsupported' | 'target-ambiguous' | 'target-missing' | 'field-not-allowed' | 'no-frontmatter' | 'invalid-utf8' | 'source-too-large' };

function validPath(source: unknown, directory: string): source is SourceRef {
  if (typeof source !== 'object' || source === null) return false;
  const candidate = source as Partial<SourceRef>; if (candidate.kind !== 'task' || (candidate.idOrigin !== 'filename' && candidate.idOrigin !== 'frontmatter') || typeof candidate.path !== 'string' || candidate.path.length === 0 || candidate.path.length > 260 || typeof candidate.revision !== 'string' || candidate.revision.length === 0 || candidate.revision.length > 400) return false;
  const path = candidate.path.replaceAll('\\', '/'); const prefix = `${directory.replaceAll('\\', '/')}/`;
  if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/') || !path.toLowerCase().endsWith('.md')) return false;
  return path.length > prefix.length + 3 && !path.split('/').some((part) => part === '.' || part === '..' || part.length === 0);
}

function validDirectory(directory: string): boolean {
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 260 || directory.startsWith('/') || /^[A-Za-z]:\//.test(directory)) return false;
  return directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** Make a legacy filename-derived task's current identity explicit, without moving it. */
export async function promoteTaskIdentity(options: PromoteTaskIdentityOptions): Promise<TaskIdentityPromotionOutcome> {
  const directory = (options.tasksDirectory ?? 'Proxima/tasks').replaceAll('\\', '/');
  if (!validDirectory(directory) || typeof options.task !== 'object' || options.task === null || typeof options.task.id !== 'string' || options.task.id.length === 0 || options.task.id.length > 200 || !validPath(options.task.source, directory)) return { ok: false, reason: 'invalid-provenance' };
  if (options.task.source.idOrigin !== 'filename') return { ok: true, noOp: true, path: options.task.source.path, revision: options.task.source.revision };
  const path = options.task.source.path.replaceAll('\\', '/'); const stem = path.slice(`${directory}/`.length, -3);
  if (options.task.id !== stem) return { ok: false, reason: 'identity-mismatch' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  let file; try { file = await options.reader.readBinary(path, maxBytes); } catch { return { ok: false, reason: 'missing' }; }
  if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  const patch = planTaskIdentityPromotion(file.bytes, options.task.id, maxBytes); if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path, bytes: patch.bytes, expectedRevision: options.task.source.revision });
}
