import { describe, expect, it } from 'vitest';
import { createCanvasPreviewRegistry, disposeCanvasPreviewsOnPageHide, MAX_CANVAS_PREVIEW_BYTES, MAX_CANVAS_PREVIEW_ITEMS } from '../src/browser/canvasPreview.js';
import type { CanvasRasterPreviewSeed } from '../src/browser/canvasFileAdmission.js';

const seed: CanvasRasterPreviewSeed = { kind: 'raster-image', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };

function urls() {
  const created: string[] = [];
  const revoked: string[] = [];
  let next = 0;
  return {
    created, revoked,
    port: { createObjectURL: () => { const url = `blob:test-${++next}`; created.push(url); return url; }, revokeObjectURL: (url: string) => { revoked.push(url); } },
  };
}

describe('Gate 8D browser raster preview registry', () => {
  it('owns URLs and revokes replacement, removal and clear exactly once', () => {
    const io = urls();
    const registry = createCanvasPreviewRegistry(io.port);
    expect(registry.install('node-1', seed)).toBe(true);
    const first = registry.get('node-1');
    expect(first?.url).toBe('blob:test-1');
    expect(registry.install('node-1', { ...seed, bytes: new Uint8Array([4]) })).toBe(true);
    expect(io.revoked).toEqual(['blob:test-1']);
    registry.remove('node-1');
    registry.remove('node-1');
    expect(io.revoked).toEqual(['blob:test-1', 'blob:test-2']);
    registry.clear();
    expect(io.revoked).toEqual(['blob:test-1', 'blob:test-2']);
    expect(registry.totalBytes()).toBe(0);
  });

  it('enforces aggregate byte and item budgets before URL creation', () => {
    const io = urls();
    const registry = createCanvasPreviewRegistry(io.port);
    const bytes = new Uint8Array(MAX_CANVAS_PREVIEW_BYTES / 2);
    expect(registry.install('a', { ...seed, bytes })).toBe(true);
    expect(registry.install('b', { ...seed, bytes })).toBe(true);
    expect(registry.install('c', seed)).toBe(false);
    registry.clear();
    for (let index = 0; index < MAX_CANVAS_PREVIEW_ITEMS; index += 1) expect(registry.install(`n${index}`, seed)).toBe(true);
    expect(registry.install('overflow', seed)).toBe(false);
  });

  it('keeps the old URL when replacement creation fails and rejects non-blob URLs', () => {
    const revoked: string[] = [];
    let calls = 0;
    const registry = createCanvasPreviewRegistry({
      createObjectURL: () => { calls += 1; if (calls > 1) throw new Error('quota'); return 'blob:good'; },
      revokeObjectURL: (url) => revoked.push(url),
    });
    expect(registry.install('node', seed)).toBe(true);
    expect(registry.install('node', seed)).toBe(false);
    expect(registry.get('node')?.url).toBe('blob:good');
    expect(revoked).toEqual([]);
    const bad = createCanvasPreviewRegistry({ createObjectURL: () => 'https://bad', revokeObjectURL: (url) => revoked.push(url) });
    expect(bad.install('node', seed)).toBe(false);
    expect(revoked).toContain('https://bad');
  });

  it('preserves previews for BFCache pagehide and clears on discarded pagehide', () => {
    const io = urls();
    const registry = createCanvasPreviewRegistry(io.port);
    registry.install('node', seed);
    disposeCanvasPreviewsOnPageHide({ persisted: true }, registry);
    expect(registry.get('node')?.url).toBe('blob:test-1');
    disposeCanvasPreviewsOnPageHide({ persisted: false }, registry);
    expect(registry.get('node')).toBeNull();
    expect(io.revoked).toEqual(['blob:test-1']);
  });
});
