import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import { createCanvasNode } from '../src/domain/canvas.js';
import { MAX_CANVAS_BINARY_BYTES } from '../src/domain/canvasRenderer.js';
import { loadCanvasNode } from '../src/app/canvasLoader.js';
import type { VaultReader } from '../src/ports/vault.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const nativeScene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] });

function node(path: string) {
  return createCanvasNode(sequentialIdGenerator(), { path, state: 'available' }, { x: 10, y: 20, width: 400, height: 300 });
}

describe('Gate 8 source loader', () => {
  it('reads text through VaultReader and preserves node identity/layout plus read provenance', async () => {
    const vault = createMemoryVault({ 'Notes/diagram.md': nativeScene });
    const before = node('Notes/diagram.md');
    const result = await loadCanvasNode(vault, before);
    expect(result.status).toBe('selected');
    expect(result.selection.kind).toBe('excalidraw');
    expect(result.node.id).toBe(before.id);
    expect(result.node.layout).toEqual(before.layout);
    expect(result.node.source.revision).toBe('Notes/diagram.md@1');
    expect(result.node.source.size).toBe(nativeScene.length);
  });

  it('keeps native and unknown-extension Excalidraw structural selection reachable', async () => {
    const native = createMemoryVault({ 'Drawings/example.excalidraw': nativeScene, 'Drawings/example.data': nativeScene });
    expect((await loadCanvasNode(native, node('Drawings/example.excalidraw'))).selection.kind).toBe('excalidraw');
    expect((await loadCanvasNode(native, node('Drawings/example.data'))).selection.kind).toBe('excalidraw');
  });

  it('passes the text bound to the source read seam', async () => {
    let bound: number | undefined;
    const base = createMemoryVault({ 'Notes/readme.md': '# hi' });
    const vault: VaultReader = { ...base, read: async (path, maxChars) => { bound = maxChars; return base.read(path, maxChars); } };
    await loadCanvasNode(vault, node('Notes/readme.md'));
    expect(bound).toBe(1_000_000);
  });

  it('uses the bounded binary seam and admits images by signature', async () => {
    const calls: number[] = [];
    const base = createMemoryVault({ 'Notes/photo.bin': 'not text' });
    const vault: VaultReader = {
      ...base,
      readBinary: async (path, maxBytes) => {
        calls.push(maxBytes);
        return { path, bytes: png, size: png.length, revision: 'binary-r2', modifiedAt: '2026-09-07T01:00:00.000Z' };
      },
    };
    const result = await loadCanvasNode(vault, node('Notes/photo.bin'));
    expect(calls).toEqual([MAX_CANVAS_BINARY_BYTES]);
    expect(result.selection).toMatchObject({ kind: 'raster-image', mediaType: 'image/png' });
    expect(result.node.source.revision).toBe('binary-r2');
  });

  it('does not read active-content extensions', async () => {
    let reads = 0;
    const base = createMemoryVault({ 'Notes/page.svg': nativeScene });
    const vault: VaultReader = { ...base, read: async () => { reads += 1; throw new Error('must not read'); } };
    const result = await loadCanvasNode(vault, node('Notes/page.svg'));
    expect(reads).toBe(0);
    expect(result.status).toBe('active-content-skipped');
    expect(result.selection).toMatchObject({ kind: 'fallback', reason: 'active-content' });
  });

  it('fails closed when binary capability is absent', async () => {
    const result = await loadCanvasNode(createMemoryVault({ 'Notes/photo.png': 'bytes' }), node('Notes/photo.png'));
    expect(result.status).toBe('binary-capability-unavailable');
    expect(result.selection).toMatchObject({ kind: 'fallback', reason: 'payload-unavailable' });
  });

  it('turns source read failure into an unavailable node without throwing', async () => {
    const base = createMemoryVault({ 'Notes/readme.md': '# hi' });
    const vault: VaultReader = { ...base, read: async () => { throw new Error('permission denied'); } };
    const before = node('Notes/readme.md');
    const result = await loadCanvasNode(vault, before);
    expect(result.status).toBe('unreadable');
    expect(result.node.id).toBe(before.id);
    expect(result.node.layout).toEqual(before.layout);
    expect(result.node.source.state).toBe('unavailable');
    expect(result.selection).toMatchObject({ kind: 'fallback', reason: 'source-unavailable' });
  });
});
