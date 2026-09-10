/** Capability-free visible canvas surface state and detailed read-only card interactions. */

import type { ActionErrorCode } from '../app/actionProtocol.js';
import type { IdGenerator } from '../domain/clock.js';
import type { CanvasNode } from '../domain/canvas.js';
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

export interface CanvasSurfaceViewState {
  selectedNodeId: string | null;
}

export const EMPTY_CANVAS_SURFACE_VIEW: CanvasSurfaceViewState = {
  selectedNodeId: null,
};

export interface CanvasSurfaceHandlers {
  openNode(nodeId: string): void;
  closeNode(): void;
}

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

  return `<section class="surface canvas-surface" data-c1-key="canvas-region" aria-label="Canvas" data-canvas-write-authority="unavailable"><header class="surface-header"><div><p class="eyebrow">Workspace canvas</p><h2>Canvas</h2><p class="surface-description">Drop files to create passive, one-shot file cards. Select a card to inspect it.</p></div><span class="surface-count">${state.items.length} items</span></header><div class="canvas-drop-zone" data-c1-key="canvas-drop-zone" aria-label="Canvas drop zone">${cards || '<p class="empty-state">Drop a file here.</p>'}</div>${diagnostic}${canvasInspector(state, selectedNodeId)}</section>`;
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

  return `<article class="canvas-card${selected ? ' selected' : ''}" role="button" tabindex="0" aria-pressed="${selected}" data-canvas-action="open-node" data-c1-key="canvas-card-${escapeHtml(node.id)}" data-canvas-node-id="${escapeHtml(node.id)}" data-canvas-source-kind="${escapeHtml(node.source.kind)}"><header>${iconMarkup}<strong>${escapeHtml(selection.filename)}</strong><span>${escapeHtml(label)}${escapeHtml(previewFailure)}</span></header>${image}${drawingSvg}${textMarkup}<p>${escapeHtml(selection.extension || 'no extension')} · ${escapeHtml(size)} · ${escapeHtml(modified)}</p><footer><span>${escapeHtml(sourceState)}${escapeHtml(reason)}</span></footer></article>`;
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

  return `<section class="canvas-node-inspector" role="dialog" aria-modal="false" aria-label="Canvas item details" data-canvas-inspector-node-id="${escapeHtml(node.id)}" data-c1-key="canvas-node-inspector"><header><div><small>Canvas item</small><h3>${escapeHtml(selection.filename)}</h3></div><button type="button" class="icon-button" data-canvas-action="close-node" data-c1-key="canvas-node-inspector-close" aria-label="Close canvas item details">×</button></header><dl class="canvas-node-fields">${field('Node ID', node.id)}${field('Representation', selection.kind)}${field('Admission', item.status)}${field('Source kind', node.source.kind)}${field(node.source.kind === 'vault-file' ? 'Source path' : 'Ephemeral source ID', sourceIdentity)}${field('Source state', node.source.state)}${field('Revision', node.source.revision)}${field('Size', node.source.size)}${field('Modified', node.source.modifiedAt)}${field('X', node.layout.x)}${field('Y', node.layout.y)}${field('Width', node.layout.width)}${field('Height', node.layout.height)}</dl><footer><button type="button" disabled aria-disabled="true" data-canvas-write-action="move-resize" data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}">Move / resize unavailable</button><button type="button" disabled aria-disabled="true" data-canvas-write-action="remove" data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}">Remove unavailable</button><small data-canvas-write-refusal="${CANVAS_SURFACE_WRITE_REFUSAL}">Unavailable until record-store cutover</small></footer></section>`;
}

export function bindCanvasSurfaceInteractions(
  root: HTMLElement,
  handlers: CanvasSurfaceHandlers,
): void {
  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement)
      .closest<HTMLElement>('[data-canvas-action]');
    if (!control || !root.contains(control)) return;

    if (control.dataset.canvasAction === 'close-node') {
      handlers.closeNode();
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
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
