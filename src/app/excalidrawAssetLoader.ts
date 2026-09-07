import { resolveEmbeddedLink, type VaultAssetIndex } from '../domain/excalidrawAssets.js';
import { detectImageMedia, imageDataUrl, type SupportedImageMedia } from '../domain/imageMedia.js';
import type { ExcalidrawEmbeddedFile } from '../domain/excalidraw.js';
import type { VaultReader } from '../ports/vault.js';

/**
 * Turning an Excalidraw drawing's embedded-file references into image bytes.
 *
 * This is the only place that spends I/O on a drawing's assets, and it is bounded in
 * three independent ways on purpose. A scene's own size says nothing about what it
 * references: a small drawing can point at fifty large photographs, so a per-asset
 * limit alone still permits an unbounded total. Hence a per-asset ceiling, a count
 * ceiling, and an aggregate budget that stops further reads once spent.
 *
 * Every failure is attributed to the asset that caused it. A drawing with one
 * missing image is a drawing with one missing image, not an unreadable drawing.
 *
 * Provenance travels with the bytes. An asset carries the vault-relative path and
 * the source revision it was read at, so the picture on screen can always be tied to
 * a particular state of the vault rather than floating free of it.
 */

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_ASSETS_PER_DRAWING = 32;
export const MAX_DRAWING_ASSET_BYTES = 64 * 1024 * 1024;

export type AssetOutcome =
  | 'resolved'
  | 'unresolved'
  | 'ambiguous'
  | 'rejected'
  /** The source cannot return bytes at all. */
  | 'capability-unavailable'
  | 'too-large'
  | 'budget-exhausted'
  | 'too-many-assets'
  | 'unsupported-media'
  | 'unreadable';

export interface LoadedAsset {
  fileId: string;
  outcome: AssetOutcome;
  /** Present only when the outcome is `resolved`. */
  dataUrl: string | null;
  mediaType: SupportedImageMedia | null;
  /** Vault-relative path, when one was identified. Never an absolute path. */
  sourcePath: string | null;
  /** Revision the bytes were read at, so the image is tied to a vault state. */
  sourceRevision: string | null;
  bytes: number;
}

export interface AssetLoadResult {
  /** `fileId` → data URL, shaped for the renderer. Resolved assets only. */
  assets: Record<string, string>;
  /** Every reference, resolved or not, with its outcome. */
  loaded: LoadedAsset[];
  totalBytes: number;
}

export interface AssetLoadOptions {
  maxAssetBytes?: number;
  maxAssets?: number;
  maxTotalBytes?: number;
}

export async function loadDrawingAssets(
  vault: VaultReader,
  index: VaultAssetIndex,
  embeddedFiles: readonly ExcalidrawEmbeddedFile[],
  options: AssetLoadOptions = {},
): Promise<AssetLoadResult> {
  const maxAssetBytes = options.maxAssetBytes ?? MAX_ASSET_BYTES;
  const maxAssets = options.maxAssets ?? MAX_ASSETS_PER_DRAWING;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_DRAWING_ASSET_BYTES;

  const assets: Record<string, string> = Object.create(null) as Record<string, string>;
  const loaded: LoadedAsset[] = [];
  let totalBytes = 0;
  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const embed of embeddedFiles) {
    if (seenKeys.has(embed.key)) duplicateKeys.add(embed.key);
    else seenKeys.add(embed.key);
  }

  for (const [position, embed] of embeddedFiles.entries()) {
    const base: LoadedAsset = {
      fileId: embed.key,
      outcome: 'unresolved',
      dataUrl: null,
      mediaType: null,
      sourcePath: null,
      sourceRevision: null,
      bytes: 0,
    };

    // One scene file ID must identify one asset. If the envelope supplies the
    // same key more than once, selecting either link would be a guess; report
    // every occurrence as ambiguous instead of allowing last-write-wins.
    if (duplicateKeys.has(embed.key)) {
      loaded.push({ ...base, outcome: 'ambiguous' });
      continue;
    }

    if (position >= maxAssets) {
      // Reported rather than ignored: the drawing references more than this will
      // load, and the viewer should know that rather than wonder.
      loaded.push({ ...base, outcome: 'too-many-assets' });
      continue;
    }

    const resolution = resolveEmbeddedLink(index, `[[${embed.link}]]`);
    if (resolution.status !== 'resolved' || !resolution.entry) {
      loaded.push({ ...base, outcome: resolution.status });
      continue;
    }

    const entry = resolution.entry;
    const located: LoadedAsset = { ...base, sourcePath: entry.relativePath, sourceRevision: entry.sourceRevision };

    if (typeof vault.readBinary !== 'function') {
      loaded.push({ ...located, outcome: 'capability-unavailable' });
      continue;
    }
    if (totalBytes >= maxTotalBytes) {
      loaded.push({ ...located, outcome: 'budget-exhausted' });
      continue;
    }

    let file;
    try {
      // The remaining budget is the ceiling for this read, so an oversized asset
      // cannot be buffered whole before being rejected.
      file = await vault.readBinary(entry.relativePath, Math.min(maxAssetBytes, maxTotalBytes - totalBytes));
    } catch {
      loaded.push({ ...located, outcome: 'unreadable' });
      continue;
    }

    const bytes = file?.bytes;
    if (!(bytes instanceof Uint8Array)) {
      loaded.push({ ...located, outcome: 'unreadable' });
      continue;
    }
    // Count every byte the source returned before judging its media. The
    // aggregate ceiling is a read/buffering budget, not merely a sum of bytes
    // that happened to be accepted as images. Unsupported media and oversized
    // responses must spend the budget too, otherwise a drawing can stream an
    // unbounded number of rejected payloads through the loader.
    totalBytes += bytes.length;
    // Once bytes have been returned, every outcome must carry the revision at
    // which those bytes were read, not merely the index revision.
    const withByteRevision = { ...located, sourceRevision: file.revision ?? entry.sourceRevision };

    if (bytes.length > maxAssetBytes) {
      loaded.push({ ...withByteRevision, outcome: 'too-large', bytes: bytes.length });
      continue;
    }
    if (totalBytes > maxTotalBytes) {
      loaded.push({ ...withByteRevision, outcome: 'budget-exhausted', bytes: bytes.length });
      continue;
    }

    const media = detectImageMedia(bytes);
    if (!media.supported) {
      // The bytes decide, not the extension. A file named .png that is not one has
      // no business reaching an image element.
      loaded.push({ ...withByteRevision, outcome: 'unsupported-media', bytes: bytes.length });
      continue;
    }

    const dataUrl = imageDataUrl(media.mediaType, bytes);
    assets[embed.key] = dataUrl;
    loaded.push({
      ...withByteRevision,
      outcome: 'resolved',
      dataUrl,
      mediaType: media.mediaType,
      bytes: bytes.length,
    });
  }

  return { assets, loaded, totalBytes };
}

/** Bounded, path-free summary suitable for evidence and diagnostics. */
export function assetCensus(result: AssetLoadResult): Record<AssetOutcome | 'total' | 'bytes', number> {
  const census = {
    total: result.loaded.length,
    bytes: result.totalBytes,
    resolved: 0,
    unresolved: 0,
    ambiguous: 0,
    rejected: 0,
    'capability-unavailable': 0,
    'too-large': 0,
    'budget-exhausted': 0,
    'too-many-assets': 0,
    'unsupported-media': 0,
    unreadable: 0,
  } as Record<AssetOutcome | 'total' | 'bytes', number>;
  for (const asset of result.loaded) census[asset.outcome] += 1;
  return census;
}
