import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCanvasNode,
  markCanvasNodeUnavailable,
} from '../src/domain/canvas.js';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import {
  admitCanvasFile,
  type BrowserFileLike,
} from '../src/browser/canvasFileAdmission.js';
import {
  admitCanvasDrop,
  renderCanvasSurface,
} from '../src/browser/canvasSurface.js';

function file(
  name: string,
  bytes: Uint8Array,
): BrowserFileLike {
  return {
    name,
    size: bytes.length,
    lastModified: Date.parse(
      '2026-09-07T02:00:00.000Z',
    ),
    type: 'application/octet-stream',
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

const CANVAS_SOURCES = [
  'src/domain/canvas.ts',
  'src/browser/canvasFileAdmission.ts',
  'src/browser/canvasSurface.ts',
  'src/ports/vault.ts',
].map((path) => ({
  path,
  source: readFileSync(
    resolve(process.cwd(), path),
    'utf8',
  ),
}));

describe('Gate 9.1 native open/reveal acceptance gap', () => {
  it('already shows an unsupported creator-selected external file as a visible passive Canvas card', async () => {
    const state = await admitCanvasDrop(
      [
        file(
          'opaque.vendorblob',
          new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        ),
      ],
      undefined,
      sequentialIdGenerator(),
    );

    expect(state.items).toHaveLength(1);

    const item = state.items[0]!;
    expect(item).toMatchObject({
      status: 'selected',
      selection: {
        kind: 'fallback',
        sourceKind: 'browser-file',
        sourcePath: null,
        filename: 'opaque.vendorblob',
        extension: 'vendorblob',
        sourceState: 'available',
        reason: 'unsupported-media',
      },
    });

    const markup = renderCanvasSurface(state);

    expect(markup).toContain('opaque.vendorblob');
    expect(markup).toContain('Fallback file');
    expect(markup).toContain('unsupported media');
    expect(markup).toContain(
      'data-canvas-source-kind="browser-file"',
    );

    expect(markup).not.toContain(
      'data-canvas-action="open-source"',
    );
    expect(markup).not.toContain(
      'data-canvas-action="reveal-source"',
    );
  });

  it('consumes a browser File once and retains no exact native handoff capability in Canvas state', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let reads = 0;

    const admitted = await admitCanvasFile(
      sequentialIdGenerator(),
      {
        ...file('external.vendorblob', bytes),
        arrayBuffer: async () => {
          reads += 1;
          return bytes.slice().buffer;
        },
      },
    );

    expect(reads).toBe(1);
    expect(admitted.node.source.kind)
      .toBe('browser-file');

    if (admitted.node.source.kind !== 'browser-file') {
      throw new Error('expected browser-file source');
    }

    const source = admitted.node.source;

    expect(source).toMatchObject({
      kind: 'browser-file',
      filename: 'external.vendorblob',
      extension: 'vendorblob',
      state: 'available',
      revision: null,
    });
    expect(source.path).toBeUndefined();

    for (const key of [
      'arrayBuffer',
      'file',
      'handle',
      'fileHandle',
      'nativePath',
      'absolutePath',
      'opaqueNativeRef',
      'open',
      'reveal',
    ]) {
      expect(key in source).toBe(false);
    }

    expect(JSON.stringify(admitted))
      .not.toContain('arrayBuffer');

    const restarted = markCanvasNodeUnavailable(
      admitted.node,
    );

    expect(restarted.source.kind)
      .toBe('browser-file');

    if (restarted.source.kind !== 'browser-file') {
      throw new Error('expected browser-file source');
    }

    expect(restarted.source).toMatchObject({
      sourceId: source.sourceId,
      filename: source.filename,
      state: 'unavailable',
      revision: null,
    });
    expect(restarted.source.path).toBeUndefined();
  });

  it('keeps vault-backed Canvas identity vault-relative rather than inventing a native machine locator', () => {
    const node = createCanvasNode(
      sequentialIdGenerator(),
      {
        path: 'Attachments/native-only.vendorblob',
        state: 'available',
        revision: 'vault-r1',
        size: 4,
        modifiedAt: '2026-09-07T02:00:00.000Z',
      },
    );

    expect(node.source.kind).toBe('vault-file');

    if (node.source.kind !== 'vault-file') {
      throw new Error('expected vault-file source');
    }

    expect(node.source).toMatchObject({
      kind: 'vault-file',
      path: 'Attachments/native-only.vendorblob',
      revision: 'vault-r1',
    });

    for (const key of [
      'absolutePath',
      'nativePath',
      'fileHandle',
      'opaqueNativeRef',
      'open',
      'reveal',
    ]) {
      expect(key in node.source).toBe(false);
    }

    expect(() =>
      createCanvasNode(
        sequentialIdGenerator(),
        {
          path: 'C:\\Users\\creator\\native-only.vendorblob',
          state: 'available',
        },
      ),
    ).toThrow('vault-relative path is invalid');
  });

  it('has no native open/reveal primitive in the current Canvas source/admission/reader boundary', () => {
    const forbiddenNativePrimitives = [
      'showOpenFilePicker(',
      'FileSystemFileHandle',
      'shell.openPath',
      'shell.showItemInFolder',
      'shell.openExternal',
      'data-canvas-action="open-source"',
      'data-canvas-action="reveal-source"',
    ];

    for (const { source } of CANVAS_SOURCES) {
      for (const primitive of forbiddenNativePrimitives) {
        expect(source).not.toContain(primitive);
      }
    }

    const admissionSource = CANVAS_SOURCES.find(
      ({ path }) =>
        path === 'src/browser/canvasFileAdmission.ts',
    )!.source;

    expect(admissionSource).toContain(
      'One-shot admission of a browser File into capability-free canvas state.',
    );
    expect(admissionSource).toContain(
      'without retaining the File capability',
    );
  });
});
