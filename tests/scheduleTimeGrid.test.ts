// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_SCHEMA_VERSION,
  type ActionResult,
} from '../src/app/actionProtocol.js';
import {
  bindScheduleTimeGridInteractions,
  isAllDayScheduleEvent,
  renderScheduleTimeGrid,
  scheduleAllDayProjection,
  scheduleTimedProjection,
  scheduleVisibleDays,
  startScheduleTimeTicker,
  type ScheduleEventChangeIntent,
  type ScheduleEventCreateIntent,
  type ScheduleEventDraft,
  type ScheduleTimeGridMode,
} from '../src/browser/scheduleTimeGrid.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { scheduleNavigationDateKey } from '../src/browser/scheduleNavigation.js';
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
  seededEvent: ScheduleEventDraft | null = null,
): string {
  return renderScheduleTimeGrid({
    mode,
    events,
    projectNames: new Map(),
    selectionLabel: 'All projects',
    calendarCursor: CURSOR,
    now: NOW,
    selectedEventId,
    seededEvent,
  });
}

function setScheduleTrackGeometry(root: ParentNode): void {
  root
    .querySelectorAll<HTMLElement>('.schedule-time-track')
    .forEach((track) => {
      Object.defineProperty(track, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 160,
          bottom: 768,
          width: 160,
          height: 768,
          toJSON: () => ({}),
        }),
      });
    });
}

function unavailableScheduleResult(eventId: string): ActionResult {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: false,
    actionType: 'event.schedule.change',
    category: 'record-mutation',
    outcome: 'unavailable',
    stateRevision: 1,
    requestId: `request-${eventId}`,
    entityIds: [eventId],
    error: {
      code: 'action-not-available',
      message: 'schedule event writes remain unavailable before record-store cutover',
    },
  };
}

function unavailableScheduleCreateResult(): ActionResult {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    ok: false,
    actionType: 'event.schedule.create',
    category: 'record-mutation',
    outcome: 'unavailable',
    stateRevision: 1,
    requestId: 'request-create',
    entityIds: [],
    error: {
      code: 'action-not-available',
      message: 'schedule event creation remains unavailable before record-store cutover',
    },
  };
}

function mountInteractiveSchedule(
  mode: ScheduleTimeGridMode,
  changes: ScheduleEventChangeIntent[],
  refusal = false,
): {
  root: HTMLElement;
  harness: ReturnType<typeof createInteractionHarness>;
} {
  document.body.innerHTML = '<div id="schedule-root"></div>';
  const root = document.querySelector<HTMLElement>('#schedule-root')!;
  root.innerHTML = render(mode);
  setScheduleTrackGeometry(root);

  bindScheduleTimeGridInteractions(root, {
    openEvent: () => {},
    closeEvent: () => {},
    seedEvent: () => {},
    createEvent: () => null,
    changeEvent: (intent) => {
      changes.push(intent);
      return refusal ? unavailableScheduleResult(intent.eventId)
        : null;
    },
  });

  return {
    root,
    harness: createInteractionHarness(root),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Schedule Day, 4-Day and Week presentation', () => {
  it('renders the shared Previous Today Next contract in Day, 4-Day and Week without changing the time-grid interaction surface', () => {
    for (const mode of [
      'day',
      'four-day',
      'week',
    ] as const) {
      document.body.innerHTML = render(mode);
      const harness = createInteractionHarness(document);

      expect(
        harness.target('schedule-previous').dataset.action,
      ).toBe('schedule-navigate');
      expect(
        harness.target('schedule-previous').dataset.direction,
      ).toBe('previous');
      expect(
        harness.target('schedule-today').dataset.direction,
      ).toBe('today');
      expect(
        harness.target('schedule-next').dataset.direction,
      ).toBe('next');
      expect(
        document.querySelector<HTMLElement>(
          '[data-schedule-navigation]',
        )?.dataset.scheduleNavigationMode,
      ).toBe(mode);

      expect(
        document.querySelectorAll('[data-schedule-slot]'),
      ).toHaveLength(
        (mode === 'day' ? 1 : mode === 'four-day' ? 4 : 7)
          * 96,
      );
    }
  });

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

  it('renders timed height as local duration over 1440 and exposes only the actual bottom resize edge', () => {
    document.body.innerHTML = render('four-day');
    const harness = createInteractionHarness(document);
    const timedCard = harness.target(
      'schedule-event-timed-2026-09-06',
    );

    expect(parseFloat(timedCard.style.top)).toBeCloseTo(
      (570 / 1_440) * 100,
    );
    expect(parseFloat(timedCard.style.height)).toBeCloseTo(
      (75 / 1_440) * 100,
    );

    expect(
      harness
        .target('schedule-event-timed-2026-09-06-resize-end')
        .dataset.scheduleResizeEdge,
    ).toBe('end');

    expect(() => (
      harness.target(
        'schedule-event-overnight-2026-09-06-resize-end',
      )
    )).toThrow();

    expect(
      harness
        .target('schedule-event-overnight-2026-09-07-resize-end')
        .dataset.scheduleResizeEdge,
    ).toBe('end');

    expect(
      document.querySelector('[data-schedule-resize-edge="start"]'),
    ).toBeNull();
  });

  it('follows the pointer and snaps moves to Schedule-specific 15-minute slots in Day, 4-Day and Week', () => {
    for (const mode of ['day', 'four-day', 'week'] as const) {
      const changes: ScheduleEventChangeIntent[] = [];
      const { harness } = mountInteractiveSchedule(
        mode,
        changes,
      );
      const gesture = harness.pointerDown(
        'schedule-event-timed-2026-09-06',
        {
          clientX: 40,
          clientY: 312,
        },
      );

      gesture.move(
        'schedule-time-track-2026-09-06',
        {
          clientX: 40,
          clientY: 326,
        },
      );

      const preview = harness.target(
        'schedule-preview-timed-2026-09-06',
      );
      expect(preview.dataset.schedulePreviewStartMinute)
        .toBe('600');
      expect(preview.dataset.schedulePreviewEndMinute)
        .toBe('675');
      expect(
        preview.dataset.schedulePreviewDurationMinutes,
      ).toBe('75');
      expect(parseFloat(preview.style.top)).toBeCloseTo(
        (600 / 1_440) * 100,
      );
      expect(parseFloat(preview.style.height)).toBeCloseTo(
        (75 / 1_440) * 100,
      );

      gesture.release(
        'schedule-time-track-2026-09-06',
        {
          clientX: 40,
          clientY: 326,
        },
      );

      expect(changes).toEqual([{
        eventId: 'timed',
        operation: 'move',
        proposedStartDate: localInstant(
          2026,
          8,
          6,
          10,
          0,
        ),
        proposedDeadline: localInstant(
          2026,
          8,
          6,
          11,
          15,
        ),
      }]);

      expect(() => (
        harness.target('schedule-preview-timed-2026-09-06')
      )).toThrow();
    }
  });

  it('moves a multi-day timed event across civil days with a segmented live preview and restores it after typed refusal', () => {
    for (const mode of ['four-day', 'week'] as const) {
      const changes: ScheduleEventChangeIntent[] = [];
      const { harness } = mountInteractiveSchedule(
        mode,
        changes,
        true,
      );
      const sourceFirst = harness.target(
        'schedule-event-overnight-2026-09-06',
      );
      const sourceLast = harness.target(
        'schedule-event-overnight-2026-09-07',
      );
      const gesture = harness.pointerDown(
        'schedule-event-overnight-2026-09-06',
        {
          clientX: 40,
          clientY: 720,
        },
      );

      gesture.move(
        'schedule-time-track-2026-09-07',
        {
          clientX: 40,
          clientY: 720,
        },
      );

      const firstPreview = harness.target(
        'schedule-preview-overnight-2026-09-07',
      );
      const secondPreview = harness.target(
        'schedule-preview-overnight-2026-09-08',
      );

      expect(firstPreview.dataset.schedulePreviewStartMinute)
        .toBe('1320');
      expect(firstPreview.dataset.schedulePreviewEndMinute)
        .toBe('1440');
      expect(firstPreview.dataset.schedulePreviewDurationMinutes)
        .toBe('120');
      expect(secondPreview.dataset.schedulePreviewStartMinute)
        .toBe('0');
      expect(secondPreview.dataset.schedulePreviewEndMinute)
        .toBe('60');
      expect(secondPreview.dataset.schedulePreviewDurationMinutes)
        .toBe('60');

      gesture.release(
        'schedule-time-track-2026-09-07',
        {
          clientX: 40,
          clientY: 720,
        },
      );

      expect(changes).toEqual([{
        eventId: 'overnight',
        operation: 'move',
        proposedStartDate: localInstant(
          2026,
          8,
          7,
          22,
          0,
        ),
        proposedDeadline: localInstant(
          2026,
          8,
          8,
          1,
          0,
        ),
      }]);

      expect(sourceFirst.dataset.scheduleRefusal)
        .toBe('action-not-available');
      expect(sourceLast.dataset.scheduleRefusal)
        .toBe('action-not-available');
      expect(sourceFirst.style.opacity).toBe('');
      expect(sourceLast.style.opacity).toBe('');
      expect(() => (
        harness.target('schedule-preview-overnight-2026-09-07')
      )).toThrow();
      expect(() => (
        harness.target('schedule-preview-overnight-2026-09-08')
      )).toThrow();
    }
  });

  it('resizes only from the bottom edge with a live 15-minute snapped deadline preview', () => {
    const changes: ScheduleEventChangeIntent[] = [];
    const { harness } = mountInteractiveSchedule(
      'day',
      changes,
      true,
    );
    const source = harness.target(
      'schedule-event-timed-2026-09-06',
    );
    const gesture = harness.beginResize(
      'schedule-event-timed-2026-09-06-resize-end',
      {
        clientX: 40,
        clientY: 344,
      },
    );

    gesture.move(
      'schedule-time-track-2026-09-06',
      {
        clientX: 40,
        clientY: 370,
      },
    );

    const preview = harness.target(
      'schedule-preview-timed-2026-09-06',
    );
    expect(preview.dataset.schedulePreviewStartMinute)
      .toBe('570');
    expect(preview.dataset.schedulePreviewEndMinute)
      .toBe('690');
    expect(preview.dataset.schedulePreviewDurationMinutes)
      .toBe('120');
    expect(parseFloat(preview.style.height)).toBeCloseTo(
      (120 / 1_440) * 100,
    );

    gesture.release(
      'schedule-time-track-2026-09-06',
      {
        clientX: 40,
        clientY: 370,
      },
    );

    expect(changes).toEqual([{
      eventId: 'timed',
      operation: 'resize-end',
      proposedStartDate: localInstant(
        2026,
        8,
        6,
        9,
        30,
      ),
      proposedDeadline: localInstant(
        2026,
        8,
        6,
        11,
        30,
      ),
    }]);
    expect(source.dataset.scheduleRefusal)
      .toBe('action-not-available');
    expect(source.style.opacity).toBe('');
    expect(() => (
      harness.target('schedule-preview-timed-2026-09-06')
    )).toThrow();
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
      seedEvent: () => {},
      createEvent: () => null,
      changeEvent: () => null,
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

  it('seeds an empty Day, 4-Day or Week slot at its clicked civil time with a local one-hour proposal and no Save side effect', () => {
    const before = JSON.stringify(events);
    const cases: readonly [
      ScheduleTimeGridMode,
      string,
      number,
      string,
      string,
    ][] = [
      [
        'day',
        '2026-09-06',
        0,
        localInstant(2026, 8, 6, 0, 0),
        localInstant(2026, 8, 6, 1, 0),
      ],
      [
        'four-day',
        '2026-09-08',
        41,
        localInstant(2026, 8, 8, 10, 15),
        localInstant(2026, 8, 8, 11, 15),
      ],
      [
        'week',
        '2026-09-12',
        95,
        localInstant(2026, 8, 12, 23, 45),
        localInstant(2026, 8, 13, 0, 45),
      ],
    ];

    for (const [
      mode,
      dayKey,
      slotIndex,
      expectedStart,
      expectedDeadline,
    ] of cases) {
      document.body.innerHTML = '<div id="schedule-root"></div>';
      const root = document.querySelector<HTMLElement>('#schedule-root')!;
      let seededEvent: ScheduleEventDraft | null = null;
      const saves: ScheduleEventCreateIntent[] = [];

      const rerender = () => {
        root.innerHTML = renderScheduleTimeGrid({
          mode,
          events,
          projectNames: new Map(),
          selectionLabel: 'All projects',
          calendarCursor: CURSOR,
          now: NOW,
          selectedEventId: null,
          seededEvent,
        });
      };

      bindScheduleTimeGridInteractions(root, {
        openEvent: () => {},
        closeEvent: () => {
          seededEvent = null;
          rerender();
        },
        seedEvent: (draft) => {
          seededEvent = { ...draft };
          rerender();
        },
        createEvent: (intent) => {
          saves.push(intent);
          return null;
        },
        changeEvent: () => null,
      });

      rerender();
      const harness = createInteractionHarness(root);
      const slot = harness.target(
        `schedule-slot-${dayKey}-${slotIndex}`,
      );

      expect(slot.dataset.scheduleAction).toBe('seed-event');
      harness.click(`schedule-slot-${dayKey}-${slotIndex}`);

      expect(seededEvent).toEqual({
        name: 'New event',
        projectId: null,
        description: '',
        startDate: expectedStart,
        deadline: expectedDeadline,
      });
      expect(
        harness.target('schedule-event-modal')
          .dataset.scheduleEditorMode,
      ).toBe('create');
      expect(
        (harness.target('schedule-event-start') as HTMLInputElement)
          .value,
      ).toBe(expectedStart);
      expect(
        (harness.target('schedule-event-end') as HTMLInputElement)
          .value,
      ).toBe(expectedDeadline);
      expect(harness.target('schedule-event-save'))
        .toBeInstanceOf(HTMLElement);
      expect(saves).toEqual([]);
      expect(JSON.stringify(events)).toBe(before);
    }
  });

  it('sends a seeded event through Save only and keeps the editor open with the typed unavailable refusal', () => {
    const before = JSON.stringify(events);
    document.body.innerHTML = '<div id="schedule-root"></div>';
    const root = document.querySelector<HTMLElement>('#schedule-root')!;
    let seededEvent: ScheduleEventDraft | null = null;
    const saves: ScheduleEventCreateIntent[] = [];

    const rerender = () => {
      root.innerHTML = renderScheduleTimeGrid({
        mode: 'day',
        events,
        projectNames: new Map(),
        selectionLabel: 'All projects',
        calendarCursor: CURSOR,
        now: NOW,
        selectedEventId: null,
        seededEvent,
      });
    };

    bindScheduleTimeGridInteractions(root, {
      openEvent: () => {},
      closeEvent: () => {
        seededEvent = null;
        rerender();
      },
      seedEvent: (draft) => {
        seededEvent = { ...draft };
        rerender();
      },
      createEvent: (intent) => {
        saves.push(intent);
        return unavailableScheduleCreateResult();
      },
      changeEvent: () => null,
    });

    rerender();
    const harness = createInteractionHarness(root);

    harness.click('schedule-slot-2026-09-06-38');

    expect(saves).toEqual([]);
    expect(JSON.stringify(events)).toBe(before);

    harness.click('schedule-event-save');

    expect(saves).toEqual([{
      name: 'New event',
      projectId: null,
      description: '',
      startDate: localInstant(2026, 8, 6, 9, 30),
      deadline: localInstant(2026, 8, 6, 10, 30),
    }]);
    expect(
      harness.target('schedule-event-modal')
        .dataset.scheduleRefusal,
    ).toBe('action-not-available');
    expect(JSON.stringify(events)).toBe(before);
  });
});
