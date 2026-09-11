/**
 * The project editor's provisional values, and the mutations they come to.
 *
 * The same shape the Task editor uses, and for the same reason: the form holds a draft rather than
 * editing the record, so "what changed" is a computation over two values instead of a reading of
 * whatever the DOM happens to contain, and a save with nothing changed is refused as a no-op rather
 * than written as a record that says the same thing.
 *
 * Exactly the two fields the record carries are offered. `projectType` is deliberately absent: A4
 * removed that legacy label from capability decisions, so an editor that could set it would be
 * reintroducing the silo. A cleared description is a real edit — the field exists and empty is a
 * value it can hold — while a cleared name is refused downstream, because a project is named.
 */
import type { Project } from '../domain/types.js';
import type { ProjectFieldMutation } from './projectMutations.js';

export interface ProjectEditorDraft {
  name: string;
  description: string;
}

export interface ProjectEditorEdit {
  kind: 'name' | 'description';
  value: string;
}

/** What the form starts from: the record, read. Never a rebuilt guess at it. */
export function projectEditorDraftFor(project: Pick<Project, 'name' | 'description'>): ProjectEditorDraft {
  return { name: project.name, description: project.description };
}

export function applyProjectEditorEdit(draft: ProjectEditorDraft, edit: ProjectEditorEdit): ProjectEditorDraft {
  return edit.kind === 'name' ? { ...draft, name: edit.value } : { ...draft, description: edit.value };
}

/**
 * The mutations a save would submit — only the fields the draft actually changed.
 *
 * Values are passed through as typed rather than trimmed: the operation validates, and a name that
 * is only whitespace should be refused by the layer that owns the rule, not silently rewritten by a
 * form that decided it knew better.
 */
export function planProjectFieldMutations(
  project: Pick<Project, 'name' | 'description'>,
  draft: ProjectEditorDraft,
): ProjectFieldMutation[] {
  const mutations: ProjectFieldMutation[] = [];
  if (draft.name !== project.name) mutations.push({ kind: 'name', value: draft.name });
  if (draft.description !== project.description) mutations.push({ kind: 'description', value: draft.description });
  return mutations;
}

export function projectEditorIsDirty(
  project: Pick<Project, 'name' | 'description'>,
  draft: ProjectEditorDraft,
): boolean {
  return planProjectFieldMutations(project, draft).length > 0;
}
