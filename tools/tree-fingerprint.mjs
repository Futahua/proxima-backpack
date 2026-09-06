import { lstat, readdir, readFile } from 'node:fs/promises';
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

/**
 * The regions whose bytes are worth hashing: the record directories Proxima reads.
 * Everything else in a vault — attachments, plugin folders, node_modules — is
 * fingerprinted by size and mtime instead.
 *
 * A real vault is around a gigabyte and several thousand files, most of them
 * binaries. Reading all of it as UTF-8 to hash it is slow, memory-hostile and
 * mangles the binaries on the way through, while adding nothing: the point of the
 * whole-tree sweep is to notice that a file moved, and size plus mtime notices that.
 * The directories Proxima actually parses still get content hashes, because there a
 * same-size same-timestamp edit is exactly the change worth catching.
 */
const CONTENT_HASHED_ROOTS = ['Proxima', '-Hide/Proxima'];

/**
 * Fingerprint a tree.
 *
 * Files under a content-hashed root carry `size:hash`; everything else carries
 * `size:mtime`. Both change when the file changes, so `changedPaths` works the same
 * either way — only the cost and the sensitivity differ.
 */
export async function fingerprint(root, options = {}) {
  const contentRoots = options.contentRoots ?? CONTENT_HASHED_ROOTS;
  const result = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(absolute);
        continue;
      }
      const relativePath = relative(root, absolute).split(sep).join('/');

      // lstat, never stat: a real vault contains symlinks, and some of them dangle.
      // Following one either crashes the sweep on a broken link or fingerprints a
      // tree outside the root as though it were inside. The link itself is what
      // lives here, so the link itself is what gets recorded.
      let metadata;
      try {
        metadata = await lstat(absolute);
      } catch (error) {
        // An entry that readdir listed but lstat cannot resolve is a fact about the
        // tree, not a reason to abandon the sweep. Record it so it still counts as
        // a change if it appears or disappears.
        result.set(relativePath, `unstattable:${error?.code ?? 'unknown'}`);
        continue;
      }

      if (metadata.isSymbolicLink()) {
        result.set(relativePath, `symlink:${metadata.size}:${metadata.mtimeMs}`);
        continue;
      }

      if (contentRoots.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
        try {
          const text = await readFile(absolute, 'utf8');
          result.set(relativePath, `${metadata.size}:${hash(text)}`);
        } catch (error) {
          result.set(relativePath, `unreadable:${metadata.size}:${error?.code ?? 'unknown'}`);
        }
      } else {
        result.set(relativePath, `${metadata.size}:${metadata.mtimeMs}`);
      }
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
