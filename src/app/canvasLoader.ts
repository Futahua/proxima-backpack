/**
 * Read one already-authorised vault source for a canvas selection.
 *
 * This adapter is deliberately the only Gate 8 slice that spends source I/O. It
 * keeps readers and handles in the app layer, passes only bounded inert payloads to
 * the domain selector, and returns read-time metadata alongside the classification.
 * A read failure degrades that node to an unavailable source; it never becomes a
 * renderer error or a reason to write back to the vault.
 */

import {
  reobserveCanvasNode,
  validateVaultRelativePath,
  vaultFileExtension,
  type CanvasNode,
  type CanvasSourceObservation,
} from '../domain/canvas.js';
import {
  MAX_CANVAS_TEXT_CHARS,
  MAX_CANVAS_BINARY_BYTES,
  selectCanvasRepresentation,
  type CanvasPayload,
  type CanvasRepresentationSelection,
} from '../domain/canvasRenderer.js';
import type { VaultReader } from '../ports/vault.js';

export type CanvasLoadStatus =
  | 'selected'
  | 'active-content-skipped'
  | 'binary-capability-unavailable'
  | 'unreadable';

export interface CanvasLoadResult {
  /** Node identity and layout are preserved across the source observation. */
  node: CanvasNode;
  /** Data-only representation chosen from the read-time source observation. */
  selection: CanvasRepresentationSelection;
  status: CanvasLoadStatus;
}

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv']);
const RASTER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const ACTIVE_EXTENSIONS = new Set(['html', 'htm', 'svg', 'js', 'mjs', 'cjs', 'exe', 'com', 'bat', 'cmd', 'ps1', 'sh', 'wasm']);

/**
 * Read and classify one canvas node. Active-content sources are never read merely
 * to discover that they cannot be rendered inline. Unknown files use the optional
 * binary seam when present, so image admission remains signature-based.
 */
export async function loadCanvasNode(
  vault: VaultReader,
  node: CanvasNode,
): Promise<CanvasLoadResult> {
  const path = validateVaultRelativePath(node.source.path);
  const source = { ...node.source, path };

  if (source.state !== 'available') {
    return { node, selection: selectCanvasRepresentation(source, null), status: 'selected' };
  }

  const extension = vaultFileExtension(path);
  if (ACTIVE_EXTENSIONS.has(extension)) {
    return { node, selection: selectCanvasRepresentation(source, null), status: 'active-content-skipped' };
  }

  // Known raster extensions can go straight to the byte-signature branch. Native
  // drawings and unknown extensions must be text-probed first, however: the
  // structure detector is intentionally stronger than a filename allowlist.
  if (RASTER_EXTENSIONS.has(extension)) return readBinary(node, source, vault);

  const textResult = await readText(node, source, vault);
  if (textResult && (TEXT_EXTENSIONS.has(extension) || extension === 'excalidraw' || textResult.selection.kind === 'excalidraw')) return textResult;
  if (!textResult && (TEXT_EXTENSIONS.has(extension) || extension === 'excalidraw')) return unavailable(node, source);
  if (textResult && typeof vault.readBinary !== 'function') return textResult;
  if (typeof vault.readBinary !== 'function') {
    return { node, selection: selectCanvasRepresentation(source, null), status: 'binary-capability-unavailable' };
  }

  // An unknown non-active file may still be a raster whose name is unhelpful. A
  // text probe that did not find a drawing therefore falls through to bytes.
  return readBinary(textResult?.node ?? node, textResult?.node.source ?? source, vault);
}

async function readText(node: CanvasNode, source: CanvasNode['source'], vault: VaultReader): Promise<CanvasLoadResult | null> {
  try {
    const file = await vault.read(source.path, MAX_CANVAS_TEXT_CHARS);
    if (file.path !== source.path) return unavailable(node, source);
    const observed: CanvasSourceObservation = {
      path: source.path,
      state: 'available',
      revision: file.revision,
      size: file.size,
      modifiedAt: file.modifiedAt,
    };
    const refreshed = reobserveCanvasNode(node, observed);
    const payload: CanvasPayload = { kind: 'text', text: file.text };
    return { node: refreshed, selection: selectCanvasRepresentation(refreshed.source, payload), status: 'selected' };
  } catch {
    return null;
  }
}

async function readBinary(node: CanvasNode, source: CanvasNode['source'], vault: VaultReader): Promise<CanvasLoadResult> {
  if (source.state !== 'available') {
    return { node, selection: selectCanvasRepresentation(source, null), status: 'unreadable' };
  }
  if (typeof vault.readBinary !== 'function') {
    return { node, selection: selectCanvasRepresentation(source, null), status: 'binary-capability-unavailable' };
  }
  try {
    const file = await vault.readBinary(source.path, MAX_CANVAS_BINARY_BYTES);
    if (file.path !== source.path || !(file.bytes instanceof Uint8Array)) return unavailable(node, source);
    const observed: CanvasSourceObservation = {
      path: source.path,
      state: 'available',
      revision: file.revision,
      size: file.size,
      modifiedAt: file.modifiedAt,
    };
    const refreshed = reobserveCanvasNode(node, observed);
    const payload: CanvasPayload = { kind: 'binary', bytes: new Uint8Array(file.bytes) };
    return { node: refreshed, selection: selectCanvasRepresentation(refreshed.source, payload), status: 'selected' };
  } catch {
    return unavailable(node, source);
  }
}

function unavailable(node: CanvasNode, source: CanvasNode['source']): CanvasLoadResult {
  const unavailableSource = { ...source, state: 'unavailable' as const };
  return {
    node: reobserveCanvasNode(node, unavailableSource),
    selection: selectCanvasRepresentation(unavailableSource, null),
    status: 'unreadable',
  };
}
