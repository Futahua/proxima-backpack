import { describe, expect, it } from 'vitest';
import { createCanvasTextPreviewRegistry, disposeCanvasTextPreviewsOnPageHide, MAX_CANVAS_TEXT_PREVIEW_CHARS, MAX_CANVAS_TEXT_PREVIEW_ITEMS } from '../src/browser/canvasTextPreview.js';

const seed = { kind: 'text' as const, text: '<script>alert(1)</script>\n[link](javascript:alert(1))' };

describe('Gate 8F literal text preview registry', () => {
  it('retains literal text only and exposes no parser semantics', () => {
    const registry = createCanvasTextPreviewRegistry();
    expect(registry.install('node', seed)).toBe(true);
    expect(registry.get('node')).toMatchObject({ presentation: { kind: 'text', text: seed.text, charLength: seed.text.length }, failure: null });
  });

  it('rejects oversized text without silent truncation', () => {
    const registry = createCanvasTextPreviewRegistry();
    const text = 'x'.repeat(MAX_CANVAS_TEXT_PREVIEW_CHARS + 1);
    expect(registry.install('node', { kind: 'text', text })).toBe(false);
    expect(registry.get('node')).toMatchObject({ presentation: null, failure: 'preview-too-large' });
    expect(registry.totalChars()).toBe(0);
  });

  it('accounts replacement/removal and BFCache lifecycle idempotently', () => {
    const registry = createCanvasTextPreviewRegistry();
    registry.install('node', { kind: 'text', text: 'one' });
    registry.install('node', { kind: 'text', text: 'two-two' });
    expect(registry.totalChars()).toBe(7);
    disposeCanvasTextPreviewsOnPageHide({ persisted: true }, registry);
    expect(registry.get('node').presentation?.text).toBe('two-two');
    disposeCanvasTextPreviewsOnPageHide({ persisted: false }, registry);
    registry.clear();
    expect(registry.totalChars()).toBe(0);
  });

  it('counts failed diagnostics toward the finite item budget', () => {
    const registry = createCanvasTextPreviewRegistry();
    const huge = 'x'.repeat(MAX_CANVAS_TEXT_PREVIEW_CHARS + 1);
    for (let index = 0; index < MAX_CANVAS_TEXT_PREVIEW_ITEMS; index += 1) expect(registry.install(`n${index}`, { kind: 'text', text: huge })).toBe(false);
    expect(registry.snapshot().size).toBe(MAX_CANVAS_TEXT_PREVIEW_ITEMS);
    expect(registry.install('overflow', { kind: 'text', text: 'ok' })).toBe(false);
  });
});
