/**
 * The Task editor's model.
 *
 * One pure projection turns a loaded state, a task id and a provisional draft into
 * everything the Task modal shows: every field the task can carry, in the control its
 * own type calls for, with the value the record holds or the value the draft has so far.
 *
 * The rule that makes this honest is that the field list comes from the **schema**, not
 * from the record. A property the schema declares but this task has never set is still a
 * field, because a field nobody can see is a field nobody can fill in; and a property the
 * record carries with no schema entry is still a field, because a value nobody can see is
 * a value the editor would silently drop on save.
 *
 * A draft is `null` while nothing has been edited, which is what makes Cancel exact:
 * discarding is `null`, not a rebuild that hopes to reproduce the record. Derived
 * properties — rollups and formulas — are shown and are not editable, because their value
 * is not the record's to set.
 *
 * Nothing here writes. The modal's Save is refused with the same typed result the rest of
 * the read-only surface uses, so an editor that cannot save yet says so instead of
 * pretending.
 *
 * @module app/taskEditor
 */

import {
  type PropertySchema,
  type PropertyType,
  type ProximaState,
  type Task,
} from '../domain/types.js';

/** The control a field is edited with. Derived values have no control of their own. */
export type TaskEditorControl =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multi-select'
  | 'relation'
  | 'derived';

/** One choice of a select, multi-select or relation field. */
export interface TaskEditorOption {
  readonly id:
    string;

  readonly label:
    string;
}

/** One field of the editor. */
export interface TaskEditorField {
  /** Stable across renders and across the record and the draft. */
  readonly id:
    string;

  readonly label:
    string;

  readonly control:
    TaskEditorControl;

  /** The value as text, which is what every control but a checkbox shows. */
  readonly value:
    string;

  readonly checked:
    boolean;

  readonly options:
    readonly TaskEditorOption[];

  /** The chosen ids of a multi-select or relation field, in the order they were chosen. */
  readonly selected:
    readonly string[];

  /** False for a derived value: shown, never entered. */
  readonly editable:
    boolean;

  readonly note:
    string | null;

  /** The schema type this field came from, or null for a field of the task itself. */
  readonly propertyType:
    PropertyType | null;
}

export interface TaskEditorSection {
  readonly id:
    | 'task'
    | 'properties';

  readonly label:
    string;

  readonly fields:
    readonly TaskEditorField[];
}

/**
 * What has been typed but not saved.
 *
 * `null` — not this type — is what means "nothing edited"; a draft is only ever built
 * from a record, so a draft that has not been touched compares equal to the record.
 */
export interface TaskEditorDraft {
  readonly values:
    Readonly<
      Record<
        string,
        string
      >
    >;

  readonly checks:
    Readonly<
      Record<
        string,
        boolean
      >
    >;

  readonly selections:
    Readonly<
      Record<
        string,
        readonly string[]
      >
    >;
}

/** One edit, as a value rather than a callback. */
export type TaskEditorEdit =
  | {
      readonly fieldId:
        string;
      readonly value:
        string;
    }
  | {
      readonly fieldId:
        string;
      readonly checked:
        boolean;
    }
  | {
      readonly fieldId:
        string;
      readonly selected:
        readonly string[];
    };

export interface TaskEditorProjection {
  readonly taskId:
    string;

  readonly title:
    string;

  readonly projectId:
    string | null;

  readonly sections:
    readonly TaskEditorSection[];

  /** True when the draft differs from the record it was seeded from. */
  readonly dirty:
    boolean;

  /** How many fields the editor shows, so a modal can say so without counting markup. */
  readonly fieldCount:
    number;
}

/** The modal cannot save yet, and says so with the writer's own refusal code. */
export const TASK_EDITOR_SAVE_REFUSAL:
  'action-not-available' =
    'action-not-available';

/** Why Save is refused, in one sentence a reader can act on. */
export const TASK_EDITOR_SAVE_NOTE:
  string =
    'Save unavailable until the record store can write. Nothing on this form has been changed.';

/** The field ids of the task's own values, in the order the editor shows them. */
const TASK_FIELD_IDS:
  readonly string[] = [
    'name',
    'project',
    'executionState',
    'weight',
    'fixedDurationOn',
    'fixedDuration',
    'maxDuration',
    'startDate',
    'deadline',
    'completion',
  ];

/** The field id a schema property is shown under. */
export function taskEditorPropertyFieldId(
  propertyId:
    string,
): string {
  return `property:${propertyId}`;
}

/** The text a value is shown as. Absent is empty, never the word "null". */
function text(
  value:
    unknown,
): string {
  return value
    === null
    || value
      === undefined
      ? ''
      : String(
          value,
        );
}

/** The chosen ids an array or single value amounts to. */
function selectedIds(
  value:
    unknown,
): string[] {
  if (
    Array.isArray(
      value,
    )
  ) {
    return value.map(
      (entry) =>
        String(
          entry,
        ),
    );
  }

  return value
    === null
    || value
      === undefined
      ? []
      : [
          String(
            value,
          ),
        ];
}

/** The task's own values, as text, keyed by field id. */
function taskValues(
  task:
    Task,
): Readonly<
  Record<
    string,
    string
  >
> {
  return {
    name:
      task.name,
    project:
      task.projectId
      ?? '',
    executionState:
      task.status,
    weight:
      text(
        task.weight,
      ),
    fixedDuration:
      text(
        task.fixedDuration,
      ),
    maxDuration:
      text(
        task.maxDuration,
      ),
    startDate:
      text(
        task.startDate,
      ),
    deadline:
      text(
        task.deadline,
      ),
  };
}

/** The task's own flags, keyed by field id. */
function taskChecks(
  task:
    Task,
): Readonly<
  Record<
    string,
    boolean
  >
> {
  return {
    fixedDurationOn:
      task.isFixedDuration
      === true,
    completion:
      task.isCompleted
      === true,
  };
}

/** The task's custom properties, as text, keyed by the field id they are shown under. */
function propertyValues(
  task:
    Task,
): Readonly<
  Record<
    string,
    string
  >
> {
  const values:
    Record<
      string,
      string
    > = {};

  for (
    const [
      key,
      value,
    ]
    of Object.entries(
      task.properties,
    )
  ) {
    values[
      taskEditorPropertyFieldId(
        key,
      )
    ] = Array.isArray(
      value,
    )
      ? value
          .map(
            (entry) =>
              String(
                entry,
              ),
          )
          .join(', ')
      : text(
          value,
        );
  }

  return values;
}

/** The chosen ids of a task's custom properties, keyed by field id. */
function propertySelections(
  task:
    Task,
): Readonly<
  Record<
    string,
    readonly string[]
  >
> {
  const selections:
    Record<
      string,
      readonly string[]
    > = {};

  for (
    const [
      key,
      value,
    ]
    of Object.entries(
      task.properties,
    )
  ) {
    const selected =
      selectedIds(
        value,
      );

    if (selected.length > 0) {
      selections[
        taskEditorPropertyFieldId(
          key,
        )
      ] = selected;
    }
  }

  return selections;
}

/** The flags a task's custom properties amount to, keyed by field id. */
function propertyChecks(
  task:
    Task,
): Readonly<
  Record<
    string,
    boolean
  >
> {
  const checks:
    Record<
      string,
      boolean
    > = {};

  for (
    const [
      key,
      value,
    ]
    of Object.entries(
      task.properties,
    )
  ) {
    checks[
      taskEditorPropertyFieldId(
        key,
      )
    ] = value
      === true;
  }

  return checks;
}

/**
 * The draft a task starts from: its record, as the form would show it.
 * @param task - the task being edited.
 * @returns a draft that is not yet a change.
 */
export function taskEditorDraftFor(
  task:
    Task,
): TaskEditorDraft {
  return {
    values: {
      ...taskValues(
        task,
      ),
      ...propertyValues(
        task,
      ),
    },
    checks: {
      ...taskChecks(
        task,
      ),
      ...propertyChecks(
        task,
      ),
    },
    selections:
      propertySelections(
        task,
      ),
  };
}

/**
 * Apply one edit to a draft.
 *
 * An edit names the field it belongs to, so a control that reports the wrong kind of edit
 * for a field is a mistake in the caller rather than a silently ignored keystroke: the
 * draft keeps one entry per field and the wrong kind would replace the right one.
 * @param draft - the draft so far.
 * @param edit - the edit to apply.
 * @returns the next draft.
 */
export function applyTaskEditorEdit(
  draft:
    TaskEditorDraft,
  edit:
    TaskEditorEdit,
): TaskEditorDraft {
  if ('checked' in edit) {
    return {
      ...draft,
      checks: {
        ...draft.checks,
        [edit.fieldId]:
          edit.checked,
      },
    };
  }

  if ('selected' in edit) {
    return {
      ...draft,
      selections: {
        ...draft.selections,
        [edit.fieldId]:
          [
            ...edit.selected,
          ],
      },
    };
  }

  return {
    ...draft,
    values: {
      ...draft.values,
      [edit.fieldId]:
        edit.value,
    },
  };
}

/** Whether two drafts hold the same edits. */
export function sameTaskEditorDraft(
  left:
    TaskEditorDraft,
  right:
    TaskEditorDraft,
): boolean {
  return sameRecord(
    left.values,
    right.values,
  ) && sameRecord(
    left.checks,
    right.checks,
  ) && sameSelections(
    left.selections,
    right.selections,
  );
}

function sameRecord(
  left:
    Readonly<
      Record<
        string,
        unknown
      >
    >,
  right:
    Readonly<
      Record<
        string,
        unknown
      >
    >,
): boolean {
  const leftKeys =
    Object.keys(
      left,
    );

  if (
    leftKeys.length
    !== Object.keys(
      right,
    ).length
  ) {
    return false;
  }

  return leftKeys.every(
    (key) =>
      Object.is(
        left[key],
        right[key],
      ),
  );
}

function sameSelections(
  left:
    Readonly<
      Record<
        string,
        readonly string[]
      >
    >,
  right:
    Readonly<
      Record<
        string,
        readonly string[]
      >
    >,
): boolean {
  const leftKeys =
    Object.keys(
      left,
    );

  if (
    leftKeys.length
    !== Object.keys(
      right,
    ).length
  ) {
    return false;
  }

  return leftKeys.every(
    (key) => {
      const other =
        right[key];

      return other !== undefined
        && other.length
          === left[key]!.length
        && other.every(
          (entry, index) =>
            entry
            === left[key]![index],
        );
    },
  );
}

/** One project, as a choice. */
function projectOptions(
  state:
    ProximaState,
): TaskEditorOption[] {
  return [
    ...state.projects
      .filter(
        (project) =>
          project.status
          === 'active',
      )
      .map(
        (project) => ({
          id:
            project.id,
          label:
            project.name,
        }),
      ),
    {
      id:
        '',
      label:
        'No project',
    },
  ];
}

/** The statuses a task may be in, as choices. Empty when the vault declares none. */
function statusOptions(
  state:
    ProximaState,
): TaskEditorOption[] {
  return state.statuses.map(
    (status) => ({
      id:
        status.id,
      label:
        `${status.name} (${status.column})`,
    }),
  );
}

/** The control a schema type is edited with. */
function controlForPropertyType(
  type:
    PropertyType,
): TaskEditorControl {
  switch (type) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'select':
      return 'select';
    case 'multi-select':
      return 'multi-select';
    case 'relation':
      return 'relation';
    case 'rollup':
    case 'formula':
      return 'derived';
  }
}

/** What a derived property's value comes from, so the field can say. */
function derivedNote(
  schema:
    PropertySchema,
): string {
  if (schema.type === 'rollup') {
    const aggregation =
      schema.aggregation
      ?? 'count';

    return `Derived: ${aggregation} of ${schema.targetProperty ?? 'the related records'}. Not editable here.`;
  }

  return `Derived: ${schema.expression ?? 'a formula'}. Not editable here.`;
}

/** One field of the editor, with the value the draft or the record holds. */
function field(
  id:
    string,
  label:
    string,
  control:
    TaskEditorControl,
  draft:
    TaskEditorDraft,
  fallbackValue:
    string,
  fallbackChecked:
    boolean,
  options:
    readonly TaskEditorOption[],
  selected:
    readonly string[],
  editable:
    boolean,
  note:
    string | null,
  propertyType:
    PropertyType | null,
): TaskEditorField {
  const chosen =
    draft.selections[id];

  return {
    id,
    label,
    control,
    value:
      draft.values[id]
      ?? fallbackValue,
    checked:
      draft.checks[id]
      ?? fallbackChecked,
    options,
    selected:
      chosen
      ?? selected,
    editable,
    note,
    propertyType,
  };
}

/**
 * Project the Task editor.
 *
 * @param state - the loaded state, which supplies the projects, the statuses and the schema.
 * @param taskId - the task being edited.
 * @param draft - the edits so far, or null while nothing has been edited.
 * @returns the editor, or null when no such task is loaded.
 */
export function projectTaskEditor(
  state:
    ProximaState,
  taskId:
    string,
  draft:
    TaskEditorDraft | null,
): TaskEditorProjection | null {
  const task =
    state.tasks.find(
      (candidate) =>
        candidate.id
        === taskId,
    );

  if (task === undefined) {
    return null;
  }

  const seed =
    taskEditorDraftFor(
      task,
    );

  const edited =
    draft
    ?? seed;

  const projects =
    projectOptions(
      state,
    );

  const statuses =
    statusOptions(
      state,
    );

  const values =
    taskValues(
      task,
    );

  const checks =
    taskChecks(
      task,
    );

  const taskFields:
    TaskEditorField[] = [
      field(
        'name',
        'Name',
        'text',
        edited,
        values.name!,
        false,
        [],
        [],
        true,
        null,
        null,
      ),
      field(
        'project',
        'Project',
        'select',
        edited,
        values.project!,
        false,
        projects,
        [],
        true,
        null,
        null,
      ),
      field(
        'executionState',
        'Execution state',
        statuses.length > 0
          ? 'select'
          : 'text',
        edited,
        values.executionState!,
        false,
        statuses,
        [],
        true,
        statuses.length > 0
          ? null
          : 'This vault declares no statuses, so the stored status is shown as it is.',
        null,
      ),
      field(
        'weight',
        'Weight',
        'number',
        edited,
        values.weight!,
        false,
        [],
        [],
        true,
        'Higher weight claims more of the remaining time.',
        null,
      ),
      field(
        'fixedDurationOn',
        'Fixed duration',
        'checkbox',
        edited,
        '',
        checks.fixedDurationOn!,
        [],
        [],
        true,
        null,
        null,
      ),
      field(
        'fixedDuration',
        'Fixed duration (minutes)',
        'number',
        edited,
        values.fixedDuration!,
        false,
        [],
        [],
        true,
        edited.checks.fixedDurationOn
          ?? checks.fixedDurationOn!
          ? null
          : 'Only counted while fixed duration is on.',
        null,
      ),
      field(
        'maxDuration',
        'Maximum duration (minutes)',
        'number',
        edited,
        values.maxDuration!,
        false,
        [],
        [],
        true,
        'Caps how far an elastic task may stretch.',
        null,
      ),
      field(
        'startDate',
        'Start',
        'date',
        edited,
        values.startDate!,
        false,
        [],
        [],
        true,
        null,
        null,
      ),
      field(
        'deadline',
        'Deadline',
        'date',
        edited,
        values.deadline!,
        false,
        [],
        [],
        true,
        null,
        null,
      ),
      field(
        'completion',
        'Completed',
        'checkbox',
        edited,
        '',
        checks.completion!,
        [],
        [],
        true,
        null,
        null,
      ),
    ];

  const propertyFields:
    TaskEditorField[] = [];

  const schemaIds =
    new Set<
      string
    >();

  for (
    const schema
    of state.taskSchema
  ) {
    schemaIds.add(
      schema.id,
    );

    const id =
      taskEditorPropertyFieldId(
        schema.id,
      );

    const control =
      controlForPropertyType(
        schema.type,
      );

    const options =
      schema.options
        ?.map(
          (option) => ({
            id:
              option.id,
            label:
              option.name,
          }),
        )
      ?? [];

    const selected =
      control
      === 'multi-select'
        ? edited.selections[id]
          ?? []
        : [];

    const editable =
      control
      !== 'derived';

    const note =
      control
      === 'derived'
        ? derivedNote(
            schema,
          )
        : control
            === 'relation'
          ? 'Relation targets are record ids; there is no picker until relations are canonical (HARD GATE A6).'
          : null;

    propertyFields.push(
      field(
        id,
        schema.name,
        control,
        edited,
        seed.values[id]
        ?? '',
        seed.checks[id]
        ?? false,
        options,
        selected,
        editable,
        note,
        schema.type,
      ),
    );
  }

  for (
    const id
    of Object.keys(
      seed.values,
    )
  ) {
    if (
      !id.startsWith(
        'property:',
      )
    ) {
      continue;
    }

    const propertyId =
      id.slice(
        'property:'.length,
      );

    if (
      schemaIds.has(
        propertyId,
      )
    ) {
      continue;
    }

    propertyFields.push(
      field(
        id,
        propertyId,
        'text',
        edited,
        seed.values[id]
        ?? '',
        seed.checks[id]
        ?? false,
        [],
        [],
        true,
        'This value is in the record but not in the schema; it is shown so an editor can see it.',
        null,
      ),
    );
  }

  return {
    taskId:
      task.id,
    title:
      task.name,
    projectId:
      task.projectId,
    sections: [
      {
        id:
          'task',
        label:
          'Task',
        fields:
          taskFields,
      },
      ...propertyFields.length
          === 0
        ? []
        : [
            {
              id:
                'properties' as const,
              label:
                'Properties',
              fields:
                propertyFields,
            },
          ],
    ],
    dirty:
      draft !== null
      && !sameTaskEditorDraft(
        draft,
        seed,
      ),
    fieldCount:
      taskFields.length
      + propertyFields.length,
  };
}
