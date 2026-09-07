/** Capability-free visible canvas surface state and passive card rendering. */

import type { IdGenerator } from '../domain/clock.js';
import type { CanvasNode } from '../domain/canvas.js';
import type { CanvasRepresentationSelection } from '../domain/canvasRenderer.js';
import { admitCanvasFile, admitCanvasFileForPresentation, type BrowserFileLike, type CanvasFileAdmissionResult } from './canvasFileAdmission.js';
import type { CanvasPreviewRegistry } from './canvasPreview.js';

export const MAX_CANVAS_DROP_FILES = 32;

export interface CanvasSurfaceItem {
  node: CanvasNode;
  selection: CanvasRepresentationSelection;
  status: CanvasFileAdmissionResult['status'];
}

export interface CanvasSurfaceState {
  items: CanvasSurfaceItem[];
  lastDropDiagnostic: string | null;
}

export const EMPTY_CANVAS_SURFACE: CanvasSurfaceState = { items: [], lastDropDiagnostic: null };

export interface CanvasDropQueue {
  enqueue(files: readonly BrowserFileLike[]): Promise<CanvasSurfaceState>;
  snapshot(): CanvasSurfaceState;
}

/** Serialize batches so overlapping DOM drop events cannot overwrite each other. */
export function createCanvasDropQueue(ids: IdGenerator, initial: CanvasSurfaceState = EMPTY_CANVAS_SURFACE, previews?: CanvasPreviewRegistry): CanvasDropQueue {
  let current = initial;
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(files) {
      const job = tail.then(async () => { current = await admitCanvasDrop(files, current, ids, previews); });
      tail = job.then(() => undefined);
      return job.then(() => current);
    },
    snapshot: () => current,
  };
}

/** Admit a bounded drop sequentially; File capabilities never enter returned state. */
export async function admitCanvasDrop(
  files: readonly BrowserFileLike[],
  state: CanvasSurfaceState = EMPTY_CANVAS_SURFACE,
  ids: IdGenerator,
  previews?: CanvasPreviewRegistry,
): Promise<CanvasSurfaceState> {
  const nextItems = [...state.items];
  const admitted = Math.min(files.length, MAX_CANVAS_DROP_FILES);
  for (let index = 0; index < admitted; index += 1) {
    const file = files[index];
    if (!file) continue;
    const resultWithPreview = previews ? await admitCanvasFileForPresentation(ids, file) : null;
    const result = resultWithPreview?.admission ?? await admitCanvasFile(ids, file);
    if (resultWithPreview?.preview && previews) previews.install(result.node.id, resultWithPreview.preview);
    nextItems.push({ node: result.node, selection: result.selection, status: result.status });
  }
  const diagnostic = files.length > MAX_CANVAS_DROP_FILES
    ? `drop-limit-exceeded: admitted ${MAX_CANVAS_DROP_FILES} of ${files.length} files`
    : null;
  return { items: nextItems, lastDropDiagnostic: diagnostic };
}

/** Render metadata only; no payload, File, URL, HTML or SVG content is embedded. */
export function renderCanvasSurface(state: CanvasSurfaceState, previews?: ReadonlyMap<string, { url: string; mediaType: string }>): string {
  const diagnostic = state.lastDropDiagnostic
    ? `<p class="canvas-diagnostic" data-c1-key="canvas-drop-diagnostic">${escapeHtml(state.lastDropDiagnostic)}</p>`
    : '';
  const cards = state.items.map((item, index) => canvasCard(item, index, previews)).join('');
  return `<section class="surface canvas-surface" data-c1-key="canvas-region" aria-label="Canvas"><header class="surface-header"><div><p class="eyebrow">Workspace canvas</p><h2>Canvas</h2><p class="surface-description">Drop files to create passive, one-shot file cards.</p></div><span class="surface-count">${state.items.length} items</span></header><div class="canvas-drop-zone" data-c1-key="canvas-drop-zone" aria-label="Canvas drop zone">${cards || '<p class="empty-state">Drop a file here.</p>'}</div>${diagnostic}</section>`;
}

function canvasCard(item: CanvasSurfaceItem, index: number, previews?: ReadonlyMap<string, { url: string; mediaType: string }>): string {
  const { selection, node } = item;
  const label = selection.kind === 'fallback' ? 'Fallback file' : `${selection.kind} — inline preview not mounted`;
  const reason = selection.reason ? ` · ${selection.reason.replaceAll('-', ' ')}` : '';
  const size = selection.size === null ? 'size unavailable' : `${selection.size} bytes`;
  const modified = selection.modifiedAt ?? 'modified time unavailable';
  const state = selection.sourceState;
  const preview = selection.kind === 'raster-image' ? previews?.get(node.id) : undefined;
  const image = preview && preview.url.startsWith('blob:') ? `<img src="${escapeHtml(preview.url)}" alt="${escapeHtml(selection.filename)}">` : '';
  return `<article class="canvas-card" data-c1-key="canvas-card-${index}" data-canvas-node-id="${escapeHtml(node.id)}"><header><strong>${escapeHtml(selection.filename)}</strong><span>${escapeHtml(label)}</span></header>${image}<p>${escapeHtml(selection.extension || 'no extension')} · ${escapeHtml(size)} · ${escapeHtml(modified)}</p><footer><span>${escapeHtml(state)}${escapeHtml(reason)}</span></footer></article>`;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
