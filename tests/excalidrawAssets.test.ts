import { describe, expect, it } from 'vitest';
import { buildAssetIndex, resolveEmbeddedLink } from '../src/domain/excalidrawAssets.js';

/**
 * Gate 7D — resolving an Excalidraw embedded-file reference.
 *
 * The safety property under test is that the resolver never guesses. Zero matches
 * and several matches are different answers requiring different fixes, and neither
 * may quietly become a file: an image chosen by index order is a confidently wrong
 * picture, which is worse than a visible gap.
 *
 * Both real cases come from the creator's vault. One embed resolves to an
 * attachment; the other is dangling. The ambiguity case is synthetic because the
 * vault happens not to contain one.
 */

const index = buildAssetIndex({
  '-Hide/Attachments/Pasted Image 20260605223658_755.png': 'r1',
  '-Hide/Attachments/1.webp': 'r2',
  '-Hide/Proxima/projects/proj-a/index.md': 'r3',
  'Notes/Shared Name.png': 'r4',
  'Archive/Shared Name.png': 'r5',
});

describe('the two cases the real vault provides', () => {
  it('resolves the attachment the drawing actually embeds', () => {
    const result = resolveEmbeddedLink(index, '[[Pasted Image 20260605223658_755.png]]');
    expect(result.status).toBe('resolved');
    expect(result.entry?.relativePath).toBe('-Hide/Attachments/Pasted Image 20260605223658_755.png');
    expect(result.entry?.sourceRevision).toBe('r1');
  });

  it('reports the dangling link as unresolved rather than as an error', () => {
    // A legitimate drawing can carry a reference to something that no longer
    // exists; that degrades the asset, never the drawing.
    const result = resolveEmbeddedLink(index, '[[Ôn sử đảng]]');
    expect(result.status).toBe('unresolved');
    expect(result.matchCount).toBe(0);
    expect(result.entry).toBeNull();
    expect(result.target).toBe('Ôn sử đảng');
  });
});

describe('never guessing', () => {
  it('calls two identically named files ambiguous and selects neither', () => {
    const result = resolveEmbeddedLink(index, '[[Shared Name.png]]');
    expect(result.status).toBe('ambiguous');
    expect(result.matchCount).toBe(2);
    expect(result.entry).toBeNull();
  });

  it('separates ambiguous from unresolved, because they need different fixes', () => {
    expect(resolveEmbeddedLink(index, '[[Shared Name.png]]').status).not.toBe(
      resolveEmbeddedLink(index, '[[Nothing At All]]').status,
    );
  });

  it('an explicit path disambiguates what a bare name cannot', () => {
    const result = resolveEmbeddedLink(index, '[[Archive/Shared Name.png]]');
    expect(result.status).toBe('resolved');
    expect(result.entry?.relativePath).toBe('Archive/Shared Name.png');
  });
});

describe('link syntax, narrowly', () => {
  it('understands a display alias and ignores the display half', () => {
    expect(resolveEmbeddedLink(index, '[[1.webp|a picture]]').status).toBe('resolved');
  });

  it('matches a bare name on its stem', () => {
    expect(resolveEmbeddedLink(index, '[[1]]').status).toBe('resolved');
  });

  it('accepts a bare target without the brackets', () => {
    expect(resolveEmbeddedLink(index, '1.webp').status).toBe('resolved');
  });

  it('is case-insensitive about the name but exact about the file', () => {
    const result = resolveEmbeddedLink(index, '[[pasted image 20260605223658_755.PNG]]');
    expect(result.status).toBe('resolved');
    expect(result.entry?.relativePath).toBe('-Hide/Attachments/Pasted Image 20260605223658_755.png');
  });
});

describe('references that are not vault assets', () => {
  it.each([
    ['a heading reference', '[[Note#Heading]]'],
    ['a block reference', '[[Note^block]]'],
    ['an absolute path', '[[/etc/passwd]]'],
    ['a Windows path', '[[C:/Windows/win.ini]]'],
    ['a traversal attempt', '[[../../secrets.png]]'],
    ['a URL', '[[https://example.com/image.png]]'],
    ['an empty link', '[[]]'],
    ['whitespace only', '[[   ]]'],
  ])('rejects %s', (_label, link) => {
    const result = resolveEmbeddedLink(index, link);
    expect(result.status).toBe('rejected');
    expect(result.entry).toBeNull();
  });

  it('rejects an absurdly long target rather than scanning for it', () => {
    expect(resolveEmbeddedLink(index, `[[${'a'.repeat(5000)}]]`).status).toBe('rejected');
  });
});

describe('index construction', () => {
  it('derives basename, stem and extension from a path', () => {
    const [entry] = buildAssetIndex({ 'a/b/Some File.PNG': 'rev' });
    expect(entry).toMatchObject({
      relativePath: 'a/b/Some File.PNG',
      basename: 'Some File.PNG',
      stem: 'Some File',
      extension: 'png',
      sourceRevision: 'rev',
    });
  });

  it('handles a file with no extension', () => {
    const [entry] = buildAssetIndex({ 'LICENSE': 'rev' });
    expect(entry).toMatchObject({ basename: 'LICENSE', stem: 'LICENSE', extension: '' });
  });
});
