// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import {
  admitCanvasDrop,
  bindCanvasSurfaceInteractions,
  CANVAS_MAX_NODE_HEIGHT,
  CANVAS_MAX_NODE_WIDTH,
  CANVAS_MIN_NODE_HEIGHT,
  CANVAS_MIN_NODE_WIDTH,
  CANVAS_SURFACE_WRITE_REFUSAL,
  EMPTY_CANVAS_SURFACE_VIEW,
  renderCanvasSurface,
  type CanvasGeometryRefusal,
  type CanvasSurfaceViewState,
} from '../src/browser/canvasSurface.js';
import type { BrowserFileLike } from '../src/browser/canvasFileAdmission.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';

function file(name: string): BrowserFileLike {
  const bytes = new TextEncoder().encode(name);
  return {
    name,
    size: bytes.length,
    lastModified: 0,
    type: 'text/plain',
    arrayBuffer: async () =>
      new Uint8Array(bytes).buffer as ArrayBuffer,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 6 slice 2 Canvas geometry preview and refusal', () => {
  it('previews move geometry and refuses release without changing CanvasSurfaceState', async () => {
    const state = await admitCanvasDrop(
      [file('move.txt')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let view: CanvasSurfaceViewState = {
      ...EMPTY_CANVAS_SURFACE_VIEW,
      selectedNodeId: nodeId,
    };
    let refused: CanvasGeometryRefusal | null = null;

    const render = (): void => {
      document.body.innerHTML = renderCanvasSurface(
        state,
        undefined,
        undefined,
        undefined,
        view,
      );
    };
    render();

    bindCanvasSurfaceInteractions(document.body, {
      openNode: () => {},
      closeNode: () => {},
      refuseGeometry: (intent) => {
        refused = {
          ...intent,
          proposed: { ...intent.proposed },
        };
        view = {
          selectedNodeId: intent.nodeId,
          writeRefusal: CANVAS_SURFACE_WRITE_REFUSAL,
          lastRefusedGeometry: refused,
        };
        render();
      },
    });

    const harness = createInteractionHarness(document);
    const gesture = harness.pointerDown(
      `canvas-move-${nodeId}`,
      { clientX: 10, clientY: 10 },
    );

    gesture.move(
      'canvas-drop-zone',
      { clientX: 70, clientY: 55 },
    );

    const card = document.querySelector<HTMLElement>(
      `[data-canvas-node-id="${nodeId}"]`,
    );
    expect(card?.dataset.canvasGeometryPreview).toBe('move');
    expect(card?.dataset.canvasPreviewX).toBe('60');
    expect(card?.dataset.canvasPreviewY).toBe('45');
    expect(card?.style.transform).toBe('translate(60px, 45px)');
    expect(JSON.stringify(state)).toBe(before);

    gesture.release(
      'canvas-drop-zone',
      { clientX: 70, clientY: 55 },
    );

    expect(refused).toEqual({
      nodeId,
      kind: 'move',
      proposed: {
        x: 60,
        y: 45,
        width: 320,
        height: 200,
      },
    });
    expect(
      document.querySelector<HTMLElement>(
        '[data-canvas-geometry-refusal="action-not-available"]',
      )?.dataset.canvasGeometryKind,
    ).toBe('move');
    expect(state.items[0]?.node.layout).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 200,
    });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('previews resize geometry and refuses release without changing node dimensions', async () => {
    const state = await admitCanvasDrop(
      [file('resize.txt')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let refused: CanvasGeometryRefusal | null = null;

    document.body.innerHTML = renderCanvasSurface(
      state,
      undefined,
      undefined,
      undefined,
      { selectedNodeId: nodeId },
    );

    bindCanvasSurfaceInteractions(document.body, {
      openNode: () => {},
      closeNode: () => {},
      refuseGeometry: (intent) => {
        refused = {
          ...intent,
          proposed: { ...intent.proposed },
        };
      },
    });

    const harness = createInteractionHarness(document);
    const gesture = harness.beginResize(
      `canvas-resize-${nodeId}`,
      { clientX: 20, clientY: 20 },
    );

    gesture.move(
      'canvas-drop-zone',
      { clientX: 100, clientY: 80 },
    );

    const card = document.querySelector<HTMLElement>(
      `[data-canvas-node-id="${nodeId}"]`,
    );
    expect(card?.dataset.canvasGeometryPreview).toBe('resize');
    expect(card?.dataset.canvasPreviewWidth).toBe('400');
    expect(card?.dataset.canvasPreviewHeight).toBe('260');
    expect(card?.style.width).toBe('400px');
    expect(card?.style.height).toBe('260px');
    expect(JSON.stringify(state)).toBe(before);

    gesture.release(
      'canvas-drop-zone',
      { clientX: 100, clientY: 80 },
    );

    expect(refused).toEqual({
      nodeId,
      kind: 'resize',
      proposed: {
        x: 0,
        y: 0,
        width: 400,
        height: 260,
      },
    });
    expect(state.items[0]?.node.layout).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 200,
    });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('bounds resize previews while keeping both geometry handles typed unavailable', async () => {
    const state = await admitCanvasDrop(
      [file('bounded.txt')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let refused: CanvasGeometryRefusal | null = null;

    document.body.innerHTML = renderCanvasSurface(state);

    bindCanvasSurfaceInteractions(document.body, {
      openNode: () => {},
      closeNode: () => {},
      refuseGeometry: (intent) => {
        refused = {
          ...intent,
          proposed: { ...intent.proposed },
        };
      },
    });

    const harness = createInteractionHarness(document);

    const minimum = harness.beginResize(
      `canvas-resize-${nodeId}`,
      { clientX: 100, clientY: 100 },
    );
    minimum.move(
      'canvas-drop-zone',
      { clientX: -10_000, clientY: -10_000 },
    );

    let card = document.querySelector<HTMLElement>(
      `[data-canvas-node-id="${nodeId}"]`,
    );
    expect(card?.dataset.canvasPreviewWidth)
      .toBe(String(CANVAS_MIN_NODE_WIDTH));
    expect(card?.dataset.canvasPreviewHeight)
      .toBe(String(CANVAS_MIN_NODE_HEIGHT));

    minimum.release(
      'canvas-drop-zone',
      { clientX: -10_000, clientY: -10_000 },
    );
    const minimumRefusal = refused as CanvasGeometryRefusal | null;
    expect(minimumRefusal?.proposed.width).toBe(CANVAS_MIN_NODE_WIDTH);
    expect(minimumRefusal?.proposed.height).toBe(CANVAS_MIN_NODE_HEIGHT);

    const maximum = harness.beginResize(
      `canvas-resize-${nodeId}`,
      { clientX: 0, clientY: 0 },
    );
    maximum.move(
      'canvas-drop-zone',
      { clientX: 10_000, clientY: 10_000 },
    );

    card = document.querySelector<HTMLElement>(
      `[data-canvas-node-id="${nodeId}"]`,
    );
    expect(card?.dataset.canvasPreviewWidth)
      .toBe(String(CANVAS_MAX_NODE_WIDTH));
    expect(card?.dataset.canvasPreviewHeight)
      .toBe(String(CANVAS_MAX_NODE_HEIGHT));

    maximum.release(
      'canvas-drop-zone',
      { clientX: 10_000, clientY: 10_000 },
    );

    const maximumRefusal = refused as CanvasGeometryRefusal | null;
    expect(maximumRefusal?.proposed.width).toBe(CANVAS_MAX_NODE_WIDTH);
    expect(maximumRefusal?.proposed.height).toBe(CANVAS_MAX_NODE_HEIGHT);

    const handles = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-canvas-geometry-handle]',
      ),
    );
    expect(handles).toHaveLength(2);
    expect(
      handles.every(
        (handle) =>
          handle.dataset.canvasWriteRefusal
            === CANVAS_SURFACE_WRITE_REFUSAL,
      ),
    ).toBe(true);

    expect(JSON.stringify(state)).toBe(before);
  });
});
