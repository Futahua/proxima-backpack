import { renderExcalidrawSvg, type ExcalidrawRenderCensus, type ExcalidrawRenderProblem } from '../domain/excalidrawRender.js';
import type { CanvasExcalidrawPreviewSeed } from './canvasFileAdmission.js';

export const MAX_CANVAS_EXCALIDRAW_SVG_CHARS = 8_000_000;
export const MAX_CANVAS_EXCALIDRAW_PREVIEW_CHARS = 32_000_000;
export const MAX_CANVAS_EXCALIDRAW_PREVIEW_ITEMS = 16;

export interface CanvasExcalidrawPresentation {
  kind: 'excalidraw';
  svg: string;
  census: ExcalidrawRenderCensus;
  problems: readonly ExcalidrawRenderProblem[];
  charLength: number;
}

export interface CanvasExcalidrawPreviewRegistry {
  install(nodeId: string, seed: CanvasExcalidrawPreviewSeed): boolean;
  get(nodeId: string): CanvasExcalidrawPresentation | null;
  snapshot(): ReadonlyMap<string, CanvasExcalidrawPresentation>;
  remove(nodeId: string): void;
  clear(): void;
  totalChars(): number;
}

/** Clear generated SVGs only when the page is actually discarded. */
export function disposeCanvasExcalidrawPreviewsOnPageHide(
  event: Pick<PageTransitionEvent, 'persisted'>,
  registry: CanvasExcalidrawPreviewRegistry,
): void {
  if (!event.persisted) registry.clear();
}

export function createCanvasExcalidrawPreviewRegistry(): CanvasExcalidrawPreviewRegistry {
  const entries = new Map<string, CanvasExcalidrawPresentation>();
  let totalChars = 0;
  return {
    install(nodeId, seed) {
      let rendered: ReturnType<typeof renderExcalidrawSvg>;
      try { rendered = renderExcalidrawSvg(seed.scene, {}); }
      catch { return false; }
      const svg = rendered.svg;
      const previous = entries.get(nodeId);
      const nextChars = totalChars - (previous?.charLength ?? 0) + svg.length;
      if (svg.length > MAX_CANVAS_EXCALIDRAW_SVG_CHARS
        || (entries.size >= MAX_CANVAS_EXCALIDRAW_PREVIEW_ITEMS && !previous)
        || nextChars > MAX_CANVAS_EXCALIDRAW_PREVIEW_CHARS) return false;
      const presentation: CanvasExcalidrawPresentation = {
        kind: 'excalidraw',
        svg,
        census: rendered.census,
        problems: rendered.problems.map((problem) => ({ ...problem })),
        charLength: svg.length,
      };
      entries.set(nodeId, presentation);
      totalChars = nextChars;
      return true;
    },
    get: (nodeId) => entries.get(nodeId) ?? null,
    snapshot: () => new Map(entries),
    remove(nodeId) {
      const previous = entries.get(nodeId);
      if (!previous) return;
      entries.delete(nodeId);
      totalChars -= previous.charLength;
    },
    clear() { entries.clear(); totalChars = 0; },
    totalChars: () => totalChars,
  };
}
