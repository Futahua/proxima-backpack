/**
 * Loads a fixture vault off disk as real bytes.
 *
 * The memory vault it produces is not a mock of the filesystem: it holds exactly the
 * bytes the fixture files hold, so parsing, discovery and identity are exercised
 * against content a creator could have written by hand. What it deliberately does not
 * claim to prove is filesystem behaviour — permissions, external writers, Windows
 * paths — which belongs to the adapter conformance and acceptance layers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import type { RecordKind, SourceRef } from '../src/domain/records.js';

export function fixtureFiles(name: string): Record<string, string> {
  const root = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return files;
}

export function fixtureVault(name: string) {
  return createMemoryVault(fixtureFiles(name));
}

/**
 * Provenance for a record a test constructs by hand.
 *
 * Domain tests care about behaviour, not about where bytes came from, but the type
 * requires an answer — and "this record has no source" is not one, which is the point.
 */
export function sourceRef(kind: RecordKind, id: string): SourceRef {
  return {
    path: `fixture/${kind}s/${id}.md`,
    revision: `${id}@1`,
    kind,
    idOrigin: 'frontmatter',
  };
}
