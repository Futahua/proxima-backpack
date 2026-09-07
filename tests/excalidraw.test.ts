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

  it('says it cannot decode a compressed payload rather than inventing a scene', () => {
    const artifact = recogniseExcalidraw(envelope('compressedpayload'), 'a.excalidraw.md');
    expect(artifact.scene).toBeNull();
    expect(artifact.payload).toBe('compressedpayload');
    expect(artifact.problems.map((problem) => problem.code)).toEqual(['encoding-unsupported']);
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
});
