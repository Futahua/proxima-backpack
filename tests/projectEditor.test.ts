/**
 * The project editor's draft, which is the form's memory between keystrokes.
 *
 * The point of a draft rather than a live edit is that "what changed" is a computation over two
 * values: the record and what the form says. These cases pin that computation, including the two
 * answers a reader might expect the form to make silently — a cleared description, which is a real
 * edit, and a cleared name, which the form passes on for the operation to refuse.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectEditorEdit,
  planProjectFieldMutations,
  projectEditorDraftFor,
  projectEditorIsDirty,
} from '../src/app/projectEditor.js';

const PROJECT = { name: 'Atlas', description: 'The project' };

describe('Stage 11 the project editor draft', () => {
  it('starts from the record and plans only the fields that changed', () => {
    const draft = projectEditorDraftFor(PROJECT);
    expect(draft).toEqual({ name: 'Atlas', description: 'The project' });
    expect(planProjectFieldMutations(PROJECT, draft)).toEqual([]);
    expect(projectEditorIsDirty(PROJECT, draft)).toBe(false);

    expect(planProjectFieldMutations(PROJECT, applyProjectEditorEdit(draft, { kind: 'name', value: 'Atlas II' })))
      .toEqual([{ kind: 'name', value: 'Atlas II' }]);
    expect(planProjectFieldMutations(PROJECT, applyProjectEditorEdit(draft, { kind: 'description', value: 'Rewritten' })))
      .toEqual([{ kind: 'description', value: 'Rewritten' }]);
    // Both changed is both submitted, in the order the record declares its fields.
    expect(planProjectFieldMutations(PROJECT, { name: 'Atlas II', description: 'Rewritten' }))
      .toEqual([{ kind: 'name', value: 'Atlas II' }, { kind: 'description', value: 'Rewritten' }]);
  });

  it('treats a cleared description as an edit and leaves a cleared name for the operation to refuse', () => {
    const cleared = projectEditorDraftFor(PROJECT);
    // Empty is a value a description can hold, so this is a change like any other.
    expect(planProjectFieldMutations(PROJECT, { ...cleared, description: '' })).toEqual([{ kind: 'description', value: '' }]);
    expect(projectEditorIsDirty(PROJECT, { ...cleared, description: '' })).toBe(true);

    // A project is named. The form does not trim, refuse or repair it: it submits what was typed,
    // and `updateProject` answers `validation-refused` for a name that is not a name.
    expect(planProjectFieldMutations(PROJECT, { ...cleared, name: '   ' })).toEqual([{ kind: 'name', value: '   ' }]);
    expect(planProjectFieldMutations(PROJECT, { ...cleared, name: '' })).toEqual([{ kind: 'name', value: '' }]);
  });

  it('applies one edit without disturbing the other field', () => {
    const draft = projectEditorDraftFor(PROJECT);
    const renamed = applyProjectEditorEdit(draft, { kind: 'name', value: 'Renamed' });
    expect(renamed).toEqual({ name: 'Renamed', description: 'The project' });
    expect(applyProjectEditorEdit(renamed, { kind: 'description', value: 'New text' }))
      .toEqual({ name: 'Renamed', description: 'New text' });
    // A draft is a value: an edit returns a new one rather than mutating the one it was given.
    expect(draft).toEqual({ name: 'Atlas', description: 'The project' });
  });
});
