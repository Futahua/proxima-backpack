/**
 * Pure renderer-selection contract for Gate 8.
 *
 * The selector receives only an already-authorised source observation and an
 * optional bounded payload. It never reads a source, creates a URL, touches the
 * DOM, executes active content, or hands authority to a renderer. Fallback is
 * total; specialised representations are opt-in and signature/structure based.
 */

import { detectImageMedia, type SupportedImageMedia } from './imageMedia.js';
import { recogniseExcalidraw } from './excalidraw.js';
import {
  validateVaultRelativePath,
  vaultFileExtension,
  vaultFileName,
  fileExtension,
  type CanvasSource,
  type CanvasSourceState,
} from './canvas.js';

export const MAX_CANVAS_TEXT_CHARS = 1_000_000;
export const MAX_CANVAS_BINARY_BYTES = 16 * 1024 * 1024;

export const CANVAS_RENDERER_ORDER = ['excalidraw', 'text', 'raster-image', 'fallback'] as const;
export type CanvasRendererKind = (typeof CANVAS_RENDERER_ORDER)[number];

export type CanvasPayload =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; bytes: Uint8Array }
  | { kind: 'too-large' };

export type CanvasSelectionReason =
  | 'source-missing'
  | 'source-unavailable'
  | 'payload-unavailable'
  | 'payload-too-large'
  | 'active-content'
  | 'unsupported-format'
  | 'unsupported-media';

export interface CanvasRepresentationSelection {
  kind: CanvasRendererKind;
  sourceKind: CanvasSource['kind'];
  sourcePath: string | null;
  sourceId: string | null;
  filename: string;
  extension: string;
  sourceState: CanvasSourceState;
  revision: string | null;
  size: number | null;
  modifiedAt: string | null;
  mediaType: SupportedImageMedia | null;
  reason: CanvasSelectionReason | null;
}

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv']);
const ACTIVE_EXTENSIONS = new Set(['html', 'htm', 'svg', 'js', 'mjs', 'cjs', 'exe', 'com', 'bat', 'cmd', 'ps1', 'sh', 'wasm']);

/** Select a data-only representation; all unsupported cases remain fallback. */
export function selectCanvasRepresentation(
  source: CanvasSource,
  payload: CanvasPayload | null,
): CanvasRepresentationSelection {
  const safeSource: CanvasSource = source.kind === 'vault-file'
    ? { ...source, path: validateVaultRelativePath(source.path) }
    : { ...source };
  const filename = safeSource.kind === 'vault-file' ? vaultFileName(safeSource.path) : safeSource.filename;
  const extension = safeSource.kind === 'vault-file' ? vaultFileExtension(safeSource.path) : fileExtension(filename);
  const base = (kind: CanvasRendererKind, reason: CanvasSelectionReason | null, mediaType: SupportedImageMedia | null = null): CanvasRepresentationSelection => ({
    kind,
    sourceKind: safeSource.kind,
    sourcePath: safeSource.kind === 'vault-file' ? safeSource.path : null,
    sourceId: safeSource.kind === 'browser-file' ? safeSource.sourceId : null,
    filename,
    extension,
    sourceState: safeSource.state,
    revision: safeSource.kind === 'vault-file' ? safeSource.revision : null,
    size: safeSource.size,
    modifiedAt: safeSource.modifiedAt,
    mediaType,
    reason,
  });

  if (safeSource.state === 'missing') return base('fallback', 'source-missing');
  if (safeSource.state === 'unavailable') return base('fallback', 'source-unavailable');
  if (ACTIVE_EXTENSIONS.has(extension)) return base('fallback', 'active-content');
  if (payload === null) return base('fallback', 'payload-unavailable');
  if (payload.kind === 'too-large') return base('fallback', 'payload-too-large');

  if (payload.kind === 'text') {
    if (payload.text.length > MAX_CANVAS_TEXT_CHARS) return base('fallback', 'payload-too-large');
    const artifact = recogniseExcalidraw(payload.text, filename);
    if (artifact.kind !== 'not-excalidraw') return base('excalidraw', null);
    if (TEXT_EXTENSIONS.has(extension)) return base('text', null);
    return base('fallback', 'unsupported-format');
  }

  if (!(payload.bytes instanceof Uint8Array) || payload.bytes.length > MAX_CANVAS_BINARY_BYTES) {
    return base('fallback', 'payload-too-large');
  }
  const media = detectImageMedia(payload.bytes);
  if (media.supported) return base('raster-image', null, media.mediaType);
  return base('fallback', 'unsupported-media');
}
