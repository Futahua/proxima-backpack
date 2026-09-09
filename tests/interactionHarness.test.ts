// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 0 programmatic interaction harness', () => {
  it('targets stable machine keys rather than visible text and refuses ambiguous keys', () => {
    document.body.innerHTML = '<button data-c1-key="primary-action">Original label</button>';

    const harness = createInteractionHarness(document);
    const button = harness.target('primary-action');
    let clicks = 0;

    button.addEventListener('click', () => {
      clicks += 1;
    });

    harness.click('primary-action');
    button.textContent = 'Completely different visible text';
    harness.click('primary-action');

    expect(clicks).toBe(2);
    expect(() => harness.target('missing')).toThrow('matched 0 elements');

    document.body.insertAdjacentHTML(
      'beforeend',
      '<button data-c1-key="primary-action">Duplicate</button>',
    );

    expect(() => harness.target('primary-action')).toThrow('matched 2 elements');
  });

  it('dispatches hover and context-menu gestures to the keyed DOM node', () => {
    document.body.innerHTML = '<div data-c1-key="card">Card</div>';

    const harness = createInteractionHarness(document);
    const card = harness.target('card');
    const seen: string[] = [];
    let contextButton = -1;

    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
      card.addEventListener(type, () => {
        seen.push(type);
      });
    }

    card.addEventListener('contextmenu', (event) => {
      contextButton = (event as MouseEvent).button;
    });

    harness.hover('card', { clientX: 12, clientY: 18 });
    harness.contextMenu('card', { clientX: 12, clientY: 18 });

    expect(seen).toEqual([
      'pointerover',
      'pointerenter',
      'mouseover',
      'mouseenter',
    ]);
    expect(contextButton).toBe(2);
  });

  it('separates pointer down, move and release so provisional state is assertable', () => {
    document.body.innerHTML = `
      <div data-c1-key="source"></div>
      <div data-c1-key="destination"></div>
    `;

    const harness = createInteractionHarness(document);
    const source = harness.target('source');
    const destination = harness.target('destination');

    let active = false;

    source.addEventListener('pointerdown', () => {
      active = true;
    });

    destination.addEventListener('pointermove', (event) => {
      if (!active) return;
      const pointer = event as PointerEvent;
      destination.dataset.preview = `${pointer.clientX},${pointer.clientY}`;
    });

    destination.addEventListener('pointerup', () => {
      active = false;
      destination.dataset.committed = 'true';
    });

    const gesture = harness.pointerDown('source', { clientX: 0, clientY: 0 });
    gesture.move('destination', { clientX: 24, clientY: 36 });

    expect(destination.dataset.preview).toBe('24,36');
    expect(destination.dataset.committed).toBeUndefined();

    gesture.release('destination', { clientX: 24, clientY: 36 });

    expect(destination.dataset.committed).toBe('true');
    expect(() => gesture.move('destination', { clientX: 30, clientY: 40 }))
      .toThrow('already released');
  });

  it('supports Shift-modified resize with provisional geometry before release', () => {
    document.body.innerHTML = '<div data-c1-key="resize-handle"></div>';

    const harness = createInteractionHarness(document);
    const handle = harness.target('resize-handle');

    let resizing = false;

    handle.addEventListener('pointerdown', (event) => {
      resizing = (event as PointerEvent).shiftKey;
    });

    handle.addEventListener('pointermove', (event) => {
      if (!resizing) return;
      const pointer = event as PointerEvent;
      handle.dataset.resizePreview = String(pointer.clientX);
    });

    handle.addEventListener('pointerup', () => {
      handle.dataset.resizeCommitted = handle.dataset.resizePreview;
      resizing = false;
    });

    const resize = harness.beginResize(
      'resize-handle',
      { clientX: 10, clientY: 0 },
      { shiftKey: true },
    );

    resize.move(
      'resize-handle',
      { clientX: 80, clientY: 0 },
      { shiftKey: true },
    );

    expect(handle.dataset.resizePreview).toBe('80');
    expect(handle.dataset.resizeCommitted).toBeUndefined();

    resize.release(
      'resize-handle',
      { clientX: 80, clientY: 0 },
      { shiftKey: true },
    );

    expect(handle.dataset.resizeCommitted).toBe('80');
  });

  it('dispatches drag and drop with shared data transfer and observable provisional state', () => {
    document.body.innerHTML = `
      <div data-c1-key="drag-source"></div>
      <div data-c1-key="drop-target"></div>
    `;

    const harness = createInteractionHarness(document);
    const source = harness.target('drag-source');
    const target = harness.target('drop-target');

    source.addEventListener('dragstart', (event) => {
      (event as DragEvent).dataTransfer?.setData('text/plain', 'task-1');
    });

    target.addEventListener('dragover', (event) => {
      event.preventDefault();
      target.dataset.dragPreview =
        (event as DragEvent).dataTransfer?.getData('text/plain') ?? '';
    });

    target.addEventListener('drop', (event) => {
      target.dataset.dropped =
        (event as DragEvent).dataTransfer?.getData('text/plain') ?? '';
    });

    const drag = harness.beginDrag('drag-source', { clientX: 5, clientY: 5 });
    drag.move('drop-target', { clientX: 50, clientY: 60 });

    expect(drag.dataTransfer.getData('text/plain')).toBe('task-1');
    expect(target.dataset.dragPreview).toBe('task-1');
    expect(target.dataset.dropped).toBeUndefined();

    drag.drop('drop-target', { clientX: 50, clientY: 60 });

    expect(target.dataset.dropped).toBe('task-1');
    expect(() => drag.move('drop-target', { clientX: 70, clientY: 80 }))
      .toThrow('already dropped');
  });

  it('enters text through keyboard/input events and dispatches Escape', () => {
    document.body.innerHTML = '<input data-c1-key="title-field" value="">';

    const harness = createInteractionHarness(document);
    const input = harness.target('title-field') as HTMLInputElement;
    const inputValues: string[] = [];
    const keys: string[] = [];

    input.addEventListener('input', () => {
      inputValues.push(input.value);
    });

    input.addEventListener('keydown', (event) => {
      keys.push((event as KeyboardEvent).key);
    });

    harness.typeText('title-field', 'abc');

    expect(input.value).toBe('abc');
    expect(inputValues).toEqual(['a', 'ab', 'abc']);

    harness.escape('title-field');

    expect(keys).toEqual(['a', 'b', 'c', 'Escape']);
    expect(document.activeElement).toBe(input);
  });
});
