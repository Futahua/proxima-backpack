/**
 * Legacy Markdown record identity and source provenance.
 *
 * `SourcedRecord.id` is the compatibility key produced by the existing Markdown
 * reader. It may come from frontmatter, a filename or a folder because legacy
 * discovery must remain truthful to the creator's existing vault.
 *
 * It is not the future canonical record identity. HARD GATE A assigns a separate
 * opaque canonical id before import. Legacy ids remain aliases/provenance only, and
 * the source reference remains separate metadata describing where legacy bytes came
 * from.
 */

export type RecordKind = 'project' | 'task' | 'event';

/**
 * How the legacy Markdown reader obtained its compatibility id.
 *
 * - `frontmatter` — the file declared `id:`.
 * - `filename`    — derived from the file's own basename.
 * - `folder`      — derived from the containing folder, for `projects/{id}/index.md`.
 *
 * These origins are import provenance only. None is authority for a future canonical
 * opaque record id, including an explicit frontmatter id.
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
  /** Legacy compatibility/import alias. Never promote directly to a canonical record id. */
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
