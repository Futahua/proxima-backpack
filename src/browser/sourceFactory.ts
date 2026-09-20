import { createExternalDirectoryVault, type ExternalDirectoryHandleLike } from '../adapters/externalDirectoryVault.js';
import { createMemoryVault } from '../adapters/memoryVault.js';
import type { VaultReader } from '../ports/vault.js';
import { bootstrapRestoredHandle, type BootstrapInspection, type ReadPermissionProvider, type RestoredHandleStore } from '../app/handleBootstrap.js';

export interface BrowserSource {
  reader: VaultReader;
  mode: 'fixture' | 'injected';
}

export interface BrowserSourceWithBootstrap extends BrowserSource {
  bootstrap: BootstrapInspection;
}

/** The default reader is an empty artifact seam: standalone Proxima never imports a vault. */
export function createBrowserSource(input: { reader?: VaultReader; directory?: ExternalDirectoryHandleLike } = {}): BrowserSource {
  if (input.reader) return { reader: input.reader, mode: 'injected' };
  if (input.directory) return { reader: createExternalDirectoryVault(input.directory), mode: 'injected' };
  return { reader: createMemoryVault({}), mode: 'fixture' };
}

/** Restore a handle only for explicit adapter tests; the standalone browser boot does not call this seam. */
export async function createBrowserSourceFromRestored(store: RestoredHandleStore, permissions: ReadPermissionProvider): Promise<BrowserSourceWithBootstrap> {
  const restored = await bootstrapRestoredHandle(store, permissions);
  if (restored.reader) return { reader: restored.reader, mode: 'injected', bootstrap: restored.inspection };
  return { ...createBrowserSource(), bootstrap: restored.inspection };
}
