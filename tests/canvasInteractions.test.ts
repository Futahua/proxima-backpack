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

function file(name: string, text: string): BrowserFileLike {
  const bytes = new TextEncoder().encode(text);
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

describe('Stage 6 slice 1 Canvas selection and inspection', () => {
  it('uses stable Proxima-owned node IDs for semantic card keys rather than list positions', async () => {
    const state = await admitCanvasDrop(
      [file('one.txt', 'one'), file('two.txt', 'two')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);

    document.body.innerHTML = renderCanvasSurface(state);

    const ids = state.items.map((item) => item.node.id);
    expect(ids).toHaveLength(2);

    for (const id of ids) {
      expect(
        document.querySelector(
          `[data-papers-visual-key="canvas-card-${id}"][data-canvas-node-id="${id}"]`,
        ),
      ).not.toBeNull();
    }

    expect(
      document.querySelector('[data-papers-visual-key="canvas-card-0"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-papers-visual-key="canvas-card-1"]'),
    ).toBeNull();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('selects a card locally and opens an escaped read-only node inspector', async () => {
    const state = await admitCanvasDrop(
      [file('<script>not executable</script>.txt', '<img src=x>')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let view: CanvasSurfaceViewState = EMPTY_CANVAS_SURFACE_VIEW;

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
      openNode: (selectedNodeId) => {
        view = { selectedNodeId };
        render();
      },
      closeNode: () => {
        view = EMPTY_CANVAS_SURFACE_VIEW;
        render();
      },
    });

    const harness = createInteractionHarness(document);
    harness.click(`canvas-card-${nodeId}`);

    expect(view.selectedNodeId).toBe(nodeId);
    expect(
      document.querySelector<HTMLElement>(
        `[data-canvas-node-id="${nodeId}"]`,
      )?.getAttribute('aria-pressed'),
    ).toBe('true');

    const inspector = document.querySelector<HTMLElement>(
      `[data-canvas-inspector-node-id="${nodeId}"]`,
    );
    expect(inspector).not.toBeNull();
    expect(inspector?.textContent).toContain(
      '<script>not executable</script>.txt',
    );
    expect(inspector?.querySelector('script')).toBeNull();
    expect(inspector?.textContent).toContain(nodeId);
    expect(inspector?.textContent).toContain('browser-file');

    const writes = Array.from(
      inspector?.querySelectorAll<HTMLButtonElement>(
        '[data-canvas-write-action]',
      ) ?? [],
    );
    expect(writes).toHaveLength(2);

    const moveResize = writes.find(
      (control) => control.dataset.canvasWriteAction === 'move-resize',
    );
    expect(moveResize?.disabled).toBe(true);
    expect(moveResize?.getAttribute('aria-disabled')).toBe('true');
    expect(moveResize?.dataset.canvasAction).toBeUndefined();
    expect(moveResize?.dataset.canvasWriteRefusal)
      .toBe(CANVAS_SURFACE_WRITE_REFUSAL);

    const removePreview = writes.find(
      (control) => control.dataset.canvasWriteAction === 'remove-preview',
    );
    expect(removePreview?.disabled).toBe(false);
    expect(removePreview?.dataset.canvasAction).toBe('request-remove');
    expect(removePreview?.dataset.canvasWriteRefusal)
      .toBe(CANVAS_SURFACE_WRITE_REFUSAL);

    expect(
      inspector?.querySelector('input, textarea, select'),
    ).toBeNull();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('supports keyboard open and Escape close without mutating CanvasSurfaceState', async () => {
    const state = await admitCanvasDrop(
      [file('keyboard.md', '# passive')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);
    const nodeId = state.items[0]!.node.id;
    let view: CanvasSurfaceViewState = EMPTY_CANVAS_SURFACE_VIEW;

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
      openNode: (selectedNodeId) => {
        view = { selectedNodeId };
        render();
      },
      closeNode: () => {
        view = EMPTY_CANVAS_SURFACE_VIEW;
        render();
      },
    });

    const harness = createInteractionHarness(document);
    harness.pressKey(`canvas-card-${nodeId}`, 'Enter');

    expect(view.selectedNodeId).toBe(nodeId);
    expect(
      document.querySelector('[data-canvas-inspector-node-id]'),
    ).not.toBeNull();

    harness.escape('canvas-node-inspector-close');

    expect(view.selectedNodeId).toBeNull();
    expect(
      document.querySelector('[data-canvas-inspector-node-id]'),
    ).toBeNull();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('fails closed when local selection names a node no longer present', async () => {
    const state = await admitCanvasDrop(
      [file('present.txt', 'present')],
      undefined,
      sequentialIdGenerator(),
    );
    const before = JSON.stringify(state);

    document.body.innerHTML = renderCanvasSurface(
      state,
      undefined,
      undefined,
      undefined,
      { selectedNodeId: 'missing-node' },
    );

    expect(
      document.querySelector('[data-canvas-inspector-node-id]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLElement>('[data-canvas-node-id]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('exposes only typed-unavailable mutation paths while allowing remove intent preview', async () => {
    const state = await admitCanvasDrop(
      [file('readonly.txt', 'readonly')],
      undefined,
      sequentialIdGenerator(),
    );
    const nodeId = state.items[0]!.node.id;

    document.body.innerHTML = renderCanvasSurface(
      state,
      undefined,
      undefined,
      undefined,
      { selectedNodeId: nodeId },
    );

    expect(
      document.querySelector<HTMLElement>('.canvas-surface')
        ?.dataset.canvasWriteAuthority,
    ).toBe('unavailable');

    const writes = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-canvas-write-action]',
      ),
    );
    expect(writes).toHaveLength(2);
    expect(
      writes.every(
        (control) =>
          control.dataset.canvasWriteRefusal
            === 'action-not-available',
      ),
    ).toBe(true);

    const moveResize = document.querySelector<HTMLButtonElement>(
      '[data-canvas-write-action="move-resize"]',
    );
    expect(moveResize?.disabled).toBe(true);
    expect(moveResize?.dataset.canvasAction).toBeUndefined();

    const removePreview = document.querySelector<HTMLButtonElement>(
      '[data-canvas-write-action="remove-preview"]',
    );
    expect(removePreview?.disabled).toBe(false);
    expect(removePreview?.dataset.canvasAction).toBe('request-remove');

    expect(
      document.querySelector(
        '[data-canvas-action="remove-node"], [data-canvas-action="delete-node"]',
      ),
    ).toBeNull();
  });
});
