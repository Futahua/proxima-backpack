/**
 * The Event editor's model.
 *
 * The same shape as the Task editor: one pure projection turns a loaded state, an event
 * id, a provisional draft and the event's recurrence into everything the modal shows.
 *
 * Three things are worth stating because they are decisions rather than mechanics:
 *
 * - **Colour has no field.** `CalendarEvent` carries no colour and nothing in the vault
 *   format declares one, so the editor says so instead of offering a control whose value
 *   could not be stored. {@link EventEditorProjection.colourNote} is what the modal shows.
 * - **Recurrence is offered even when the event does not recur.** The end-condition select
 *   includes "does not recur", so the same control answers whether the event recurs and
 *   how it ends; recurrence that cannot be read is reported as unusable rather than shown
 *   as absent.
 * - **The scope question is stated, not guessed.** Changing one occurrence of a series is
 *   a different edit from changing the series, so the editor says that a scope has to be
 *   chosen. Choosing it is the existing occurrence/series scope modal.
 *
 * It takes a narrow input rather than the whole loaded state: the schedule surfaces carry
 * a project name lookup and the events, not the schema, so listing the task schema's
 * custom properties here would need a data path no § Event modal box asks for. What the
 * editor shows is the event's own fields and its recurrence, which is what those boxes
 * name.
 *
 * @module app/eventEditor
 */

import {
  applyFormEdit,
  sameFormDraft,
  type FormDraft,
  type FormEdit,
} from './formDraft.js';

import type {
  CalendarEvent,
} from '../domain/types.js';

/** The control an event field is edited with. */
export type EventEditorControl =
  | 'text'
  | 'textarea'
  | 'date'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'derived';

/** One choice of a select field. */
export interface EventEditorOption {
  readonly id:
    string;

  readonly label:
    string;
}

export interface EventEditorField {
  readonly id:
    string;

  readonly label:
    string;

  readonly control:
    EventEditorControl;

  readonly value:
    string;

  readonly checked:
    boolean;

  readonly options:
    readonly EventEditorOption[];

  readonly editable:
    boolean;

  readonly note:
    string | null;
}

export interface EventEditorSection {
  readonly id:
    | 'event'
    | 'recurrence'
    | 'properties';

  readonly label:
    string;

  readonly fields:
    readonly EventEditorField[];
}

/** How often a series repeats, as the editor offers it. */
export type EventRecurrenceFrequency =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly';

/**
 * What the record's recurrence amounts to.
 *
 * `none` is an event that does not recur; `series` is a rule the app layer could read;
 * `unsupported` is a recurrence the record carries that cannot be used, which is a thing
 * to say rather than a thing to hide.
 */
export type EventEditorRecurrence =
  | {
      readonly kind:
        'none';
    }
  | {
      readonly kind:
        'series';
      readonly frequency:
        EventRecurrenceFrequency;
      readonly interval:
        number;
      readonly count:
        number | null;
      readonly until:
        string | null;
    }
  | {
      readonly kind:
        'unsupported';
      readonly detail:
        string;
    };

/** The end condition, including "this event does not recur" as one of the answers. */
export type EventEditorEndKind =
  | 'none'
  | 'never'
  | 'until'
  | 'count';

export interface EventEditorProjection {
  readonly eventId:
    string;

  readonly title:
    string;

  readonly projectId:
    string | null;

  readonly sections:
    readonly EventEditorSection[];

  readonly dirty:
    boolean;

  readonly fieldCount:
    number;

  /** Why there is no colour field, for the modal to show rather than to omit silently. */
  readonly colourNote:
    string;

  /** Whether the event's recurrence could be read. */
  readonly recurrenceKind:
    EventEditorRecurrence['kind'];
}

/** The modal cannot save yet, and says so with the writer's own refusal code. */
export const EVENT_EDITOR_SAVE_REFUSAL:
  'action-not-available' =
    'action-not-available';

/** Why Save is refused, in one sentence a reader can act on. */
export const EVENT_EDITOR_SAVE_NOTE:
  string =
    'Save unavailable until the record store can write. Nothing on this form has been changed.';

/** Why there is no colour control, stated once. */
export const EVENT_EDITOR_COLOUR_NOTE:
  string =
    'Event records carry no colour of their own, so this editor offers none.';

/** What changing one occurrence of a series means, stated once. */
export const EVENT_EDITOR_SCOPE_NOTE:
  string =
    'Changing one occurrence is not changing the series: choose this occurrence or the whole series before the change means anything.';

/**
 * What the editor needs to know about the world: the events it may open, and the projects
 * it may offer. Both are passed in rather than read from a loaded state, because the
 * surfaces that render this editor carry exactly these two things.
 */
export interface EventEditorInput {
  readonly events:
    readonly CalendarEvent[];

  readonly projectChoices:
    readonly EventEditorOption[];
}

/** The event's own values, as text, keyed by field id. */
function eventValues(
  event:
    CalendarEvent,
): Readonly<
  Record<
    string,
    string
  >
> {
  return {
    name:
      event.name,
    description:
      event.description,
    project:
      event.projectId
      ?? '',
    start:
      event.startDate,
    end:
      event.deadline,
  };
}

/** The recurrence fields, as text, keyed by field id. */
function recurrenceValues(
  recurrence:
    EventEditorRecurrence,
): Readonly<
  Record<
    string,
    string
  >
> {
  return {
    recurrenceFrequency:
      recurrence.kind
      === 'series'
        ? recurrence.frequency
        : 'daily',
    recurrenceInterval:
      recurrence.kind
      === 'series'
        ? String(
            recurrence.interval,
          )
        : '1',
    recurrenceEndKind:
      endKindOf(
        recurrence,
      ),
    recurrenceUntil:
      recurrence.kind
      === 'series'
        ? recurrence.until
          ?? ''
        : '',
    recurrenceCount:
      recurrence.kind
      === 'series'
      && recurrence.count
        !== null
        ? String(
            recurrence.count,
          )
        : '',
  };
}

/**
 * The end condition a recurrence amounts to.
 *
 * An unreadable recurrence is shown as "does not recur" while the section says it could
 * not be read, so the controls stay usable and the record is not misrepresented as empty.
 */
function endKindOf(
  recurrence:
    EventEditorRecurrence,
): EventEditorEndKind {
  if (recurrence.kind !== 'series') {
    return 'none';
  }

  if (
    recurrence.count
    !== null
  ) {
    return 'count';
  }

  return recurrence.until
    === null
    ? 'never'
    : 'until';
}

/**
 * The draft an event starts from.
 * @param event - the event being edited.
 * @param recurrence - what the record's recurrence amounts to.
 * @returns a draft that is not yet a change.
 */
export function eventEditorDraftFor(
  event:
    CalendarEvent,
  recurrence:
    EventEditorRecurrence,
): FormDraft {
  const checks:
    Record<
      string,
      boolean
    > = {
    completion:
      event.isCompleted
      === true,
  };

  return {
    values: {
      ...eventValues(
        event,
      ),
      ...recurrenceValues(
        recurrence,
      ),
    },
    checks,
    selections:
      {},
  };
}

/** One field, with the value the draft or the record holds. */
function field(
  id:
    string,
  label:
    string,
  control:
    EventEditorControl,
  draft:
    FormDraft,
  fallbackValue:
    string,
  fallbackChecked:
    boolean,
  options:
    readonly EventEditorOption[],
  editable:
    boolean,
  note:
    string | null,
): EventEditorField {
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
    editable,
    note,
  };
}

/** The recurrence controls, always offered so an event can be made to recur. */
function recurrenceFields(
  recurrence:
    EventEditorRecurrence,
  edited:
    FormDraft,
  seed:
    FormDraft,
): EventEditorField[] {
  const unreadable =
    recurrence.kind
    === 'unsupported'
      ? recurrence.detail
      : recurrence.kind
          === 'none'
        ? 'This event does not recur.'
        : null;

  const endKind =
    edited.values.recurrenceEndKind
    ?? seed.values.recurrenceEndKind
    ?? 'none';

  return [
    field(
      'recurrenceFrequency',
      'Repeats',
      'select',
      edited,
      seed.values.recurrenceFrequency!,
      false,
      [
        {
          id:
            'daily',
          label:
            'Daily',
        },
        {
          id:
            'weekly',
          label:
            'Weekly',
        },
        {
          id:
            'monthly',
          label:
            'Monthly',
        },
        {
          id:
            'yearly',
          label:
            'Yearly',
        },
      ],
      true,
      null,
    ),
    field(
      'recurrenceInterval',
      'Every',
      'number',
      edited,
      seed.values.recurrenceInterval!,
      false,
      [],
      true,
      'How many repetitions apart, so 2 with weekly means every other week.',
    ),
    field(
      'recurrenceEndKind',
      'Ends',
      'select',
      edited,
      seed.values.recurrenceEndKind!,
      false,
      [
        {
          id:
            'none',
          label:
            'Does not recur',
        },
        {
          id:
            'never',
          label:
            'Never ends',
        },
        {
          id:
            'until',
          label:
            'Ends on a date',
        },
        {
          id:
            'count',
          label:
            'Ends after a number of times',
        },
      ],
      true,
      unreadable,
    ),
    field(
      'recurrenceUntil',
      'End date',
      'date',
      edited,
      seed.values.recurrenceUntil!,
      false,
      [],
      true,
      endKind
      === 'until'
        ? null
        : 'Only used when the end condition is a date.',
    ),
    field(
      'recurrenceCount',
      'Number of times',
      'number',
      edited,
      seed.values.recurrenceCount!,
      false,
      [],
      true,
      endKind
      === 'count'
        ? null
        : 'Only used when the end condition is a number of times.',
    ),
    field(
      'recurrenceScope',
      'Changing one occurrence',
      'derived',
      edited,
      EVENT_EDITOR_SCOPE_NOTE,
      false,
      [],
      false,
      'Occurrences and series are different things to change.',
    ),
  ];
}

/**
 * Project the Event editor.
 *
 * @param state - the loaded state, which supplies the projects, the statuses and the schema.
 * @param eventId - the event being edited.
 * @param draft - the edits so far, or null while nothing has been edited.
 * @param recurrence - what the record's recurrence amounts to.
 * @returns the editor, or null when no such event is loaded.
 */
export function projectEventEditor(
  input:
    EventEditorInput,
  eventId:
    string,
  draft:
    FormDraft | null,
  recurrence:
    EventEditorRecurrence,
): EventEditorProjection | null {
  const event =
    input.events.find(
      (candidate) =>
        candidate.id
        === eventId,
    );

  if (event === undefined) {
    return null;
  }

  const seed =
    eventEditorDraftFor(
      event,
      recurrence,
    );

  const edited =
    draft
    ?? seed;

  const values =
    eventValues(
      event,
    );

  const eventFields:
    EventEditorField[] = [
      field(
        'name',
        'Name',
        'text',
        edited,
        values.name!,
        false,
        [],
        true,
        null,
      ),
      field(
        'description',
        'Description',
        'textarea',
        edited,
        values.description!,
        false,
        [],
        true,
        null,
      ),
      field(
        'project',
        'Project',
        'select',
        edited,
        values.project!,
        false,
        input.projectChoices,
        true,
        null,
      ),
      field(
        'start',
        'Start',
        'date',
        edited,
        values.start!,
        false,
        [],
        true,
        null,
      ),
      field(
        'end',
        'End',
        'date',
        edited,
        values.end!,
        false,
        [],
        true,
        'The record stores this as the event deadline.',
      ),
      field(
        'completion',
        'Completed',
        'checkbox',
        edited,
        '',
        event.isCompleted
        === true,
        [],
        true,
        null,
      ),
    ];

  const recurrenceSection:
    EventEditorField[] =
      recurrenceFields(
        recurrence,
        edited,
        seed,
      );

  return {
    eventId:
      event.id,
    title:
      event.name,
    projectId:
      event.projectId,
    sections: [
      {
        id:
          'event',
        label:
          'Event',
        fields:
          eventFields,
      },
      {
        id:
          'recurrence',
        label:
          'Recurrence',
        fields:
          recurrenceSection,
      },
    ],
    dirty:
      draft !== null
      && !sameFormDraft(
        draft,
        seed,
      ),
    fieldCount:
      eventFields.length
      + recurrenceSection.length,
    colourNote:
      EVENT_EDITOR_COLOUR_NOTE,
    recurrenceKind:
      recurrence.kind,
  };
}

/** Apply one edit to an Event editor draft. */
export const applyEventEditorEdit:
  typeof applyFormEdit =
    applyFormEdit;

/** Whether two Event editor drafts hold the same edits. */
export const sameEventEditorDraft:
  typeof sameFormDraft =
    sameFormDraft;

/** One edit of the Event editor's form. */
export type EventEditorEdit =
  FormEdit;

/** What has been typed into the Event editor but not saved. */
export type EventEditorDraft =
  FormDraft;
