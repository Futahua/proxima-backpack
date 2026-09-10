// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createActionDispatcher,
  type ProximaActionDispatcher,
} from '../src/app/actionProtocol.js';
import {
  bindElasticCockpitInteractions,
} from '../src/browser/elasticCockpit.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  bindTimekeepingCockpitInteractions,
  deadlineCalendarProjection,
  renderTimekeepingCockpit,
} from '../src/browser/timekeepingCockpit.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { localDateKey } from '../src/domain/time.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

const NOW = new Date(2026, 8, 6, 12, 0, 0, 0);

function afterHours(hours: number): string {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function task(id: string, deadline: string | null): Task {
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
    startDate: null,
    deadline,
    properties: {},
  };
}

const overdue = task('overdue', afterHours(-24));
const urgent = task('urgent', afterHours(6));
const later = task('later', afterHours(24 * 14));
const noDeadline = task('no-deadline', null);

const state: ProximaState = {
  projects: [],
  tasks: [
    overdue,
    urgent,
    later,
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

function mount(dispatcher: ProximaActionDispatcher) {
  document.body.innerHTML = '<div id="timekeeping-root"></div>';
  const root = document.querySelector<HTMLElement>('#timekeeping-root')!;
  let selectedTaskId: string | null = null;

  const render = () => {
    const snapshot = dispatcher.snapshot();

    root.innerHTML = renderTimekeepingCockpit({
      state: snapshot.state,
      tasks: snapshot.state.tasks,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      panels: snapshot.timekeepingPanels,
      calendarCursor: new Date(`${snapshot.calendarMonth}T00:00:00`),
      now: NOW,
      selectedTaskId,
    });
  };

  bindTimekeepingCockpitInteractions(root, {
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
  });

  render();

  return {
    harness: createInteractionHarness(root),
    render,
    selectedTaskId: () => selectedTaskId,
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
      'later',
    ]);

    for (const item of [overdue, urgent, later]) {
      expect(
        projection.find((entry) => entry.taskId === item.id)?.dayKey,
      ).toBe(localDateKey(item.deadline!));
    }

    expect(
      projection.some((entry) => entry.taskId === noDeadline.id),
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
