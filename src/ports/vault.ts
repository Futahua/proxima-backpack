/**
 * The seam that replaces Obsidian's App/Vault.
 *
 * Everything above this line is Proxima. Everything below it is whatever happens
 * to be holding the bytes: a fixture directory, the browser File System Access
 * API, or a Papers capability if one is ever justified. The domain must never
 * learn which.
 *
 * v1 is read-only on purpose. Obsidian stays the only writer to the real vault
 * until conflict semantics are specified and tested.
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

export interface VaultEntry {
  path: string;
  kind: 'file' | 'directory';
}

export interface VaultReader {
  /** Entries directly under a vault-relative directory ('' is the vault root). */
  list(directory: string): Promise<VaultEntry[]>;
  read(path: string): Promise<VaultFile>;
  exists(path: string): Promise<boolean>;
  /** Every file under a directory, recursively. */
  walk(directory: string): Promise<string[]>;
}

/**
 * Marker for the day Proxima is allowed to write. Deliberately unimplemented in v1.
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
export interface VaultWriter {
  /**
   * Write only if the file still has the revision we read. Anything else is a
   * conflict, not a write — this is the guard against silently overwriting an
   * edit Obsidian made in the meantime.
   */
  writeIfUnchanged(path: string, text: string, expectedRevision: string): Promise<
    { ok: true; revision: string } | { ok: false; reason: 'stale'; actualRevision: string }
  >;
}
