/**
 * Resolving the embedded-file references an Excalidraw envelope carries.
 *
 * An image element names a `fileId`; the envelope maps that id to a wikilink such
 * as `[[Pasted Image 20260605223658_755.png]]`; and the bytes live in the vault as
 * an ordinary attachment. This module walks that chain and stops.
 *
 * It is deliberately *not* Obsidian link resolution. Block references, heading
 * references, aliases, metadata resolution, `.obsidian` configuration, URI schemes,
 * network URLs and external paths are all out of scope until a real artifact proves
 * one is needed. Implementing them speculatively is how a narrow adapter becomes an
 * Obsidian compatibility layer, which is the thing this project exists to escape.
 *
 * It performs no I/O. The vault index is supplied by the caller, built from the
 * audited read-only source; a resolver that went looking through the filesystem
 * itself would be recreating the semantics it is meant to avoid.
 *
 * The distinction that matters most: **unresolved and ambiguous are different
 * answers.** Nothing matching a reference is a different problem from a reference
 * too vague to identify one file safely, and they call for different fixes. Neither
 * ever guesses: an ambiguous link selects nothing, because picking the first match
 * would turn index ordering into a wrong picture.
 */

export type AssetResolution = 'resolved' | 'unresolved' | 'ambiguous' | 'rejected';

export interface VaultAssetEntry {
  /** Vault-relative path, forward-slashed. */
  relativePath: string;
  /** Final path segment, with extension. */
  basename: string;
  /** Final path segment, without extension. */
  stem: string;
  /** Lowercase extension without the dot, or '' when there is none. */
  extension: string;
  /** Revision at index time, carried through so evidence can cite it. */
  sourceRevision: string;
}

export type VaultAssetIndex = readonly VaultAssetEntry[];

export interface ResolvedAsset {
  status: AssetResolution;
  /** The single matching entry, only when exactly one matched. */
  entry: VaultAssetEntry | null;
  /** How many entries the reference matched. */
  matchCount: number;
  /** The link target after parsing, for evidence. Never a filesystem path. */
  target: string;
}

const MAX_TARGET_LENGTH = 400;

/** Build an index entry from a vault-relative path. */
export function assetEntry(relativePath: string, sourceRevision: string): VaultAssetEntry {
  const normalised = relativePath.split('\\').join('/').replace(/^\/+/, '');
  const basename = normalised.slice(normalised.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  return {
    relativePath: normalised,
    basename,
    stem: dot > 0 ? basename.slice(0, dot) : basename,
    extension: dot > 0 ? basename.slice(dot + 1).toLowerCase() : '',
    sourceRevision,
  };
}

export function buildAssetIndex(files: Record<string, string>): VaultAssetIndex {
  return Object.entries(files).map(([path, revision]) => assetEntry(path, revision));
}

/**
 * Resolve one embedded-file wikilink against the index.
 *
 * `[[target]]` and `[[target|display]]` are understood; the display half is
 * discarded because it names nothing. A target carrying a path or an extension is
 * matched as a path first, then by basename; a bare target is matched by stem.
 */
export function resolveEmbeddedLink(index: VaultAssetIndex, link: string): ResolvedAsset {
  const target = parseWikilink(link);
  if (target === null) {
    return { status: 'rejected', entry: null, matchCount: 0, target: bounded(link) };
  }

  const matches = matchEntries(index, target);
  if (matches.length === 1) {
    return { status: 'resolved', entry: matches[0] as VaultAssetEntry, matchCount: 1, target };
  }
  if (matches.length === 0) {
    return { status: 'unresolved', entry: null, matchCount: 0, target };
  }
  // Never select one. Index order is not a decision about which file the artist
  // meant, and a confidently wrong image is worse than a visible gap.
  return { status: 'ambiguous', entry: null, matchCount: matches.length, target };
}

function matchEntries(index: VaultAssetIndex, target: string): VaultAssetEntry[] {
  const wanted = target.toLowerCase();
  const hasPath = wanted.includes('/');
  const hasExtension = /\.[a-z0-9]+$/i.test(wanted);

  if (hasPath) {
    // An explicit path is an exact claim; honour it exactly.
    return index.filter((entry) => entry.relativePath.toLowerCase() === wanted);
  }
  if (hasExtension) {
    return index.filter((entry) => entry.basename.toLowerCase() === wanted);
  }
  // A bare name matches on stem, which is how a vault link without an extension
  // names a note or an attachment.
  return index.filter((entry) => entry.stem.toLowerCase() === wanted);
}

/** `[[target]]` or `[[target|display]]`. Anything else is rejected, not guessed. */
function parseWikilink(link: string): string | null {
  if (typeof link !== 'string') return null;
  const trimmed = link.trim();
  const inner = /^\[\[(.+)\]\]$/.exec(trimmed);
  const body = (inner ? inner[1] : trimmed) ?? '';
  const withoutAlias = (body.split('|')[0] ?? '').trim();
  if (!withoutAlias) return null;

  // Out of scope on purpose: a reference to part of a document is not a reference
  // to a file, and treating it as one would resolve to the wrong thing.
  // A caret can appear anywhere in the reference, not only at the start — the
  // start-only check let `[[Note^block]]` through as an ordinary name.
  if (withoutAlias.includes('#') || withoutAlias.includes('^')) return null;
  // `[[]]` does not match the wikilink pattern, so without this the empty body
  // survives as a literal target and reports as merely unresolved.
  if (withoutAlias.includes('[') || withoutAlias.includes(']')) return null;
  // Anything that leaves the vault is not an embedded vault asset.
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutAlias)) return null;
  if (withoutAlias.startsWith('/') || /^[A-Za-z]:/.test(withoutAlias)) return null;
  if (withoutAlias.split('/').some((part) => part === '..' || part === '.')) return null;
  if (withoutAlias.length > MAX_TARGET_LENGTH) return null;

  return withoutAlias;
}

function bounded(value: string): string {
  return String(value ?? '').slice(0, MAX_TARGET_LENGTH);
}
