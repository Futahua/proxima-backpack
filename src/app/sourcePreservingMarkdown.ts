import type { TaskStatusId } from '../domain/types.js';
import { findUnsupportedDoubleQuotedEscape } from '../domain/frontmatter.js';

export type SourcePatchFailureReason =
  | 'no-frontmatter'
  | 'target-missing'
  | 'target-ambiguous'
  | 'target-unsupported'
  | 'invalid-value'
  | 'invalid-utf8'
  | 'source-too-large';

/** Closed set of task fields that the semantic writer may ever target. */
export type TaskScalarField =
  | 'name' | 'project' | 'projectId' | 'status' | 'weight' | 'orderIndex'
  | 'isFixedDuration' | 'fixedDuration' | 'maxDuration' | 'isCompleted'
  | 'startDate' | 'deadline';

export type SourcePatchResult =
  | { ok: true; bytes: Uint8Array; start: number; end: number }
  | { ok: false; reason: SourcePatchFailureReason };

const BOM = '\uFEFF';
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const SAFE_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

interface SourceLine { content: string; start: number; end: number; }

function linesOf(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1;
    const content = source.slice(start, end);
    if (end < source.length) {
      if (source[end] === '\r' && source[end + 1] === '\n') end += 2;
      else end += 1;
    }
    lines.push({ content, start, end });
    start = end;
  }
  if (source.length === 0 || (source.endsWith('\n') || source.endsWith('\r'))) lines.push({ content: '', start: source.length, end: source.length });
  return lines;
}

function commentStart(value: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i] as string;
    if (quote === '"') {
      if (c === '\\') i += 1;
      else if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'" && value[i + 1] === "'") i += 1;
      else if (c === "'") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && i > 0 && /[ \t]/.test(value[i - 1] as string)) return i;
  }
  return value.length;
}

function scalarEnd(value: string): number {
  return commentStart(value);
}

function validQuoted(value: string, quote: '"' | "'"): boolean {
  if (value.length < 2 || value[0] !== quote) return false;
  for (let i = 1; i < value.length; i += 1) {
    const c = value[i] as string;
    if (quote === '"' && c === '\\') { if (i + 1 >= value.length) return false; i += 1; continue; }
    if (quote === "'" && c === "'" && value[i + 1] === "'") { i += 1; continue; }
    if (c === quote) return i === value.length - 1;
  }
  return false;
}

function encodeForStyle(value: string, style: 'plain' | 'single' | 'double', plainSafe = false): string | null {
  if (/[\u0000-\u001F\u007F\r\n]/u.test(value)) return null;
  if (style === 'plain') return (plainSafe ? SAFE_PLAIN.test(value) : safePlain(value)) ? value : null;
  if (style === 'single') return `'${value.replaceAll("'", "''")}'`;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function safePlain(value: string): boolean {
  if (!value || /^[\-?:,\[\]{}#&*!|>'"%@`]/.test(value) || /[ \t]#/.test(value) || /:[ \t]/.test(value)) return false;
  return !/[\u0000-\u001F\u007F\r\n]/u.test(value);
}

function fieldMode(field: TaskScalarField): 'string' | 'number' | 'boolean' {
  if (field === 'weight' || field === 'orderIndex' || field === 'fixedDuration' || field === 'maxDuration') return 'number';
  if (field === 'isFixedDuration' || field === 'isCompleted') return 'boolean';
  return 'string';
}

function encodedValue(field: TaskScalarField, value: string | number | boolean, style: 'plain' | 'single' | 'double'): string | null {
  const mode = fieldMode(field);
  if (mode === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (mode === 'boolean') return typeof value === 'boolean' ? String(value) : null;
  if (typeof value !== 'string') return null;
  return encodeForStyle(field === 'status' ? value.trim() : value, style, field === 'status');
}

/** Plan a byte-exact patch of one unambiguous top-level `status:` scalar. */
export function planTaskStatusPatch(input: Uint8Array | string, status: TaskStatusId, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  return planTaskScalarPatch(input, 'status', status, maxBytes);
}

/** Plan a byte-exact patch of one allowlisted existing top-level task scalar. */
export function planTaskScalarPatch(input: Uint8Array | string, field: TaskScalarField, value: string | number | boolean, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  let source: string;
  try { source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, reason: 'invalid-utf8' }; }
  if (fieldMode(field) === 'string' && (typeof value !== 'string' || /[\u0000-\u001F\u007F\r\n]/u.test(value))) return { ok: false, reason: 'invalid-value' };
  if (field === 'status' && typeof value === 'string' && value.trim() === '') return { ok: false, reason: 'invalid-value' };
  if (fieldMode(field) === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return { ok: false, reason: 'invalid-value' };
  if (fieldMode(field) === 'boolean' && typeof value !== 'boolean') return { ok: false, reason: 'invalid-value' };

  const lines = linesOf(source);
  const first = lines[0];
  const opening = first && first.content.startsWith(BOM) ? first.content.slice(BOM.length) : first?.content;
  if (opening === undefined || !/^---[ \t]*$/.test(opening)) return { ok: false, reason: 'no-frontmatter' };
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) if (/^---[ \t]*$/.test(lines[i]?.content ?? '')) { closingIndex = i; break; }
  if (closingIndex === -1) return { ok: false, reason: 'no-frontmatter' };

  const matches: Array<{ start: number; end: number; style: 'plain' | 'single' | 'double'; value: string }> = [];
  for (let i = 1; i < closingIndex; i += 1) {
    const line = lines[i] as SourceLine;
    if (/^[ \t]/.test(line.content) || line.content.trim() === '' || /^[ \t]*#/.test(line.content)) continue;
    const colon = line.content.indexOf(':');
    if (colon < 0 || line.content.slice(0, colon).trim() !== field) continue;
    const rest = line.content.slice(colon + 1);
    const comment = scalarEnd(rest);
    const withoutComment = rest.slice(0, comment);
    const leading = withoutComment.match(/^[ \t]*/)?.[0].length ?? 0;
    const trailing = withoutComment.match(/[ \t]*$/)?.[0].length ?? 0;
    const valueText = withoutComment.slice(leading, Math.max(leading, withoutComment.length - trailing));
    if (!valueText) return { ok: false, reason: 'target-unsupported' };
    let style: 'plain' | 'single' | 'double' = 'plain';
    if (valueText.startsWith('"')) style = 'double';
    else if (valueText.startsWith("'")) style = 'single';
    if ((style !== 'plain' && !validQuoted(valueText, style === 'double' ? '"' : "'")) || (style === 'double' && findUnsupportedDoubleQuotedEscape(valueText) !== null) || (style === 'plain' && /^[\[\]{|>&*]/.test(valueText))) return { ok: false, reason: 'target-unsupported' };
    if (style === 'plain' && /[\t ]#/.test(valueText)) return { ok: false, reason: 'target-unsupported' };
    matches.push({ start: line.start + colon + 1 + leading, end: line.start + colon + 1 + withoutComment.length - trailing, style, value: valueText });
  }
  if (matches.length === 0) return { ok: false, reason: 'target-missing' };
  if (matches.length !== 1) return { ok: false, reason: 'target-ambiguous' };
  const match = matches[0] as (typeof matches)[number];
  const replacement = encodedValue(field, value, match.style);
  if (replacement === null) return { ok: false, reason: 'invalid-value' };
  const patched = source.slice(0, match.start) + replacement + source.slice(match.end);
  const encoder = new TextEncoder();
  return { ok: true, bytes: encoder.encode(patched), start: encoder.encode(source.slice(0, match.start)).byteLength, end: encoder.encode(source.slice(0, match.end)).byteLength };
}
