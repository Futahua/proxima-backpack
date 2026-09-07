import type { SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planTaskProjectPatch, planTaskScalarPatch, type SourcePatchFailureReason } from './sourcePreservingMarkdown.js';
import { readOptionalDate, type FieldIssue } from '../domain/validation.js';

export type EventScalarMutation =
  | { field: 'name'; value: string }
  | { field: 'project'; value: string }
  | { field: 'startDate'; value: string }
  | { field: 'deadline'; value: string }
  | { field: 'isCompleted'; value: boolean };
interface Common { path: string; reader: VaultReader; coordinator: VaultMutationCoordinator; eventsDirectory?: string; maxBytes?: number; }
export type UpdateEventScalarOptions = Common & { event: { id: string; source: SourceRef }; mutation: EventScalarMutation };
export type EventScalarMutationOutcome = VaultMutationOutcome | { ok: false; reason: SourcePatchFailureReason | 'invalid-provenance' | 'invalid-value' | 'binary-read-unavailable' | 'missing' };
const FIELDS: readonly EventScalarMutation['field'][] = ['name', 'project', 'startDate', 'deadline', 'isCompleted'];
function validDirectory(directory: string): boolean { return typeof directory === 'string' && directory.length > 0 && directory.length <= 260 && !directory.startsWith('/') && !/^[A-Za-z]:\//.test(directory) && directory.replaceAll('\\', '/').split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'); }
function validSource(source: unknown, directory: string): source is SourceRef { if (typeof source !== 'object' || source === null) return false; const s = source as Partial<SourceRef>; if (s.kind !== 'event' || typeof s.path !== 'string' || s.path.length === 0 || s.path.length > 260 || typeof s.revision !== 'string' || s.revision.length === 0 || s.revision.length > 400) return false; const path = s.path.replaceAll('\\', '/'); const prefix = `${directory.replaceAll('\\', '/')}/`; if (!path.startsWith(prefix) || path.split('/').some((part) => !part || part === '.' || part === '..')) return false; const rest = path.slice(prefix.length); return !rest.includes('/') && rest.toLowerCase().endsWith('.md'); }
function validValue(mutation: EventScalarMutation): boolean { if (mutation.field === 'isCompleted') return typeof mutation.value === 'boolean'; if (typeof mutation.value !== 'string' || mutation.value.length === 0 || mutation.value.length > 4096 || /[\u0000-\u001F\u007F\r\n]/u.test(mutation.value)) return false; if (mutation.field === 'startDate' || mutation.field === 'deadline') { const issues: FieldIssue[] = []; return readOptionalDate(mutation.value, mutation.field, issues) !== null && issues.length === 0; } return true; }

/** Apply one closed event scalar mutation using exact source spans and observed CAS. */
export async function updateEventScalar(options: UpdateEventScalarOptions): Promise<EventScalarMutationOutcome> {
  const raw = (options as unknown as { mutation?: { field?: unknown } }).mutation; if (!raw || typeof raw.field !== 'string' || !FIELDS.includes(raw.field as EventScalarMutation['field'])) return { ok: false, reason: 'field-not-allowed' };
  const directory = (options.eventsDirectory ?? 'Proxima/events').replaceAll('\\', '/'); if (!validDirectory(directory) || typeof options.event !== 'object' || options.event === null || typeof options.event.id !== 'string' || options.event.id.length === 0 || options.event.id.length > 200 || !validSource(options.event.source, directory)) return { ok: false, reason: 'invalid-provenance' };
  if (typeof options.path !== 'string' || options.path.replaceAll('\\', '/') !== options.event.source.path.replaceAll('\\', '/')) return { ok: false, reason: 'invalid-provenance' };
  if (!validValue(options.mutation)) return { ok: false, reason: 'invalid-value' }; if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024)); let file; try { file = await options.reader.readBinary(options.path, maxBytes); } catch { return { ok: false, reason: 'missing' }; } if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  const patch = options.mutation.field === 'project' ? planTaskProjectPatch(file.bytes, options.mutation.value, maxBytes) : planTaskScalarPatch(file.bytes, options.mutation.field, options.mutation.value, maxBytes); if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path: options.path, bytes: patch.bytes, expectedRevision: options.event.source.revision });
}
