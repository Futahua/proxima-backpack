import { describe, expect, it } from 'vitest';
import { assetCensus, loadDrawingAssets } from '../src/app/excalidrawAssetLoader.js';
import { buildAssetIndex } from '../src/domain/excalidrawAssets.js';
import { base64ToBytes, bytesToBase64, detectImageMedia } from '../src/domain/imageMedia.js';
import type { VaultBinaryFile, VaultReader } from '../src/ports/vault.js';

/**
 * Gate 7D asset loading.
 *
 * Every case here degrades one asset and leaves the rest of the drawing intact.
 * The bounds are tested separately from each other on purpose: a per-asset ceiling
 * alone still permits an unbounded total, which is exactly how a modest drawing
 * referencing many large photographs becomes a memory problem.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9, 9]);
const NOT_AN_IMAGE = new Uint8Array(Array.from('<?xml version="1.0"?><svg/>').map((c) => c.charCodeAt(0)));

function vaultWith(files: Record<string, Uint8Array>, options: { omitBinary?: boolean; throwOn?: string } = {}): VaultReader {
  const reader: VaultReader = {
    list: async () => [],
    walk: async () => Object.keys(files),
    exists: async (path) => path in files,
    read: async () => { throw new Error('text read not used here'); },
  };
  if (!options.omitBinary) {
    reader.readBinary = async (path: string): Promise<VaultBinaryFile> => {
      if (options.throwOn === path) throw new Error('denied');
      const bytes = files[path];
      if (!bytes) throw new Error('missing');
      return { path, bytes, size: bytes.length, revision: `rev-${path}`, modifiedAt: '2026-09-07T00:00:00.000Z' };
    };
  }
  return reader;
}

const index = buildAssetIndex({
  'Attachments/photo.png': 'r1',
  'Attachments/scan.jpg': 'r2',
  'Attachments/notes.txt': 'r3',
  'One/Same.png': 'r4',
  'Two/Same.png': 'r5',
});

const embed = (key: string, link: string) => ({ key, link });

describe('loading an asset that resolves', () => {
  it('returns bytes as a data URL the renderer can use, with provenance', async () => {
    const vault = vaultWith({ 'Attachments/photo.png': PNG });
    const result = await loadDrawingAssets(vault, index, [embed('f1', 'photo.png')]);

    expect(result.assets.f1).toMatch(/^data:image\/png;base64,/);
    const asset = result.loaded[0];
    expect(asset).toMatchObject({
      outcome: 'resolved',
      mediaType: 'image/png',
      sourcePath: 'Attachments/photo.png',
      bytes: PNG.length,
    });
    // Provenance travels with the bytes, so the picture is tied to a vault state.
    expect(asset?.sourceRevision).toBe('rev-Attachments/photo.png');
  });

  it('identifies media from the bytes, not the extension', async () => {
    // A file named .png that is actually a JPEG is still a JPEG.
    const vault = vaultWith({ 'Attachments/photo.png': JPEG });
    const result = await loadDrawingAssets(vault, index, [embed('f1', 'photo.png')]);
    expect(result.loaded[0]?.mediaType).toBe('image/jpeg');
  });
});

describe('each failure degrades one asset', () => {
  it('reports a dangling reference as unresolved', async () => {
    const result = await loadDrawingAssets(vaultWith({}), index, [embed('f1', 'Nothing Here')]);
    expect(result.loaded[0]?.outcome).toBe('unresolved');
    expect(result.assets).toEqual({});
  });

  it('reports an ambiguous reference without choosing', async () => {
    const result = await loadDrawingAssets(vaultWith({}), index, [embed('f1', 'Same.png')]);
    expect(result.loaded[0]?.outcome).toBe('ambiguous');
    expect(result.loaded[0]?.sourcePath).toBeNull();
  });

  it('reports a reference that is not a vault asset at all', async () => {
    const result = await loadDrawingAssets(vaultWith({}), index, [embed('f1', 'https://example.com/x.png')]);
    expect(result.loaded[0]?.outcome).toBe('rejected');
  });

  it('reports a source that cannot return bytes', async () => {
    const vault = vaultWith({ 'Attachments/photo.png': PNG }, { omitBinary: true });
    const result = await loadDrawingAssets(vault, index, [embed('f1', 'photo.png')]);
    expect(result.loaded[0]?.outcome).toBe('capability-unavailable');
    // The path was still identified; only the bytes are missing.
    expect(result.loaded[0]?.sourcePath).toBe('Attachments/photo.png');
  });

  it('reports an asset that cannot be read', async () => {
    const vault = vaultWith({ 'Attachments/photo.png': PNG }, { throwOn: 'Attachments/photo.png' });
    const result = await loadDrawingAssets(vault, index, [embed('f1', 'photo.png')]);
    expect(result.loaded[0]?.outcome).toBe('unreadable');
  });

  it('refuses bytes that are not a supported image', async () => {
    // SVG is excluded deliberately: it is markup with its own reference surface,
    // not a byte array that decodes to pixels.
    const vault = vaultWith({ 'Attachments/notes.txt': NOT_AN_IMAGE });
    const result = await loadDrawingAssets(vault, index, [embed('f1', 'notes.txt')]);
    expect(result.loaded[0]?.outcome).toBe('unsupported-media');
    expect(result.assets).toEqual({});
  });

  it('keeps loading the other assets when one fails', async () => {
    const vault = vaultWith({ 'Attachments/photo.png': PNG });
    const result = await loadDrawingAssets(vault, index, [embed('bad', 'Nothing Here'), embed('good', 'photo.png')]);
    expect(result.loaded.map((asset) => asset.outcome)).toEqual(['unresolved', 'resolved']);
    expect(Object.keys(result.assets)).toEqual(['good']);
  });
});

describe('three independent bounds', () => {
  it('rejects an asset over the per-asset ceiling', async () => {
    const big = new Uint8Array(2000);
    big.set(PNG.slice(0, 8));
    const vault = vaultWith({ 'Attachments/photo.png': big });
    const result = await loadDrawingAssets(vault, index, [embed('f1', 'photo.png')], { maxAssetBytes: 1000 });
    expect(result.loaded[0]?.outcome).toBe('too-large');
    expect(result.totalBytes).toBe(0);
  });

  it('stops at the aggregate budget even when each asset is individually fine', async () => {
    // The case a per-asset limit alone cannot catch.
    const vault = vaultWith({ 'Attachments/photo.png': PNG, 'Attachments/scan.jpg': JPEG });
    const result = await loadDrawingAssets(
      vault,
      index,
      [embed('f1', 'photo.png'), embed('f2', 'scan.jpg')],
      { maxAssetBytes: 1000, maxTotalBytes: PNG.length },
    );
    expect(result.loaded[0]?.outcome).toBe('resolved');
    expect(result.loaded[1]?.outcome).toBe('budget-exhausted');
    expect(result.totalBytes).toBe(PNG.length);
  });

  it('reports references beyond the per-drawing count rather than ignoring them', async () => {
    const vault = vaultWith({ 'Attachments/photo.png': PNG });
    const result = await loadDrawingAssets(
      vault,
      index,
      [embed('f1', 'photo.png'), embed('f2', 'photo.png'), embed('f3', 'photo.png')],
      { maxAssets: 2 },
    );
    expect(result.loaded.map((asset) => asset.outcome)).toEqual(['resolved', 'resolved', 'too-many-assets']);
  });
});

describe('census', () => {
  it('counts every reference by outcome', async () => {
    const vault = vaultWith({ 'Attachments/photo.png': PNG });
    const result = await loadDrawingAssets(vault, index, [embed('a', 'photo.png'), embed('b', 'Nothing'), embed('c', 'Same.png')]);
    const census = assetCensus(result);
    expect(census.total).toBe(3);
    expect(census.resolved).toBe(1);
    expect(census.unresolved).toBe(1);
    expect(census.ambiguous).toBe(1);
  });
});

describe('media detection and encoding', () => {
  it('recognises the formats it admits, and nothing else', () => {
    expect(detectImageMedia(PNG)).toEqual({ supported: true, mediaType: 'image/png' });
    expect(detectImageMedia(JPEG)).toEqual({ supported: true, mediaType: 'image/jpeg' });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1, 1, 1, 1, 1]);
    expect(detectImageMedia(gif)).toEqual({ supported: true, mediaType: 'image/gif' });
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(detectImageMedia(webp)).toEqual({ supported: true, mediaType: 'image/webp' });
    expect(detectImageMedia(NOT_AN_IMAGE).supported).toBe(false);
  });

  it('does not accept a RIFF container that is not WebP', () => {
    const riffWave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectImageMedia(riffWave).supported).toBe(false);
  });

  it('treats a too-short buffer as undetectable rather than guessing', () => {
    const result = detectImageMedia(new Uint8Array([0x89, 0x50]));
    expect(result.supported).toBe(false);
    // The discriminated union means the reason is only reachable once narrowed,
    // which is the type doing its job.
    if (!result.supported) expect(result.reason).toBe('too-short');
  });

  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66]);
    const restored = base64ToBytes(bytesToBase64(bytes));
    expect(Array.from(restored ?? [])).toEqual(Array.from(bytes));
  });

  it('rejects malformed base64 rather than returning partial bytes', () => {
    expect(base64ToBytes('not base64!!')).toBeNull();
    expect(base64ToBytes('QQ')).toBeNull();
  });
});
