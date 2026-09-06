/**
 * Gate 1B — the frontmatter subset, and what happens outside it.
 *
 * Two halves, and the second matters more. The supported forms must be read correctly;
 * the unsupported ones must be *reported*, not guessed. Every case below that ends in
 * an issue was, before this gate, a value the reader invented: a hoisted nested key, a
 * list split through a quoted comma, the string "|", a number turned into prose by a
 * trailing comment.
 */
import { describe, expect, it } from 'vitest';
import { parseDocument, parseFrontmatter } from '../src/domain/frontmatter.js';
import type { FrontmatterIssueCode } from '../src/domain/frontmatter.js';

const values = (raw: string) => parseFrontmatter(raw).values;
const issues = (raw: string) => parseFrontmatter(raw).issues;
const codes = (raw: string): FrontmatterIssueCode[] => issues(raw).map((i) => i.code);

describe('the supported subset', () => {
  it('reads plain scalars', () => {
    expect(values('name: Studio')).toEqual({ name: 'Studio' });
    expect(values('name: two words here')).toEqual({ name: 'two words here' });
  });

  it('reads numbers, including negative and fractional', () => {
    expect(values('weight: 3')).toEqual({ weight: 3 });
    expect(values('offset: -2')).toEqual({ offset: -2 });
    expect(values('ratio: 1.5')).toEqual({ ratio: 1.5 });
  });

  it('leaves a version-like or date-like token as a string', () => {
    expect(values('version: 1.2.3')).toEqual({ version: '1.2.3' });
    expect(values('deadline: 2026-09-08T18:00:00.000Z')).toEqual({
      deadline: '2026-09-08T18:00:00.000Z',
    });
    expect(values('day: 2026-09-06')).toEqual({ day: '2026-09-06' });
  });

  it('reads booleans in any case', () => {
    expect(values('done: true')).toEqual({ done: true });
    expect(values('done: True')).toEqual({ done: true });
    expect(values('done: FALSE')).toEqual({ done: false });
  });

  it('reads null and its tilde spelling', () => {
    expect(values('project: null')).toEqual({ project: null });
    expect(values('project: ~')).toEqual({ project: null });
  });

  it('reads quoted strings and strips the quotes', () => {
    expect(values('colour: "#00b894"')).toEqual({ colour: '#00b894' });
    expect(values("name: 'Studio'")).toEqual({ name: 'Studio' });
    expect(values('number: "3"')).toEqual({ number: '3' });
  });

  it('reads inline lists', () => {
    expect(values('tags: [a, b]')).toEqual({ tags: ['a', 'b'] });
    expect(values('tags: []')).toEqual({ tags: [] });
    expect(values('sizes: [1, 2.5]')).toEqual({ sizes: [1, 2.5] });
  });

  it('reads block lists', () => {
    expect(values('tags:\n  - alpha\n  - beta')).toEqual({ tags: ['alpha', 'beta'] });
    expect(values('tags:\n- alpha\n- beta')).toEqual({ tags: ['alpha', 'beta'] });
  });

  it('reads a key with an empty value as an empty string', () => {
    expect(values('description:')).toEqual({ description: '' });
  });

  it('ignores whole-line comments and blank lines', () => {
    expect(values('# a note\n\nname: Studio\n\n# another')).toEqual({ name: 'Studio' });
    expect(issues('# a note\nname: Studio')).toEqual([]);
  });

  it('accepts CRLF line endings', () => {
    expect(values('name: Studio\r\nweight: 2')).toEqual({ name: 'Studio', weight: 2 });
  });

  it('reports no issue for anything in the subset', () => {
    const raw = [
      'name: Studio',
      'weight: 3',
      'done: true',
      'project: null',
      'colour: "#00b894"',
      'tags: [a, b]',
      'list:',
      '  - one',
    ].join('\n');
    expect(issues(raw)).toEqual([]);
  });
});

describe('forms that used to be read wrongly', () => {
  it('keeps a comma inside a quoted inline-list value', () => {
    expect(values('tags: ["a,b", c]')).toEqual({ tags: ['a,b', 'c'] });
    expect(issues('tags: ["a,b", c]')).toEqual([]);
  });

  it('drops a trailing comment instead of folding it into the value', () => {
    expect(values('weight: 3 # the weight')).toEqual({ weight: 3 });
    expect(values('name: Studio  # a note')).toEqual({ name: 'Studio' });
    expect(values('tags: [a, b] # a note')).toEqual({ tags: ['a', 'b'] });
  });

  it('does not mistake a # inside quotes or mid-token for a comment', () => {
    expect(values('colour: "#00b894"')).toEqual({ colour: '#00b894' });
    expect(values('anchor: page#section')).toEqual({ anchor: 'page#section' });
  });

  it('unescapes a quoted string rather than keeping the backslashes', () => {
    expect(values('name: "say \\"hi\\""')).toEqual({ name: 'say "hi"' });
    expect(values('path: "C:\\\\Notes"')).toEqual({ path: 'C:\\Notes' });
    expect(values('label: "line\\nnext\\tcell"')).toEqual({ label: 'line\nnext\tcell' });
    expect(values("name: 'it''s here'")).toEqual({ name: "it's here" });
  });

  it('reads frontmatter behind a UTF-8 BOM', () => {
    const parsed = parseDocument('﻿---\nid: task-1\nname: Kept\n---\nbody');
    expect(parsed.frontmatter).toEqual({ id: 'task-1', name: 'Kept' });
    expect(parsed.frontmatterRaw).toBe('id: task-1\nname: Kept');
    expect(parsed.body).toBe('body');
  });

  it('keeps yes/no/on/off as strings, agreeing with the YAML Obsidian reads', () => {
    expect(values('done: yes')).toEqual({ done: 'yes' });
    expect(values('done: off')).toEqual({ done: 'off' });
  });
});

describe('forms outside the subset are reported, not guessed', () => {
  it('refuses unsupported double-quoted escapes without silently removing backslashes', () => {
    for (const raw of [
      'name: "caf\\u00e9"',
      'name: "caf\\xE9"',
      'name: "bad\\qescape"',
      'path: "C:\\Users\\Ana"',
    ]) {
      expect(values(raw)).toEqual({});
      expect(issues(raw)[0]).toMatchObject({ code: 'unsupported-escape', line: 1 });
    }
  });

  it('poisons a whole list when one quoted item has an unsupported escape', () => {
    expect(values('tags: [safe, "caf\\u00e9"]')).toEqual({});
    expect(codes('tags: [safe, "caf\\u00e9"]')).toEqual(['unsupported-escape']);
    expect(values('tags:\n  - safe\n  - "bad\\q"')).toEqual({});
    expect(codes('tags:\n  - safe\n  - "bad\\q"')).toEqual(['unsupported-escape']);
  });

  it('refuses a nested mapping instead of hoisting its keys', () => {
    const raw = 'meta:\n  owner: ana\n  rank: 2\nname: Studio';
    // The old parser produced { meta: [], owner: 'ana', rank: 2, name: 'Studio' } —
    // a nested `id:` or `status:` would have become the record's own.
    expect(values(raw)).toEqual({ name: 'Studio' });
    expect(codes(raw)).toEqual(['nested-mapping']);
    expect(issues(raw)[0]).toMatchObject({ key: 'meta', line: 2 });
  });

  it('refuses a block mapping under a key that already had a value', () => {
    const raw = 'a: 1\nnested:\n  x: 9';
    expect(values(raw)).toEqual({ a: 1 });
    expect(codes(raw)).toEqual(['nested-mapping']);
  });

  it('refuses a list of mappings instead of stringifying each item', () => {
    const raw = 'items:\n  - name: x\n  - name: y';
    expect(values(raw)).toEqual({});
    expect(codes(raw)).toEqual(['list-of-mappings']);
  });

  it('refuses a | block scalar instead of reading it as "|"', () => {
    const raw = 'desc: |\n  line one\n  line two\nname: Studio';
    expect(values(raw)).toEqual({ name: 'Studio' });
    expect(codes(raw)).toEqual(['block-scalar']);
  });

  it('refuses a > block scalar, and its modifier spellings', () => {
    expect(codes('desc: >\n  folded')).toEqual(['block-scalar']);
    expect(codes('desc: |-\n  clipped')).toEqual(['block-scalar']);
    expect(codes('desc: >2\n   indented')).toEqual(['block-scalar']);
  });

  it('refuses a flow mapping', () => {
    const raw = 'meta: {x: 1}';
    expect(values(raw)).toEqual({});
    expect(codes(raw)).toEqual(['flow-mapping']);
  });

  it('refuses anchors and aliases', () => {
    expect(codes('base: &b value')).toEqual(['anchor-or-alias']);
    expect(codes('other: *b')).toEqual(['anchor-or-alias']);
    expect(values('base: &b value')).toEqual({});
  });

  it('refuses a nested or unterminated inline list', () => {
    expect(codes('tags: [a, [b, c]]')).toEqual(['unterminated-list']);
    expect(codes('tags: [a, {b: c}]')).toEqual(['unterminated-list']);
    expect(codes('tags: ["a, b]')).toEqual(['unterminated-list']);
  });

  it('keeps the first of a duplicated key and says so', () => {
    const raw = 'status: running\nstatus: review';
    expect(values(raw)).toEqual({ status: 'running' });
    expect(codes(raw)).toEqual(['duplicate-key']);
  });

  it('reports a line that is not a key, a list item or a comment', () => {
    const raw = 'name: Studio\njust some prose';
    expect(values(raw)).toEqual({ name: 'Studio' });
    expect(codes(raw)).toEqual(['unparsable-line']);
  });

  it('reports each unsupported construct once, with its line number', () => {
    const raw = ['a: 1', 'meta:', '  x: 1', '  y: 2', 'b: 2'].join('\n');
    expect(values(raw)).toEqual({ a: 1, b: 2 });
    expect(issues(raw)).toHaveLength(1);
    expect(issues(raw)[0]).toMatchObject({ code: 'nested-mapping', key: 'meta', line: 3 });
  });

  it('keeps reading valid keys after an unsupported one', () => {
    const raw = ['first: 1', 'bad: |', '  text', 'second: 2', 'alsoBad: {x: 1}', 'third: 3'].join('\n');
    expect(values(raw)).toEqual({ first: 1, second: 2, third: 3 });
    expect(codes(raw)).toEqual(['block-scalar', 'flow-mapping']);
  });
});

describe('the raw frontmatter is preserved independently of interpretation', () => {
  it('keeps the original text byte for byte', () => {
    const raw = 'name: Studio\nmeta:\n  owner: ana\nweight: 3';
    const parsed = parseDocument(`---\n${raw}\n---\nbody`);
    expect(parsed.frontmatterRaw).toBe(raw);
  });

  it('marks a document lossy exactly when something could not be interpreted', () => {
    expect(parseDocument('---\nname: Studio\n---\n').lossy).toBe(false);
    expect(parseDocument('---\nmeta:\n  x: 1\n---\n').lossy).toBe(true);
  });

  it('preserves a key it does not interpret, in the raw text', () => {
    const parsed = parseDocument('---\ncssclass: wide\nname: Studio\n---\n');
    expect(parsed.frontmatter.cssclass).toBe('wide');
    expect(parsed.frontmatterRaw).toContain('cssclass: wide');
  });

  it('separates body from frontmatter, and tolerates a file with neither', () => {
    expect(parseDocument('---\nname: X\n---\nbody text').body).toBe('body text');
    expect(parseDocument('just a note').frontmatter).toEqual({});
    expect(parseDocument('just a note').frontmatterRaw).toBe(null);
    expect(parseDocument('just a note').lossy).toBe(false);
  });

  it('does not treat a horizontal rule in the body as a fence', () => {
    const parsed = parseDocument('# Title\n\n---\n\nbelow');
    expect(parsed.frontmatterRaw).toBe(null);
    expect(parsed.body).toBe('# Title\n\n---\n\nbelow');
  });
});
