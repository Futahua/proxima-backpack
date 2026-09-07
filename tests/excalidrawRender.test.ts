import { describe, expect, it } from 'vitest';
import { renderExcalidrawSvg } from '../src/domain/excalidrawRender.js';
import type { ExcalidrawScene } from '../src/domain/excalidraw.js';

/**
 * Gate 7C rendering.
 *
 * The census is the point of these tests as much as the SVG is. A renderer that
 * quietly drops what it cannot draw produces a picture that looks complete and is
 * not, and that is the one failure a viewer cannot detect for themselves. So every
 * element must be accounted for: rendered, unsupported, deleted or skipped, summing
 * to the scene's own count.
 */

const scene = (elements: unknown[], appState?: Record<string, unknown>): ExcalidrawScene => ({
  type: 'excalidraw',
  version: 2,
  elements,
  ...(appState ? { appState } : {}),
});

const freedraw = { id: 'f1', type: 'freedraw', x: 10, y: 10, points: [[0, 0], [20, 30]], strokeColor: '#3E6F8D' };
const text = { id: 't1', type: 'text', x: 0, y: 0, text: 'hello', fontSize: 20 };
const line = { id: 'l1', type: 'line', x: 5, y: 5, points: [[0, 0], [50, 0]] };
const arrow = { id: 'a1', type: 'arrow', x: 0, y: 0, points: [[0, 0], [40, 40]] };
const image = { id: 'i1', type: 'image', x: 100, y: 100, width: 60, height: 40, fileId: 'abc123' };

describe('rendering the supported element types', () => {
  it('draws each type the creator drawings actually contain', () => {
    const result = renderExcalidrawSvg(scene([freedraw, text, line, arrow]));
    expect(result.census.rendered).toBe(4);
    expect(result.census.unsupported).toBe(0);
    expect(result.svg).toContain('<path');
    expect(result.svg).toContain('<text');
    expect(result.svg).toContain('hello');
  });

  it('gives an arrow a head, which is what distinguishes it from a line', () => {
    const withArrow = renderExcalidrawSvg(scene([arrow])).svg;
    const withLine = renderExcalidrawSvg(scene([line])).svg;
    // The arrow emits a filled head path in addition to its stroke.
    expect((withArrow.match(/<path/g) ?? []).length).toBeGreaterThan((withLine.match(/<path/g) ?? []).length);
    expect(withArrow).toContain('fill="#1e1e1e"');
  });

  it('preserves document order, which is z-order', () => {
    const svg = renderExcalidrawSvg(scene([{ ...text, text: 'first' }, { ...text, id: 't2', text: 'second' }])).svg;
    expect(svg.indexOf('first')).toBeLessThan(svg.indexOf('second'));
  });

  it('frames the drawing from its own extent rather than a fixed guess', () => {
    const near = renderExcalidrawSvg(scene([{ ...line, points: [[0, 0], [10, 10]] }]));
    const far = renderExcalidrawSvg(scene([{ ...line, points: [[0, 0], [1000, 500]] }]));
    expect(far.viewBox.width).toBeGreaterThan(near.viewBox.width);
    expect(near.viewBox.width).toBeGreaterThan(0);
  });

  it('still produces a usable frame for an empty scene', () => {
    const result = renderExcalidrawSvg(scene([]));
    expect(result.viewBox.width).toBeGreaterThan(0);
    expect(result.census.sceneElements).toBe(0);
    expect(result.svg).toContain('<svg');
  });
});

describe('nothing disappears without a reason', () => {
  it('accounts for every element in the scene', () => {
    const result = renderExcalidrawSvg(
      scene([
        freedraw,
        { id: 'e1', type: 'ellipse', x: 0, y: 0, width: 10, height: 10 },
        { ...text, id: 'gone', isDeleted: true },
        { id: 'bad', type: 'line', x: 'not a number', y: 0, points: [[0, 0]] },
      ]),
    );
    const { sceneElements, rendered, unsupported, deleted, skipped } = result.census;
    expect(rendered + unsupported + deleted + skipped).toBe(sceneElements);
    expect(rendered).toBe(1);
    expect(unsupported).toBe(1);
    expect(deleted).toBe(1);
    expect(skipped).toBe(1);
  });

  it('reports an unsupported type instead of silently dropping it', () => {
    const result = renderExcalidrawSvg(scene([freedraw, { id: 'e1', type: 'ellipse', x: 0, y: 0 }]));
    // The supported remainder still renders.
    expect(result.census.rendered).toBe(1);
    expect(result.problems).toContainEqual({ code: 'unsupported-element', elementType: 'ellipse', count: 1 });
  });

  it('counts repeated unsupported types once, with a count', () => {
    const ellipses = Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, type: 'ellipse', x: 0, y: 0 }));
    const result = renderExcalidrawSvg(scene(ellipses));
    expect(result.problems).toEqual([{ code: 'unsupported-element', elementType: 'ellipse', count: 5 }]);
  });

  it('records the type census whatever the types are', () => {
    const result = renderExcalidrawSvg(scene([freedraw, freedraw, text, { id: 'x', type: 'ellipse', x: 0, y: 0 }]));
    expect(result.census.byType).toEqual({ freedraw: 2, text: 1, ellipse: 1 });
  });

  it('accounts for elements beyond the render budget as explicitly skipped', () => {
    const many = Array.from({ length: 5_001 }, (_, index) => ({ ...text, id: `t${index}` }));
    const result = renderExcalidrawSvg(scene(many));
    const { sceneElements, rendered, unsupported, deleted, skipped } = result.census;
    expect(sceneElements).toBe(5_001);
    expect(rendered + unsupported + deleted + skipped).toBe(sceneElements);
    expect(skipped).toBe(1);
    expect(result.problems).toContainEqual({ code: 'element-limit-exceeded', elementType: 'text', count: 1 });
  });
});

describe('images before asset resolution', () => {
  it('renders a visible placeholder and reports it, rather than a hole', () => {
    const result = renderExcalidrawSvg(scene([image]));
    expect(result.census.imageElements).toBe(1);
    expect(result.census.imagesResolved).toBe(0);
    expect(result.census.imagePlaceholders).toBe(1);
    expect(result.svg).toContain('image unavailable');
    expect(result.problems).toContainEqual({ code: 'image-asset-unresolved', elementType: 'image', count: 1 });
  });

  it('draws the real image once its asset is resolved', () => {
    const result = renderExcalidrawSvg(scene([image]), { abc123: 'data:image/png;base64,AAAA' });
    expect(result.census.imagesResolved).toBe(1);
    expect(result.census.imagePlaceholders).toBe(0);
    expect(result.svg).toContain('<image');
    expect(result.svg).toContain('data:image/png;base64,AAAA');
    expect(result.problems).toEqual([]);
  });
});

describe('the scene decides its own background', () => {
  it('reports transparent rather than substituting a colour', () => {
    // Painting white here would invent a decision the artist did not make; the
    // surface is told instead and supplies its own sheet.
    expect(renderExcalidrawSvg(scene([freedraw], { viewBackgroundColor: 'transparent' })).background).toBe('transparent');
  });

  it('uses a real background colour when the scene sets one', () => {
    const result = renderExcalidrawSvg(scene([freedraw], { viewBackgroundColor: '#ffe9b0' }));
    expect(result.background).toBe('#ffe9b0');
    expect(result.svg).toContain('#ffe9b0');
  });
});

describe('hostile input', () => {
  it('does not let element content escape into markup', () => {
    const svg = renderExcalidrawSvg(scene([{ ...text, text: '</text><script>alert(1)</script>' }])).svg;
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
  });

  it('survives a null scene and a scene whose elements are not an array', () => {
    expect(renderExcalidrawSvg(null).census.sceneElements).toBe(0);
    expect(renderExcalidrawSvg({ elements: 'nope' } as unknown as ExcalidrawScene).census.sceneElements).toBe(0);
  });
});
