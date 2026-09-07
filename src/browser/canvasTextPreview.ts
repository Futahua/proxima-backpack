import type { CanvasTextPreviewSeed } from './canvasFileAdmission.js';

export const MAX_CANVAS_TEXT_PREVIEW_CHARS = 200_000;
export const MAX_CANVAS_TEXT_PREVIEW_TOTAL_CHARS = 2_000_000;
export const MAX_CANVAS_TEXT_PREVIEW_ITEMS = 32;

export type CanvasTextPreviewFailure = 'preview-too-large' | 'preview-budget-exhausted';

export interface CanvasTextPresentation {
  kind: 'text';
  text: string;
  charLength: number;
}

export interface CanvasTextPreviewSnapshot {
  presentation: CanvasTextPresentation | null;
  failure: CanvasTextPreviewFailure | null;
}

export interface CanvasTextPreviewRegistry {
  install(nodeId: string, seed: CanvasTextPreviewSeed): boolean;
  get(nodeId: string): CanvasTextPreviewSnapshot;
  snapshot(): ReadonlyMap<string, CanvasTextPreviewSnapshot>;
  remove(nodeId: string): void;
  clear(): void;
  totalChars(): number;
}

/** Browser-only literal text ownership; no parser or markup interpretation. */
export function createCanvasTextPreviewRegistry(): CanvasTextPreviewRegistry {
  const entries = new Map<string, CanvasTextPreviewSnapshot>();
  let totalChars = 0;
  return {
    install(nodeId, seed) {
      const previous = entries.get(nodeId);
      const previousChars = previous?.presentation?.charLength ?? 0;
      const replacing = previous !== undefined;
      if (seed.text.length > MAX_CANVAS_TEXT_PREVIEW_CHARS) {
        if (!replacing && entries.size >= MAX_CANVAS_TEXT_PREVIEW_ITEMS) return false;
        entries.set(nodeId, { presentation: null, failure: 'preview-too-large' });
        totalChars -= previousChars;
        return false;
      }
      const nextChars = totalChars - previousChars + seed.text.length;
      if ((entries.size >= MAX_CANVAS_TEXT_PREVIEW_ITEMS && !replacing) || nextChars > MAX_CANVAS_TEXT_PREVIEW_TOTAL_CHARS) {
        if (!replacing && entries.size >= MAX_CANVAS_TEXT_PREVIEW_ITEMS) return false;
        entries.set(nodeId, { presentation: null, failure: 'preview-budget-exhausted' });
        totalChars -= previousChars;
        return false;
      }
      const text = seed.text;
      entries.set(nodeId, { presentation: { kind: 'text', text, charLength: text.length }, failure: null });
      totalChars = nextChars;
      return true;
    },
    get: (nodeId) => entries.get(nodeId) ?? { presentation: null, failure: null },
    snapshot: () => new Map(entries),
    remove(nodeId) {
      const previous = entries.get(nodeId);
      if (!previous) return;
      entries.delete(nodeId);
      totalChars -= previous.presentation?.charLength ?? 0;
    },
    clear() { entries.clear(); totalChars = 0; },
    totalChars: () => totalChars,
  };
}

export function disposeCanvasTextPreviewsOnPageHide(
  event: Pick<PageTransitionEvent, 'persisted'>,
  registry: CanvasTextPreviewRegistry,
): void {
  if (!event.persisted) registry.clear();
}
