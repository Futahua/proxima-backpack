import type { SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planTaskOptionalInsert, planTaskOptionalRemove, planTaskProjectPatch, planTaskScalarPatch, type SourcePatchFailureReason } from './sourcePreservingMarkdown.js';
import { readOptionalDate, type FieldIssue } from '../domain/validation.js';

export type EventOptionalMutation =
  | { kind: 'set-project'; value: string }
  | { kind: 'unlink-project' }
  | { kind: 'set-start'; value: string }
  | { kind: 'clear-start' }
  | { kind: 'set-deadline'; value: string }
  | { kind: 'use-start-as-deadline' };
interface Common { path: string; reader: VaultReader; coordinator: VaultMutationCoordinator; eventsDirectory?: string; maxBytes?: number; }
export type UpdateEventOptionalOptions = Common & { event: { id: string; source: SourceRef }; mutation: EventOptionalMutation };
export type EventOptionalMutationOutcome = VaultMutationOutcome | { ok: true; noOp: true; path: string; revision: string } | { ok: false; reason: SourcePatchFailureReason | 'invalid-provenance' | 'invalid-value' | 'binary-read-unavailable' | 'missing' };

function validDirectory(directory: string): boolean { return typeof directory === 'string' && directory.length > 0 && directory.length <= 260 && !directory.startsWith('/') && !/^[A-Za-z]:\//.test(directory) && directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'); }
function validSource(source: unknown, directory: string): source is SourceRef { if (typeof source !== 'object' || source === null) return false; const s = source as Partial<SourceRef>; if (s.kind !== 'event' || typeof s.path !== 'string' || s.path.length === 0 || s.path.length > 260 || typeof s.revision !== 'string' || s.revision.length === 0 || s.revision.length > 400) return false; const path = s.path.replaceAll('\\', '/'); const prefix = `${directory.replaceAll('\\', '/')}/`; if (!path.startsWith(prefix) || path.split('/').some((part) => !part || part === '.' || part === '..')) return false; const rest = path.slice(prefix.length); return !rest.includes('/') && rest.toLowerCase().endsWith('.md'); }
function validMutation(mutation: EventOptionalMutation): boolean { if (mutation.kind === 'unlink-project' || mutation.kind === 'clear-start' || mutation.kind === 'use-start-as-deadline') return true; if (typeof mutation.value !== 'string' || mutation.value.length === 0 || mutation.value.length > 4096 || /[\u0000-\u001F\u007F\r\n]/u.test(mutation.value)) return false; if (mutation.kind === 'set-start' || mutation.kind === 'set-deadline') { const field = mutation.kind === 'set-start' ? 'startDate' : 'deadline'; const issues: FieldIssue[] = []; return readOptionalDate(mutation.value, field, issues) !== null && issues.length === 0; } return true; }

/** Apply one explicit event optional semantic operation through source-preserving CAS. */
export async function updateEventOptional(options: UpdateEventOptionalOptions): Promise<EventOptionalMutationOutcome> {
  const raw = (options as unknown as { mutation?: { kind?: unknown } }).mutation; const allowed = ['set-project', 'unlink-project', 'set-start', 'clear-start', 'set-deadline', 'use-start-as-deadline'];
  if (!raw || typeof raw.kind !== 'string' || !allowed.includes(raw.kind)) return { ok: false, reason: 'field-not-allowed' };
  const directory = (options.eventsDirectory ?? 'Proxima/events').replaceAll('\\', '/'); if (!validDirectory(directory) || typeof options.event !== 'object' || options.event === null || typeof options.event.id !== 'string' || options.event.id.length === 0 || options.event.id.length > 200 || !validSource(options.event.source, directory)) return { ok: false, reason: 'invalid-provenance' };
  if (typeof options.path !== 'string' || options.path.replaceAll('\\', '/') !== options.event.source.path.replaceAll('\\', '/')) return { ok: false, reason: 'invalid-provenance' }; if (!validMutation(options.mutation)) return { ok: false, reason: 'invalid-value' }; if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024)); let file; try { file = await options.reader.readBinary(options.path, maxBytes); } catch { return { ok: false, reason: 'missing' }; } if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  let patch;
  switch (options.mutation.kind) {
    case 'set-project': patch = planTaskProjectPatch(file.bytes, options.mutation.value, maxBytes); if (!patch.ok && patch.reason === 'target-missing') patch = planTaskOptionalInsert(file.bytes, 'project', options.mutation.value, maxBytes); break;
    case 'unlink-project': patch = planTaskOptionalRemove(file.bytes, 'project', maxBytes); break;
    case 'set-start': patch = planTaskScalarPatch(file.bytes, 'startDate', options.mutation.value, maxBytes); if (!patch.ok && patch.reason === 'target-missing') patch = planTaskOptionalInsert(file.bytes, 'startDate', options.mutation.value, maxBytes); break;
    case 'clear-start': patch = planTaskOptionalRemove(file.bytes, 'startDate', maxBytes); break;
    case 'set-deadline': patch = planTaskScalarPatch(file.bytes, 'deadline', options.mutation.value, maxBytes); if (!patch.ok && patch.reason === 'target-missing') patch = planTaskOptionalInsert(file.bytes, 'deadline', options.mutation.value, maxBytes); break;
    case 'use-start-as-deadline': patch = planTaskOptionalRemove(file.bytes, 'deadline', maxBytes); break;
  }
  if (!patch!.ok && patch!.reason === 'target-missing' && (options.mutation.kind === 'unlink-project' || options.mutation.kind === 'clear-start' || options.mutation.kind === 'use-start-as-deadline')) return { ok: true, noOp: true, path: options.path, revision: file.revision };
  if (!patch!.ok) return patch!;
  return options.coordinator.execute({ kind: 'update', path: options.path, bytes: patch!.bytes, expectedRevision: options.event.source.revision });
}
