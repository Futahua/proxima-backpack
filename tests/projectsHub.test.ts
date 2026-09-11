// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixedClock } from '../src/domain/clock.js';
import { bindProjectsHubInteractions, renderProjectsHub, type ProjectsHubFilter } from '../src/browser/projectsHub.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { createMemoryVault } from '../src/adapters/memoryVault.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');

async function mountProjectCreate() {
  const loaded = await loadVaultState(createMemoryVault({}));
  const state = loaded.state;
  const dispatcher = createActionDispatcher({ state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture', clock: fixedClock(NOW.toISOString()) });
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.querySelector<HTMLElement>('#root')!;
  let filter: ProjectsHubFilter = 'active';
  let newProjectOpen = false;
  const rerender = () => { root.innerHTML = renderProjectsHub({ state, selection: 'all', filter, workspaceTab: 'notes', now: NOW, newProjectOpen }); };
  bindProjectsHubInteractions(root, { setFilter: (next) => { filter = next; rerender(); }, openProject: () => {}, showHub: () => {}, openNewProject: () => { newProjectOpen = true; rerender(); }, closeNewProject: () => { newProjectOpen = false; rerender(); }, createProject: ({ name, description }) => dispatcher.dispatch({ type: 'project.create', name, description }) });
  rerender();
  return { root, harness: createInteractionHarness(root), state, dispatcher, isOpen: () => newProjectOpen };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('Stage 5 New Project provisional modal', () => {
  it('opens locally and Cancel or Escape discards provisional fields without changing project data', async () => {
    const mounted = await mountProjectCreate();
    const before = JSON.stringify(mounted.state);
    mounted.harness.click('project-create-open');
    expect(mounted.isOpen()).toBe(true);
    expect(mounted.harness.target('project-create-modal').dataset.projectEditorMode).toBe('create');
    expect(mounted.root.querySelector('[data-project-type]')).toBeNull();
    mounted.harness.typeText('project-create-name', 'Transient Project');
    mounted.harness.typeText('project-create-description', 'Never saved');
    mounted.harness.click('project-create-cancel');
    expect(mounted.isOpen()).toBe(false);
    expect(() => mounted.harness.target('project-create-modal')).toThrow();
    expect(JSON.stringify(mounted.state)).toBe(before);
    mounted.harness.click('project-create-open');
    expect((mounted.harness.target('project-create-name') as HTMLInputElement).value).toBe('');
    expect((mounted.harness.target('project-create-description') as HTMLTextAreaElement).value).toBe('');
    mounted.harness.typeText('project-create-name', 'Another transient project');
    mounted.harness.escape('project-create-name');
    expect(mounted.isOpen()).toBe(false);
    expect(() => mounted.harness.target('project-create-modal')).toThrow();
    expect(JSON.stringify(mounted.state)).toBe(before);
  });

  it('routes Save through project.create, keeps the provisional modal open on typed unavailable, and creates no record', async () => {
    const mounted = await mountProjectCreate();
    const before = JSON.stringify(mounted.state);
    const beforeRevision = mounted.dispatcher.snapshot().stateRevision;
    mounted.harness.click('project-create-open');
    mounted.harness.typeText('project-create-name', 'Future combined project');
    mounted.harness.typeText('project-create-description', 'No task versus schedule type.');
    mounted.harness.click('project-create-save');
    expect(mounted.isOpen()).toBe(true);
    expect(mounted.harness.target('project-create-modal').dataset.projectCreateRefusal).toBe('action-not-available');
    expect(mounted.dispatcher.snapshot().stateRevision).toBe(beforeRevision);
    expect(JSON.stringify(mounted.state)).toBe(before);
    expect(mounted.state.projects.some((project) => project.name === 'Future combined project')).toBe(false);
  });

  it('refuses an invalid form with the invalid-input reason, not with the unavailable one', async () => {
    const mounted = await mountProjectCreate();
    const before = JSON.stringify(mounted.state);
    const beforeRevision = mounted.dispatcher.snapshot().stateRevision;
    mounted.harness.click('project-create-open');

    // Nothing typed at all: the boundary refuses an empty name as invalid input, and the
    // modal says so rather than answering with the refusal this stage gives every valid
    // form.
    mounted.harness.click('project-create-save');
    expect(mounted.isOpen()).toBe(true);
    expect(mounted.harness.target('project-create-modal').dataset.projectCreateRefusal).toBe('invalid-action-input');

    // Whitespace is not a name either — the boundary trims before it decides.
    mounted.harness.typeText('project-create-name', '   ');
    mounted.harness.click('project-create-save');
    expect(mounted.harness.target('project-create-modal').dataset.projectCreateRefusal).toBe('invalid-action-input');

    // A name that is a name gets the answer this stage can give.
    mounted.harness.typeText('project-create-name', 'Named project');
    mounted.harness.click('project-create-save');
    expect(mounted.harness.target('project-create-modal').dataset.projectCreateRefusal).toBe('action-not-available');

    expect(mounted.dispatcher.snapshot().stateRevision).toBe(beforeRevision);
    expect(JSON.stringify(mounted.state)).toBe(before);
  });
});
