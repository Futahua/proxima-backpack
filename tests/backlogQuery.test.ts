/**
 * Backlog query contracts: what the search matches, which operators each field
 * admits, how typed comparisons behave, how filters combine and come off, and
 * the ordering rules — including where a missing value lands.
 *
 * These assertions are what the Backlog's search/filter/sort boxes rest on. They
 * are deliberately about meaning rather than rendering: the browser layer that
 * draws a filtered table is not unit-tested anywhere in this repository, so a
 * claim about pixels would not be evidence.
 */

import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  applyBacklogQuery,
  BacklogQueryError,
  EMPTY_BACKLOG_QUERY,
  matchesFilter,
  matchesSearch,
  operatorTakesValue,
  operatorsForField,
  removeBacklogFilter,
  type BacklogFilter,
  type BacklogQuery,
} from '../src/domain/backlogQuery.js';

import type {
  Task,
} from '../src/domain/types.js';

/** A task with every field defaulted, so each test states only what it means. */
function task(
  overrides:
    Partial<Task>
    & {
      id:
        string;
    },
): Task {
  return {
    source: {
      path:
        `Proxima/tasks/${overrides.id}.md`,
      revision:
        'rev-1',
      kind:
        'task',
      idOrigin:
        'frontmatter',
    },
    name:
      overrides.id,
    description:
      '',
    projectId:
      null,
    status:
      'running',
    weight:
      1,
    orderIndex:
      0,
    isFixedDuration:
      false,
    fixedDuration:
      null,
    maxDuration:
      null,
    isCompleted:
      false,
    createdAt:
      '2026-01-01T00:00:00.000Z',
    startDate:
      null,
    deadline:
      null,
    properties:
      {},
    ...overrides,
  };
}

function filter(
  id:
    string,
  field:
    BacklogFilter['field'],
  operator:
    BacklogFilter['operator'],
  value?:
    string
    | number
    | boolean,
): BacklogFilter {
  return value
    === undefined
    ? {
        id,
        field,
        operator,
      }
    : {
        id,
        field,
        operator,
        value,
      };
}

function query(
  overrides:
    Partial<BacklogQuery>,
): BacklogQuery {
  return {
    ...EMPTY_BACKLOG_QUERY,
    ...overrides,
  };
}

describe(
  'Backlog search',
  () => {
    it(
      'matches everything for an empty or whitespace-only query',
      () => {
        const subject =
          task({
            id:
              'a',
            name:
              'Anything',
          });

        expect(
          matchesSearch(
            subject,
            '',
          ),
        ).toBe(
          true,
        );

        expect(
          matchesSearch(
            subject,
            '   ',
          ),
        ).toBe(
          true,
        );

        expect(
          applyBacklogQuery(
            [
              subject,
            ],
            EMPTY_BACKLOG_QUERY,
          ),
        ).toHaveLength(
          1,
        );
      },
    );

    it(
      'matches name and description case-insensitively, and nothing else',
      () => {
        const subject =
          task({
            id:
              'a',
            name:
              'Write the Release Notes',
            description:
              'Covers the migration',
          });

        expect(
          matchesSearch(
            subject,
            'release',
          ),
        ).toBe(
          true,
        );

        expect(
          matchesSearch(
            subject,
            'MIGRATION',
          ),
        ).toBe(
          true,
        );

        // The id and the source path are not searchable text: a task must not
        // surface because its filename happens to contain the query.
        expect(
          matchesSearch(
            subject,
            'a.md',
          ),
        ).toBe(
          false,
        );

        expect(
          matchesSearch(
            subject,
            'absent',
          ),
        ).toBe(
          false,
        );
      },
    );
  },
);

describe(
  'Backlog filter operators',
  () => {
    it(
      'offers each field only the comparisons its type admits',
      () => {
        const text =
          operatorsForField(
            'name',
          );

        expect(
          text,
        ).toContain(
          'contains',
        );

        expect(
          text,
        ).not.toContain(
          'less-than',
        );

        expect(
          text,
        ).not.toContain(
          'before',
        );

        const number =
          operatorsForField(
            'weight',
          );

        expect(
          number,
        ).toContain(
          'less-than',
        );

        expect(
          number,
        ).toContain(
          'greater-than',
        );

        expect(
          number,
        ).not.toContain(
          'contains',
        );

        const dates =
          operatorsForField(
            'deadline',
          );

        expect(
          dates,
        ).toContain(
          'before',
        );

        expect(
          dates,
        ).toContain(
          'after',
        );

        expect(
          dates,
        ).not.toContain(
          'less-than',
        );

        expect(
          operatorsForField(
            'isCompleted',
          ),
        ).toEqual([
          'is',
          'is-not',
        ]);

        // Every field offers something, so no field can be filtered into a
        // control with no choices.
        for (
          const field
          of [
            'name',
            'description',
            'status',
            'weight',
            'fixedDuration',
            'maxDuration',
            'startDate',
            'deadline',
            'isCompleted',
          ] as const
        ) {
          expect(
            operatorsForField(
              field,
            ).length,
          ).toBeGreaterThan(
            0,
          );
        }
      },
    );

    it(
      'knows which operators test a value',
      () => {
        expect(
          operatorTakesValue(
            'is-empty',
          ),
        ).toBe(
          false,
        );

        expect(
          operatorTakesValue(
            'is-not-empty',
          ),
        ).toBe(
          false,
        );

        expect(
          operatorTakesValue(
            'contains',
          ),
        ).toBe(
          true,
        );
      },
    );

    it(
      'refuses a query it cannot mean rather than skipping the filter',
      () => {
        expect(
          () =>
            applyBacklogQuery(
              [],
              query({
                filters: [
                  filter(
                    'f1',
                    'name',
                    'less-than',
                    'x',
                  ),
                ],
              }),
            ),
        ).toThrow(
          BacklogQueryError,
        );

        expect(
          () =>
            applyBacklogQuery(
              [],
              query({
                filters: [
                  filter(
                    'f1',
                    'name',
                    'less-than',
                    'x',
                  ),
                ],
              }),
            ),
        ).toThrow(
          /does not support "less-than"/,
        );

        expect(
          () =>
            applyBacklogQuery(
              [],
              query({
                filters: [
                  filter(
                    'f1',
                    'weight',
                    'is',
                  ),
                ],
              }),
            ),
        ).toThrow(
          /needs a value/,
        );

        // Presence tests need no value, so they are accepted without one.
        expect(
          () =>
            applyBacklogQuery(
              [],
              query({
                filters: [
                  filter(
                    'f1',
                    'deadline',
                    'is-empty',
                  ),
                ],
              }),
            ),
        ).not.toThrow();
      },
    );
  },
);

describe(
  'Backlog typed comparisons',
  () => {
    it(
      'compares numbers numerically, not as text',
      () => {
        const nine =
          task({
            id:
              'nine',
            weight:
              9,
          });

        const ten =
          task({
            id:
              'ten',
            weight:
              10,
          });

        expect(
          matchesFilter(
            nine,
            filter(
              'f',
              'weight',
              'less-than',
              10,
            ),
          ),
        ).toBe(
          true,
        );

        // Lexically "9" > "10", which is the mistake this pins down.
        expect(
          matchesFilter(
            ten,
            filter(
              'f',
              'weight',
              'greater-than',
              9,
            ),
          ),
        ).toBe(
          true,
        );

        expect(
          matchesFilter(
            nine,
            filter(
              'f',
              'weight',
              'is',
              '9',
            ),
          ),
        ).toBe(
          false,
        );
      },
    );

    it(
      'compares dates as instants, not as strings',
      () => {
        const subject =
          task({
            id:
              'a',
            deadline:
              '2026-09-09T00:00:00.000Z',
          });

        expect(
          matchesFilter(
            subject,
            filter(
              'f',
              'deadline',
              'before',
              '2026-10-01T00:00:00.000Z',
            ),
          ),
        ).toBe(
          true,
        );

        expect(
          matchesFilter(
            subject,
            filter(
              'f',
              'deadline',
              'after',
              '2026-10-01T00:00:00.000Z',
            ),
          ),
        ).toBe(
          false,
        );

        // Same instant, different spelling of it.
        expect(
          matchesFilter(
            subject,
            filter(
              'f',
              'deadline',
              'is',
              '2026-09-09T07:00:00+07:00',
            ),
          ),
        ).toBe(
          true,
        );
      },
    );

    it(
      'never equates a boolean with its string spelling',
      () => {
        const done =
          task({
            id:
              'a',
            isCompleted:
              true,
          });

        expect(
          matchesFilter(
            done,
            filter(
              'f',
              'isCompleted',
              'is',
              true,
            ),
          ),
        ).toBe(
          true,
        );

        expect(
          matchesFilter(
            done,
            filter(
              'f',
              'isCompleted',
              'is',
              'true',
            ),
          ),
        ).toBe(
          false,
        );

        expect(
          matchesFilter(
            done,
            filter(
              'f',
              'isCompleted',
              'is-not',
              false,
            ),
          ),
        ).toBe(
          true,
        );
      },
    );

    it(
      'treats null and blank text as empty, and a real value as present',
      () => {
        const blank =
          task({
            id:
              'blank',
            description:
              '   ',
            deadline:
              null,
          });

        const filled =
          task({
            id:
              'filled',
            description:
              'Something',
            deadline:
              '2026-01-02T00:00:00.000Z',
          });

        expect(
          matchesFilter(
            blank,
            filter(
              'f',
              'description',
              'is-empty',
            ),
          ),
        ).toBe(
          true,
        );

        expect(
          matchesFilter(
            blank,
            filter(
              'f',
              'deadline',
              'is-empty',
            ),
          ),
        ).toBe(
          true,
        );

        expect(
          matchesFilter(
            filled,
            filter(
              'f',
              'deadline',
              'is-not-empty',
            ),
          ),
        ).toBe(
          true,
        );
      },
    );
  },
);

describe(
  'Backlog query composition',
  () => {
    const tasks =
      [
        task({
          id:
            'alpha',
          name:
            'Alpha',
          weight:
            5,
        }),
        task({
          id:
            'beta',
          name:
            'Beta',
          weight:
            1,
        }),
        task({
          id:
            'gamma',
          name:
            'Gamma',
          weight:
            9,
        }),
      ];

    it(
      'conjoins search and every filter',
      () => {
        const result =
          applyBacklogQuery(
            tasks,
            query({
              search:
                'a',
              filters: [
                filter(
                  'f1',
                  'weight',
                  'greater-than',
                  2,
                ),
                filter(
                  'f2',
                  'isCompleted',
                  'is',
                  false,
                ),
              ],
            }),
          );

        // "a" matches Alpha and Gamma; weight > 2 keeps both; both are open.
        expect(
          result.map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'alpha',
          'gamma',
        ] );
      },
    );

    it(
      'removes one filter by id and leaves the rest untouched',
      () => {
        const before =
          query({
            search:
              'a',
            filters: [
              filter(
                'f1',
                'weight',
                'greater-than',
                2,
              ),
              filter(
                'f2',
                'isCompleted',
                'is',
                false,
              ),
            ],
          });

        const after =
          removeBacklogFilter(
            before,
            'f1',
          );

        expect(
          after.filters.map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'f2',
        ] );

        expect(
          after.search,
        ).toBe(
          'a',
        );

        // The original query is untouched: removal is not a mutation.
        expect(
          before.filters,
        ).toHaveLength(
          2,
        );

        // Removing something already gone is the outcome the caller wanted.
        expect(
          removeBacklogFilter(
            after,
            'f1',
          ).filters,
        ).toHaveLength(
          1,
        );
      },
    );

    it(
      'never mutates the tasks or the array it was given',
      () => {
        const input =
          [
            ...tasks,
          ];

        const result =
          applyBacklogQuery(
            input,
            query({
              sort: {
                field:
                  'weight',
                direction:
                  'descending',
              },
            }),
          );

        expect(
          input.map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'alpha',
          'beta',
          'gamma',
        ] );

        expect(
          result,
        ).not.toBe(
          input,
        );

        for (
          const entry
          of input
        ) {
          expect(
            Object.isFrozen(
              entry,
            ),
          ).toBe(
            false,
          );
        }
      },
    );
  },
);

describe(
  'Backlog sorting',
  () => {
    it(
      'orders ascending and descending by a numeric field',
      () => {
        const tasks =
          [
            task({
              id:
                'a',
              weight:
                5,
            }),
            task({
              id:
                'b',
              weight:
                1,
            }),
            task({
              id:
                'c',
              weight:
                9,
            }),
          ];

        expect(
          applyBacklogQuery(
            tasks,
            query({
              sort: {
                field:
                  'weight',
                direction:
                  'ascending',
              },
            }),
          ).map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'b',
          'a',
          'c',
        ] );

        expect(
          applyBacklogQuery(
            tasks,
            query({
              sort: {
                field:
                  'weight',
                direction:
                  'descending',
              },
            }),
          ).map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'c',
          'a',
          'b',
        ] );
      },
    );

    it(
      'orders text case-insensitively',
      () => {
        const tasks =
          [
            task({
              id:
                'b',
              name:
                'beta',
            }),
            task({
              id:
                'a',
              name:
                'Alpha',
            }),
            task({
              id:
                'c',
              name:
                'Gamma',
            }),
          ];

        expect(
          applyBacklogQuery(
            tasks,
            query({
              sort: {
                field:
                  'name',
                direction:
                  'ascending',
              },
            }),
          ).map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'a',
          'b',
          'c',
        ] );
      },
    );

    it(
      'sorts a missing value last ascending and first descending',
      () => {
        const tasks =
          [
            task({
              id:
                'none',
              deadline:
                null,
            }),
            task({
              id:
                'later',
              deadline:
                '2026-12-01T00:00:00.000Z',
            }),
            task({
              id:
                'sooner',
              deadline:
                '2026-02-01T00:00:00.000Z',
            }),
          ];

        expect(
          applyBacklogQuery(
            tasks,
            query({
              sort: {
                field:
                  'deadline',
                direction:
                  'ascending',
              },
            }),
          ).map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'sooner',
          'later',
          'none',
        ] );

        expect(
          applyBacklogQuery(
            tasks,
            query({
              sort: {
                field:
                  'deadline',
                direction:
                  'descending',
              },
            }),
          ).map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'none',
          'later',
          'sooner',
        ] );
      },
    );

    it(
      'is a total order, so equal keys never swap between runs',
      () => {
        const tied =
          [
            task({
              id:
                'second',
              weight:
                4,
              orderIndex:
                2,
            }),
            task({
              id:
                'first',
              weight:
                4,
              orderIndex:
                1,
            }),
            task({
              id:
                'same-order-a',
              weight:
                4,
              orderIndex:
                0,
            }),
            task({
              id:
                'same-order-b',
              weight:
                4,
              orderIndex:
                0,
            }),
          ];

        const order =
          applyBacklogQuery(
            tied,
            query({
              sort: {
                field:
                  'weight',
                direction:
                  'ascending',
              },
            }),
          ).map(
            (entry) =>
              entry.id,
          );

        // Ties fall back to orderIndex, then id — a deterministic total order.
        expect(
          order,
        ).toEqual([
          'same-order-a',
          'same-order-b',
          'first',
          'second',
        ] );

        // Re-running over the same input yields the same order.
        expect(
          applyBacklogQuery(
            tied,
            query({
              sort: {
                field:
                  'weight',
                direction:
                  'ascending',
              },
            }),
          ).map(
            (entry) =>
              entry.id,
          ),
        ).toEqual(
          order,
        );
      },
    );

    it(
      'keeps the caller order when no sort is requested',
      () => {
        const tasks =
          [
            task({
              id:
                'z',
              orderIndex:
                9,
            }),
            task({
              id:
                'a',
              orderIndex:
                0,
            }),
          ];

        expect(
          applyBacklogQuery(
            tasks,
            EMPTY_BACKLOG_QUERY,
          ).map(
            (entry) =>
              entry.id,
          ),
        ).toEqual([
          'z',
          'a',
        ] );
      },
    );
  },
);
