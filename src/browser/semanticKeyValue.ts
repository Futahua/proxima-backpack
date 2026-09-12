/**
 * Papers observes one semantic-key attribute and validates its values before it
 * accepts an observation: each key must be 1-128 characters matching
 * `^[A-Za-z0-9][A-Za-z0-9._~-]*$`, and no key may repeat inside one payload.
 * A payload that breaks any of those rules is refused **whole and in silence**
 * (`registerVisualSemanticKeysIpc` swallows the parse error), so one key derived
 * from a record identity that contains a space makes every key on the surface
 * invisible to `inspect.visual.elements` with no diagnostic anywhere.
 *
 * A record's identity is what the record declares, and a vault file may legitimately
 * be named `Untitled loose task`. The identity is therefore not the key: this module
 * encodes an identity into the host's alphabet, deterministically and injectively, so
 * the key stays stable across runs and two different records can never share one.
 *
 * The encoding is `~` + two uppercase hex digits per UTF-8 byte. `~` itself is always
 * escaped as `~7E`, which makes the escape unambiguous and keeps two different
 * identities apart - a record literally named `a~20b` cannot collide with one named
 * `a b`. A value that would start with anything but a letter or digit is prefixed with
 * `k~`; `~` is never a hex digit, so a prefixed key can never be confused with an
 * escaped byte, not even for an identity that itself contains `k~`.
 *
 * The cost of an unambiguous escape is that encoding is **not idempotent**: applying it
 * to its own output escapes the escapes. That is why {@link normalizeSemanticKeyValues}
 * belongs on freshly rendered markup - the one moment the document holds the raw
 * identities the renderers wrote - and nowhere else.
 */
export const SEMANTIC_KEY_ATTRIBUTE = 'data-papers-visual-key';

/** The host's bound, restated: a longer key is refused with the whole payload. */
export const SEMANTIC_KEY_MAX_LENGTH = 128;

const ALLOWED_CHARACTER = /[A-Za-z0-9._~-]/;
const ALLOWED_FIRST_CHARACTER = /[A-Za-z0-9]/;
const PREFIX = 'k~';
const HASH_LENGTH = 16;
const ENCODER = new TextEncoder();

/** FNV-1a over the encoded text: deterministic, synchronous, no host dependency. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function encodeSemanticKeyValue(value: string): string {
  let encoded = '';
  for (const character of value) {
    if (character === '~') { encoded += '~7E'; continue; }
    if (ALLOWED_CHARACTER.test(character)) { encoded += character; continue; }
    for (const byte of ENCODER.encode(character)) encoded += `~${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (encoded.length > SEMANTIC_KEY_MAX_LENGTH) {
    // Bounded, still injective in practice: the digest is over the whole encoding,
    // so two long identities that share a prefix keep distinct keys.
    const room = SEMANTIC_KEY_MAX_LENGTH - HASH_LENGTH - PREFIX.length;
    encoded = `${encoded.slice(0, room)}${PREFIX}${digest(encoded)}`;
  }
  return ALLOWED_FIRST_CHARACTER.test(encoded.charAt(0)) ? encoded : `${PREFIX}${encoded}`;
}

/**
 * Rewrites every observed key in place and answers how many values changed. Called on
 * the markup the app just wrote, which is the moment the document actually holds the
 * keys the host will read - so every surface, present and future, passes through it.
 */
export function normalizeSemanticKeyValues(root: ParentNode): number {
  let changed = 0;
  root.querySelectorAll<HTMLElement>(`[${SEMANTIC_KEY_ATTRIBUTE}]`).forEach((element) => {
    const value = element.getAttribute(SEMANTIC_KEY_ATTRIBUTE);
    if (value === null) return;
    const encoded = encodeSemanticKeyValue(value);
    if (encoded === value) return;
    element.setAttribute(SEMANTIC_KEY_ATTRIBUTE, encoded);
    changed += 1;
  });
  return changed;
}
