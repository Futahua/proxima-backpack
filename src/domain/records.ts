/**
 * Record identity and provenance.
 *
 * A record's logical id and the path of the file it was read from are two different
 * things, and conflating them is the defect this module exists to prevent. The plugin
 * treated the path as the identity, so moving a file silently created a new record and
 * renaming one silently destroyed the old one.
 *
 * Here the logical id is what the rest of Proxima refers to — selections, board keys,
 * agent-visible ids, future visual keys — and the source reference is separate
 * metadata describing where those bytes came from.
 */

export type RecordKind = 'project' | 'task' | 'event';

/**
 * How a record's logical id was decided.
 *
 * - `frontmatter` — the file declared `id:`. Authoritative; a rename cannot change it.
 * - `filename`    — derived from the file's own basename, the legacy convention.
 * - `folder`      — derived from the containing folder, for `projects/{id}/index.md`.
 *
 * Only `frontmatter` survives a rename. That is a property of the data, not a bug:
 * a file with no declared id has nothing else to be identified by.
 */
export type IdOrigin = 'frontmatter' | 'filename' | 'folder';

/** Where a loaded record came from. Every record carries one; none is inferred later. */
export interface SourceRef {
  /** Vault-relative path, forward-slashed, of the file that produced this record. */
  path: string;
  /** Opaque revision as read. Changes when the file changes. */
  revision: string;
  /** What the reader interpreted this file as. */
  kind: RecordKind;
  /** How the logical id was decided. */
  idOrigin: IdOrigin;
}

/** Anything loaded out of the vault can be traced back to its file. */
export interface SourcedRecord {
  id: string;
  source: SourceRef;
}

/** The basename of a vault path, without its Markdown extension. */
export function baseName(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.md$/i, '');
}

/** The immediate parent folder name of a vault path, or '' at the root. */
export function parentName(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? (parts[parts.length - 2] as string) : '';
}
