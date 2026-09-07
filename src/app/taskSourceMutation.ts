import type { VaultReader } from '../ports/vault.js';
import type { VaultMutationCoordinator, VaultMutationOutcome } from './vaultMutation.js';
import { planTaskStatusPatch, type SourcePatchFailureReason } from './sourcePreservingMarkdown.js';

export interface UpdateTaskStatusOptions {
  path: string;
  expectedRevision: string;
  status: string;
  reader: VaultReader;
  coordinator: VaultMutationCoordinator;
  maxBytes?: number;
}

export type TaskStatusMutationOutcome = VaultMutationOutcome | { ok: false; reason: SourcePatchFailureReason | 'binary-read-unavailable' | 'missing' };

/** Read exact source bytes, patch only the existing status scalar, then CAS them through the coordinator. */
export async function updateTaskStatus(options: UpdateTaskStatusOptions): Promise<TaskStatusMutationOutcome> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  if (typeof options.reader.readBinary !== 'function') return { ok: false, reason: 'binary-read-unavailable' };
  let file;
  try { file = await options.reader.readBinary(options.path, maxBytes); }
  catch { return { ok: false, reason: 'missing' }; }
  if (file.bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  const patch = planTaskStatusPatch(file.bytes, options.status, maxBytes);
  if (!patch.ok) return patch;
  return options.coordinator.execute({ kind: 'update', path: options.path, bytes: patch.bytes, expectedRevision: options.expectedRevision });
}
