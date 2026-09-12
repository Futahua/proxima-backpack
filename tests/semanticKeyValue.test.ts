// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeSemanticKeyValue, normalizeSemanticKeyValues, SEMANTIC_KEY_ATTRIBUTE, SEMANTIC_KEY_MAX_LENGTH } from '../src/browser/semanticKeyValue.js';

/**
 * Papers refuses a semantic-key payload whole - and silently - when one key breaks
 * `^[A-Za-z0-9][A-Za-z0-9._~-]*$`, is longer than 128 characters, or repeats. These
 * cases pin the encoder against exactly that contract, including the adversarial
 * pairs where a naive replacement (a space for a dash, or a dropped `~`) would make
 * two different record identities share one key.
 */
const HOST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

const identities = [
  'Untitled loose task',
  'task-card-alpha',
  'proj-backpack',
  'event-2026-09-12T00:00:00.000Z',
  'a b',
  'a-b',
  'a.b',
  'a_b',
  'a~b',
  'a~20b',
  'a~-b',
  '-leading-dash',
  '.leading-dot',
  '_leading-underscore',
  ' leading-space',
  'München 日',
  'emoji 🎈 task',
  'quote " and amp &',
  'slash/path/C:\\vault\\note.md',
  'tab\tnewline\n',
  '~7E',
  '',
];

describe('semantic key encoding', () => {
  it('produces only values the host accepts', () => {
    for (const identity of identities) {
      const key = encodeSemanticKeyValue(identity);
      expect(key.length).toBeGreaterThanOrEqual(1);
      expect(key.length).toBeLessThanOrEqual(SEMANTIC_KEY_MAX_LENGTH);
      expect(key).toMatch(HOST_KEY_PATTERN);
    }
  });

  it('leaves a value that already conforms exactly as it is', () => {
    for (const identity of ['app-root', 'task-card-alpha', 'a.b_c-d-e', 'x9']) {
      expect(encodeSemanticKeyValue(identity)).toBe(identity);
    }
    // `~` is allowed by the host and still escaped here, because a literal `~20` must
    // stay distinguishable from an encoded space.
    expect(encodeSemanticKeyValue('a~b')).toBe('a~7Eb');
  });

  it('keeps two different identities apart', () => {
    const encoded = identities.map((identity) => encodeSemanticKeyValue(identity));
    expect(new Set(encoded).size).toBe(new Set(identities).size);
    // The adversarial pair that a "replace the space with a dash" fix would merge.
    expect(encodeSemanticKeyValue('a b')).not.toBe(encodeSemanticKeyValue('a-b'));
    // A literal escape sequence must not collide with the character it escapes.
    expect(encodeSemanticKeyValue('a~b')).not.toBe(encodeSemanticKeyValue('a~20b'));
  });

  it('is deterministic across calls', () => {
    for (const identity of identities) {
      expect(encodeSemanticKeyValue(identity)).toBe(encodeSemanticKeyValue(identity));
    }
  });

  it('bounds a long identity without merging it with its near neighbour', () => {
    const long = `task-${'x'.repeat(400)}`;
    const neighbour = `task-${'x'.repeat(399)}y`;
    const bounded = encodeSemanticKeyValue(long);
    expect(bounded.length).toBeLessThanOrEqual(SEMANTIC_KEY_MAX_LENGTH);
    expect(bounded).toMatch(HOST_KEY_PATTERN);
    expect(bounded).not.toBe(encodeSemanticKeyValue(neighbour));
  });

  it('rewrites the keys in a rendered document and counts them', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      `<span ${SEMANTIC_KEY_ATTRIBUTE}="app-root"></span>`,
      `<span ${SEMANTIC_KEY_ATTRIBUTE}="elastic-task-Untitled loose task"></span>`,
      `<span ${SEMANTIC_KEY_ATTRIBUTE}="board-column-backlog"></span>`,
    ].join('');
    expect(normalizeSemanticKeyValues(root)).toBe(1);
    const values: Array<string | null> = [];
    root.querySelectorAll(`[${SEMANTIC_KEY_ATTRIBUTE}]`).forEach((element) => values.push(element.getAttribute(SEMANTIC_KEY_ATTRIBUTE)));
    expect(values).toEqual(['app-root', 'elastic-task-Untitled~20loose~20task', 'board-column-backlog']);
    // Encoding is deliberately not idempotent - it escapes its own escapes - so the pass
    // belongs on freshly rendered markup only. Running it twice shows the cost rather
    // than hiding it, which is why the call site is pinned below.
    expect(normalizeSemanticKeyValues(root)).toBe(1);
    const rescaped: Array<string | null> = [];
    root.querySelectorAll(`[${SEMANTIC_KEY_ATTRIBUTE}]`).forEach((element) => rescaped.push(element.getAttribute(SEMANTIC_KEY_ATTRIBUTE)));
    expect(rescaped[1]).toBe('elastic-task-Untitled~7E20loose~7E20task');
  });

  it('normalizes every surface the app writes, from one boundary', () => {
    // The app writes its whole document once, in main.ts, and the pass sits immediately
    // after that assignment. A second call site would re-escape keys the host already
    // accepts, so there is exactly one.
    const source = readFileSync(resolve(import.meta.dirname, '../src/browser/main.ts'), 'utf8');
    const assignment = source.indexOf('root.innerHTML =');
    const pass = source.indexOf('normalizeSemanticKeyValues(root)');
    expect(assignment).toBeGreaterThan(-1);
    expect(pass).toBeGreaterThan(assignment);
    expect(source.slice(assignment, pass)).not.toContain('\n}\n');
    expect(source.split('normalizeSemanticKeyValues(').length - 1).toBe(1);
    const modules = readFileSync(resolve(import.meta.dirname, '../src/browser/semanticKeyValue.ts'), 'utf8');
    expect(modules.split('export function normalizeSemanticKeyValues').length - 1).toBe(1);
  });
});
