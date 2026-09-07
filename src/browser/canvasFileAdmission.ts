/**
 * One-shot admission of a browser File into capability-free canvas state.
 *
 * This is intentionally not a drop handler. A File is consumed once, bounded by
 * size before arrayBuffer(), and only its inert metadata and classification result
 * leave this module. The generated browser-file source id is ephemeral: callers
 * must not persist a File or silently reconnect it by name after restart.
 */

import {
  createCanvasNode,
  fileExtension,
  markCanvasNodeUnavailable,
  type CanvasLayout,
  type CanvasNode,
  type CanvasSourceObservation,
} from '../domain/canvas.js';
import {
  MAX_CANVAS_BINARY_BYTES,
  canvasExtensionPolicy,
  selectCanvasRepresentation,
  type CanvasRepresentationSelection,
} from '../domain/canvasRenderer.js';
import type { IdGenerator } from '../domain/clock.js';

export interface BrowserFileLike {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type CanvasFileAdmissionStatus = 'selected' | 'active-content-skipped' | 'payload-too-large' | 'unreadable';

export interface CanvasFileAdmissionResult {
  node: CanvasNode;
  selection: CanvasRepresentationSelection;
  status: CanvasFileAdmissionStatus;
}

/** Admit one browser File snapshot without retaining the File capability. */
export async function admitCanvasFile(
  ids: IdGenerator,
  file: BrowserFileLike,
  layout?: CanvasLayout,
): Promise<CanvasFileAdmissionResult> {
  const filename = safeFilename(file.name);
  // Policy uses the complete original name; only the display copy is bounded.
  const extension = fileExtension(file.name);
  const policy = canvasExtensionPolicy(file.name);
  const sourceId = ids.next('canvas-source');
  const size = safeSize(file.size);
  const modifiedAt = safeModifiedAt(file.lastModified);
  const observation: CanvasSourceObservation = {
    kind: 'browser-file',
    sourceId,
    filename,
    extension,
    state: 'available',
    mimeType: typeof file.type === 'string' && file.type.length <= 200 ? file.type : null,
    size,
    modifiedAt,
  };
  const node = createCanvasNode(ids, observation, layout);

  if (policy === 'active') {
    return { node, selection: selectCanvasRepresentation(node.source, null), status: 'active-content-skipped' };
  }
  if (size === null || size > MAX_CANVAS_BINARY_BYTES) {
    return { node, selection: selectCanvasRepresentation(node.source, { kind: 'too-large' }), status: 'payload-too-large' };
  }

  let bytes: Uint8Array;
  try {
    const buffer = await file.arrayBuffer();
    bytes = new Uint8Array(buffer);
  } catch {
    return unavailable(node);
  }
  if (bytes.byteLength > MAX_CANVAS_BINARY_BYTES) return { node, selection: selectCanvasRepresentation(node.source, { kind: 'too-large' }), status: 'payload-too-large' };

  // One acquisition is reused for both structure/text and raster classification.
  if (policy === 'raster') {
    return { node, selection: selectCanvasRepresentation(node.source, { kind: 'binary', bytes }), status: 'selected' };
  }
  const text = new TextDecoder().decode(bytes);
  const textSelection = selectCanvasRepresentation(node.source, { kind: 'text', text });
  if (textSelection.kind === 'excalidraw' || extension === 'md' || extension === 'markdown' || extension === 'txt' || extension === 'text' || extension === 'json' || extension === 'csv' || extension === 'tsv') {
    return { node, selection: textSelection, status: 'selected' };
  }
  return { node, selection: selectCanvasRepresentation(node.source, { kind: 'binary', bytes }), status: 'selected' };
}

function unavailable(node: CanvasNode): CanvasFileAdmissionResult {
  const unavailableNode = markCanvasNodeUnavailable(node);
  return { node: unavailableNode, selection: selectCanvasRepresentation(unavailableNode.source, null), status: 'unreadable' };
}

function safeFilename(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return 'unnamed';
  return value.slice(0, 260);
}

function safeSize(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeModifiedAt(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
