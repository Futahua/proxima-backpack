// @vitest-environment happy-dom

/**
 * Projects Hub evidence.
 *
 * The hub's cards, its active/archived filter and its workspace opening were built in Stage 5
 * slices 1–4 and covered only by the New Project modal's cases. A box without evidence is a
 * claim, so this suite asserts what the cards actually show: every field the checklist names,
 * the priority row appearing only where a priority is represented, the filter switching what
 * is listed, a card opening its project's workspace, and the lifecycle controls refusing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { bindProjectsHubInteractions, projectsHubCards, renderProjectsHub, type ProjectsHubFilter } from '../src/browser/projectsHub.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { EMPTY_STATE, type Project, type ProximaState, type Task } from '../src/domain/types.js';

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

/** Two projects whose cards differ in every field the checklist names. */
function state(overrides: Partial<ProximaState> = {}): ProximaState {
  return {
    ...EMPTY_STATE,
    projects: [
      project({
        id: 'alpha',
        name: 'Alpha',
        description: 'The first project',
        createdAt: '2026-08-27T12:00:00.000Z',
        status: 'active',
        tabBgColor: '#123456',
        tabTextColor: '#ffffff',
      }),
      project({ id: 'beta', name: 'Beta', description: '', createdAt: 'not-a-date', status: 'archived' }),
    ],
    tasks: [
      task({ id: 'a1', projectId: 'alpha', deadline: '2026-09-01T00:00:00.000Z' }),
      task({ id: 'a2', projectId: 'alpha', deadline: '2026-09-20T00:00:00.000Z', properties: { priority: 'P1' } }),
      task({ id: 'a3', projectId: 'alpha', isCompleted: true, deadline: '2026-01-01T00:00:00.000Z' }),
      task({ id: 'b1', projectId: 'beta' }),
    ],
    taskSchema: [{ id: 'priority', name: 'Priority', type: 'text' }],
    ...overrides,
  };
}

function mount(hubState: ProximaState = state(), filter: ProjectsHubFilter = 'active') {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.querySelector<HTMLElement>('#root')!;
  let currentFilter = filter;
  let selection = 'all';
  const opened: string[] = [];
  const rerender = () => { root.innerHTML = renderProjectsHub({ state: hubState, selection, filter: currentFilter, workspaceTab: 'notes', now: NOW, newProjectOpen: false }); };
  bindProjectsHubInteractions(root, {
    setFilter: (next) => { currentFilter = next; rerender(); },
    openProject: (projectId) => { opened.push(projectId); selection = projectId; rerender(); },
    showHub: () => { selection = 'all'; rerender(); },
    openNewProject: () => {},
    closeNewProject: () => {},
    createProject: () => null,
    archiveProject: () => undefined, restoreProject: () => undefined, deleteProject: () => undefined,
  });
  rerender();
  return { root, harness: createInteractionHarness(root), opened, filter: () => currentFilter, selection: () => selection };
}

function card(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-c1-key="project-hub-card-${id}"]`)!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Projects Hub cards', () => {
  it('shows every field the checklist names, from the data it has', () => {
    const mounted = mount();
    const alpha = card(mounted.root, 'alpha');

    expect(alpha.querySelector('h3')!.textContent).toBe('Alpha');
    expect(alpha.querySelector('p')!.textContent).toBe('The first project');
    expect(alpha.getAttribute('data-project-age-days')).toBe('10');
    expect(alpha.querySelector?.call(alpha, 'dl dd')).toBeDefined();
    expect(alpha.getAttribute('data-project-task-count')).toBe('3');
    // One task is overdue and one is unfinished with a future deadline; the completed
    // overdue task is not counted, because a finished task is not late.
    expect(alpha.getAttribute('data-project-overdue-count')).toBe('1');
    expect(alpha.getAttribute('data-project-next-deadline')).toBe('2026-09-20T00:00:00.000Z');
    expect(alpha.getAttribute('data-project-archive-state')).toBe('active');
    expect(alpha.textContent).toContain('Active');
    expect(alpha.getAttribute('data-project-high-priority-count')).toBeNull();
  });

  it('shows the priority row only where a priority is represented, and none otherwise', () => {
    const alpha = card(mount().root, 'alpha');
    expect(alpha.querySelector('[data-project-high-priority-count]')!.textContent).toBe('1');

    // A project whose tasks carry no priority property has no priority to count, so the row
    // is absent rather than showing a zero nobody's data supports.
    const without = state({ taskSchema: [], tasks: [task({ id: 'a1', properties: {} })] });
    expect(card(mount(without).root, 'alpha').querySelector('[data-project-high-priority-count]')).toBeNull();
  });

  it('shows a project identity only when the colours are usable, and an unknown age as unknown', () => {
    const mounted = mount();
    const alpha = card(mounted.root, 'alpha');
    expect(alpha.querySelector('[data-project-identity-bg]')!.getAttribute('data-project-identity-bg')).toBe('#123456');
    expect(alpha.querySelector('[data-project-identity-text]')!.getAttribute('data-project-identity-text')).toBe('#ffffff');

    // Beta's created date is not a date, so its age is unknown rather than zero, and it has no
    // identity colours to show.
    const beta = card(mount(state(), 'archived').root, 'beta');
    expect(beta.getAttribute('data-project-age-days')).toBe('');
    expect(beta.textContent).toContain('Unknown');
    expect(beta.querySelector('[data-project-identity-bg]')).toBeNull();
    expect(beta.getAttribute('data-project-archive-state')).toBe('archived');
    expect(beta.textContent).toContain('Archived');

    // A colour that is not a colour is not a swatch.
    const hostile = state({ projects: [{ ...project({ id: 'alpha' }), tabBgColor: 'red; background: url(x)' }] });
    expect(card(mount(hostile).root, 'alpha').querySelector('[data-project-identity-bg]')).toBeNull();
  });

  it('lists only the projects the filter asks for, and switches when the other is pressed', () => {
    const mounted = mount();
    expect(mounted.root.querySelectorAll('[data-projects-hub-action="open-project"]')).toHaveLength(1);
    expect(card(mounted.root, 'alpha')).not.toBeNull();
    expect(mounted.root.querySelector('[data-projects-hub-filter="active"]')).not.toBeNull();
    expect(mounted.root.querySelector('[data-c1-key="project-hub-filter-active"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(mounted.root.textContent).toContain('1 active');

    mounted.harness.click('project-hub-filter-archived');
    expect(mounted.filter()).toBe('archived');
    expect(card(mounted.root, 'beta')).not.toBeNull();
    expect(mounted.root.querySelector('[data-c1-key="project-hub-card-alpha"]')).toBeNull();
    expect(mounted.root.querySelector('[data-c1-key="project-hub-filter-archived"]')!.getAttribute('aria-pressed')).toBe('true');

    // A filter with nothing in it says so rather than showing an empty grid.
    const none = mount(state({ projects: [project({ id: 'alpha' })] }), 'archived');
    expect(none.root.querySelector('[data-c1-key="project-hub-empty"]')!.textContent).toContain('No archived projects');
  });

  it('opens the workspace of the project that was clicked, and comes back', () => {
    const mounted = mount();
    mounted.harness.click('project-hub-card-alpha');
    expect(mounted.opened).toEqual(['alpha']);
    expect(mounted.selection()).toBe('alpha');

    // The workspace replaces the hub's grid: no cards, and the project's own panels.
    expect(mounted.root.querySelector('[data-c1-key="project-hub-cards"]')).toBeNull();
    expect(mounted.root.querySelector('[data-project-workspace-project-id="alpha"]')).not.toBeNull();
    expect(mounted.root.textContent).toContain('Active project');

    mounted.harness.click('project-hub-back');
    expect(mounted.selection()).toBe('all');
    expect(mounted.root.querySelector('[data-c1-key="project-hub-cards"]')).not.toBeNull();
  });

  it('offers archive, restore and delete with the archive one the project needs', () => {
    const active = card(mount().root, 'alpha');
    const controls = active.parentElement!;
    expect(controls.querySelector('[data-project-lifecycle-action="archive"]')).not.toBeNull();
    expect(controls.querySelector('[data-project-lifecycle-action="restore"]')).toBeNull();
    expect(controls.querySelector('[data-project-lifecycle-action="delete"]')).not.toBeNull();
    expect(controls.querySelectorAll('button[disabled]')).toHaveLength(2);
    expect(controls.querySelector('[data-project-lifecycle-refusal]')!.getAttribute('data-project-lifecycle-refusal')).toBe('action-not-available');
    expect(controls.textContent).toContain('Unavailable until record-store cutover');

    const archived = card(mount(state(), 'archived').root, 'beta');
    expect(archived.parentElement!.querySelector('[data-project-lifecycle-action="restore"]')).not.toBeNull();
    expect(archived.parentElement!.querySelector('[data-project-lifecycle-action="archive"]')).toBeNull();
  });

  it('projects the same card the pure model describes, so the hub cannot drift from it', () => {
    const projected = projectsHubCards(state(), 'active', NOW);
    expect(projected.map((entry) => entry.id)).toEqual(['alpha']);
    expect(projected[0]).toMatchObject({
      name: 'Alpha',
      description: 'The first project',
      status: 'active',
      ageDays: 10,
      taskCount: 3,
      overdueCount: 1,
      highPriorityCount: 1,
      nextDeadline: '2026-09-20T00:00:00.000Z',
      identityBackground: '#123456',
      identityText: '#ffffff',
    });
  });
});
