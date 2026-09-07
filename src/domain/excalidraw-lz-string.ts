/*
 * LZ-String decompression, vendored verbatim.
 *
 * The Obsidian Excalidraw plugin stores a drawing's scene as `compressed-json`,
 * which is LZ-String base64, so reading the creator's actual drawings requires this
 * algorithm. It is copied rather than reimplemented: a hand-written LZ decoder is
 * the kind of deceptively small compatibility task that produces "works on my
 * sample" corruption, and corruption here would render a scene nobody drew.
 *
 * Only the decompression half is present. Proxima does not write drawings, so it
 * has no business carrying a compressor.
 *
 * Vendored rather than depended upon because the build is tsc-only with no bundler
 * and the Papers CSP forbids fetching anything at runtime — the implementation has
 * to be physically present in the build output.
 *
 * Upstream: lz-string 1.5.0, https://github.com/pieroxy/lz-string
 * The decompression body below is unchanged from upstream apart from types.
 *
 * Copyright (c) 2013 Pieroxy <pieroxy@pieroxy.net>
 * This work is free. You can redistribute it and/or modify it
 * under the terms of the WTFPL, Version 2.
 * For more information see http://www.wtfpl.net/
 */

/* eslint-disable */

const KEY_STR_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

const baseReverseDic: Record<string, Record<string, number>> = {};

function getBaseValue(alphabet: string, character: string): number {
  const existing = baseReverseDic[alphabet];
  if (existing) return existing[character] as number;
  const map: Record<string, number> = {};
  for (let i = 0; i < alphabet.length; i += 1) map[alphabet.charAt(i)] = i;
  baseReverseDic[alphabet] = map;
  return map[character] as number;
}

/**
 * Decompress an LZ-String base64 payload.
 *
 * Returns null for anything it cannot decode rather than a partial or empty
 * string. A decoder that quietly yields something parseable is worse than one that
 * admits defeat: the caller would render a drawing nobody made.
 */
export function decompressFromBase64(input: string): string | null {
  if (typeof input !== 'string' || input === '') return null;
  try {
    const result = lzDecompress(input.length, 32, (index: number) => getBaseValue(KEY_STR_BASE64, input.charAt(index)));
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

function lzDecompress(length: number, resetValue: number, getNextValue: (index: number) => number): string | null {
  const f = String.fromCharCode;
  var dictionary: any[] = [],
      next,
      enlargeIn = 4,
      dictSize = 4,
      numBits = 3,
      entry: string = "",
      result = [],
      i,
      w: string = "",
      bits, resb, maxpower, power,
      c,
      data = {val:getNextValue(0), position:resetValue, index:1};

  for (i = 0; i < 3; i += 1) {
    dictionary[i] = i;
  }

  bits = 0;
  maxpower = Math.pow(2,2);
  power=1;
  while (power!=maxpower) {
    resb = data.val & data.position;
    data.position >>= 1;
    if (data.position == 0) {
      data.position = resetValue;
      data.val = getNextValue(data.index++);
    }
    bits |= (resb>0 ? 1 : 0) * power;
    power <<= 1;
  }

  switch (next = bits) {
    case 0:
        bits = 0;
        maxpower = Math.pow(2,8);
        power=1;
        while (power!=maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb>0 ? 1 : 0) * power;
          power <<= 1;
        }
      c = f(bits);
      break;
    case 1:
        bits = 0;
        maxpower = Math.pow(2,16);
        power=1;
        while (power!=maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb>0 ? 1 : 0) * power;
          power <<= 1;
        }
      c = f(bits);
      break;
    case 2:
      return "";
  }
  dictionary[3] = c;
  w = String(c);
  result.push(c);
  while (true) {
    if (data.index > length) {
      return "";
    }

    bits = 0;
    maxpower = Math.pow(2,numBits);
    power=1;
    while (power!=maxpower) {
      resb = data.val & data.position;
      data.position >>= 1;
      if (data.position == 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb>0 ? 1 : 0) * power;
      power <<= 1;
    }

    switch (c = bits) {
      case 0:
        bits = 0;
        maxpower = Math.pow(2,8);
        power=1;
        while (power!=maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb>0 ? 1 : 0) * power;
          power <<= 1;
        }

        dictionary[dictSize++] = f(bits);
        c = dictSize-1;
        enlargeIn--;
        break;
      case 1:
        bits = 0;
        maxpower = Math.pow(2,16);
        power=1;
        while (power!=maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb>0 ? 1 : 0) * power;
          power <<= 1;
        }
        dictionary[dictSize++] = f(bits);
        c = dictSize-1;
        enlargeIn--;
        break;
      case 2:
        return result.join('');
    }

    if (enlargeIn == 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }

    if (dictionary[c]) {
      entry = String(dictionary[c]);
    } else {
      if (c === dictSize) {
        entry = w + w.charAt(0);
      } else {
        return null;
      }
    }
    result.push(entry);

    // Add w+entry[0] to the dictionary.
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;

    w = entry;

    if (enlargeIn == 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }

  }
  
}
