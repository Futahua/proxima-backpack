/**
 * Headless arbitrary-file canvas nodes.
 *
 * A node is Proxima-owned workspace state. Its stable id and layout are therefore
 * deliberately separate from the vault-relative source locator and its observed
 * provenance. This first Gate 8 slice is pure data: it reads nothing, knows no
 * filesystem or browser types, and represents every vault file through a passive
 * fallback card until a later registry supplies a specialised renderer.
 */

import type { IdGenerator } from './clock.js';

export type CanvasSourceState = 'available' | 'missing' | 'unavailable';

export interface CanvasLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasVaultFileSource {
  kind: 'vault-file';
  /** Canonical vault-relative path; never an absolute or traversal path. */
  path: string;
  state: CanvasSourceState;
  /** Last observed source metadata, or null when the source did not provide it. */
  revision: string | null;
  size: number | null;
  modifiedAt: string | null;
}

export interface CanvasBrowserFileSource {
  kind: 'browser-file';
  /** Deliberately absent: a browser filename is not a vault locator. */
  path?: never;
  /** Proxima-owned, ephemeral acquisition identity; never a filename or path. */
  sourceId: string;
  filename: string;
  state: CanvasSourceState;
  mimeType: string | null;
  /** Browser one-shot sources have no durable vault revision. */
  revision: string | null;
  size: number | null;
  modifiedAt: string | null;
}

export type CanvasSource = CanvasVaultFileSource | CanvasBrowserFileSource;

export interface CanvasFallbackRepresentation {
  kind: 'fallback';
  sourceKind: CanvasSource['kind'];
  sourceId: string | null;
  sourcePath: string | null;
  filename: string;
  /** Lowercase extension without the leading dot, or '' when there is none. */
  extension: string;
  sourceState: CanvasSourceState;
  revision: string | null;
  size: number | null;
  modifiedAt: string | null;
}

export interface CanvasNode {
  /** Stable Proxima-owned identity. It is not a path or renderer type. */
  id: string;
  layout: CanvasLayout;
  source: CanvasSource;
  /** Total, passive representation for this first slice. */
  representation: CanvasFallbackRepresentation;
}

export type CanvasSourceObservation = {
  path: string;
  state: CanvasSourceState;
  revision?: string | null;
  size?: number | null;
  modifiedAt?: string | null;
  kind?: 'vault-file';
} | {
  kind: 'browser-file';
  sourceId: string;
  filename: string;
  state: CanvasSourceState;
  mimeType?: string | null;
  size?: number | null;
  modifiedAt?: string | null;
};

export const DEFAULT_CANVAS_LAYOUT: CanvasLayout = { x: 0, y: 0, width: 320, height: 200 };

/** Create a node without reading or acquiring authority over its source. */
export function createCanvasNode(
  ids: IdGenerator,
  observation: CanvasSourceObservation,
  layout: CanvasLayout = DEFAULT_CANVAS_LAYOUT,
): CanvasNode {
  const safeLayout = validateLayout(layout);
  const source = sourceFromObservation(observation);
  return {
    id: ids.next('canvas-node'),
    layout: safeLayout,
    source,
    representation: fallbackFor(source),
  };
}

/** Re-observe a source, preserving the node's identity and canvas layout. */
export function reobserveCanvasNode(node: CanvasNode, observation: CanvasSourceObservation): CanvasNode {
  const source = sourceFromObservation(observation, node.source);
  return { ...node, source, representation: fallbackFor(source) };
}

/** Preserve the node and last-known metadata when its source disappears. */
export function markCanvasNodeMissing(node: CanvasNode): CanvasNode {
  const source: CanvasSource = { ...node.source, state: 'missing' };
  return { ...node, source, representation: fallbackFor(source) };
}

/** Preserve the node and metadata when the source cannot currently be observed. */
export function markCanvasNodeUnavailable(node: CanvasNode): CanvasNode {
  const source: CanvasSource = { ...node.source, state: 'unavailable' };
  return { ...node, source, representation: fallbackFor(source) };
}

function sourceFromObservation(
  observation: CanvasSourceObservation,
  previous?: CanvasSource,
): CanvasSource {
  if (observation.kind === 'browser-file') {
    const old = previous?.kind === 'browser-file' ? previous : undefined;
    return {
      kind: 'browser-file',
      sourceId: observation.sourceId,
      filename: boundedFilename(observation.filename),
      state: observation.state,
      mimeType: metadataValue(observation.mimeType, old?.mimeType ?? null),
      revision: null,
      size: metadataValue(observation.size, old?.size ?? null),
      modifiedAt: metadataValue(observation.modifiedAt, old?.modifiedAt ?? null),
    };
  }
  const path = validateVaultRelativePath(observation.path);
  const old = previous?.kind === 'vault-file' ? previous : undefined;
  const revision = metadataValue(observation.revision, old?.revision ?? null);
  const size = metadataValue(observation.size, old?.size ?? null);
  const modifiedAt = metadataValue(observation.modifiedAt, old?.modifiedAt ?? null);
  return { kind: 'vault-file', path, state: observation.state, revision, size, modifiedAt };
}

function metadataValue<T>(value: T | null | undefined, previous: T | null): T | null {
  return value === undefined ? previous : value;
}

function fallbackFor(source: CanvasSource): CanvasFallbackRepresentation {
  const filename = source.kind === 'vault-file' ? vaultFileName(source.path) : source.filename;
  const extension = source.kind === 'vault-file' ? vaultFileExtension(source.path) : fileExtension(filename);
  return {
    kind: 'fallback',
    sourceKind: source.kind,
    sourceId: source.kind === 'browser-file' ? source.sourceId : null,
    sourcePath: source.kind === 'vault-file' ? source.path : null,
    filename,
    extension,
    sourceState: source.state,
    revision: source.revision,
    size: source.size,
    modifiedAt: source.modifiedAt,
  };
}

export function vaultFileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function vaultFileExtension(path: string): string {
  return fileExtension(vaultFileName(path));
}

export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

function boundedFilename(value: string): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 260) : 'unnamed';
}

/** Reject rather than normalise an unsafe locator. */
export function validateVaultRelativePath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('//') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('vault-relative path is invalid');
  }
  return path;
}

function validateLayout(layout: CanvasLayout): CanvasLayout {
  if (
    !Number.isFinite(layout.x) ||
    !Number.isFinite(layout.y) ||
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    layout.width <= 0 ||
    layout.height <= 0
  ) {
    throw new Error('canvas layout is invalid');
  }
  return { ...layout };
}
