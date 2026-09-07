import type { TaskStatusId } from '../domain/types.js';
import { coerceScalar, findUnsupportedDoubleQuotedEscape } from '../domain/frontmatter.js';

export type SourcePatchFailureReason =
  | 'no-frontmatter'
  | 'target-missing'
  | 'target-ambiguous'
  | 'target-unsupported'
  | 'invalid-value'
  | 'invalid-utf8'
  | 'source-too-large'
  | 'field-not-allowed';

/** Closed set of task fields that the semantic writer may ever target. */
export type TaskScalarField =
  | 'name' | 'project' | 'status' | 'weight' | 'orderIndex'
  | 'isFixedDuration' | 'fixedDuration' | 'maxDuration' | 'isCompleted'
  | 'startDate' | 'deadline';
export type TaskOptionalField = 'project' | 'fixedDuration' | 'maxDuration' | 'startDate' | 'deadline';
export type ProjectScalarField = 'name' | 'status' | 'projectType' | 'tabBgColor' | 'tabTextColor';
export type ProjectOptionalField = 'tabBgColor' | 'tabTextColor';

type SourceScalarField = TaskScalarField | ProjectScalarField | 'projectId' | 'description';
const TASK_SCALAR_FIELDS: readonly TaskScalarField[] = ['name', 'project', 'status', 'weight', 'orderIndex', 'isFixedDuration', 'fixedDuration', 'maxDuration', 'isCompleted', 'startDate', 'deadline'];
const PROJECT_SCALAR_FIELDS: readonly ProjectScalarField[] = ['name', 'status', 'projectType', 'tabBgColor', 'tabTextColor'];

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
  if (style === 'plain') return (safePlain(value) && (!plainSafe || SAFE_PLAIN.test(value))) ? value : null;
  if (style === 'single') return `'${value.replaceAll("'", "''")}'`;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function safePlain(value: string): boolean {
  if (!value || /^[\-?:,\[\]{}#&*!|>'"%@`]/.test(value) || /[ \t]#/.test(value) || /:[ \t]/.test(value)) return false;
  return !/[\u0000-\u001F\u007F\r\n]/u.test(value) && typeof coerceScalar(value) === 'string' && coerceScalar(value) === value;
}

function fieldMode(field: SourceScalarField): 'string' | 'number' | 'boolean' {
  if (field === 'weight' || field === 'orderIndex' || field === 'fixedDuration' || field === 'maxDuration') return 'number';
  if (field === 'isFixedDuration' || field === 'isCompleted') return 'boolean';
  return 'string';
}

function encodedValue(field: SourceScalarField, value: string | number | boolean, style: 'plain' | 'single' | 'double'): string | null {
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
  if (!TASK_SCALAR_FIELDS.includes(field)) return { ok: false, reason: 'field-not-allowed' };
  return planSourceScalarPatch(input, field, value, maxBytes);
}

/** Patch the one semantic project field, selecting preferred or legacy source spelling. */
export function planTaskProjectPatch(input: Uint8Array | string, value: string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  const preferred = planTaskScalarPatch(input, 'project', value, maxBytes);
  const legacy = planSourceScalarPatch(input, 'projectId', value, maxBytes);
  if (preferred.ok && legacy.ok) return { ok: false, reason: 'target-ambiguous' };
  return preferred.ok || preferred.reason !== 'target-missing' ? preferred : legacy;
}

/** Plan a byte-exact patch of one allowlisted existing project scalar. */
export function planProjectScalarPatch(input: Uint8Array | string, field: ProjectScalarField, value: string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  if (!PROJECT_SCALAR_FIELDS.includes(field)) return { ok: false, reason: 'field-not-allowed' };
  return planSourceScalarPatch(input, field, value, maxBytes);
}

/** Patch an existing project description scalar without changing Markdown body bytes. */
export function planProjectDescriptionPatch(input: Uint8Array | string, value: string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  return planSourceScalarPatch(input, 'description', value, maxBytes);
}

/** Remove one existing project description scalar so the reader falls back to body text. */
export function planProjectDescriptionRemove(input: Uint8Array | string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  const window = sourceAndFence(input, maxBytes); if (!('source' in window)) return window;
  const matches = targetLines(window.source, window.closingStart, 'description');
  if (matches.some((match) => match.start < 0)) return { ok: false, reason: 'target-unsupported' };
  if (matches.length === 0) return { ok: false, reason: 'target-missing' };
  if (matches.length !== 1) return { ok: false, reason: 'target-ambiguous' };
  const lines = linesOf(window.source); const target = matches[0] as { start: number; end: number };
  const line = lines.find((candidate) => candidate.start <= target.start && candidate.end >= target.end); if (!line) return { ok: false, reason: 'target-unsupported' };
  const patched = window.source.slice(0, line.start) + window.source.slice(line.end); const encoder = new TextEncoder();
  return { ok: true, bytes: encoder.encode(patched), start: encoder.encode(window.source.slice(0, line.start)).byteLength, end: encoder.encode(window.source.slice(0, line.end)).byteLength };
}

/** Insert a missing explicit project description immediately before the closing fence. */
export function planProjectDescriptionInsert(input: Uint8Array | string, value: string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001F\u007F\r\n]/u.test(value)) return { ok: false, reason: 'invalid-value' };
  const window = sourceAndFence(input, maxBytes); if (!('source' in window)) return window;
  const matches = targetLines(window.source, window.closingStart, 'description'); if (matches.some((match) => match.start < 0)) return { ok: false, reason: 'target-unsupported' }; if (matches.length > 0) return { ok: false, reason: 'target-ambiguous' };
  const encoded = safePlain(value) ? value : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const insertion = `description: ${encoded}${window.lineEnding}`; const patched = window.source.slice(0, window.closingStart) + insertion + window.source.slice(window.closingStart); const encoder = new TextEncoder(); const start = encoder.encode(window.source.slice(0, window.closingStart)).byteLength;
  return { ok: true, bytes: encoder.encode(patched), start, end: start };
}

function planSourceScalarPatch(input: Uint8Array | string, field: SourceScalarField, value: string | number | boolean, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
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

function sourceAndFence(input: Uint8Array | string, maxBytes: number): { ok: true; source: string; bytes: Uint8Array; closingStart: number; lineEnding: string } | SourcePatchResult {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > maxBytes) return { ok: false, reason: 'source-too-large' };
  let source: string;
  try { source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, reason: 'invalid-utf8' }; }
  const lines = linesOf(source); const first = lines[0];
  const opening = first && first.content.startsWith(BOM) ? first.content.slice(BOM.length) : first?.content;
  if (opening === undefined || !/^---[ \t]*$/.test(opening)) return { ok: false, reason: 'no-frontmatter' };
  let closingStart = -1; let lineEnding = '';
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---[ \t]*$/.test(lines[i]?.content ?? '')) { closingStart = lines[i]?.start ?? -1; break; }
    const previous = lines[i - 1] as SourceLine;
    const ending = source.slice(previous.start + previous.content.length, previous.end);
    if (!lineEnding && /\r\n|\n|\r/.test(ending)) lineEnding = ending.match(/\r\n|\n|\r/)?.[0] ?? '';
  }
  if (closingStart < 0) return { ok: false, reason: 'no-frontmatter' };
  if (!lineEnding) lineEnding = source.includes('\r\n') ? '\r\n' : source.includes('\n') ? '\n' : source.includes('\r') ? '\r' : '\n';
  return { ok: true, source, bytes, closingStart, lineEnding };
}

function targetLines(source: string, closingStart: number, field: string): Array<{ start: number; end: number; style: 'plain' | 'single' | 'double' }> {
  const lines = linesOf(source); const matches: Array<{ start: number; end: number; style: 'plain' | 'single' | 'double' }> = [];
  for (const line of lines) {
    if (line.start >= closingStart || /^[ \t]/.test(line.content) || line.content.trim() === '' || /^[ \t]*#/.test(line.content)) continue;
    const colon = line.content.indexOf(':'); if (colon < 0 || line.content.slice(0, colon).trim() !== field) continue;
    const rest = line.content.slice(colon + 1); const comment = scalarEnd(rest); const withoutComment = rest.slice(0, comment);
    const leading = withoutComment.match(/^[ \t]*/)?.[0].length ?? 0; const trailing = withoutComment.match(/[ \t]*$/)?.[0].length ?? 0;
    const valueText = withoutComment.slice(leading, Math.max(leading, withoutComment.length - trailing)); if (!valueText) return [{ start: -1, end: -1, style: 'plain' }];
    let style: 'plain' | 'single' | 'double' = 'plain'; if (valueText.startsWith('"')) style = 'double'; else if (valueText.startsWith("'")) style = 'single';
    if ((style !== 'plain' && !validQuoted(valueText, style === 'double' ? '"' : "'")) || (style === 'double' && findUnsupportedDoubleQuotedEscape(valueText) !== null) || (style === 'plain' && /^[\[\]{|>&*]/.test(valueText))) return [{ start: -1, end: -1, style: 'plain' }];
    matches.push({ start: line.start + colon + 1 + leading, end: line.start + colon + 1 + withoutComment.length - trailing, style });
  }
  return matches;
}

function insertEncoding(field: TaskOptionalField, value: string | number): string | null {
  if (field === 'project' || field === 'startDate' || field === 'deadline') {
    if (typeof value !== 'string' || /[\u0000-\u001F\u007F\r\n]/u.test(value) || value.length === 0) return null;
    if (safePlain(value)) return value;
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : null;
}

function insertProjectEncoding(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001F\u007F\r\n]/u.test(value)) return null;
  return safePlain(value) ? value : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Insert one explicitly allowlisted optional project field immediately before the closing fence. */
export function planProjectOptionalInsert(input: Uint8Array | string, field: ProjectOptionalField, value: string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  if (!['tabBgColor', 'tabTextColor'].includes(field)) return { ok: false, reason: 'field-not-allowed' };
  const window = sourceAndFence(input, maxBytes); if (!('source' in window)) return window;
  const matches = targetLines(window.source, window.closingStart, field);
  if (matches.some((match) => match.start < 0)) return { ok: false, reason: 'target-unsupported' };
  if (matches.length > 0) return { ok: false, reason: 'target-ambiguous' };
  const encoded = insertProjectEncoding(value); if (encoded === null) return { ok: false, reason: 'invalid-value' };
  const insertion = `${field}: ${encoded}${window.lineEnding}`; const patched = window.source.slice(0, window.closingStart) + insertion + window.source.slice(window.closingStart);
  const encoder = new TextEncoder(); const start = encoder.encode(window.source.slice(0, window.closingStart)).byteLength;
  return { ok: true, bytes: encoder.encode(patched), start, end: start };
}

/** Remove one explicitly allowlisted optional project field line, including its inline comment. */
export function planProjectOptionalRemove(input: Uint8Array | string, field: ProjectOptionalField, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  if (!['tabBgColor', 'tabTextColor'].includes(field)) return { ok: false, reason: 'field-not-allowed' };
  const window = sourceAndFence(input, maxBytes); if (!('source' in window)) return window;
  const matches = targetLines(window.source, window.closingStart, field);
  if (matches.some((match) => match.start < 0)) return { ok: false, reason: 'target-unsupported' };
  if (matches.length === 0) return { ok: false, reason: 'target-missing' };
  if (matches.length !== 1) return { ok: false, reason: 'target-ambiguous' };
  const lines = linesOf(window.source); const target = matches[0] as { start: number; end: number };
  const line = lines.find((candidate) => candidate.start <= target.start && candidate.end >= target.end); if (!line) return { ok: false, reason: 'target-unsupported' };
  const patched = window.source.slice(0, line.start) + window.source.slice(line.end); const encoder = new TextEncoder();
  return { ok: true, bytes: encoder.encode(patched), start: encoder.encode(window.source.slice(0, line.start)).byteLength, end: encoder.encode(window.source.slice(0, line.end)).byteLength };
}

/** Insert one explicitly allowlisted optional task field immediately before the closing fence. */
export function planTaskOptionalInsert(input: Uint8Array | string, field: TaskOptionalField, value: string | number, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  if (!['project', 'fixedDuration', 'maxDuration', 'startDate', 'deadline'].includes(field)) return { ok: false, reason: 'field-not-allowed' };
  const window = sourceAndFence(input, maxBytes); if (!('source' in window)) return window;
  const fields: SourceScalarField[] = field === 'project' ? ['project', 'projectId'] : [field];
  const matches = fields.flatMap((candidate) => targetLines(window.source, window.closingStart, candidate));
  if (matches.some((match) => match.start < 0)) return { ok: false, reason: 'target-unsupported' };
  if (matches.length > 0) return { ok: false, reason: matches.length === 1 ? 'target-ambiguous' : 'target-ambiguous' };
  const encoded = insertEncoding(field, value); if (encoded === null) return { ok: false, reason: 'invalid-value' };
  const insertion = `${field}: ${encoded}${window.lineEnding}`;
  const patched = window.source.slice(0, window.closingStart) + insertion + window.source.slice(window.closingStart);
  const encoder = new TextEncoder(); const start = encoder.encode(window.source.slice(0, window.closingStart)).byteLength;
  return { ok: true, bytes: encoder.encode(patched), start, end: start };
}

/** Remove one explicitly allowlisted optional task field line, including its inline comment. */
export function planTaskOptionalRemove(input: Uint8Array | string, field: TaskOptionalField, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  if (!['project', 'fixedDuration', 'maxDuration', 'startDate', 'deadline'].includes(field)) return { ok: false, reason: 'field-not-allowed' };
  const window = sourceAndFence(input, maxBytes); if (!('source' in window)) return window;
  const fields: SourceScalarField[] = field === 'project' ? ['project', 'projectId'] : [field];
  const matches = fields.flatMap((candidate) => targetLines(window.source, window.closingStart, candidate));
  if (matches.some((match) => match.start < 0)) return { ok: false, reason: 'target-unsupported' };
  if (matches.length === 0) return { ok: false, reason: 'target-missing' };
  if (matches.length !== 1) return { ok: false, reason: 'target-ambiguous' };
  const lines = linesOf(window.source); const target = matches[0] as { start: number; end: number };
  const line = lines.find((candidate) => candidate.start <= target.start && candidate.end >= target.end); if (!line) return { ok: false, reason: 'target-unsupported' };
  const patched = window.source.slice(0, line.start) + window.source.slice(line.end); const encoder = new TextEncoder();
  return { ok: true, bytes: encoder.encode(patched), start: encoder.encode(window.source.slice(0, line.start)).byteLength, end: encoder.encode(window.source.slice(0, line.end)).byteLength };
}

/** Insert the observed filename-derived identity as an explicit id, and nothing else. */
export function planTaskIdentityPromotion(input: Uint8Array | string, id: string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200 || /[\u0000-\u001F\u007F\r\n]/u.test(id)) return { ok: false, reason: 'invalid-value' };
  const window = sourceAndFence(input, maxBytes); if (!('source' in window)) return window;
  const matches = targetLines(window.source, window.closingStart, 'id');
  if (matches.some((match) => match.start < 0)) return { ok: false, reason: 'target-unsupported' };
  if (matches.length > 0) return { ok: false, reason: 'target-ambiguous' };
  const encoded = safePlain(id) ? id : `"${id.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const insertion = `id: ${encoded}${window.lineEnding}`; const patched = window.source.slice(0, window.closingStart) + insertion + window.source.slice(window.closingStart);
  const encoder = new TextEncoder(); const start = encoder.encode(window.source.slice(0, window.closingStart)).byteLength;
  return { ok: true, bytes: encoder.encode(patched), start, end: start };
}

/** Project identity uses the same exact id insertion primitive, under a separate semantic API. */
export function planProjectIdentityPromotion(input: Uint8Array | string, id: string, maxBytes = DEFAULT_MAX_BYTES): SourcePatchResult {
  return planTaskIdentityPromotion(input, id, maxBytes);
}
