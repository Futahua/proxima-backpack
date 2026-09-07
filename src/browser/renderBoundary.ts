/**
 * Keep a surface renderer failure inside the visible/agent-readable boundary.
 *
 * Renderers are pure functions, but a malformed future input or implementation
 * bug must not tear down the whole page. The boundary returns safe markup and a
 * stable failure code without touching source state or host capabilities.
 */

export interface RendererFailure {
  code: 'renderer-failure';
  detail: string;
}

export interface RenderBoundaryResult {
  markup: string;
  failure: RendererFailure | null;
}

export function renderWithBoundary(renderSurface: () => string): RenderBoundaryResult {
  try {
    return { markup: renderSurface(), failure: null };
  } catch (error) {
    const detail = boundedDetail(error);
    return {
      markup: `<section class="surface error-surface" data-c1-key="renderer-failure" role="alert"><h2>Surface unavailable</h2><p>Renderer failed safely: ${escapeHtml(detail)}</p></section>`,
      failure: { code: 'renderer-failure', detail },
    };
  }
}

function boundedDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (clean || 'unknown renderer failure').slice(0, 180);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
