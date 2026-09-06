import { createOpfsVault, type OpfsDirectoryHandleLike, type OpfsVaultOptions } from './opfsVault.js';
import type { VaultReader } from '../ports/vault.js';

/** Structural, read-only subset compatible with FileSystemDirectoryHandle. */
export interface ExternalDirectoryHandleLike extends OpfsDirectoryHandleLike {}

/**
 * Adapt an injected directory handle to Proxima's reader contract.
 * The handle is consumed here and never enters domain, dispatcher, or inspection state.
 */
export function createExternalDirectoryVault(root: ExternalDirectoryHandleLike, options?: OpfsVaultOptions): VaultReader {
  return createOpfsVault(root, options);
}
