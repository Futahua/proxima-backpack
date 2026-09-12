/**
 * The New Task form: what it shows, and what its Save means.
 *
 * The product had no way to create a task at all — no control, no form, nothing that named
 * `task.create` outside the write path's own tests. This is the missing half, and it is deliberately
 * the *same shape* the card editor established rather than a second idiom: a draft (`FormDraft`,
 * `null` meaning "not open"), a projection that consumes the same `TaskEditorField` vocabulary so the
 * surface renders it with the same control per type, a plan that turns the draft into one closed
 * typed request, and a sequence that executes it through operations rather than a store.
 *
 * Three decisions worth keeping:
 *
 * **A create is a plan, not a patch.** `planTaskCreate` refuses anything the request could not hold
 * *before* the write path is asked, and every refusal names the field it is about, so the form can
 * mark one input rather than the whole modal.
 *
 * **Only fields the request can carry.** The write path accepts a name, a project, a description,
 * an execution state, a weight, dates, durations and both orderings — and custom properties, which
 * need the canonical schema mapping Stage 10 owns. So this form offers exactly the first group and
 * says nothing about properties: a creation form that showed a field it could not write would be
 * inventing a promise, and the card editor's refusal of property edits is the same boundary seen
 * from the other side.
 *
 * **A new task starts where the board is.** The project defaults to the one the reader is looking
 * at, because that is the only reading of "new task" that does not require a second choice; a
 * selection that is not a project (All projects, Uncategorised) defaults to no project instead of
 * guessing one.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CanonicalExecutionState } from '../domain/canonicalTaskState.js';
import type { IdGenerator } from '../domain/clock.js';
import type { ProximaState } from '../domain/types.js';
import type { FormEdit } from './formDraft.js';
import { EXECUTION_STATE_STATUSES } from './recordStateProjection.js';
import { mintSemanticRequestId, semanticOutcomeOf, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import type { CreateTaskRequest, TaskMutationFailureReason, TaskMutationResult } from './taskMutations.js';
import type { TaskEditorDraft, TaskEditorField, TaskEditorOption, TaskEditorSection } from './taskEditor.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import type { TaskEditorActionEffect } from './taskEditorWrite.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const TASK_CREATE_SCHEMA_VERSION = 1 as const;

/**
 * The verb a create is journalled under, exported so a boundary that reaches this operation does not spell it.
 *
 * The taxonomy registers no `task.create` - a create is an operation with a draft rather than a dispatcher verb,
 * which the wire's own battery asserts - so this constant is the one place the name lives.
 */
export const TASK_CREATE_ACTION_TYPE = 'task.create';

const EXECUTION_STATES: readonly CanonicalExecutionState[] = ['backlog', 'running', 'finished'];

export type TaskCreatePlanFailureReason = 'validation-refused' | 'unknown-project';

export interface TaskCreateProjection {
  readonly title: string;
  readonly sections: readonly TaskEditorSection[];
  readonly fieldCount: number;
  /** True once the form holds anything a save could write. */
  readonly dirty: boolean;
}

export interface TaskCreatePlanOk {
  readonly ok: true;
  readonly schemaVersion: typeof TASK_CREATE_SCHEMA_VERSION;
  readonly request: CreateTaskRequest;
}

export interface TaskCreatePlanRefused {
  readonly ok: false;
  readonly schemaVersion: typeof TASK_CREATE_SCHEMA_VERSION;
  readonly reason: TaskCreatePlanFailureReason;
  readonly detail: string;
  readonly fieldId: string;
}

export type TaskCreatePlan = TaskCreatePlanOk | TaskCreatePlanRefused;

/** One edit of the New Task form, which is the shared form vocabulary. */
export type TaskCreateEdit = FormEdit;

/**
 * A draft holding the form's defaults.
 *
 * The project defaults from what the reader is looking at — but only when that selection *is* a
 * project. "All projects" and "Uncategorised" are how the reader is filtering the board, not a
 * destination for new work, so they default to no project rather than picking one on the reader's
 * behalf.
 *
 * @param state - the loaded state, so a selection can be checked against the projects it holds.
 * @param selection - the project selection the reader is on.
 * @returns a draft whose values are the defaults, not a copy of any record.
 */
export function newTaskDraft(state: ProximaState, selection: string): TaskEditorDraft {
  const project = state.projects.some((candidate) => candidate.id === selection) ? selection : '';
  return {
    values: {
      name: '',
      project,
      executionState: 'backlog',
      weight: '1',
      fixedDuration: '',
      maxDuration: '',
      startDate: '',
      deadline: '',
    },
    checks: {
      fixedDurationOn: false,
    },
    selections: {},
  };
}

function selectOptions(items: readonly { id: string; label: string }[]): TaskEditorOption[] {
  return items.map((item) => ({ id: item.id, label: item.label }));
}

function field(
  id: string,
  label: string,
  control: TaskEditorField['control'],
  draft: TaskEditorDraft,
  options: readonly TaskEditorOption[] = [],
  note: string | null = null,
): TaskEditorField {
  const value = draft.values[id] ?? '';
  return {
    id,
    label,
    control,
    value,
    checked: draft.checks[id] ?? false,
    options,
    selected: draft.selections[id] ?? [],
    editable: true,
    note,
    propertyType: null,
  };
}

/**
 * Project the New Task form.
 *
 * @param state - the loaded state, which supplies the projects the form may choose from.
 * @param draft - the form's values.
 * @returns the sections the surface renders, in the same shape the Task editor uses.
 */
export function projectNewTaskEditor(state: ProximaState, draft: TaskEditorDraft): TaskCreateProjection {
  const projects = selectOptions([
    ...state.projects
      .filter((project) => project.status === 'active')
      .map((project) => ({ id: project.id, label: project.name })),
    { id: '', label: 'No project' },
  ]);
  // The canonical execution states, not the vault's statuses: the request can only carry these,
  // and offering a status the write path would refuse is how a form lies about what it can do.
  const states = selectOptions(EXECUTION_STATE_STATUSES.map((status) => ({ id: status.id, label: status.name })));

  const fields: TaskEditorField[] = [
    field('name', 'Name', 'text', draft, [], 'A task needs a name.'),
    field('project', 'Project', 'select', draft, projects),
    field('executionState', 'Column', 'select', draft, states),
    field('weight', 'Weight', 'number', draft, [], 'Higher weight claims more of the remaining time.'),
    field('fixedDurationOn', 'Fixed duration', 'checkbox', draft),
    field('fixedDuration', 'Fixed duration (minutes)', 'number', draft, [], draft.checks.fixedDurationOn === true ? null : 'Only counted while fixed duration is on.'),
    field('maxDuration', 'Maximum duration (minutes)', 'number', draft, [], 'Caps how far an elastic task may stretch.'),
    field('startDate', 'Start', 'text', draft),
    field('deadline', 'Deadline', 'text', draft),
  ];

  return {
    title: 'New task',
    sections: [{ id: 'task', label: 'Task', fields }],
    fieldCount: fields.length,
    dirty: (draft.values.name ?? '').trim().length > 0,
  };
}

function refused(reason: TaskCreatePlanFailureReason, detail: string, fieldId: string): TaskCreatePlanRefused {
  return { ok: false, schemaVersion: TASK_CREATE_SCHEMA_VERSION, reason, detail, fieldId };
}

function instantOrNull(value: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  return Number.isFinite(Date.parse(trimmed)) ? { ok: true, value: trimmed } : { ok: false };
}

function minutesOrNull(value: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? { ok: true, value: parsed } : { ok: false };
}

/**
 * What a New Task Save would ask for.
 *
 * @param state - the loaded state, so a project the form chose can be checked against it. Nothing else in the
 *   plan reads it, which is why the operation below can pass nothing: the state's only job here is to be the
 *   default answer for the project question, and a caller that cannot answer says so instead.
 * @param draft - the form's values.
 * @param isKnownProject - how a named project is checked, when the caller has a rule of its own.
 * @returns one closed typed request, or a typed refusal naming the field.
 */
export function planTaskCreate(
  state: ProximaState | null | undefined,
  draft: TaskEditorDraft,
  isKnownProject: (projectId: string) => boolean = (projectId) => state?.projects.some((candidate) => candidate.id === projectId) === true,
): TaskCreatePlan {
  const name = (draft.values.name ?? '').trim();
  if (name.length === 0) return refused('validation-refused', 'a task needs a name', 'name');

  const project = (draft.values.project ?? '').trim();
  // A named project is checked, and an empty one is not: a task with no project is ordinary, and the check is
  // about whether the *named* one exists. Who may name an unknown one is the caller's policy, which is why it
  // arrives as this predicate rather than being decided here.
  if (project.length > 0 && !isKnownProject(project)) {
    return refused('unknown-project', `no project ${project}`, 'project');
  }

  const executionState = (draft.values.executionState ?? 'backlog').trim() as CanonicalExecutionState;
  if (!EXECUTION_STATES.includes(executionState)) {
    return refused('validation-refused', 'a column is Backlog, Running or Finished', 'executionState');
  }

  const weightText = (draft.values.weight ?? '').trim();
  const weight = weightText.length === 0 ? 1 : Number(weightText);
  if (!Number.isFinite(weight) || weight < 0) return refused('validation-refused', 'weight is a number that is not negative', 'weight');

  const isFixedDuration = draft.checks.fixedDurationOn === true;
  const fixed = minutesOrNull(draft.values.fixedDuration ?? '');
  if (!fixed.ok || (isFixedDuration && fixed.value === null)) {
    return refused('validation-refused', 'a fixed-duration task needs a duration in whole minutes', 'fixedDuration');
  }
  const max = minutesOrNull(draft.values.maxDuration ?? '');
  if (!max.ok) return refused('validation-refused', 'the maximum duration is whole minutes, or nothing at all', 'maxDuration');
  if (max.value !== null && isFixedDuration && fixed.value !== null && max.value < fixed.value) {
    return refused('validation-refused', 'the maximum duration is below the fixed duration', 'maxDuration');
  }

  const startDate = instantOrNull(draft.values.startDate ?? '');
  if (!startDate.ok) return refused('validation-refused', 'the start date is not a readable instant', 'startDate');
  const deadline = instantOrNull(draft.values.deadline ?? '');
  if (!deadline.ok) return refused('validation-refused', 'the deadline is not a readable instant', 'deadline');
  if (startDate.value !== null && deadline.value !== null && Date.parse(deadline.value) < Date.parse(startDate.value)) {
    return refused('validation-refused', 'the deadline is before the start date', 'deadline');
  }

  return {
    ok: true,
    schemaVersion: TASK_CREATE_SCHEMA_VERSION,
    request: {
      name,
      projectId: project.length === 0 ? null : project as OpaqueRecordId,
      executionState,
      weight,
      startDate: startDate.value,
      deadline: deadline.value,
      isFixedDuration,
      fixedDuration: isFixedDuration ? fixed.value : null,
      maxDuration: max.value,
      // A new card lands at the top of its column; where it belongs among its peers is a drag,
      // and inventing a position here would claim an order nobody chose.
      executionOrder: 0,
    },
  };
}

/**
 * The operations a create needs, structurally.
 */
export interface TaskCreateOperations {
  createTask(request: CreateTaskRequest): Promise<TaskMutationResult>;
}

export interface TaskCreateDependencies extends TaskCreateOperationDependencies {
  readonly state: ProximaState | null;
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
}

/**
 * What the operation needs, and nothing a cockpit owns.
 *
 * The only fact a create took from a projection was whether a named project exists, and who may name one is a
 * caller's policy rather than a fact: the board can check its projection, and a caller that read the record
 * elsewhere has no projection to check against - so it says so and the record layer answers for a project
 * nobody holds. `state` stays above, because the refusal for no state at all is the *form's* answer: an agent
 * has no form to be unopened.
 */
export interface TaskCreateOperationDependencies {
  readonly writes: () => Promise<TaskCreateOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** Mints this run's semantic request id. Injected, like the record identity itself. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
  /**
   * Whether a named project is known to this caller.
   *
   * Absent means the caller cannot answer, and names `mayNameAnyProject` instead. A board answers by looking
   * the project up in what it rendered.
   */
  readonly isKnownProject?: (projectId: string) => boolean;
  /** True when the caller may name a project this operation cannot check - and takes the record layer's answer. */
  readonly mayNameAnyProject?: boolean;
  /**
   * What the surface does with the answer, before the run is journalled.
   *
   * Present only where there is a form, because the order is this family's contract and its own test pins it:
   * the board clears or sets its refusal and redraws after convergence, then the terminal event is appended.
   * It is **not** called for a refusal the plan decides: a form whose values are not a request has nothing to
   * draw differently, and the original behaviour - which this preserves rather than re-decides - was to journal
   * that refusal and stop.
   */
  readonly settle?: (outcome: TaskCreateOutcome, refusedBeforeStorage: boolean) => void;
}

export type TaskCreateFailureReason =
  | 'not-open'
  | 'writes-unavailable'
  | 'validation-refused'
  | 'unknown-project'
  | TaskMutationFailureReason;

export type TaskCreateOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof TASK_CREATE_SCHEMA_VERSION;
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly recordId: OpaqueRecordId;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof TASK_CREATE_SCHEMA_VERSION;
      readonly reason: TaskCreateFailureReason;
      readonly detail: string;
      readonly fieldId: string | null;
      /** Present on a refusal too, which is what makes a refused create correlatable. */
      readonly requestId: string;
      readonly refreshed: boolean;
    };

function createRefused(
  reason: TaskCreateFailureReason,
  detail: string,
  requestId: string,
  fieldId: string | null = null,
  refreshed = false,
): TaskCreateOutcome {
  return { ok: false, schemaVersion: TASK_CREATE_SCHEMA_VERSION, reason, detail, fieldId, requestId, refreshed };
}

/**
 * Create the task the draft describes, with no form and no projection in the dependency set.
 *
 * The envelope is minted before the plan is asked, so a refused plan is correlatable exactly like an accepted
 * create, and one terminal event is appended for every run. A create is a single record, so the outcome is
 * accepted or rejected and never partial; the shared rule decides that rather than this file.
 *
 * @param deps - the write callable, the refresh, the id source, the sink, and who may name a project.
 * @param draft - the values a form would have submitted.
 * @returns the outcome, with the store's revision when a task was created.
 */
export async function runTaskCreate(
  deps: TaskCreateOperationDependencies,
  draft: TaskEditorDraft,
): Promise<TaskCreateOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: TASK_CREATE_ACTION_TYPE,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  const plan = planTaskCreate(undefined, draft, (projectId) => {
    if (deps.mayNameAnyProject === true) return true;
    // A caller with no resolver has not answered the question, and this is where that is refused rather than
    // guessed: an operation that defaulted to "the project is fine" would be relying on the record layer to
    // disbelieve it, and the refusal that eventually came back would name the wrong reason.
    if (deps.isKnownProject === undefined) return false;
    return deps.isKnownProject(projectId);
  });
  if (!plan.ok) {
    const refusal = createRefused(plan.reason, plan.detail, requestId, plan.fieldId);
    // A plan refusal is not drawn: the form's values have not changed and the board already shows them.
    deps.settle?.(refusal, true);
    audit('rejected', [], plan.reason);
    return refusal;
  }

  const writes = await deps.writes();
  if (writes === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    const refusal = createRefused('writes-unavailable', reason, requestId);
    deps.settle?.(refusal, false);
    audit('rejected', [], 'writes-unavailable');
    return refusal;
  }

  const written = await writes.createTask(plan.request);
  const convergence = await convergeAfterWrite(deps, { accepted: written.ok });

  if (!written.ok) {
    const refusal = createRefused(written.reason, written.detail, requestId, null, convergence.refreshed);
    deps.settle?.(refusal, false);
    audit(semanticOutcomeOf({ wrote: 0, refused: true }), [], written.reason);
    return refusal;
  }

  const accepted: TaskCreateOutcome = {
    ok: true,
    schemaVersion: TASK_CREATE_SCHEMA_VERSION,
    requestId,
    recordId: written.recordId,
    revision: written.revision,
    refreshed: convergence.refreshed,
  };
  deps.settle?.(accepted, false);
  audit(semanticOutcomeOf({ wrote: 1, refused: false }), [written.recordId]);
  return accepted;
}

/**
 * The board's entry over the operation: refuse an unopened form, answer for the projects it can see, and
 * report the effect the editor acts on.
 *
 * The effect it reports is the same shape the editor's Save reports, so the shell treats "the form is done"
 * the same way in both places: an accepted create closes the form, a refused one leaves it open with
 * everything typed still in it. Both are the surface's business and stay here.
 */
export async function createTaskAction(
  deps: TaskCreateDependencies,
  input: { readonly draft: TaskEditorDraft | null },
): Promise<TaskEditorActionEffect<TaskCreateOutcome>> {
  if (input.draft === null) return { outcome: null, clearDraft: false, closeEditor: false };

  if (deps.state === null) {
    // The form's own refusal, and it *is* journalled - a run happened, and a refusal nobody can correlate is
    // a dead end - but nothing is drawn, because a form that was never open shows nothing differently. The id
    // is minted here because the operation is never reached: an agent has no form to be unopened.
    const requestId = mintSemanticRequestId(deps.ids);
    deps.audit.append({ requestId, actionType: 'task.create', outcome: 'rejected', entityIds: [], errorCode: 'not-open' });
    return {
      outcome: createRefused('not-open', 'no state is loaded to create into', requestId),
      clearDraft: false,
      closeEditor: false,
    };
  }

  // The board's own drawing, handed to the operation as `settle` so it happens in the order this family's
  // audit test pins - cleared or set, then drawn, then journalled - rather than after the run is recorded.
  deps.setRefusal(null);
  const outcome = await runTaskCreate(
    {
      ...deps,
      isKnownProject: (projectId) => deps.state?.projects.some((candidate) => candidate.id === projectId) === true,
      settle: (settled, refusedBeforeStorage) => {
        if (refusedBeforeStorage) return;
        // The surface shows the sentence, not the code: this form used to hand the refusal sink the reason the
        // composition gave when it had no write path, and that string is the one the outcome carries as its
        // detail - so drawing the detail keeps the board saying exactly what it said before the split.
        if (!settled.ok) deps.setRefusal(settled.detail);
        deps.render();
      },
    },
    input.draft,
  );

  return {
    outcome,
    clearDraft: outcome.ok,
    closeEditor: outcome.ok,
  };
}
