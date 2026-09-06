import { createExternalDirectoryVault, type ExternalDirectoryHandleLike } from '../adapters/externalDirectoryVault.js';
import { createMemoryVault } from '../adapters/memoryVault.js';
import type { VaultReader } from '../ports/vault.js';
import { FIXTURE_VAULTS } from './generated/fixtureVault.generated.js';

export interface BrowserSource {
  reader: VaultReader;
  mode: 'fixture' | 'injected';
}

/** Fixture remains the default; injected readers/handles are explicit test seams. */
export function createBrowserSource(input: { reader?: VaultReader; directory?: ExternalDirectoryHandleLike } = {}): BrowserSource {
  if (input.reader) return { reader: input.reader, mode: 'injected' };
  if (input.directory) return { reader: createExternalDirectoryVault(input.directory), mode: 'injected' };
  return { reader: createMemoryVault(FIXTURE_VAULTS['vault-basic']), mode: 'fixture' };
}
