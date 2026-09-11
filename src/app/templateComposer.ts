/**
 * The template composer's model.
 *
 * A template is text a person pastes or types, and this module turns it into a plan: the
 * tasks the text asks for, and a typed, positioned error for every line that cannot be read.
 *
 * **The format is ours, and it is deliberately not the legacy mini-language.** Stage 6's own
 * acceptance refuses to treat the old textual syntax as fixed "if the same presentation and
 * workflow can be preserved cleanly", so nothing here tries to reproduce it, and nothing
 * here should be read as a compatibility promise. The format is one task per unindented
 * line, one `field: value` per indented line, `#` for a comment, and `property.<key>` for a
 * custom property:
 *
 * ```text
 * # A comment, and any blank line, is ignored.
 * Ship the release
 *   weight: 3
 *   deadline: 2026-06-30
 *   property.area: work
 * ```
 *
 * Two rules make it usable while it is being typed:
 *
 * - **An unreadable line is an error, not a stop.** Every task that could be read is in the
 *   plan, so a composer can show the preview and the error list side by side and the reader
 *   can see which line each complaint belongs to.
 * - **A value is kept as written.** `deadline: 2026-06-30` is validated as a date and stored
 *   as the text that was typed; normalising it into an instant is the importer's job, not a
 *   text box's. This module plans; it does not write, and it does not guess.
 *
 * Nothing here reads a record, and nothing here writes one. The plan is data.
 *
 * @module app/templateComposer
 */

/** How many tasks a template may plan, so a paste cannot become an unbounded job. */
export const MAX_TEMPLATE_TASKS:
  number =
    500;

/** How many lines a template may have. Pasted prose is not a template. */
export const MAX_TEMPLATE_LINES:
  number =
    5_000;

/** Why one line of a template could not be read. */
export type TemplateErrorCode =
  | 'property-before-task'
  | 'unknown-field'
  | 'duplicate-field'
  | 'missing-field-separator'
  | 'empty-field-value'
  | 'invalid-indentation'
  | 'invalid-number'
  | 'invalid-date'
  | 'invalid-boolean'
  | 'too-many-tasks'
  | 'too-many-lines';

/** One unreadable line, and where it is. */
export interface TemplateComposerError {
  readonly code:
    TemplateErrorCode;

  /** What is wrong, in one sentence a reader can act on. */
  readonly message:
    string;

  /** 1-based, so it matches what an editor shows. */
  readonly line:
    number;

  /** 1-based column of the start of the offending text. */
  readonly column:
    number;

  /** The line as it was written, trimmed, so a report can quote it. */
  readonly text:
    string;
}

/** One task a template asks for, as written. */
export interface TemplateTaskDraft {
  readonly name:
    string;

  /** The line the name is on, so a preview can point back at the text. */
  readonly line:
    number;

  readonly weight:
    number | null;

  readonly status:
    string | null;

  readonly startDate:
    string | null;

  readonly deadline:
    string | null;

  readonly fixedDuration:
    number | null;

  readonly maxDuration:
    number | null;

  readonly isCompleted:
    boolean | null;

  /** Custom properties, exactly as written. */
  readonly properties:
    Readonly<
      Record<
        string,
        string
      >
    >;
}

export interface TemplatePlan {
  readonly tasks:
    readonly TemplateTaskDraft[];

  readonly errors:
    readonly TemplateComposerError[];

  /** How many lines were read, so a caller can say how much text it looked at. */
  readonly lineCount:
    number;
}

/** The fields a task line may set, and what each one is checked as. */
type TemplateFieldKind =
  | 'number'
  | 'date'
  | 'boolean'
  | 'text';

const TASK_FIELDS:
  Readonly<
    Record<
      string,
      TemplateFieldKind
    >
  > = {
    weight:
      'number',
    status:
      'text',
    start:
      'date',
    deadline:
      'date',
    fixed:
      'number',
    max:
      'number',
    completed:
      'boolean',
  };

/** The keys a field line may use, in the order a reader is told about them. */
export const TEMPLATE_FIELD_KEYS:
  readonly string[] = [
    ...Object.keys(
      TASK_FIELDS,
    ),
    'property.<key>',
  ];

/** A task before its fields are read, so the fields can be filled in as they arrive. */
interface MutableDraft {
  name:
    string;
  line:
    number;
  weight:
    number | null;
  status:
    string | null;
  startDate:
    string | null;
  deadline:
    string | null;
  fixedDuration:
    number | null;
  maxDuration:
    number | null;
  isCompleted:
    boolean | null;
  properties:
    Record<
      string,
      string
    >;
  seen:
    Set<
      string
    >;
}

function draftFor(
  name:
    string,
  line:
    number,
): MutableDraft {
  return {
    name,
    line,
    weight:
      null,
    status:
      null,
    startDate:
      null,
    deadline:
      null,
    fixedDuration:
      null,
    maxDuration:
      null,
    isCompleted:
      null,
    properties:
      {},
    seen:
      new Set<
        string
      >(),
  };
}

/** A draft, frozen into the plan's own shape. */
function freeze(
  draft:
    MutableDraft,
): TemplateTaskDraft {
  return {
    name:
      draft.name,
    line:
      draft.line,
    weight:
      draft.weight,
    status:
      draft.status,
    startDate:
      draft.startDate,
    deadline:
      draft.deadline,
    fixedDuration:
      draft.fixedDuration,
    maxDuration:
      draft.maxDuration,
    isCompleted:
      draft.isCompleted,
    properties:
      {
        ...draft.properties,
      },
  };
}

/** Whether text is a date this composer accepts: a day, or an instant. */
function isDateText(
  value:
    string,
): boolean {
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      value,
    )
  ) {
    return Number.isFinite(
      Date.parse(
        `${value}T00:00:00Z`,
      ),
    );
  }

  return /^\d{4}-\d{2}-\d{2}T/.test(
    value,
  )
  && Number.isFinite(
    Date.parse(
      value,
    ),
  );
}

/** Whether text is a boolean this composer accepts. */
function isBooleanText(
  value:
    string,
): boolean {
  return value === 'true'
    || value
      === 'false';
}

/**
 * Parse a template into a plan.
 *
 * @param text - the template, as pasted or typed.
 * @returns the tasks that could be read, and one error per line that could not.
 */
export function parseTemplatePlan(
  text:
    string,
): TemplatePlan {
  const lines =
    text.split(
      /\r\n|\r|\n/,
    );

  const tasks:
    MutableDraft[] = [];

  const errors:
    TemplateComposerError[] = [];

  const fail = (
    code:
      TemplateErrorCode,
    message:
      string,
    line:
      number,
    column:
      number,
    raw:
      string,
  ): void => {
    errors.push({
      code,
      message,
      line,
      column,
      text:
        raw.trim(),
    });
  };

  for (
    let index = 0;
    index < lines.length;
    index += 1
  ) {
    const raw =
      lines[index] ?? '';

    const lineNumber =
      index + 1;

    if (lineNumber > MAX_TEMPLATE_LINES) {
      fail(
        'too-many-lines',
        `A template may have at most ${MAX_TEMPLATE_LINES} lines.`,
        lineNumber,
        1,
        raw,
      );

      break;
    }

    const trimmed =
      raw.trim();

    if (
      trimmed === ''
      || trimmed.startsWith(
        '#',
      )
    ) {
      continue;
    }

    const indent =
      raw.length
      - raw.trimStart().length;

    const current =
      tasks[
        tasks.length - 1
      ];

    if (indent === 0) {
      if (tasks.length >= MAX_TEMPLATE_TASKS) {
        fail(
          'too-many-tasks',
          `A template may plan at most ${MAX_TEMPLATE_TASKS} tasks.`,
          lineNumber,
          indent + 1,
          raw,
        );

        continue;
      }

      tasks.push(
        draftFor(
          trimmed,
          lineNumber,
        ),
      );

      continue;
    }

    if (
      raw.includes(
        '\t',
      )
    ) {
      fail(
        'invalid-indentation',
        'Indent a field with spaces, not a tab, so a template reads the same everywhere.',
        lineNumber,
        1,
        raw,
      );

      continue;
    }

    if (current === undefined) {
      fail(
        'property-before-task',
        'This line sets a field, but no task has been named above it yet.',
        lineNumber,
        indent + 1,
        raw,
      );

      continue;
    }

    const separator =
      trimmed.indexOf(
        ':',
      );

    if (separator === -1) {
      fail(
        'missing-field-separator',
        'A field line reads "name: value".',
        lineNumber,
        indent + 1,
        raw,
      );

      continue;
    }

    const key =
      trimmed.slice(
        0,
        separator,
      ).trim();

    const value =
      trimmed.slice(
        separator + 1,
      ).trim();

    /**
     * Where the value really starts in the raw line, 1-based, so a report points at the
     * character rather than at a guess: `weight: 3` and `weight:3` differ by a column and a
     * reader following the number wants the right one.
     */
    let valueIndex =
      indent
      + separator
      + 1;

    while (
      valueIndex < raw.length
      && raw[valueIndex]
        === ' '
    ) {
      valueIndex += 1;
    }

    const valueColumn =
      valueIndex
      + 1;

    /** The colon's own 1-based column, which is where an empty value is worth pointing. */
    const colonColumn =
      indent
      + separator
      + 1;

    if (value === '') {
      fail(
        'empty-field-value',
        `"${key}" was given no value.`,
        lineNumber,
        colonColumn,
        raw,
      );

      continue;
    }

    if (
      current.seen.has(
        key,
      )
    ) {
      fail(
        'duplicate-field',
        `"${key}" is already set on "${current.name}".`,
        lineNumber,
        indent + 1,
        raw,
      );

      continue;
    }

    if (
      key.startsWith(
        'property.',
      )
    ) {
      const propertyKey =
        key.slice(
          'property.'.length,
        ).trim();

      if (propertyKey === '') {
        fail(
          'unknown-field',
          'A custom property needs a name after "property.".',
          lineNumber,
          indent + 1,
          raw,
        );

        continue;
      }

      current.seen.add(
        key,
      );

      current.properties[
        propertyKey
      ] = value;

      continue;
    }

    const kind =
      TASK_FIELDS[key];

    if (kind === undefined) {
      fail(
        'unknown-field',
        `"${key}" is not a task field. A template may set ${TEMPLATE_FIELD_KEYS.join(', ')}.`,
        lineNumber,
        indent + 1,
        raw,
      );

      continue;
    }

    current.seen.add(
      key,
    );

    if (kind === 'number') {
      const number =
        Number(
          value,
        );

      if (
        !Number.isFinite(
          number,
        )
        || number
          < 0
      ) {
        fail(
          'invalid-number',
          `"${key}" needs a number of zero or more, not "${value}".`,
          lineNumber,
          valueColumn,
          raw,
        );

        continue;
      }

      if (key === 'weight') {
        current.weight =
          number;
      } else if (key === 'fixed') {
        current.fixedDuration =
          number;
      } else {
        current.maxDuration =
          number;
      }

      continue;
    }

    if (kind === 'date') {
      if (
        !isDateText(
          value,
        )
      ) {
        fail(
          'invalid-date',
          `"${key}" needs a date like 2026-06-30 or an instant like 2026-06-30T09:00:00Z, not "${value}".`,
          lineNumber,
          valueColumn,
          raw,
        );

        continue;
      }

      if (key === 'start') {
        current.startDate =
          value;
      } else {
        current.deadline =
          value;
      }

      continue;
    }

    if (kind === 'boolean') {
      if (
        !isBooleanText(
          value,
        )
      ) {
        fail(
          'invalid-boolean',
          `"${key}" needs true or false, not "${value}".`,
          lineNumber,
          valueColumn,
          raw,
        );

        continue;
      }

      current.isCompleted =
        value
        === 'true';

      continue;
    }

    current.status =
      value;
  }

  return {
    tasks:
      tasks.map(
        freeze,
      ),
    errors,
    lineCount:
      lines.length,
  };
}

/**
 * One line describing a planned task, for a preview list.
 * @param task - the planned task.
 * @returns what the task asks for, in the order the fields matter.
 */
export function describeTemplateTask(
  task:
    TemplateTaskDraft,
): string {
  const parts:
    string[] = [];

  if (task.weight !== null) {
    parts.push(
      `weight ${task.weight}`,
    );
  }

  if (task.status !== null) {
    parts.push(
      task.status,
    );
  }

  if (task.startDate !== null) {
    parts.push(
      `starts ${task.startDate}`,
    );
  }

  if (task.deadline !== null) {
    parts.push(
      `due ${task.deadline}`,
    );
  }

  if (task.fixedDuration !== null) {
    parts.push(
      `fixed ${task.fixedDuration}m`,
    );
  }

  if (task.maxDuration !== null) {
    parts.push(
      `max ${task.maxDuration}m`,
    );
  }

  if (task.isCompleted === true) {
    parts.push(
      'completed',
    );
  }

  for (
    const [
      key,
      value,
    ]
    of Object.entries(
      task.properties,
    )
  ) {
    parts.push(
      `${key}: ${value}`,
    );
  }

  return parts.length
    === 0
    ? 'No fields'
    : parts.join(
        ' · ',
      );
}
