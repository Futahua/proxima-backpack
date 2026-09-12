/**
 * The navigator's project list, as a surface a test can mount.
 *
 * This rendering lived inline in `src/browser/main.ts` until the parity agenda's project-archive box was read
 * closely: that box could show the Hub and the workspace following a project's status - both read the record on
 * every render - but not the navigator, because the navigator's list had no exported surface for a test to
 * mount, and "it is drawn inline in a six-thousand-line boot file" is not evidence. Extracting it is the whole
 * change; the markup is the same markup.
 *
 * **It holds no state and reads none.** The selection arrives as an argument and the projects come from the
 * state handed in, so a status change that arrives from the source is visible on the next render by
 * construction: there is no cached membership to invalidate, no list to keep in step, and nothing that could
 * disagree with the record. That is what the archive box's claim needs - the navigator moves a record between
 * the active list and the archived one because it draws what the record now says, not because something told
 * it to move.
 *
 * An archived project is drawn as a **non-selectable row rather than a disabled button**: it stays visible
 * (a reader must be able to see that it exists) and it carries no `data-action`, so the shell's delegated
 * selection cannot reach it. The count in the heading is the active projects only, which is the same rule
 * counted.
 */
import { ALL_PROJECTS, UNCATEGORISED } from '../domain/selectors.js';
import type { ProximaState } from '../domain/types.js';
import { projectPresentation } from './projectPresentation.js';

export const PROJECT_NAVIGATION_SCHEMA_VERSION = 1 as const;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Draw the project list and the selected project's read-only details.
 *
 * @param state - the current state; the projects, their names and their statuses come from here.
 * @param selection - the selected project id, `ALL_PROJECTS` or `UNCATEGORISED`.
 */
export function renderProjectNavigation(state: ProximaState, selection: string): string {
  const projects = state.projects.slice().sort((a, b) => a.id.localeCompare(b.id));
  const active = projects.filter((project) => project.status === 'active');
  const items = [
    { id: ALL_PROJECTS, label: 'All projects', detail: 'All Proxima work', project: undefined },
    { id: UNCATEGORISED, label: 'Uncategorised', detail: 'Records without a project', project: undefined },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      detail: `${project.status === 'archived' ? 'Archived · ' : ''}Project`,
      project,
    })),
  ];
  const selectedProject = state.projects.find((project) => project.id === selection);
  const detail = selectedProject ? projectPresentation(selectedProject) : null;
  return `<nav class="project-navigation" data-papers-visual-key="project-navigation" aria-label="Projects">
    <div class="region-heading"><span>Projects</span><span class="count">${active.length}</span></div><div class="project-list">
    ${items.map((item) => {
      const activeItem = selection === item.id;
      const disabled = item.project?.status === 'archived';
      const body = `<span class="project-dot ${item.project?.projectType ?? 'all'}"></span><span class="project-item-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>`;
      return disabled
        ? `<div class="project-item archived" data-papers-visual-key="project-item-${escapeHtml(item.id)}" title="${escapeHtml(item.detail)}" aria-label="${escapeHtml(item.label)}">${body}</div>`
        : `<button type="button" class="project-item${activeItem ? ' selected' : ''}" data-action="select-project" data-project-id="${escapeHtml(item.id)}" data-papers-visual-key="project-item-${escapeHtml(item.id || 'uncategorised')}" aria-current="${activeItem ? 'page' : 'false'}" title="${escapeHtml(item.detail)}">${body}</button>`;
    }).join('')}</div>
    ${detail ? `<section class="project-details" data-papers-visual-key="project-details" aria-label="Project details"><header><strong>${escapeHtml(detail.name)}</strong><small>${escapeHtml(detail.statusLabel)}</small></header><p>${escapeHtml(detail.description || 'No description')}</p>${detail.linkedFolders.length > 0 ? `<div><small>Linked folders</small><ul>${detail.linkedFolders.map((folder) => `<li><strong>${escapeHtml(folder.name)}</strong><span>${escapeHtml(folder.path)}</span></li>`).join('')}</ul></div>` : '<small>No linked folders</small>'}<footer><small>Source</small><code>${escapeHtml(detail.sourcePath)}</code><small>ID from ${escapeHtml(detail.sourceIdOrigin)}</small></footer></section>` : '<section class="project-details empty" data-papers-visual-key="project-details"><small>Select a project to inspect its read-only details.</small></section>'}
  </nav>`;
}
