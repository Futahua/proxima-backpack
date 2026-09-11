// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindScheduleProjectionInteractions,
  renderScheduleProjection,
  scheduleDateOccurrenceProjection,
  type ScheduleProjectionMode,
} from '../src/browser/scheduleProjection.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  renderScheduleTimeGrid,
  scheduleVisibleDays,
} from '../src/browser/scheduleTimeGrid.js';
import { localCalendarDate } from '../src/browser/calendarGrid.js';
import { localDateKey } from '../src/domain/time.js';
import { scheduleNavigationDateKey } from '../src/browser/scheduleNavigation.js';
import type { CalendarEvent } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

const CURSOR = localCalendarDate(2026, 8, 1);
const NOW = new Date(2026, 8, 6, 12, 0, 0, 0);

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
    createdAt: localInstant(2026, 0, 1, 0, 0),
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

const multi = event(
  'multi',
  localInstant(2026, 8, 6, 22, 0),
  localInstant(2026, 8, 7, 1, 0),
);

const october = event(
  'october',
  localInstant(2026, 9, 2, 8, 0),
  localInstant(2026, 9, 2, 9, 0),
);

const january = event(
  'january',
  localInstant(2026, 0, 15, 13, 0),
  localInstant(2026, 0, 15, 14, 0),
);

const events = [
  october,
  multi,
  january,
  timed,
];

function render(
  mode: ScheduleProjectionMode,
  selectedEventId: string | null = null,
): string {
  return renderScheduleProjection({
    mode,
    events,
    projectNames: new Map(),
    selectionLabel: 'All projects',
    calendarCursor: CURSOR,
    now: NOW,
    selectedEventId,
    problems: [],
  });
}

function mount(
  mode: ScheduleProjectionMode,
): {
  root: HTMLElement;
  harness: ReturnType<typeof createInteractionHarness>;
  selectedEventId(): string | null;
  selectedMonths: string[];
  drilledMonths: string[];
} {
  document.body.innerHTML = '<div id="schedule-root"></div>';
  const root = document.querySelector<HTMLElement>(
    '#schedule-root',
  )!;
  let selectedEventId: string | null = null;
  const selectedMonths: string[] = [];
  const drilledMonths: string[] = [];

  const rerender = () => {
    root.innerHTML = render(mode, selectedEventId);
  };

  bindScheduleProjectionInteractions(root, {
    openEvent: (eventId) => {
      selectedEventId = eventId;
      rerender();
    },
    closeEvent: () => {
      selectedEventId = null;
      rerender();
    },
    selectMonth: (month) => {
      selectedMonths.push(month);
    },
    drillMonth: (month) => {
      drilledMonths.push(month);
    },
  });

  rerender();

  return {
    root,
    harness: createInteractionHarness(root),
    selectedEventId: () => selectedEventId,
    selectedMonths,
    drilledMonths,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Schedule Month, Year and Agenda projection', () => {
  it('shares deterministic Previous Today Next navigation semantics across all six Schedule modes', () => {
    const cursor = localCalendarDate(2026, 8, 6);
    const today = localCalendarDate(2026, 10, 19);
    const cases = [
      ['day', '2026-09-05', '2026-09-07'],
      ['four-day', '2026-09-02', '2026-09-10'],
      ['week', '2026-08-30', '2026-09-13'],
      ['month', '2026-08-06', '2026-10-06'],
      ['year', '2025-09-06', '2027-09-06'],
      ['agenda', '2026-08-06', '2026-10-06'],
    ] as const;

    for (const [mode, previous, next] of cases) {
      expect(
        scheduleNavigationDateKey(
          cursor,
          mode,
          'previous',
          today,
        ),
      ).toBe(previous);
      expect(
        scheduleNavigationDateKey(
          cursor,
          mode,
          'today',
          today,
        ),
      ).toBe('2026-11-19');
      expect(
        scheduleNavigationDateKey(
          cursor,
          mode,
          'next',
          today,
        ),
      ).toBe(next);
    }

    for (const mode of [
      'month',
      'year',
      'agenda',
    ] as const) {
      document.body.innerHTML = render(mode);
      const harness = createInteractionHarness(document);

      expect(
        harness.target('schedule-previous').dataset.action,
      ).toBe('schedule-navigate');
      expect(
        harness.target('schedule-today').dataset.direction,
      ).toBe('today');
      expect(
        harness.target('schedule-next').dataset.direction,
      ).toBe('next');

      expect(
        document.querySelector('[data-schedule-timed-event]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-schedule-resize-edge]'),
      ).toBeNull();
    }
  });

  it('projects event occurrences onto deterministic local civil dates', () => {
    expect(
      scheduleDateOccurrenceProjection(events),
    ).toEqual([
      {
        dayKey: '2026-01-15',
        eventId: 'january',
      },
      {
        dayKey: '2026-09-06',
        eventId: 'timed',
      },
      {
        dayKey: '2026-09-06',
        eventId: 'multi',
      },
      {
        dayKey: '2026-09-07',
        eventId: 'multi',
      },
      {
        dayKey: '2026-10-02',
        eventId: 'october',
      },
    ]);
  });

  it('renders Month as a 42-date occurrence grid and opens an event read-only without writes', () => {
    const before = JSON.stringify(events);
    const mounted = mount('month');

    expect(
      document.querySelectorAll('[data-schedule-month-day]'),
    ).toHaveLength(42);

    expect(
      mounted.harness
        .target('schedule-month-day-2026-09-06')
        .dataset.scheduleOccurrenceCount,
    ).toBe('2');
    expect(
      mounted.harness
        .target('schedule-month-day-2026-09-07')
        .dataset.scheduleOccurrenceCount,
    ).toBe('1');

    expect(
      mounted.harness
        .target('schedule-month-event-multi-2026-09-06')
        .dataset.scheduleOccurrenceDate,
    ).toBe('2026-09-06');
    expect(
      mounted.harness
        .target('schedule-month-event-multi-2026-09-07')
        .dataset.scheduleOccurrenceDate,
    ).toBe('2026-09-07');

    mounted.harness.click(
      'schedule-month-event-timed-2026-09-06',
    );

    expect(mounted.selectedEventId()).toBe('timed');
    expect(
      mounted.harness.target('schedule-event-modal')
        .dataset.scheduleEditorMode,
    ).toBe('read-only');
    expect(
      (mounted.harness.target(
        'schedule-event-name',
      ) as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('renders Year as twelve mini-months with date indicators and exact-month local drill-down', () => {
    const before = JSON.stringify(events);
    const mounted = mount('year');

    expect(
      document.querySelectorAll('[data-schedule-year-month]'),
    ).toHaveLength(12);

    expect(
      mounted.harness
        .target('schedule-year-month-2026-01-01')
        .dataset.scheduleYearMonth,
    ).toBe('2026-01-01');
    expect(
      mounted.harness
        .target('schedule-year-month-2026-12-01')
        .dataset.scheduleYearMonth,
    ).toBe('2026-12-01');

    const indicator = document.querySelector<HTMLElement>(
      '[data-schedule-year-event-indicator="2026-09-06"]',
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.dataset.scheduleOccurrenceCount)
      .toBe('2');

    mounted.harness.click(
      'schedule-year-day-2026-09-07',
    );
    expect(mounted.drilledMonths).toEqual([
      '2026-09-01',
    ]);

    expect(mounted.selectedMonths).toEqual([]);
    expect(
      mounted.harness.target('schedule-previous')
        .dataset.direction,
    ).toBe('previous');
    expect(
      mounted.harness.target('schedule-next')
        .dataset.direction,
    ).toBe('next');

    expect(JSON.stringify(events)).toBe(before);
  });

  it('renders Agenda as chronological date groups with editable event entry but no time-grid gesture semantics', () => {
    const before = JSON.stringify(events);
    const mounted = mount('agenda');

    const groupKeys = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-schedule-agenda-date]',
      ),
    ).map((group) => group.dataset.scheduleAgendaDate);

    expect(groupKeys).toEqual([
      '2026-01-15',
      '2026-09-06',
      '2026-09-07',
      '2026-10-02',
    ]);

    expect(
      mounted.harness
        .target('schedule-agenda-event-multi-2026-09-06')
        .dataset.scheduleOccurrenceDate,
    ).toBe('2026-09-06');
    expect(
      mounted.harness
        .target('schedule-agenda-event-multi-2026-09-07')
        .dataset.scheduleOccurrenceDate,
    ).toBe('2026-09-07');

    mounted.harness.click(
      'schedule-agenda-event-october-2026-10-02',
    );

    expect(mounted.selectedEventId()).toBe('october');
    expect(
      mounted.harness.target('schedule-event-modal')
        .dataset.scheduleEditorMode,
    ).toBe('read-only');

    for (const mode of [
      'month',
      'year',
      'agenda',
    ] as const) {
      document.body.innerHTML = render(mode);

      expect(
        document.querySelector('[data-schedule-timed-event]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-schedule-resize-edge]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-schedule-slot]'),
      ).toBeNull();
      expect(
        document.querySelector('[draggable="true"]'),
      ).toBeNull();
    }

    expect(JSON.stringify(events)).toBe(before);
  });

  it('projects one fixture set onto the same local dates in all six Schedule views', () => {
    const before = JSON.stringify(events);
    const cursor = localCalendarDate(2026, 8, 6);
    const canonical = scheduleDateOccurrenceProjection(events);

    // Month, Agenda and the time grid name both the event and the date it is drawn on;
    // Year reports how many occurrences fall on a date and nothing else, so it is read
    // as counts below rather than as pairs.
    const pairs = (root: ParentNode): string[][] => Array.from(
      root.querySelectorAll<HTMLElement>('[data-schedule-event-id]'),
    ).map((card) => [
      card.dataset.scheduleEventId ?? '',
      card.dataset.scheduleOccurrenceDate
        ?? card.closest<HTMLElement>('[data-schedule-day]')?.dataset.scheduleDay
        ?? '',
    ]).sort();

    const occurrencesOn = (dayKeys: readonly string[]): string[][] => canonical
      .filter((occurrence) => dayKeys.includes(occurrence.dayKey))
      .map((occurrence) => [occurrence.eventId, occurrence.dayKey] as [string, string])
      .sort();

    for (const mode of ['day', 'four-day', 'week'] as const) {
      document.body.innerHTML = renderScheduleTimeGrid({
        mode,
        events: [...events],
        projectNames: new Map(),
        selectionLabel: 'All projects',
        calendarCursor: cursor,
        now: NOW,
        selectedEventId: null,
      });

      expect(pairs(document.body))
        .toEqual(occurrencesOn(scheduleVisibleDays(cursor, mode).map((day) => localDateKey(day))));
    }

    document.body.innerHTML = renderScheduleProjection({
      mode: 'month',
      events,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      calendarCursor: cursor,
      now: NOW,
      selectedEventId: null,
      problems: [],
    });

    // The grid's outside days are drawn but carry no occurrence buttons, so the Month
    // view is compared against the days its own cells claim, in-month or not.
    const monthDays = Array.from(
      document.querySelectorAll<HTMLElement>('[data-schedule-month-day]'),
    ).filter((cell) => cell.dataset.scheduleOccurrenceCount !== '0')
      .map((cell) => cell.dataset.scheduleMonthDay ?? '');

    expect(pairs(document.body)).toEqual(occurrencesOn(monthDays));

    document.body.innerHTML = renderScheduleProjection({
      mode: 'agenda',
      events,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      calendarCursor: cursor,
      now: NOW,
      selectedEventId: null,
      problems: [],
    });

    expect(pairs(document.body)).toEqual(occurrencesOn(canonical.map((occurrence) => occurrence.dayKey)));

    document.body.innerHTML = renderScheduleProjection({
      mode: 'year',
      events,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      calendarCursor: cursor,
      now: NOW,
      selectedEventId: null,
      problems: [],
    });

    const expectedCounts = new Map<string, number>();
    for (const occurrence of canonical) {
      expectedCounts.set(occurrence.dayKey, (expectedCounts.get(occurrence.dayKey) ?? 0) + 1);
    }

    for (const [dayKey, count] of expectedCounts) {
      expect(
        document.querySelector<HTMLElement>(
          `[data-schedule-year-event-indicator="${dayKey}"]`,
        )?.dataset.scheduleOccurrenceCount,
      ).toBe(String(count));
    }

    expect(JSON.stringify(events)).toBe(before);
  });
});
