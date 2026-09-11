// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { renderProjectsHub } from '../src/browser/projectsHub.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { ALL_PROJECTS } from '../src/domain/selectors.js';
import { sourceRef } from './fixtures.js';

async function lifecycleState() {
  const template = { id: 'template', source: sourceRef('project', 'template'), name: 'Template', description: 'Template', createdAt: '2026-01-01T00:00:00.000Z', status: 'active' as const, projectType: 'task' as const, linkedFolders: [] };
  return { projects: [{ ...template, id: 'lifecycle-active', name: 'Lifecycle Active' }, { ...template, id: 'lifecycle-archived', name: 'Lifecycle Archived', status: 'archived' as const, archivedAt: '2026-09-01T00:00:00.000Z' }], tasks: [], events: [], statuses: [], taskSchema: [] };
}
beforeEach(() => { document.body.innerHTML = ''; });
describe('Stage 5 project lifecycle controls with no write path resolved', () => {
  it('shows Archive/Delete for active projects and Restore/Delete for archived projects as explicit unavailable controls', async () => {
    const state = await lifecycleState(); const before = JSON.stringify(state);
    document.body.innerHTML = renderProjectsHub({ state, selection: ALL_PROJECTS, filter: 'active', workspaceTab: 'notes', now: new Date('2026-09-06T12:00:00.000Z') });
    let harness = createInteractionHarness(document); const archive = harness.target('project-lifecycle-archive-lifecycle-active') as HTMLButtonElement; const activeDelete = harness.target('project-lifecycle-delete-lifecycle-active') as HTMLButtonElement;
    expect(archive.disabled).toBe(true); expect(archive.dataset.projectLifecycleAction).toBe('archive'); expect(archive.dataset.projectLifecycleRefusal).toBe('action-not-available'); expect(activeDelete.disabled).toBe(true); expect(activeDelete.dataset.projectLifecycleAction).toBe('delete'); expect(() => harness.target('project-lifecycle-restore-lifecycle-active')).toThrow();
    document.body.innerHTML = renderProjectsHub({ state, selection: ALL_PROJECTS, filter: 'archived', workspaceTab: 'notes', now: new Date('2026-09-06T12:00:00.000Z') });
    harness = createInteractionHarness(document); const restore = harness.target('project-lifecycle-restore-lifecycle-archived') as HTMLButtonElement; const archivedDelete = harness.target('project-lifecycle-delete-lifecycle-archived') as HTMLButtonElement;
    expect(restore.disabled).toBe(true); expect(restore.dataset.projectLifecycleAction).toBe('restore'); expect(restore.dataset.projectLifecycleRefusal).toBe('action-not-available'); expect(archivedDelete.disabled).toBe(true); expect(archivedDelete.dataset.projectLifecycleAction).toBe('delete'); expect(() => harness.target('project-lifecycle-archive-lifecycle-archived')).toThrow(); expect(JSON.stringify(state)).toBe(before);
  });
  it('keeps the same honest lifecycle controls visible inside an opened project workspace without changing records', async () => {
    const state = await lifecycleState(); const before = JSON.stringify(state); document.body.innerHTML = renderProjectsHub({ state, selection: 'lifecycle-active', filter: 'active', workspaceTab: 'notes', now: new Date('2026-09-06T12:00:00.000Z') }); const harness = createInteractionHarness(document);
    expect(harness.target('project-lifecycle-controls-lifecycle-active').dataset.projectLifecycleState).toBe('active'); expect((harness.target('project-lifecycle-archive-lifecycle-active') as HTMLButtonElement).disabled).toBe(true); expect((harness.target('project-lifecycle-delete-lifecycle-active') as HTMLButtonElement).disabled).toBe(true); expect(harness.target('project-lifecycle-controls-lifecycle-active').textContent).toContain('Unavailable until record-store cutover'); expect(JSON.stringify(state)).toBe(before);
  });
});
