/**
 * The seam that replaces Obsidian's App/Vault.
 *
 * Everything above this line is Proxima. Everything below it is whatever happens
 * to be holding the bytes: a fixture directory, the browser File System Access
 * API, or a Papers capability if one is ever justified. The domain must never
 * learn which.
 *
 * The reader remains the production boundary for the signed read-only release.
 * Owner-mode writers are introduced only for explicitly granted/disposable roots
 * until the native authority and coexistence gates are signed.
 */

export interface VaultFile {
  /** Vault-relative path, forward-slashed. */
  path: string;
  /** Bytes as last read. */
  text: string;
  /** Opaque revision — changes when the file changes. Used to detect external edits. */
  revision: string;
  size: number;
  modifiedAt: string;
}

/** Bytes, with the provenance a text read would have carried. */
export interface VaultBinaryFile {
  path: string;
  bytes: Uint8Array;
  size: number;
  revision: string;
  modifiedAt: string;
}

export interface VaultEntry {
  path: string;
  kind: 'file' | 'directory';
}

/**
 * What a reader can say about a directory after a traversal failed.
 *
 * `unknown` is a real answer and the safe default: a reader that cannot separate
 * "not there" from "there but unreadable" must say so rather than pick, because
 * treating an unreadable directory as absent turns a hole in the evidence into a
 * warning. Callers fail closed on it.
 */
export type DirectoryPresence = 'present' | 'missing' | 'unknown';

export interface VaultReader {
  /** Entries directly under a vault-relative directory ('' is the vault root). */
  list(directory: string): Promise<VaultEntry[]>;
  /**
   * Read text, optionally refusing a response whose decoded character count
   * exceeds the caller's bound. Sources should apply the bound before exposing
   * the payload where their underlying API permits it.
   */
  read(path: string, maxChars?: number): Promise<VaultFile>;
  exists(path: string): Promise<boolean>;
  /** Every file under a directory, recursively. */
  walk(directory: string): Promise<string[]>;
  /**
   * Optional binary read, for assets that are not text.
   *
   * Optional because a source may genuinely not offer one, and an asset layer that
   * assumed every source could return bytes would fail confusingly instead of
   * reporting a missing capability. Bytes rather than base64: base64 belongs at an
   * HTTP boundary, not in the source contract, where it would expand everything in
   * memory by a third for no benefit.
   *
   * It grants no new authority. The same traversal rejection, symlink refusal and
   * bounds apply as for `read`; this is the same file, returned unmangled.
   */
  readBinary?(path: string, maxBytes: number): Promise<VaultBinaryFile>;

  /**
   * Optional precise presence probe, used only to classify a traversal failure.
   * A reader that omits it is treated as `unknown`, which blocks rather than
   * excuses — so adding it can only ever make a verdict more precise, never more
   * permissive.
   */
  presence?(directory: string): Promise<DirectoryPresence>;
}

/**
 * Conditional mutation seam for owner mode. Implementations must refuse stale
 * observations rather than silently choosing last-writer-wins.
 *
 * Two conditions bind whoever implements this, both recorded in docs/DECISIONS.md:
 *
 *  - serialize from `ParsedDocument.frontmatterRaw`, never from the interpreted
 *    values. The parser reads a subset; a document whose `lossy` flag is set has
 *    content the interpreted view does not contain, and round-tripping through that
 *    view would delete a key another plugin owns.
 *  - re-decide the parser question first (D7). A partial parser is safe to read with
 *    and unsafe to write from.
 */
export type VaultMutationConflict = 'stale' | 'missing' | 'already-exists' | 'destination-exists';

export type VaultMutationResult =
  | { ok: true; revision: string }
  | { ok: false; reason: VaultMutationConflict; actualRevision?: string };

export interface VaultWriter {
  createIfAbsent(path: string, bytes: Uint8Array): Promise<VaultMutationResult>;
  /**
   * Write only if the file still has the revision we read. Anything else is a
   * conflict, not a write — this is the guard against silently overwriting an
   * edit Obsidian made in the meantime.
   */
  writeIfUnchanged(path: string, bytes: Uint8Array, expectedRevision: string): Promise<VaultMutationResult>;

  moveIfUnchanged(path: string, destination: string, expectedRevision: string): Promise<VaultMutationResult>;

  deleteIfUnchanged(path: string, expectedRevision: string): Promise<VaultMutationResult>;
}
