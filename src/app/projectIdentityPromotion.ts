import type { SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planProjectIdentityPromotion } from './sourcePreservingMarkdown.js';

export interface PromoteProjectIdentityOptions { project: { id: string; source: SourceRef }; reader: VaultReader; coordinator: VaultMutationCoordinator; projectsDirectory?: string; maxBytes?: number; }
export type ProjectIdentityPromotionOutcome = VaultMutationOutcome | { ok: true; noOp: true; path: string; revision: string } | { ok: false; reason: 'invalid-provenance' | 'identity-mismatch' | 'binary-read-unavailable' | 'missing' | 'invalid-value' | 'target-unsupported' | 'target-ambiguous' | 'target-missing' | 'field-not-allowed' | 'no-frontmatter' | 'invalid-utf8' | 'source-too-large' };

function validDirectory(directory: string): boolean { return typeof directory === 'string' && directory.length > 0 && directory.length <= 260 && !directory.startsWith('/') && !/^[A-Za-z]:\//.test(directory) && directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'); }
function validSource(source: unknown, directory: string): source is SourceRef {
  if (typeof source !== 'object' || source === null) return false; const s = source as Partial<SourceRef>;
  if (s.kind !== 'project' || !['filename', 'folder', 'frontmatter'].includes(s.idOrigin as string) || typeof s.path !== 'string' || s.path.length === 0 || s.path.length > 260 || typeof s.revision !== 'string' || s.revision.length === 0 || s.revision.length > 400) return false;
  const path = s.path.replaceAll('\\', '/'); const prefix = `${directory.replaceAll('\\', '/')}/`; if (!path.startsWith(prefix) || path.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  const rest = path.slice(prefix.length); const parts = rest.split('/'); return (parts.length === 1 && parts[0]!.toLowerCase().endsWith('.md')) || (parts.length === 2 && parts[1]!.toLowerCase() === 'index.md');
}

/** Make a legacy project filename/folder identity explicit without moving it. */
export async function promoteProjectIdentity(options: PromoteProjectIdentityOptions): Promise<ProjectIdentityPromotionOutcome> {
  const directory = (options.projectsDirectory ?? 'Proxima/projects').replaceAll('\\', '/');
  if (!validDirectory(directory) || typeof options.project !== 'object' || options.project === null || typeof options.project.id !== 'string' || options.project.id.length === 0 || options.project.id.length > 200 || !validSource(options.project.source, directory)) return { ok: false, reason: 'invalid-provenance' };
  const source = options.project.source; if (source.idOrigin === 'frontmatter') return { ok: true, noOp: true, path: source.path, revision: source.revision };
  const path = source.path.replaceAll('\\', '/'); const rest = path.slice(`${directory}/`.length); const parts = rest.split('/');
  const derived = parts.length === 1 ? parts[0]!.slice(0, -3) : parts[0]!;
  if (options.project.id !== derived) return { ok: false, reason: 'identity-mismatch' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024)); if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  let file; try { file = await options.reader.readBinary(path, maxBytes); } catch { return { ok: false, reason: 'missing' }; } if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  const patch = planProjectIdentityPromotion(file.bytes, options.project.id, maxBytes); if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path, bytes: patch.bytes, expectedRevision: source.revision });
}
