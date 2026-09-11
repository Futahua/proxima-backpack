// @vitest-environment happy-dom

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createActionDispatcher,
  type ActionResult,
  type ProximaActionDispatcher,
} from '../src/app/actionProtocol.js';
import {
  bindElasticCockpitInteractions,
} from '../src/browser/elasticCockpit.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  bindTimekeepingCockpitInteractions,
  countdownProjection,
  deadlineCalendarProjection,
  renderTimekeepingCockpit,
  startTimekeepingCountdownTicker,
  timelineGanttProjection,
  type TimelineChangeIntent,
} from '../src/browser/timekeepingCockpit.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { localDateKey } from '../src/domain/time.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

const NOW = new Date(2026, 8, 6, 12, 0, 0, 0);

function durableStateHash(state: ProximaState): string {
  return createHash('sha256')
    .update(JSON.stringify(state))
    .digest('hex');
}

function afterHours(hours: number): string {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function task(
  id: string,
  deadline: string | null,
  startDate: string | null = null,
): Task {
  return {
    id,
    source: sourceRef('task', id),
    name: `Task ${id}`,
    description: `Description ${id}`,
    projectId: null,
    status: 'running',
    weight: 1,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: afterHours(-24 * 30),
    startDate,
    deadline,
    properties: {},
  };
}

const overdue = task('overdue', afterHours(-24));
const urgent = task('urgent', afterHours(6), afterHours(-24));
const underThreeDays = task('under-three-days', afterHours(36));
const underOneWeek = task('under-one-week', afterHours(96));
const later = task('later', afterHours(24 * 14));
const startOnly = task('start-only', null, afterHours(24 * 3));
const noDeadline = task('no-deadline', null);

const state: ProximaState = {
  projects: [],
  tasks: [
    overdue,
    urgent,
    underThreeDays,
    underOneWeek,
    later,
    startOnly,
    noDeadline,
  ],
  events: [],
  statuses: [
    {
      id: 'running',
      name: 'Running',
      color: '#000',
      column: 'running',
    },
  ],
  taskSchema: [],
};

function createDispatcher(): ProximaActionDispatcher {
  return createActionDispatcher({
    state,
    mode: 'fixture',
    initialTasksMode: 'timekeeping',
    initialCalendarMonth: '2026-09-01',
    clock: fixedClock(NOW.toISOString()),
    idGenerator: sequentialIdGenerator(),
  });
}

function mount(
  dispatcher: ProximaActionDispatcher,
  now: () => Date = () => NOW,
) {
  document.body.innerHTML = '<div id="timekeeping-root"></div>';
  const root = document.querySelector<HTMLElement>('#timekeeping-root')!;
  let selectedTaskId: string | null = null;
  const timelineIntents: TimelineChangeIntent[] = [];
  const timelineResults: ActionResult[] = [];

  const render = () => {
    const snapshot = dispatcher.snapshot();

    root.innerHTML = renderTimekeepingCockpit({
      state: snapshot.state,
      tasks: snapshot.state.tasks,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      panels: snapshot.timekeepingPanels,
      calendarCursor: new Date(`${snapshot.calendarMonth}T00:00:00`),
      now: now(),
      selectedTaskId,
      editorDraft: null,
    });
  };

  bindTimekeepingCockpitInteractions(root, {
    openTask: (taskId) => {
      selectedTaskId = taskId;
      render();
    },
    setPanelVisible: (panel, visible) => {
      dispatcher.dispatch({
        type: 'timekeeping.panel.set-visible',
        panel,
        visible,
      });
      render();
    },
    navigateMonth: (direction) => {
      dispatcher.dispatch({
        type: 'calendar.navigate',
        direction,
      });
      render();
    },
    today: () => {
      dispatcher.dispatch({ type: 'calendar.today' });
      render();
    },
    changeTask: (intent) => {
      timelineIntents.push(intent);
      const result = dispatcher.dispatch({
        type: 'task.timeline.change',
        taskId: intent.taskId,
        operation: intent.operation,
        proposedStartDate: intent.proposedStartDate,
        proposedDeadline: intent.proposedDeadline,
        targetRowIndex: intent.targetRowIndex,
      });
      timelineResults.push(result);
      return result;
    },
  });

  bindElasticCockpitInteractions(root, {
    openTask: (taskId) => {
      selectedTaskId = taskId;
      render();
    },
    closeTask: () => {
      selectedTaskId = null;
      render();
    },
    setTarget: () => {},
    lock: () => {},
    unlock: () => {},
    moveTask: () => {},
    editTask: () => undefined,
    cancelTaskEdit: () => undefined,
  });

  render();

  return {
    root,
    harness: createInteractionHarness(root),
    render,
    selectedTaskId: () => selectedTaskId,
    timelineIntents: () => timelineIntents,
    timelineResults: () => timelineResults,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Timekeeping composition shell and Deadline Calendar', () => {
  it('projects deadline placement without mutating records', () => {
    const before = JSON.stringify(state);
    const projection = deadlineCalendarProjection(state.tasks, NOW);

    expect(projection.map((entry) => entry.taskId)).toEqual([
      'overdue',
      'urgent',
      'under-three-days',
      'under-one-week',
      'later',
    ]);

    for (const item of [
      overdue,
      urgent,
      underThreeDays,
      underOneWeek,
      later,
    ]) {
      expect(
        projection.find((entry) => entry.taskId === item.id)?.dayKey,
      ).toBe(localDateKey(item.deadline!));
    }

    expect(
      projection.some((entry) => entry.taskId === noDeadline.id),
    ).toBe(false);

    expect(JSON.stringify(state)).toBe(before);
  });

  it('projects truthful Gantt spans and milestones into the visible civil-day window', () => {
    const before = JSON.stringify(state);
    const projection = timelineGanttProjection(
      state.tasks,
      new Date(2026, 8, 1),
      NOW,
    );

    expect(
      projection.find((entry) => entry.taskId === 'urgent'),
    ).toMatchObject({
      kind: 'span',
      startKey: localDateKey(urgent.startDate!),
      endKey: localDateKey(urgent.deadline!),
    });

    expect(
      projection.find((entry) => entry.taskId === 'later'),
    ).toMatchObject({
      kind: 'deadline',
      startKey: null,
      endKey: localDateKey(later.deadline!),
      spanColumns: 1,
    });

    expect(
      projection.find((entry) => entry.taskId === 'start-only'),
    ).toMatchObject({
      kind: 'start',
      startKey: localDateKey(startOnly.startDate!),
      endKey: null,
      spanColumns: 1,
    });

    expect(
      projection.some((entry) => entry.taskId === 'no-deadline'),
    ).toBe(false);

    expect(JSON.stringify(state)).toBe(before);
  });

  it('composes panels non-exclusively through machine-key interactions', () => {
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    expect(mounted.harness.target('timekeeping-panel-calendar'))
      .toBeInstanceOf(HTMLElement);

    mounted.harness.click('timekeeping-panel-toggle-timeline');
    mounted.harness.click('timekeeping-panel-toggle-countdowns');

    expect(mounted.harness.target('timekeeping-panel-calendar'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-panel-timeline'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-panel-countdowns'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-gantt-body'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-gantt-task-urgent'))
      .toBeInstanceOf(HTMLElement);

    expect(dispatcher.snapshot().timekeepingPanels).toEqual({
      calendar: true,
      timeline: true,
      countdowns: true,
    });

    mounted.render();

    expect(mounted.harness.target('timekeeping-panel-calendar'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-panel-timeline'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-panel-countdowns'))
      .toBeInstanceOf(HTMLElement);

    mounted.harness.click('timekeeping-panel-toggle-calendar');

    expect(() => mounted.harness.target('timekeeping-panel-calendar'))
      .toThrow();
    expect(mounted.harness.target('timekeeping-panel-timeline'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-panel-countdowns'))
      .toBeInstanceOf(HTMLElement);
  });

  it('navigates months, marks today, and gives empty days no creation action', () => {
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    const today = mounted.harness.target(
      `timekeeping-calendar-day-${localDateKey(NOW)}`,
    );

    expect(today.classList.contains('today')).toBe(true);
    expect(today.getAttribute('aria-current')).toBe('date');

    mounted.harness.click('timekeeping-calendar-next');

    expect(dispatcher.snapshot().calendarMonth).toBe('2026-10-01');
    expect(
      mounted.harness.target('timekeeping-calendar-month')
        .dataset.calendarMonth,
    ).toBe('2026-10-01');

    mounted.harness.click('timekeeping-calendar-today');

    expect(dispatcher.snapshot().calendarMonth).toBe('2026-09-01');

    const emptyCell = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-c1-key^="timekeeping-calendar-day-"]',
      ),
    ).find((cell) => cell.dataset.deadlineCount === '0');

    expect(emptyCell).toBeDefined();
    expect(emptyCell!.querySelector('[data-timekeeping-action]')).toBeNull();
    expect(emptyCell!.querySelector('[data-elastic-action]')).toBeNull();
  });

  it('drives Gantt navigation and task entry through the real DOM without record writes', () => {
    const beforeRecords = JSON.stringify(state);
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    mounted.harness.click('timekeeping-panel-toggle-timeline');
    mounted.harness.click('timekeeping-panel-toggle-calendar');

    expect(() => mounted.harness.target('timekeeping-panel-calendar'))
      .toThrow();
    expect(mounted.harness.target('timekeeping-panel-timeline'))
      .toBeInstanceOf(HTMLElement);

    const urgentBar = mounted.harness.target(
      'timekeeping-gantt-task-urgent',
    );

    expect(urgentBar.dataset.ganttKind).toBe('span');
    expect(Number(urgentBar.dataset.ganttSpanColumns)).toBeGreaterThan(1);

    const today = mounted.harness.target(
      `timekeeping-gantt-day-${localDateKey(NOW)}`,
    );

    expect(today.classList.contains('today')).toBe(true);
    expect(today.getAttribute('aria-current')).toBe('date');

    mounted.harness.click('timekeeping-gantt-next');

    expect(dispatcher.snapshot().calendarMonth).toBe('2026-10-01');
    expect(
      mounted.harness.target('timekeeping-gantt-month')
        .dataset.calendarMonth,
    ).toBe('2026-10-01');

    mounted.harness.click('timekeeping-gantt-today');

    expect(dispatcher.snapshot().calendarMonth).toBe('2026-09-01');

    mounted.harness.click('timekeeping-gantt-task-urgent');

    expect(mounted.selectedTaskId()).toBe('urgent');
    expect(mounted.harness.target('elastic-task-modal'))
      .toBeInstanceOf(HTMLElement);

    mounted.harness.click('elastic-task-modal-close');

    expect(mounted.selectedTaskId()).toBeNull();
    expect(JSON.stringify(dispatcher.snapshot().state)).toBe(beforeRecords);
  });

  it('previews a phased pointer move by whole days and resolves an occupied row continuously before refusing the write', () => {
    const beforeRecords = JSON.stringify(state);
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    mounted.harness.click('timekeeping-panel-toggle-timeline');
    mounted.harness.click('timekeeping-panel-toggle-calendar');

    const bar = mounted.harness.target('timekeeping-gantt-task-urgent');
    const row = mounted.harness.target('timekeeping-gantt-row-urgent');
    const targetRow = mounted.harness.target('timekeeping-gantt-row-later');
    const track = mounted.harness.target('timekeeping-gantt-track-urgent');
    const proposal = mounted.harness.target('timekeeping-gantt-proposal-urgent');
    const originalGridColumn = bar.style.gridColumn;
    const originalStartColumn = Number(bar.dataset.ganttStartColumn);
    const originalSpanColumns = Number(bar.dataset.ganttSpanColumns);
    const targetRowIndex = Number(targetRow.dataset.ganttRowIndex);

    track.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 420,
      height: 40,
      top: 0,
      right: 420,
      bottom: 40,
      left: 0,
      toJSON: () => ({}),
    });

    const drag = mounted.harness.pointerDown(
      'timekeeping-gantt-task-urgent',
      { clientX: 100, clientY: 100 },
    );

    expect(bar.dataset.ganttPickup).toBe('true');
    expect(mounted.timelineIntents()).toHaveLength(0);

    drag.move(
      'timekeeping-gantt-row-later',
      { clientX: 130, clientY: 150 },
    );

    expect(bar.dataset.ganttPreviewStartColumn)
      .toBe(String(originalStartColumn + 3));
    expect(bar.dataset.ganttPreviewSpanColumns)
      .toBe(String(originalSpanColumns));
    expect(bar.dataset.ganttPreviewRowIndex)
      .toBe(String(targetRowIndex));
    expect(row.style.transform).toBe('translateY(50px)');
    expect(targetRow.dataset.ganttRowTarget).toBe('true');
    expect(proposal.textContent).toContain('Proposed:');
    expect(proposal.textContent).toContain('2026-09-08');
    expect(proposal.textContent).toContain('2026-09-09');
    expect(mounted.timelineIntents()).toHaveLength(0);

    drag.release(
      'timekeeping-gantt-row-later',
      { clientX: 130, clientY: 150 },
    );

    expect(mounted.timelineIntents()).toHaveLength(1);
    expect(mounted.timelineResults()).toHaveLength(1);

    const intent = mounted.timelineIntents()[0];
    const result = mounted.timelineResults()[0];

    if (!intent || !result) {
      throw new Error('timeline move did not emit its one release result');
    }

    expect(intent).toMatchObject({
      taskId: 'urgent',
      operation: 'move',
      targetRowIndex,
    });
    expect(localDateKey(intent.proposedStartDate!)).toBe('2026-09-08');
    expect(localDateKey(intent.proposedDeadline!)).toBe('2026-09-09');
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'action-not-available' },
    });

    expect(bar.style.gridColumn).toBe(originalGridColumn);
    expect(row.style.transform).toBe('');
    expect(targetRow.dataset.ganttRowTarget).toBeUndefined();
    expect(bar.dataset.ganttPickup).toBeUndefined();
    expect(bar.dataset.ganttRefusal).toBe('action-not-available');
    expect(proposal.textContent).toBe('action-not-available');
    expect(JSON.stringify(dispatcher.snapshot().state)).toBe(beforeRecords);
  });

  it('distinguishes Shift start-edge and end-edge resize geometry and refuses inverted preview', () => {
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    mounted.harness.click('timekeeping-panel-toggle-timeline');
    mounted.harness.click('timekeeping-panel-toggle-calendar');

    const bar = mounted.harness.target('timekeeping-gantt-task-urgent');
    const row = mounted.harness.target('timekeeping-gantt-row-urgent');
    const track = mounted.harness.target('timekeeping-gantt-track-urgent');
    const startEdge = mounted.harness.target(
      'timekeeping-gantt-edge-start-urgent',
    );
    const endEdge = mounted.harness.target(
      'timekeeping-gantt-edge-end-urgent',
    );
    const originalStartColumn = Number(bar.dataset.ganttStartColumn);
    const originalSpanColumns = Number(bar.dataset.ganttSpanColumns);

    track.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 420,
      height: 40,
      top: 0,
      right: 420,
      bottom: 40,
      left: 0,
      toJSON: () => ({}),
    });

    mounted.harness.hover(
      'timekeeping-gantt-edge-start-urgent',
      { clientX: 100, clientY: 100 },
      { shiftKey: true },
    );
    mounted.harness.hover(
      'timekeeping-gantt-edge-end-urgent',
      { clientX: 120, clientY: 100 },
      { shiftKey: true },
    );

    expect(startEdge.style.cursor).toBe('col-resize');
    expect(endEdge.style.cursor).toBe('col-resize');
    expect(startEdge.style.width).toBe('8px');
    expect(endEdge.style.width).toBe('8px');
    expect(startEdge.style.borderLeftWidth).toBe('2px');
    expect(endEdge.style.borderRightWidth).toBe('2px');

    const startResize = mounted.harness.beginResize(
      'timekeeping-gantt-edge-start-urgent',
      { clientX: 100, clientY: 100 },
      { shiftKey: true },
    );

    startResize.move(
      'timekeeping-gantt-row-urgent',
      { clientX: 110, clientY: 100 },
      { shiftKey: true },
    );

    expect(bar.dataset.ganttPreviewStartColumn)
      .toBe(String(originalStartColumn + 1));
    expect(bar.dataset.ganttPreviewSpanColumns)
      .toBe(String(originalSpanColumns - 1));
    expect(localDateKey(bar.dataset.ganttProposedStart!))
      .toBe('2026-09-06');
    expect(localDateKey(bar.dataset.ganttProposedDeadline!))
      .toBe('2026-09-06');

    startResize.release(
      'timekeeping-gantt-row-urgent',
      { clientX: 110, clientY: 100 },
      { shiftKey: true },
    );

    const startIntent = mounted.timelineIntents()[0];
    if (!startIntent) {
      throw new Error('start-edge resize did not emit on release');
    }

    expect(startIntent.operation).toBe('resize-start');
    expect(localDateKey(startIntent.proposedStartDate!)).toBe('2026-09-06');
    expect(localDateKey(startIntent.proposedDeadline!)).toBe('2026-09-06');

    const endResize = mounted.harness.beginResize(
      'timekeeping-gantt-edge-end-urgent',
      { clientX: 100, clientY: 100 },
      { shiftKey: true },
    );

    endResize.move(
      'timekeeping-gantt-row-urgent',
      { clientX: 120, clientY: 100 },
      { shiftKey: true },
    );

    expect(bar.dataset.ganttPreviewStartColumn)
      .toBe(String(originalStartColumn));
    expect(bar.dataset.ganttPreviewSpanColumns)
      .toBe(String(originalSpanColumns + 2));
    expect(localDateKey(bar.dataset.ganttProposedStart!))
      .toBe('2026-09-05');
    expect(localDateKey(bar.dataset.ganttProposedDeadline!))
      .toBe('2026-09-08');

    endResize.release(
      'timekeeping-gantt-row-urgent',
      { clientX: 120, clientY: 100 },
      { shiftKey: true },
    );

    const endIntent = mounted.timelineIntents()[1];
    if (!endIntent) {
      throw new Error('end-edge resize did not emit on release');
    }

    expect(endIntent.operation).toBe('resize-end');
    expect(localDateKey(endIntent.proposedStartDate!)).toBe('2026-09-05');
    expect(localDateKey(endIntent.proposedDeadline!)).toBe('2026-09-08');

    const intentsBeforeInvalid = mounted.timelineIntents().length;
    const invalidResize = mounted.harness.beginResize(
      'timekeeping-gantt-edge-start-urgent',
      { clientX: 100, clientY: 100 },
      { shiftKey: true },
    );

    invalidResize.move(
      'timekeeping-gantt-row-urgent',
      { clientX: 130, clientY: 100 },
      { shiftKey: true },
    );

    expect(bar.dataset.ganttInvalid).toBe('true');
    expect(bar.dataset.ganttPreviewSpanColumns).toBeUndefined();

    invalidResize.release(
      'timekeeping-gantt-row-urgent',
      { clientX: 130, clientY: 100 },
      { shiftKey: true },
    );

    expect(mounted.timelineIntents()).toHaveLength(intentsBeforeInvalid);
    expect(bar.dataset.ganttInvalid).toBeUndefined();
    expect(bar.style.gridColumn)
      .toBe(`${originalStartColumn} / span ${originalSpanColumns}`);
    expect(row.style.transform).toBe('');
  });

  it('renders all five countdown buckets and moves items automatically as the injected clock advances', () => {
    vi.useFakeTimers();

    try {
      const currentNow = { value: NOW };
      const dispatcher = createDispatcher();
      const mounted = mount(dispatcher, () => currentNow.value);

      mounted.harness.click('timekeeping-panel-toggle-countdowns');

      const initialProjection = countdownProjection(state.tasks, currentNow.value);

      expect(
        initialProjection.find((entry) => entry.taskId === 'overdue')?.bucket,
      ).toBe('overdue');
      expect(
        initialProjection.find((entry) => entry.taskId === 'urgent')?.bucket,
      ).toBe('under-one-day');
      expect(
        initialProjection.find(
          (entry) => entry.taskId === 'under-three-days',
        )?.bucket,
      ).toBe('under-three-days');
      expect(
        initialProjection.find(
          (entry) => entry.taskId === 'under-one-week',
        )?.bucket,
      ).toBe('under-one-week');
      expect(
        initialProjection.find((entry) => entry.taskId === 'later')?.bucket,
      ).toBe('later');

      expect(
        initialProjection.some((entry) => entry.taskId === 'start-only'),
      ).toBe(false);
      expect(
        initialProjection.some((entry) => entry.taskId === 'no-deadline'),
      ).toBe(false);

      for (const bucket of [
        'overdue',
        'under-one-day',
        'under-three-days',
        'under-one-week',
        'later',
      ]) {
        expect(
          mounted.harness.target(`timekeeping-countdown-bucket-${bucket}`),
        ).toBeInstanceOf(HTMLElement);
      }

      const urgentBefore = mounted.harness
        .target('timekeeping-countdown-value-urgent')
        .textContent;

      const stopTicker = startTimekeepingCountdownTicker(
        mounted.root,
        mounted.render,
      );

      try {
        currentNow.value = new Date(
          NOW.getTime() + 30 * 60 * 60 * 1_000,
        );

        vi.advanceTimersByTime(1_000);

        const urgentCard = mounted.harness.target(
          'timekeeping-countdown-task-urgent',
        );
        const underThreeCard = mounted.harness.target(
          'timekeeping-countdown-task-under-three-days',
        );
        const underWeekCard = mounted.harness.target(
          'timekeeping-countdown-task-under-one-week',
        );

        expect(
          urgentCard.closest<HTMLElement>('[data-countdown-bucket]')
            ?.dataset.countdownBucket,
        ).toBe('overdue');
        expect(
          underThreeCard.closest<HTMLElement>('[data-countdown-bucket]')
            ?.dataset.countdownBucket,
        ).toBe('under-one-day');
        expect(
          underWeekCard.closest<HTMLElement>('[data-countdown-bucket]')
            ?.dataset.countdownBucket,
        ).toBe('under-three-days');

        expect(
          mounted.harness.target('timekeeping-countdown-value-urgent')
            .textContent,
        ).not.toBe(urgentBefore);
      } finally {
        stopTicker();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the existing task editor from a countdown item without writing records', () => {
    const beforeRecords = JSON.stringify(state);
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    mounted.harness.click('timekeeping-panel-toggle-countdowns');
    mounted.harness.click('timekeeping-countdown-task-urgent');

    expect(mounted.selectedTaskId()).toBe('urgent');
    expect(mounted.harness.target('elastic-task-modal'))
      .toBeInstanceOf(HTMLElement);

    mounted.harness.click('elastic-task-modal-close');

    expect(mounted.selectedTaskId()).toBeNull();
    expect(JSON.stringify(dispatcher.snapshot().state)).toBe(beforeRecords);
  });

  it('observes the same task simultaneously in every Timekeeping panel where its temporal data applies', () => {
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    mounted.harness.click('timekeeping-panel-toggle-timeline');
    mounted.harness.click('timekeeping-panel-toggle-countdowns');

    expect(mounted.harness.target('timekeeping-calendar-task-urgent'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-gantt-task-urgent'))
      .toBeInstanceOf(HTMLElement);
    expect(mounted.harness.target('timekeeping-countdown-task-urgent'))
      .toBeInstanceOf(HTMLElement);

    expect(mounted.harness.target('timekeeping-gantt-task-start-only'))
      .toBeInstanceOf(HTMLElement);
    expect(() => mounted.harness.target('timekeeping-calendar-task-start-only'))
      .toThrow();
    expect(() => mounted.harness.target('timekeeping-countdown-task-start-only'))
      .toThrow();

    expect(() => mounted.harness.target('timekeeping-calendar-task-no-deadline'))
      .toThrow();
    expect(() => mounted.harness.target('timekeeping-gantt-task-no-deadline'))
      .toThrow();
    expect(() => mounted.harness.target('timekeeping-countdown-task-no-deadline'))
      .toThrow();
  });

  it('keeps durable state byte-identical when the injected clock alone advances', () => {
    vi.useFakeTimers();

    try {
      const currentNow = { value: NOW };
      const dispatcher = createDispatcher();

      document.body.innerHTML = '<div id="clock-only-root"></div>';
      const root = document.querySelector<HTMLElement>('#clock-only-root')!;

      const render = () => {
        const snapshot = dispatcher.snapshot();

        root.innerHTML = renderTimekeepingCockpit({
          state: snapshot.state,
          tasks: snapshot.state.tasks,
          projectNames: new Map(),
          selectionLabel: 'All projects',
          panels: {
            calendar: false,
            timeline: false,
            countdowns: true,
          },
          calendarCursor: new Date(`${snapshot.calendarMonth}T00:00:00`),
          now: currentNow.value,
          selectedTaskId: null,
          editorDraft: null,
        });
      };

      render();

      const harness = createInteractionHarness(root);
      const beforeHash = durableStateHash(dispatcher.snapshot().state);
      const beforeCountdown = harness
        .target('timekeeping-countdown-value-urgent')
        .textContent;

      const stopTicker = startTimekeepingCountdownTicker(root, render);

      try {
        currentNow.value = new Date(
          NOW.getTime() + 30 * 60 * 60 * 1_000,
        );

        vi.advanceTimersByTime(1_000);

        const afterCountdown = harness
          .target('timekeeping-countdown-value-urgent')
          .textContent;
        const afterHash = durableStateHash(dispatcher.snapshot().state);

        expect(afterCountdown).not.toBe(beforeCountdown);
        expect(
          harness
            .target('timekeeping-countdown-task-urgent')
            .closest<HTMLElement>('[data-countdown-bucket]')
            ?.dataset.countdownBucket,
        ).toBe('overdue');
        expect(afterHash).toBe(beforeHash);
      } finally {
        stopTicker();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('styles deadline pressure and overdue state and opens the existing task modal', () => {
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    const overdueCard = mounted.harness.target(
      'timekeeping-calendar-task-overdue',
    );
    const urgentCard = mounted.harness.target(
      'timekeeping-calendar-task-urgent',
    );
    const laterCard = mounted.harness.target(
      'timekeeping-calendar-task-later',
    );

    expect(overdueCard.dataset.deadlineOverdue).toBe('true');
    expect(overdueCard.classList.contains('task-overdue')).toBe(true);
    expect(overdueCard.getAttribute('style')).toContain('background-color');
    expect(urgentCard.getAttribute('style')).toContain('background-color');
    expect(laterCard.getAttribute('style')).toContain('background-color');
    expect(urgentCard.getAttribute('style')).not.toBe(
      laterCard.getAttribute('style'),
    );

    mounted.harness.click('timekeeping-calendar-task-urgent');

    expect(mounted.selectedTaskId()).toBe('urgent');
    expect(mounted.harness.target('elastic-task-modal'))
      .toBeInstanceOf(HTMLElement);

    mounted.harness.click('elastic-task-modal-close');

    expect(mounted.selectedTaskId()).toBeNull();
    expect(() => mounted.harness.target('elastic-task-modal')).toThrow();
  });

  it('fixture reset destroys panel composition while records remain unchanged', () => {
    const beforeRecords = JSON.stringify(state);
    const dispatcher = createDispatcher();
    const mounted = mount(dispatcher);

    mounted.harness.click('timekeeping-panel-toggle-timeline');
    mounted.harness.click('timekeeping-panel-toggle-countdowns');
    mounted.harness.click('timekeeping-panel-toggle-calendar');

    expect(dispatcher.snapshot().timekeepingPanels).toEqual({
      calendar: false,
      timeline: true,
      countdowns: true,
    });

    expect(dispatcher.dispatch({ type: 'fixture.reset' })).toMatchObject({
      ok: true,
      category: 'local-state',
    });

    expect(dispatcher.snapshot().timekeepingPanels).toEqual({
      calendar: true,
      timeline: false,
      countdowns: false,
    });

    expect(JSON.stringify(dispatcher.snapshot().state)).toBe(beforeRecords);
  });
});
