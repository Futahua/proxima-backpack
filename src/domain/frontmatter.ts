/**
 * Frontmatter parsing.
 *
 * Deliberately a small, documented subset rather than a full YAML implementation:
 * scalars, quoted strings, inline [a, b] lists and block "- item" lists. Anything
 * it does not understand is preserved verbatim so a round-trip cannot silently
 * destroy a key Obsidian or another plugin owns.
 *
 * The original plugin's parser was similarly limited, which is exactly why
 * migration tests must use real vault files rather than assume valid YAML works.
 */

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  /** Raw frontmatter lines, kept so unknown keys survive a rewrite. */
  frontmatterRaw: string | null;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDocument(text: string): ParsedDocument {
  const match = FENCE.exec(text);
  if (!match) return { frontmatter: {}, frontmatterRaw: null, body: text };
  const raw = match[1] ?? '';
  return {
    frontmatter: parseFrontmatter(raw),
    frontmatterRaw: raw,
    body: text.slice(match[0].length),
  };
}

export function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let pendingKey: string | null = null;
  let pendingList: unknown[] | null = null;

  const flush = () => {
    if (pendingKey !== null && pendingList !== null) out[pendingKey] = pendingList;
    pendingKey = null;
    pendingList = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && pendingList !== null) {
      pendingList.push(coerce(item[1] ?? ''));
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    flush();

    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;

    if (value === '') {
      pendingKey = key;
      pendingList = [];
      out[key] = '';
      continue;
    }
    out[key] = coerce(value);
  }
  flush();
  return out;
}

function coerce(value: string): unknown {
  const v = value.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;

  if (
    (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
    (v.startsWith("'") && v.endsWith("'") && v.length > 1)
  ) {
    return v.slice(1, -1);
  }

  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => coerce(part));
  }

  // Only treat as a number when the whole token is numeric, so "1.2.3" and
  // "2026-09-06" stay strings.
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
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
