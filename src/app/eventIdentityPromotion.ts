import type { SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planProjectIdentityPromotion } from './sourcePreservingMarkdown.js';

export interface PromoteEventIdentityOptions { event: { id: string; source: SourceRef }; reader: VaultReader; coordinator: VaultMutationCoordinator; eventsDirectory?: string; maxBytes?: number; }
export type EventIdentityPromotionOutcome = VaultMutationOutcome | { ok: true; noOp: true; path: string; revision: string } | { ok: false; reason: 'invalid-provenance' | 'identity-mismatch' | 'binary-read-unavailable' | 'missing' | 'invalid-value' | 'target-unsupported' | 'target-ambiguous' | 'target-missing' | 'field-not-allowed' | 'no-frontmatter' | 'invalid-utf8' | 'source-too-large' };
function validDirectory(directory: string): boolean { return typeof directory === 'string' && directory.length > 0 && directory.length <= 260 && !directory.startsWith('/') && !/^[A-Za-z]:\//.test(directory) && directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'); }
function validSource(source: unknown, directory: string): source is SourceRef { if (typeof source !== 'object' || source === null) return false; const s = source as Partial<SourceRef>; if (s.kind !== 'event' || !['filename', 'frontmatter'].includes(s.idOrigin as string) || typeof s.path !== 'string' || s.path.length === 0 || s.path.length > 260 || typeof s.revision !== 'string' || s.revision.length === 0 || s.revision.length > 400) return false; const path = s.path.replaceAll('\\', '/'); const prefix = `${directory.replaceAll('\\', '/')}/`; if (!path.startsWith(prefix) || path.split('/').some((part) => !part || part === '.' || part === '..')) return false; const rest = path.slice(prefix.length); return !rest.includes('/') && rest.toLowerCase().endsWith('.md'); }

/** Make a legacy filename-derived event identity explicit without changing its path. */
export async function promoteEventIdentity(options: PromoteEventIdentityOptions): Promise<EventIdentityPromotionOutcome> {
  const directory = (options.eventsDirectory ?? 'Proxima/events').replaceAll('\\', '/'); if (!validDirectory(directory) || typeof options.event !== 'object' || options.event === null || typeof options.event.id !== 'string' || options.event.id.length === 0 || options.event.id.length > 200 || !validSource(options.event.source, directory)) return { ok: false, reason: 'invalid-provenance' };
  const source = options.event.source; if (source.idOrigin === 'frontmatter') return { ok: true, noOp: true, path: source.path, revision: source.revision };
  const path = source.path.replaceAll('\\', '/'); const stem = path.slice(`${directory}/`.length, -3); if (options.event.id !== stem) return { ok: false, reason: 'identity-mismatch' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024)); if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' }; let file; try { file = await options.reader.readBinary(path, maxBytes); } catch { return { ok: false, reason: 'missing' }; } if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  const patch = planProjectIdentityPromotion(file.bytes, options.event.id, maxBytes); if (!patch.ok) return patch; return options.coordinator.execute({ kind: 'update', path, bytes: patch.bytes, expectedRevision: source.revision });
}
