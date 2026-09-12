import type { ScheduleMode } from '../app/actionProtocol.js';
import { localDateKey } from '../domain/time.js';
import { localCalendarDate } from './calendarGrid.js';

export type ScheduleNavigationDirection =
  | 'previous'
  | 'today'
  | 'next';

function shiftCivilDays(
  cursor: Date,
  days: number,
): Date {
  const next = localCalendarDate(
    cursor.getFullYear(),
    cursor.getMonth(),
    cursor.getDate() + days,
  );

  if (
    next.getFullYear() < 0
    || next.getFullYear() > 9999
  ) {
    return localCalendarDate(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate(),
    );
  }

  return next;
}

function shiftCivilMonths(
  cursor: Date,
  months: number,
): Date {
  const sourceMonthIndex = (
    cursor.getFullYear() * 12
    + cursor.getMonth()
  );
  const targetMonthIndex = sourceMonthIndex + months;
  const targetYear = Math.floor(targetMonthIndex / 12);

  if (targetYear < 0 || targetYear > 9999) {
    return localCalendarDate(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate(),
    );
  }

  const targetMonth = targetMonthIndex - targetYear * 12;
  const lastDay = localCalendarDate(
    targetYear,
    targetMonth + 1,
    0,
  ).getDate();

  return localCalendarDate(
    targetYear,
    targetMonth,
    Math.min(cursor.getDate(), lastDay),
  );
}

export function scheduleNavigationDate(
  cursor: Date,
  mode: ScheduleMode,
  direction: ScheduleNavigationDirection,
  today: Date,
): Date {
  if (direction === 'today') {
    return localCalendarDate(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
  }

  const sign = direction === 'previous' ? -1 : 1;

  if (mode === 'day') {
    return shiftCivilDays(cursor, sign);
  }
  if (mode === 'four-day') {
    return shiftCivilDays(cursor, sign * 4);
  }
  if (mode === 'week') {
    return shiftCivilDays(cursor, sign * 7);
  }
  if (mode === 'year') {
    return shiftCivilMonths(cursor, sign * 12);
  }

  return shiftCivilMonths(cursor, sign);
}

export function scheduleNavigationDateKey(
  cursor: Date,
  mode: ScheduleMode,
  direction: ScheduleNavigationDirection,
  today: Date,
): string {
  return localDateKey(
    scheduleNavigationDate(
      cursor,
      mode,
      direction,
      today,
    ),
  );
}

function navigationLabel(
  cursor: Date,
  mode: ScheduleMode,
): string {
  if (mode === 'day') {
    return localDateKey(cursor);
  }
  if (mode === 'four-day') {
    return `${localDateKey(cursor)} – ${localDateKey(
      shiftCivilDays(cursor, 3),
    )}`;
  }
  if (mode === 'week') {
    return `${localDateKey(cursor)} – ${localDateKey(
      shiftCivilDays(cursor, 6),
    )}`;
  }
  if (mode === 'year') {
    return String(cursor.getFullYear());
  }

  return cursor.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export function renderScheduleNavigation(
  cursor: Date,
  mode: ScheduleMode,
): string {
  const label = navigationLabel(cursor, mode);

  return `<div class="calendar-controls" data-schedule-navigation="true" data-schedule-navigation-mode="${mode}" data-schedule-navigation-date="${localDateKey(cursor)}"><button type="button" class="icon-button" data-action="schedule-navigate" data-direction="previous" data-papers-visual-key="schedule-previous" aria-label="Previous ${mode}">←</button><button type="button" class="icon-button" data-action="schedule-navigate" data-direction="today" data-papers-visual-key="schedule-today">Today</button><strong data-papers-visual-key="schedule-navigation-label">${label}</strong><button type="button" class="icon-button" data-action="schedule-navigate" data-direction="next" data-papers-visual-key="schedule-next" aria-label="Next ${mode}">→</button></div>`;
}
