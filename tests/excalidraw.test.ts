import { describe, expect, it } from 'vitest';
import { recogniseExcalidraw } from '../src/domain/excalidraw.js';

/**
 * Gate 7A/7B — recognising a real Excalidraw artifact by its structure.
 *
 * The two rules under test: a file is a drawing because of what it contains, never
 * because of what it is called; and an artifact this build cannot decode is reported
 * as such rather than guessed at. One bad drawing must degrade that drawing, not the
 * session.
 */

const envelope = (drawing: string, fence = 'compressed-json') => `---
excalidraw-plugin: parsed
tags: [excalidraw]
---

# Excalidraw Data

## Text Elements
A line with an anchor ^lGqbdCxY
A line without one

## Embedded Files
1bcca9d390e97603b688b8ed5d0227ae66f9ceb7: [[Ôn sử đảng]]

%%
## Drawing
\`\`\`${fence}
${drawing}
\`\`\`
%%`;

const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'a', type: 'rectangle' }], appState: {} });

describe('structural recognition', () => {
  it('reads the Obsidian envelope, its text elements and its embeds', () => {
    const artifact = recogniseExcalidraw(envelope('N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JRJQgEYA6bGwC2CgF7N6hbEcK4OCtptbErHALRY8RMpWdx8Q1TdIEfARcZgRmBShcZR5tHgBmbQB2GjoghH0EDihmbgBtcDBQMBKIEm4IfQAreIApWoBJAFkAZXxsACEAaTaAMygADQAZHmIACVSSyFhECt7AhE8qflLM'), 'Untitled Drawing.excalidraw.md');
    expect(artifact.kind).toBe('obsidian-envelope');
    expect(artifact.encoding).toBe('compressed-json');
    expect(artifact.textElements).toEqual([
      { text: 'A line with an anchor', anchor: 'lGqbdCxY' },
      { text: 'A line without one', anchor: null },
    ]);
    expect(artifact.embeddedFiles).toEqual([
      { key: '1bcca9d390e97603b688b8ed5d0227ae66f9ceb7', link: 'Ôn sử đảng' },
    ]);
  });

  it('never invents a scene from a compressed payload it cannot make sense of', () => {
    // This asserted `encoding-unsupported` while decoding was unimplemented. Now
    // the payload is decoded and found to be nonsense; the rule it guards is
    // unchanged — no scene, and a bounded reason — so the assertion follows the
    // behaviour rather than the other way round.
    const artifact = recogniseExcalidraw(envelope('compressedpayload'), 'a.excalidraw.md');
    expect(artifact.scene).toBeNull();
    expect(artifact.payload).toBe('compressedpayload');
    expect(artifact.problems).toHaveLength(1);
    expect(['decode-failed', 'payload-unparsable', 'scene-shape-invalid']).toContain(artifact.problems[0]?.code);
  });

  it('parses an uncompressed envelope scene', () => {
    const artifact = recogniseExcalidraw(envelope(scene, 'json'), 'a.excalidraw.md');
    expect(artifact.encoding).toBe('json');
    expect(artifact.scene?.elements).toHaveLength(1);
    expect(artifact.problems).toEqual([]);
  });

  it('reads a native .excalidraw scene', () => {
    const artifact = recogniseExcalidraw(scene, 'drawing.excalidraw');
    expect(artifact.kind).toBe('native-json');
    expect(artifact.scene?.version).toBe(2);
    expect(artifact.problems).toEqual([]);
  });

  it('decides by structure, not by filename', () => {
    // Named like a note, shaped like a drawing.
    expect(recogniseExcalidraw(envelope(scene, 'json'), 'ordinary-note.md').kind).toBe('obsidian-envelope');
    // Named like a drawing, shaped like prose.
    const mislabelled = recogniseExcalidraw('just some writing, honestly', 'sketch.excalidraw');
    expect(mislabelled.kind).toBe('not-excalidraw');
    expect(mislabelled.problems.map((problem) => problem.code)).toEqual(['payload-unparsable']);
  });
});

describe('failure surfaces', () => {
  it('reports malformed JSON in a drawing block without throwing', () => {
    const artifact = recogniseExcalidraw(envelope('{ "elements": [', 'json'), 'a.excalidraw.md');
    expect(artifact.kind).toBe('obsidian-envelope');
    expect(artifact.scene).toBeNull();
    expect(artifact.problems.map((problem) => problem.code)).toEqual(['payload-unparsable']);
  });

  it('rejects valid JSON that is not an Excalidraw scene', () => {
    const artifact = recogniseExcalidraw(envelope('{"hello":"world"}', 'json'), 'a.excalidraw.md');
    expect(artifact.problems.map((problem) => problem.code)).toEqual(['scene-shape-invalid']);
  });

  it('reports an envelope with no drawing block', () => {
    const artifact = recogniseExcalidraw('---\nexcalidraw-plugin: parsed\n---\n\nnothing here\n', 'a.excalidraw.md');
    expect(artifact.problems.map((problem) => problem.code)).toEqual(['drawing-block-missing']);
  });

  it('reports an unreadable embed line and keeps the readable ones', () => {
    const text = envelope(scene, 'json').replace(
      '1bcca9d390e97603b688b8ed5d0227ae66f9ceb7: [[Ôn sử đảng]]',
      '1bcca9d390e97603b688b8ed5d0227ae66f9ceb7: [[Ôn sử đảng]]\nthis line is not an embed',
    );
    const artifact = recogniseExcalidraw(text, 'a.excalidraw.md');
    expect(artifact.embeddedFiles).toHaveLength(1);
    expect(artifact.problems.map((problem) => problem.code)).toContain('embed-unreadable');
  });

  it('treats empty and whitespace files as not a drawing', () => {
    expect(recogniseExcalidraw('', 'a.excalidraw').kind).toBe('not-excalidraw');
    expect(recogniseExcalidraw('   \n\n', 'a.md').kind).toBe('not-excalidraw');
  });

  it('accepts an empty but valid scene', () => {
    const artifact = recogniseExcalidraw(JSON.stringify({ type: 'excalidraw', elements: [] }), 'empty.excalidraw');
    expect(artifact.kind).toBe('native-json');
    expect(artifact.scene?.elements).toEqual([]);
    expect(artifact.problems).toEqual([]);
  });

  it('bounds what it reports from an unusually large drawing', () => {
    const many = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');
    const text = envelope(scene, 'json').replace('A line with an anchor ^lGqbdCxY\nA line without one', many);
    const artifact = recogniseExcalidraw(text, 'big.excalidraw.md');
    expect(artifact.textElements.length).toBeLessThanOrEqual(200);
  });

  it('fails closed instead of hiding embedded mappings beyond the cap', () => {
    const embeds = Array.from({ length: 201 }, (_, index) => `${index.toString(16)}: [[image-${index}.png]]`).join('\n');
    const text = envelope(scene, 'json').replace('1bcca9d390e97603b688b8ed5d0227ae66f9ceb7: [[Ôn sử đảng]]', embeds);
    const artifact = recogniseExcalidraw(text, 'large-embeds.excalidraw.md');
    expect(artifact.embeddedFiles).toEqual([]);
    expect(artifact.problems).toContainEqual({ code: 'embed-limit-exceeded', detail: 'more than 200 embedded files' });
  });
});

/**
 * Gate 7C — decoding the encoding the creator's own drawings actually use.
 *
 * This payload is genuinely LZ-String-compressed, produced by the upstream
 * compressor rather than hand-written, and wrapped across lines exactly as the
 * Obsidian plugin wraps its own. A synthetic "looks compressed" string would prove
 * nothing about the algorithm.
 */
const REAL_COMPRESSED_SCENE = [
  'N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkTBg0wZJJhgBbGIzA0EAbVB4EIfAEYRkWMvwxU',
  'YdIwDmYkcgSqADOQisrIInjAALcxbtOY2Q0+HwArHYGxnx2Qvj0ANYwAML0mPT4ygDEqjCpqSAAvqSKuMpg6uSafOAowuRm8Kp+1',
  'ggAzHYCyL4gHpjxIgBmTGAAytgAXnwsFtm5yuiF4NAl6PjhJBUIdjbwdlD02NKy8HJyVhYAuqRyACxW54fHIEJzYABCW7hbhgigM',
  'GKS0gCSeYhqWUy13QUCgvX0AjelGwMCI93QqAihnCnEYuFi8USiCSnVxeKy5E62DEO2AmUyQA===',
].join('\n');

describe('compressed-json decoding', () => {
  it('decodes a real compressed payload into a usable scene', () => {
    const artifact = recogniseExcalidraw(envelope(REAL_COMPRESSED_SCENE), 'Untitled Drawing.excalidraw.md');
    expect(artifact.encoding).toBe('compressed-json');
    expect(artifact.problems).toEqual([]);
    expect(artifact.scene?.type).toBe('excalidraw');
    expect(artifact.scene?.version).toBe(2);
    expect(artifact.scene?.elements).toHaveLength(3);
  });

  it('preserves geometry, text and connectors through the decode', () => {
    const artifact = recogniseExcalidraw(envelope(REAL_COMPRESSED_SCENE), 'a.excalidraw.md');
    const elements = (artifact.scene?.elements ?? []) as Array<Record<string, unknown>>;
    const rectangle = elements.find((element) => element.id === 'r1');
    const text = elements.find((element) => element.type === 'text');
    const arrow = elements.find((element) => element.type === 'arrow');

    expect(rectangle).toMatchObject({ x: 10, y: 20, width: 100, height: 50, strokeColor: '#1e1e1e' });
    expect(text).toMatchObject({ text: 'hello', fontSize: 20 });
    expect(arrow?.points).toEqual([[0, 0], [40, 40]]);
    // A connector's binding is what makes it a connector rather than a line.
    expect(arrow?.startBinding).toMatchObject({ elementId: 'r1' });
    expect(artifact.scene?.appState).toMatchObject({ viewBackgroundColor: '#ffffff' });
  });

  it('keeps element order, which is z-order', () => {
    const artifact = recogniseExcalidraw(envelope(REAL_COMPRESSED_SCENE), 'a.excalidraw.md');
    const ids = ((artifact.scene?.elements ?? []) as Array<{ id?: string }>).map((element) => element.id);
    expect(ids).toEqual(['r1', 't1', 'a1']);
  });

  it('reports a corrupted compressed payload rather than yielding a partial scene', () => {
    // Truncation is the realistic corruption: a decoder that returns whatever it
    // managed would hand the surface a drawing nobody made.
    const truncated = REAL_COMPRESSED_SCENE.slice(0, 120);
    const artifact = recogniseExcalidraw(envelope(truncated), 'a.excalidraw.md');
    expect(artifact.scene).toBeNull();
    expect(artifact.problems.map((problem) => problem.code)[0]).toMatch(/decode-failed|payload-unparsable|scene-shape-invalid/);
  });

  it('reports garbage in a compressed block without throwing', () => {
    const artifact = recogniseExcalidraw(envelope('!!!! not base64 at all !!!!'), 'a.excalidraw.md');
    expect(artifact.scene).toBeNull();
    expect(artifact.problems.length).toBeGreaterThan(0);
    expect(artifact.kind).toBe('obsidian-envelope');
  });

  it('rejects an alphabet-invalid byte even when the payload length is intact', () => {
    const corrupted = `${REAL_COMPRESSED_SCENE.slice(0, 20)}?${REAL_COMPRESSED_SCENE.slice(21)}`;
    const artifact = recogniseExcalidraw(envelope(corrupted), 'a.excalidraw.md');
    expect(artifact.scene).toBeNull();
    expect(artifact.problems.map((problem) => problem.code)).toContain('decode-failed');
  });

  it('still reads the envelope summary when the scene cannot be decoded', () => {
    // The text elements are what a canvas can still show for an undecodable drawing.
    const artifact = recogniseExcalidraw(envelope('!!!!'), 'a.excalidraw.md');
    expect(artifact.textElements).toHaveLength(2);
    expect(artifact.embeddedFiles).toHaveLength(1);
  });
});
