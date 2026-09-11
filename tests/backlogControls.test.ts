/**
 * Backlog query-control contracts.
 *
 * A control is what a person does — type a search, add a filter, remove a chip, sort by
 * a column, clear the query — and each one is a pure transition, so what the controls do
 * is checked here rather than guessed at from the browser. The last two sections check
 * the two claims that a control layer can get wrong without any test noticing: that the
 * filter menu can only offer comparisons the matcher accepts, and that searching,
 * filtering and sorting never write to a record.
 */

import { describe, expect, it } from 'vitest';

import {
  applyBacklogControl,
  BACKLOG_FIELD_LABELS,
  BACKLOG_OPERATOR_LABELS,
  buildBacklogFilter,
  encodeBacklogExpression,
  nextBacklogFilterId,
  type BacklogControl,
} from '../src/app/backlogControls.js';
import { projectBacklog } from '../src/app/backlogView.js';
import {
  assertBacklogQuery,
  BACKLOG_FIELDS,
  BacklogQueryError,
  EMPTY_BACKLOG_QUERY,
  operatorsForField,
  operatorTakesValue,
  type BacklogField,
  type BacklogFilter,
  type BacklogQuery,
} from '../src/domain/backlogQuery.js';
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

function state(tasks: Task[]): ProximaState {
  return { ...EMPTY_STATE, projects: [project({ id: 'p1' })], tasks };
}

function query(overrides: Partial<BacklogQuery> = {}): BacklogQuery {
  return { ...EMPTY_BACKLOG_QUERY, ...overrides };
}

function view(overrides: Partial<BacklogQuery> = {}): ProjectBacklogViewState {
  return { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: 'p1', query: query(overrides) };
}

/** A value the field can actually be compared against, for the exhaustive passes below. */
function sampleValue(field: BacklogField): string {
  return field === 'weight' || field === 'fixedDuration' || field === 'maxDuration' ? '7' : '2026-01-01';
}

const WEIGHT_TWO: BacklogFilter = { id: 'filter-1', field: 'weight', operator: 'greater-than', value: 2 };

describe('Backlog query controls', () => {
  it('sets the search text and keeps the rest of the query', () => {
    const before = query({ filters: [WEIGHT_TWO], sort: { field: 'name', direction: 'descending' } });

    const after = applyBacklogControl(before, { kind: 'set-search', search: 'alp' });

    expect(after.search).toBe('alp');
    expect(after.filters).toBe(before.filters);
    expect(after.sort).toBe(before.sort);
  });

  it('keeps the typed search exactly, leaving trimming to the matcher', () => {
    const padded = applyBacklogControl(EMPTY_BACKLOG_QUERY, { kind: 'set-search', search: '  alpha  ' });

    expect(padded.search).toBe('  alpha  ');

    // The engine is what decides a query of only spaces searches for nothing.
    const loaded = state([task({ id: 'a', name: 'Alpha' })]);
    const spaced = query({ search: '   ' });
    expect(projectBacklog(loaded, loaded.projects[0]!, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: 'p1', query: spaced }).rows).toHaveLength(1);
  });

  it('returns the same query when a control cannot change it', () => {
    const sorted = query({ search: 'alp', filters: [WEIGHT_TWO], sort: { field: 'name', direction: 'ascending' } });

    expect(applyBacklogControl(sorted, { kind: 'set-search', search: 'alp' })).toBe(sorted);
    expect(applyBacklogControl(sorted, { kind: 'remove-filter', filterId: 'filter-9' })).toBe(sorted);
    expect(applyBacklogControl(sorted, { kind: 'add-filter', filter: { ...WEIGHT_TWO } })).toBe(sorted);
    expect(applyBacklogControl(EMPTY_BACKLOG_QUERY, { kind: 'clear-sort' })).toBe(EMPTY_BACKLOG_QUERY);
    expect(applyBacklogControl(EMPTY_BACKLOG_QUERY, { kind: 'clear-query' })).toBe(EMPTY_BACKLOG_QUERY);
  });

  it('appends a filter, and addresses one it already holds', () => {
    const first = applyBacklogControl(EMPTY_BACKLOG_QUERY, { kind: 'add-filter', filter: WEIGHT_TWO });

    expect(first.filters.map((filter) => filter.id)).toEqual(['filter-1']);

    const second = applyBacklogControl(first, {
      kind: 'add-filter',
      filter: { id: nextBacklogFilterId(first.filters), field: 'isCompleted', operator: 'is', value: true },
    });

    expect(second.filters.map((filter) => filter.id)).toEqual(['filter-1', 'filter-2']);

    // A filter whose id is already in the query replaces it in place, so a chip does
    // not jump to the end of the strip when it is edited.
    const replaced = applyBacklogControl(second, {
      kind: 'add-filter',
      filter: { id: 'filter-1', field: 'weight', operator: 'less-than', value: 9 },
    });

    expect(replaced.filters.map((filter) => filter.id)).toEqual(['filter-1', 'filter-2']);
    expect(replaced.filters[0]!.operator).toBe('less-than');
    expect(replaced.filters[1]).toBe(second.filters[1]);
  });

  it('refuses a filter that cannot mean anything without touching the query', () => {
    const before = query({ filters: [WEIGHT_TWO] });
    const snapshot = JSON.stringify(before);

    expect(() => applyBacklogControl(before, {
      kind: 'add-filter',
      filter: { id: 'filter-2', field: 'name', operator: 'less-than', value: 'x' },
    })).toThrow(BacklogQueryError);

    expect(() => applyBacklogControl(before, {
      kind: 'add-filter',
      filter: { id: 'filter-2', field: 'weight', operator: 'greater-than' },
    })).toThrow(/needs a value/);

    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('removes the filter a chip names and leaves the others as they were', () => {
    const before = query({
      filters: [
        WEIGHT_TWO,
        { id: 'filter-2', field: 'deadline', operator: 'is-empty' },
      ],
    });

    const after = applyBacklogControl(before, { kind: 'remove-filter', filterId: 'filter-1' });

    expect(after.filters.map((filter) => filter.id)).toEqual(['filter-2']);
    expect(after.filters[0]).toBe(before.filters[1]);
    expect(before.filters).toHaveLength(2);
  });

  it('sorts ascending on a new column and reverses on the sorted one', () => {
    const ascending = applyBacklogControl(EMPTY_BACKLOG_QUERY, { kind: 'sort-by', field: 'name' });
    expect(ascending.sort).toEqual({ field: 'name', direction: 'ascending' });

    const descending = applyBacklogControl(ascending, { kind: 'sort-by', field: 'name' });
    expect(descending.sort).toEqual({ field: 'name', direction: 'descending' });

    expect(applyBacklogControl(descending, { kind: 'sort-by', field: 'name' }).sort)
      .toEqual({ field: 'name', direction: 'ascending' });

    // Changing column starts at the beginning of the new column's order rather than
    // inheriting the direction the previous column was left in.
    expect(applyBacklogControl(descending, { kind: 'sort-by', field: 'weight' }).sort)
      .toEqual({ field: 'weight', direction: 'ascending' });
  });

  it('clears the sort, and the whole query, back to nothing', () => {
    const loaded = query({ search: 'alp', filters: [WEIGHT_TWO], sort: { field: 'name', direction: 'ascending' } });

    const unsorted = applyBacklogControl(loaded, { kind: 'clear-sort' });
    expect(unsorted.sort).toBeNull();
    expect(unsorted.search).toBe('alp');
    expect(unsorted.filters).toBe(loaded.filters);

    const cleared = applyBacklogControl(loaded, { kind: 'clear-query' });
    expect(cleared).toEqual(EMPTY_BACKLOG_QUERY);
    expect(loaded.search).toBe('alp');
  });

  it('never mutates the query it was given', () => {
    const before = query({ search: 'alp', filters: [WEIGHT_TWO], sort: { field: 'name', direction: 'ascending' } });
    const filters = before.filters;
    const snapshot = JSON.stringify(before);

    const controls: BacklogControl[] = [
      { kind: 'set-search', search: 'beta' },
      { kind: 'add-filter', filter: { id: 'filter-2', field: 'deadline', operator: 'is-empty' } },
      { kind: 'remove-filter', filterId: 'filter-1' },
      { kind: 'sort-by', field: 'weight' },
      { kind: 'clear-sort' },
      { kind: 'clear-query' },
    ];

    for (const control of controls) {
      applyBacklogControl(before, control);
      expect(JSON.stringify(before)).toBe(snapshot);
      expect(before.filters).toBe(filters);
    }
  });

  it('mints filter ids that are never already in use', () => {
    expect(nextBacklogFilterId([])).toBe('filter-1');

    expect(nextBacklogFilterId([
      { id: 'filter-1', field: 'name', operator: 'contains', value: 'a' },
      { id: 'filter-7', field: 'name', operator: 'contains', value: 'b' },
      { id: 'named-by-someone-else', field: 'name', operator: 'contains', value: 'c' },
    ])).toBe('filter-8');

    const minted = nextBacklogFilterId([WEIGHT_TWO]);
    expect([WEIGHT_TWO].some((filter) => filter.id === minted)).toBe(false);
  });
});

describe('Backlog filter menu', () => {
  it('offers every field, each with exactly the comparisons it admits', () => {
    const loaded = state([task({ id: 'a' })]);
    const menu = projectBacklog(loaded, loaded.projects[0]!, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: 'p1', query: EMPTY_BACKLOG_QUERY }).filterMenu;

    expect(menu.map((group) => group.field)).toEqual([...BACKLOG_FIELDS]);
    expect(menu.map((group) => group.label)).toEqual(BACKLOG_FIELDS.map((field) => BACKLOG_FIELD_LABELS[field]));

    for (const group of menu) {
      expect(group.options.map((option) => option.operator)).toEqual([...operatorsForField(group.field)]);
      expect(group.options.map((option) => option.expression)).toEqual(
        operatorsForField(group.field).map((operator) => encodeBacklogExpression(group.field, operator)),
      );
      expect(group.options.map((option) => option.label)).toEqual(
        operatorsForField(group.field).map((operator) => BACKLOG_OPERATOR_LABELS[operator]),
      );
    }
  });

  it('turns every comparison the menu offers into a filter the engine accepts', () => {
    for (const field of BACKLOG_FIELDS) {
      for (const operator of operatorsForField(field)) {
        const built = buildBacklogFilter([], encodeBacklogExpression(field, operator), sampleValue(field));

        expect(built.ok, `${field} ${operator}`).toBe(true);

        const filter = (built as { ok: true; filter: BacklogFilter }).filter;
        expect(filter.field).toBe(field);
        expect(filter.operator).toBe(operator);
        expect(filter.id).toBe('filter-1');

        // The engine's own check is what the menu's promises are measured against.
        expect(() => assertBacklogQuery({ ...EMPTY_BACKLOG_QUERY, filters: [filter] })).not.toThrow();

        // A comparison that takes a value must carry one, and one that does not must
        // leave the value absent rather than present-and-undefined.
        if (operatorTakesValue(operator)) expect(filter.value).not.toBeUndefined();
        else expect('value' in filter).toBe(false);
      }
    }
  });

  it('takes a number field as a number, because text would match nothing', () => {
    const built = buildBacklogFilter([], 'weight|greater-than', ' 2 ');

    expect(built.ok).toBe(true);
    const filter = (built as { ok: true; filter: BacklogFilter }).filter;
    expect(filter.value).toBe(2);

    const loaded = state([
      task({ id: 'light', weight: 1 }),
      task({ id: 'heavy', weight: 5 }),
    ]);

    const matched = projectBacklog(loaded, loaded.projects[0]!, {
      ...EMPTY_PROJECT_BACKLOG_VIEW,
      projectId: 'p1',
      query: query({ filters: [filter] }),
    });
    expect(matched.rows.map((row) => row.taskId)).toEqual(['heavy']);

    // The same comparison against the same text would match nothing, which is why the
    // menu's value is parsed rather than passed through.
    const asText = projectBacklog(loaded, loaded.projects[0]!, {
      ...EMPTY_PROJECT_BACKLOG_VIEW,
      projectId: 'p1',
      query: query({ filters: [{ id: 'filter-1', field: 'weight', operator: 'greater-than', value: '2' }] }),
    });
    expect(asText.rows).toEqual([]);
  });

  it('takes a boolean field as the comparison itself, and a text field as typed', () => {
    const completed = buildBacklogFilter([], 'isCompleted|is', 'ignored');
    expect(completed.ok && completed.filter.value).toBe(true);

    const notCompleted = buildBacklogFilter([], 'isCompleted|is-not', '');
    expect(notCompleted.ok && notCompleted.filter.value).toBe(false);

    const status = buildBacklogFilter([], 'status|is', 'running');
    expect(status.ok && status.filter.value).toBe('running');
  });

  it('says why a request cannot become a filter instead of throwing', () => {
    const refusals: readonly (readonly [string, string, RegExp])[] = [
      ['name', 'alp', /is not a filter/],
      ['nope|is', 'alp', /is not a filterable field/],
      ['name|less-than', 'alp', /Name does not support that comparison/],
      ['weight|greater-than', 'many', /"many" is not a number/],
      ['weight|greater-than', '', /Weight needs a number/],
    ];

    for (const [expression, raw, expected] of refusals) {
      const built = buildBacklogFilter([], expression, raw);

      expect(built.ok, expression).toBe(false);
      expect(built.ok ? '' : built.reason).toMatch(expected);
    }
  });

  it('gives a filter id that does not collide with the ones already in the query', () => {
    const built = buildBacklogFilter(
      [
        { id: 'filter-1', field: 'name', operator: 'contains', value: 'a' },
        { id: 'filter-2', field: 'name', operator: 'contains', value: 'b' },
      ],
      'isCompleted|is',
      '',
    );

    expect(built.ok && built.filter.id).toBe('filter-3');
  });
});

describe('Backlog control markup', () => {
  const loaded = state([
    task({ id: 'alpha', name: 'Alpha', weight: 5, orderIndex: 1 }),
    task({ id: 'beta', name: 'Beta', weight: 1, orderIndex: 0 }),
  ]);
  const p1 = loaded.projects[0]!;

  it('offers the controls even before any query is active', () => {
    const html = renderProjectBacklog(loaded, p1, view());

    expect(html).toContain('data-project-backlog-controls');
    expect(html).toContain('data-project-backlog-search-input');
    expect(html).toContain('data-project-backlog-filter-builder');
    expect(html).toContain('data-project-backlog-action="add-filter"');
    expect(html).toContain('data-project-backlog-sort-controls');

    // The menu's options are the engine's own pairs, field by field.
    expect(html).toContain('<option value="name|contains">contains</option>');
    expect(html).toContain('<option value="weight|greater-than">&gt;</option>');
    expect(html).toContain('<optgroup label="Deadline">');

    // No query yet, so there is nothing to clear and no sort to clear.
    expect(html).toContain('data-project-backlog-action="clear-query" data-c1-key="project-backlog-clear-query" disabled');
    expect(html).not.toContain('data-project-backlog-action="clear-sort"');
  });

  it('shows the search text in the field that produced it', () => {
    const html = renderProjectBacklog(loaded, p1, view({ search: 'alp' }));

    expect(html).toContain('data-project-backlog-search-input data-c1-key="project-backlog-search-input" value="alp"');
    expect(html).toContain('data-project-backlog-action="clear-query" data-c1-key="project-backlog-clear-query">Clear query');
  });

  it('carries the id a chip removes and the field a column sorts by', () => {
    const html = renderProjectBacklog(loaded, p1, view({ filters: [WEIGHT_TWO], sort: { field: 'weight', direction: 'descending' } }));

    expect(html).toContain('data-project-backlog-filter-remove="filter-1"');
    expect(html).toContain('aria-label="Remove filter Weight &gt; 2"');
    expect(html).toContain('data-project-backlog-sort-by="weight" data-c1-key="project-backlog-sort-weight" data-project-backlog-sorted="descending" aria-pressed="true"');
    expect(html).toContain('data-project-backlog-action="clear-sort"');
  });

  it('removes the filter a chip names, all the way to the rendered list', () => {
    const before = view({ filters: [WEIGHT_TWO] });
    const projectedBefore = projectBacklog(loaded, p1, before);
    expect(projectedBefore.rows.map((row) => row.taskId)).toEqual(['alpha']);

    const after = { ...before, query: applyBacklogControl(before.query, { kind: 'remove-filter', filterId: 'filter-1' }) };
    const html = renderProjectBacklog(loaded, p1, after);

    expect(html).not.toContain('data-project-backlog-filter-chip');
    expect(html).not.toContain('data-project-backlog-filter-remove');
    expect(html).toContain('data-project-backlog-task-id="beta"');
    expect(html).toContain('2 project tasks · order writes unavailable');
  });

  it('says why a value could not become a filter, and keeps the query it had', () => {
    const built = buildBacklogFilter([], 'weight|greater-than', 'many');
    const refused = renderProjectBacklog(loaded, p1, {
      ...view(),
      queryRefusal: built.ok ? '' : built.reason,
    });

    expect(refused).toContain('data-project-backlog-query-refusal="&quot;many&quot; is not a number"');
    expect(refused).toContain('&quot;many&quot; is not a number');
  });

  it('escapes what a search or a filter carries into markup', () => {
    const html = renderProjectBacklog(loaded, p1, view({
      search: '"onmouseover="x',
      filters: [{ id: 'filter-1', field: 'name', operator: 'contains', value: '<script>' }],
    }));

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;onmouseover=&quot;x');
  });
});

describe('Search, filter and sort never mutate records', () => {
  it('leaves every record exactly as it was, through a whole session of controls', () => {
    const loaded = state([
      task({ id: 'alpha', name: 'Alpha', weight: 5, orderIndex: 1, properties: { area: 'work' } }),
      task({ id: 'beta', name: 'Beta', weight: 1, orderIndex: 0, isCompleted: true }),
      task({ id: 'gamma', name: 'Gamma', description: 'Alpha in the text', weight: 3, orderIndex: 2, deadline: '2026-05-01T00:00:00.000Z' }),
    ]);
    const p1 = loaded.projects[0]!;

    const before = JSON.stringify(loaded);
    const taskRefs = [...loaded.tasks];
    const taskKeys = loaded.tasks.map((record) => Object.keys(record).join(','));

    let active: ProjectBacklogViewState = { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: 'p1' };

    const controls: BacklogControl[] = [
      { kind: 'set-search', search: 'alpha' },
      { kind: 'add-filter', filter: { id: 'filter-1', field: 'weight', operator: 'greater-than', value: 2 } },
      { kind: 'sort-by', field: 'weight' },
      { kind: 'sort-by', field: 'weight' },
      { kind: 'set-search', search: '' },
      { kind: 'remove-filter', filterId: 'filter-1' },
      { kind: 'add-filter', filter: { id: 'filter-2', field: 'name', operator: 'contains', value: 'a' } },
      { kind: 'clear-query' },
    ];

    for (const control of controls) {
      const queryBefore = active.query;
      active = { ...active, query: applyBacklogControl(queryBefore, control) };

      // Both halves of the read path run for every control: the projection the app
      // uses and the markup the browser is shown.
      const projected = projectBacklog(loaded, p1, active);
      renderProjectBacklog(loaded, p1, active);

      expect(projected.totalCount).toBe(3);
      expect(projected.visibleCount).toBeLessThanOrEqual(3);
    }

    expect(JSON.stringify(loaded)).toBe(before);
    expect(loaded.tasks).toHaveLength(taskRefs.length);
    loaded.tasks.forEach((record, index) => {
      expect(record).toBe(taskRefs[index]);
      expect(Object.keys(record).join(',')).toBe(taskKeys[index]);
    });
    expect(loaded.projects[0]).toBe(p1);

    // The filters array is replaced rather than edited, so a render already holding the
    // previous query keeps showing the previous query.
    const held = query({ filters: [WEIGHT_TWO] });
    const next = applyBacklogControl(held, { kind: 'add-filter', filter: { id: 'filter-2', field: 'name', operator: 'contains', value: 'a' } });
    expect(next.filters).not.toBe(held.filters);
    expect(held.filters).toHaveLength(1);
  });
});
