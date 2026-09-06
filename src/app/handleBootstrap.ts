import { createExternalDirectoryVault, type ExternalDirectoryHandleLike } from '../adapters/externalDirectoryVault.js';
import type { VaultReader } from '../ports/vault.js';

export type RestoredPermission = 'granted' | 'prompt' | 'denied';
export type BootstrapStatus = 'no-restored-handle' | 'ready' | 'permission-required' | 'permission-denied' | 'permission-check-failed' | 'invalid-handle' | 'restore-failed';

export interface RestoredHandleStore {
  restore(): Promise<ExternalDirectoryHandleLike | null>;
}

export interface ReadPermissionProvider {
  queryPermission(options: { mode: 'read' }): Promise<RestoredPermission>;
}

export interface BootstrapInspection {
  sourceMode: 'fixture' | 'restored';
  restoredHandlePresent: boolean;
  handleKind: 'directory' | null;
  handleName: string | null;
  permission: RestoredPermission | 'unavailable' | null;
  bootstrapStatus: BootstrapStatus;
  problemCodes: string[];
}

export interface RestoredBootstrapResult {
  reader: VaultReader | null;
  inspection: BootstrapInspection;
}

const MAX_TEXT = 120;

function safeName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0 || /^(?:[A-Za-z]:|[\\/])/.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  return name.slice(0, MAX_TEXT);
}

function inspection(status: BootstrapStatus, handle: ExternalDirectoryHandleLike | null, permission: BootstrapInspection['permission'], problemCodes: string[] = []): BootstrapInspection {
  return {
    sourceMode: status === 'ready' ? 'restored' : 'fixture',
    restoredHandlePresent: handle !== null,
    handleKind: handle?.kind === 'directory' ? 'directory' : null,
    handleName: safeName(handle?.name),
    permission,
    bootstrapStatus: status,
    problemCodes: [...new Set(problemCodes.map((code) => code.slice(0, 100)))].slice(0, 20),
  };
}

/**
 * Resolve a persisted handle without acquiring permission. The returned value is
 * either a VaultReader or null; the raw handle is never returned or stored.
 */
export async function bootstrapRestoredHandle(store: RestoredHandleStore, permissions: ReadPermissionProvider): Promise<RestoredBootstrapResult> {
  let handle: ExternalDirectoryHandleLike | null;
  try {
    handle = await store.restore();
  } catch {
    return { reader: null, inspection: inspection('restore-failed', null, 'unavailable', ['restore-failed']) };
  }
  if (handle === null) return { reader: null, inspection: inspection('no-restored-handle', null, null) };
  if (handle.kind !== 'directory' || typeof handle.entries !== 'function') return { reader: null, inspection: inspection('invalid-handle', handle, 'unavailable', ['invalid-handle']) };
  let permission: RestoredPermission;
  try {
    permission = await permissions.queryPermission({ mode: 'read' });
  } catch {
    return { reader: null, inspection: inspection('permission-check-failed', handle, 'unavailable', ['permission-check-failed']) };
  }
  if (permission === 'prompt') return { reader: null, inspection: inspection('permission-required', handle, permission, ['permission-required']) };
  if (permission === 'denied') return { reader: null, inspection: inspection('permission-denied', handle, permission, ['permission-denied']) };
  try {
    return { reader: createExternalDirectoryVault(handle), inspection: inspection('ready', handle, permission) };
  } catch {
    return { reader: null, inspection: inspection('invalid-handle', handle, permission, ['invalid-handle']) };
  }
}
