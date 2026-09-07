/**
 * An in-memory VaultReader over a plain path -> text map.
 *
 * This is not a mock of the filesystem: it holds the same real fixture bytes the
 * on-disk fixtures hold, so domain and parsing tests exercise real content. The
 * things it cannot test — permissions, external writers, Windows paths — belong
 * to the browser and acceptance layers instead.
 */
import type { VaultEntry, VaultFile, VaultReader, VaultWriter, VaultMutationResult } from '../ports/vault.js';

export function createMemoryVault(files: Record<string, string>): VaultReader & VaultWriter & {
  set(path: string, text: string): void;
  delete(path: string): void;
} {
  const normalise = (p: string) => p.split(String.fromCharCode(92)).join('/').replace(/^[/]+|[/]+$/g, '');
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([path, text]) => [normalise(path), new TextEncoder().encode(text)]));
  const revisions = new Map<string, number>();
  for (const path of store.keys()) revisions.set(path, 1);

  const fileOf = (path: string): VaultFile => {
    const bytes = store.get(path);
    if (bytes === undefined) throw new Error(`No such file in vault: ${path}`);
    const text = new TextDecoder().decode(bytes);
    return {
      path,
      text,
      revision: `${path}@${revisions.get(path) ?? 1}`,
      size: bytes.byteLength,
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
    async read(path, maxChars) {
      const file = fileOf(normalise(path));
      if (maxChars !== undefined && file.text.length > maxChars) throw new Error('memory vault text size limit exceeded');
      return file;
    },
    async exists(path) {
      const key = normalise(path);
      // A directory exists when something lives under it; the store holds files only.
      return store.has(key) || [...store.keys()].some((candidate) => candidate.startsWith(`${key}/`));
    },
    async presence(directory) {
      // In-memory: absence is knowable exactly, so this never answers 'unknown'.
      const key = normalise(directory);
      return store.has(key) || [...store.keys()].some((candidate) => candidate.startsWith(`${key}/`))
        ? 'present'
        : 'missing';
    },
    async walk(directory) {
      const prefix = normalise(directory);
      const base = prefix ? `${prefix}/` : '';
      return [...store.keys()].filter((p) => p.startsWith(base)).sort();
    },
    set(path, text) {
      const key = normalise(path);
      store.set(key, new TextEncoder().encode(text));
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
    },
    delete(path) {
      store.delete(normalise(path));
    },
    async createIfAbsent(path: string, bytes: Uint8Array): Promise<VaultMutationResult> {
      const key = normalise(path);
      if (store.has(key)) return { ok: false, reason: 'already-exists', actualRevision: `${key}@${revisions.get(key) ?? 1}` };
      store.set(key, new Uint8Array(bytes));
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      return { ok: true, revision: `${key}@${revisions.get(key)}` };
    },
    async writeIfUnchanged(path: string, bytes: Uint8Array, expectedRevision: string): Promise<VaultMutationResult> {
      const key = normalise(path);
      const current = revisions.has(key) && store.has(key) ? `${key}@${revisions.get(key)}` : undefined;
      if (!current) return { ok: false, reason: 'missing', actualRevision: `${key}@${revisions.get(key) ?? 0}` };
      if (current !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: current };
      store.set(key, new Uint8Array(bytes));
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      return { ok: true, revision: `${key}@${revisions.get(key)}` };
    },
    async moveIfUnchanged(path: string, destination: string, expectedRevision: string): Promise<VaultMutationResult> {
      const from = normalise(path); const to = normalise(destination);
      const current = revisions.has(from) && store.has(from) ? `${from}@${revisions.get(from)}` : undefined;
      if (!current) return { ok: false, reason: 'missing', actualRevision: `${from}@${revisions.get(from) ?? 0}` };
      if (current !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: current };
      if (store.has(to)) return { ok: false, reason: 'destination-exists', actualRevision: `${to}@${revisions.get(to) ?? 1}` };
      const bytes = store.get(from)!;
      store.delete(from); store.set(to, new Uint8Array(bytes));
      const next = (revisions.get(to) ?? 0) + 1;
      revisions.set(to, next); revisions.set(from, (revisions.get(from) ?? 0) + 1);
      return { ok: true, revision: `${to}@${next}` };
    },
    async deleteIfUnchanged(path: string, expectedRevision: string): Promise<VaultMutationResult> {
      const key = normalise(path);
      const current = revisions.has(key) && store.has(key) ? `${key}@${revisions.get(key)}` : undefined;
      if (!current) return { ok: false, reason: 'missing', actualRevision: `${key}@${revisions.get(key) ?? 0}` };
      if (current !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: current };
      store.delete(key); revisions.set(key, (revisions.get(key) ?? 0) + 1);
      return { ok: true, revision: `${key}@${revisions.get(key)}` };
    },
  };
}
