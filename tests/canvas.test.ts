import { describe, expect, it } from 'vitest';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import {
  createCanvasNode,
  markCanvasNodeMissing,
  markCanvasNodeUnavailable,
  reobserveCanvasNode,
  validateVaultRelativePath,
} from '../src/domain/canvas.js';

const source = (path: string, state: 'available' | 'missing' | 'unavailable' = 'available') => ({
  path,
  state,
  revision: 'r1',
  size: 42,
  modifiedAt: '2026-09-07T00:00:00.000Z',
});

describe('Gate 8A canvas nodes', () => {
  it('uses injected Proxima identity and a passive fallback', () => {
    const node = createCanvasNode(sequentialIdGenerator(), source('Attachments/thing.xyz'));
    expect(node.id).toBe('canvas-node-0001');
    expect(node.source.path).toBe('Attachments/thing.xyz');
    expect(node.representation).toMatchObject({ kind: 'fallback', filename: 'thing.xyz', extension: 'xyz', sourceState: 'available' });
    expect(node.representation).not.toHaveProperty('html');
  });

  it('keeps identity and layout stable across a source rename', () => {
    const node = createCanvasNode(sequentialIdGenerator(), source('Notes/a.bin'));
    const renamed = reobserveCanvasNode(node, source('Archive/a.bin', 'available'));
    expect(renamed.id).toBe(node.id);
    expect(renamed.layout).toEqual(node.layout);
    expect(renamed.source).toMatchObject({ path: 'Archive/a.bin', revision: 'r1' });
    expect(renamed.representation.filename).toBe('a.bin');
  });

  it('keeps a deleted node and last-known metadata as missing', () => {
    const node = createCanvasNode(sequentialIdGenerator(), source('Notes/a.bin'));
    const missing = markCanvasNodeMissing(node);
    expect(missing.id).toBe(node.id);
    expect(missing.layout).toEqual(node.layout);
    expect(missing.source).toMatchObject({ path: 'Notes/a.bin', state: 'missing', revision: 'r1', size: 42 });
    expect(missing.representation).toMatchObject({ filename: 'a.bin', sourceState: 'missing', revision: 'r1', size: 42 });
  });

  it('represents an unavailable source without dropping the node', () => {
    const node = createCanvasNode(sequentialIdGenerator(), source('Notes/a.bin'));
    const unavailable = markCanvasNodeUnavailable(node);
    expect(unavailable.id).toBe(node.id);
    expect(unavailable.source.state).toBe('unavailable');
    expect(unavailable.representation.sourceState).toBe('unavailable');
  });

  it('preserves node identity when only revision changes', () => {
    const node = createCanvasNode(sequentialIdGenerator(), source('Notes/a.bin'));
    const changed = reobserveCanvasNode(node, { ...source('Notes/a.bin'), revision: 'r2' });
    expect(changed.id).toBe(node.id);
    expect(changed.layout).toEqual(node.layout);
    expect(changed.source.revision).toBe('r2');
  });

  it('rejects absolute, drive, traversal and malformed locators', () => {
    for (const path of ['/etc/passwd', '//server/share/a.bin', '\\\\server\\share\\a.bin', 'C:\\temp\\a.bin', 'file:///etc/passwd', 'a/../b', './b', 'a//b', 'a\\b', '']) {
      expect(() => validateVaultRelativePath(path)).toThrow();
    }
    expect(validateVaultRelativePath('Attachments/photo.png')).toBe('Attachments/photo.png');
  });

  it('validates layout instead of allowing invalid canvas geometry', () => {
    expect(() => createCanvasNode(sequentialIdGenerator(), source('a.bin'), { x: 0, y: 0, width: 0, height: 20 })).toThrow();
    expect(() => createCanvasNode(sequentialIdGenerator(), source('a.bin'), { x: Number.NaN, y: 0, width: 20, height: 20 })).toThrow();
  });

  it('keeps active or unknown files passive fallback cards', () => {
    const ids = sequentialIdGenerator();
    for (const path of ['thing.xyz', 'page.html', 'script.js', 'tool.exe', 'README']) {
      const node = createCanvasNode(ids, source(path));
      expect(node.representation.kind).toBe('fallback');
      expect(node.representation.filename).toBe(path.split('/').pop());
    }
  });

  it('represents absent metadata as unavailable instead of fabricating it', () => {
    const node = createCanvasNode(sequentialIdGenerator(), { path: 'photo.PNG', state: 'available' });
    expect(node.representation).toMatchObject({ filename: 'photo.PNG', extension: 'png', revision: null, size: null, modifiedAt: null });
  });
});
