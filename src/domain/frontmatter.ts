/**
 * Frontmatter parsing.
 *
 * A deliberately small, documented subset of YAML — scalars, quoted strings, inline
 * `[a, b]` lists and block `- item` lists — and, more importantly, a parser that knows
 * what it does not understand.
 *
 * That second property is the whole point. A parser that guesses is worse than one
 * that refuses: the previous implementation turned
 *
 *     meta:
 *       owner: ana
 *
 * into `{ meta: [], owner: 'ana' }`, hoisting a nested key to the top level where a
 * nested `id:` or `status:` would quietly become the record's own. It read `desc: |`
 * as the string `"|"`, split `tags: ["a,b", c]` into three broken pieces, and let a
 * trailing `# comment` turn a number into a string that silently fell back to a
 * default. None of that announced itself.
 *
 * So every construct outside the subset now produces a `FrontmatterIssue` and the key
 * is left unset rather than filled with something plausible. A missing field is a
 * problem the reader can report; a wrong field is one nobody notices.
 *
 * The raw text is always preserved verbatim alongside the interpreted values, so an
 * unknown key another plugin owns survives, and so a future writer has something
 * lossless to serialize from. See `docs/DECISIONS.md#d7`.
 */

export type FrontmatterIssueCode =
  /** An indented `key: value` block — a nested mapping the subset cannot represent. */
  | 'nested-mapping'
  /** A `|` or `>` multiline scalar header. */
  | 'block-scalar'
  /** A `{ ... }` flow mapping. */
  | 'flow-mapping'
  /** A `&anchor` definition or `*alias` reference. */
  | 'anchor-or-alias'
  /** A block list whose items are mappings. */
  | 'list-of-mappings'
  /** An inline list that never closed, or held a structure the subset cannot hold. */
  | 'unterminated-list'
  /** A double-quoted scalar used an escape this deliberately small subset cannot decode. */
  | 'unsupported-escape'
  /** The same key given twice at the top level. */
  | 'duplicate-key'
  /** A line that is not blank, not a comment, not a list item and not `key: value`. */
  | 'unparsable-line';

export interface FrontmatterIssue {
  code: FrontmatterIssueCode;
  /** The key the issue concerns, where one is identifiable. */
  key: string | null;
  /** 1-based line number within the frontmatter block. */
  line: number;
  detail: string;
}

export interface FrontmatterResult {
  values: Record<string, unknown>;
  issues: FrontmatterIssue[];
}

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  /** Raw frontmatter lines, byte-exact, so unknown keys survive a future rewrite. */
  frontmatterRaw: string | null;
  body: string;
  issues: FrontmatterIssue[];
  /**
   * True when the interpreted values are not the whole truth of `frontmatterRaw`.
   * A writer must never serialize a lossy document from the interpreted projection.
   */
  lossy: boolean;
}

const BOM = '﻿';
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseDocument(text: string): ParsedDocument {
  // A UTF-8 BOM before the fence is invisible and, untrimmed, hides the entire
  // frontmatter block — the record then loads with every field defaulted and nothing
  // to say why.
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const match = FENCE.exec(source);
  if (!match) {
    return { frontmatter: {}, frontmatterRaw: null, body: source, issues: [], lossy: false };
  }

  const raw = match[1] ?? '';
  const { values, issues } = parseFrontmatter(raw);
  return {
    frontmatter: values,
    frontmatterRaw: raw,
    body: source.slice(match[0].length),
    issues,
    lossy: issues.length > 0,
  };
}

const LIST_ITEM = /^[ \t]*-(?:[ \t]+(.*?))?[ \t]*$/;
const KEY_LINE = /^([ \t]*)([^:]+?)[ \t]*:(.*)$/;
const BLOCK_SCALAR_HEADER = /^[|>][-+]?\d*$/;

export function parseFrontmatter(raw: string): FrontmatterResult {
  const values: Record<string, unknown> = {};
  const issues: FrontmatterIssue[] = [];
  const lines = raw.split(/\r?\n/);

  let pendingKey: string | null = null;
  let pendingList: unknown[] | null = null;
  let pendingPoisoned = false;
  let lastKey: string | null = null;

  const flush = () => {
    if (pendingKey !== null && pendingList !== null) {
      if (pendingPoisoned) delete values[pendingKey];
      else if (pendingList.length > 0) values[pendingKey] = pendingList;
    }
    pendingKey = null;
    pendingList = null;
    pendingPoisoned = false;
  };

  const issue = (code: FrontmatterIssueCode, key: string | null, line: number, detail: string) => {
    issues.push({ code, key, line, detail });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const lineNumber = i + 1;

    if (line.trim() === '') continue;
    if (/^[ \t]*#/.test(line)) continue;

    // Checked before indentation, because a block list's items are normally indented
    // under their key and are not a nested mapping.
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (pendingList === null) {
        issue('unparsable-line', lastKey, lineNumber, 'list item with no key to belong to.');
        continue;
      }
      const content = item[1] ?? '';
      const unsupportedEscape = findUnsupportedDoubleQuotedEscape(content);
      if (unsupportedEscape) {
        if (!pendingPoisoned) {
          issue(
            'unsupported-escape',
            pendingKey,
            lineNumber,
            `${unsupportedEscape}; the key is left unset rather than silently changing the value.`,
          );
        }
        pendingPoisoned = true;
        continue;
      }
      if (looksLikeMapping(content)) {
        if (!pendingPoisoned) {
          issue(
            'list-of-mappings',
            pendingKey,
            lineNumber,
            'a list of mappings is outside the supported subset; the key is left unset.',
          );
        }
        pendingPoisoned = true;
        continue;
      }
      pendingList.push(coerceScalar(content));
      continue;
    }

    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (indent > 0) {
      const parent = pendingKey ?? lastKey;
      issue(
        'nested-mapping',
        parent,
        lineNumber,
        parent
          ? `nested values under "${parent}" are outside the supported subset; the key is left unset.`
          : 'indented content with no key to belong to.',
      );
      if (parent !== null) delete values[parent];
      pendingKey = null;
      pendingList = null;
      pendingPoisoned = false;
      // The whole indented block belongs to the top-level parent, so skip past all of
      // it — siblings at this depth are the same nested mapping, not new ones.
      i = skipIndentedBlock(lines, i, 0);
      continue;
    }

    const keyLine = KEY_LINE.exec(line);
    if (!keyLine) {
      issue('unparsable-line', lastKey, lineNumber, `not a key, a list item or a comment: ${line.trim()}`);
      continue;
    }

    flush();

    const key = (keyLine[2] ?? '').trim();
    if (key === '') {
      issue('unparsable-line', null, lineNumber, 'empty key.');
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(values, key)) {
      // YAML rejects a duplicate key outright; keeping the first and saying so is
      // consistent with how a duplicate record id is handled.
      issue('duplicate-key', key, lineNumber, `"${key}" is already set; this line is ignored.`);
      continue;
    }

    lastKey = key;
    const rest = stripComment(keyLine[3] ?? '').trim();

    if (rest === '') {
      // Either an empty value or the header of a block list. Decided by what follows.
      pendingKey = key;
      pendingList = [];
      pendingPoisoned = false;
      values[key] = '';
      continue;
    }

    const unsupportedEscape = findUnsupportedDoubleQuotedEscape(rest);
    if (unsupportedEscape) {
      issue(
        'unsupported-escape',
        key,
        lineNumber,
        `${unsupportedEscape}; the key is left unset rather than silently changing the value.`,
      );
      continue;
    }

    if (BLOCK_SCALAR_HEADER.test(rest)) {
      issue('block-scalar', key, lineNumber, `"${rest}" multiline scalars are outside the supported subset.`);
      i = skipIndentedBlock(lines, i, indent);
      continue;
    }

    if (rest.startsWith('&') || rest.startsWith('*')) {
      issue('anchor-or-alias', key, lineNumber, 'YAML anchors and aliases are outside the supported subset.');
      continue;
    }

    if (rest.startsWith('{')) {
      issue('flow-mapping', key, lineNumber, 'inline mappings are outside the supported subset.');
      continue;
    }

    if (rest.startsWith('[')) {
      const list = parseInlineList(rest);
      if (list === null) {
        issue('unterminated-list', key, lineNumber, `not a supported inline list: ${rest}`);
        continue;
      }
      values[key] = list;
      continue;
    }

    values[key] = coerceScalar(rest);
  }

  flush();
  return { values, issues };
}

/** Advance past the indented body belonging to the line at `start`. */
function skipIndentedBlock(lines: string[], start: number, indent: number): number {
  let i = start;
  while (i + 1 < lines.length) {
    const next = lines[i + 1] as string;
    if (next.trim() === '') {
      i += 1;
      continue;
    }
    const nextIndent = /^[ \t]*/.exec(next)?.[0].length ?? 0;
    if (nextIndent <= indent) break;
    i += 1;
  }
  return i;
}

/** A list item that is really `key: value`, which the subset cannot represent. */
function looksLikeMapping(item: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < item.length; i += 1) {
    const char = item[i] as string;
    if (quote) {
      if (char === '\\' && quote === '"') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // A colon only separates a mapping when a space or the end of the item follows,
    // so "https://example.com" stays a plain scalar.
    if (char === ':' && (i === item.length - 1 || item[i + 1] === ' ')) return true;
  }
  return false;
}

/**
 * Remove a trailing `# comment`.
 *
 * YAML needs whitespace before the `#`, so `colour: "#00b894"` and `path: a#b` are
 * untouched — which matters, because a colour is exactly the field this would ruin.
 */
function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    if (quote) {
      if (char === '\\' && quote === '"') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && i > 0 && /[ \t]/.test(value[i - 1] as string)) return value.slice(0, i);
  }
  return value;
}

/** Split `[a, "b,c"]` on its real separators. Null when it is not one of those. */
function parseInlineList(text: string): unknown[] | null {
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1);
  if (inner.trim() === '') return [];

  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] as string;
    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < inner.length) {
        current += char + (inner[i + 1] as string);
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    // Nesting is structure the subset cannot hold; say so rather than flatten it.
    if (char === '[' || char === '{') return null;
    if (char === ']' || char === '}') return null;
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (quote) return null;
  parts.push(current);
  return parts.map((part) => coerceScalar(part));
}

/**
 * Interpret one scalar.
 *
 * `true`/`false` are booleans in any case, matching YAML 1.2 core. `yes`, `no`, `on`
 * and `off` deliberately stay strings: js-yaml 4 — which is what Obsidian reads these
 * files with — treats them as strings too, and agreeing with the peer application
 * matters more than agreeing with YAML 1.1.
 */
export function coerceScalar(value: string): unknown {
  const v = stripComment(value).trim();
  if (v === '') return '';

  const lower = v.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || v === '~') return null;

  if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) return unescapeDouble(v.slice(1, -1));
  if (v.length > 1 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).split("''").join("'");

  if (v.startsWith('[')) {
    const list = parseInlineList(v);
    return list ?? v;
  }

  // Only when the whole token is numeric, so "1.2.3" and "2026-09-06" stay strings.
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function unescapeDouble(inner: string): string {
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] as string;
    if (char !== '\\' || i === inner.length - 1) {
      out += char;
      continue;
    }
    const next = inner[i + 1] as string;
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else out += next;
  }
  return out;
}

/**
 * Validate the only double-quoted escapes this subset deliberately interprets.
 *
 * YAML has a much larger escape grammar. Pretending to support it is dangerous: the
 * old fallback removed the backslash from every unknown escape, turning `\u00e9` into
 * `u00e9` and Windows paths such as `C:\Users` into different paths. Full YAML escape
 * support belongs to a real YAML parser; this reader instead fails visibly.
 */
function findUnsupportedDoubleQuotedEscape(text: string): string | null {
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble || char !== '\\') continue;

    if (i === text.length - 1) return 'a trailing backslash is not a supported quoted escape';
    const next = text[i + 1] as string;
    if (next !== '"' && next !== '\\' && next !== 'n' && next !== 't') {
      return `\\${next} is not a supported quoted escape`;
    }
    i += 1;
  }
  return null;
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function asStringOrNull(value: unknown): string | null {
  const s = asString(value, '');
  return s === '' ? null : s;
}
