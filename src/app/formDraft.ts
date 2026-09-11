/**
 * The provisional-form primitives every editor shares.
 *
 * A draft is what has been typed but not saved. It holds text values, flags and
 * selections, keyed by the field id they belong to, and it is `null` — not an empty
 * draft — that means "nothing has been edited": that is what makes Cancel exact, because
 * discarding is `null` rather than a rebuild that hopes to reproduce the record.
 *
 * The Task editor and the Event editor both edit forms, so the mechanics live here once.
 * What each editor *shows* is its own projection; only the arithmetic of "one more
 * keystroke" and "is this still the record?" is shared.
 *
 * @module app/formDraft
 */

/** What has been typed into a form but not saved. */
export interface FormDraft {
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

/**
 * One edit, as a value rather than a callback. The shape of the edit is what says which
 * part of the form it belongs to, so a caller that reports the wrong kind for a field is
 * a bug in the caller and not a keystroke that quietly went nowhere.
 */
export type FormEdit =
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

/**
 * Apply one edit.
 * @param draft - the draft so far.
 * @param edit - the edit to apply.
 * @returns the next draft, which never shares the edited record with the old one.
 */
export function applyFormEdit(
  draft:
    FormDraft,
  edit:
    FormEdit,
): FormDraft {
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

/**
 * Whether two drafts hold the same edits.
 *
 * This is what `dirty` is computed from, so it is deliberately exact: a draft that
 * started from a record and was edited back to that record is not a change.
 * @param left - one draft.
 * @param right - the other.
 * @returns true when they hold the same values, flags and selections.
 */
export function sameFormDraft(
  left:
    FormDraft,
  right:
    FormDraft,
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
