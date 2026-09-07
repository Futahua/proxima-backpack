import { describe, expect, it } from 'vitest';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import { MAX_CANVAS_BINARY_BYTES, MAX_CANVAS_TEXT_CHARS } from '../src/domain/canvasRenderer.js';
import { admitCanvasFile, type BrowserFileLike } from '../src/browser/canvasFileAdmission.js';
import { markCanvasNodeUnavailable } from '../src/domain/canvas.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] });

function file(name: string, bytes: Uint8Array, extra: Partial<BrowserFileLike> = {}): BrowserFileLike {
  return {
    name,
    size: bytes.length,
    lastModified: Date.parse('2026-09-07T02:00:00.000Z'),
    type: 'application/octet-stream',
    arrayBuffer: async () => bytes.slice().buffer,
    ...extra,
  };
}

describe('Gate 8B one-shot browser File admission', () => {
  it('separates node and ephemeral source identities and copies display provenance', async () => {
    const ids = sequentialIdGenerator();
    const first = await admitCanvasFile(ids, file('report.bin', new TextEncoder().encode('hello')));
    const second = await admitCanvasFile(ids, file('report.bin', new TextEncoder().encode('hello')));
    expect(first.node.id).toBe('canvas-node-0001');
    expect(first.node.source.kind).toBe('browser-file');
    if (first.node.source.kind !== 'browser-file' || second.node.source.kind !== 'browser-file') throw new Error('expected browser sources');
    expect(first.node.source.sourceId).toBe('canvas-source-0001');
    expect(second.node.source.sourceId).not.toBe(first.node.source.sourceId);
    expect(first.node.source.filename).toBe('report.bin');
    expect(first.node.source.path).toBeUndefined();
    expect(first.node.source.size).toBe(5);
  });

  it('skips active content and oversized files without calling arrayBuffer', async () => {
    let reads = 0;
    const active = file('page.svg', png, { arrayBuffer: async () => { reads += 1; return png.buffer; } });
    const blocked = file('large.bin', new Uint8Array(1), { size: MAX_CANVAS_BINARY_BYTES + 1, arrayBuffer: async () => { reads += 1; return new ArrayBuffer(1); } });
    const ids = sequentialIdGenerator();
    const activeResult = await admitCanvasFile(ids, active);
    const largeResult = await admitCanvasFile(ids, blocked);
    expect(reads).toBe(0);
    expect(activeResult).toMatchObject({ status: 'active-content-skipped', selection: { reason: 'active-content' } });
    expect(largeResult).toMatchObject({ status: 'payload-too-large', selection: { reason: 'payload-too-large' } });
  });

  it('uses one bounded acquisition for structural Excalidraw and unknown raster files', async () => {
    let reads = 0;
    const ids = sequentialIdGenerator();
    const drawing = file('drawing.excalidraw', new TextEncoder().encode(scene), { arrayBuffer: async () => { reads += 1; return new TextEncoder().encode(scene).buffer; } });
    const selectedDrawing = await admitCanvasFile(ids, drawing);
    expect(selectedDrawing.selection.kind).toBe('excalidraw');
    const unknownRaster = file('photo.bin', png, { arrayBuffer: async () => { reads += 1; return png.buffer; } });
    const selectedRaster = await admitCanvasFile(ids, unknownRaster);
    expect(selectedRaster.selection).toMatchObject({ kind: 'raster-image', mediaType: 'image/png' });
    expect(reads).toBe(2);
  });

  it('applies the decoded text bound without a second read', async () => {
    let reads = 0;
    const huge = new TextEncoder().encode('x'.repeat(MAX_CANVAS_TEXT_CHARS + 1));
    const result = await admitCanvasFile(sequentialIdGenerator(), file('notes.md', huge, { arrayBuffer: async () => { reads += 1; return huge.buffer; } }));
    expect(reads).toBe(1);
    expect(result.selection).toMatchObject({ kind: 'fallback', reason: 'payload-too-large' });
  });

  it('makes restart explicit without filename-based rebinding', async () => {
    const result = await admitCanvasFile(sequentialIdGenerator(), file('report.txt', new TextEncoder().encode('hello')));
    const restarted = markCanvasNodeUnavailable(result.node);
    expect(restarted.id).toBe(result.node.id);
    expect(restarted.layout).toEqual(result.node.layout);
    expect(restarted.source).toMatchObject({ kind: 'browser-file', state: 'unavailable', filename: 'report.txt' });
    if (restarted.source.kind !== 'browser-file' || result.node.source.kind !== 'browser-file') throw new Error('expected browser sources');
    expect(restarted.source.sourceId).toBe(result.node.source.sourceId);
  });
});
