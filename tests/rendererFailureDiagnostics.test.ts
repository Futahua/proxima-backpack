import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_LIMITS,
  isDiagnosticCode,
} from '../src/app/diagnostics.js';
import { renderWithBoundary } from '../src/browser/renderBoundary.js';

describe('Stage 6 slice 13 renderer-failure diagnostics', () => {
  it('returns the stable machine-readable renderer-failure code with bounded visible fallback markup', () => {
    const result = renderWithBoundary(() => {
      throw new Error(
        '<script>alert("renderer")</script>\n'
        + 'x'.repeat(500),
      );
    });

    expect(result.failure).not.toBeNull();
    expect(result.failure?.code).toBe('renderer-failure');
    expect(isDiagnosticCode(result.failure?.code)).toBe(true);
    expect(result.failure?.detail.length)
      .toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.rendererDetail);

    expect(result.markup).toContain(
      'data-c1-key="renderer-failure"',
    );
    expect(result.markup).toContain('role="alert"');
    expect(result.markup).toContain('Surface unavailable');
    expect(result.markup).toContain('Renderer failed safely');
    expect(result.markup).toContain('&lt;script&gt;');
    expect(result.markup).not.toContain('<script>');
  });

  it('normalizes control characters and supplies a bounded fallback for empty thrown detail', () => {
    const controlled = renderWithBoundary(() => {
      throw new Error('first\u0000second\nthird\tlast');
    });

    expect(controlled.failure).toMatchObject({
      code: 'renderer-failure',
    });
    expect(controlled.failure?.detail)
      .toBe('first second third last');
    expect(controlled.failure?.detail)
      .not.toMatch(/[\u0000-\u001f\u007f]/);

    const empty = renderWithBoundary(() => {
      throw new Error('\n\t\u0000');
    });

    expect(empty.failure).toEqual({
      code: 'renderer-failure',
      detail: 'unknown renderer failure',
    });
    expect(empty.markup).toContain(
      'Renderer failed safely: unknown renderer failure',
    );
  });

  it('contains non-Error throws under the same structured renderer diagnostic contract', () => {
    const result = renderWithBoundary(() => {
      throw '<img src=x onerror=alert(1)>';
    });

    expect(result.failure).toEqual({
      code: 'renderer-failure',
      detail: '<img src=x onerror=alert(1)>',
    });
    expect(isDiagnosticCode(result.failure?.code)).toBe(true);

    expect(result.markup).toContain(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(result.markup).not.toContain(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('does not let one renderer failure poison the next render attempt', () => {
    const failed = renderWithBoundary(() => {
      throw new Error('first render failed');
    });

    expect(failed.failure).toMatchObject({
      code: 'renderer-failure',
      detail: 'first render failed',
    });

    const recovered = renderWithBoundary(
      () => '<section data-c1-key="recovered-surface">recovered</section>',
    );

    expect(recovered).toEqual({
      markup:
        '<section data-c1-key="recovered-surface">recovered</section>',
      failure: null,
    });
    expect(recovered.markup).not.toContain(
      'renderer-failure',
    );
  });
});
