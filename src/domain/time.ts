/**
 * Presentation of time. Pure, and always given "now" rather than reading a clock.
 * Ported from the plugin's utils.ts; the Obsidian theme token in the contrast
 * helper is replaced by a Proxima-owned token.
 *
 * The two functions that turn an *instant* into civil fields - `localDateKey` and
 * `formatClockTime` - take the zone explicitly, because a `Date` getter reads whatever zone
 * the machine is in. `src/domain/timeZone.ts` owns the type; `src/browser/hostTimeZone.ts` is
 * the one place that reads the machine's zone.
 *
 * The default is UTC, and it is a **migration default rather than a policy**: it exists so the
 * ambient read could be removed in one step instead of through a call-site refactor, and
 * `tests/timeZoneDerivation.test.ts` pins the number of call sites still relying on it so the
 * count can only fall. A defaulted call derives in UTC - explicitly, deterministically, and
 * never in the machine's zone - which is why the ambient read is gone even before every caller
 * passes a zone.
 */
import { civilFieldsAt, utcZone, type TimeZone } from './timeZone.js';

export function formatAge(createdAtIso: string, now: number): string {
  const diff = now - new Date(createdAtIso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatCountdown(diffMs: number): string {
  const isPast = diffMs < 0;
  const totalSeconds = Math.floor(Math.abs(diffMs) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let text = '';
  if (days > 0) text += `${days}d `;
  if (hours > 0) text += `${hours}h `;
  text += `${minutes}m ${seconds}s`;
  return isPast ? `overdue by ${text}` : text;
}

/** Deadline urgency as a hue. Purple is overdue; red is under a day. */
export function deadlineHue(remainingMs: number): string {
  if (remainingMs < 0) return 'hsl(300, 60%, 85%)';
  const days = remainingMs / 86400000;
  if (days > 30) return 'hsl(210, 60%, 85%)';
  if (days >= 7) return 'hsl(180, 60%, 85%)';
  if (days >= 3) return 'hsl(60, 70%, 85%)';
  if (days >= 1) return 'hsl(30, 90%, 80%)';
  return 'hsl(0, 90%, 80%)';
}

export function formatDuration(minutes: number): string {
  const whole = Math.round(minutes);
  return whole >= 60 ? `${Math.floor(whole / 60)}h ${whole % 60}m` : `${whole}m`;
}

export interface CivilDate { year: number; month: number; day: number; }

/** Strict Gregorian parser for date-only creator values (YYYY-MM-DD). */
export function parseCivilDate(value: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function civilDateKey(value: CivilDate): string {
  return `${value.year.toString().padStart(4, '0')}-${value.month.toString().padStart(2, '0')}-${value.day.toString().padStart(2, '0')}`;
}

export function nextCivilDate(value: CivilDate): CivilDate {
  const limit = daysInMonth(value.year, value.month);
  if (value.day < limit) return { ...value, day: value.day + 1 };
  if (value.month < 12) return { year: value.year, month: value.month + 1, day: 1 };
  return { year: value.year + 1, month: 1, day: 1 };
}

/** Calendar date in the given zone, as YYYY-MM-DD. */
export function localDateKey(value: string | number | Date, zone: TimeZone = utcZone()): string {
  // A bare civil date is already a date: it is not an instant, so no zone applies to it.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(instant)) return 'invalid-date';
  const fields = civilFieldsAt(instant, zone);
  return `${String(fields.year).padStart(4, '0')}-${String(fields.month).padStart(2, '0')}-${String(fields.day).padStart(2, '0')}`;
}

/** Wall-clock time in the given zone, as HH:MM. */
export function formatClockTime(value: string | number | Date, zone: TimeZone = utcZone()): string {
  const instant = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(instant)) return '--:--';
  const fields = civilFieldsAt(instant, zone);
  return `${String(fields.hour).padStart(2, '0')}:${String(fields.minute).padStart(2, '0')}`;
}

export function contrastText(hexColor: string): string {
  if (!hexColor || !hexColor.startsWith('#')) return 'var(--proxima-text)';
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) return 'var(--proxima-text)';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#111111' : '#ffffff';
}
