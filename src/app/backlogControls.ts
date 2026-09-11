/**
 * The Backlog's query controls, as values.
 *
 * Typing in search, adding a filter, removing a filter, sorting by a column and
 * clearing the query are all pure transitions from one `BacklogQuery` to the next.
 * A control is a plain value rather than a callback, so the browser layer only has to
 * turn an event into a control and render again, and what the controls *do* is
 * verifiable without a DOM.
 *
 * Two contracts hold for every control:
 *
 * - the query it is given is never modified, nor is anything the query points at;
 * - a control that cannot change what the query means returns that same query, so a
 *   caller may compare references to decide whether anything happened.
 *
 * The one way a control fails is a filter that cannot mean anything: an operator its
 * field does not admit, or a value-taking operator with no value. That raises
 * `BacklogQueryError` and leaves the caller's query alone, because a silently dropped
 * filter looks exactly like a filter that matched everything.
 *
 * This module also owns the words the Backlog's controls are made of: the labels a
 * field and an operator are shown with, and the `field|operator` expression a filter
 * menu carries as one value. The projection and the filter menu both read them here,
 * so a chip and the menu that produced it cannot describe the same filter differently.
 *
 * @module app/backlogControls
 */

import {
  assertBacklogQuery,
  EMPTY_BACKLOG_QUERY,
  isBacklogField,
  operatorTakesValue,
  operatorsForField,
  removeBacklogFilter,
  valueTypeForField,
  type BacklogField,
  type BacklogFilter,
  type BacklogOperator,
  type BacklogQuery,
} from '../domain/backlogQuery.js';

/** The filter ids this module mints, so a minted id is recognisable and ordinate. */
const FILTER_ID_PATTERN =
  /^filter-(\d+)$/;

/** How a field is named in a column header, a chip and a filter menu. */
export const BACKLOG_FIELD_LABELS:
  Readonly<
    Record<
      BacklogField,
      string
    >
  > = {
    name:
      'Name',
    description:
      'Description',
    status:
      'Status',
    weight:
      'Weight',
    fixedDuration:
      'Fixed duration',
    maxDuration:
      'Max duration',
    startDate:
      'Start',
    deadline:
      'Deadline',
    isCompleted:
      'Completed',
  };

/** How an operator is named in a chip and a filter menu. */
export const BACKLOG_OPERATOR_LABELS:
  Readonly<
    Record<
      BacklogOperator,
      string
    >
  > = {
    contains:
      'contains',
    is:
      'is',
    'is-not':
      'is not',
    'less-than':
      '<',
    'greater-than':
      '>',
    before:
      'before',
    after:
      'after',
    'is-empty':
      'is empty',
    'is-not-empty':
      'is not empty',
  };

/** Everything a Backlog control may ask of the query. */
export type BacklogControl =
  | {
      readonly kind:
        'set-search';
      readonly search:
        string;
    }
  | {
      readonly kind:
        'add-filter';
      readonly filter:
        BacklogFilter;
    }
  | {
      readonly kind:
        'remove-filter';
      readonly filterId:
        string;
    }
  | {
      readonly kind:
        'sort-by';
      readonly field:
        BacklogField;
    }
  | {
      readonly kind:
        'clear-sort';
    }
  | {
      readonly kind:
        'clear-query';
    };

/**
 * Whether two filters would filter identically. The id is compared too: it addresses
 * one filter, so a filter carrying a different id is a different filter even when it
 * would match the same tasks.
 */
function sameFilter(
  left:
    BacklogFilter,
  right:
    BacklogFilter | undefined,
): boolean {
  return right !== undefined
    && left.id === right.id
    && left.field === right.field
    && left.operator === right.operator
    && Object.is(
      left.value,
      right.value,
    );
}

/** Whether the query asks for nothing at all. */
function isEmptyQuery(
  query:
    BacklogQuery,
): boolean {
  return query.search === ''
    && query.filters.length === 0
    && query.sort === null;
}

/**
 * Apply one control to a query.
 *
 * `sort-by` is the column-header gesture: a field that is not the current sort field
 * starts ascending, and the field already being sorted on reverses. So one control
 * reaches both directions without the caller tracking which one is next.
 *
 * @param query - the query currently in effect.
 * @param control - the control the user asked for.
 * @returns the next query, or `query` itself when the control changes nothing.
 * @throws BacklogQueryError when an added filter cannot mean anything.
 */
export function applyBacklogControl(
  query:
    BacklogQuery,
  control:
    BacklogControl,
): BacklogQuery {
  switch (control.kind) {
    case 'set-search': {
      return control.search === query.search
        ? query
        : {
            ...query,
            search:
              control.search,
          };
    }

    case 'add-filter': {
      const at =
        query.filters.findIndex(
          (filter) =>
            filter.id
            === control.filter.id,
        );

      if (
        sameFilter(
          control.filter,
          at === -1
            ? undefined
            : query.filters[at],
        )
      ) {
        return query;
      }

      const next:
        BacklogQuery = {
          ...query,
          filters:
            at === -1
              ? [
                  ...query.filters,
                  control.filter,
                ]
              : query.filters.map(
                  (filter, index) =>
                    index === at
                      ? control.filter
                      : filter,
                ),
        };

      assertBacklogQuery(
        next,
      );

      return next;
    }

    case 'remove-filter': {
      return query.filters.some(
        (filter) =>
          filter.id
          === control.filterId,
      )
        ? removeBacklogFilter(
            query,
            control.filterId,
          )
        : query;
    }

    case 'sort-by': {
      const current =
        query.sort;

      if (
        current !== null
        && current.field === control.field
      ) {
        return {
          ...query,
          sort: {
            field:
              current.field,
            direction:
              current.direction === 'ascending'
                ? 'descending'
                : 'ascending',
          },
        };
      }

      return {
        ...query,
        sort: {
          field:
            control.field,
          direction:
            'ascending',
        },
      };
    }

    case 'clear-sort': {
      return query.sort === null
        ? query
        : {
            ...query,
            sort:
              null,
          };
    }

    case 'clear-query': {
      return isEmptyQuery(
        query,
      )
        ? query
        : EMPTY_BACKLOG_QUERY;
    }
  }
}

/**
 * The id to give the next filter added to a query.
 *
 * One above the highest ordinal already in use, so a minted id never collides with a
 * filter the query still holds. An id freed by removal may be minted again, which costs
 * nothing: once its filter is gone the id addresses nothing.
 *
 * @param filters - the filters the query currently holds.
 * @returns an id that is not among them.
 */
export function nextBacklogFilterId(
  filters:
    readonly BacklogFilter[],
): string {
  let highest =
    0;

  for (
    const filter
    of filters
  ) {
    const match =
      FILTER_ID_PATTERN.exec(
        filter.id,
      );

    if (match === null) {
      continue;
    }

    const ordinal =
      Number(
        match[1],
      );

    if (ordinal > highest) {
      highest =
        ordinal;
    }
  }

  return `filter-${highest + 1}`;
}

/**
 * The one value a filter menu carries for a field and an operator.
 *
 * Carried as one string so a menu needs a single select and no draft state: the pairs
 * offered are exactly the ones {@link operatorsForField} admits, which is what keeps
 * the menu and the matcher from disagreeing.
 *
 * @param field - the field the filter reads.
 * @param operator - the comparison it applies.
 * @returns the encoded expression.
 */
export function encodeBacklogExpression(
  field:
    BacklogField,
  operator:
    BacklogOperator,
): string {
  return `${field}|${operator}`;
}

/** The operators of a field, or null when the field does not admit that operator. */
function operatorFrom(
  field:
    BacklogField,
  value:
    string,
): BacklogOperator | null {
  return operatorsForField(
    field,
  ).find(
    (candidate) =>
      candidate
      === value,
  ) ?? null;
}

/**
 * What building a filter produced: either a filter, or why the request cannot become
 * one. A refusal is a sentence rather than an exception because the text it comes from
 * was typed by a person, and a mistyped number is a thing to say, not a crash.
 */
export type BacklogFilterBuild =
  | {
      readonly ok:
        true;
      readonly filter:
        BacklogFilter;
    }
  | {
      readonly ok:
        false;
      readonly reason:
        string;
    };

/**
 * Build the filter a filter menu is asking for.
 *
 * The value is taken as the field's own type: a number field must be given a number,
 * because a numeric comparison against the text `"9"` matches nothing and would be
 * indistinguishable from a filter that quietly failed. A boolean field's value is the
 * comparison itself — "completed is" and "completed is not" — so it takes no text.
 *
 * @param filters - the filters already in the query, so the new id does not collide.
 * @param expression - the encoded `field|operator` the menu offered.
 * @param raw - the text typed for the value, ignored by operators that take none.
 * @returns the filter, or the reason it cannot be built.
 */
export function buildBacklogFilter(
  filters:
    readonly BacklogFilter[],
  expression:
    string,
  raw:
    string,
): BacklogFilterBuild {
  const separator =
    expression.indexOf(
      '|',
    );

  if (separator === -1) {
    return {
      ok:
        false,
      reason:
        `"${expression}" is not a filter`,
    };
  }

  const fieldName =
    expression.slice(
      0,
      separator,
    );

  if (!isBacklogField(fieldName)) {
    return {
      ok:
        false,
      reason:
        `"${fieldName}" is not a filterable field`,
    };
  }

  const operator =
    operatorFrom(
      fieldName,
      expression.slice(
        separator + 1,
      ),
    );

  if (operator === null) {
    return {
      ok:
        false,
      reason:
        `${BACKLOG_FIELD_LABELS[fieldName]} does not support that comparison`,
    };
  }

  const id =
    nextBacklogFilterId(
      filters,
    );

  if (!operatorTakesValue(operator)) {
    return {
      ok:
        true,
      filter: {
        id,
        field:
          fieldName,
        operator,
      },
    };
  }

  switch (valueTypeForField(fieldName)) {
    case 'boolean': {
      return {
        ok:
          true,
        filter: {
          id,
          field:
            fieldName,
          operator,
          value:
            operator
            === 'is',
        },
      };
    }

    case 'number': {
      const text =
        raw.trim();

      if (text === '') {
        return {
          ok:
            false,
          reason:
            `${BACKLOG_FIELD_LABELS[fieldName]} needs a number`,
        };
      }

      const number =
        Number(
          text,
        );

      if (!Number.isFinite(number)) {
        return {
          ok:
            false,
          reason:
            `"${text}" is not a number`,
        };
      }

      return {
        ok:
          true,
        filter: {
          id,
          field:
            fieldName,
          operator,
          value:
            number,
        },
      };
    }

    case 'date':
    case 'text': {
      return {
        ok:
          true,
        filter: {
          id,
          field:
            fieldName,
          operator,
          value:
            raw,
        },
      };
    }
  }
}


/**
 * Mark or unmark one task for a bulk action.
 *
 * The order a selection was made in is kept, because it is the order a bulk action would
 * act in and a reader who selected `b` then `a` should not be surprised by `a, b`.
 * @param selected - the tasks marked so far.
 * @param taskId - the task to mark or unmark.
 * @returns the next selection.
 */
export function toggleBacklogSelection(
  selected:
    readonly string[],
  taskId:
    string,
): string[] {
  return selected.includes(
    taskId,
  )
    ? selected.filter(
        (id) =>
          id
          !== taskId,
      )
    : [
        ...selected,
        taskId,
      ];
}

/**
 * Mark every task the caller can see, keeping any selection it already had.
 *
 * `Select all` can only mean the rows on screen: a task the query hides is not something
 * the creator can see they are selecting, so it is left to whatever marked it before.
 * @param selected - the tasks marked so far.
 * @param visibleTaskIds - the tasks the query currently leaves visible.
 * @returns the next selection, or a copy of the same one when every visible task was marked.
 */
export function selectAllBacklogVisible(
  selected:
    readonly string[],
  visibleTaskIds:
    readonly string[],
): string[] {
  const added =
    visibleTaskIds.filter(
      (taskId) =>
        !selected.includes(
          taskId,
        ),
    );

  return [
    ...selected,
    ...added,
  ];
}

/**
 * Clear the whole selection, including tasks the current query hides.
 * @param selected - the tasks marked so far.
 * @returns the empty selection.
 */
export function clearBacklogSelection(
  selected:
    readonly string[],
): string[] {
  return selected.length
    === 0
    ? [
        ...selected,
      ]
    : [];
}

/** How narrow a Backlog column may be dragged, so a label never becomes unreadable. */
export const BACKLOG_COLUMN_MIN_WIDTH:
  number =
    96;

/** How wide a Backlog column may be dragged, so one column cannot swallow the table. */
export const BACKLOG_COLUMN_MAX_WIDTH:
  number =
    640;

/** The width a column starts at, before anybody has dragged it. */
export const BACKLOG_COLUMN_DEFAULT_WIDTH:
  number =
    160;

/**
 * Clamp a proposed column width.
 *
 * A drag reports pixels, and a drag can go anywhere: off the left edge of the table, or far
 * past the right. Rounding to whole pixels keeps a rendered width and a stored width the
 * same number, so a reload does not drift a column by a fraction each time.
 * @param width - the width the drag proposed, in pixels.
 * @returns a whole number of pixels inside the bounds.
 */
export function clampBacklogColumnWidth(
  width:
    number,
): number {
  if (!Number.isFinite(width)) {
    return BACKLOG_COLUMN_DEFAULT_WIDTH;
  }

  return Math.min(
    BACKLOG_COLUMN_MAX_WIDTH,
    Math.max(
      BACKLOG_COLUMN_MIN_WIDTH,
      Math.round(width),
    ),
  );
}

/**
 * Record a column's width, leaving every other column as it was.
 *
 * A width is how this reader is looking at the table, not what the table means, which is why
 * it lives in view state and why this returns a new map rather than editing one.
 * @param widths - the widths in effect.
 * @param columnId - the column being resized.
 * @param width - the proposed width, which is clamped.
 * @returns the next widths, or a copy of the same ones when nothing changed.
 */
export function resizeBacklogColumn(
  widths:
    Readonly<
      Record<
        string,
        number
      >
    >,
  columnId:
    string,
  width:
    number,
): Readonly<
  Record<
    string,
    number
  >
> {
  const clamped =
    clampBacklogColumnWidth(
      width,
    );

  if (
    widths[columnId]
    === clamped
  ) {
    return {
      ...widths,
    };
  }

  return {
    ...widths,
    [columnId]:
      clamped,
  };
}

/**
 * The width a column is currently drawn at.
 * @param widths - the widths in effect.
 * @param columnId - the column being drawn.
 * @returns its width, or the default when nobody has dragged it.
 */
export function backlogColumnWidth(
  widths:
    Readonly<
      Record<
        string,
        number
      >
    >,
  columnId:
    string,
): number {
  return widths[columnId]
    ?? BACKLOG_COLUMN_DEFAULT_WIDTH;
}