/**
 * The Backlog's query surface: search, typed property filters and sorting,
 * expressed as pure functions over the task view model.
 *
 * This module owns the *meaning* of a Backlog query — which operators a field
 * admits, what "contains" means for text, how a missing value orders against a
 * present one. It deliberately renders nothing and mutates nothing: the browser
 * layer decides how the result is drawn, and no path here can write a record.
 *
 * Domain-only by construction: it imports the task view model and nothing else,
 * so a host, a framework or a filesystem cannot reach it.
 *
 * @module domain/backlogQuery
 */

import type {
  Task,
  TaskStatusId,
} from './types.js';

/** Every field the Backlog may filter or sort on. */
export type BacklogField =
  | 'name'
  | 'description'
  | 'status'
  | 'weight'
  | 'fixedDuration'
  | 'maxDuration'
  | 'startDate'
  | 'deadline'
  | 'isCompleted';

/**
 * Comparison operators. Which of these a field admits is decided once, by
 * {@link operatorsForField}, so a text field can never be asked whether it is
 * numerically greater than something.
 */
export type BacklogOperator =
  | 'contains'
  | 'is'
  | 'is-not'
  | 'less-than'
  | 'greater-than'
  | 'before'
  | 'after'
  | 'is-empty'
  | 'is-not-empty';

/** A single filter. The id is what makes removal addressable. */
export interface BacklogFilter {
  readonly id:
    string;

  readonly field:
    BacklogField;

  readonly operator:
    BacklogOperator;

  /** Absent only for the operators that test presence. */
  readonly value?:
    string
    | number
    | boolean;
}

export interface BacklogSort {
  readonly field:
    BacklogField;

  readonly direction:
    'ascending'
    | 'descending';
}

export interface BacklogQuery {
  readonly search:
    string;

  readonly filters:
    readonly BacklogFilter[];

  readonly sort:
    BacklogSort | null;
}

/** The empty query: everything, in the order the caller supplied. */
export const EMPTY_BACKLOG_QUERY:
  BacklogQuery = {
    search:
      '',
    filters:
      [],
    sort:
      null,
  };

/**
 * A query that cannot mean anything: an operator its field does not admit, or a
 * value-taking operator with no value. Raised rather than skipped, because a
 * silently ignored filter looks exactly like a filter that matched everything.
 */
export class BacklogQueryError
  extends Error {
  readonly field:
    BacklogField;

  readonly operator:
    BacklogOperator;

  constructor(
    message:
      string,
    field:
      BacklogField,
    operator:
      BacklogOperator,
  ) {
    super(
      message,
    );

    this.name =
      'BacklogQueryError';

    this.field =
      field;

    this.operator =
      operator;
  }
}

const TEXT_OPERATORS:
  readonly BacklogOperator[] = [
    'contains',
    'is',
    'is-not',
    'is-empty',
    'is-not-empty',
  ];

const NUMBER_OPERATORS:
  readonly BacklogOperator[] = [
    'is',
    'is-not',
    'less-than',
    'greater-than',
    'is-empty',
    'is-not-empty',
  ];

const DATE_OPERATORS:
  readonly BacklogOperator[] = [
    'is',
    'is-not',
    'before',
    'after',
    'is-empty',
    'is-not-empty',
  ];

const BOOLEAN_OPERATORS:
  readonly BacklogOperator[] = [
    'is',
    'is-not',
  ];

const STATUS_OPERATORS:
  readonly BacklogOperator[] = [
    'is',
    'is-not',
  ];

const FIELD_OPERATORS:
  Readonly<
    Record<
      BacklogField,
      readonly BacklogOperator[]
    >
  > = {
    name:
      TEXT_OPERATORS,
    description:
      TEXT_OPERATORS,
    status:
      STATUS_OPERATORS,
    weight:
      NUMBER_OPERATORS,
    fixedDuration:
      NUMBER_OPERATORS,
    maxDuration:
      NUMBER_OPERATORS,
    startDate:
      DATE_OPERATORS,
    deadline:
      DATE_OPERATORS,
    isCompleted:
      BOOLEAN_OPERATORS,
  };

/**
 * The operators a field admits, in presentation order. This is the one place
 * type-appropriateness is decided, so a filter menu and the matcher below
 * cannot disagree.
 * @param field - the field being filtered.
 * @returns the operators that field admits.
 */
export function operatorsForField(
  field:
    BacklogField,
): readonly BacklogOperator[] {
  return FIELD_OPERATORS[field];
}

/**
 * Every filterable field, in the order a field chooser should offer them. A menu
 * built from this cannot offer a field the matcher does not know.
 */
export const BACKLOG_FIELDS:
  readonly BacklogField[] = [
    'name',
    'description',
    'status',
    'weight',
    'fixedDuration',
    'maxDuration',
    'startDate',
    'deadline',
    'isCompleted',
  ];

/**
 * Whether text names a filterable field.
 *
 * The browser layer reads field names out of markup, where everything is a string.
 * Narrowing through this keeps a value that came from a document from being used as a
 * field without being checked.
 * @param value - the text to test.
 * @returns true when the text names a field.
 */
export function isBacklogField(
  value:
    string,
): value is BacklogField {
  return BACKLOG_FIELDS.some(
    (field) =>
      field
      === value,
  );
}

/**
 * What kind of value a field holds. A text filter takes the typed text as it stands;
 * a number filter must be given a number, because a numeric comparison against the
 * text `"9"` matches nothing and would look like a filter that quietly failed.
 */
export type BacklogValueType =
  | 'text'
  | 'number'
  | 'date'
  | 'boolean';

const FIELD_VALUE_TYPES:
  Readonly<
    Record<
      BacklogField,
      BacklogValueType
    >
  > = {
    name:
      'text',
    description:
      'text',
    status:
      'text',
    weight:
      'number',
    fixedDuration:
      'number',
    maxDuration:
      'number',
    startDate:
      'date',
    deadline:
      'date',
    isCompleted:
      'boolean',
  };

/**
 * The kind of value a field is compared against.
 * @param field - the field being filtered.
 * @returns the value type that field holds.
 */
export function valueTypeForField(
  field:
    BacklogField,
): BacklogValueType {
  return FIELD_VALUE_TYPES[field];
}

/**
 * Whether an operator tests a value at all. `is-empty` and `is-not-empty` are
 * the two that do not, which is why a filter carrying them must not require one.
 * @param operator - the operator in question.
 * @returns true when the operator takes no value.
 */
export function operatorTakesValue(
  operator:
    BacklogOperator,
): boolean {
  return operator
    !== 'is-empty'
    && operator
      !== 'is-not-empty';
}

/**
 * Reject a query that cannot mean anything, before it filters anything.
 * @param query - the query to check.
 * @throws BacklogQueryError naming the offending field and operator.
 */
export function assertBacklogQuery(
  query:
    BacklogQuery,
): void {
  for (
    const filter
    of query.filters
  ) {
    const allowed =
      operatorsForField(
        filter.field,
      );

    if (
      !allowed.includes(
        filter.operator,
      )
    ) {
      throw new BacklogQueryError(
        `Backlog field "${filter.field}" does not support "${filter.operator}"; it supports ${allowed.join(', ')}`,
        filter.field,
        filter.operator,
      );
    }

    if (
      operatorTakesValue(
        filter.operator,
      )
      && filter.value
        === undefined
    ) {
      throw new BacklogQueryError(
        `Backlog filter "${filter.operator}" on "${filter.field}" needs a value`,
        filter.field,
        filter.operator,
      );
    }
  }
}

/** The fields search reads. */
function searchableText(
  task:
    Task,
): string {
  return `${task.name} ${task.description}`;
}

/**
 * Case-insensitive substring search, trimmed so a query of only spaces is the
 * empty query rather than a search for a space.
 * @param task - the task to test.
 * @param search - the raw query text.
 * @returns true when the task matches, or when the query is empty.
 */
export function matchesSearch(
  task:
    Task,
  search:
    string,
): boolean {
  const needle =
    search
      .trim()
      .toLowerCase();

  if (
    needle.length
    === 0
  ) {
    return true;
  }

  return searchableText(
    task,
  )
    .toLowerCase()
    .includes(
      needle,
    );
}

/** The comparable value of a field, or null when the record has none. */
function fieldValue(
  task:
    Task,
  field:
    BacklogField,
): string | number | boolean | null {
  switch (
    field
  ) {
    case 'name':
      return task.name;
    case 'description':
      return task.description;
    case 'status':
      return task.status;
    case 'weight':
      return task.weight;
    case 'fixedDuration':
      return task.fixedDuration;
    case 'maxDuration':
      return task.maxDuration;
    case 'startDate':
      return task.startDate;
    case 'deadline':
      return task.deadline;
    case 'isCompleted':
      return task.isCompleted;
  }
}

function isEmptyValue(
  value:
    string | number | boolean | null,
): boolean {
  return value
    === null
    || (
      typeof value
      === 'string'
      && value
        .trim()
        .length
        === 0
    );
}

function asInstant(
  value:
    string | number | boolean | null,
): number | null {
  if (
    typeof value
    !== 'string'
  ) {
    return null;
  }

  const parsed =
    Date.parse(
      value,
    );

  return Number.isNaN(
    parsed,
  )
    ? null
    : parsed;
}

/**
 * Test one task against one filter.
 * @param task - the task to test.
 * @param filter - a filter whose operator {@link assertBacklogQuery} accepted.
 * @returns true when the task satisfies the filter.
 */
export function matchesFilter(
  task:
    Task,
  filter:
    BacklogFilter,
): boolean {
  const actual =
    fieldValue(
      task,
      filter.field,
    );

  switch (
    filter.operator
  ) {
    case 'is-empty':
      return isEmptyValue(
        actual,
      );

    case 'is-not-empty':
      return !isEmptyValue(
        actual,
      );

    case 'contains':
      return String(
        actual
        ?? '',
      )
        .toLowerCase()
        .includes(
          String(
            filter.value
            ?? '',
          )
            .toLowerCase(),
        );

    case 'is':
      return equalsValue(
        actual,
        filter.value,
        filter.field,
      );

    case 'is-not':
      return !equalsValue(
        actual,
        filter.value,
        filter.field,
      );

    case 'less-than':
      return compareOrdered(
        actual,
        filter.value,
      ) === -1;

    case 'greater-than':
      return compareOrdered(
        actual,
        filter.value,
      ) === 1;

    case 'before': {
      const left =
        asInstant(
          actual,
        );

      const right =
        asInstant(
          filter.value
          ?? null,
        );

      return left
        !== null
        && right
          !== null
        && left
          < right;
    }

    case 'after': {
      const left =
        asInstant(
          actual,
        );

      const right =
        asInstant(
          filter.value
          ?? null,
        );

      return left
        !== null
        && right
          !== null
        && left
          > right;
    }
  }
}

/** Whether the field's values are numbers, so equality must be numeric. */
function isNumericField(
  field:
    BacklogField,
): boolean {
  return field
    === 'weight'
    || field
      === 'fixedDuration'
    || field
      === 'maxDuration';
}

/**
 * Equality that respects the field's type: numbers compare numerically, dates
 * compare as instants, everything else as text, and a boolean never equals the
 * string "true".
 */
function equalsValue(
  actual:
    string | number | boolean | null,
  expected:
    string | number | boolean | undefined,
  field:
    BacklogField,
): boolean {
  if (
    expected
    === undefined
  ) {
    return false;
  }

  if (
    isNumericField(
      field,
    )
  ) {
    return typeof actual
      === 'number'
      && typeof expected
        === 'number'
      && actual
        === expected;
  }

  if (
    typeof actual
    === 'boolean'
    || typeof expected
      === 'boolean'
  ) {
    return typeof actual
      === 'boolean'
      && typeof expected
        === 'boolean'
      && actual
        === expected;
  }

  if (
    field
      === 'startDate'
    || field
      === 'deadline'
  ) {
    const left =
      asInstant(
        actual,
      );

    const right =
      asInstant(
        expected,
      );

    return left
      !== null
      && right
        !== null
      && left
        === right;
  }

  return String(
    actual
    ?? '',
  ) === String(
    expected,
  );
}

/**
 * Order a present value against a filter value: -1 below, 1 above, 0 equal, and
 * null when either side cannot be ordered.
 */
function compareOrdered(
  actual:
    string | number | boolean | null,
  expected:
    string | number | boolean | undefined,
): number | null {
  if (
    typeof actual
    === 'number'
    && typeof expected
      === 'number'
  ) {
    return actual
      < expected
      ? -1
      : actual
        > expected
        ? 1
        : 0;
  }

  if (
    typeof actual
    === 'string'
    && typeof expected
      === 'string'
  ) {
    const left =
      asInstant(
        actual,
      );

    const right =
      asInstant(
        expected,
      );

    if (
      left
      !== null
      && right
        !== null
    ) {
      return left
        < right
        ? -1
        : left
          > right
          ? 1
          : 0;
    }
  }

  return null;
}

/**
 * Sort key for one task: numbers and dates order by value, text orders
 * case-insensitively, and a missing value is its own tier.
 */
function sortKey(
  task:
    Task,
  field:
    BacklogField,
): {
  readonly missing:
    boolean;
  readonly number:
    number | null;
  readonly text:
    string;
} {
  const value =
    fieldValue(
      task,
      field,
    );

  if (
    typeof value
    === 'number'
  ) {
    return {
      missing:
        false,
      number:
        value,
      text:
        '',
    };
  }

  if (
    typeof value
    === 'boolean'
  ) {
    return {
      missing:
        false,
      number:
        value
          ? 1
          : 0,
      text:
        '',
    };
  }

  if (
    typeof value
    === 'string'
  ) {
    const instant =
      asInstant(
        value,
      );

    return {
      missing:
        value
          .trim()
          .length
          === 0,
      number:
        instant,
      text:
        value.toLowerCase(),
    };
  }

  return {
    missing:
      true,
    number:
      null,
    text:
      '',
  };
}

/**
 * Compare two tasks by one field, in the requested direction.
 *
 * Missing values sort last in ascending order and first in descending order —
 * the rule a reader expects, and stated here because "no deadline" is not a
 * deadline of zero. Ties fall back to `orderIndex`, then `id`, so sorting is
 * total and stable: two tasks that compare equal never swap between renders.
 */
function compareForSort(
  left:
    Task,
  right:
    Task,
  sort:
    BacklogSort,
): number {
  const a =
    sortKey(
      left,
      sort.field,
    );

  const b =
    sortKey(
      right,
      sort.field,
    );

  let result =
    0;

  if (
    a.missing
    !== b.missing
  ) {
    result =
      a.missing
        ? 1
        : -1;
  } else if (
    !a.missing
  ) {
    if (
      a.number
      !== null
      && b.number
        !== null
    ) {
      result =
        a.number
        < b.number
          ? -1
          : a.number
            > b.number
            ? 1
            : 0;
    }

    if (
      result
      === 0
      && a.number
        === null
    ) {
      result =
        a.text
          < b.text
          ? -1
          : a.text
            > b.text
            ? 1
            : 0;
    }
  }

  if (
    sort.direction
    === 'descending'
  ) {
    result =
      -result;
  }

  if (
    result
    !== 0
  ) {
    return result;
  }

  if (
    left.orderIndex
    !== right.orderIndex
  ) {
    return left.orderIndex
      < right.orderIndex
      ? -1
      : 1;
  }

  return left.id
    < right.id
      ? -1
      : left.id
        > right.id
          ? 1
          : 0;
}

/**
 * Apply a query: search, then every filter (conjunction), then the sort.
 *
 * Returns a new array in every case, so a caller cannot mistake the filtered
 * view for the underlying records. Records are never mutated.
 * @param tasks - the tasks to query.
 * @param query - the query; validated before it is applied.
 * @returns the matching tasks in the requested order.
 * @throws BacklogQueryError when the query cannot mean anything.
 */
export function applyBacklogQuery(
  tasks:
    readonly Task[],
  query:
    BacklogQuery,
): Task[] {
  assertBacklogQuery(
    query,
  );

  const matched =
    tasks.filter(
      (task) =>
        matchesSearch(
          task,
          query.search,
        )
        && query.filters
          .every(
            (filter) =>
              matchesFilter(
                task,
                filter,
              ),
          ),
    );

  if (
    query.sort
    === null
  ) {
    return [
      ...matched,
    ];
  }

  return [
    ...matched,
  ].sort(
    (left, right) =>
      compareForSort(
        left,
        right,
        query.sort!,
      ),
  );
}

/**
 * Drop one filter by id, leaving the rest of the query untouched — the Backlog's
 * "remove filter" control. An unknown id changes nothing rather than throwing:
 * removing a filter that is already gone has the outcome the caller wanted.
 * @param query - the query to modify.
 * @param filterId - the id of the filter to remove.
 * @returns a new query without that filter.
 */
export function removeBacklogFilter(
  query:
    BacklogQuery,
  filterId:
    string,
): BacklogQuery {
  return {
    ...query,
    filters:
      query.filters.filter(
        (filter) =>
          filter.id
          !== filterId,
      ),
  };
}

/**
 * A status value is a task status id, re-exported so a caller building a status
 * filter does not need the task model for it.
 */
export type BacklogStatusValue =
  TaskStatusId;
