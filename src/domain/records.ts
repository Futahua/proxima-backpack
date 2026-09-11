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

/**
 * Where a record's identity came from.
 *
 * `legacy-markdown` covers the three `IdOrigin` answers above. `record-store` says the
 * record is canonical and its identity is the opaque record id, so `SourceRef.path` and
 * `SourceRef.revision` describe the record itself rather than a vault file. HARD GATE C
 * asks inspection to identify record-store provenance instead of pretending JSON records
 * are Markdown; this is the value that lets it.
 */
export type RecordOrigin = 'legacy-markdown' | 'record-store';

/** `SourceRef.idOrigin` is the legacy answer, or the record store's. */
export type SourceIdOrigin = IdOrigin | 'record-store';

/** Where a loaded record came from. Every record carries one; none is inferred later. */
export interface SourceRef {
  /**
   * Vault-relative path, forward-slashed, of the file that produced this record — or, for
   * a `record-store` origin, the opaque canonical record id, because there is no file in
   * the creator's vault to name.
   */
  path: string;
  /**
   * Opaque revision as read: the file's revision for legacy Markdown, the record store's
   * observed revision for a canonical record.
   */
  revision: string;
  /** What the reader interpreted this file as. */
  kind: RecordKind;
  /** How the logical id was decided. */
  idOrigin: SourceIdOrigin;
}

/** The origin a `SourceRef` records, without every caller re-deriving it. */
export function recordOriginOf(source: Pick<SourceRef, 'idOrigin'>): RecordOrigin {
  return source.idOrigin === 'record-store' ? 'record-store' : 'legacy-markdown';
}

/**
 * The legacy id origin, refusing a record that did not come from legacy Markdown.
 *
 * Import provenance is a legacy-Markdown concept: a canonical record's identity is opaque and
 * has no `frontmatter`/`filename`/`folder` answer. A caller that needs the legacy answer must
 * say so here rather than receive `'record-store'` in a field that cannot mean it.
 */
export function legacyIdOriginOf(source: Pick<SourceRef, 'idOrigin'>): IdOrigin {
  if (source.idOrigin === 'record-store') {
    throw new Error('legacy id origin requested for a record that came from the record store');
  }
  return source.idOrigin;
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
