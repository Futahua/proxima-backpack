// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindScheduleTimeGridInteractions,
  isAllDayScheduleEvent,
  renderScheduleTimeGrid,
  scheduleAllDayProjection,
  scheduleTimedProjection,
  scheduleVisibleDays,
  startScheduleTimeTicker,
  type ScheduleTimeGridMode,
} from '../src/browser/scheduleTimeGrid.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import type { CalendarEvent } from '../src/domain/types.js';
import { localDateKey } from '../src/domain/time.js';
import { sourceRef } from './fixtures.js';

const NOW = new Date(2026, 8, 6, 12, 30, 0, 0);
const CURSOR = new Date(2026, 8, 6, 0, 0, 0, 0);

function localInstant(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(
    year,
    monthIndex,
    day,
    hour,
    minute,
    0,
    0,
  ).toISOString();
}

function event(
  id: string,
  startDate: string,
  deadline: string,
): CalendarEvent {
  return {
    id,
    source: sourceRef('event', id),
    name: `Event ${id}`,
    description: `Description ${id}`,
    projectId: null,
    createdAt: localInstant(2026, 8, 1, 0, 0),
    startDate,
    deadline,
    isCompleted: false,
    properties: {},
  };
}

const timed = event(
  'timed',
  localInstant(2026, 8, 6, 9, 30),
  localInstant(2026, 8, 6, 10, 45),
);

const overnight = event(
  'overnight',
  localInstant(2026, 8, 6, 22, 0),
  localInstant(2026, 8, 7, 1, 0),
);

const allDay = event(
  'all-day',
  localInstant(2026, 8, 7, 0, 0),
  localInstant(2026, 8, 8, 0, 0),
);

const outside = event(
  'outside',
  localInstant(2026, 8, 20, 10, 0),
  localInstant(2026, 8, 20, 11, 0),
);

const events = [timed, overnight, allDay, outside];

function render(
  mode: ScheduleTimeGridMode,
  selectedEventId: string | null = null,
): string {
  return renderScheduleTimeGrid({
    mode,
    events,
    projectNames: new Map(),
    selectionLabel: 'All projects',
    calendarCursor: CURSOR,
    now: NOW,
    selectedEventId,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Schedule Day, 4-Day and Week presentation', () => {
  it('uses one, four and seven adjacent civil-day columns over the same 96-slot grid', () => {
    for (const [mode, expectedDays] of [
      ['day', 1],
      ['four-day', 4],
      ['week', 7],
    ] as const) {
      document.body.innerHTML = render(mode);

      const harness = createInteractionHarness(document);
      const body = harness.target('schedule-time-grid-body');

      expect(body.dataset.scheduleDayCount).toBe(String(expectedDays));
      expect(body.dataset.scheduleSlotMinutes).toBe('15');
      expect(
        document.querySelectorAll('[data-schedule-day]'),
      ).toHaveLength(expectedDays);
      expect(
        document.querySelectorAll('[data-schedule-slot]'),
      ).toHaveLength(expectedDays * 96);

      const visibleDays = scheduleVisibleDays(CURSOR, mode);

      expect(visibleDays).toHaveLength(expectedDays);
      expect(localDateKey(visibleDays[0]!)).toBe('2026-09-06');
    }
  });

  it('places timed and multi-day timed events by local minutes while separating inferred all-day events', () => {
    const days = scheduleVisibleDays(CURSOR, 'four-day');
    const timedProjection = scheduleTimedProjection(events, days);
    const allDayProjection = scheduleAllDayProjection(events, days);

    expect(isAllDayScheduleEvent(allDay)).toBe(true);
    expect(isAllDayScheduleEvent(overnight)).toBe(false);

    expect(
      timedProjection.find((segment) => (
        segment.eventId === 'timed'
        && segment.dayKey === '2026-09-06'
      )),
    ).toMatchObject({
      startMinute: 570,
      endMinute: 645,
    });

    expect(
      timedProjection.find((segment) => (
        segment.eventId === 'overnight'
        && segment.dayKey === '2026-09-06'
      )),
    ).toMatchObject({
      startMinute: 1_320,
      endMinute: 1_440,
    });

    expect(
      timedProjection.find((segment) => (
        segment.eventId === 'overnight'
        && segment.dayKey === '2026-09-07'
      )),
    ).toMatchObject({
      startMinute: 0,
      endMinute: 60,
    });

    expect(
      timedProjection.some((segment) => segment.eventId === 'all-day'),
    ).toBe(false);
    expect(allDayProjection).toEqual([
      {
        eventId: 'all-day',
        startColumn: 2,
        spanColumns: 1,
      },
    ]);
  });

  it('derives the current-time indicator from the supplied clock and advances it only when the live-clock gate allows refresh', () => {
    vi.useFakeTimers();

    try {
      document.body.innerHTML = render('day');
      const harness = createInteractionHarness(document);
      const indicator = harness.target('schedule-current-time-2026-09-06');

      expect(indicator.dataset.currentMinute).toBe('750');

      let live = false;
      let refreshes = 0;
      const stop = startScheduleTimeTicker(
        document.body,
        () => live,
        () => {
          refreshes += 1;
        },
      );

      try {
        vi.advanceTimersByTime(60_000);
        expect(refreshes).toBe(0);

        live = true;
        vi.advanceTimersByTime(60_000);
        expect(refreshes).toBe(1);
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens and closes the local read-only event editor through machine-key clicks without changing event data', () => {
    const before = JSON.stringify(events);
    document.body.innerHTML = '<div id="schedule-root"></div>';
    const root = document.querySelector<HTMLElement>('#schedule-root')!;
    let selectedEventId: string | null = null;

    const rerender = () => {
      root.innerHTML = renderScheduleTimeGrid({
        mode: 'day',
        events,
        projectNames: new Map(),
        selectionLabel: 'All projects',
        calendarCursor: CURSOR,
        now: NOW,
        selectedEventId,
      });
    };

    bindScheduleTimeGridInteractions(root, {
      openEvent: (eventId) => {
        selectedEventId = eventId;
        rerender();
      },
      closeEvent: () => {
        selectedEventId = null;
        rerender();
      },
    });

    rerender();

    const harness = createInteractionHarness(root);

    harness.click('schedule-event-timed-2026-09-06');

    expect(selectedEventId).toBe('timed');
    expect(harness.target('schedule-event-modal').getAttribute('role'))
      .toBe('dialog');
    expect(
      (harness.target('schedule-event-start') as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(
      (harness.target('schedule-event-end') as HTMLInputElement).readOnly,
    ).toBe(true);

    harness.click('schedule-event-modal-close');

    expect(selectedEventId).toBeNull();
    expect(() => harness.target('schedule-event-modal')).toThrow();
    expect(JSON.stringify(events)).toBe(before);
  });

  it('gives empty 15-minute slots no creation action or silent event side effect', () => {
    document.body.innerHTML = '<div id="schedule-root"></div>';
    const root = document.querySelector<HTMLElement>('#schedule-root')!;
    let openedEventId: string | null = null;

    root.innerHTML = render('day');

    bindScheduleTimeGridInteractions(root, {
      openEvent: (eventId) => {
        openedEventId = eventId;
      },
      closeEvent: () => {
        openedEventId = null;
      },
    });

    const harness = createInteractionHarness(root);
    const emptySlot = harness.target(
      'schedule-slot-2026-09-06-0',
    );

    expect(emptySlot.dataset.scheduleAction).toBeUndefined();

    harness.click('schedule-slot-2026-09-06-0');

    expect(openedEventId).toBeNull();
  });
});
