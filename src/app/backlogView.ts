/**
 * The Backlog view model.
 *
 * One pure projection turns loaded state plus a Backlog view state into
 * everything the Backlog draws: the rows, the columns, the sort indicator, the
 * filter chips and why the list is empty. The renderer consumes this and decides
 * nothing — which is what makes the Backlog's search, filter and sort behaviour
 * verifiable without a browser.
 *
 * @module app/backlogView
 */

import {
  applyBacklogQuery,
  BACKLOG_FIELDS,
  EMPTY_BACKLOG_QUERY,
  operatorsForField,
  type BacklogField,
  type BacklogFilter,
  type BacklogOperator,
  type BacklogQuery,
  type BacklogSort,
} from '../domain/backlogQuery.js';

import {
  BACKLOG_FIELD_LABELS,
  BACKLOG_OPERATOR_LABELS,
  encodeBacklogExpression,
} from './backlogControls.js';

import type {
  Project,
  PropertySchema,
  ProximaState,
  Task,
} from '../domain/types.js';

/** The Backlog's own view state, including the query it is showing. */
export interface BacklogViewState {
  readonly projectId:
    string | null;

  readonly selectedTaskId:
    string | null;

  readonly query:
    BacklogQuery;
}

export const EMPTY_BACKLOG_VIEW:
  BacklogViewState = {
    projectId:
      null,
    selectedTaskId:
      null,
    query:
      EMPTY_BACKLOG_QUERY,
  };

/** A column the Backlog can show. A field column sorts; a property column does not yet. */
export interface BacklogColumn {
  readonly id:
    string;

  readonly label:
    string;

  readonly field:
    BacklogField | null;

  readonly propertyKey:
    string | null;
}

export interface BacklogCell {
  readonly columnId:
    string;

  readonly text:
    string;

  readonly empty:
    boolean;
}

export interface BacklogRow {
  readonly taskId:
    string;

  readonly name:
    string;

  readonly description:
    string;

  readonly deadline:
    string | null;

  readonly completed:
    boolean;

  /** The legacy order index, which the row element has always carried. */
  readonly orderIndex:
    number;

  readonly cells:
    readonly BacklogCell[];
}

/** One active filter, as a chip the creator can read and remove. */
export interface BacklogFilterChip {
  readonly id:
    string;

  readonly field:
    BacklogField;

  readonly operator:
    BacklogOperator;

  readonly label:
    string;
}

/**
 * One comparison a filter menu offers. `expression` is the single value the menu
 * carries for the pair, so adding a filter needs no draft state in the view.
 */
export interface BacklogFilterOption {
  readonly expression:
    string;

  readonly field:
    BacklogField;

  readonly operator:
    BacklogOperator;

  readonly label:
    string;
}

/** One field's worth of a filter menu. */
export interface BacklogFilterMenuGroup {
  readonly field:
    BacklogField;

  readonly label:
    string;

  readonly options:
    readonly BacklogFilterOption[];
}

export interface BacklogProjection {
  readonly projectId:
    string;

  readonly columns:
    readonly BacklogColumn[];

  readonly rows:
    readonly BacklogRow[];

  /** Tasks in the project, before the query. */
  readonly totalCount:
    number;

  /** Tasks the query left visible. */
  readonly visibleCount:
    number;

  readonly search:
    string;

  readonly sortIndicator:
    BacklogSort | null;

  /** The filter menu, offering each field and only the comparisons it admits. */
  readonly filterMenu:
    readonly BacklogFilterMenuGroup[];

  readonly filterChips:
    readonly BacklogFilterChip[];

  /**
   * `no-tasks` — the project has nothing to show.
   * `no-matches` — it has tasks and the query hid them all, which is a different
   * sentence to put in front of a reader.
   */
  readonly emptyReason:
    | 'no-tasks'
    | 'no-matches'
    | null;
}

/**
 * The order the Backlog shows its columns in: the task fields, without
 * `description`, which every row already carries under its name. The filter menu's
 * field order is {@link BACKLOG_FIELDS}, which does include it.
 */
const FIELD_ORDER:
  readonly BacklogField[] = [
    'name',
    'status',
    'weight',
    'fixedDuration',
    'maxDuration',
    'startDate',
    'deadline',
    'isCompleted',
  ];

/** The order the Backlog has always shown: legacy order, then id. */
function byLegacyOrder(
  left:
    Task,
  right:
    Task,
): number {
  return (
    Number(
      left.orderIndex,
    ) || 0
  ) - (
    Number(
      right.orderIndex,
    ) || 0
  ) || left.id
    .localeCompare(
      right.id,
    );
}

/** How one field reads in a cell. A missing value is empty rather than "null". */
function cellText(
  task:
    Task,
  field:
    BacklogField,
): {
  readonly text:
    string;
  readonly empty:
    boolean;
} {
  switch (
    field
  ) {
    case 'isCompleted':
      return {
        text:
          task.isCompleted
            ? 'Yes'
            : 'No',
        empty:
          false,
      };

    case 'weight':
      return {
        text:
          String(
            task.weight,
          ),
        empty:
          false,
      };

    case 'fixedDuration':
    case 'maxDuration': {
      const minutes =
        field
          === 'fixedDuration'
          ? task.fixedDuration
          : task.maxDuration;

      return minutes
        === null
        ? {
            text:
              '',
            empty:
              true,
          }
        : {
            text:
              `${minutes} min`,
            empty:
              false,
          };
    }

    case 'startDate':
    case 'deadline': {
      const value =
        field
          === 'startDate'
          ? task.startDate
          : task.deadline;

      const blank =
        value
        === null
        || value
          .trim()
          .length
          === 0;

      return {
        text:
          blank
            ? ''
            : String(
                value,
              ),
        empty:
          blank,
      };
    }

    default: {
      const value =
        field
          === 'name'
          ? task.name
          : field
              === 'description'
            ? task.description
            : task.status;

      const blank =
        value
          .trim()
          .length
          === 0;

      return {
        text:
          blank
            ? ''
            : value,
        empty:
          blank,
      };
    }
  }
}

/** A property value as a cell reads it. */
function propertyText(
  value:
    unknown,
): {
  readonly text:
    string;
  readonly empty:
    boolean;
} {
  if (
    value
    === undefined
    || value
      === null
  ) {
    return {
      text:
        '',
      empty:
        true,
    };
  }

  if (
    Array.isArray(
      value,
    )
  ) {
    return value
      .length
      === 0
      ? {
          text:
            '',
          empty:
            true,
        }
      : {
          text:
            value
              .map(
                (entry) =>
                  String(
                    entry,
                  ),
              )
              .join(
                ', ',
              ),
          empty:
            false,
        };
  }

  const text =
    String(
      value,
    );

  return {
    text,
    empty:
      text
        .trim()
        .length
        === 0,
  };
}

/**
 * The columns: the fixed task fields, then one column per custom property any
 * task in the project declares, so a property column appears because the data
 * has it rather than because a list somewhere was edited.
 */
function columnsFor(
  tasks:
    readonly Task[],
  schema:
    readonly PropertySchema[],
): BacklogColumn[] {
  const propertyKeys =
    new Set<
      string
    >();

  for (
    const task
    of tasks
  ) {
    for (
      const key
      of Object.keys(
        task.properties,
      )
    ) {
      propertyKeys.add(
        key,
      );
    }
  }

  return [
    ...FIELD_ORDER.map(
      (field) => ({
        id:
          `field:${field}`,
        label:
          BACKLOG_FIELD_LABELS[field],
        field,
        propertyKey:
          null,
      }),
    ),
    ...[
      ...propertyKeys,
    ]
      .sort(
        (left, right) =>
          left.localeCompare(
            right,
          ),
      )
      .map(
        (key) => ({
          id:
            `property:${key}`,
          label:
            schema.find((declared) => declared.id === key)?.name ?? key,
          field:
            null,
          propertyKey:
            key,
        }),
      ),
  ];
}

/** One chip's text, so a reader sees the filter rather than its object shape. */
function chipLabel(
  filter:
    BacklogFilter,
): string {
  const field =
    BACKLOG_FIELD_LABELS[filter.field];

  const operator =
    BACKLOG_OPERATOR_LABELS[filter.operator];

  return filter.value
    === undefined
    ? `${field} ${operator}`
    : `${field} ${operator} ${String(filter.value)}`;
}

/**
 * The filter menu: every field, each offering exactly the comparisons it admits.
 *
 * Built from the same operator table the matcher uses, and labelled from the same
 * tables the chips are labelled from, so a menu cannot offer a comparison that would
 * be refused and a chip cannot describe a filter differently from the menu that built
 * it.
 */
function filterMenuFor(): BacklogFilterMenuGroup[] {
  return BACKLOG_FIELDS.map(
    (field) => ({
      field,
      label:
        BACKLOG_FIELD_LABELS[field],
      options:
        operatorsForField(
          field,
        ).map(
          (operator) => ({
            expression:
              encodeBacklogExpression(
                field,
                operator,
              ),
            field,
            operator,
            label:
              BACKLOG_OPERATOR_LABELS[operator],
          }),
        ),
    }),
  );
}

/**
 * Project one Backlog view.
 * @param state - the loaded state.
 * @param project - the project whose Backlog is shown.
 * @param view - the view state, carrying the query.
 * @returns everything the Backlog draws.
 */
export function projectBacklog(
  state:
    ProximaState,
  project:
    Project,
  view:
    BacklogViewState,
): BacklogProjection {
  const tasks =
    state.tasks
      .filter(
        (task) =>
          task.projectId
          === project.id,
      )
      .sort(
        byLegacyOrder,
      );

  const visible =
    applyBacklogQuery(
      tasks,
      view.query,
    );

  const columns =
    columnsFor(
      tasks,
      state.taskSchema,
    );

  const rows =
    visible.map(
      (task) => ({
        taskId:
          task.id,
        name:
          task.name,
        description:
          task.description,
        deadline:
          task.deadline,
        completed:
          task.isCompleted,
        orderIndex:
          Number(
            task.orderIndex,
          ) || 0,
        cells:
          columns.map(
            (column) =>
              column.propertyKey
              === null
                ? {
                    columnId:
                      column.id,
                    ...cellText(
                      task,
                      column.field!,
                    ),
                  }
                : {
                    columnId:
                      column.id,
                    ...propertyText(
                      task.properties[
                        column
                          .propertyKey!
                      ],
                    ),
                  },
          ),
      }),
    );

  const emptyReason =
    tasks.length
    === 0
      ? 'no-tasks'
      : visible.length
          === 0
        ? 'no-matches'
        : null;

  return {
    projectId:
      project.id,
    columns,
    rows,
    totalCount:
      tasks.length,
    visibleCount:
      visible.length,
    search:
      view.query.search,
    sortIndicator:
      view.query.sort,
    filterMenu:
      filterMenuFor(),
    filterChips:
      view.query.filters.map(
        (filter) => ({
          id:
            filter.id,
          field:
            filter.field,
          operator:
            filter.operator,
          label:
            chipLabel(
              filter,
            ),
        }),
      ),
    emptyReason,
  };
}
