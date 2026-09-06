/**
 * Test-facing view of the zero-write proof.
 *
 * The capability witness lives in `src/app/` so the acceptance harness and the tests
 * share one implementation, and the tree fingerprint lives in `tools/` because it
 * needs `node:fs`, which `src/` deliberately cannot compile against. This module
 * joins the two halves and adds the root-bound `snapshot` convenience the tests use.
 */
import { createZeroWriteWitness as createCapabilityWitness, type ZeroWriteWitness as CapabilityWitness } from '../src/app/zeroWriteWitness.js';
import { changedPaths as changedPathsImpl, fingerprint as fingerprintImpl } from '../tools/tree-fingerprint.mjs';
import type { VaultReader } from '../src/ports/vault.js';

export type TreeFingerprint = Map<string, string>;

export interface ZeroWriteWitness extends CapabilityWitness {
  /** Fingerprint the tree this witness was created against. */
  snapshot(): Promise<TreeFingerprint>;
}

export function createZeroWriteWitness(reader: VaultReader, root: string): ZeroWriteWitness {
  const witness = createCapabilityWitness(reader);
  return { ...witness, assertObserved: () => witness.assertObserved(), snapshot: () => fingerprint(root) };
}

export function fingerprint(root: string): Promise<TreeFingerprint> {
  return fingerprintImpl(root) as Promise<TreeFingerprint>;
}

export function changedPaths(before: TreeFingerprint, after: TreeFingerprint): string[] {
  return changedPathsImpl(before, after) as string[];
}
