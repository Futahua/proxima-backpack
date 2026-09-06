import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * The effect half of the zero-write proof.
 *
 * The capability witness in `src/app/zeroWriteWitness.ts` can only police the object
 * it wraps; a JavaScript Proxy cannot stop code that already holds some other handle
 * on the disk. Fingerprinting the tree before and after catches that class: whatever
 * changed, changed, regardless of which reference did it.
 *
 * Shared by the acceptance harness and the tests so there is one implementation of
 * "what changed", not two that can disagree.
 */

/** Content hash plus size for every file under root, keyed by root-relative path. */
export async function fingerprint(root) {
  const result = new Map();
  async function walk(directory) {
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
 * Paths differing between two fingerprints, in either direction.
 *
 * Both directions matter: a file that vanished is as much a change as one that
 * appeared, and a rename is both at once. A caller subtracts the operations it
 * declared; whatever remains was caused by the code under test.
 */
export function changedPaths(before, after) {
  const changed = new Set();
  for (const [path, value] of before) if (after.get(path) !== value) changed.add(path);
  for (const [path, value] of after) if (before.get(path) !== value) changed.add(path);
  return [...changed].sort();
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}
