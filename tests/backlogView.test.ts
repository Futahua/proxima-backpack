/**
 * Backlog projection and rendering contracts.
 *
 * The second half of this file is the first test in the repository to import
 * `src/browser/`. `renderProjectBacklog` returns an HTML string and depends on
 * nothing but types, so it is exercisable in Node — which is what turns the
 * Backlog's search, filter and sort boxes into claims with evidence instead of
 * claims about pixels nobody checks.
 */

import { describe, expect, it } from 'vitest';

import { projectBacklog, type BacklogViewState } from '../src/app/backlogView.js';
import { EMPTY_BACKLOG_QUERY, type BacklogQuery } from '../src/domain/backlogQuery.js';
import { EMPTY_STATE, type Project, type ProximaState, type Task } from '../src/domain/types.js';
import {
  EMPTY_PROJECT_BACKLOG_VIEW,
  renderProjectBacklog,
  type ProjectBacklogViewState,
} from '../src/browser/projectBacklog.js';

function project(overrides: Partial<Project> & { id: string }): Project {
  return {
    source: { path: `Proxima/projects/${overrides.id}.md`, revision: 'r1', kind: 'project', idOrigin: 'frontmatter' },
    name: overrides.id,
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
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
    ...overrides,
  };
}

function state(tasks: Task[], projects: Project[] = [project({ id: 'p1' })]): ProximaState {
  return { ...EMPTY_STATE, projects, tasks };
}

/**
 * The browser view state extends the projection's, so one helper serves both the
 * projection and the renderer.
 */
function view(query: Partial<BacklogQuery> = {}): ProjectBacklogViewState {
  return { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: 'p1', query: { ...EMPTY_BACKLOG_QUERY, ...query } };
}

describe('Backlog projection', () => {
  it('shows the project it was asked for, in the legacy order', () => {
    const loaded = state([
      task({ id: 'third', orderIndex: 3 }),
      task({ id: 'first', orderIndex: 1 }),
      task({ id: 'other-project', projectId: 'p2', orderIndex: 0 }),
    ]);

    const projected = projectBacklog(loaded, loaded.projects[0]!, view());

    expect(projected.rows.map((row) => row.taskId)).toEqual(['first', 'third']);
    expect(projected.totalCount).toBe(2);
    expect(projected.visibleCount).toBe(2);
    expect(projected.emptyReason).toBeNull();
  });

  it('builds the fixed columns, then one per custom property the data declares', () => {
    const loaded = state([
      task({ id: 'a', properties: { tags: ['one', 'two'], effort: 3 } }),
      task({ id: 'b', properties: { tags: [] } }),
    ]);

    const projected = projectBacklog(loaded, loaded.projects[0]!, view());
    const ids = projected.columns.map((column) => column.id);

    // Fixed field columns keep their declared order and stay sortable.
    expect(ids.slice(0, 8)).toEqual([
      'field:name', 'field:status', 'field:weight', 'field:fixedDuration',
      'field:maxDuration', 'field:startDate', 'field:deadline', 'field:isCompleted',
    ]);
    expect(projected.columns[0]!.field).toBe('name');

    // Property columns come from the data, sorted, and are not field-sortable.
    expect(ids.slice(8)).toEqual(['property:effort', 'property:tags']);
    expect(projected.columns[8]!.field).toBeNull();
    expect(projected.columns[8]!.propertyKey).toBe('effort');

    // A property nothing declares produces no column.
    expect(ids).not.toContain('property:absent');
  });

  it('formats cells for their type and marks empties', () => {
    const loaded = state([task({
      id: 'a',
      name: 'Alpha',
      status: 'review',
      weight: 4,
      isCompleted: true,
      fixedDuration: 90,
      maxDuration: null,
      startDate: '2026-03-01T00:00:00.000Z',
      deadline: null,
      properties: { tags: ['x', 'y'], note: null },
    })]);

    const projected = projectBacklog(loaded, loaded.projects[0]!, view());
    const cells = new Map(projected.rows[0]!.cells.map((cell) => [cell.columnId, cell]));

    expect(cells.get('field:name')).toMatchObject({ text: 'Alpha', empty: false });
    expect(cells.get('field:status')).toMatchObject({ text: 'review' });
    expect(cells.get('field:weight')).toMatchObject({ text: '4' });
    expect(cells.get('field:isCompleted')).toMatchObject({ text: 'Yes' });
    expect(cells.get('field:fixedDuration')).toMatchObject({ text: '90 min', empty: false });
    expect(cells.get('field:maxDuration')).toMatchObject({ text: '', empty: true });
    expect(cells.get('field:startDate')).toMatchObject({ text: '2026-03-01T00:00:00.000Z', empty: false });
    expect(cells.get('field:deadline')).toMatchObject({ text: '', empty: true });

    // A list property reads as its values; an empty list and a null are empty.
    expect(cells.get('property:tags')).toMatchObject({ text: 'x, y', empty: false });
    expect(cells.get('property:note')).toMatchObject({ text: '', empty: true });
  });

  it('applies search, filters and ordering, and reports both counts', () => {
    const loaded = state([
      task({ id: 'alpha', name: 'Alpha', weight: 5 }),
      task({ id: 'beta', name: 'Beta', weight: 1 }),
      task({ id: 'gamma', name: 'Gamma', weight: 9 }),
    ]);

    const projected = projectBacklog(loaded, loaded.projects[0]!, view({
      search: 'a',
      filters: [{ id: 'f1', field: 'weight', operator: 'greater-than', value: 2 }],
      sort: { field: 'weight', direction: 'descending' },
    }));

    // "a" keeps Alpha and Gamma; weight > 2 keeps both; sorted by weight, descending.
    expect(projected.rows.map((row) => row.taskId)).toEqual(['gamma', 'alpha']);
    expect(projected.totalCount).toBe(3);
    expect(projected.visibleCount).toBe(2);
  });

  it('describes the active query for the toolbar', () => {
    const loaded = state([task({ id: 'a', name: 'Alpha' })]);

    const unfiltered = projectBacklog(loaded, loaded.projects[0]!, view());
    expect(unfiltered.filterChips).toEqual([]);
    expect(unfiltered.sortIndicator).toBeNull();
    expect(unfiltered.search).toBe('');

    const filtered = projectBacklog(loaded, loaded.projects[0]!, view({
      search: 'alp',
      filters: [
        { id: 'f1', field: 'weight', operator: 'greater-than', value: 2 },
        { id: 'f2', field: 'deadline', operator: 'is-empty' },
      ],
      sort: { field: 'name', direction: 'ascending' },
    }));

    expect(filtered.search).toBe('alp');
    expect(filtered.sortIndicator).toEqual({ field: 'name', direction: 'ascending' });
    expect(filtered.filterChips.map((chip) => chip.id)).toEqual(['f1', 'f2']);
    expect(filtered.filterChips[0]!.label).toBe('Weight > 2');
    expect(filtered.filterChips[1]!.label).toBe('Deadline is empty');
  });

  it('distinguishes an empty project from a query that hid everything', () => {
    const withTasks = state([task({ id: 'a', name: 'Alpha' })]);

    expect(projectBacklog(withTasks, withTasks.projects[0]!, view()).emptyReason).toBeNull();
    expect(projectBacklog(withTasks, withTasks.projects[0]!, view({ search: 'zzz' })).emptyReason).toBe('no-matches');

    const bare = state([task({ id: 'a', projectId: 'p2' })]);
    expect(projectBacklog(bare, bare.projects[0]!, view()).emptyReason).toBe('no-tasks');
  });

  it('refuses a query it cannot mean rather than rendering an unfiltered list', () => {
    const loaded = state([task({ id: 'a' })]);

    expect(() => projectBacklog(loaded, loaded.projects[0]!, view({
      filters: [{ id: 'f1', field: 'name', operator: 'less-than', value: 'x' }],
    }))).toThrow(/does not support "less-than"/);
  });
});

describe('Backlog rendering', () => {
  const loaded = state([
    task({ id: 'alpha', name: 'Alpha', description: 'First', deadline: '2026-05-01T00:00:00.000Z', weight: 5, orderIndex: 1 }),
    task({ id: 'beta', name: 'Beta', weight: 1, orderIndex: 0, isCompleted: true }),
  ]);
  const p1 = loaded.projects[0]!;

  it('renders one row per visible task and keeps every interaction hook', () => {
    const html = renderProjectBacklog(loaded, p1, view());

    expect(html).toContain('data-project-backlog-project-id="p1"');
    expect(html).toContain('data-project-backlog-write-authority="unavailable"');

    // Both tasks, in legacy order: beta has orderIndex 0.
    expect(html.indexOf('data-project-backlog-task-id="beta"')).toBeLessThan(
      html.indexOf('data-project-backlog-task-id="alpha"'),
    );

    // The row and drop-slot hooks the drag layer depends on, including the
    // trailing slot at the row count.
    expect(html).toContain('data-project-backlog-row-index="0"');
    expect(html).toContain('data-project-backlog-row-index="1"');
    expect(html).toContain('data-papers-visual-key="project-backlog-drop-p1-0"');
    expect(html).toContain('data-project-backlog-drop-index="2"');
    expect(html).toContain('data-papers-visual-key="project-backlog-task-alpha"');
    expect(html).toContain('data-project-backlog-order="1"');
    expect(html).toContain('data-project-backlog-action="open-task"');

    // Field content and the completed / selected classes.
    expect(html).toContain('<strong>Alpha</strong>');
    expect(html).toContain('<small>2026-05-01T00:00:00.000Z</small>');
    expect(html).toContain('<small>No deadline</small>');
    expect(html).toContain('project-backlog-task completed');
  });

  it('renders only what the query left, and says what the query was', () => {
    const html = renderProjectBacklog(loaded, p1, view({
      search: 'alpha',
      filters: [{ id: 'f1', field: 'weight', operator: 'greater-than', value: 2 }],
      sort: { field: 'weight', direction: 'descending' },
    }));

    expect(html).toContain('data-project-backlog-task-id="alpha"');
    expect(html).not.toContain('data-project-backlog-task-id="beta"');

    expect(html).toContain('data-project-backlog-search="alpha"');
    expect(html).toContain('data-project-backlog-filter-chip="f1"');
    expect(html).toContain('Weight &gt; 2');
    expect(html).toContain('data-project-backlog-sort-indicator');
    expect(html).toContain('data-project-backlog-sort-field="weight"');
    expect(html).toContain('data-project-backlog-sort-direction="descending"');

    // The header reports visible-of-total once a query is active.
    expect(html).toContain('1 of 2 project tasks');
  });

  it('keeps the unqueried markup as it was, and separates the two empty states', () => {
    const plain = renderProjectBacklog(loaded, p1, view());

    // No query means no toolbar, and the original count sentence.
    expect(plain).not.toContain('data-project-backlog-query=');
    expect(plain).toContain('2 project tasks · order writes unavailable');

    const noMatch = renderProjectBacklog(loaded, p1, view({ search: 'zzz' }));
    expect(noMatch).toContain('data-project-backlog-empty-reason="no-matches"');
    expect(noMatch).toContain('No project tasks match the current search or filters.');

    const bare = state([task({ id: 'a', projectId: 'p2' })]);
    const noTasks = renderProjectBacklog(bare, bare.projects[0]!, view());
    expect(noTasks).toContain('data-papers-visual-key="project-backlog-empty"');
    expect(noTasks).toContain('No project tasks.');
    expect(noTasks).not.toContain('no-matches');
  });

  it('escapes task text so a name cannot inject markup', () => {
    const hostile = state([task({ id: 'a', name: '<script>alert(1)</script>', description: '"onmouseover="x' })]);
    const html = renderProjectBacklog(hostile, hostile.projects[0]!, view());

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;onmouseover=&quot;x');
  });
});
