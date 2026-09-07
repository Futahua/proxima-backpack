import type { ExcalidrawScene } from './excalidraw.js';

/**
 * Rendering a decoded Excalidraw scene to SVG.
 *
 * Pure by construction: a scene and a set of already-resolved assets go in, an SVG
 * string and a census come out. No DOM, no filesystem, no Obsidian. The browser
 * surface owns insertion; acquiring asset bytes is a different trust boundary and
 * belongs to the asset resolver, not here.
 *
 * The element types supported are exactly those the creator's own drawings contain —
 * freedraw, text, line, arrow, image. The format supports many more, and rendering
 * types nobody has would be untested code pretending to be capability.
 *
 * The rule that matters most: **an element this cannot draw is reported, never
 * dropped.** Silently omitting an unsupported element produces a picture that looks
 * complete and is not, which is the one failure a viewer cannot detect. The same
 * applies to an image whose bytes are unavailable: it becomes a visible placeholder
 * and a diagnostic, not a hole.
 */

export type ExcalidrawRenderProblemCode =
  /** An element type this renderer does not draw. */
  | 'unsupported-element'
  /** An image element whose asset was not resolved. */
  | 'image-asset-unresolved'
  /** An element whose geometry could not be read. */
  | 'element-geometry-invalid'
  /** Elements beyond the renderer's bounded scene-element budget. */
  | 'element-limit-exceeded'
  /** A point-based element exceeded the bounded geometry budget. */
  | 'point-limit-exceeded';

export interface ExcalidrawRenderProblem {
  code: ExcalidrawRenderProblemCode;
  /** Element type, never element content. */
  elementType: string;
  count: number;
}

export interface ExcalidrawRenderCensus {
  /** Every element in the decoded scene. */
  sceneElements: number;
  /** Counts per type, whatever the type. */
  byType: Record<string, number>;
  /** Elements this renderer drew. */
  rendered: number;
  /** Elements reported as unsupported. */
  unsupported: number;
  imageElements: number;
  imagesResolved: number;
  imagePlaceholders: number;
  /**
   * Elements Excalidraw itself marks as deleted. They are tombstones and are not
   * drawn, but they are counted: rendered + unsupported + deleted + skipped must
   * equal sceneElements, so no element can disappear without a reason.
   */
  deleted: number;
  /** Elements dropped because their geometry could not be read. */
  skipped: number;
}

export interface ExcalidrawRenderResult {
  svg: string;
  census: ExcalidrawRenderCensus;
  problems: ExcalidrawRenderProblem[];
  /** The frame chosen for the drawing, so a test can assert deterministic framing. */
  viewBox: { x: number; y: number; width: number; height: number };
  /**
   * The scene's own background, reported rather than substituted.
   *
   * Excalidraw's `transparent` is a real answer: the drawing is meant to sit on
   * whatever canvas shows it. Painting white here would be inventing a decision the
   * artist did not make, so the surface is told and chooses its own backdrop —
   * which also stops dark strokes from vanishing on a dark host.
   */
  background: string;
}

/**
 * Asset bytes the caller has already resolved, keyed by the element's `fileId`.
 * A `data:` URL, because the Papers CSP permits `img-src data:` and forbids
 * fetching anything at runtime.
 */
export type ResolvedAssets = Readonly<Record<string, string>>;

const SUPPORTED = new Set(['freedraw', 'text', 'line', 'arrow', 'image']);
const MAX_ELEMENTS = 5_000;
const MAX_POINTS = 5_000;
const PADDING = 20;

export function renderExcalidrawSvg(scene: ExcalidrawScene | null, assets: ResolvedAssets = {}): ExcalidrawRenderResult {
  const allElements = Array.isArray(scene?.elements) ? (scene.elements as ElementLike[]) : [];
  const elements = allElements.slice(0, MAX_ELEMENTS);
  const typeCounts = new Map<string, number>();
  const census: ExcalidrawRenderCensus = {
    sceneElements: allElements.length,
    byType: {},
    rendered: 0,
    unsupported: 0,
    imageElements: 0,
    imagesResolved: 0,
    imagePlaceholders: 0,
    deleted: 0,
    skipped: 0,
  };
  const problemCounts = new Map<string, ExcalidrawRenderProblem>();
  const renderedTypes: string[] = [];
  const note = (code: ExcalidrawRenderProblemCode, elementType: string) => {
    const key = `${code}:${elementType}`;
    const existing = problemCounts.get(key);
    if (existing) existing.count += 1;
    else problemCounts.set(key, { code, elementType, count: 1 });
  };

  const countType = (type: string) => typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  const body: string[] = [];
  const bounds = new Bounds();

  for (const element of elements) {
    const type = typeof element?.type === 'string' ? element.type : 'unknown';
    countType(type);

    if (!SUPPORTED.has(type)) {
      census.unsupported += 1;
      note('unsupported-element', type);
      continue;
    }
    if (element.isDeleted === true) {
      census.deleted += 1;
      continue;
    }

    const x = finite(element.x);
    const y = finite(element.y);
    if (x === null || y === null || roundedFinite(x) === null || roundedFinite(y) === null) {
      census.skipped += 1;
      note('element-geometry-invalid', type);
      continue;
    }

    if (type === 'image') {
      census.imageElements += 1;
      const width = finite(element.width);
      const height = finite(element.height);
      const right = width === null ? null : finite(x + width);
      const bottom = height === null ? null : finite(y + height);
      const roundedWidth = width === null ? null : roundedFinite(width);
      const roundedHeight = height === null ? null : roundedFinite(height);
      if (width === null || height === null || right === null || bottom === null || width <= 0 || height <= 0 || roundedWidth === null || roundedHeight === null || roundedWidth <= 0 || roundedHeight <= 0) {
        census.skipped += 1;
        note('element-geometry-invalid', type);
        continue;
      }
      const href = typeof element.fileId === 'string' && Object.prototype.hasOwnProperty.call(assets, element.fileId) && typeof assets[element.fileId] === 'string'
        ? assets[element.fileId]
        : undefined;
      bounds.add(x, y);
      bounds.add(x + width, y + height);
      if (href) {
        census.imagesResolved += 1;
        census.rendered += 1;
        renderedTypes.push(type);
        body.push(`<image x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" href="${escapeAttribute(href)}" preserveAspectRatio="none" />`);
      } else {
        // Visible, labelled, and reported. A missing image must not read as empty
        // canvas: the viewer would believe the drawing looks like this.
        census.imagePlaceholders += 1;
        census.rendered += 1;
        renderedTypes.push(type);
        note('image-asset-unresolved', type);
        body.push(placeholder(x, y, width, height));
      }
      continue;
    }

    if (['freedraw', 'line', 'arrow'].includes(type) && Array.isArray(element.points) && element.points.length > MAX_POINTS) {
      census.skipped += 1;
      note('point-limit-exceeded', type);
      continue;
    }

    const drawn = drawElement(type, element, x, y, bounds);
    if (drawn === null) {
      census.skipped += 1;
      note('element-geometry-invalid', type);
      continue;
    }
    census.rendered += 1;
    renderedTypes.push(type);
    body.push(drawn);
  }

  // The renderer is deliberately bounded, but a bound must never become silent
  // omission. Account for every element beyond the drawing budget as skipped and
  // retain its type in the census so the equality remains truthful.
  for (const element of allElements.slice(MAX_ELEMENTS)) {
    const type = typeof element?.type === 'string' ? element.type : 'unknown';
    countType(type);
    census.skipped += 1;
    note('element-limit-exceeded', type);
  }

  // If the scene-wide extrema cannot fit in a finite SVG frame, do not claim
  // that those elements were rendered while silently clipping them.
  if (bounds.frameOverflows(PADDING)) {
    for (const type of renderedTypes) {
      census.rendered -= 1;
      census.skipped += 1;
      note('element-geometry-invalid', type);
    }
    body.length = 0;
    bounds.clear();
  }

  const viewBox = bounds.viewBox(PADDING);
  const background = colour(scene?.appState?.viewBackgroundColor, '#ffffff', true);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(viewBox.x)} ${round(viewBox.y)} ${round(viewBox.width)} ${round(viewBox.height)}" width="100%" height="100%" role="img">`,
    `<rect x="${round(viewBox.x)}" y="${round(viewBox.y)}" width="${round(viewBox.width)}" height="${round(viewBox.height)}" fill="${escapeAttribute(background)}" />`,
    // Document order is z-order, and it is preserved.
    ...body,
    '</svg>',
  ].join('');

  census.byType = Object.fromEntries(typeCounts);
  return { svg, census, problems: [...problemCounts.values()], viewBox, background };
}

interface ElementLike {
  type?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  points?: unknown;
  text?: unknown;
  fontSize?: unknown;
  fileId?: unknown;
  isDeleted?: unknown;
  strokeColor?: unknown;
  backgroundColor?: unknown;
  strokeWidth?: unknown;
  opacity?: unknown;
}

function drawElement(type: string, element: ElementLike, x: number, y: number, bounds: Bounds): string | null {
  const stroke = colour(element.strokeColor, '#1e1e1e');
  const strokeWidth = finite(element.strokeWidth) ?? 1;
  const roundedStrokeWidth = roundedFinite(strokeWidth);
  const opacity = typeof element.opacity === 'number' ? Math.max(0, Math.min(1, element.opacity / 100)) : 1;

  if (type === 'text') {
    const text = typeof element.text === 'string' ? element.text : '';
    const fontSize = finite(element.fontSize) ?? 16;
    const baseline = finite(y + fontSize);
    const extent = Math.max(fontSize * text.length * 0.6, 1);
    const right = finite(x + extent);
    if (text.length === 0 || fontSize <= 0 || roundedFinite(fontSize) === null || roundedFinite(fontSize)! <= 0 || baseline === null || right === null || roundedFinite(baseline) === null || roundedFinite(right) === null) return null;
    bounds.add(x, y);
    bounds.add(x + Math.max(fontSize * text.length * 0.6, 1), y + fontSize);
    // Baseline sits a line down from the element origin, matching Excalidraw's
    // top-left positioning.
    return `<text x="${round(x)}" y="${round(y + fontSize)}" font-size="${round(fontSize)}" fill="${escapeAttribute(stroke)}" opacity="${opacity}" font-family="Segoe UI, system-ui, sans-serif" xml:space="preserve">${escapeText(text)}</text>`;
  }

  const points = readPoints(element.points);
  if (!points || points.length < 2) return null;
  if (roundedStrokeWidth === null || (['line', 'freedraw', 'arrow'].includes(type) && (strokeWidth <= 0 || roundedStrokeWidth <= 0))) return null;
  const absolutePoints: Array<[number, number]> = [];
  for (const [px, py] of points) {
    const absoluteX = finite(x + px);
    const absoluteY = finite(y + py);
    if (absoluteX === null || absoluteY === null || roundedFinite(absoluteX) === null || roundedFinite(absoluteY) === null) return null;
    absolutePoints.push([absoluteX, absoluteY]);
  }
  if ((type === 'line' || type === 'freedraw') && !hasDrawableSegment(absolutePoints)) return null;
  const path = absolutePoints
    .map(([absoluteX, absoluteY], index) => `${index === 0 ? 'M' : 'L'}${round(absoluteX)},${round(absoluteY)}`)
    .join(' ');
  for (const [absoluteX, absoluteY] of absolutePoints) bounds.add(absoluteX, absoluteY);

  if (type === 'freedraw') {
    return `<path d="${path}" fill="none" stroke="${escapeAttribute(stroke)}" stroke-width="${round(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" />`;
  }
  if (type === 'line') {
    return `<path d="${path}" fill="none" stroke="${escapeAttribute(stroke)}" stroke-width="${round(strokeWidth)}" opacity="${opacity}" />`;
  }
  // arrow: the head is what distinguishes it from a line.
  const head = arrowHead(absolutePoints, strokeWidth);
  if (head === null) return null;
  return `<g opacity="${opacity}"><path d="${path}" fill="none" stroke="${escapeAttribute(stroke)}" stroke-width="${round(strokeWidth)}" /><path d="${head}" fill="${escapeAttribute(stroke)}" /></g>`;
}

function hasDrawableSegment(points: Array<[number, number]>): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index] as [number, number];
    const previous = points[index - 1] as [number, number];
    if (round(current[0]) !== round(previous[0]) || round(current[1]) !== round(previous[1])) return true;
  }
  return false;
}

function arrowHead(points: Array<[number, number]>, strokeWidth: number): string | null {
  const last = points[points.length - 1] as [number, number];
  const previous = (points[points.length - 2] ?? points[0]) as [number, number];
  const endX = last[0];
  const endY = last[1];
  const angle = Math.atan2(last[1] - previous[1], last[0] - previous[0]);
  const size = Math.max(8, strokeWidth * 4);
  if (!Number.isFinite(size)) return null;
  const left = angle + Math.PI - Math.PI / 7;
  const right = angle + Math.PI + Math.PI / 7;
  const leftX = finite(endX + Math.cos(left) * size);
  const leftY = finite(endY + Math.sin(left) * size);
  const rightX = finite(endX + Math.cos(right) * size);
  const rightY = finite(endY + Math.sin(right) * size);
  if (leftX === null || leftY === null || rightX === null || rightY === null || roundedFinite(leftX) === null || roundedFinite(leftY) === null || roundedFinite(rightX) === null || roundedFinite(rightY) === null) return null;
  return [
    `M${round(endX)},${round(endY)}`,
    `L${round(leftX)},${round(leftY)}`,
    `L${round(rightX)},${round(rightY)}`,
    'Z',
  ].join(' ');
}

/** A visible, labelled stand-in for an image whose bytes are not available. */
function placeholder(x: number, y: number, width: number, height: number): string {
  const w = Math.max(width, 24);
  const h = Math.max(height, 24);
  return [
    `<g>`,
    `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="#f3f4f6" stroke="#9ca3af" stroke-width="1" stroke-dasharray="6 4" />`,
    `<text x="${round(x + w / 2)}" y="${round(y + h / 2)}" font-size="${round(Math.min(16, h / 3))}" fill="#6b7280" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif">image unavailable</text>`,
    `</g>`,
  ].join('');
}

function readPoints(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<[number, number]> = [];
  for (const point of value) {
    if (!Array.isArray(point)) return null;
    const px = finite(point[0]);
    const py = finite(point[1]);
    if (px === null || py === null) return null;
    out.push([px, py]);
  }
  return out.length > 0 ? out : null;
}

/** Tracks the drawing's extent so the frame is derived, not guessed. */
class Bounds {
  private minX = Number.POSITIVE_INFINITY;
  private minY = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;

  add(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
  }

  clear(): void {
    this.minX = Number.POSITIVE_INFINITY;
    this.minY = Number.POSITIVE_INFINITY;
    this.maxX = Number.NEGATIVE_INFINITY;
    this.maxY = Number.NEGATIVE_INFINITY;
  }

  frameOverflows(padding: number): boolean {
    if (!Number.isFinite(this.minX)) return false;
    return !Number.isFinite(this.maxX - this.minX + padding * 2)
      || !Number.isFinite(this.maxY - this.minY + padding * 2);
  }

  viewBox(padding: number): { x: number; y: number; width: number; height: number } {
    // An empty scene still needs a frame, and a fixed one keeps rendering
    // deterministic rather than dependent on whatever the viewport happens to be.
    if (!Number.isFinite(this.minX)) return { x: 0, y: 0, width: 100, height: 100 };
    const x = finite(this.minX - padding) ?? (this.minX < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE);
    const y = finite(this.minY - padding) ?? (this.minY < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE);
    const widthSpan = this.maxX - this.minX + padding * 2;
    const heightSpan = this.maxY - this.minY + padding * 2;
    // frameOverflows() is handled by the caller before SVG emission. Keep a
    // finite fallback here as a final defense for direct future callers.
    return {
      x,
      y,
      width: Number.isFinite(widthSpan) ? Math.max(widthSpan, 1) : Number.MAX_VALUE,
      height: Number.isFinite(heightSpan) ? Math.max(heightSpan, 1) : Number.MAX_VALUE,
    };
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function colour(value: unknown, fallback: string, allowTransparent = false): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (allowTransparent && candidate === 'transparent') return candidate;
  // SVG paint servers and URLs are intentionally excluded from this renderer's
  // inline boundary. Excalidraw's ordinary palette is represented by hex colors.
  return /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i.test(candidate) ? candidate : fallback;
}

function round(value: number): number {
  // Multiplication by 100 overflows for large-but-finite inputs. At that
  // magnitude there is no meaningful two-decimal precision to retain, so
  // preserve the finite value rather than emitting Infinity.
  if (Number.isFinite(value) && Math.abs(value) > Number.MAX_VALUE / 100) return value;
  return Math.round(value * 100) / 100;
}

function roundedFinite(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = round(value);
  return Number.isFinite(rounded) ? rounded : null;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
