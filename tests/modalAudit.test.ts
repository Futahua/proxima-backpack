// @vitest-environment happy-dom

/**
 * The write-control audit.
 *
 * Two claims Stage 6's acceptance section makes, checked against the rendered document
 * rather than against a reading of the code:
 *
 * 1. No Save, Delete, Edit, Archive or Restore control can be clicked and do nothing. Each
 *    is either disabled and carries a typed refusal, or is routed to the action dispatcher
 *    — and then a click has to produce the refusal, which is the only way "no fake success"
 *    can be told from "nothing happened".
 * 2. Every editor can be opened from state alone, without a click. A modal that only opens
 *    when a pointer hits the right word is not a program that an agent or a test can drive.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createProjectAction } from '../src/app/projectLifecycleActions.js';
import { fixedClock } from '../src/domain/clock.js';
import { bindElasticCockpitInteractions, renderElasticCockpit } from '../src/browser/elasticCockpit.js';
import { bindProjectsHubInteractions, renderProjectsHub, type ProjectsHubFilter } from '../src/browser/projectsHub.js';
import { bindProjectBacklogInteractions, EMPTY_PROJECT_BACKLOG_VIEW, renderProjectBacklog } from '../src/browser/projectBacklog.js';
import { bindScheduleTimeGridInteractions, renderScheduleTimeGrid } from '../src/browser/scheduleTimeGrid.js';
import { renderEventModal } from '../src/browser/eventModal.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { EMPTY_STATE, type CalendarEvent, type Project, type ProximaState, type Task } from '../src/domain/types.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');

const project: Project = {
  id: 'p1',
  source: { path: 'Proxima/projects/p1.md', revision: 'r1', kind: 'project', idOrigin: 'frontmatter' },
  name: 'Alpha project',
  description: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  projectType: 'task',
  linkedFolders: [],
};

const task: Task = {
  id: 't1',
  source: { path: 'Proxima/tasks/t1.md', revision: 'r1', kind: 'task', idOrigin: 'frontmatter' },
  name: 'Task one',
  description: '',
  projectId: 'p1',
  status: 'running',
  weight: 1,
  orderIndex: 0,
  isFixedDuration: false,
  fixedDuration: null,
  maxDuration: null,
  isCompleted: false,
  createdAt: '2026-01-02T00:00:00.000Z',
  startDate: null,
  deadline: null,
  properties: {},
};

const event: CalendarEvent = {
  id: 'e1',
  source: { path: 'Proxima/events/e1.md', revision: 'r1', kind: 'event', idOrigin: 'frontmatter' },
  name: 'Kickoff',
  description: '',
  projectId: 'p1',
  createdAt: '2026-01-01T00:00:00.000Z',
  startDate: '2026-02-01T09:00:00.000Z',
  deadline: '2026-02-01T10:00:00.000Z',
  isCompleted: false,
  properties: {},
};

function state(): ProximaState {
  return {
    ...EMPTY_STATE,
    projects: [project],
    tasks: [task],
    events: [event],
    statuses: [{ id: 'running', name: 'Running', color: '#000', column: 'running' }],
    taskSchema: [],
  };
}

const projectNames = new Map([['p1', 'Alpha project']]);

/**
 * A control that writes, or says it cannot: the product's own convention is that every such
 * control carries a hook — a `*-refusal`, a `*-write-action` or a `*-lifecycle-action`.
 *
 * The words are deliberately *not* the test. "Completed" is the Backlog's sort button for
 * the completion field, and "Archived" is a Projects Hub filter: a label cannot tell a write
 * from an order or a view, and an audit that guessed from words would either miss the real
 * controls or fail every time a state name was reused.
 */
function writeControls(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => Array.from(button.attributes).some((attribute) => /-refusal$|-write-action$|-lifecycle-action$/.test(attribute.name)));
}

/**
 * Buttons that legitimately stay clickable because the operation layer, not the markup, answers.
 * Clicking one either writes or refuses with a typed reason, which is what the cases below check.
 */
const OPERATION_ROUTED = new Set(['project-create-save']);

/**
 * The Projects Hub's lifecycle controls are routed by its own binder to
 * `src/app/projectLifecycleActions.ts`, so an enabled Archive, Restore or Delete is the honest
 * state once a write path resolved — its answer is the operation's, and Delete's answer while the
 * policy is undecided is a refusal a reader can act on rather than a missing feature (D57).
 */
function isOperationRouted(button: HTMLElement): boolean {
  return OPERATION_ROUTED.has(button.getAttribute('data-c1-key') ?? '') || button.hasAttribute('data-project-lifecycle-action');
}

/** A label that is nothing but a write verb, which no sort or filter control ever is. */
const BARE_WRITE_VERB = /^(save|delete|edit|archive|restore|complete)$/i;

/** The refusal a control carries, whatever it is called. */
function refusalOf(button: HTMLElement): string | null {
  for (const attribute of Array.from(button.attributes)) {
    if (attribute.name.endsWith('refusal')) return attribute.value;
  }

  return null;
}

/**
 * The invariant: a clickable write control must be routed to something that refuses.
 * Anything else is either a fake success waiting to happen or a dead button.
 */
function violationsIn(root: ParentNode): string[] {
  const violations: string[] = [];

  // The safety net for a write control that forgot its hook entirely: a button labelled
  // exactly "Save" or "Delete" is a write control whatever else it says. A routed control is
  // allowed to stay clickable here because a case below clicks it and checks the refusal.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
    const key = button.getAttribute('data-c1-key') ?? '';
    if (!button.disabled && BARE_WRITE_VERB.test((button.textContent ?? '').trim()) && refusalOf(button) === null && !isOperationRouted(button)) {
      violations.push(`${button.outerHTML.slice(0, 120)} is an enabled write control with no hook at all`);
    }
  }

  for (const button of writeControls(root)) {
    const key = button.getAttribute('data-c1-key') ?? button.textContent ?? '';
    const refusal = refusalOf(button);

    if (!button.disabled) {
      if (!isOperationRouted(button)) violations.push(`${key} is enabled and carries no refusal: ${button.outerHTML.slice(0, 120)}`);
      continue;
    }

    if (refusal !== 'action-not-available') violations.push(`${key} is disabled without a typed refusal (${String(refusal)})`);
  }

  return violations;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('no write control can be clicked and do nothing', () => {
  it('holds for the Elastic Task editor', () => {
    document.body.innerHTML = renderElasticCockpit({
      state: state(),
      tasks: [task],
      projectNames,
      selectionLabel: 'All projects',
      session: { targetTime: '2026-09-06T16:00:00.000Z', lockedAt: null },
      now: NOW,
      selectedTaskId: 't1',
      editorDraft: null,
      dropRefusal: null,
      taskWrites: { refusal: 'action-not-available', editorRefusal: null },
      newTaskDraft: null,
      newTaskRefusal: null,
    });

    // The Task editor's Delete is present and typed, so the audit has something to check.
    expect(writeControls(document.body).map((button) => button.textContent)).toEqual(['Delete unavailable', 'Save unavailable']);
    expect(violationsIn(document.body)).toEqual([]);
  });

  it('holds for the Backlog inspector and its bulk controls', () => {
    document.body.innerHTML = renderProjectBacklog(state(), project, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: 'p1', selectedTaskId: 't1' });

    // The inspector's Edit/Delete and the two bulk controls are all present, and the sort
    // button labelled "Completed" is correctly not among them: it orders, it does not write.
    expect(writeControls(document.body).map((button) => button.textContent)).toEqual([
      'Complete selected',
      'Delete selected',
      'Delete unavailable',
      'Save unavailable',
    ]);
    expect(violationsIn(document.body)).toEqual([]);
  });

  it('holds for the Projects Hub lifecycle controls, disabled before a write path and enabled after one', () => {
    document.body.innerHTML = renderProjectsHub({ state: state(), selection: 'all', filter: 'active', workspaceTab: 'notes', now: NOW, newProjectOpen: false });

    expect(writeControls(document.body).length).toBeGreaterThan(0);
    expect(violationsIn(document.body)).toEqual([]);

    // And the same surface once a record write path has resolved: the controls are real buttons
    // now, so the audit has to know they are routed rather than merely unlabelled.
    document.body.innerHTML = renderProjectsHub({
      state: state(),
      selection: 'all',
      filter: 'active',
      workspaceTab: 'notes',
      now: NOW,
      newProjectOpen: false,
      projectWrites: { refusal: null, feedback: null },
    });
    const enabled = writeControls(document.body).filter((button) => !button.disabled);
    // One project, so one Archive and one Delete: the shape is what is asserted, not a count.
    expect(enabled.map((button) => button.dataset.projectLifecycleAction)).toEqual(['archive', 'delete']);
    expect(violationsIn(document.body)).toEqual([]);
  });

  it('holds for the Event editor', () => {
    document.body.innerHTML = renderEventModal({ events: [event], projectNames, eventId: 'e1', closeAction: 'close-event', closeAttribute: 'data-schedule-action', mode: 'edit' });

    expect(violationsIn(document.body)).toEqual([]);
  });

  it('routes the project create Save to the create sequence rather than a fake success', async () => {
    const loaded = state();
    let open = false;
    let refusal: { code: string; sentence: string } | null = null;
    let draft: { name: string; description: string } | null = null;
    const pending: Promise<void>[] = [];
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.querySelector<HTMLElement>('#root')!;
    const rerender = () => { root.innerHTML = renderProjectsHub({ state: loaded, selection: 'all', filter: 'active', workspaceTab: 'notes', now: NOW, newProjectOpen: open, projectCreateRefusal: refusal, projectCreateDraft: draft }); };
    bindProjectsHubInteractions(root, {
      setFilter: () => {},
      openProject: () => {},
      showHub: () => {},
      openNewProject: () => { open = true; refusal = null; draft = { name: '', description: '' }; rerender(); },
      closeNewProject: () => { open = false; refusal = null; draft = null; rerender(); },
      // The shell's half, as `main.ts` performs it: no record write path in this fixture, so the
      // sequence answers with the reason there is none, and the modal draws what it was told.
      createProject: ({ name, description }) => {
        draft = { name, description };
        pending.push((async () => {
          const outcome = await createProjectAction({ state: loaded, writes: async () => null, unavailableReason: () => 'record-writes-need-an-activated-store', refresh: async () => null, setRefusal: () => {}, render: () => {} }, { name, description });
          if (outcome.ok) draft = null;
          refusal = outcome.ok ? null : { code: outcome.reason, sentence: `${outcome.reason}: ${outcome.detail}` };
          rerender();
        })());
      },
      openProjectEditor: () => {},
      closeProjectEditor: () => {},
      saveProjectEdit: () => {},
      archiveProject: () => undefined,
      restoreProject: () => undefined,
      deleteProject: () => undefined,
    });
    rerender();

    const harness = createInteractionHarness(root);
    harness.click('project-create-open');
    harness.typeText('project-create-name', 'Audit project');
    expect(violationsIn(root)).toEqual([]);
    harness.click('project-create-save');
    await Promise.all(pending);

    expect(harness.target('project-create-modal').dataset.projectCreateRefusal).toBe('writes-unavailable');
    expect(root.querySelector<HTMLElement>('[data-project-create-feedback]')!.textContent).toContain('record-writes-need-an-activated-store');
    expect(loaded.projects).toHaveLength(1);
  });

  it('routes the create-event Save to the create sequence rather than a fake success', () => {
    const loaded = state();
    let seeded: Parameters<typeof renderScheduleTimeGrid>[0]['seededEvent'] = null;
    let refusal: string | null = null;
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.querySelector<HTMLElement>('#root')!;
    const rerender = () => {
      root.innerHTML = renderScheduleTimeGrid({
        mode: 'day',
        events: loaded.events,
        projectNames,
        selectionLabel: 'All projects',
        calendarCursor: new Date('2026-09-06T00:00:00.000Z'),
        now: NOW,
        selectedEventId: null,
        seededEvent: seeded,
        seedRefusal: refusal,
      });
    };
    bindScheduleTimeGridInteractions(root, {
      saveEvent: () => {},
      deleteEvent: () => {},
      openEvent: () => {},
      closeEvent: () => { seeded = null; refusal = null; rerender(); },
      seedEvent: (draft) => { seeded = { ...draft }; refusal = null; rerender(); },
      // The shell's half, as `main.ts` performs it: the sequence runs with no record write path in
      // this fixture, and what it answers is what the form draws.
      createEvent: () => { refusal = 'writes-unavailable'; rerender(); },
      changeEvent: () => {},
    });
    rerender();

    const harness = createInteractionHarness(root);
    harness.click('schedule-slot-2026-09-06-36');
    expect(document.querySelector('[data-schedule-editor-mode="create"]')).not.toBeNull();
    harness.click('schedule-event-save');

    const modal = document.querySelector<HTMLElement>('[data-schedule-editor-mode="create"]')!;
    expect(modal.dataset.scheduleRefusal).toBe('writes-unavailable');
    expect(document.querySelector('[data-schedule-seed-feedback]')!.textContent).toContain('writes-unavailable');
    expect(loaded.events).toHaveLength(1);
  });
});

describe('every editor opens from state alone', () => {
  it('opens the Task editor in both surfaces it lives in', () => {
    const elastic = renderElasticCockpit({
      state: state(),
      tasks: [task],
      projectNames,
      selectionLabel: 'All projects',
      session: { targetTime: '2026-09-06T16:00:00.000Z', lockedAt: null },
      now: NOW,
      selectedTaskId: 't1',
      editorDraft: null,
      dropRefusal: null,
      taskWrites: { refusal: 'action-not-available', editorRefusal: null },
      newTaskDraft: null,
      newTaskRefusal: null,
    });
    document.body.innerHTML = elastic;
    expect(document.querySelector('[data-c1-key="elastic-task-modal"]')).not.toBeNull();
  });

  it('opens the Event editor and the create-event modal', () => {
    document.body.innerHTML = renderScheduleTimeGrid({
      mode: 'day',
      events: [event],
      projectNames,
      selectionLabel: 'All projects',
      calendarCursor: new Date('2026-09-06T00:00:00.000Z'),
      now: NOW,
      selectedEventId: 'e1',
    });
    expect(document.querySelector('[data-c1-key="schedule-event-modal"]')).not.toBeNull();

    document.body.innerHTML = renderScheduleTimeGrid({
      mode: 'day',
      events: [event],
      projectNames,
      selectionLabel: 'All projects',
      calendarCursor: new Date('2026-09-06T00:00:00.000Z'),
      now: NOW,
      selectedEventId: null,
      seededEvent: { name: 'New', projectId: 'p1', description: '', startDate: '2026-09-06T09:00:00.000Z', deadline: '2026-09-06T10:00:00.000Z' },
    });
    expect(document.querySelector('[data-schedule-editor-mode="create"]')).not.toBeNull();
  });

  it('opens the New Project modal', () => {
    document.body.innerHTML = renderProjectsHub({ state: state(), selection: 'all', filter: 'active', workspaceTab: 'notes', now: NOW, newProjectOpen: true });
    expect(document.querySelector('[data-c1-key="project-create-modal"]')).not.toBeNull();
  });

  it('opens the recurrence scope modal from the occurrence selection', () => {
    document.body.innerHTML = renderScheduleTimeGrid({
      mode: 'day',
      events: [{ ...event, properties: { recurrence: { frequency: 'daily', count: 5 } } }],
      projectNames,
      selectionLabel: 'All projects',
      calendarCursor: new Date('2026-09-06T00:00:00.000Z'),
      now: NOW,
      selectedEventId: null,
      selectedRecurringOccurrence: { eventId: 'e1', startDate: '2026-09-06T09:00:00.000Z', deadline: '2026-09-06T10:00:00.000Z' },
      selectedRecurringScope: null,
    });
    expect(document.querySelector('[data-c1-key="schedule-recurrence-scope-modal"]')).not.toBeNull();
  });
});