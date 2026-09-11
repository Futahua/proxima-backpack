// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createProjectAction } from '../src/app/projectLifecycleActions.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { bindProjectsHubInteractions, renderProjectsHub, type ProjectCreateIntent, type ProjectFormRefusal, type ProjectsHubFilter } from '../src/browser/projectsHub.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { createMemoryVault } from '../src/adapters/memoryVault.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
async function mountProjectCreate() {
  const loaded = await loadVaultState(createMemoryVault({}));
  const state = loaded.state;
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.querySelector<HTMLElement>('#root')!;
  let filter: ProjectsHubFilter = 'active';
  let newProjectOpen = false;
  let refusal: ProjectFormRefusal | null = null;
  /** What the form says, held by the shell so a refused save does not empty it. */
  let draft: ProjectCreateIntent | null = null;
  const pending: Promise<void>[] = [];
  const rerender = () => { root.innerHTML = renderProjectsHub({ state, selection: 'all', filter, workspaceTab: 'notes', now: NOW, newProjectOpen, projectCreateRefusal: refusal, projectCreateDraft: draft }); };
  bindProjectsHubInteractions(root, { setFilter: (next) => { filter = next; rerender(); }, openProject: () => {}, showHub: () => {}, openNewProject: () => { newProjectOpen = true; refusal = null; draft = { name: '', description: '' }; rerender(); }, closeNewProject: () => { newProjectOpen = false; refusal = null; draft = null; rerender(); },
    // The shell's half of Save, performed here the way `main.ts` performs it: the real sequence runs
    // with no record write path, and what it answers is what the form draws.
    createProject: ({ name, description }) => {
      draft = { name, description };
      pending.push((async () => {
        const outcome = await createProjectAction({ state, writes: async () => null, unavailableReason: () => 'record-writes-need-an-activated-store', refresh: async () => null, setRefusal: () => {}, render: () => {} }, { name, description });
        refusal = outcome.ok ? null : { code: outcome.reason, sentence: `${outcome.reason}: ${outcome.detail}` };
        if (outcome.ok) { newProjectOpen = false; draft = null; }
        rerender();
      })());
    },
    openProjectEditor: () => {}, closeProjectEditor: () => {}, saveProjectEdit: () => {},
    archiveProject: () => undefined, restoreProject: () => undefined, deleteProject: () => undefined,
  });
  rerender();
  return { root, harness: createInteractionHarness(root), state, pending, isOpen: () => newProjectOpen };
}
beforeEach(() => { document.body.innerHTML = ''; });
describe('Stage 5 New Project provisional modal', () => {
  it('opens locally and Cancel or Escape discards provisional fields without changing project data', async () => {
    const mounted = await mountProjectCreate(); const before = JSON.stringify(mounted.state);
    mounted.harness.click('project-create-open'); expect(mounted.isOpen()).toBe(true); expect(mounted.harness.target('project-create-modal').dataset.projectEditorMode).toBe('create'); expect(mounted.root.querySelector('[data-project-type]')).toBeNull();
    mounted.harness.typeText('project-create-name', 'Transient Project'); mounted.harness.typeText('project-create-description', 'Never saved'); mounted.harness.click('project-create-cancel'); expect(mounted.isOpen()).toBe(false); expect(() => mounted.harness.target('project-create-modal')).toThrow(); expect(JSON.stringify(mounted.state)).toBe(before);
    mounted.harness.click('project-create-open'); expect((mounted.harness.target('project-create-name') as HTMLInputElement).value).toBe(''); expect((mounted.harness.target('project-create-description') as HTMLTextAreaElement).value).toBe(''); mounted.harness.typeText('project-create-name', 'Another transient project'); mounted.harness.escape('project-create-name'); expect(mounted.isOpen()).toBe(false); expect(() => mounted.harness.target('project-create-modal')).toThrow(); expect(JSON.stringify(mounted.state)).toBe(before);
  });
  it('routes Save through the create sequence, keeps the provisional modal open on a refusal, and creates no record', async () => {
    const mounted = await mountProjectCreate(); const before = JSON.stringify(mounted.state);
    mounted.harness.click('project-create-open'); mounted.harness.typeText('project-create-name', 'Future combined project'); mounted.harness.typeText('project-create-description', 'No task versus schedule type.'); mounted.harness.click('project-create-save');
    await Promise.all(mounted.pending);
    expect(mounted.isOpen()).toBe(true); expect(mounted.harness.target('project-create-modal').dataset.projectCreateRefusal).toBe('writes-unavailable'); expect(JSON.stringify(mounted.state)).toBe(before); expect(mounted.state.projects.some((project) => project.name === 'Future combined project')).toBe(false);
  });
  it('collects exactly the metadata the corrected model keeps, and requires no legacy type', async () => {
    const mounted = await mountProjectCreate();
    mounted.harness.click('project-create-open');

    const modal = mounted.harness.target('project-create-modal');
    const controls = Array.from(modal.querySelectorAll('input, textarea, select'))
      .map((element) => element.getAttribute('data-c1-key') ?? '')
      .filter((key) => key.length > 0);

    // Name and description, which `CanonicalProjectRecordV2` keeps. Nothing else is asked
    // for, so nothing the corrected model drops can be required by this modal.
    expect(controls).toEqual(['project-create-name', 'project-create-description']);
    expect(modal.querySelector('[data-project-type]')).toBeNull();
    expect(modal.querySelector('[data-project-tab-bg-color]')).toBeNull();
    expect(modal.querySelector('[data-project-tab-text-color]')).toBeNull();
    expect(modal.querySelector('[data-project-linked-folder]')).toBeNull();
    // A name is canonical data, not identity: the modal never asks for an id or a filename.
    expect(modal.querySelector('[data-project-id]')).toBeNull();
    expect(modal.querySelector('[data-project-source]')).toBeNull();
  });
});
