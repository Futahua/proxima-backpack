// @vitest-environment happy-dom
//
// Stage 19's claim is that the cockpit behaves as one system rather than as a collection of
// independently updated surfaces. Nothing can write a record yet, so the change a surface has
// to notice can only arrive through the source — which is exactly what an external editor or
// another program does to the vault. This file edits the vault behind an open cockpit, reloads
// it the way the application does, and then asks every surface what it shows. A surface that
// kept its own copy, or that only picked the change up when its own tab was rebuilt, fails
// here.
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { toggleBacklogSelection } from '../src/app/backlogControls.js';
import { projectBacklog } from '../src/app/backlogView.js';
import { projectEventEditor } from '../src/app/eventEditor.js';
import { projectTaskEditor } from '../src/app/taskEditor.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { localCalendarDate } from '../src/browser/calendarGrid.js';
import { EMPTY_BACKLOG_QUERY } from '../src/domain/backlogQuery.js';
import { renderElasticCockpit } from '../src/browser/elasticCockpit.js';
import { eventEditorInputFor, eventRecurrenceFor } from '../src/browser/eventModal.js';
import { EMPTY_PROJECT_BACKLOG_VIEW, renderProjectBacklog } from '../src/browser/projectBacklog.js';
import { EMPTY_PROJECT_DEADLINES_VIEW, renderProjectDeadlines } from '../src/browser/projectDeadlines.js';
import { renderProjectTaskBoard } from '../src/browser/projectTaskBoard.js';
import { renderProjectsHub } from '../src/browser/projectsHub.js';
import { renderScheduleProjection } from '../src/browser/scheduleProjection.js';
import { renderScheduleTimeGrid } from '../src/browser/scheduleTimeGrid.js';
import {
  countdownProjection,
  deadlineCalendarProjection,
  timelineGanttProjection,
} from '../src/browser/timekeepingCockpit.js';
import { localDateKey } from '../src/domain/time.js';
import type { CalendarEvent, ProximaState } from '../src/domain/types.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const CURSOR = localCalendarDate(2026, 8, 6);
const SESSION = { targetTime: '2026-09-06T16:00:00.000Z', lockedAt: null };
const PROJECT_ID = 'converge-project';

const ALPHA_EARLY = '2026-09-20T09:00:00.000Z';
const ALPHA_LATE = '2026-09-25T09:00:00.000Z';
const BETA = '2026-09-22T09:00:00.000Z';
const EVENT_BEFORE = '2026-09-06T10:00:00.000Z';
const EVENT_AFTER = '2026-09-06T14:00:00.000Z';

function projectFile(): string {
  return [
    '---',
    `id: ${PROJECT_ID}`,
    'name: Convergence',
    'status: active',
    'createdAt: 2026-08-01T00:00:00.000Z',
    '---',
    'One project, two tasks, one event.',
    '',
  ].join('\n');
}

function taskFile(id: string, name: string, deadline: string, status = 'backlog'): string {
  return [
    '---',
    `id: ${id}`,
    `name: ${name}`,
    `project: ${PROJECT_ID}`,
    `status: ${status}`,
    'weight: 1',
    'orderIndex: 1',
    'isCompleted: false',
    'createdAt: 2026-08-01T00:00:00.000Z',
    `deadline: ${deadline}`,
    '---',
    `${name} body.`,
    '',
  ].join('\n');
}

function eventFile(startDate: string, name = 'Gate'): string {
  const deadline = new Date(Date.parse(startDate) + 60 * 60 * 1000).toISOString();
  return [
    '---',
    'id: converge-event',
    `name: ${name}`,
    `project: ${PROJECT_ID}`,
    `startDate: ${startDate}`,
    `deadline: ${deadline}`,
    'createdAt: 2026-08-01T00:00:00.000Z',
    '---',
    'A single event, moved once.',
    '',
  ].join('\n');
}

function vaultFiles(alphaDeadline: string, eventStart: string, eventName = 'Gate'): Record<string, string> {
  return {
    'Proxima/projects/Convergence.md': projectFile(),
    'Proxima/tasks/Alpha.md': taskFile('converge-alpha', 'Alpha', alphaDeadline),
    'Proxima/tasks/Beta.md': taskFile('converge-beta', 'Beta', BETA),
    'Proxima/events/Gate.md': eventFile(eventStart, eventName),
  };
}

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function cardDeadline(state: ProximaState, taskId: string): string | null {
  const project = state.projects[0]!;
  const board = mount(renderProjectTaskBoard(state, project));
  return board.querySelector<HTMLElement>(`[data-project-board-task-id="${taskId}"] small`)?.textContent ?? null;
}

function backlogShows(state: ProximaState, value: string): boolean {
  const project = state.projects[0]!;
  return renderProjectBacklog(state, project, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: project.id }).includes(value);
}

function deadlineRow(state: ProximaState, taskId: string): string | null {
  const project = state.projects[0]!;
  const deadlines = mount(renderProjectDeadlines(state, project, NOW, { ...EMPTY_PROJECT_DEADLINES_VIEW, projectId: project.id }));
  return deadlines.querySelector<HTMLElement>(`[data-project-deadline-task-id="${taskId}"]`)?.dataset.projectDeadlineValue ?? null;
}

function hubNextDeadline(state: ProximaState): string | null {
  const hub = mount(renderProjectsHub({ state, selection: 'all', filter: 'active', workspaceTab: 'notes', now: NOW }));
  return hub.querySelector<HTMLElement>(`[data-c1-key="project-hub-card-${PROJECT_ID}"]`)?.dataset.projectNextDeadline ?? null;
}

function elasticColumn(state: ProximaState, taskId: string): string | null {
  mount(renderElasticCockpit({
    state,
    tasks: state.tasks,
    projectNames: new Map(),
    selectionLabel: 'All projects',
    session: SESSION,
    now: NOW,
    selectedTaskId: null,
    editorDraft: null,
    dropRefusal: null,
    taskWrites: { refusal: 'action-not-available', editorRefusal: null },
    containerHeight: 800,
  }));
  return document
    .querySelector<HTMLElement>(`[data-c1-key="elastic-task-${taskId}"]`)
    ?.closest<HTMLElement>('[data-c1-key^="board-column-"]')
    ?.dataset.c1Key ?? null;
}

function editorShows(state: ProximaState, taskId: string, value: string): boolean {
  return JSON.stringify(projectTaskEditor(state, taskId, null)).includes(value);
}

function eventEditorShows(state: ProximaState, eventId: string, value: string): boolean {
  const event = state.events.find((candidate) => candidate.id === eventId) as CalendarEvent;
  return JSON.stringify(projectEventEditor(
    eventEditorInputFor(state.events, new Map<string, string>()),
    eventId,
    null,
    eventRecurrenceFor(event),
  )).includes(value);
}

function scheduleViews(state: ProximaState): Record<string, string> {
  const common = {
    projectNames: new Map<string, string>(),
    selectionLabel: 'All projects',
    calendarCursor: CURSOR,
    now: NOW,
    selectedEventId: null,
  };
  const views: Record<string, string> = {};
  for (const mode of ['day', 'four-day', 'week'] as const) {
    views[mode] = renderScheduleTimeGrid({ ...common, mode, events: [...state.events] });
  }
  for (const mode of ['month', 'year', 'agenda'] as const) {
    views[mode] = renderScheduleProjection({ ...common, mode, events: state.events, problems: [] });
  }
  return views;
}

function scheduleShows(state: ProximaState, value: string): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(scheduleViews(state)).map(([mode, html]) => [mode, html.includes(value)]),
  );
}

/** The instant each time-grid view draws the event's start at, read from the card itself. */
function gridStartValues(state: ProximaState): Record<string, string | undefined> {
  const common = {
    projectNames: new Map<string, string>(),
    selectionLabel: 'All projects',
    calendarCursor: CURSOR,
    now: NOW,
    selectedEventId: null,
  };
  const values: Record<string, string | undefined> = {};
  for (const mode of ['day', 'four-day', 'week'] as const) {
    mount(renderScheduleTimeGrid({ ...common, mode, events: [...state.events] }));
    values[mode] = document
      .querySelector<HTMLElement>('[data-schedule-event-id="converge-event"]')
      ?.dataset.scheduleStartValue;
  }
  return values;
}

function taskSurfaces(state: ProximaState, taskId: string, value: string): Record<string, boolean> {
  return {
    'project Task Board': cardDeadline(state, taskId) === value,
    Backlog: backlogShows(state, value),
    'project Deadlines': deadlineRow(state, taskId) === value,
    'task editor': editorShows(state, taskId, value),
    Countdowns: countdownProjection(state.tasks, NOW).some((entry) => entry.taskId === taskId && entry.deadline === value),
    'deadline Calendar': deadlineCalendarProjection(state.tasks, NOW).some((entry) => entry.taskId === taskId && entry.deadline === value),
    'Timeline/Gantt': timelineGanttProjection(state.tasks, CURSOR, NOW)
      .some((entry) => entry.taskId === taskId && entry.kind === 'deadline' && entry.endKey === localDateKey(new Date(value))),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 19 cross-surface convergence', () => {
  it('shows one record changed at the source in every surface that draws it', async () => {
    const vault = createMemoryVault(vaultFiles(ALPHA_EARLY, EVENT_BEFORE));
    const before = await loadVaultState(vault);
    const beforeSurfaces = taskSurfaces(before.state, 'converge-alpha', ALPHA_EARLY);
    expect(beforeSurfaces).toEqual(Object.fromEntries(Object.keys(beforeSurfaces).map((surface) => [surface, true])));
    expect(hubNextDeadline(before.state)).toBe(ALPHA_EARLY);

    // The peer edit: the same file, two fields — a later deadline and the move from the
    // Elastic Backlog column to Running.
    vault.set('Proxima/tasks/Alpha.md', taskFile('converge-alpha', 'Alpha', ALPHA_LATE, 'running'));
    const after = await loadVaultState(vault);

    expect(after.revisions['Proxima/tasks/Alpha.md']).not.toBe(before.revisions['Proxima/tasks/Alpha.md']);
    const afterSurfaces = taskSurfaces(after.state, 'converge-alpha', ALPHA_LATE);
    expect(afterSurfaces).toEqual(Object.fromEntries(Object.keys(afterSurfaces).map((surface) => [surface, true])));

    // The Elastic cockpit draws no deadline, so its convergence is the column the card is
    // in: the execution state it reads from the same record moved with everything else.
    expect(elasticColumn(before.state, 'converge-alpha')).toBe('board-column-backlog');
    expect(elasticColumn(after.state, 'converge-alpha')).toBe('board-column-running');

    // The old value is gone from the surfaces that draw it, not merely joined by the new one.
    expect(cardDeadline(after.state, 'converge-alpha')).toBe(ALPHA_LATE);
    expect(deadlineRow(after.state, 'converge-alpha')).toBe(ALPHA_LATE);
    expect(backlogShows(after.state, ALPHA_EARLY)).toBe(false);

    // Moving the earliest deadline behind the other task's changes which record the Hub
    // metric reports: the metric converges on the state, it is not a copy of one task.
    expect(hubNextDeadline(after.state)).toBe(BETA);

    // The other record, and the other kind of record, are untouched — in the revision map
    // and in every surface.
    expect(after.revisions['Proxima/tasks/Beta.md']).toBe(before.revisions['Proxima/tasks/Beta.md']);
    expect(after.revisions['Proxima/events/Gate.md']).toBe(before.revisions['Proxima/events/Gate.md']);
    expect(cardDeadline(after.state, 'converge-beta')).toBe(BETA);
    expect(taskSurfaces(after.state, 'converge-beta', BETA)['project Deadlines']).toBe(true);
    expect(taskSurfaces(after.state, 'converge-beta', BETA).Countdowns).toBe(true);
    // The other kind of record did not move with the task: its revision and every view that
    // draws it are what they were.
    expect(scheduleShows(after.state, 'Gate')).toEqual({
      day: true,
      'four-day': true,
      week: true,
      month: true,
      year: false,
      agenda: true,
    });
  });

  it('converges the six Schedule views and the event editor on an event moved at the source', async () => {
    const vault = createMemoryVault(vaultFiles(ALPHA_EARLY, EVENT_BEFORE));
    const before = await loadVaultState(vault);
    expect(scheduleShows(before.state, 'Gate')).toEqual({
      day: true,
      'four-day': true,
      week: true,
      month: true,
      year: false,
      agenda: true,
    });
    expect(gridStartValues(before.state)).toEqual({
      day: EVENT_BEFORE,
      'four-day': EVENT_BEFORE,
      week: EVENT_BEFORE,
    });
    expect(eventEditorShows(before.state, 'converge-event', EVENT_BEFORE)).toBe(true);

    vault.set('Proxima/events/Gate.md', eventFile(EVENT_AFTER, 'Review gate'));
    const after = await loadVaultState(vault);

    expect(after.revisions['Proxima/events/Gate.md']).not.toBe(before.revisions['Proxima/events/Gate.md']);
    // Day, 4-Day and Week draw the event itself; Month draws its occurrence button; Agenda
    // lists it with its own start value; Year draws only a per-date count, so the event's
    // name is nowhere in it and the view is excluded rather than asserted false.
    expect(scheduleShows(after.state, 'Review gate')).toEqual({
      day: true,
      'four-day': true,
      week: true,
      month: true,
      year: false,
      agenda: true,
    });
    expect(scheduleShows(after.state, 'Gate')).toEqual({
      day: false,
      'four-day': false,
      week: false,
      month: false,
      year: false,
      agenda: false,
    });
    expect(gridStartValues(after.state)).toEqual({
      day: EVENT_AFTER,
      'four-day': EVENT_AFTER,
      week: EVENT_AFTER,
    });
    expect(eventEditorShows(after.state, 'converge-event', EVENT_AFTER)).toBe(true);
    expect(eventEditorShows(after.state, 'converge-event', EVENT_BEFORE)).toBe(false);

    mount(renderScheduleTimeGrid({
      mode: 'day',
      events: [...after.state.events],
      projectNames: new Map<string, string>(),
      selectionLabel: 'All projects',
      calendarCursor: CURSOR,
      now: NOW,
      selectedEventId: null,
    }));
    expect(
      document.querySelector<HTMLElement>('[data-schedule-event-id="converge-event"]')
        ?.closest<HTMLElement>('[data-schedule-day]')?.dataset.scheduleDay,
    ).toBe('2026-09-06');
  });

  it('keeps the reader’s own view state local while the data underneath it changes', async () => {
    const vault = createMemoryVault(vaultFiles(ALPHA_EARLY, EVENT_BEFORE));
    const before = await loadVaultState(vault);
    const project = before.state.projects[0]!;
    const view = {
      ...EMPTY_PROJECT_BACKLOG_VIEW,
      projectId: project.id,
      query: { ...EMPTY_BACKLOG_QUERY, search: 'Alpha' },
      selectedTaskIds: toggleBacklogSelection([], 'converge-beta'),
    };

    const beforeProjection = projectBacklog(before.state, project, view);
    expect(beforeProjection.rows.map((row) => row.taskId)).toEqual(['converge-alpha']);
    // Beta is marked but the search hides it, and the projection says so rather than
    // letting the selection cover a row nobody can see.
    expect(beforeProjection.hiddenSelectedCount).toBe(1);

    // The peer renames the hidden task. The reader's query is not a fact about the vault,
    // so it has to survive the change; the data behind it is what moves.
    vault.set('Proxima/tasks/Beta.md', taskFile('converge-beta', 'Beta renamed', BETA));
    const after = await loadVaultState(vault);

    expect(after.revisions['Proxima/tasks/Beta.md']).not.toBe(before.revisions['Proxima/tasks/Beta.md']);
    const afterProjection = projectBacklog(after.state, project, view);
    expect(afterProjection.rows.map((row) => row.taskId)).toEqual(['converge-alpha']);
    expect(afterProjection.hiddenSelectedCount).toBe(1);
    expect(afterProjection.selectedCount).toBe(0);
    const renamed = { ...view, query: { ...view.query, search: 'Beta' } };
    expect(projectBacklog(after.state, project, renamed).rows.map((row) => row.taskId)).toEqual(['converge-beta']);
    expect(renderProjectBacklog(after.state, project, renamed).includes('Beta renamed')).toBe(true);

    // A selection is how this reader is looking at the table: nothing about it reached the
    // vault, whose bytes are the peer's edit and nothing else.
    expect((await vault.read('Proxima/tasks/Beta.md')).text).toBe(taskFile('converge-beta', 'Beta renamed', BETA));
    expect((await vault.read('Proxima/tasks/Alpha.md')).text).toBe(taskFile('converge-alpha', 'Alpha', ALPHA_EARLY));
    expect((await vault.read('Proxima/projects/Convergence.md')).text).toBe(projectFile());
  });
});
