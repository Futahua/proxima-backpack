/** Capability-free visible canvas surface state and detailed read-only card interactions. */

import type { ActionErrorCode } from '../app/actionProtocol.js';
import type { IdGenerator } from '../domain/clock.js';
import type { CanvasLayout, CanvasNode } from '../domain/canvas.js';
import type { CanvasRepresentationSelection } from '../domain/canvasRenderer.js';
import { admitCanvasFile, admitCanvasFileForPresentation, type BrowserFileLike, type CanvasFileAdmissionResult } from './canvasFileAdmission.js';
import type { CanvasPreviewRegistry } from './canvasPreview.js';
import type { CanvasExcalidrawPreviewRegistry, CanvasExcalidrawPresentation } from './canvasExcalidrawPreview.js';
import type { CanvasTextPreviewRegistry, CanvasTextPreviewSnapshot } from './canvasTextPreview.js';
import { canvasFallbackIcon } from './canvasFallbackIcon.js';

export const MAX_CANVAS_DROP_FILES = 32;

export type CanvasSurfaceWriteRefusal =
  Extract<ActionErrorCode, 'action-not-available'>;

export const CANVAS_SURFACE_WRITE_REFUSAL:
  CanvasSurfaceWriteRefusal = 'action-not-available';

export type CanvasGeometryGestureKind = 'move' | 'resize';

export interface CanvasGeometryRefusal {
  nodeId: string;
  kind: CanvasGeometryGestureKind;
  proposed: CanvasLayout;
}

export interface CanvasSurfaceViewState {
  selectedNodeId: string | null;
  writeRefusal?: CanvasSurfaceWriteRefusal | null;
  lastRefusedGeometry?: CanvasGeometryRefusal | null;
  removeCandidateNodeId?: string | null;
  lastRefusedRemovalNodeId?: string | null;
}

export const EMPTY_CANVAS_SURFACE_VIEW: CanvasSurfaceViewState = {
  selectedNodeId: null,
  writeRefusal: null,
  lastRefusedGeometry: null,
  removeCandidateNodeId: null,
  lastRefusedRemovalNodeId: null,
};

export interface CanvasSurfaceHandlers {
  openNode(nodeId: string): void;
  closeNode(): void;
  refuseGeometry?(intent: CanvasGeometryRefusal): void;
  requestRemove?(nodeId: string): void;
  cancelRemove?(): void;
  refuseRemove?(nodeId: string): void;
}

export const CANVAS_MIN_NODE_WIDTH = 160;
export const CANVAS_MIN_NODE_HEIGHT = 120;
export const CANVAS_MAX_NODE_WIDTH = 1_600;
export const CANVAS_MAX_NODE_HEIGHT = 1_200;
export const CANVAS_MAX_ABS_POSITION = 100_000;

export interface CanvasSurfaceItem {
  node: CanvasNode;
  selection: CanvasRepresentationSelection;
  status: CanvasFileAdmissionResult['status'];
  presentationDiagnostic: string | null;
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
export function createCanvasDropQueue(ids: IdGenerator, initial: CanvasSurfaceState = EMPTY_CANVAS_SURFACE, previews?: CanvasPreviewRegistry, excalidrawPreviews?: CanvasExcalidrawPreviewRegistry, textPreviews?: CanvasTextPreviewRegistry): CanvasDropQueue {
  let current = initial;
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(files) {
      const job = tail.then(async () => { current = await admitCanvasDrop(files, current, ids, previews, excalidrawPreviews, textPreviews); });
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
  excalidrawPreviews?: CanvasExcalidrawPreviewRegistry,
  textPreviews?: CanvasTextPreviewRegistry,
): Promise<CanvasSurfaceState> {
  const nextItems = [...state.items];
  const admitted = Math.min(files.length, MAX_CANVAS_DROP_FILES);
  for (let index = 0; index < admitted; index += 1) {
    const file = files[index];
    if (!file) continue;
    const resultWithPreview = previews || excalidrawPreviews || textPreviews ? await admitCanvasFileForPresentation(ids, file) : null;
    const result = resultWithPreview?.admission ?? await admitCanvasFile(ids, file);
    let presentationDiagnostic: string | null = null;
    if (resultWithPreview?.preview?.kind === 'raster-image' && previews && !previews.install(result.node.id, resultWithPreview.preview)) presentationDiagnostic = 'preview-install-failed';
    if (resultWithPreview?.preview?.kind === 'excalidraw' && excalidrawPreviews) excalidrawPreviews.install(result.node.id, resultWithPreview.preview);
    if (resultWithPreview?.preview?.kind === 'text' && textPreviews && !textPreviews.install(result.node.id, resultWithPreview.preview)) presentationDiagnostic = textPreviews.get(result.node.id).failure ?? 'preview-budget-exhausted';
    nextItems.push({ node: result.node, selection: result.selection, status: result.status, presentationDiagnostic });
  }
  const diagnostic = files.length > MAX_CANVAS_DROP_FILES
    ? `drop-limit-exceeded: admitted ${MAX_CANVAS_DROP_FILES} of ${files.length} files`
    : null;
  return { items: nextItems, lastDropDiagnostic: diagnostic };
}

/** Render escaped metadata plus optional registry-owned previews and local selection. */
export function renderCanvasSurface(
  state: CanvasSurfaceState,
  previews?: ReadonlyMap<string, { url: string; mediaType: string }>,
  excalidrawPreviews?: ReadonlyMap<string, CanvasExcalidrawPresentation>,
  textPreviews?: ReadonlyMap<string, CanvasTextPreviewSnapshot>,
  view: CanvasSurfaceViewState = EMPTY_CANVAS_SURFACE_VIEW,
): string {
  const selectedNodeId =
    view.selectedNodeId !== null
    && state.items.some((item) => item.node.id === view.selectedNodeId)
      ? view.selectedNodeId
      : null;

  const diagnostic = state.lastDropDiagnostic
    ? `<p class="canvas-diagnostic" data-c1-key="canvas-drop-diagnostic">${escapeHtml(state.lastDropDiagnostic)}</p>`
    : '';

  const cards = state.items
    .map((item) =>
      canvasCard(
        item,
        selectedNodeId,
        previews,
        excalidrawPreviews,
        textPreviews,
      ),
    )
    .join('');

  return `<section class="surface canvas-surface" data-c1-key="canvas-region" aria-label="Canvas" data-canvas-write-authority="unavailable"><header class="surface-header"><div><p class="eyebrow">Workspace canvas</p><h2>Canvas</h2><p class="surface-description">Drop files to create passive, one-shot file cards. Select a card to inspect it.</p></div><span class="surface-count">${state.items.length} items</span></header><div class="canvas-drop-zone" data-c1-key="canvas-drop-zone" aria-label="Canvas drop zone">${cards || '<p class="empty-state">Drop a file here.</p>'}</div>${diagnostic}${canvasGeometryRefusal(state, view)}${canvasRemovalRefusal(state, view)}${canvasInspector(state, selectedNodeId)}${canvasRemoveConfirmation(state, view)}</section>`;
}

function canvasCard(
  item: CanvasSurfaceItem,
  selectedNodeId: string | null,
  previews?: ReadonlyMap<string, { url: string; mediaType: string }>,
  excalidrawPreviews?: ReadonlyMap<string, CanvasExcalidrawPresentation>,
  textPreviews?: ReadonlyMap<string, CanvasTextPreviewSnapshot>,
): string {
  const { selection, node } = item;
  const selected = selectedNodeId === node.id;
  const preview =
    selection.kind === 'raster-image'
      ? previews?.get(node.id)
      : undefined;
  const drawing =
    selection.kind === 'excalidraw'
      ? excalidrawPreviews?.get(node.id)
      : undefined;
  const textPreview =
    selection.kind === 'text'
      ? textPreviews?.get(node.id)
      : undefined;

  const label =
    selection.kind === 'fallback'
      ? 'Fallback file'
      : selection.kind === 'raster-image' && preview
        ? 'raster-image — inline preview mounted'
        : selection.kind === 'excalidraw' && drawing
          ? 'excalidraw — inline preview mounted'
          : selection.kind === 'text' && textPreview?.presentation
            ? 'text — inline preview mounted'
            : `${selection.kind} — inline preview not mounted`;

  const reason = selection.reason
    ? ` · ${selection.reason.replaceAll('-', ' ')}`
    : '';
  const size =
    selection.size === null
      ? 'size unavailable'
      : `${selection.size} bytes`;
  const modified =
    selection.modifiedAt ?? 'modified time unavailable';
  const sourceState = selection.sourceState;

  const image =
    preview && preview.url.startsWith('blob:')
      ? `<img src="${escapeHtml(preview.url)}" alt="${escapeHtml(selection.filename)}">`
      : '';

  const drawingSvg = drawing
    ? `<div class="canvas-excalidraw-preview" aria-label="Generated Excalidraw preview">${drawing.svg}</div><small>scene ${drawing.census.sceneElements} · rendered ${drawing.census.rendered} · problems ${drawing.problems.length}</small>`
    : '';

  const textMarkup = textPreview?.presentation
    ? `<pre class="canvas-text-preview">${escapeHtml(textPreview.presentation.text)}</pre>`
    : '';

  const previewFailure = item.presentationDiagnostic
    ? ` · ${item.presentationDiagnostic.replaceAll('-', ' ')}`
    : textPreview?.failure
      ? ` · ${textPreview.failure.replaceAll('-', ' ')}`
      : '';

  const icon =
    selection.kind === 'fallback'
      ? canvasFallbackIcon(selection.extension)
      : null;
  const iconMarkup = icon
    ? `<span class="canvas-fallback-icon" aria-label="${escapeHtml(icon.label)}">${icon.token}</span>`
    : '';

  return `<article class="canvas-card${selected ? ' selected' : ''}" role="button" tabindex="0" aria-pressed="${selected}" data-canvas-action="open-node" data-c1-key="canvas-card-${escapeHtml(node.id)}" data-canvas-node-id="${escapeHtml(node.id)}" data-canvas-source-kind="${escapeHtml(node.source.kind)}" data-canvas-layout-x="${node.layout.x}" data-canvas-layout-y="${node.layout.y}" data-canvas-layout-width="${node.layout.width}" data-canvas-layout-height="${node.layout.height}"><header><span class="canvas-move-handle" data-canvas-action="geometry-preview" data-canvas-geometry-handle="move" data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}" data-c1-key="canvas-move-${escapeHtml(node.id)}" title="Preview move; write unavailable">⋮⋮</span>${iconMarkup}<strong>${escapeHtml(selection.filename)}</strong><span>${escapeHtml(label)}${escapeHtml(previewFailure)}</span></header>${image}${drawingSvg}${textMarkup}<p>${escapeHtml(selection.extension || 'no extension')} · ${escapeHtml(size)} · ${escapeHtml(modified)}</p><footer><span>${escapeHtml(sourceState)}${escapeHtml(reason)}</span></footer><span class="canvas-resize-handle" data-canvas-action="geometry-preview" data-canvas-geometry-handle="resize" data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}" data-c1-key="canvas-resize-${escapeHtml(node.id)}" title="Preview resize; write unavailable">↘</span></article>`;
}

function canvasGeometryRefusal(
  state: CanvasSurfaceState,
  view: CanvasSurfaceViewState,
): string {
  const refusal = view.lastRefusedGeometry ?? null;
  if (
    view.writeRefusal !== CANVAS_SURFACE_WRITE_REFUSAL
    || refusal === null
    || !state.items.some((item) => item.node.id === refusal.nodeId)
  ) {
    return '';
  }

  const proposed = refusal.proposed;
  return `<p class="canvas-geometry-refusal" data-canvas-geometry-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}" data-canvas-geometry-kind="${refusal.kind}" data-canvas-geometry-node-id="${escapeHtml(refusal.nodeId)}" data-c1-key="canvas-geometry-refusal">${refusal.kind === 'move' ? 'Move' : 'Resize'} unavailable until record-store cutover · proposed x ${proposed.x}, y ${proposed.y}, ${proposed.width} × ${proposed.height}. Canvas data was not changed.</p>`;
}

function canvasRemovalRefusal(
  state: CanvasSurfaceState,
  view: CanvasSurfaceViewState,
): string {
  const nodeId = view.lastRefusedRemovalNodeId ?? null;
  if (
    view.writeRefusal !== CANVAS_SURFACE_WRITE_REFUSAL
    || nodeId === null
    || !state.items.some((item) => item.node.id === nodeId)
  ) {
    return '';
  }

  return `<p class="canvas-remove-refusal" data-canvas-remove-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}" data-canvas-remove-node-id="${escapeHtml(nodeId)}" data-c1-key="canvas-remove-refusal">Remove unavailable until record-store cutover. Canvas data and source data were not changed.</p>`;
}

function canvasRemoveConfirmation(
  state: CanvasSurfaceState,
  view: CanvasSurfaceViewState,
): string {
  const nodeId = view.removeCandidateNodeId ?? null;
  if (nodeId === null) return '';

  const item = state.items.find(
    (candidate) => candidate.node.id === nodeId,
  );
  if (!item) return '';

  const sourceIdentity =
    item.node.source.kind === 'vault-file'
      ? item.node.source.path
      : item.node.source.sourceId;

  return `<section class="canvas-remove-confirmation" role="dialog" aria-modal="false" aria-label="Remove Canvas item" data-canvas-remove-candidate-node-id="${escapeHtml(nodeId)}" data-c1-key="canvas-remove-confirm-${escapeHtml(nodeId)}"><header><div><small>Remove from Canvas</small><h3>${escapeHtml(item.selection.filename)}</h3></div></header><p>This would remove the Canvas node only. Source identity: <code>${escapeHtml(sourceIdentity)}</code>.</p><footer><button type="button" data-canvas-action="cancel-remove" data-c1-key="canvas-remove-cancel-${escapeHtml(nodeId)}">Cancel</button><button type="button" data-canvas-action="refuse-remove" data-canvas-node-id="${escapeHtml(nodeId)}" data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}" data-c1-key="canvas-remove-confirm-action-${escapeHtml(nodeId)}">Remove unavailable</button></footer></section>`;
}

function canvasInspector(
  state: CanvasSurfaceState,
  selectedNodeId: string | null,
): string {
  if (selectedNodeId === null) return '';

  const item = state.items.find(
    (candidate) => candidate.node.id === selectedNodeId,
  );
  if (!item) return '';

  const { node, selection } = item;
  const sourceIdentity =
    node.source.kind === 'vault-file'
      ? node.source.path
      : node.source.sourceId;

  const field = (label: string, value: unknown): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`;

  return `<section class="canvas-node-inspector" role="dialog" aria-modal="false" aria-label="Canvas item details" data-canvas-inspector-node-id="${escapeHtml(node.id)}" data-c1-key="canvas-node-inspector"><header><div><small>Canvas item</small><h3>${escapeHtml(selection.filename)}</h3></div><button type="button" class="icon-button" data-canvas-action="close-node" data-c1-key="canvas-node-inspector-close" aria-label="Close canvas item details">×</button></header><dl class="canvas-node-fields">${field('Node ID', node.id)}${field('Representation', selection.kind)}${field('Admission', item.status)}${field('Source kind', node.source.kind)}${field(node.source.kind === 'vault-file' ? 'Source path' : 'Ephemeral source ID', sourceIdentity)}${field('Source state', node.source.state)}${field('Revision', node.source.revision)}${field('Size', node.source.size)}${field('Modified', node.source.modifiedAt)}${field('X', node.layout.x)}${field('Y', node.layout.y)}${field('Width', node.layout.width)}${field('Height', node.layout.height)}</dl><footer><button type="button" disabled aria-disabled="true" data-canvas-write-action="move-resize" data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}">Move / resize unavailable</button><button type="button" data-canvas-action="request-remove" data-canvas-node-id="${escapeHtml(node.id)}" data-canvas-write-action="remove-preview" data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}" data-c1-key="canvas-remove-${escapeHtml(node.id)}">Remove…</button><small data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}">Removal remains unavailable until record-store cutover</small></footer></section>`;
}

interface ActiveCanvasGeometryGesture {
  nodeId: string;
  kind: CanvasGeometryGestureKind;
  startX: number;
  startY: number;
  original: CanvasLayout;
  card: HTMLElement;
}

function finiteDatasetNumber(
  card: HTMLElement,
  key: 'canvasLayoutX' | 'canvasLayoutY' | 'canvasLayoutWidth' | 'canvasLayoutHeight',
): number | null {
  const value = Number(card.dataset[key]);
  return Number.isFinite(value) ? value : null;
}

function layoutFromCard(card: HTMLElement): CanvasLayout | null {
  const x = finiteDatasetNumber(card, 'canvasLayoutX');
  const y = finiteDatasetNumber(card, 'canvasLayoutY');
  const width = finiteDatasetNumber(card, 'canvasLayoutWidth');
  const height = finiteDatasetNumber(card, 'canvasLayoutHeight');

  if (
    x === null
    || y === null
    || width === null
    || height === null
    || width <= 0
    || height <= 0
  ) {
    return null;
  }

  return { x, y, width, height };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function proposedCanvasGeometry(
  gesture: ActiveCanvasGeometryGesture,
  clientX: number,
  clientY: number,
): CanvasLayout {
  const dx = clientX - gesture.startX;
  const dy = clientY - gesture.startY;

  if (gesture.kind === 'move') {
    return {
      ...gesture.original,
      x: clamp(
        gesture.original.x + dx,
        -CANVAS_MAX_ABS_POSITION,
        CANVAS_MAX_ABS_POSITION,
      ),
      y: clamp(
        gesture.original.y + dy,
        -CANVAS_MAX_ABS_POSITION,
        CANVAS_MAX_ABS_POSITION,
      ),
    };
  }

  return {
    ...gesture.original,
    width: clamp(
      gesture.original.width + dx,
      CANVAS_MIN_NODE_WIDTH,
      CANVAS_MAX_NODE_WIDTH,
    ),
    height: clamp(
      gesture.original.height + dy,
      CANVAS_MIN_NODE_HEIGHT,
      CANVAS_MAX_NODE_HEIGHT,
    ),
  };
}

function applyCanvasGeometryPreview(
  gesture: ActiveCanvasGeometryGesture,
  proposed: CanvasLayout,
): void {
  const { card } = gesture;
  card.dataset.canvasGeometryPreview = gesture.kind;
  card.dataset.canvasPreviewX = String(proposed.x);
  card.dataset.canvasPreviewY = String(proposed.y);
  card.dataset.canvasPreviewWidth = String(proposed.width);
  card.dataset.canvasPreviewHeight = String(proposed.height);

  if (gesture.kind === 'move') {
    card.style.transform = `translate(${proposed.x - gesture.original.x}px, ${proposed.y - gesture.original.y}px)`;
    return;
  }

  card.style.width = `${proposed.width}px`;
  card.style.height = `${proposed.height}px`;
}

function clearCanvasGeometryPreview(
  gesture: ActiveCanvasGeometryGesture,
): void {
  const { card } = gesture;
  delete card.dataset.canvasGeometryPreview;
  delete card.dataset.canvasPreviewX;
  delete card.dataset.canvasPreviewY;
  delete card.dataset.canvasPreviewWidth;
  delete card.dataset.canvasPreviewHeight;
  card.style.transform = '';
  card.style.width = '';
  card.style.height = '';
}

export function bindCanvasSurfaceInteractions(
  root: HTMLElement,
  handlers: CanvasSurfaceHandlers,
): void {
  let activeGeometry: ActiveCanvasGeometryGesture | null = null;

  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-canvas-action]');
    if (!control || !root.contains(control)) return;

    if (control.dataset.canvasAction === 'close-node') {
      handlers.closeNode();
      return;
    }

    if (control.dataset.canvasAction === 'request-remove') {
      const nodeId = control.dataset.canvasNodeId;
      if (!nodeId) return;
      handlers.requestRemove?.(nodeId);
      return;
    }

    if (control.dataset.canvasAction === 'cancel-remove') {
      handlers.cancelRemove?.();
      return;
    }

    if (control.dataset.canvasAction === 'refuse-remove') {
      const nodeId = control.dataset.canvasNodeId;
      if (!nodeId) return;
      handlers.refuseRemove?.(nodeId);
      return;
    }

    if (control.dataset.canvasAction === 'open-node') {
      const nodeId = control.dataset.canvasNodeId;
      if (!nodeId) return;
      handlers.openNode(nodeId);
      bindInspectorEscape();
    }
  });

  const bindInspectorEscape = (): void => {
    const close = root.querySelector<HTMLElement>(
      '[data-canvas-action="close-node"][data-c1-key="canvas-node-inspector-close"]',
    );
    if (!close || close.dataset.canvasEscapeBound === 'true') return;

    close.dataset.canvasEscapeBound = 'true';
    close.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      handlers.closeNode();
    });
  };

  bindInspectorEscape();

  root
    .querySelectorAll<HTMLElement>(
      '[data-canvas-action="open-node"][data-canvas-node-id]',
    )
    .forEach((card) => {
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;

        const nodeId = card.dataset.canvasNodeId;
        if (!nodeId) return;

        event.preventDefault();
        handlers.openNode(nodeId);
        bindInspectorEscape();
      });
    });

  root.addEventListener('pointerdown', (event) => {
    const handle = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-canvas-geometry-handle]');
    if (!handle || !root.contains(handle)) return;

    const kind = handle.dataset.canvasGeometryHandle;
    if (kind !== 'move' && kind !== 'resize') return;

    const card = handle.closest<HTMLElement>(
      '[data-canvas-node-id][data-canvas-layout-x][data-canvas-layout-y][data-canvas-layout-width][data-canvas-layout-height]',
    );
    if (!card || !root.contains(card)) return;

    const nodeId = card.dataset.canvasNodeId;
    const original = layoutFromCard(card);
    if (!nodeId || original === null) return;

    event.preventDefault();
    activeGeometry = {
      nodeId,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      original,
      card,
    };
  });

  root.addEventListener('pointermove', (event) => {
    if (activeGeometry === null) return;

    event.preventDefault();
    applyCanvasGeometryPreview(
      activeGeometry,
      proposedCanvasGeometry(
        activeGeometry,
        event.clientX,
        event.clientY,
      ),
    );
  });

  root.addEventListener('pointerup', (event) => {
    if (activeGeometry === null) return;

    event.preventDefault();
    const gesture = activeGeometry;
    activeGeometry = null;

    const proposed = proposedCanvasGeometry(
      gesture,
      event.clientX,
      event.clientY,
    );
    clearCanvasGeometryPreview(gesture);

    handlers.refuseGeometry?.({
      nodeId: gesture.nodeId,
      kind: gesture.kind,
      proposed,
    });
  });

  root.addEventListener('pointercancel', () => {
    if (activeGeometry === null) return;

    const gesture = activeGeometry;
    activeGeometry = null;
    clearCanvasGeometryPreview(gesture);
  });
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
