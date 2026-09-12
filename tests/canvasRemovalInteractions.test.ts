// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import {
  admitCanvasDrop,
  bindCanvasSurfaceInteractions,
  CANVAS_SURFACE_WRITE_REFUSAL,
  EMPTY_CANVAS_SURFACE_VIEW,
  renderCanvasSurface,
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

describe('Stage 6 slice 3 Canvas remove intent and refusal', () => {
  it('opens a node-specific remove confirmation without removing or mutating the node', async () => {
    const state = await admitCanvasDrop(
      [file('remove-me.txt')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let view: CanvasSurfaceViewState = {
      ...EMPTY_CANVAS_SURFACE_VIEW,
      selectedNodeId: nodeId,
    };

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
      requestRemove: (candidateNodeId) => {
        view = {
          ...EMPTY_CANVAS_SURFACE_VIEW,
          selectedNodeId: candidateNodeId,
          removeCandidateNodeId: candidateNodeId,
        };
        render();
      },
    });

    const remove = document.querySelector<HTMLButtonElement>(
      `[data-papers-visual-key="canvas-remove-${nodeId}"]`,
    );
    expect(remove?.disabled).toBe(false);
    expect(remove?.dataset.canvasWriteRefusal)
      .toBe(CANVAS_SURFACE_WRITE_REFUSAL);

    const harness = createInteractionHarness(document);
    harness.click(`canvas-remove-${nodeId}`);

    expect(view.removeCandidateNodeId).toBe(nodeId);
    expect(
      document.querySelector<HTMLElement>(
        `[data-canvas-remove-candidate-node-id="${nodeId}"]`,
      ),
    ).not.toBeNull();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.node.id).toBe(nodeId);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('cancels remove intent while preserving the selected node and source state', async () => {
    const state = await admitCanvasDrop(
      [file('cancel.txt')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let view: CanvasSurfaceViewState = {
      ...EMPTY_CANVAS_SURFACE_VIEW,
      selectedNodeId: nodeId,
    };

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
      requestRemove: (candidateNodeId) => {
        view = {
          ...EMPTY_CANVAS_SURFACE_VIEW,
          selectedNodeId: candidateNodeId,
          removeCandidateNodeId: candidateNodeId,
        };
        render();
      },
      cancelRemove: () => {
        view = {
          ...EMPTY_CANVAS_SURFACE_VIEW,
          selectedNodeId: nodeId,
        };
        render();
      },
    });

    const harness = createInteractionHarness(document);
    harness.click(`canvas-remove-${nodeId}`);
    harness.click(`canvas-remove-cancel-${nodeId}`);

    expect(view.selectedNodeId).toBe(nodeId);
    expect(view.removeCandidateNodeId).toBeNull();
    expect(
      document.querySelector('[data-canvas-remove-candidate-node-id]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-canvas-remove-refusal]'),
    ).toBeNull();
    expect(
      document.querySelector(`[data-canvas-node-id="${nodeId}"]`),
    ).not.toBeNull();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('confirmation terminates in typed action-not-available and leaves CanvasSurfaceState byte-for-byte unchanged', async () => {
    const state = await admitCanvasDrop(
      [file('still-here.txt')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let view: CanvasSurfaceViewState = {
      ...EMPTY_CANVAS_SURFACE_VIEW,
      selectedNodeId: nodeId,
    };
    let refusedNodeId: string | null = null;

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
      requestRemove: (candidateNodeId) => {
        view = {
          ...EMPTY_CANVAS_SURFACE_VIEW,
          selectedNodeId: candidateNodeId,
          removeCandidateNodeId: candidateNodeId,
        };
        render();
      },
      refuseRemove: (candidateNodeId) => {
        refusedNodeId = candidateNodeId;
        view = {
          ...EMPTY_CANVAS_SURFACE_VIEW,
          selectedNodeId: candidateNodeId,
          writeRefusal: CANVAS_SURFACE_WRITE_REFUSAL,
          lastRefusedRemovalNodeId: candidateNodeId,
        };
        render();
      },
    });

    const harness = createInteractionHarness(document);
    harness.click(`canvas-remove-${nodeId}`);
    harness.click(`canvas-remove-confirm-action-${nodeId}`);

    expect(refusedNodeId).toBe(nodeId);
    expect(view.removeCandidateNodeId).toBeNull();
    expect(
      document.querySelector<HTMLElement>(
        '[data-canvas-remove-refusal="action-not-available"]',
      )?.dataset.canvasRemoveNodeId,
    ).toBe(nodeId);
    expect(
      document.querySelector('[data-canvas-remove-candidate-node-id]'),
    ).toBeNull();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.node.id).toBe(nodeId);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('fails closed for stale remove candidates and stale removal refusals', async () => {
    const state = await admitCanvasDrop(
      [file('present.txt')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);

    document.body.innerHTML = renderCanvasSurface(
      state,
      undefined,
      undefined,
      undefined,
      {
        selectedNodeId: state.items[0]!.node.id,
        writeRefusal: CANVAS_SURFACE_WRITE_REFUSAL,
        removeCandidateNodeId: 'missing-node',
        lastRefusedRemovalNodeId: 'missing-node',
      },
    );

    expect(
      document.querySelector('[data-canvas-remove-candidate-node-id]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-canvas-remove-refusal]'),
    ).toBeNull();
    expect(state.items).toHaveLength(1);
    expect(JSON.stringify(state)).toBe(before);
  });
});
