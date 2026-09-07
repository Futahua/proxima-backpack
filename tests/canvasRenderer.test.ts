import { describe, expect, it } from 'vitest';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import { createCanvasNode } from '../src/domain/canvas.js';
import {
  MAX_CANVAS_TEXT_CHARS,
  selectCanvasRepresentation,
} from '../src/domain/canvasRenderer.js';

const source = (path: string, state: 'available' | 'missing' | 'unavailable' = 'available') => ({
  kind: 'vault-file' as const,
  path,
  state,
  revision: 'r1',
  size: 42,
  modifiedAt: '2026-09-07T00:00:00.000Z',
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const nativeScene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] });

describe('Gate 8 renderer-selection contract', () => {
  it('selects bounded Markdown/text payloads', () => {
    const selected = selectCanvasRepresentation(source('Notes/readme.md'), { kind: 'text', text: '# hello' });
    expect(selected).toMatchObject({ kind: 'text', extension: 'md', reason: null, mediaType: null });
  });

  it('selects Excalidraw by structure rather than filename', () => {
    const selected = selectCanvasRepresentation(source('Notes/diagram.data'), { kind: 'text', text: nativeScene });
    expect(selected.kind).toBe('excalidraw');
  });

  it('selects raster images by byte signature, not extension', () => {
    const selected = selectCanvasRepresentation(source('Notes/photo.bin'), { kind: 'binary', bytes: png });
    expect(selected).toMatchObject({ kind: 'raster-image', mediaType: 'image/png', reason: null });
  });

  it('keeps SVG and invalid image bytes in passive fallback', () => {
    expect(selectCanvasRepresentation(source('Notes/shape.svg'), { kind: 'binary', bytes: png })).toMatchObject({ kind: 'fallback', reason: 'active-content' });
    expect(selectCanvasRepresentation(source('Notes/photo.png'), { kind: 'binary', bytes: new Uint8Array(12) })).toMatchObject({ kind: 'fallback', reason: 'unsupported-media' });
  });

  it('keeps HTML, JavaScript, executables and unknown formats passive', () => {
    for (const path of ['page.html', 'script.js', 'tool.exe', 'thing.xyz']) {
      expect(selectCanvasRepresentation(source(path), { kind: 'text', text: 'not executable' }).kind).toBe('fallback');
    }
    expect(selectCanvasRepresentation(source('thing.xyz'), { kind: 'text', text: 'not executable' }).reason).toBe('unsupported-format');
  });

  it('does not preview missing or unavailable sources', () => {
    expect(selectCanvasRepresentation(source('photo.png', 'missing'), { kind: 'binary', bytes: png })).toMatchObject({ kind: 'fallback', reason: 'source-missing' });
    expect(selectCanvasRepresentation(source('photo.png', 'unavailable'), { kind: 'binary', bytes: png })).toMatchObject({ kind: 'fallback', reason: 'source-unavailable' });
    expect(selectCanvasRepresentation(source('photo.png'), null)).toMatchObject({ kind: 'fallback', reason: 'payload-unavailable' });
  });

  it('bounds text before classification', () => {
    const selected = selectCanvasRepresentation(source('Notes/readme.md'), { kind: 'text', text: 'x'.repeat(MAX_CANVAS_TEXT_CHARS + 1) });
    expect(selected).toMatchObject({ kind: 'fallback', reason: 'payload-too-large' });
  });

  it('does not require a reader or alter the canvas node model', () => {
    const node = createCanvasNode(sequentialIdGenerator(), { path: 'photo.png', state: 'available' });
    const selected = selectCanvasRepresentation(node.source, { kind: 'binary', bytes: png });
    expect(node.representation.kind).toBe('fallback');
    expect(selected.sourcePath).toBe(node.source.path);
  });
});
