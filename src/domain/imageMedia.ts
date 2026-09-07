/**
 * What kind of image a byte array actually is.
 *
 * Determined from the file's own signature, never from its extension. A `.png`
 * suffix is a claim made by whoever named the file; the bytes are the fact. Trusting
 * the name means a renderer can be handed something it did not agree to display,
 * which is the whole reason this check exists rather than a string comparison.
 *
 * SVG is deliberately absent from the allowlist. It is not a byte array that decodes
 * to pixels — it is markup with its own scripting and reference surface — so
 * admitting it is a security decision rather than a format decision, and one nothing
 * currently requires.
 */

export type SupportedImageMedia = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type ImageMediaResult =
  | { supported: true; mediaType: SupportedImageMedia }
  | { supported: false; reason: 'unsupported-media' | 'too-short' };

/** Signatures are checked in full; a prefix match on two bytes is not identification. */
export function detectImageMedia(bytes: Uint8Array): ImageMediaResult {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
    return { supported: false, reason: 'too-short' };
  }

  // PNG: \x89PNG\r\n\x1a\n
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { supported: true, mediaType: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (matches(bytes, [0xff, 0xd8, 0xff])) {
    return { supported: true, mediaType: 'image/jpeg' };
  }
  // GIF87a / GIF89a
  if (matches(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { supported: true, mediaType: 'image/gif' };
  }
  // WebP: RIFF....WEBP — both halves, since RIFF alone is a container, not a format.
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { supported: true, mediaType: 'image/webp' };
  }

  return { supported: false, reason: 'unsupported-media' };
}

function matches(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 for a `data:` URL, without depending on `btoa` or Node's Buffer.
 *
 * The domain compiles with no Node types and runs in a sandboxed page, so it cannot
 * assume either. Encoding is only reached for bytes that already passed the size
 * bounds, so the string it builds is bounded too.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64[b0 >> 2];
    out += BASE64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(value: string): Uint8Array | null {
  const clean = value.replace(/\s+/g, '');
  if (clean === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const lookup = new Map<string, number>();
  for (let i = 0; i < BASE64.length; i += 1) lookup.set(BASE64[i] as string, i);

  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let position = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((offset) => lookup.get(clean[i + offset] as string) ?? 0);
    const triple = ((chunk[0] as number) << 18) | ((chunk[1] as number) << 12) | ((chunk[2] as number) << 6) | (chunk[3] as number);
    if (position < out.length) out[position++] = (triple >> 16) & 0xff;
    if (position < out.length) out[position++] = (triple >> 8) & 0xff;
    if (position < out.length) out[position++] = triple & 0xff;
  }
  return out;
}

/** A `data:` URL for an image whose media type has already been established. */
export function imageDataUrl(mediaType: SupportedImageMedia, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}
