/**
 * The navigator's project list, driven as a surface rather than read as a slice of the boot file.
 *
 * The parity agenda's project-archive box was half demonstrable for a while: the Hub and the workspace both
 * read the project record on every render, so a status change arriving from the source moves them - but the
 * navigator was drawn inline by `src/browser/main.ts` and had no exported surface to mount, which is why the
 * box stayed open. `src/browser/projectNavigation.ts` is that surface, and this file is the evidence the box
 * was waiting for: the same record is rendered twice, once active and once archived, which is exactly what an
 * external status change looks like on the next render.
 *
 * What is asserted is what the box claims - the project moves between the sets, the count follows, and the
 * archived row cannot be selected - plus the two things a reader would notice if they broke: an archived
 * project stays *visible* rather than disappearing, and the selected project's details are drawn from the
 * record.
 */
import { describe, expect, it } from 'vitest';
import { renderProjectNavigation } from '../src/browser/projectNavigation.js';
import { ALL_PROJECTS, UNCATEGORISED } from '../src/domain/selectors.js';
import type { Project, ProximaState } from '../src/domain/types.js';

function project(id: string, name: string, status: Project['status'], linkedFolders: readonly { name: string; path: string }[] = []): Project {
  return {
    id,
    source: { path: `fixtures/${id}.md`, kind: 'markdown', idOrigin: 'declared' },
    name,
    description: `${name} description`,
    createdAt: '2026-09-01T00:00:00.000Z',
    status,
    projectType: 'project',
    colors: [],
    linkedFolders: [...linkedFolders],
  } as unknown as Project;
}

function stateWith(projects: readonly Project[]): ProximaState {
  return { projects: [...projects] } as unknown as ProximaState;
}

const ACTIVE = project('pxr_active', 'Active work', 'active');
const ARCHIVED = project('pxr_archived', 'Old work', 'archived');

describe('the navigator draws the projects the records now describe', () => {
  it('draws an active project as a selectable row, and counts the active ones', () => {
    const html = renderProjectNavigation(stateWith([ACTIVE, ARCHIVED]), ALL_PROJECTS);

    expect(html).toContain('data-c1-key="project-item-pxr_active"');
    expect(html).toContain('data-action="select-project" data-project-id="pxr_active"');
    expect(html).toContain('aria-label="Projects"');
    // The count is the active projects only: one of the two.
    expect(html).toContain('<span class="count">1</span>');
  });

  it('draws an archived project as a visible row that the shell cannot select', () => {
    const html = renderProjectNavigation(stateWith([ACTIVE, ARCHIVED]), ALL_PROJECTS);

    expect(html).toContain('class="project-item archived"');
    expect(html).toContain('Archived · Project');
    // Visible, and not a control: the archived row carries no action and no project id, so the shell's
    // delegated selection has nothing to find. That is the difference between "archived" and "hidden".
    const archivedRow = html.slice(html.indexOf('data-c1-key="project-item-pxr_archived"'), html.indexOf('data-c1-key="project-item-pxr_archived"') + 260);
    expect(archivedRow).not.toContain('data-action=');
    expect(html).toContain('Old work');
  });

  it('moves a project between the sets when the record says its status changed', () => {
    // The same id, the same name, one field different - which is what an edit arriving from the source looks
    // like by the time a surface renders again. Nothing is invalidated and nothing is notified: the render is
    // a function of the state, so the move cannot be missed.
    const before = renderProjectNavigation(stateWith([ACTIVE]), ALL_PROJECTS);
    const after = renderProjectNavigation(stateWith([{ ...ACTIVE, status: 'archived' }]), ALL_PROJECTS);

    expect(before).toContain('<span class="count">1</span>');
    expect(before).toContain('data-action="select-project" data-project-id="pxr_active"');
    expect(after).toContain('<span class="count">0</span>');
    expect(after).toContain('class="project-item archived"');
    expect(after).not.toContain('data-action="select-project" data-project-id="pxr_active"');
    // And back again: the move is not one-way state somewhere.
    const restored = renderProjectNavigation(stateWith([{ ...ACTIVE, status: 'active' }]), ALL_PROJECTS);
    expect(restored).toContain('<span class="count">1</span>');
  });

  it('draws the selected project details from the record, and the sentinels as ordinary rows', () => {
    const withFolders = project('pxr_active', 'Active work', 'active', [{ name: 'Specs', path: 'Vault/Specs' }]);
    const html = renderProjectNavigation(stateWith([withFolders]), withFolders.id);

    expect(html).toContain('data-c1-key="project-details"');
    expect(html).toContain('Active work');
    expect(html).toContain('Active work description');
    expect(html).toContain('aria-current="page"');
    // The details are the record's: a linked folder drawn from it, and the source the record came from.
    expect(html).toContain('Specs');
    expect(html).toContain('Vault/Specs');
    expect(html).toContain('fixtures/pxr_active.md');
    // The two sentinels are always offered, and neither is a project record.
    expect(html).toContain(`data-project-id="${ALL_PROJECTS}"`);
    expect(html).toContain(`data-project-id="${UNCATEGORISED}"`);
    // Nothing selected: the details panel says so rather than drawing an empty one.
    expect(renderProjectNavigation(stateWith([ACTIVE]), 'pxr_nothing')).toContain('Select a project to inspect its read-only details.');
  });
});
