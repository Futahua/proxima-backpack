/**
 * Field validation, with ranges rather than hope.
 *
 * Malformed frontmatter reaching the Elastic algorithm is how a board ends up drawing
 * a card of NaN pixels or a negative height. The defence is not a guard inside the
 * algorithm — by then the bad value is already indistinguishable from a real one — but
 * a boundary here, where the value is still attached to the file and line that produced
 * it and can be reported.
 *
 * Every reader takes the raw frontmatter value and an issue list. It returns a value
 * that is always safe to compute with, and appends an issue whenever the raw value was
 * not the one it returned. Substituting a default is fine; substituting one silently
 * is not.
 */

import { parseCivilDate } from './time.js';

export type FieldIssueCode =
  /** Present, but not a number in any readable form. */
  | 'not-a-number'
  /** A number, but outside the range the field allows. */
  | 'out-of-range'
  /** Present, but not a boolean. */
  | 'not-a-boolean'
  /** Present, but not a date any clock could read. */
  | 'invalid-date'
  /** Present, but not a usable status identifier. */
  | 'invalid-status'
  /** Present, but not one of a field's closed set of values. */
  | 'invalid-enum';

export interface FieldIssue {
  field: string;
  code: FieldIssueCode;
  detail: string;
}

/**
 * A task's pull on the elastic timeline. Must be a positive, finite number.
 *
 * Zero or negative is rejected rather than clamped to zero: a weight of zero would
 * give the task no time at all while still occupying the board, which reads as a bug
 * to the creator, and a negative weight would drag every other card's share upward.
 * The default of 1 is what an absent weight already means.
 */
export function readWeight(raw: unknown, issues: FieldIssue[]): number {
  if (raw === undefined) return 1;
  const n = toNumber(raw);
  if (n === null) {
    issues.push({
      field: 'weight',
      code: 'not-a-number',
      detail: `${describe(raw)} is not a number; using 1.`,
    });
    return 1;
  }
  if (n <= 0) {
    issues.push({
      field: 'weight',
      code: 'out-of-range',
      detail: `weight must be greater than 0, got ${n}; using 1.`,
    });
    return 1;
  }
  return n;
}

/** Board order. Any finite number is legal, including negative and fractional. */
export function readOrderIndex(raw: unknown, issues: FieldIssue[]): number {
  if (raw === undefined) return 0;
  const n = toNumber(raw);
  if (n === null) {
    issues.push({
      field: 'orderIndex',
      code: 'not-a-number',
      detail: `${describe(raw)} is not a number; using 0.`,
    });
    return 0;
  }
  return n;
}

/**
 * A duration in minutes: absent, or a positive finite number.
 *
 * Zero and negative are rejected rather than carried. A negative fixed duration would
 * run the timeline cursor backwards, overlapping the previous task; a zero one is
 * indistinguishable from having no duration at all, which is what null already says.
 */
export function readDurationMinutes(
  raw: unknown,
  field: string,
  issues: FieldIssue[],
): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = toNumber(raw);
  if (n === null) {
    issues.push({
      field,
      code: 'not-a-number',
      detail: `${describe(raw)} is not a number; treated as unset.`,
    });
    return null;
  }
  if (n <= 0) {
    issues.push({
      field,
      code: 'out-of-range',
      detail: `${field} must be greater than 0, got ${n}; treated as unset.`,
    });
    return null;
  }
  return n;
}

export function readBoolean(
  raw: unknown,
  field: string,
  fallback: boolean,
  issues: FieldIssue[],
): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === 'boolean') return raw;
  issues.push({
    field,
    code: 'not-a-boolean',
    detail: `${describe(raw)} is not a boolean; using ${fallback}. Write true or false.`,
  });
  return fallback;
}

/**
 * A status identifier. Unknown-but-well-formed statuses are legal — the plugin let
 * creators configure their own, and `columnOf` files anything unrecognised under
 * running. Only a status that is not a usable identifier at all is an issue.
 */
export function readStatus(raw: unknown, fallback: string, issues: FieldIssue[]): string {
  if (raw === undefined) return fallback;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  issues.push({
    field: 'status',
    code: 'invalid-status',
    detail: `${describe(raw)} is not a status identifier; using "${fallback}".`,
  });
  return fallback;
}

/** A closed vocabulary whose values affect product routing or record state. */
export function readEnum<const T extends string>(
  raw: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
  issues: FieldIssue[],
): T {
  if (raw === undefined) return fallback;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  issues.push({
    field,
    code: 'invalid-enum',
    detail: `${describe(raw)} is not one of ${allowed.map((value) => `"${value}"`).join(', ')}; using "${fallback}".`,
  });
  return fallback;
}

/** An optional date. Kept as the original string; only its readability is checked. */
export function readOptionalDate(raw: unknown, field: string, issues: FieldIssue[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    issues.push({
      field,
      code: 'invalid-date',
      detail: `${describe(raw)} is not a date; treated as unset.`,
    });
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseCivilDate(raw) === null : Number.isNaN(new Date(raw).getTime())) {
    issues.push({ field, code: 'invalid-date', detail: `"${raw}" is not a readable date.` });
    return null;
  }
  return raw;
}

/**
 * A date that must exist. An unreadable one falls back rather than propagating, so
 * nothing downstream has to defend against NaN.
 */
export function readDate(raw: unknown, field: string, fallback: string, issues: FieldIssue[]): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = readOptionalDate(raw, field, issues);
  return value ?? fallback;
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function describe(raw: unknown): string {
  if (typeof raw === 'string') return `"${raw}"`;
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'a list';
  return String(raw);
}
