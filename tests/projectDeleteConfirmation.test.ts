// @vitest-environment happy-dom

/**
 * The two-step project delete, at the Hub and at the decision behind it.
 *
 * Deleting a project now removes the records it holds, and the operation verifies the list it is
 * given, so the surface may not submit a delete it did not confirm. These cases are the six things
 * that has to mean: an empty project goes in one press because there is nothing to confirm; a
 * project with members does not submit on the first press; that press captures the ids the hub was
 * displaying; the second press submits exactly those ids; it does not rediscover membership in
 * between; and the held confirmation is gone once it has been submitted, so it cannot be sent twice.
 *
 * The capture and the decision are asserted on `beginProjectDelete` directly, because that is the
 * real function the shell runs, and the two presses are asserted through the real binder and the real
 * renderer with the shell's half performed beside them — the same split every other Hub suite uses.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginProjectDelete,
  bindProjectsHubInteractions,
  renderProjectsHub,
  type ProjectDeleteConfirmation,
} from '../src/browser/projectsHub.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { EMPTY_STATE, type CalendarEvent, type Project, type ProximaState, type Task } from '../src/domain/types.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');

function project(overrides: Partial<Project> & { id: string }): Project {
  return {
    source: { path: `Proxima/projects/${overrides.id}.md`, revision: 'r1', kind: 'project', idOrigin: 'frontmatter' },
    name: overrides.id,
    description: '',
    createdAt: '2026-08-27T12:00:00.000Z',
    status: 'active',
    projectType: 'task',
    linkedFolders: [],
    ...overrides,
  };
}

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    source: { path: `Proxima/tasks/${overrides.id}.md`, revision: 'r1', kind: 'task', idOrigin: 'frontmatter' },
    name: overrides.id,
    description: '',
    projectId: 'alpha',
    status: 'running',
    weight: 1,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-08-27T12:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
    ...overrides,
  };
}

function event(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    source: { path: `Proxima/events/${overrides.id}.md`, revision: 'r1', kind: 'event', idOrigin: 'frontmatter' },
    name: overrides.id,
    description: '',
    projectId: 'alpha',
    createdAt: '2026-08-27T12:00:00.000Z',
    startDate: '2026-09-01T09:00:00.000Z',
    deadline: '2026-09-01T10:00:00.000Z',
    isCompleted: false,
    properties: {},
    ...overrides,
  };
}

/**
 * One project holding what the case needs, and a second project's task and event so a capture that
 * took everything displayed rather than everything belonging to the project would fail here.
 */
function state(projectId: string, members: { tasks: number; events: number }): ProximaState {
  return {
    ...EMPTY_STATE,
    projects: [project({ id: projectId, name: 'Alpha' }), project({ id: 'beta', name: 'Beta' })],
    tasks: [
      ...Array.from({ length: members.tasks }, (_unused, index) => task({ id: `t${index + 1}`, projectId })),
      task({ id: 'other-task', projectId: 'beta' }),
    ],
    events: [
      ...Array.from({ length: members.events }, (_unused, index) => event({ id: `e${index + 1}`, projectId })),
      event({ id: 'other-event', projectId: 'beta' }),
    ],
  };
}

/**
 * The shell's half of the two-step delete, as `main.ts` performs it: hold what the first press
 * captured, submit it on the second press, clear it before the outcome is known.
 *
 * It is written here rather than imported because `main.ts` is a boot module with no exports, which
 * is why every Hub suite performs this half beside the real surface. What the real surface owns —
 * `beginProjectDelete`, the confirmation it renders and the controls it binds — is the real code.
 */
function mountShell(drawn: ProximaState) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.querySelector<HTMLElement>('#root')!;
  let current: ProximaState = drawn;
  let pending: ProjectDeleteConfirmation | null = null;
  const submitted: ProjectDeleteConfirmation[] = [];
  // A resolved write path is what makes the lifecycle controls real buttons rather than disabled
  // ones, which is the state a reader deletes from.
  const redraw = (): void => {
    root.innerHTML = renderProjectsHub({
      state: current,
      selection: 'all',
      filter: 'active',
      workspaceTab: 'notes',
      now: NOW,
      projectWrites: { refusal: null, feedback: null },
      projectDelete: pending,
    });
  };
  const handlers = {
    setFilter: () => undefined,
    openProject: () => undefined,
    showHub: () => undefined,
    openNewProject: () => undefined,
    closeNewProject: () => undefined,
    createProject: () => undefined,
    openProjectEditor: () => undefined,
    closeProjectEditor: () => undefined,
    saveProjectEdit: () => undefined,
    archiveProject: () => undefined,
    restoreProject: () => undefined,
    deleteProject: (projectId: string) => {
      const decision = beginProjectDelete(current, projectId);
      if (decision === null) return;
      if (decision.kind === 'submit') { pending = null; submitted.push(decision.request); redraw(); return; }
      pending = decision.pending;
      redraw();
    },
    confirmDeleteProject: () => { const held = pending; pending = null; if (held !== null) submitted.push(held); redraw(); },
    cancelDeleteProject: () => { pending = null; redraw(); },
  };
  bindProjectsHubInteractions(root, handlers);
  redraw();
  return {
    root,
    harness: createInteractionHarness(root),
    handlers,
    submitted,
    held: () => pending,
    /** The projection the surface is drawn from, so a case can move membership under it. */
    setState: (next: ProximaState) => { current = next; redraw(); },
  };
}

describe('the decision the first press makes', () => {
  it('submits at once for a project with no members, because there is nothing to confirm', () => {
    expect(beginProjectDelete(state('alpha', { tasks: 0, events: 0 }), 'alpha'))
      .toEqual({ kind: 'submit', request: { projectId: 'alpha', members: { tasks: [], events: [] } } });
  });

  it('captures the displayed task and event ids for a project with members', () => {
    expect(beginProjectDelete(state('alpha', { tasks: 2, events: 1 }), 'alpha'))
      .toEqual({ kind: 'confirm', pending: { projectId: 'alpha', members: { tasks: ['t1', 't2'], events: ['e1'] } } });
  });

  it('takes only the records that belong to the project it was given', () => {
    const decision = beginProjectDelete(state('alpha', { tasks: 2, events: 1 }), 'beta');
    expect(decision).toEqual({ kind: 'confirm', pending: { projectId: 'beta', members: { tasks: ['other-task'], events: ['other-event'] } } });
  });

  it('answers null for an id no project carries, so there is no request to make', () => {
    expect(beginProjectDelete(state('alpha', { tasks: 1, events: 0 }), 'gamma')).toBeNull();
  });
});

describe('the two presses at the surface', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('deletes an empty project on the first press and never draws a confirmation', () => {
    const shell = mountShell(state('alpha', { tasks: 0, events: 0 }));

    shell.harness.click('project-lifecycle-delete-alpha');

    expect(shell.submitted).toEqual([{ projectId: 'alpha', members: { tasks: [], events: [] } }]);
    expect(shell.held()).toBeNull();
    expect(shell.root.querySelector('[data-project-delete-confirmation]')).toBeNull();
  });

  it('submits nothing on the first press, and draws the ids it captured instead', () => {
    const shell = mountShell(state('alpha', { tasks: 2, events: 1 }));

    shell.harness.click('project-lifecycle-delete-alpha');

    expect(shell.submitted).toEqual([]);
    expect(shell.held()).toEqual({ projectId: 'alpha', members: { tasks: ['t1', 't2'], events: ['e1'] } });
    const confirmation = shell.root.querySelector<HTMLElement>('[data-project-delete-confirmation]')!;
    expect(confirmation.dataset.projectDeleteConfirmation).toBe('alpha');
    expect(confirmation.dataset.projectDeleteTasks).toBe('t1 t2');
    expect(confirmation.dataset.projectDeleteEvents).toBe('e1');
    expect(confirmation.dataset.projectDeleteTaskCount).toBe('2');
    expect(confirmation.dataset.projectDeleteEventCount).toBe('1');
    // The sentence is the informational half: it names the project and the records, and says that
    // nothing has happened yet, so the first press cannot be mistaken for the delete itself.
    const sentence = shell.root.querySelector<HTMLElement>('[data-project-delete-sentence]')!.textContent ?? '';
    expect(sentence).toContain('Alpha');
    expect(sentence).toContain('t1, t2, e1');
    expect(sentence).toContain('Nothing is deleted until you confirm');
  });

  it('submits the captured ids on the second press, even after the membership moved under it', () => {
    const shell = mountShell(state('alpha', { tasks: 2, events: 1 }));
    shell.harness.click('project-lifecycle-delete-alpha');

    // Membership moves before the reader confirms: the first task is gone and a third has appeared.
    // A shell that rediscovered would submit `t2 t3`; the confirmation the reader is looking at still
    // names `t1 t2`, and the store is the thing that decides whether that list is still true.
    shell.setState({
      ...state('alpha', { tasks: 2, events: 1 }),
      tasks: [task({ id: 't2', projectId: 'alpha' }), task({ id: 't3', projectId: 'alpha' })],
    });

    const drawn = shell.root.querySelector<HTMLElement>('[data-project-delete-confirmation]')!;
    expect(drawn.dataset.projectDeleteTasks).toBe('t1 t2');
    expect(shell.root.querySelector<HTMLElement>('[data-project-delete-sentence]')!.textContent).toContain('t1, t2');

    shell.harness.click('project-delete-confirm');

    expect(shell.submitted).toEqual([{ projectId: 'alpha', members: { tasks: ['t1', 't2'], events: ['e1'] } }]);
  });

  it('clears the held confirmation when it is submitted, so a second press sends nothing', () => {
    const shell = mountShell(state('alpha', { tasks: 1, events: 0 }));
    shell.harness.click('project-lifecycle-delete-alpha');

    shell.harness.click('project-delete-confirm');
    expect(shell.submitted).toHaveLength(1);
    expect(shell.held()).toBeNull();
    expect(shell.root.querySelector('[data-project-delete-confirmation]')).toBeNull();

    // The control is gone from the surface, so a reader has nothing left to press; the handler is
    // also total on its own, which is what this second call asserts while nothing is held.
    shell.handlers.confirmDeleteProject();
    expect(shell.submitted).toHaveLength(1);
  });

  it('cancels without submitting, and keeps the records exactly where they were', () => {
    const shell = mountShell(state('alpha', { tasks: 2, events: 1 }));
    shell.harness.click('project-lifecycle-delete-alpha');

    shell.harness.click('project-delete-cancel');

    expect(shell.submitted).toEqual([]);
    expect(shell.held()).toBeNull();
    expect(shell.root.querySelector('[data-project-delete-confirmation]')).toBeNull();
    expect(shell.root.querySelector('[data-project-lifecycle-action="delete"]')).not.toBeNull();
  });

  it('cancels on Escape, which is the way out every other Hub modal offers', () => {
    const shell = mountShell(state('alpha', { tasks: 1, events: 0 }));
    shell.harness.click('project-lifecycle-delete-alpha');

    shell.harness.escape('project-delete-confirmation');

    expect(shell.held()).toBeNull();
    expect(shell.root.querySelector('[data-project-delete-confirmation]')).toBeNull();
  });
});
