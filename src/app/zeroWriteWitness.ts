import type { VaultReader } from '../ports/vault.js';

/**
 * The capability half of the zero-write proof.
 *
 * Proxima is handed this proxy instead of the real reader, so the claim "Proxima did
 * not write" is enforced at the only surface through which it could: reads are
 * recorded, and any member outside the read surface throws rather than being tallied
 * after the fact. An attempted write fails the run.
 *
 * Pure on purpose — no filesystem, so the acceptance harness and the browser-facing
 * code can share it. The complementary effect half, which fingerprints a real tree
 * and catches anything that bypassed this object entirely, needs `node:fs` and so
 * lives in `tools/tree-fingerprint.mjs`.
 *
 * See `docs/DECISIONS.md#d39`: this exists because the invariant it replaces was an
 * assertion that could not fail.
 */

/** The complete read surface. Anything else is a write attempt or an escape hatch. */
export const READ_SURFACE: ReadonlySet<string> = new Set(['list', 'read', 'exists', 'walk']);

export interface ZeroWriteWitness {
  /** Hand this to the code under test, never the underlying reader. */
  reader: VaultReader;
  /** `operation:argument` for every read that went through the proxy. */
  reads: string[];
  /** Every access that left the read surface. Non-empty means the run is void. */
  violations: string[];
  /**
   * Throw unless the witness observed real reads and recorded no violation.
   *
   * The liveness half matters as much as the violation half: a witness that saw
   * nothing was never wired to the code under test, and certifying that would repeat
   * exactly the defect this replaced.
   */
  assertObserved(): void;
}

export function createZeroWriteWitness(reader: VaultReader): ZeroWriteWitness {
  const reads: string[] = [];
  const violations: string[] = [];

  const proxied = new Proxy(reader as unknown as Record<string, unknown>, {
    get(target, property, receiver) {
      const name = String(property);
      // Symbols and promise plumbing are structural, not vault access.
      if (typeof property === 'symbol' || name === 'then' || name === 'constructor') {
        return Reflect.get(target, property, receiver);
      }
      if (!READ_SURFACE.has(name)) {
        violations.push(name);
        return () => {
          throw new Error(`zero-write violation: ${name} is not part of the read surface`);
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        reads.push(`${name}:${String(args[0] ?? '')}`);
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
    set(_target, property) {
      violations.push(`set:${String(property)}`);
      throw new Error(`zero-write violation: assignment to ${String(property)}`);
    },
    deleteProperty(_target, property) {
      violations.push(`delete:${String(property)}`);
      throw new Error(`zero-write violation: deletion of ${String(property)}`);
    },
  }) as unknown as VaultReader;

  return {
    reader: proxied,
    reads,
    violations,
    assertObserved() {
      if (violations.length > 0) {
        throw new Error(`zero-write violations recorded: ${violations.join(', ')}`);
      }
      if (reads.length === 0) {
        throw new Error('zero-write witness recorded no reads; the instrument was not wired to the code under test');
      }
    },
  };
}
