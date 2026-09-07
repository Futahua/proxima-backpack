import { describe, expect, it } from 'vitest';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import { admitCanvasDrop, createCanvasDropQueue, MAX_CANVAS_DROP_FILES, renderCanvasSurface } from '../src/browser/canvasSurface.js';
import type { BrowserFileLike } from '../src/browser/canvasFileAdmission.js';
import { createCanvasPreviewRegistry } from '../src/browser/canvasPreview.js';

function file(name: string, bytes: Uint8Array): BrowserFileLike {
  return { name, size: bytes.length, lastModified: 0, type: 'application/octet-stream', arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer };
}

describe('Gate 8C visible passive canvas surface', () => {
  it('renders escaped fallback metadata without embedding content', async () => {
    const state = await admitCanvasDrop([file('<img src=x onerror=alert(1)>.bin', new Uint8Array([1, 2, 3]))], undefined, sequentialIdGenerator());
    const html = renderCanvasSurface(state);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.bin');
    expect(html).toContain('unsupported media');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data:');
    expect(html).not.toContain('arrayBuffer');
  });

  it('shows active and oversized files as visible passive cards', async () => {
    let reads = 0;
    const active = { ...file('page.svg', new Uint8Array([1])), arrayBuffer: async () => { reads += 1; return new ArrayBuffer(1); } };
    const oversized = { ...file('large.bin', new Uint8Array([1])), arrayBuffer: async () => { reads += 1; return new ArrayBuffer(1); } };
    Object.defineProperty(oversized, 'size', { value: 16 * 1024 * 1024 + 1 });
    const state = await admitCanvasDrop([active, oversized], undefined, sequentialIdGenerator());
    const html = renderCanvasSurface(state);
    expect(reads).toBe(0);
    expect(html).toContain('active content');
    expect(html).toContain('payload too large');
  });

  it('admits duplicates independently, processes sequentially, and reports a drop limit', async () => {
    let activeReads = 0;
    let maxActive = 0;
    const files = Array.from({ length: MAX_CANVAS_DROP_FILES + 2 }, (_, index) => file(`f${index}.bin`, new Uint8Array([index])));
    const boundedFiles = files.map((item) => ({ ...item, arrayBuffer: async () => { activeReads += 1; maxActive = Math.max(maxActive, activeReads); await Promise.resolve(); activeReads -= 1; return new ArrayBuffer(1); } }));
    const state = await admitCanvasDrop(boundedFiles, undefined, sequentialIdGenerator());
    expect(state.items).toHaveLength(MAX_CANVAS_DROP_FILES);
    expect(state.lastDropDiagnostic).toContain('drop-limit-exceeded');
    expect(maxActive).toBe(1);
    expect(new Set(state.items.map((item) => item.node.id)).size).toBe(MAX_CANVAS_DROP_FILES);
    expect(new Set(state.items.map((item) => item.node.source.kind === 'browser-file' ? item.node.source.sourceId : '')).size).toBe(MAX_CANVAS_DROP_FILES);
  });

  it('keeps only capability-free state across rendering and surface reuse', async () => {
    const first = await admitCanvasDrop([file('one.txt', new TextEncoder().encode('hello'))], undefined, sequentialIdGenerator());
    const second = await admitCanvasDrop([], first, sequentialIdGenerator());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).not.toContain('arrayBuffer');
  });

  it('serializes overlapping drop batches so neither completed batch is lost', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = { ...file('first.bin', new Uint8Array([1])), arrayBuffer: async () => { await firstGate; return new ArrayBuffer(1); } };
    const second = file('second.bin', new Uint8Array([2]));
    const queue = createCanvasDropQueue(sequentialIdGenerator());
    const a = queue.enqueue([first]);
    const b = queue.enqueue([second]);
    releaseFirst();
    await Promise.all([a, b]);
    expect(queue.snapshot().items.map((item) => item.selection.filename)).toEqual(['first.bin', 'second.bin']);
  });

  it('renders only registry-owned blob URLs for admitted raster selections', async () => {
    const registry = createCanvasPreviewRegistry({ createObjectURL: () => 'blob:preview-1', revokeObjectURL: () => undefined });
    const state = await admitCanvasDrop([file('photo.bin', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))], undefined, sequentialIdGenerator(), registry);
    const item = state.items[0];
    const html = renderCanvasSurface(state, registry.snapshot());
    expect(item?.selection.kind).toBe('raster-image');
    expect(html).toContain('src="blob:preview-1"');
    expect(html).not.toContain('data:');
  });
});
