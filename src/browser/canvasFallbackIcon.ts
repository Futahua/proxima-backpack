import { canvasExtensionPolicy } from '../domain/canvasRenderer.js';

export type CanvasFallbackIconKind = 'text' | 'image' | 'drawing' | 'svg' | 'pdf' | 'active' | 'file';
export interface CanvasFallbackIcon {
  kind: CanvasFallbackIconKind;
  token: 'TXT' | 'IMG' | 'DRAW' | 'SVG' | 'PDF' | 'SAFE' | 'FILE';
  label: string;
}

/** Pure static category token; it never authorizes a renderer or performs I/O. */
export function canvasFallbackIcon(extension: string): CanvasFallbackIcon {
  const normalized = typeof extension === 'string' ? extension.toLowerCase() : '';
  if (normalized === 'pdf') return { kind: 'pdf', token: 'PDF', label: 'PDF file' };
  if (normalized === 'svg') return { kind: 'svg', token: 'SVG', label: 'SVG file' };
  if (normalized === 'excalidraw') return { kind: 'drawing', token: 'DRAW', label: 'Drawing file' };
  const policy = canvasExtensionPolicy(normalized ? `file.${normalized}` : '');
  if (policy === 'text') return { kind: 'text', token: 'TXT', label: 'Text file' };
  if (policy === 'raster') return { kind: 'image', token: 'IMG', label: 'Image file' };
  if (policy === 'active') return { kind: 'active', token: 'SAFE', label: 'Active content kept passive' };
  return { kind: 'file', token: 'FILE', label: 'File' };
}
