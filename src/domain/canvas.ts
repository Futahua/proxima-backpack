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

export interface CanvasFallbackRepresentation {
  kind: 'fallback';
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
  source: CanvasVaultFileSource;
  /** Total, passive representation for this first slice. */
  representation: CanvasFallbackRepresentation;
}

export interface CanvasSourceObservation {
  path: string;
  state: CanvasSourceState;
  revision?: string | null;
  size?: number | null;
  modifiedAt?: string | null;
}

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
  const source: CanvasVaultFileSource = { ...node.source, state: 'missing' };
  return { ...node, source, representation: fallbackFor(source) };
}

/** Preserve the node and metadata when the source cannot currently be observed. */
export function markCanvasNodeUnavailable(node: CanvasNode): CanvasNode {
  const source: CanvasVaultFileSource = { ...node.source, state: 'unavailable' };
  return { ...node, source, representation: fallbackFor(source) };
}

function sourceFromObservation(
  observation: CanvasSourceObservation,
  previous?: CanvasVaultFileSource,
): CanvasVaultFileSource {
  const path = validateVaultRelativePath(observation.path);
  const revision = metadataValue(observation.revision, previous?.revision ?? null);
  const size = metadataValue(observation.size, previous?.size ?? null);
  const modifiedAt = metadataValue(observation.modifiedAt, previous?.modifiedAt ?? null);
  return { kind: 'vault-file', path, state: observation.state, revision, size, modifiedAt };
}

function metadataValue<T>(value: T | null | undefined, previous: T | null): T | null {
  return value === undefined ? previous : value;
}

function fallbackFor(source: CanvasVaultFileSource): CanvasFallbackRepresentation {
  const filename = source.path.slice(source.path.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
  return {
    kind: 'fallback',
    filename,
    extension,
    sourceState: source.state,
    revision: source.revision,
    size: source.size,
    modifiedAt: source.modifiedAt,
  };
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
