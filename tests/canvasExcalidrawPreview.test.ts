import { describe, expect, it } from 'vitest';
import { createCanvasExcalidrawPreviewRegistry, disposeCanvasExcalidrawPreviewsOnPageHide, MAX_CANVAS_EXCALIDRAW_PREVIEW_ITEMS } from '../src/browser/canvasExcalidrawPreview.js';

const seed = { kind: 'excalidraw' as const, scene: { type: 'excalidraw', elements: [{ type: 'text', x: 0, y: 0, text: 'hello', fontSize: 16 }] } };

describe('Gate 8E scene-only Excalidraw preview registry', () => {
  it('renders generated SVG and retains census without retaining the scene', () => {
    const registry = createCanvasExcalidrawPreviewRegistry();
    expect(registry.install('node', seed)).toBe(true);
    const preview = registry.get('node');
    expect(preview?.svg).toContain('<svg');
    expect(preview?.svg).toContain('hello');
    expect(preview?.census.rendered).toBe(1);
    expect(preview?.charLength).toBe(preview?.svg.length);
    expect(JSON.stringify(preview)).not.toContain('elements');
    expect(registry.totalChars()).toBe(preview?.svg.length);
  });

  it('is bounded, replacement-safe, removable and idempotently clearable', () => {
    const registry = createCanvasExcalidrawPreviewRegistry();
    for (let index = 0; index < MAX_CANVAS_EXCALIDRAW_PREVIEW_ITEMS; index += 1) expect(registry.install(`n${index}`, seed)).toBe(true);
    expect(registry.install('overflow', seed)).toBe(false);
    const before = registry.totalChars();
    expect(registry.install('n0', seed)).toBe(true);
    expect(registry.totalChars()).toBe(before);
    registry.remove('n0');
    registry.remove('n0');
    expect(registry.totalChars()).toBeLessThan(before);
    registry.clear();
    registry.clear();
    expect(registry.snapshot().size).toBe(0);
    expect(registry.totalChars()).toBe(0);
  });

  it('preserves generated previews in BFCache and clears on discarded pagehide', () => {
    const registry = createCanvasExcalidrawPreviewRegistry();
    registry.install('node', seed);
    disposeCanvasExcalidrawPreviewsOnPageHide({ persisted: true }, registry);
    expect(registry.get('node')).not.toBeNull();
    disposeCanvasExcalidrawPreviewsOnPageHide({ persisted: false }, registry);
    expect(registry.get('node')).toBeNull();
  });
});
