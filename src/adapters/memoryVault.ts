/**
 * An in-memory VaultReader over a plain path -> text map.
 *
 * This is not a mock of the filesystem: it holds the same real fixture bytes the
 * on-disk fixtures hold, so domain and parsing tests exercise real content. The
 * things it cannot test — permissions, external writers, Windows paths — belong
 * to the browser and acceptance layers instead.
 */
import type { VaultEntry, VaultFile, VaultReader } from '../ports/vault.js';

export function createMemoryVault(files: Record<string, string>): VaultReader & {
  set(path: string, text: string): void;
  delete(path: string): void;
} {
  const store = new Map<string, string>(Object.entries(files));
  const revisions = new Map<string, number>();
  for (const path of store.keys()) revisions.set(path, 1);

  const normalise = (p: string) => p.split(String.fromCharCode(92)).join('/').replace(/^[/]+|[/]+$/g, '');

  const fileOf = (path: string): VaultFile => {
    const text = store.get(path);
    if (text === undefined) throw new Error(`No such file in vault: ${path}`);
    return {
      path,
      text,
      revision: `${path}@${revisions.get(path) ?? 1}`,
      size: text.length,
      modifiedAt: new Date(0).toISOString(),
    };
  };

  return {
    async list(directory) {
      const prefix = normalise(directory);
      const base = prefix ? `${prefix}/` : '';
      const seen = new Map<string, VaultEntry>();
      for (const path of store.keys()) {
        if (!path.startsWith(base)) continue;
        const rest = path.slice(base.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(path, { path, kind: 'file' });
        else {
          const dir = `${base}${rest.slice(0, slash)}`;
          seen.set(dir, { path: dir, kind: 'directory' });
        }
      }
      return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      return fileOf(normalise(path));
    },
    async exists(path) {
      return store.has(normalise(path));
    },
    async walk(directory) {
      const prefix = normalise(directory);
      const base = prefix ? `${prefix}/` : '';
      return [...store.keys()].filter((p) => p.startsWith(base)).sort();
    },
    set(path, text) {
      const key = normalise(path);
      store.set(key, text);
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
    },
    delete(path) {
      store.delete(normalise(path));
    },
  };
}
