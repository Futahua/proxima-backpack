import type { SupportedImageMedia } from '../domain/imageMedia.js';
import type { CanvasRasterPreviewSeed } from './canvasFileAdmission.js';

export const MAX_CANVAS_PREVIEW_BYTES = 64 * 1024 * 1024;
export const MAX_CANVAS_PREVIEW_ITEMS = 32;

export interface CanvasObjectUrlPort {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface CanvasRasterPresentation {
  kind: 'raster-image';
  url: string;
  mediaType: SupportedImageMedia;
  byteLength: number;
}

export interface CanvasPreviewRegistry {
  install(nodeId: string, seed: CanvasRasterPreviewSeed): boolean;
  get(nodeId: string): CanvasRasterPresentation | null;
  snapshot(): ReadonlyMap<string, CanvasRasterPresentation>;
  remove(nodeId: string): void;
  clear(): void;
  totalBytes(): number;
}

export function createCanvasPreviewRegistry(urls: CanvasObjectUrlPort): CanvasPreviewRegistry {
  const entries = new Map<string, CanvasRasterPresentation>();
  let totalBytes = 0;
  return {
    install(nodeId, seed) {
      const previous = entries.get(nodeId);
      const nextBytes = totalBytes - (previous?.byteLength ?? 0) + seed.bytes.byteLength;
      if (seed.bytes.byteLength > MAX_CANVAS_PREVIEW_BYTES || entries.size >= MAX_CANVAS_PREVIEW_ITEMS && !previous || nextBytes > MAX_CANVAS_PREVIEW_BYTES) return false;
      let url: string;
      try {
        const copy = new Uint8Array(seed.bytes.byteLength);
        copy.set(seed.bytes);
        url = urls.createObjectURL(new Blob([copy.buffer], { type: seed.mediaType }));
      }
      catch { return false; }
      if (!url.startsWith('blob:')) { urls.revokeObjectURL(url); return false; }
      if (previous) urls.revokeObjectURL(previous.url);
      entries.set(nodeId, { kind: 'raster-image', url, mediaType: seed.mediaType, byteLength: seed.bytes.byteLength });
      totalBytes = nextBytes;
      return true;
    },
    get: (nodeId) => entries.get(nodeId) ?? null,
    snapshot: () => new Map(entries),
    remove(nodeId) { const previous = entries.get(nodeId); if (!previous) return; entries.delete(nodeId); totalBytes -= previous.byteLength; urls.revokeObjectURL(previous.url); },
    clear() { for (const entry of entries.values()) urls.revokeObjectURL(entry.url); entries.clear(); totalBytes = 0; },
    totalBytes: () => totalBytes,
  };
}
