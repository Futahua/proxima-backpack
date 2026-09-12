import { describe, expect, it } from 'vitest';
import { renderWithBoundary } from '../src/browser/renderBoundary.js';

describe('Gate 19 renderer failure boundary', () => {
  it('returns normal markup and no failure for a successful renderer', () => {
    expect(renderWithBoundary(() => '<section>ok</section>')).toEqual({ markup: '<section>ok</section>', failure: null });
  });

  it('contains a thrown renderer failure with stable bounded state and safe markup', () => {
    const result = renderWithBoundary(() => { throw new Error('<script>alert(1)</script>\n' + 'x'.repeat(500)); });
    expect(result.failure?.code).toBe('renderer-failure');
    expect(result.failure?.detail.length).toBeLessThanOrEqual(180);
    expect(result.markup).toContain('data-papers-visual-key="renderer-failure"');
    expect(result.markup).toContain('Renderer failed safely');
    expect(result.markup).toContain('&lt;script&gt;');
    expect(result.markup).not.toContain('<script>');
    expect(renderWithBoundary(() => '<section>recovered</section>')).toEqual({ markup: '<section>recovered</section>', failure: null });
  });
});
