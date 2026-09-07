import { describe, expect, it } from 'vitest';
import { canvasFallbackIcon } from '../src/browser/canvasFallbackIcon.js';

describe('Gate 8G static fallback icon categories', () => {
  it('maps known passive/active categories to fixed tokens', () => {
    expect(canvasFallbackIcon('bin').token).toBe('FILE');
    expect(canvasFallbackIcon('md').token).toBe('TXT');
    expect(canvasFallbackIcon('png').token).toBe('IMG');
    expect(canvasFallbackIcon('excalidraw').token).toBe('DRAW');
    expect(canvasFallbackIcon('pdf').token).toBe('PDF');
    expect(canvasFallbackIcon('svg').token).toBe('SVG');
    expect(canvasFallbackIcon('html').token).toBe('SAFE');
  });

  it('is total and does not echo adversarial extension strings', () => {
    const icon = canvasFallbackIcon('<script>alert(1)</script>');
    expect(icon.token).toBe('FILE');
    expect(icon.label).not.toContain('<script>');
  });
});
