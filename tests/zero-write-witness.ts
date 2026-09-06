import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { VaultReader } from '../src/ports/vault.js';

/**
 * Evidence that Proxima did not write, rather than a variable nobody assigned to.
 *
 * The Gate 6M test previously declared `const writerCalls: string[] = []` and then
 * asserted it was empty. Nothing ever appended to it, so the assertion held whatever
 * the code under test did — it would have passed identically if every file in the
 * vault had been rewritten. An assertion that cannot fail is not evidence.
 *
 * This witness makes the claim falsifiable from two directions at once:
 *
 *  - **Capability**: the reader handed to the code under test is a proxy. Reads are
 *    recorded; touching anything outside the read surface — a `writeIfUnchanged`, or
 *    any member the VaultReader contract does not define — is recorded as a
 *    violation and throws, so an attempted write fails the run rather than being
 *    counted after the fact.
 *  - **Effect**: the tree on disk is fingerprinted before and after. Any content or
 *    mtime the test did not itself cause through a declared peer write shows up as
 *    an unexplained change.
 *
 * Both halves are self-checking: `assertObserved` fails if no read was recorded at
 * all, because a witness that saw nothing proves nothing.
 */

/** The complete read surface. Anything else is a write attempt or an escape hatch. */
const READ_SURFACE = new Set(['list', 'read', 'exists', 'walk']);

export interface ZeroWriteWitness {
  reader: VaultReader;
  reads: string[];
  violations: string[];
  /** Fingerprint the tree so later changes can be attributed. */
  snapshot(): Promise<TreeFingerprint>;
  /**
   * Assert the witness actually observed work and recorded no write attempt.
   * Throws when nothing was read, so a silent no-op cannot masquerade as proof.
   */
  assertObserved(): void;
}

export type TreeFingerprint = Map<string, string>;

export function createZeroWriteWitness(reader: VaultReader, root: string): ZeroWriteWitness {
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
    snapshot: () => fingerprint(root),
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

/** Content hash plus size for every file under root, keyed by vault-relative path. */
export async function fingerprint(root: string): Promise<TreeFingerprint> {
  const result: TreeFingerprint = new Map();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const [text, metadata] = await Promise.all([readFile(absolute, 'utf8'), stat(absolute)]);
      result.set(relative(root, absolute).split(sep).join('/'), `${metadata.size}:${hash(text)}`);
    }
  }
  await walk(root);
  return result;
}

/**
 * Paths whose content differs between two fingerprints, in either direction.
 * A caller subtracts the writes it deliberately performed; whatever remains was
 * written by the code under test.
 */
export function changedPaths(before: TreeFingerprint, after: TreeFingerprint): string[] {
  const changed = new Set<string>();
  for (const [path, value] of before) if (after.get(path) !== value) changed.add(path);
  for (const [path, value] of after) if (before.get(path) !== value) changed.add(path);
  return [...changed].sort();
}

function hash(text: string): string {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}
