/** Calendar-grid dates without Date(year, ...) 0–99 remapping. */
export function localCalendarDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month, day);
  return date;
}

export function calendarGridDates(cursor: Date): Date[] {
  const first = localCalendarDate(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = localCalendarDate(cursor.getFullYear(), cursor.getMonth(), 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => localCalendarDate(start.getFullYear(), start.getMonth(), start.getDate() + index));
}
