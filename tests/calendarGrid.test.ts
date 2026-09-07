import { describe, expect, it } from 'vitest';
import { calendarGridDates, localCalendarDate } from '../src/browser/calendarGrid.js';
import { localDateKey } from '../src/domain/time.js';

describe('Gate 6.3B Calendar grid presentation', () => {
  it('preserves low-year calendar state without Date constructor remapping', () => {
    const cursor = localCalendarDate(99, 11, 1);
    const keys = calendarGridDates(cursor).map((date) => localDateKey(date));
    expect(keys.some((key) => key.startsWith('0099-'))).toBe(true);
    expect(keys.some((key) => key.startsWith('1999-'))).toBe(false);
  });

  it('always returns a deterministic 42-cell grid across year boundaries', () => {
    const cursor = localCalendarDate(2026, 11, 1);
    const first = calendarGridDates(cursor).map((date) => localDateKey(date));
    const second = calendarGridDates(cursor).map((date) => localDateKey(date));
    expect(first).toEqual(second);
    expect(first).toHaveLength(42);
    expect(first).toContain('2027-01-01');
  });
});
