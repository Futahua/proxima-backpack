/**
 * The Task editor's write path: what a Save means, and what a Delete means.
 *
 * Two halves, and the first one is the interesting one.
 *
 * **A plan, not a patch.** `planTaskEditorSave` compares the draft against the record it was
 * seeded from and emits one typed mutation *per field that actually changed* — nothing else. That
 * matters beyond tidiness: a field nobody touched is a field a concurrent editor may have already
 * changed, and rewriting it would be this form overwriting work it never saw. A save that changed
 * nothing is refused rather than treated as an empty write, because a caller that asked for
 * nothing has a bug and a silent success would hide it.
 *
 * **Only the task's own fields.** Custom properties are refused by name, with the reason: their
 * values reached the editor through a *compatibility* projection (a select's option id became its
 * label, a relation became a list of record ids), so writing one back needs the canonical mapping
 * that Stage 10 owns. Refusing loudly is the honest half of that; dropping the edit silently
 * would be the dishonest one.
 *
 * **The sequence is the shell's, minus the shell.** `saveTaskFromEditor` and
 * `deleteTaskFromEditor` take operations rather than a store, carry the revision the card was
 * read at, and re-read the surfaces afterwards by the same rule every write follows.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CanonicalExecutionState } from '../domain/canonicalTaskState.js';
import type { IdGenerator } from '../domain/clock.js';
import type { PropertySchema } from '../domain/types.js';
import type { ProximaState, Task } from '../domain/types.js';
import { taskEditorDraftFor, type TaskEditorDraft } from './taskEditor.js';
import { taskMoveActionType, type TaskMoveActionType } from './taskMoveGesture.js';
import { workflowMutationsFor, workflowMoveAction, workflowMoveActionType, type WorkflowMoveActionType } from './workflowMoveGesture.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, semanticOutcomeOf, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import type { TaskFieldMutation, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import { planPropertyMutation } from './propertyMutationPlan.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const TASK_EDITOR_WRITE_SCHEMA_VERSION = 1 as const;

/** The canonical execution states, which are the only columns a task may be moved to. */
const EXECUTION_STATES: readonly CanonicalExecutionState[] = ['backlog', 'running', 'finished'];

export type TaskEditorPlanFailureReason = 'nothing-to-save' | 'unsupported-field' | 'unknown-schema' | 'validation-refused';

export type TaskEditorMutationPlan =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof TASK_EDITOR_WRITE_SCHEMA_VERSION;
      readonly mutations: readonly TaskFieldMutation[];
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof TASK_EDITOR_WRITE_SCHEMA_VERSION;
      readonly reason: TaskEditorPlanFailureReason;
      readonly detail: string;
      /** The field the refusal is about, so a form can mark it rather than the whole modal. */
      readonly fieldId: string | null;
    };

function planRefused(
  reason: TaskEditorPlanFailureReason,
  detail: string,
  fieldId: string | null,
): TaskEditorMutationPlan {
  return { ok: false, schemaVersion: TASK_EDITOR_WRITE_SCHEMA_VERSION, reason, detail, fieldId };
}

/** Empty text is "no value"; anything else must be an instant the canonical record can carry. */
function instantOrNull(value: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  return Number.isFinite(Date.parse(trimmed)) ? { ok: true, value: trimmed } : { ok: false };
}

/** Whole minutes, or nothing at all. */
function minutesOrNull(value: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? { ok: true, value: parsed } : { ok: false };
}

function numberOrNull(value: string): { ok: true; value: number } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false };
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
}

/**
 * What a Save would write, given the record and the form.
 *
 * @param task - the task as the editor's projection read it.
 * @param draft - the edits so far, or null while nothing has been edited.
 * @returns one mutation per changed field, or a typed refusal.
 */
/**
 * Where a card lands when an edit moves it into a workflow stage.
 *
 * A modal has no pointer, so it cannot choose a position the way a drop does; the honest answer is the end of
 * the target stage, and the end is a **count the caller owns** rather than something this planner can read. So
 * the caller supplies it, exactly as the timeline and project operations take a caller-owned revision: an
 * operation that cannot see the board asks whoever can. A caller that supplies nothing gets a refusal rather
 * than a guess - the position would otherwise be one somebody else already holds.
 */
export interface TaskEditorStagePlacement {
  /** How many cards the stage holds, so an edit that enters it can append; null when it is not this project's stage. */
  appendIndex(stageId: string): number | null;
}

export function planTaskEditorSave(
  task: Task,
  draft: TaskEditorDraft | null,
  schemas: readonly PropertySchema[] = [],
  stagePlacement?: TaskEditorStagePlacement,
): TaskEditorMutationPlan {
  if (draft === null) return planRefused('nothing-to-save', 'nothing has been edited yet', null);

  const seed = taskEditorDraftFor(task);
  const value = (id: string): string => draft.values[id] ?? seed.values[id] ?? '';
  const flag = (id: string): boolean => draft.checks[id] ?? seed.checks[id] ?? false;
  const valueChanged = (id: string): boolean => draft.values[id] !== undefined && draft.values[id] !== (seed.values[id] ?? '');
  const flagChanged = (id: string): boolean => draft.checks[id] !== undefined && draft.checks[id] !== (seed.checks[id] ?? false);

  const mutations: TaskFieldMutation[] = [];

  if (valueChanged('name')) {
    const name = value('name').trim();
    if (name.length === 0) return planRefused('validation-refused', 'a task needs a name', 'name');
    mutations.push({ kind: 'name', value: name });
  }

  if (valueChanged('project')) {
    const project = value('project').trim();
    mutations.push({ kind: 'project', value: project.length === 0 ? null : project as OpaqueRecordId });
  }

  if (valueChanged('executionState')) {
    const state = value('executionState').trim() as CanonicalExecutionState;
    if (!EXECUTION_STATES.includes(state)) {
      return planRefused('validation-refused', 'a column is Backlog, Running or Finished', 'executionState');
    }
    mutations.push({ kind: 'execution-state', value: state });
  }

  if (valueChanged('workflowStage')) {
    // The stage and its position move together, and this is the one field whose position a modal cannot
    // choose: entering a stage appends to the end of it, which is a count only the caller can read. Clearing
    // the field leaves the stage, and the record clears the position with it.
    const stage = value('workflowStage').trim();
    if (stage.length === 0) {
      mutations.push(...workflowMutationsFor(task.workflowStageId ?? null, null, null));
    } else {
      const placement = stagePlacement?.appendIndex(stage) ?? null;
      if (placement === null || !Number.isSafeInteger(placement) || placement < 0) {
        return planRefused(
          'validation-refused',
          'that workflow stage is not one this task\'s project declares',
          'workflowStage',
        );
      }
      mutations.push(...workflowMutationsFor(task.workflowStageId ?? null, stage, placement));
    }
  }

  if (valueChanged('weight')) {
    const weight = numberOrNull(value('weight'));
    if (!weight.ok || weight.value < 0) return planRefused('validation-refused', 'weight is a number that is not negative', 'weight');
    mutations.push({ kind: 'weight', value: weight.value });
  }

  // Fixed duration travels as one mutation because the record refuses half of it: a duration
  // without the flag would be a number nobody counts, and the flag without one nothing to count.
  if (flagChanged('fixedDurationOn') || valueChanged('fixedDuration')) {
    const isFixedDuration = flag('fixedDurationOn');
    if (isFixedDuration) {
      const fixed = minutesOrNull(value('fixedDuration'));
      if (!fixed.ok || fixed.value === null) {
        return planRefused('validation-refused', 'a fixed-duration task needs a duration in whole minutes', 'fixedDuration');
      }
      mutations.push({ kind: 'fixed-duration', isFixedDuration: true, fixedDuration: fixed.value });
    } else {
      mutations.push({ kind: 'fixed-duration', isFixedDuration: false, fixedDuration: null });
    }
  }

  if (valueChanged('maxDuration')) {
    const max = minutesOrNull(value('maxDuration'));
    if (!max.ok) return planRefused('validation-refused', 'the maximum duration is whole minutes, or nothing at all', 'maxDuration');
    mutations.push({ kind: 'max-duration', value: max.value });
  }

  // Dates travel together for the same reason the record keeps them together: an inverted pair
  // is not a state either half should be able to reach on its own.
  if (valueChanged('startDate') || valueChanged('deadline')) {
    const startDate = instantOrNull(value('startDate'));
    const deadline = instantOrNull(value('deadline'));
    if (!startDate.ok) return planRefused('validation-refused', 'the start date is not a readable instant', 'startDate');
    if (!deadline.ok) return planRefused('validation-refused', 'the deadline is not a readable instant', 'deadline');
    mutations.push({ kind: 'dates', startDate: startDate.value, deadline: deadline.value });
  }

  if (flagChanged('completion')) {
    // Completion as data. It deliberately does not move the execution state: a caller that wants
    // the board to change says so with the column.
    mutations.push({ kind: 'completion', value: flag('completion') });
  }

  // Custom properties go through the canonical mapping Stage 10 owns: the form holds what the
  // compatibility projection produced — a select's label, a relation's ids — so writing one back
  // needs the schema to reverse it, and a value the schema cannot account for is refused by name
  // rather than half-written.
  for (const id of changedPropertyFieldIds(draft, seed)) {
    const schemaId = id.slice('property:'.length);
    const planned = planPropertyMutation(
      schemas.find((candidate) => candidate.id === schemaId),
      {
        value: value(id),
        checked: flag(id),
        selected: draft.selections[id] ?? seed.selections[id] ?? [],
      },
    );
    if (!planned.ok) return planRefused(planned.reason, planned.detail, id);
    mutations.push({ kind: 'property', key: schemaId as OpaqueRecordId, value: planned.value });
  }

  if (mutations.length === 0) {
    return planRefused('nothing-to-save', 'the form matches the record, so there is nothing to write', null);
  }

  return { ok: true, schemaVersion: TASK_EDITOR_WRITE_SCHEMA_VERSION, mutations };
}

/** Property fields the draft changed, in a stable order, so the refusal names one deterministically. */
function changedPropertyFieldIds(draft: TaskEditorDraft, seed: TaskEditorDraft): string[] {
  const ids = new Set<string>([
    ...Object.keys(draft.values),
    ...Object.keys(draft.checks),
    ...Object.keys(draft.selections),
  ]);

  return [...ids]
    .filter((id) => id.startsWith('property:'))
    .filter((id) => (
      (draft.values[id] ?? seed.values[id] ?? '') !== (seed.values[id] ?? '')
      || (draft.checks[id] ?? seed.checks[id] ?? false) !== (seed.checks[id] ?? false)
      || (draft.selections[id] ?? []).join('\u0000') !== (seed.selections[id] ?? []).join('\u0000')
    ))
    .sort();
}

/**
 * The operations an editor needs, structurally: the two the shell resolved, and no store.
 */
export interface TaskEditorWriteOperations {
  updateTask(input: {
    taskId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly TaskFieldMutation[];
  }): Promise<TaskMutationResult>;
  deleteTask(input: { taskId: OpaqueRecordId; expectedRevision: string }): Promise<TaskMutationResult>;
}

export interface TaskEditorWriteDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<TaskEditorWriteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export type TaskEditorWriteFailureReason =
  | 'unknown-task'
  | 'writes-unavailable'
  | TaskEditorPlanFailureReason
  | TaskMutationFailureReason;

export type TaskEditorWriteOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof TASK_EDITOR_WRITE_SCHEMA_VERSION;
      readonly outcome: 'updated' | 'deleted';
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof TASK_EDITOR_WRITE_SCHEMA_VERSION;
      readonly reason: TaskEditorWriteFailureReason;
      readonly detail: string;
      readonly fieldId: string | null;
      /** Present on a refusal too, so a save that lost a race is correlatable with the event it left. */
      readonly requestId: string;
      readonly refreshed: boolean;
      /** The revision that beat this caller, when the refusal was a lost race. */
      readonly actualRevision?: string;
    };

function writeRefused(
  reason: TaskEditorWriteFailureReason,
  detail: string,
  requestId: string,
  fieldId: string | null = null,
  refreshed = false,
  actualRevision?: string,
): TaskEditorWriteOutcome {
  return {
    ok: false,
    schemaVersion: TASK_EDITOR_WRITE_SCHEMA_VERSION,
    reason,
    detail,
    fieldId,
    requestId,
    refreshed,
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
}

function taskOf(deps: TaskEditorWriteDependencies, taskId: string): Task | null {
  return deps.state?.tasks.find((candidate) => candidate.id === taskId) ?? null;
}

/**
 * Save the editor's form.
 *
 * The plan is built from the record the *surface* is showing, and the write carries that record's
 * revision, so a save against a card someone else has since changed is refused rather than merged.
 *
 * The semantic envelope is minted here, before the card lookup, so a save refused because the card is gone is
 * correlatable too; one terminal event follows, after convergence where the store was touched. The event's
 * action type is the semantic verb this save actually is - a save that moves the card between columns is an
 * execution move as well as an edit, and `taskEditorSaveActionType` is the function that already knows that.
 */
export async function saveTaskFromEditor(
  deps: TaskEditorWriteDependencies,
  input: { readonly taskId: string; readonly draft: TaskEditorDraft | null },
): Promise<TaskEditorWriteOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, actionType: string, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  const task = taskOf(deps, input.taskId);
  if (task === null) {
    audit('rejected', 'task.update', [], 'unknown-task');
    return writeRefused('unknown-task', 'the editor has no card with that id', requestId);
  }

  const plan = planTaskEditorSave(task, input.draft, deps.state?.taskSchema ?? [], {
    // The board's own answer, read from the state this save was opened over: the stage must belong to the
    // task's project, and the end of it is how many cards are in it now.
    appendIndex: (stageId) => {
      const stages = deps.state?.workflowStages ?? [];
      if (!stages.some((stage) => stage.id === stageId && stage.projectId === (task.projectId ?? ''))) return null;
      return (deps.state?.tasks ?? []).filter((candidate) => candidate.workflowStageId === stageId).length;
    },
  });
  if (!plan.ok) {
    audit('rejected', 'task.update', [task.id], plan.reason);
    return writeRefused(plan.reason, plan.detail, requestId, plan.fieldId);
  }

  const actionType = taskEditorSaveActionType(task, plan.mutations);

  deps.setRefusal(null);
  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', actionType, [task.id], 'writes-unavailable');
    return writeRefused('writes-unavailable', reason, requestId);
  }

  const written = await writes.updateTask({
    taskId: task.id as OpaqueRecordId,
    expectedRevision: task.source.revision,
    mutations: plan.mutations,
  });

  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  deps.render();

  if (!written.ok) {
    audit(semanticOutcomeOf({ wrote: 0, refused: true }), actionType, [task.id], written.reason);
    return writeRefused(written.reason, written.detail, requestId, null, convergence.refreshed, written.actualRevision);
  }

  audit(semanticOutcomeOf({ wrote: 1, refused: false }), actionType, [task.id]);
  return {
    ok: true,
    schemaVersion: TASK_EDITOR_WRITE_SCHEMA_VERSION,
    outcome: 'updated',
    requestId,
    revision: written.revision,
    refreshed: convergence.refreshed,
  };
}

/**
 * Delete the card the editor is showing.
 *
 * Deleting is not a form edit, so there is no plan to build and nothing to be dirty: the
 * revision the card was read at is the whole request.
 */
export async function deleteTaskFromEditor(
  deps: TaskEditorWriteDependencies,
  input: { readonly taskId: string },
): Promise<TaskEditorWriteOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: 'task.delete',
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  const task = taskOf(deps, input.taskId);
  if (task === null) {
    audit('rejected', [], 'unknown-task');
    return writeRefused('unknown-task', 'the editor has no card with that id', requestId);
  }

  deps.setRefusal(null);
  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', [task.id], 'writes-unavailable');
    return writeRefused('writes-unavailable', reason, requestId);
  }

  const written = await writes.deleteTask({
    taskId: task.id as OpaqueRecordId,
    expectedRevision: task.source.revision,
  });

  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  deps.render();

  if (!written.ok) {
    audit(semanticOutcomeOf({ wrote: 0, refused: true }), [task.id], written.reason);
    return writeRefused(written.reason, written.detail, requestId, null, convergence.refreshed, written.actualRevision);
  }

  audit(semanticOutcomeOf({ wrote: 1, refused: false }), [task.id]);
  return {
    ok: true,
    schemaVersion: TASK_EDITOR_WRITE_SCHEMA_VERSION,
    outcome: 'deleted',
    requestId,
    revision: written.revision,
    refreshed: convergence.refreshed,
  };
}

/**
 * The action type a save is reported as, for callers that audit coverage by semantic operation.
 *
 * A save that moves the card between columns *is* an execution move as well as an edit, and
 * saying so is how the audit sees both without a second write. The same rule names the other
 * structural edits a save can carry, in the order a reader would rank them: the execution column
 * first, then the workflow stage, then an in-stage position, then a property, and `task.update` for
 * an ordinary field edit. One run leaves one event, so a save that carries two of these is reported
 * as the one that moved the card somewhere rather than as both.
 */
export type TaskEditorSaveActionType = 'task.update' | 'task.property.change' | TaskMoveActionType | WorkflowMoveActionType;

export function taskEditorSaveActionType(
  task: Task,
  mutations: readonly TaskFieldMutation[],
): TaskEditorSaveActionType {
  const moved = mutations.find((mutation) => mutation.kind === 'execution-state');
  if (moved !== undefined && moved.kind === 'execution-state') {
    return taskMoveActionType(
      task.status === 'running' || task.status === 'finished' ? task.status : 'backlog',
      moved.value,
    );
  }

  const staged = mutations.find((mutation) => mutation.kind === 'workflow-stage');
  if (staged !== undefined && staged.kind === 'workflow-stage') {
    return workflowMoveActionType(workflowMoveAction(task.workflowStageId ?? null, staged.value));
  }

  if (mutations.some((mutation) => mutation.kind === 'workflow-order')) {
    return 'task.workflow.reorder';
  }

  // A relation is a property value here, so the two rows Stage 17 audits separately share this verb
  // rather than growing a second name for one mutation.
  if (mutations.some((mutation) => mutation.kind === 'property')) {
    return 'task.property.change';
  }

  return 'task.update';
}

/**
 * What a save or a delete means for the form the shell is holding.
 *
 * The shell owns two pieces of session state — which card is open and what has been typed — so
 * the sequences report what should happen to them rather than reaching for them. That keeps the
 * rule that matters testable: a **refused** save keeps the edits (the reader retries from the
 * authoritative revision rather than retyping), and only an accepted one clears them, because
 * only then does the record actually match the form.
 */
export interface TaskEditorActionEffect<Outcome = TaskEditorWriteOutcome> {
  /** Null when there was nothing to act on: no card was open. */
  readonly outcome: Outcome | null;
  readonly clearDraft: boolean;
  readonly closeEditor: boolean;
}

function noEditor(): TaskEditorActionEffect {
  return { outcome: null, clearDraft: false, closeEditor: false };
}

export async function saveTaskAction(
  deps: TaskEditorWriteDependencies,
  input: { readonly taskId: string | null; readonly draft: TaskEditorDraft | null },
): Promise<TaskEditorActionEffect> {
  if (input.taskId === null) return noEditor();
  const outcome = await saveTaskFromEditor(deps, { taskId: input.taskId, draft: input.draft });
  return { outcome, clearDraft: outcome.ok, closeEditor: false };
}

export async function deleteTaskAction(
  deps: TaskEditorWriteDependencies,
  input: { readonly taskId: string | null },
): Promise<TaskEditorActionEffect> {
  if (input.taskId === null) return noEditor();
  const outcome = await deleteTaskFromEditor(deps, { taskId: input.taskId });
  return { outcome, clearDraft: outcome.ok, closeEditor: outcome.ok };
}
