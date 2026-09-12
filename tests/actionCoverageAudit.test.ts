/**
 * Stage 17's action coverage for tasks, as a table rather than as prose.
 *
 * The stage asks the same thirteen questions of every action — typed request, validation, typed
 * success, stale/conflict, refusal, storage failure, request id, entity ids, observable revision,
 * audit record, and three kinds of test. Answering them in a document would be a claim; this answers
 * the two that can be checked mechanically and says which rows cannot:
 *
 * - **the operation exists**, in a named module, and the record layer's contract carries what it needs
 *   (a typed mutation kind, a refusal vocabulary, a revision);
 * - **a UI caller reaches it**, in the shell, by a named call — so the row is not an agent-only verb
 *   wearing a UI box's name;
 * - **a test names it**, which is what makes "agent invocation test exists" and "UI invocation test
 *   exists" checkable rather than remembered;
 * - and for a row that is deliberately **operation-only**, the table asserts the *absence* of a caller,
 *   so a gap cannot quietly become a claim. Task recurrence is the one such row: the record layer
 *   accepts a recurrence series for a task, and no surface offers it yet.
 *
 * The equivalence column is checked against `tests/uiAgentMutationParity.test.ts` rather than trusted:
 * a row that claims an equivalence case must be named by that file.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** Every module in the app layer, so an absence assertion cannot be dodged by a new file name. */
const APP_FILES = readdirSync(resolve(process.cwd(), 'src/app')).filter((name) => name.endsWith('.ts')).sort();

const MAIN = source('src/browser/main.ts');
const TASK_MUTATIONS = source('src/app/taskMutations.ts');
const PARITY = source('tests/uiAgentMutationParity.test.ts');

interface TaskActionRow {
  readonly action: string;
  /** The module that owns the write, and something in it that must exist. */
  readonly module: string;
  readonly marker: string;
  /** How the shell reaches it. Empty for a row that is deliberately operation-only. */
  readonly caller?: string;
  /** Where that call is, when it is not the shell: a planner is reached by the module that plans with it. */
  readonly callerFile?: string;
  /**
   * The call in the shell that reaches the caller above.
   *
   * A row whose write is owned by a module that is itself reached from the shell needs both halves
   * asserted: the sequence must call the operation, and the shell must call the sequence. Otherwise a
   * row could pass by having a caller nobody reaches.
   */
  readonly shellCaller?: string;
  /** A test file that must name the module's operation. */
  readonly testFile: string;
  readonly testMarker: string;
  /** Whether the UI/agent equivalence case names this action. */
  readonly equivalence: boolean;
  /** Where that case lives, when it is not the file the parity audit uses by default. */
  readonly equivalenceFile?: string;
}

const TASK_ROWS: readonly TaskActionRow[] = [
  { action: 'task.create', module: 'src/app/taskCreate.ts', marker: 'export async function createTaskAction', caller: 'createTaskFromFormAction(', testFile: 'tests/taskCreate.test.ts', testMarker: 'createTaskAction', equivalence: true },
  { action: 'task.update (ordinary fields)', module: 'src/app/taskEditorWrite.ts', marker: 'export async function saveTaskAction', caller: 'saveTaskFromEditorAction(', testFile: 'tests/taskEditorWrite.test.ts', testMarker: 'saveTaskAction', equivalence: true },
  { action: 'task.delete', module: 'src/app/taskEditorWrite.ts', marker: 'export async function deleteTaskAction', caller: 'deleteTaskFromEditorAction(', testFile: 'tests/taskEditorWrite.test.ts', testMarker: 'deleteTaskAction', equivalence: true },
  { action: 'task dates set/clear', module: 'src/app/taskEditorWrite.ts', marker: "kind: 'dates'", caller: 'saveTaskFromEditorAction(', testFile: 'tests/taskEditorWrite.test.ts', testMarker: 'dates', equivalence: false },
  // The editor plans the duration mutations and the record layer's own suite is what exercises the
  // max-duration kind; the shell half is the same Save the weight edit goes through.
  { action: 'task weight/duration edits', module: 'src/app/taskEditorWrite.ts', marker: "kind: 'max-duration'", caller: 'saveTaskFromEditorAction(', testFile: 'tests/taskMutations.test.ts', testMarker: 'max-duration', equivalence: false },
  // The Elastic drop's UI/agent equivalence is asserted where the drop itself is: two identical worlds,
  // one dragged and one submitted directly, compared field by field.
  { action: 'task.execution.move', module: 'src/app/taskMoveGesture.ts', marker: 'export async function moveTaskByGesture', caller: 'moveTaskFromDrop(', testFile: 'tests/taskMoveGesture.test.ts', testMarker: 'moveTaskByGesture', equivalence: true, equivalenceFile: 'tests/elasticChangeConvergence.test.ts' },
  // An in-column reorder is the same operation with a different target index, so it is compared by the
  // same equivalence case.
  { action: 'task.execution.reorder', module: 'src/app/taskMoveGesture.ts', marker: 'execution-order', caller: 'moveTaskFromDrop(', testFile: 'tests/taskMoveGesture.test.ts', testMarker: 'execution-order', equivalence: true },
  { action: 'task workflow-stage move', module: 'src/app/workflowBoardDrop.ts', marker: 'export async function performWorkflowDrop', caller: 'moveTaskFromWorkflowDrop(', testFile: 'tests/projectWorkflowBoard.test.ts', testMarker: 'performWorkflowDrop', equivalence: false },
  // The reorder is the same drop with a stage the card is already in, and the module that plans it is
  // the gesture's: the board delegates the write and the gesture owns the position rule.
  { action: 'task workflow reorder', module: 'src/app/workflowMoveGesture.ts', marker: 'workflow-order', caller: 'moveTaskFromWorkflowDrop(', testFile: 'tests/workflowMoveGesture.test.ts', testMarker: 'workflow-order', equivalence: false },
  { action: 'task Gantt date move', module: 'src/app/timelineChangeAction.ts', marker: "export type TimelineChangeOperation = 'move' | 'resize-start' | 'resize-end'", caller: 'changeTaskDatesFromGantt(', testFile: 'tests/ganttWriteWiring.test.ts', testMarker: 'changeTaskDatesAction', equivalence: false },
  { action: 'task Gantt start resize', module: 'src/app/timelineChangeAction.ts', marker: "'resize-start'", caller: 'changeTaskDatesFromGantt(', testFile: 'tests/timelineChangeAction.test.ts', testMarker: 'resize-start', equivalence: false },
  { action: 'task Gantt end resize', module: 'src/app/timelineChangeAction.ts', marker: "'resize-end'", caller: 'changeTaskDatesFromGantt(', testFile: 'tests/timelineChangeAction.test.ts', testMarker: 'resize-end', equivalence: false },
  { action: 'task property set/clear', module: 'src/app/propertyMutationPlan.ts', marker: 'export function planPropertyMutation', caller: 'planPropertyMutation(', callerFile: 'src/app/taskEditorWrite.ts', testFile: 'tests/propertyMutationPlan.test.ts', testMarker: 'planPropertyMutation', equivalence: false },
  { action: 'task relation edit', module: 'src/app/propertyMutationPlan.ts', marker: 'relation becomes a list of', caller: 'planPropertyMutation(', callerFile: 'src/app/taskEditorWrite.ts', testFile: 'tests/propertyMutationPlan.test.ts', testMarker: 'relation', equivalence: false },
  // The bulk run's UI/agent equivalence is asserted where the selection is: the ids the Backlog itself
  // would submit, compared with the same list submitted directly.
  { action: 'task.bulk.complete', module: 'src/app/bulkTaskActions.ts', marker: 'export async function bulkCompleteTasks', caller: 'runBacklogBulk(', testFile: 'tests/backlogBulkActions.test.ts', testMarker: 'bulkCompleteTasks', equivalence: true, equivalenceFile: 'tests/backlogBulkActions.test.ts' },
  { action: 'task.bulk.delete', module: 'src/app/bulkTaskActions.ts', marker: 'export async function bulkDeleteTasks', caller: 'runBacklogBulk(', testFile: 'tests/stageTenAcceptance.test.ts', testMarker: 'bulkDeleteTasks', equivalence: false },
];

/**
 * Stage 17's event rows, in the same shape as the task ones.
 *
 * The two halves of an event's life are here: the record's own fields (create, edit, delete, and the
 * two date verbs a gesture or an agent sentence compiles to) and the series (an occurrence-scoped
 * change, a series-scoped change, and the rule itself). The last of those is the same kind of row as
 * task recurrence: the record layer takes a rule, and no surface offers one yet, so the table declares
 * it operation-only and the audit asserts the missing caller rather than assuming it.
 */
const EVENT_ROWS: readonly TaskActionRow[] = [
  { action: 'event.create', module: 'src/app/eventWriteActions.ts', marker: 'export async function createEventAction', caller: 'createEventFromSeed(', testFile: 'tests/scheduleWriteWiring.test.ts', testMarker: 'createEventAction', equivalence: false },
  { action: 'event.update', module: 'src/app/eventWriteActions.ts', marker: 'export async function saveEventAction', caller: 'saveEventFromEditor(', testFile: 'tests/scheduleWriteWiring.test.ts', testMarker: 'saveEventAction', equivalence: false },
  { action: 'event.delete', module: 'src/app/eventWriteActions.ts', marker: 'export async function deleteEventAction', caller: 'deleteEventFromEditor(', testFile: 'tests/scheduleWriteWiring.test.ts', testMarker: 'deleteEventAction', equivalence: false },
  { action: 'event.reschedule', module: 'src/app/eventWriteActions.ts', marker: 'export async function rescheduleEventAction', caller: 'changeEventFromGesture(', testFile: 'tests/scheduleWriteWiring.test.ts', testMarker: 'rescheduleEventAction', equivalence: false },
  { action: 'event.resize', module: 'src/app/eventWriteActions.ts', marker: 'export async function resizeEventAction', caller: 'changeEventFromGesture(', testFile: 'tests/scheduleWriteWiring.test.ts', testMarker: 'resizeEventAction', equivalence: false },
  { action: 'event occurrence change', module: 'src/app/eventRecurrenceActions.ts', marker: 'export async function updateOccurrenceAction', caller: 'updateOccurrenceFromScope(', testFile: 'tests/recurrenceScopeWiring.test.ts', testMarker: 'updateOccurrenceAction', equivalence: false },
  // A series-scoped change is the same operation with the other scope, and it is the request's scope that
  // the case names: the module declares the scope type, and the comment above the branch says which write
  // each one means.
  { action: 'event series change', module: 'src/app/eventRecurrenceActions.ts', marker: 'scope: OccurrenceScope', caller: 'updateOccurrenceFromScope(', testFile: 'tests/eventRecurrence.test.ts', testMarker: 'series', equivalence: false },
];

/** The event rule itself: accepted by the record layer, not offered by a surface yet. */
const EVENT_OPERATION_ONLY_ROWS = [
  { action: 'event.recurrence.set/clear (retained)', module: 'src/app/eventRecurrenceActions.ts', marker: 'export async function setRecurrenceAction', absentCaller: 'setRecurrenceAction(' },
] as const;

/**
 * Stage 17's project rows.
 *
 * Five of the eleven rows in this group are wired: a project is created, edited, archived, restored
 * and deleted through one operation each, and the Projects Hub reaches all five. Delete is the one to
 * read carefully — the operation exists and answers, and what it answers is `policy-not-decided` with
 * the counts it would affect, because what deleting a project *means* for its members is the creator's
 * decision (D56). This table therefore says "wired" about a verb that refuses, and says why.
 *
 * The other rows are the workflow-stage ones, which are wired now and carry their own table below,
 * and the three property-schema rows, which are not: a record kind existing — and schema records do,
 * canonically — is not an operation, and the gap table below is what keeps that distinction checkable.
 */
const PROJECT_ROWS: readonly TaskActionRow[] = [
  { action: 'project.create', module: 'src/app/projectLifecycleActions.ts', marker: 'export async function createProjectAction', caller: 'createProjectAction(', testFile: 'tests/projectLifecycleActions.test.ts', testMarker: 'createProjectAction', equivalence: false },
  { action: 'project.update', module: 'src/app/projectLifecycleActions.ts', marker: 'export async function updateProjectAction', caller: 'updateProjectAction(', testFile: 'tests/projectLifecycleWiring.test.ts', testMarker: 'updateProjectAction', equivalence: false },
  { action: 'project.archive', module: 'src/app/projectLifecycleActions.ts', marker: 'export async function archiveProjectAction', caller: 'archiveProjectAction(', testFile: 'tests/projectLifecycleWiring.test.ts', testMarker: 'archiveProjectAction', equivalence: false },
  { action: 'project.restore', module: 'src/app/projectLifecycleActions.ts', marker: 'export async function restoreProjectAction', caller: 'restoreProjectAction(', testFile: 'tests/projectLifecycleWiring.test.ts', testMarker: 'restoreProjectAction', equivalence: false },
  // Wired, and refused on purpose: the sequence runs and the operation answers `policy-not-decided`.
  { action: 'project.delete', module: 'src/app/projectLifecycleActions.ts', marker: 'export async function deleteProjectAction', caller: 'deleteProjectAction(', testFile: 'tests/projectMutations.test.ts', testMarker: 'policy-not-decided', equivalence: false },
];

/**
 * The workflow-stage rows, which are no longer gaps.
 *
 * The board's New stage, Rename and Delete are real controls, the sequences that carry them live in
 * `workflowStageWriteActions.ts`, and the operations they call live in `workflowStageMutations.ts`.
 * The row names the operation module and marker, the sequence that reaches it, and the call in the
 * shell that reaches the sequence, so all three links are asserted rather than assumed.
 */
const WORKFLOW_STAGE_ROWS: readonly TaskActionRow[] = [
  { action: 'workflow stage create', module: 'src/app/workflowStageMutations.ts', marker: 'export async function createWorkflowStage', callerFile: 'src/app/workflowStageWriteActions.ts', caller: 'export async function createWorkflowStageAction', shellCaller: 'createWorkflowStageAction(', testFile: 'tests/workflowStageBoard.test.ts', testMarker: 'createWorkflowStageAction', equivalence: false },
  { action: 'workflow stage rename', module: 'src/app/workflowStageMutations.ts', marker: 'export async function renameWorkflowStage', callerFile: 'src/app/workflowStageWriteActions.ts', caller: 'export async function renameWorkflowStageAction', shellCaller: 'renameWorkflowStageAction(', testFile: 'tests/workflowStageBoard.test.ts', testMarker: 'renameWorkflowStageAction', equivalence: false },
  { action: 'workflow stage delete/remap', module: 'src/app/workflowStageMutations.ts', marker: 'export async function deleteWorkflowStage', callerFile: 'src/app/workflowStageWriteActions.ts', caller: 'export async function deleteWorkflowStageAction', shellCaller: 'deleteWorkflowStageAction(', testFile: 'tests/workflowStageBoard.test.ts', testMarker: 'deleteWorkflowStageAction', equivalence: false },
];

/**
 * The schema rows, which now have operations and no surface.
 *
 * The record layer writes a schema: create, update, delete, one option at a time, and a field edit
 * that may not change what kind of value the property holds. Nothing in the shell reaches them yet —
 * there is no schema editor — so these rows are declared **operation-only** and the test below asserts
 * the absence of a caller, exactly as the task-recurrence row does. That is the honest state: the verb
 * exists, its refusals are real, and a reader who wants to manage schemas in the app is told what is
 * missing rather than shown a control that is not there.
 */
const SCHEMA_ROWS: readonly TaskActionRow[] = [
  { action: 'property schema create/update/delete', module: 'src/app/propertySchemaMutations.ts', marker: 'export async function updatePropertySchema', testFile: 'tests/propertySchemaMutations.test.ts', testMarker: 'updatePropertySchema', equivalence: false },
  { action: 'schema options', module: 'src/app/propertySchemaMutations.ts', marker: 'export async function updateSchemaOption', testFile: 'tests/propertySchemaMutations.test.ts', testMarker: 'updateSchemaOption', equivalence: false },
  { action: 'formula/rollup/relation schema edits', module: 'src/app/propertySchemaMutations.ts', marker: 'export async function updateSchemaField', testFile: 'tests/propertySchemaMutations.test.ts', testMarker: 'updateSchemaField', equivalence: false },
];

/** Every operation the app layer must carry for this group's rows to be covered rather than gaps. */
const WRITTEN_SCHEMA_EXPORTS = [
  'export async function createPropertySchema',
  'export async function updatePropertySchema',
  'export async function deletePropertySchema',
  'export async function updateSchemaOption',
  'export async function updateSchemaField',
] as const;

/**
 * Rows whose operation does not exist yet, asserted as absent.
 *
 * **This table is empty as of `9e27cad`**: every row in the project/workflow/schema group has an
 * operation. It stays here, with the complement assertion below, because "nothing is missing" is a
 * claim that has to be checkable too — the day a row is added back, the scan is what finds it.
 */
const UNWRITTEN_PROJECT_ROWS = [] as readonly { readonly action: string; readonly absentExport: string }[];

/** The one task action the record layer accepts and no surface offers yet. */
const OPERATION_ONLY_ROWS = [
  { action: 'task recurrence (retained)', module: 'src/app/taskMutations.ts', marker: "kind: 'recurrence'" },
] as const;

/**
 * The Templates row, split in two because the two questions it answers are evidenced in two files.
 *
 * `template.execute` is deliberately not a `ProximaAction`: the AUTHOR ruled on 2026-09-12 that it is a
 * sibling entry, so its shell caller is the named function the click chain reaches rather than a
 * `data-action` verb - and the row names that function, which is what keeps the claim checkable.
 *
 * The first row is the UI-invocation half. It named `createTemplateTasksAction` and a source-shape test until
 * the AUTHOR rejected that as the box's evidence - reading `main.ts` as text cannot prove a listener runs -
 * so the binding was extracted into `src/browser/templateExecuteBinding.ts` and the row now names the module
 * a test can import, the shell call that composes it, and the click test that drives it.
 */
const TEMPLATE_ROWS: readonly TaskActionRow[] = [
  { action: 'template.execute (UI invocation)', module: 'src/browser/templateExecuteBinding.ts', marker: 'export function bindTemplateExecuteInteractions', caller: 'bindTemplateExecute(root)', testFile: 'tests/templateExecuteClick.test.ts', testMarker: "'template-execute'", equivalence: false },
  { action: 'template.execute (equivalence)', module: 'src/app/templateSubmission.ts', marker: 'export async function submitTemplateExecution', caller: 'bindTemplateExecute(', testFile: 'tests/templateCallerEquivalence.test.ts', testMarker: 'submitTemplateExecution', equivalence: true, equivalenceFile: 'tests/templateCallerEquivalence.test.ts' },
];

describe('Stage 17 task action coverage', () => {
  it('names a module, a caller and a test for every task action the UI reaches', () => {
    for (const row of TASK_ROWS) {
      const text = source(row.module);
      expect(text, `${row.action}: ${row.module} must carry ${row.marker}`).toContain(row.marker);
      const callerText = row.callerFile === undefined ? MAIN : source(row.callerFile);
      expect(callerText, `${row.action}: ${row.module} must be reached by the shell`).toContain(row.caller!);
      const test = source(row.testFile);
      expect(test, `${row.action}: ${row.testFile} must exercise it`).toContain(row.testMarker);
      // The equivalence column is checked rather than trusted: a row that claims a UI/agent
      // comparison must be one of the actions that file actually compares.
      // Either the parity audit names this action, or the row says where its equivalence case lives.
      const compared = PARITY.includes(row.testMarker)
        || (row.equivalenceFile !== undefined && source(row.equivalenceFile).includes(row.testMarker));
      expect(compared, `${row.action}: equivalence claimed but not asserted`).toBe(row.equivalence);
    }
  });

  it('leaves no task action silently agent-only, and says which one is', () => {
    for (const row of OPERATION_ONLY_ROWS) {
      // The record layer accepts it…
      expect(source(row.module)).toContain(row.marker);
      // …and no surface reaches it, which is the gap rather than an oversight: the row is ticked only
      // when a caller exists, and this assertion is what keeps that honest.
      expect(MAIN).not.toContain('recurrenceSeriesFor(');
      expect(MAIN).not.toContain("kind: 'recurrence'");
    }
  });

  it('carries the record layer contract every row leans on', () => {
    // A typed request with a closed mutation union, the refusal vocabulary, and a revision to lose.
    for (const kind of ["kind: 'name'", "kind: 'project'", "kind: 'execution-state'", "kind: 'weight'", "kind: 'dates'", "kind: 'fixed-duration'", "kind: 'max-duration'", "kind: 'completion'", "kind: 'execution-order'", "kind: 'workflow-stage'", "kind: 'workflow-order'", "kind: 'property'", "kind: 'recurrence'"]) {
      expect(TASK_MUTATIONS, `the mutation union must carry ${kind}`).toContain(kind);
    }
    for (const reason of ["'validation-refused'", "'not-found'", "'stale-revision'", "'semantic-conflict'", "'recovery-required'", "'storage-failure'"]) {
      expect(TASK_MUTATIONS, `the refusal vocabulary must carry ${reason}`).toContain(reason);
    }
    expect(TASK_MUTATIONS).toContain('expectedRevision: input.expectedRevision');
    expect(TASK_MUTATIONS).toContain('actualRevision');
  });
});

type ContractStatus = 'satisfied' | 'gap' | 'n/a';

interface ContractCell {
  readonly column: string;
  readonly status: ContractStatus;
  /** Where the status is read from. */
  readonly file: string;
  /** Optional anchor: the marker is looked for from here on, so a request field is not confused with a result. */
  readonly from?: string;
  /** What must be there - or, for a gap, must not be. */
  readonly marker: string;
  /** A gap asserts the marker's absence, so the day the gap closes this table fails and the cell is revisited. */
  readonly absent?: boolean;
  /**
   * For a gap: something that must be present in the same text.
   *
   * An absence assertion is green when its marker is misspelled as easily as when the gap is real, so every
   * gap names a witness - the code it is a gap *in* - and the audit fails if that witness disappears.
   */
  readonly witness?: string;
  /** Why, in one sentence a reader can check. */
  readonly reason: string;
}

/**
 * Stage 17's ten columns for the Templates row, as an inventory.
 *
 * The AUTHOR fixed what each column means on 2026-09-12 and ruled the order of work: build the matrix first,
 * record every cell as satisfied, gap or not-applicable with its reason, and **do not fix anything while
 * building it** - the matrix exists to expose the common gaps, and a gap is asserted as an absence so it
 * cannot quietly become a claim later. The four gaps this row records are the ones the AUTHOR named, and the
 * two that repeat across rows (a semantic request id, a bounded semantic event) become one cross-cutting
 * slice once the matrix shows its whole coverage.
 */
const TEMPLATE_CONTRACT_CELLS: readonly ContractCell[] = [
  { column: 'typed request exists', status: 'satisfied', file: 'src/app/templateExecuteAction.ts', marker: 'export interface TemplateExecuteRequest', reason: 'the request is a closed exported type naming the template text and an optional project' },
  { column: 'runtime validation exists', status: 'gap', file: 'src/app/templateSubmission.ts', marker: 'parseOpaqueRecordId', absent: true, witness: "typeof candidate.projectId !== 'string'", reason: "the agent boundary validates the outer shape, but a projectId is only checked as a string and then cast to OpaqueRecordId - canonical-ID validation is missing, which is the AUTHOR's own reading of this row" },
  { column: 'typed success exists', status: 'satisfied', file: 'src/app/templateExecuteAction.ts', marker: "outcome: 'created'", reason: 'the success branch is discriminated and names the semantic effect and the ids' },
  { column: 'typed stale/conflict where applicable', status: 'gap', file: 'src/app/templateExecuteAction.ts', marker: "'semantic-conflict'", absent: true, witness: "'creation-refused'", reason: 'stale is not applicable to a create-only run (the action reads the lost-race cause only to decide whether to re-read), but a semantic conflict from the port arrives as creation-refused with the port sentence, so nothing in the result distinguishes it' },
  { column: 'typed validation refusal exists', status: 'satisfied', file: 'src/app/templateExecuteAction.ts', marker: "'untranslatable-draft-field'", reason: 'invalid semantic input comes back as a machine-readable reason with a bounded sentence, not as prose or an exception' },
  { column: 'typed storage/recovery failure exists', status: 'gap', file: 'src/app/templateExecuteAction.ts', marker: "'storage-failure'", absent: true, witness: "'creation-refused'", reason: 'a storage failure is collapsed into creation-refused; recovery is not applicable on this path because a create goes through createIfAbsent and never uses the recovery coordinator' },
  { column: 'request ID exists', status: 'gap', file: 'src/app/templateExecuteAction.ts', from: 'export type TemplateExecuteOutcome', marker: 'requestId', absent: true, witness: 'readonly created', reason: 'the request type accepts a caller-supplied requestId that nothing reads, and neither outcome branch carries a system-generated correlation id' },
  { column: 'affected entity IDs returned', status: 'satisfied', file: 'src/app/templateExecuteAction.ts', marker: 'readonly created: readonly OpaqueRecordId[]', reason: 'both branches carry the ids: empty for a refusal decided before the first call, and the ids that landed for a partial run' },
  { column: 'state/revision observable afterward', status: 'satisfied', file: 'tests/templateExecuteClick.test.ts', marker: 'afterRuns', reason: 'behavioural rather than structural: the click test asserts the convergence step ran after a real run, and the caller-equivalence test decodes the stored records of both worlds afterwards' },
  { column: 'event/audit record exists', status: 'gap', file: 'src/app/templateExecuteAction.ts', marker: 'eventRing', absent: true, witness: 'executeTemplatePlan', reason: 'nothing on this path emits a semantic event; the coordinator keeps a recovery journal, and its own contract says a recovery record is never exposed as an audit event' },
];

describe('Stage 17 template action coverage', () => {
  it('names the module, the shell caller and the tests for the template entry, in both halves', () => {
    for (const row of TEMPLATE_ROWS) {
      expect(source(row.module), `${row.action}: ${row.module} must carry ${row.marker}`).toContain(row.marker);
      expect(MAIN, `${row.action}: the shell must reach it`).toContain(row.caller!);
      expect(source(row.testFile), `${row.action}: ${row.testFile} must exercise it`).toContain(row.testMarker);
      const compared = PARITY.includes(row.testMarker)
        || (row.equivalenceFile !== undefined && source(row.equivalenceFile).includes(row.testMarker));
      expect(compared, `${row.action}: equivalence claimed but not asserted`).toBe(row.equivalence);
    }
  });

  it('records the ten columns for the Templates row, gaps included', () => {
    expect(TEMPLATE_CONTRACT_CELLS.map((cell) => cell.column)).toEqual([
      'typed request exists',
      'runtime validation exists',
      'typed success exists',
      'typed stale/conflict where applicable',
      'typed validation refusal exists',
      'typed storage/recovery failure exists',
      'request ID exists',
      'affected entity IDs returned',
      'state/revision observable afterward',
      'event/audit record exists',
    ]);

    for (const cell of TEMPLATE_CONTRACT_CELLS) {
      const text = source(cell.file);
      let scoped = text;
      if (cell.from !== undefined) {
        // The anchor is asserted before it scopes anything: indexOf returning -1 slices the last character,
        // which would leave a check that cannot fail on a file that never carried the anchor at all.
        expect(text, `${cell.column}: ${cell.file} must contain the anchor ${cell.from}`).toContain(cell.from);
        scoped = text.slice(text.indexOf(cell.from));
      }
      if (cell.witness !== undefined) {
        expect(scoped, `${cell.column}: ${cell.file} must carry the witness ${cell.witness}`).toContain(cell.witness);
      }
      // A satisfied cell or a not-applicable note must carry its marker; a gap must not. That is what makes
      // a gap fail the day it closes, instead of staying a gap nobody revisits.
      expect(scoped.includes(cell.marker), `${cell.column} (${cell.status}): ${cell.reason}`)
        .toBe(cell.absent !== true);
    }
  });

  it('keeps the entry out of the action union it was ruled not to join', () => {
    // The row above asserts the wiring; this asserts the decision behind its shape, so a later refactor
    // cannot quietly promote a sibling entry into the `ProximaAction` vocabulary and inherit a set of
    // guarantees (a verb a surface dispatches, a request the agent protocol validates) that were never
    // designed for a run of variable length. The sibling is reached by binding a module, not by naming a
    // verb in the dispatcher's union, and the agent's wire type lives in the submission entry alone.
    expect(MAIN).toContain('bindTemplateExecute(root)');
    expect(MAIN).not.toContain("kind: 'template.execute'");
    expect(MAIN).not.toContain("type: 'template.execute'");
    expect(source('src/app/templateSubmission.ts')).toContain("type: 'template.execute'");
  });
});

describe('Stage 17 event action coverage', () => {
  it('names a module, a caller and a test for every event action the UI reaches', () => {
    for (const row of EVENT_ROWS) {
      expect(source(row.module), `${row.action}: ${row.module} must carry ${row.marker}`).toContain(row.marker);
      const callerText = row.callerFile === undefined ? MAIN : source(row.callerFile);
      expect(callerText, `${row.action}: the shell must reach it`).toContain(row.caller!);
      expect(source(row.testFile), `${row.action}: ${row.testFile} must exercise it`).toContain(row.testMarker);
      const compared = PARITY.includes(row.testMarker)
        || (row.equivalenceFile !== undefined && source(row.equivalenceFile).includes(row.testMarker));
      expect(compared, `${row.action}: equivalence claimed but not asserted`).toBe(row.equivalence);
    }
  });

  it('leaves no event action silently agent-only, and says which one is', () => {
    for (const row of EVENT_OPERATION_ONLY_ROWS) {
      expect(source(row.module)).toContain(row.marker);
      // The rule can be written and no surface offers it: that is the gap this row records, and the
      // assertion is what keeps it from being claimed as wired.
      expect(MAIN).not.toContain(row.absentCaller);
    }
  });

  it('carries the record layer contract the event rows lean on', () => {
    const mutations = source('src/app/eventMutations.ts');
    for (const kind of ["kind: 'name'", "kind: 'span'", "kind: 'recurrence'", "kind: 'property'", "kind: 'completion'"]) {
      expect(mutations, `the event mutation union must carry ${kind}`).toContain(kind);
    }
    for (const reason of ["'validation-refused'", "'not-found'", "'stale-revision'", "'semantic-conflict'", "'recovery-required'", "'storage-failure'"]) {
      expect(mutations, `the event refusal vocabulary must carry ${reason}`).toContain(reason);
    }
    expect(mutations).toContain('expectedRevision: input.expectedRevision');
    expect(mutations).toContain('actualRevision');
  });
});

describe('Stage 17 project, workflow and schema coverage', () => {
  it('names a module, a caller and a test for every project action the Hub reaches', () => {
    for (const row of PROJECT_ROWS) {
      expect(source(row.module), `${row.action}: ${row.module} must carry ${row.marker}`).toContain(row.marker);
      expect(MAIN, `${row.action}: the shell must reach it`).toContain(row.caller!);
      expect(source(row.testFile), `${row.action}: ${row.testFile} must exercise it`).toContain(row.testMarker);
    }
  });

  it('names the operation, the sequence and the shell call for every workflow-stage action', () => {
    for (const row of WORKFLOW_STAGE_ROWS) {
      expect(source(row.module), `${row.action}: ${row.module} must carry ${row.marker}`).toContain(row.marker);
      // The sequence that carries it…
      expect(source(row.callerFile!), `${row.action}: ${row.callerFile} must reach it`).toContain(row.caller!);
      // …and the shell call that reaches the sequence.
      expect(MAIN, `${row.action}: the shell must reach the sequence`).toContain(row.shellCaller!);
      expect(source(row.testFile), `${row.action}: ${row.testFile} must exercise it`).toContain(row.testMarker);
      const compared = PARITY.includes(row.testMarker)
        || (row.equivalenceFile !== undefined && source(row.equivalenceFile).includes(row.testMarker));
      expect(compared, `${row.action}: equivalence claimed but not asserted`).toBe(row.equivalence);
    }
  });

  it('proves the rows that have no operation rather than remembering them, and the ones that do', () => {
    // A canonical record kind is not an operation, and an operation is not a surface: both halves of
    // that sentence are asserted here rather than remembered.
    //
    // The scan is the whole app layer rather than a hand-listed set of files: the stage rows were once
    // proved absent by a list that did not include the module they were about to appear in, which is
    // exactly how an audit stops auditing.
    const appText = APP_FILES.map((file) => source(`src/app/${file}`)).join('\n');
    for (const row of UNWRITTEN_PROJECT_ROWS) {
      expect(appText, `${row.action}: an operation appeared, so the row must be revisited`).not.toContain(row.absentExport);
    }
    // The complement, and the reason this test still means something with an empty table: every
    // operation this group's rows claim must be findable in that same scan.
    for (const marker of WRITTEN_SCHEMA_EXPORTS) {
      expect(appText, `${marker} must be in the app layer`).toContain(marker);
    }
  });

  it('declares the schema rows operation-only, and asserts that no surface reaches them', () => {
    for (const row of SCHEMA_ROWS) {
      expect(source(row.module), `${row.action}: ${row.module} must carry ${row.marker}`).toContain(row.marker);
      expect(source(row.testFile), `${row.action}: ${row.testFile} must exercise it`).toContain(row.testMarker);
      // The operation exists and the shell does not reach it. That is the gap this row records, and
      // the assertion is what keeps it from being claimed as wired.
      expect(MAIN, `${row.action}: a caller appeared, so the row is no longer operation-only`).not.toContain(row.testMarker);
      expect(PARITY, `${row.action}: equivalence cannot be claimed without a UI caller`).not.toContain(row.testMarker);
    }
  });

  it('carries the record layer contract the schema rows lean on', () => {
    const mutations = source('src/app/propertySchemaMutations.ts');
    for (const reason of ["'validation-refused'", "'not-found'", "'stale-revision'", "'semantic-conflict'", "'recovery-required'", "'storage-failure'"]) {
      expect(mutations, `the schema refusal vocabulary must carry ${reason}`).toContain(reason);
    }
    expect(mutations).toContain('createIfAbsent(built.record)');
    expect(mutations).toContain('expectedRevision: input.expectedRevision');
    expect(mutations).toContain('actualRevision');
    // A write that would orphan stored values refuses with the count, which is what makes the refusal
    // an answer rather than a wall.
    expect(mutations).toContain('affectedRecordCount');
    expect(mutations).toContain('defineCanonicalPropertySchema');
  });

  it('carries the record layer contract the workflow-stage rows lean on', () => {
    const mutations = source('src/app/workflowStageMutations.ts');
    for (const reason of ["'validation-refused'", "'not-found'", "'stale-revision'", "'semantic-conflict'", "'recovery-required'", "'storage-failure'"]) {
      expect(mutations, `the stage refusal vocabulary must carry ${reason}`).toContain(reason);
    }
    // A create goes through the store's own idempotent boundary; an update or a delete is conditional
    // and carries the revision the caller read, which is what makes a lost race reportable.
    expect(mutations).toContain('createIfAbsent(record)');
    expect(mutations).toContain('expectedRevision: input.expectedRevision');
    expect(mutations).toContain('actualRevision');
    // The delete moves its cards through the task operation rather than a second rule of its own.
    expect(mutations).toContain('updateTask(deps.taskDependencies');
  });

  it('states what project delete answers, since the box is about a refusing verb being wired', () => {
    const mutations = source('src/app/projectMutations.ts');
    expect(mutations).toContain("'policy-not-decided'");
    // The refusal names what it would affect, which is what makes it an answer rather than a failure.
    expect(mutations).toContain('would affect');
    expect(source('src/browser/main.ts')).toContain('deleteProjectAction(');
  });
});

/**
 * Stage 17's ten columns for every other row this file carries, as the same kind of inventory.
 *
 * The Templates table above is the model, and the AUTHOR's rules for it are the rules here: one cell
 * per column in the fixed order, each cell naming the file it is read from, the marker that must be
 * there - or, for a gap, must not - a witness for an absence, and one sentence a reader can check.
 * Nothing is fixed while the matrix is built; a gap is recorded as an absence so the day it closes
 * this table fails and the cell is revisited.
 *
 * The two gaps the AUTHOR named as cross-cutting - a semantic request id, and a bounded semantic
 * event - are the same gap in the same module for every row of a family, so each family writes them
 * once and every row in it carries that cell. The cells that are about the row's own verb (its
 * request, its refusal, the ids it returns, the test that reads it back) are written per row, and a
 * family that cannot answer one of them says so with a gap instead.
 *
 * Three findings the matrix records rather than fixes:
 *
 * - every record operation in this tree is reached through a typed request and none of them accepts
 *   `unknown`, so a programmatic caller that bypasses TypeScript is refused field by field inside the
 *   module rather than at a boundary;
 * - the coordinator generates a request id for every update and delete, and every semantic result
 *   here discards it, while creates never reach the coordinator at all;
 * - the action dispatcher refuses every one of these verbs with `action-not-available` before the
 *   record layer, so the only event ring in the tree never sees a record write.
 */

/** The ten columns, in the order the AUTHOR fixed. Every row's cells must match this exactly. */
const COLUMN_REQUEST = 'typed request exists';
const COLUMN_VALIDATION = 'runtime validation exists';
const COLUMN_SUCCESS = 'typed success exists';
const COLUMN_CONFLICT = 'typed stale/conflict where applicable';
const COLUMN_REFUSAL = 'typed validation refusal exists';
const COLUMN_STORAGE = 'typed storage/recovery failure exists';
const COLUMN_REQUEST_ID = 'request ID exists';
const COLUMN_ENTITY_IDS = 'affected entity IDs returned';
const COLUMN_OBSERVABLE = 'state/revision observable afterward';
const COLUMN_AUDIT = 'event/audit record exists';

const CONTRACT_COLUMNS = [
  COLUMN_REQUEST,
  COLUMN_VALIDATION,
  COLUMN_SUCCESS,
  COLUMN_CONFLICT,
  COLUMN_REFUSAL,
  COLUMN_STORAGE,
  COLUMN_REQUEST_ID,
  COLUMN_ENTITY_IDS,
  COLUMN_OBSERVABLE,
  COLUMN_AUDIT,
] as const;

/** One row of the matrix: the action this file already carries, and its ten cells. */
interface ContractRow {
  readonly action: string;
  readonly cells: readonly ContractCell[];
}

/** A cell a row writes for itself: a marker, the sentence behind it, and where it is read from. */
interface RowCell {
  readonly marker: string;
  readonly reason: string;
  /** Where the marker is looked for, when it is not the family's own module. */
  readonly file?: string;
  /** Defaults to satisfied; a column that does not apply says why in its reason instead. */
  readonly status?: 'satisfied' | 'n/a';
}

/** A cell for something that is not there: the marker must stay absent and the witness must not. */
interface GapCell {
  readonly file: string;
  readonly marker: string;
  readonly witness: string;
  readonly reason: string;
}

/** Column nine's satisfied half: the test that reads the state back after this row's write. */
interface ObservableCell {
  readonly file: string;
  readonly marker: string;
  readonly note: string;
}

function carried(column: string, file: string, marker: string, reason: string, from?: string): ContractCell {
  return { column, status: 'satisfied', file, marker, reason, ...(from === undefined ? {} : { from }) };
}

function missing(column: string, file: string, marker: string, witness: string, reason: string): ContractCell {
  return { column, status: 'gap', file, marker, absent: true, witness, reason };
}

function rowCell(column: string, spec: RowCell, fallbackFile: string, from?: string): ContractCell {
  return {
    column,
    status: spec.status ?? 'satisfied',
    file: spec.file ?? fallbackFile,
    marker: spec.marker,
    ...(from === undefined ? {} : { from }),
    reason: spec.reason,
  };
}

function observableCell(action: string, spec: ObservableCell | { readonly gap: GapCell }): ContractCell {
  if ('gap' in spec) {
    return missing(COLUMN_OBSERVABLE, spec.gap.file, spec.gap.marker, spec.gap.witness, spec.gap.reason);
  }
  return carried(COLUMN_OBSERVABLE, spec.file, spec.marker, `${action}: behavioural rather than structural - ${spec.note}`);
}

/**
 * What a family answers the same way for every row in it.
 *
 * The member module is where the write lands and where four of the ten columns are read: the typed
 * boundary, the storage and recovery vocabulary, the request id the result would have to carry, and
 * the event the path would have to emit. A row whose request type lives in another module names that
 * module on its own cell rather than changing the family's.
 */
interface FamilyContract {
  readonly requestFile: string;
  readonly validation: { readonly file: string; readonly witness: string; readonly note: string };
  readonly success: { readonly file: string; readonly from: string; readonly marker: string };
  readonly conflictFile: string;
  readonly storage: {
    readonly file: string;
    readonly create: string;
    readonly write: string;
    readonly createNote: string;
    readonly writeNote: string;
    readonly refusingNote: string;
  };
  readonly requestId: { readonly file: string; readonly witness: string; readonly note: string };
  readonly ids: { readonly file: string; readonly marker: string };
  readonly audit: { readonly file: string; readonly witness: string; readonly note: string };
}

interface ContractRowSpec {
  readonly action: string;
  readonly request: RowCell;
  /** The effect this row's own success names, quoted in the success cell's reason. */
  readonly effect: string;
  /** Column three as a note that does not apply, for an operation with no success branch at all. */
  readonly success?: RowCell;
  readonly shape: 'create' | 'write' | 'refusing';
  /** Column four, when the family's own sentence would not be true for this row. */
  readonly conflictNote?: string;
  readonly refusal: RowCell;
  readonly ids?: RowCell;
  readonly idsGap?: GapCell;
  readonly observable: ObservableCell | { readonly gap: GapCell };
  /** The family this row is read against, when it is not the table's own: a bulk run reports itself. */
  readonly contract?: FamilyContract;
}

function contractRows(contract: FamilyContract, specs: readonly ContractRowSpec[]): readonly ContractRow[] {
  return specs.map((spec) => {
    const family = spec.contract ?? contract;
    return {
    action: spec.action,
    cells: [
      rowCell(COLUMN_REQUEST, spec.request, family.requestFile),
      missing(
        COLUMN_VALIDATION,
        family.validation.file,
        'input: unknown',
        family.validation.witness,
        `${spec.action}: ${family.validation.note}`,
      ),
      spec.success === undefined
        ? carried(
            COLUMN_SUCCESS,
            family.success.file,
            family.success.marker,
            `${spec.action}: the success branch is discriminated and names this row's own effect (${spec.effect}) together with the record id and the revision the store returned`,
            family.success.from,
          )
        : rowCell(COLUMN_SUCCESS, spec.success, family.success.file, family.success.from),
      spec.shape === 'create'
        ? carried(
            COLUMN_CONFLICT,
            family.conflictFile,
            "'semantic-conflict'",
            spec.conflictNote
              ?? `${spec.action}: stale is not applicable to a create, which has no prior revision to lose, and the collision that is possible - a record already holding that id - is carried as semantic-conflict`,
          )
        : carried(
            COLUMN_CONFLICT,
            family.conflictFile,
            "'stale-revision'",
            spec.conflictNote
              ?? `${spec.action}: a caller that lost a race is refused with stale-revision and the revision that beat it (actualRevision), and this row's own semantic conflicts are carried too`,
          ),
      rowCell(COLUMN_REFUSAL, spec.refusal, family.requestFile),
      carried(
        COLUMN_STORAGE,
        family.storage.file,
        spec.shape === 'write' ? family.storage.write : family.storage.create,
        `${spec.action}: ${spec.shape === 'write' ? family.storage.writeNote : spec.shape === 'create' ? family.storage.createNote : family.storage.refusingNote}`,
      ),
      missing(
        COLUMN_REQUEST_ID,
        family.requestId.file,
        'requestId',
        family.requestId.witness,
        `${spec.action}: ${family.requestId.note}`,
      ),
      spec.idsGap !== undefined
        ? missing(COLUMN_ENTITY_IDS, spec.idsGap.file, spec.idsGap.marker, spec.idsGap.witness, spec.idsGap.reason)
        : spec.ids === undefined
          ? carried(
              COLUMN_ENTITY_IDS,
              family.ids.file,
              family.ids.marker,
              `${spec.action}: the result carries the id of the record the write landed on, and a delete carries a null record beside it rather than only a flag`,
            )
          : rowCell(COLUMN_ENTITY_IDS, spec.ids, family.ids.file),
      observableCell(spec.action, spec.observable),
      missing(
        COLUMN_AUDIT,
        family.audit.file,
        'eventRing',
        family.audit.witness,
        `${spec.action}: ${family.audit.note}`,
      ),
    ],
    };
  });
}

/** The task record layer, which every task row in this file writes through. */
const TASK_CONTRACT: FamilyContract = {
  requestFile: 'src/app/taskMutations.ts',
  validation: {
    file: 'src/app/taskMutations.ts',
    witness: 'request: CreateTaskRequest',
    note: 'the operation checks every field before it writes, but its entry takes the typed request object and nothing accepts it as unknown, so a programmatic caller that bypasses TypeScript is refused inside the module rather than at the boundary',
  },
  success: { file: 'src/app/taskMutations.ts', from: 'export interface TaskMutationSuccess', marker: "readonly outcome: 'created' | 'updated' | 'deleted';" },
  conflictFile: 'src/app/taskMutations.ts',
  storage: {
    file: 'src/app/taskMutations.ts',
    create: "'storage-failure'",
    write: "'recovery-required'",
    createNote: 'a store that rejects the write is a storage failure of its own; recovery is not applicable on this path, because a create goes through the store own createIfAbsent and never journals',
    writeNote: 'a storage failure and a store that needs recovery stay distinguishable, which is what a journaled update or delete needs',
    refusingNote: 'the store read that decides the question is a storage failure of its own, and recovery is not applicable because this path never journals',
  },
  requestId: {
    file: 'src/app/taskMutations.ts',
    witness: 'readonly recordId: OpaqueRecordId',
    note: 'the coordinator generates a requestId for every update and delete and this module discards it - outcomeOf reads ok, reason and actualRevision and nothing else - and a create never reaches the coordinator, so no correlation id survives into the result',
  },
  ids: { file: 'src/app/taskMutations.ts', marker: 'readonly recordId: OpaqueRecordId' },
  audit: {
    file: 'src/app/taskMutations.ts',
    witness: 'export type TaskMutationResult',
    note: 'nothing on this path emits a semantic event: the only event ring in the tree belongs to the action dispatcher, which refuses every record verb with action-not-available before the record layer, and a recovery journal record is not an audit event',
  },
};

/** The bulk task report, which is where a selection reports one outcome per member. */
const BULK_TASK_CONTRACT: FamilyContract = {
  ...TASK_CONTRACT,
  requestFile: 'src/app/bulkTaskActions.ts',
  validation: {
    file: 'src/app/bulkTaskActions.ts',
    witness: 'readonly taskIds: readonly string[]',
    note: 'the selection arrives as a typed list of task ids and nothing accepts it as unknown, so a caller that bypasses TypeScript is not refused at this boundary either',
  },
  success: { file: 'src/app/bulkTaskActions.ts', from: 'export interface BulkTaskActionReport', marker: 'readonly status: BulkTaskActionStatus;' },
  requestId: {
    file: 'src/app/bulkTaskActions.ts',
    witness: 'readonly action: BulkTaskActionKind',
    note: 'the report names the action, the counts and each member revision, and carries no request id at all; the coordinator ids the task operations it calls are discarded by those operations before the report is built',
  },
  ids: { file: 'src/app/bulkTaskActions.ts', marker: 'readonly entities: readonly BulkEntityOutcome[];' },
  audit: {
    file: 'src/app/bulkTaskActions.ts',
    witness: 'export interface BulkTaskActionReport',
    note: 'a bulk run emits no semantic event: each member is written through the task operations, which emit none, and the report is a return value rather than a record',
  },
};

/** The event record layer. */
const EVENT_CONTRACT: FamilyContract = {
  requestFile: 'src/app/eventMutations.ts',
  validation: {
    file: 'src/app/eventMutations.ts',
    witness: 'request: CreateEventRequest',
    note: 'the span, the name and the project are checked before the write, but the entry takes the typed request object and nothing accepts it as unknown, so the boundary is TypeScript rather than a parse',
  },
  success: {
    file: 'src/app/eventMutations.ts',
    from: 'export interface EventMutationSuccess',
    marker: "readonly outcome: 'created' | 'updated' | 'deleted' | 'rescheduled' | 'resized';",
  },
  conflictFile: 'src/app/eventMutations.ts',
  storage: {
    file: 'src/app/eventMutations.ts',
    create: "'storage-failure'",
    write: "'recovery-required'",
    createNote: 'a create goes through the store own createIfAbsent and never journals, so recovery is not applicable and a rejected write is a storage failure of its own',
    writeNote: 'a storage failure and a store that needs recovery stay distinguishable on the journaled path, which is what puts a dragged block back where the store says it is',
    refusingNote: 'the store read that decides the question is a storage failure of its own, and this path never journals',
  },
  requestId: {
    file: 'src/app/eventMutations.ts',
    witness: 'readonly recordId: OpaqueRecordId',
    note: 'outcomeOf keeps ok, reason and actualRevision from the coordinator and drops the requestId it returns, and a create never reaches the coordinator, so no correlation id survives',
  },
  ids: { file: 'src/app/eventMutations.ts', marker: 'readonly recordId: OpaqueRecordId' },
  audit: {
    file: 'src/app/eventMutations.ts',
    witness: 'export type EventMutationResult',
    note: 'no semantic event is emitted: the dispatcher refuses every schedule verb with action-not-available before this layer, so the only ring in the tree never sees an event write',
  },
};

/** The recurrence write sequences, which own the scope and rule verbs. */
const RECURRENCE_CONTRACT: FamilyContract = {
  requestFile: 'src/app/eventRecurrenceActions.ts',
  validation: {
    file: 'src/app/eventRecurrenceActions.ts',
    witness: 'readonly eventId: string',
    note: 'the scope, the instant and the change arrive as typed fields and nothing accepts the request as unknown; the plan own refusals are machine-readable, but they are reached only after TypeScript has already accepted the shape',
  },
  success: { file: 'src/app/eventRecurrenceActions.ts', from: 'export type RecurrenceWriteOutcome', marker: "readonly outcome: 'updated' | 'deleted';" },
  conflictFile: 'src/app/eventRecurrenceActions.ts',
  storage: {
    file: 'src/app/eventRecurrenceActions.ts',
    create: "'storage-failure'",
    write: "'recovery-required'",
    createNote: 'there is no create on this path; a rejected write is a storage failure of its own',
    writeNote: 'the write failure reason is passed through from the event operations, so storage failure and recovery-required stay distinguishable here too',
    refusingNote: 'the store read that decides the question is a storage failure of its own',
  },
  requestId: {
    file: 'src/app/eventRecurrenceActions.ts',
    witness: 'readonly recordId: OpaqueRecordId',
    note: 'the outcome carries the verb, the scope, the record id, the revision and a refreshed flag, and no request id; the event operations it calls discard the coordinator one',
  },
  ids: { file: 'src/app/eventRecurrenceActions.ts', marker: 'readonly recordId: OpaqueRecordId' },
  audit: {
    file: 'src/app/eventRecurrenceActions.ts',
    witness: 'export type RecurrenceWriteOutcome',
    note: 'the outcome is returned and never recorded: no ring, no audit event, and the convergence step is a re-read rather than a record',
  },
};

/** The project lifecycle operations. */
const PROJECT_CONTRACT: FamilyContract = {
  requestFile: 'src/app/projectMutations.ts',
  validation: {
    file: 'src/app/projectMutations.ts',
    witness: 'request: CreateProjectRequest',
    note: 'the name and the description are checked before the write, but the entry takes the typed request object and nothing accepts it as unknown, so the boundary is TypeScript rather than a parse',
  },
  success: { file: 'src/app/projectMutations.ts', from: 'export interface ProjectMutationSuccess', marker: "readonly outcome: 'created' | 'updated' | 'archived' | 'restored';" },
  conflictFile: 'src/app/projectMutations.ts',
  storage: {
    file: 'src/app/projectMutations.ts',
    create: "'storage-failure'",
    write: "'recovery-required'",
    createNote: 'a create goes through the store own createIfAbsent and never journals, so recovery is not applicable and a rejected write is a storage failure of its own',
    writeNote: 'a storage failure and a store that needs recovery stay distinguishable, which is what a conditional lifecycle write needs',
    refusingNote: 'the store list that counts the members is a storage failure of its own, and recovery is not applicable because the delete writes nothing',
  },
  requestId: {
    file: 'src/app/projectMutations.ts',
    witness: 'readonly recordId: OpaqueRecordId',
    note: 'the coordinator requestId is dropped: write reads ok, reason and actualRevision from the outcome, and createProject never reaches the coordinator at all',
  },
  ids: { file: 'src/app/projectMutations.ts', marker: 'readonly recordId: OpaqueRecordId' },
  audit: {
    file: 'src/app/projectMutations.ts',
    witness: 'export type ProjectMutationResult',
    note: 'no semantic event is emitted: the dispatcher refuses project create, archive, restore and delete with action-not-available before record-store cutover, so the ring records a refusal rather than the write',
  },
};

/** The workflow-stage operations. */
const STAGE_CONTRACT: FamilyContract = {
  requestFile: 'src/app/workflowStageMutations.ts',
  validation: {
    file: 'src/app/workflowStageMutations.ts',
    witness: 'request: CreateWorkflowStageRequest',
    note: 'the name is checked by stageNameFailure, which does take unknown, but the request object itself is typed and nothing accepts it as unknown, so a programmatic caller is refused field by field inside the module',
  },
  success: { file: 'src/app/workflowStageMutations.ts', from: 'export interface WorkflowStageMutationSuccess', marker: "readonly outcome: 'created' | 'renamed' | 'deleted';" },
  conflictFile: 'src/app/workflowStageMutations.ts',
  storage: {
    file: 'src/app/workflowStageMutations.ts',
    create: "'storage-failure'",
    write: "'recovery-required'",
    createNote: 'a create goes through the store own createIfAbsent and never journals, so recovery is not applicable and a rejected write is a storage failure of its own',
    writeNote: 'a storage failure and a store that needs recovery stay distinguishable, and a delete that stopped part-way says which cards had already moved',
    refusingNote: 'the store read that decides the question is a storage failure of its own',
  },
  requestId: {
    file: 'src/app/workflowStageMutations.ts',
    witness: 'readonly recordId: OpaqueRecordId',
    note: 'the coordinator requestId is dropped on every branch - the rename reads ok, reason and actualRevision, and the delete does the same - so the stage result cannot be correlated with the journal that wrote it',
  },
  ids: { file: 'src/app/workflowStageMutations.ts', marker: 'readonly recordId: OpaqueRecordId' },
  audit: {
    file: 'src/app/workflowStageMutations.ts',
    witness: 'export type WorkflowStageMutationResult',
    note: 'no semantic event is emitted on any stage verb: the write sequences re-read the store instead, and the only ring in the tree is the dispatcher, which does not carry a stage verb at all',
  },
};

/** The property-schema operations. */
const SCHEMA_CONTRACT: FamilyContract = {
  requestFile: 'src/app/propertySchemaMutations.ts',
  validation: {
    file: 'src/app/propertySchemaMutations.ts',
    witness: 'request: CreatePropertySchemaRequest',
    note: 'the name and the definition are checked, and the definition is validated by the domain constructor, but the request object is typed and nothing accepts it as unknown, so the parse happens inside the module rather than at a boundary',
  },
  success: {
    file: 'src/app/propertySchemaMutations.ts',
    from: 'export interface PropertySchemaMutationSuccess',
    marker: "readonly outcome: 'created' | 'updated' | 'option-added' | 'option-renamed' | 'option-removed' | 'deleted';",
  },
  conflictFile: 'src/app/propertySchemaMutations.ts',
  storage: {
    file: 'src/app/propertySchemaMutations.ts',
    create: "'storage-failure'",
    write: "'recovery-required'",
    createNote: 'a create goes through the store own createIfAbsent and never journals, so recovery is not applicable and a rejected write is a storage failure of its own',
    writeNote: 'a storage failure and a store that needs recovery stay distinguishable on the journaled path',
    refusingNote: 'the store read that counts the values is a storage failure of its own',
  },
  requestId: {
    file: 'src/app/propertySchemaMutations.ts',
    witness: 'readonly recordId: OpaqueRecordId',
    note: 'the coordinator requestId is dropped by writeSchema and by the delete branch, and createPropertySchema never reaches the coordinator, so no schema result can be correlated with its journal entry',
  },
  ids: { file: 'src/app/propertySchemaMutations.ts', marker: 'readonly recordId: OpaqueRecordId' },
  audit: {
    file: 'src/app/propertySchemaMutations.ts',
    witness: 'export type PropertySchemaMutationResult',
    note: 'no semantic event is emitted: the schema rows are operation-only and the dispatcher has no schema verb, so nothing records a schema write outside the journal that made it recoverable',
  },
};

/**
 * The task family, one row per row the file above already carries.
 *
 * The request cell names the half of the closed mutation union that carries the row's verb, because
 * that union is what a caller actually composes; the refusal cell names the sentence the row's own
 * semantics produces rather than the vocabulary in general.
 */
const TASK_CONTRACT_ROWS: readonly ContractRow[] = contractRows(TASK_CONTRACT, [
  {
    action: 'task.create',
    request: { marker: 'export interface CreateTaskRequest', reason: 'a create names the record it wants rather than patching one: the closed exported type carries the name, the project, the dates, the durations and the initial properties, and the id is allocated by the store rather than supplied' },
    effect: "'created'",
    shape: 'create',
    refusal: { marker: "'a task needs a name'", reason: 'a create that names nothing is refused with a machine-readable reason before the first byte moves, and the same vocabulary answers an unreadable instant or a description that is too long' },
    observable: { file: 'tests/taskCreate.test.ts', marker: "state.tasks.find((task) => task.name === 'Created from the form')", note: 'the create case re-reads the world the form created into and finds the task there, then asserts the file count, so the record is observed rather than assumed' },
  },
  {
    action: 'task.update (ordinary fields)',
    request: { marker: 'export type TaskFieldMutation', reason: 'one mutation per field, named: the union is what an ordinary edit composes, so a caller cannot invent a field and cannot write a field the module does not understand' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'an update with no field to change is not an update'", reason: 'an empty mutation list is refused as a validation refusal rather than written as a record that says the same thing' },
    observable: { file: 'tests/taskEditorWrite.test.ts', marker: '(await app.deps.store.read(id))?.observedRevision', note: 'the save case reads the stored revision back and asserts the revision the write moved it to' },
  },
  {
    action: 'task.delete',
    request: { marker: 'export async function deleteTask', reason: 'the request is the closed object type on the exported delete operation - the task and the revision the caller read - so a delete is a semantic request rather than a path' },
    effect: "'deleted'",
    shape: 'write',
    refusal: { marker: "'the task record is not in the store'", reason: 'deleting a task the store does not hold answers a stable reason instead of throwing, and the conditional write reports a lost race rather than a false success' },
    observable: { file: 'tests/taskEditorWrite.test.ts', marker: 'expect(await app.deps.store.read(id)).toBeUndefined();', note: 'the delete case asserts the record is gone from the store, which is deletion absence rather than a returned flag' },
  },
  {
    action: 'task dates set/clear',
    request: { marker: "kind: 'dates'", reason: 'both ends travel in one mutation, so a task whose start moved and whose end did not cannot be expressed through this request' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'the start date is not a readable instant'", reason: 'an unreadable instant is refused by name before the write, and an end before its start has its own sentence' },
    observable: { file: 'tests/taskEditorWrite.test.ts', marker: '(await app.deps.store.read(id))?.observedRevision', note: 'the dates case reads the stored record back after the save, so the two ends are observed in the store rather than in the plan' },
  },
  {
    action: 'task weight/duration edits',
    request: { marker: "kind: 'max-duration'", reason: 'the weight, the fixed duration and the maximum duration are three named mutations rather than a numeric bag, and the maximum is the one the record-layer suite exercises directly' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'the maximum duration is whole minutes, or nothing at all'", reason: 'a duration that is not a whole number of minutes is refused by name, and so is a maximum below the fixed duration' },
    observable: { file: 'tests/taskMutations.test.ts', marker: '(await deps.store.read(seeded.recordId))?.observedRevision', note: 'the record-layer suite reads the stored revision back and asserts it equals the revision the operation returned' },
  },
  {
    action: 'task.execution.move',
    request: { marker: "kind: 'execution-state'", reason: 'the move is the pair execution-state and execution-order submitted as one update, which is what makes the column and the position land together' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'the execution order is a position, so it is a whole number that is not negative'", reason: 'a position that is not a whole number is refused with a named reason before the column moves' },
    observable: { file: 'tests/taskMoveGesture.test.ts', marker: 'observation?.observedRevision', note: 'the gesture suite reads every dragged task back out of the store and asserts the revision the move left on it' },
  },
  {
    action: 'task.execution.reorder',
    request: { marker: "kind: 'execution-order'", reason: 'a reorder is the same request in the same column with a different position, so the one mutation carries it' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'the execution order is a position, so it is a whole number that is not negative'", reason: 'the same position rule the move uses, refused rather than clamped' },
    observable: { file: 'tests/taskMoveGesture.test.ts', marker: 'observation?.observedRevision', note: 'the same suite drives the reorder and reads the stored revision back, so the position that landed is the store own' },
  },
  {
    action: 'task workflow-stage move',
    request: { marker: "kind: 'workflow-stage'", reason: 'the stage and its position travel together in one mutation, because the canonical model refuses either half alone' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'a task in a workflow stage needs its position in that stage'", reason: 'a stage without a position and a position without a stage are both refused by name, and a stage belonging to another project is a semantic conflict' },
    observable: { file: 'tests/projectWorkflowBoard.test.ts', marker: 'settle: async (id) => {', note: 'the board suite settles each card by reading it out of the store, which is the authoritative position rather than the drawn one' },
  },
  {
    action: 'task workflow reorder',
    request: { marker: "kind: 'workflow-order'", reason: 'the in-stage reorder has its own mutation, and the module refuses to write one for a task that has no stage' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'a task with no workflow stage has no workflow position to change'", reason: 'the position that cannot exist is refused with its own sentence rather than silently created' },
    observable: { file: 'tests/workflowMoveGesture.test.ts', marker: '(await app.deps.store.read(task.id))!.observedRevision', note: 'the gesture suite reads the stored revision back before the next conditional write, so a write that had not landed would be refused as stale' },
  },
  {
    action: 'task Gantt date move',
    request: { marker: "kind: 'dates'", reason: 'a Gantt move compiles to the same dates mutation a form save uses, so a drag and a typed change cannot disagree about what moved' },
    effect: "'updated'",
    shape: 'write',
    refusal: { file: 'src/app/timelineChangeAction.ts', marker: "'a task must end after it starts'", reason: 'the Gantt plans its span before the operation is asked, so an inverted range is refused as invalid-range with a sentence rather than reaching the store' },
    observable: { file: 'tests/ganttWriteWiring.test.ts', marker: 'const after = spanOf(app, app.dragged);', note: 'the click test re-syncs from the store after the release and reads the moved span back out of it' },
  },
  {
    action: 'task Gantt start resize',
    request: { marker: "kind: 'dates'", reason: 'a start-edge drag compiles to the same dates mutation, with the end taken from the record the bar was drawn from' },
    effect: "'updated'",
    shape: 'write',
    refusal: { file: 'src/app/timelineChangeAction.ts', marker: "'the start is not a real instant'", reason: 'a proposed start that is not a real instant is refused as invalid-range before the write rather than written as a span nobody can read' },
    observable: { file: 'tests/timelineChangeAction.test.ts', marker: 'const observation = await store.read(task.recordId);', note: 'the case reads the record back out of the store through its own record helper before asserting which end moved' },
  },
  {
    action: 'task Gantt end resize',
    request: { marker: "kind: 'dates'", reason: 'an end-edge drag compiles to the same dates mutation, with the start taken from the record' },
    effect: "'updated'",
    shape: 'write',
    refusal: { file: 'src/app/timelineChangeAction.ts', marker: "'the end is not a real instant'", reason: 'a proposed end that is not a real instant is refused as invalid-range before the write, which is what keeps a refused resize from moving the bar' },
    observable: { file: 'tests/timelineChangeAction.test.ts', marker: 'const observation = await store.read(task.recordId);', note: 'the same record helper reads the stored span back after the end-edge resize' },
  },
  {
    action: 'task property set/clear',
    request: { marker: "kind: 'property'", reason: 'one property, named by the schema record that defines it, set or cleared by value null: the same mutation the record layer validates against stored schemas' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: 'no schema record defines the property ${', reason: 'a property nothing defines is refused as a semantic conflict by name, before the record is written' },
    observable: { file: 'tests/propertyMutationPlan.test.ts', marker: '(await store.read(created.recordId))?.record', note: 'the case reads the stored task back and asserts the property value the plan landed on it' },
  },
  {
    action: 'task relation edit',
    request: { marker: "kind: 'property'", reason: 'a relation is a value like any other here, so the same property mutation carries it and the relation rule stays with the schema the value points at' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: 'no schema record defines the property ${', reason: 'the same refusal: a relation value keyed by a schema record that does not exist is a conflict rather than an orphan value' },
    observable: { file: 'tests/propertyMutationPlan.test.ts', marker: '(await store.read(created.recordId))?.record', note: 'the same read-back: the stored relation value is asserted on the record, not on the plan that produced it' },
  },
  {
    action: 'task.bulk.complete',
    contract: BULK_TASK_CONTRACT,
    request: { marker: 'readonly taskIds: readonly string[]', reason: 'the selection arrives as a closed list of task ids, and each member is written through the task operations at the revision the surface was rendering rather than by a bulk path of its own' },
    effect: "'accepted', or 'partial' when only some members landed",
    shape: 'write',
    refusal: { file: 'src/app/bulkTaskActions.ts', marker: "'the selection names a task that is not loaded'", reason: 'a marked task the world does not hold is reported per entity rather than aborting the run, and a member that lost a race is reported with the revision that beat it' },
    observable: { file: 'tests/backlogBulkActions.test.ts', marker: '(await app.state()).tasks.find((task) => task.id === first)?.status', note: 'the bulk case reads the projected state back after the run and finds the member finished' },
  },
  {
    action: 'task.bulk.delete',
    contract: BULK_TASK_CONTRACT,
    request: { marker: 'readonly taskIds: readonly string[]', reason: 'the same closed selection, with each member deleted through the task delete operation at the revision the surface was rendering' },
    effect: "'accepted', or 'partial' when only some members landed",
    shape: 'write',
    refusal: { file: 'src/app/bulkTaskActions.ts', marker: "'the selection names a task that is not loaded'", reason: 'the same per-entity refusals, so one raced record cannot cost the rest of the selection' },
    observable: { file: 'tests/stageTenAcceptance.test.ts', marker: 'expect(await app.stored(first.id)).toBeUndefined();', note: 'the acceptance case reads each member back out of the store and asserts the deleted ones are absent' },
  },
  {
    action: 'task recurrence (retained)',
    request: { marker: "kind: 'recurrence'", reason: 'the record layer accepts a recurrence series for a task as one typed mutation; no surface composes it yet, which is why the row is operation-only' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'an update with no field to change is not an update'", reason: 'the field union is what refuses here, and an update with nothing to change is refused rather than written' },
    observable: { gap: { file: 'tests/taskMutations.test.ts', marker: "kind: 'recurrence'", witness: 'recurrence: null', reason: 'no test reads a task recurrence write back: the record-layer suite seeds every task with recurrence null and never composes the mutation, so this row is unobserved as well as unreached' } },
  },
]);

/** The event family: the five record verbs, the two scope verbs, and the retained rule row. */
const EVENT_CONTRACT_ROWS: readonly ContractRow[] = [
  ...contractRows(EVENT_CONTRACT, [
    {
      action: 'event.create',
      request: { marker: 'export interface CreateEventRequest', reason: 'a create names both ends of the span and the project, so an event that does not span anything cannot be asked for' },
      effect: "'created'",
      shape: 'create',
      refusal: { marker: "'an event needs a start that is a real instant'", reason: 'a create without a real start or end is refused by name, and so is a span that ends before it starts' },
      observable: { file: 'tests/scheduleWriteWiring.test.ts', marker: "drawn.events.find((event) => event.name === 'Seeded through the grid')", note: 'the seeded form case re-reads the schedule after the create and finds the event by name in what came back' },
    },
    {
      action: 'event.update',
      request: { marker: 'export type EventFieldMutation', reason: 'one field per mutation, including the span the editor submits when both ends changed, so a form and the gesture verbs share one validated write' },
      effect: "'updated'",
      shape: 'write',
      refusal: { marker: "'an update with no field to change is not an update'", reason: 'a save that changed nothing submits nothing and is answered by the operation refusal rather than written as a record that says the same thing' },
      observable: { file: 'tests/scheduleWriteWiring.test.ts', marker: 'const saved = drawn.events.find((event) => event.id === app.eventId)!;', note: 'the editor case reads the saved event back out of the re-read schedule rather than out of the draft it typed' },
    },
    {
      action: 'event.delete',
      request: { marker: 'export async function deleteEvent', reason: 'the request is the closed object type on the exported delete operation - the event and the revision the caller read' },
      effect: "'deleted'",
      shape: 'write',
      refusal: { marker: "'the event record is not in the store'", reason: 'deleting an event the store does not hold answers a reason instead of throwing, and a record at that id that is not an event is answered as not-found too' },
      observable: { file: 'tests/scheduleWriteWiring.test.ts', marker: 'expect(drawn.events.some((event) => event.id === app.eventId)).toBe(false);', note: 'the delete case asserts the event is gone from the re-read schedule, which is deletion absence rather than a returned flag' },
    },
    {
      action: 'event.reschedule',
      request: { marker: 'export async function rescheduleEvent', reason: 'the verb names the new start and nothing else: the duration is the record own, which is what makes a drag and an agent sentence the same request' },
      effect: "'rescheduled'",
      shape: 'write',
      refusal: { marker: "'the new start is not a real instant'", reason: 'an unreadable new start is refused by name before the record is read, and the resulting span is validated before the write' },
      observable: { file: 'tests/scheduleWriteWiring.test.ts', marker: 'const moved = drawn.events.find((event) => event.id === app.eventId)!;', note: 'the drag case reads the moved event back out of the re-read schedule and asserts the start the store holds' },
    },
    {
      action: 'event.resize',
      request: { marker: 'export type EventResizeTarget', reason: 'a resize names either the new end or the duration it should have, never both and never neither, so the two things a caller actually knows are the two shapes of one request' },
      effect: "'resized'",
      shape: 'write',
      refusal: { marker: "'a duration must be a whole number of minutes greater than zero'", reason: 'an impossible duration and an unreadable end are each refused by name before the span is written' },
      observable: { file: 'tests/scheduleWriteWiring.test.ts', marker: 'const resized = drawn.events.find((event) => event.id === app.eventId)!;', note: 'the resize case reads the resized event back out of the re-read schedule' },
    },
  ]),
  ...contractRows(RECURRENCE_CONTRACT, [
    {
      action: 'event occurrence change',
      request: { marker: 'readonly change: OccurrenceChange', reason: 'the request names the occurrence, the scope and the change, so a caller that means one slot says so rather than being inferred from what it edited' },
      effect: "'updated'",
      shape: 'write',
      refusal: { file: 'src/app/eventRecurrencePlan.ts', marker: "'not-a-generated-occurrence'", reason: 'an override for an instant the rule does not generate is refused by name, and a moved occurrence with an impossible span is refused as invalid-span' },
      observable: { file: 'tests/recurrenceScopeWiring.test.ts', marker: 'const observation = await store.read(created.recordId);', note: 'the wiring case reads the event record back out of the store and asserts the exception the occurrence write left on it' },
    },
    {
      action: 'event series change',
      request: { marker: 'scope: OccurrenceScope', reason: 'the scope is a parameter and never an inference: a series-scoped move writes the owner record span and drops the overrides, and a series-scoped cancel deletes the owner record' },
      effect: "'updated', or 'deleted' for a series-scoped cancel",
      shape: 'write',
      refusal: { file: 'src/app/eventMutations.ts', marker: "'an event must end after it starts'", reason: 'a series move goes through the same validated span write, so an impossible span is refused with a machine-readable reason rather than written as the series rule' },
      observable: { file: 'tests/eventRecurrence.test.ts', marker: 'expect((await app.series())?.exceptions).toEqual([]);', note: 'the series case reads the series back out of the record and asserts the overrides were dropped, which is the claim a series-scoped move makes' },
    },
    {
      action: 'event.recurrence.set/clear (retained)',
      request: { marker: 'readonly rule: CanonicalRecurrenceRule', reason: 'the set half names the rule it writes and the clear half names only the event; neither accepts a series id from the caller, because the series identity is allocated rather than supplied' },
      effect: "'updated'",
      shape: 'write',
      refusal: { marker: 'refused(verb, scope, planned.reason, planned.detail)', reason: 'the rule is validated by the planner and its machine-readable reason travels back through planned.reason, so a rule that cannot be written is refused rather than thrown' },
      observable: { file: 'tests/eventRecurrence.test.ts', marker: 'expect(await app.series()).toBeNull();', note: 'the case reads the series back out of the store record through its own helper and asserts it is gone, and the schedule expansion is asserted empty beside it' },
    },
  ]),
];

/** The project lifecycle family. */
const PROJECT_CONTRACT_ROWS: readonly ContractRow[] = contractRows(PROJECT_CONTRACT, [
  {
    action: 'project.create',
    request: { marker: 'export interface CreateProjectRequest', reason: 'a create names the project and its description and nothing else: the status, the archive date and the bindings are the module own decisions' },
    effect: "'created'",
    shape: 'create',
    refusal: { marker: "'a project needs a name'", reason: 'a create that names nothing is refused with a machine-readable reason before the record is built' },
    observable: { file: 'tests/projectLifecycleActions.test.ts', marker: "(await app.state()).projects.find((project) => project.name === 'From the modal')", note: 'the sequence case re-reads the hub state after the create and finds the project by the name the form typed' },
  },
  {
    action: 'project.update',
    request: { marker: 'export type ProjectFieldMutation', reason: 'one field per mutation, named, and projectType is deliberately not one of them - the legacy label was removed from capability decisions' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: "'an update with no field to change is not an update'", reason: 'a save with nothing changed is the operation own refusal, which the surface draws without a record being rewritten' },
    observable: { file: 'tests/projectLifecycleWiring.test.ts', marker: 'const renamed = (await app.read()).projects.find((project) => project.id === app.projectId)!;', note: 'the editor case re-reads the hub after the save and asserts the new name and the untouched description' },
  },
  {
    action: 'project.archive',
    request: { marker: 'export async function archiveProject', reason: 'archive is a status change with the caller revision, so the request is the project and the revision rather than a field mutation that could set a status directly' },
    effect: "'archived'",
    shape: 'write',
    refusal: { marker: "'this project is already archived'", reason: 'archiving a project that is already archived is a semantic conflict by name, and the refusal writes nothing' },
    observable: { file: 'tests/projectLifecycleWiring.test.ts', marker: 'const archived = (await app.read()).projects.find((project) => project.id === app.projectId)!;', note: 'the clicked-control case re-reads the hub after the click and asserts the status and the archive instant the store holds' },
  },
  {
    action: 'project.restore',
    request: { marker: 'export async function restoreProject', reason: 'restore is the other status change, clearing the archive date with the status it belonged to' },
    effect: "'restored'",
    shape: 'write',
    refusal: { marker: "'this project is not archived, so there is nothing to restore'", reason: 'restoring a project that is not archived is refused by name rather than written as a no-op that moves the revision' },
    observable: { file: 'tests/projectLifecycleWiring.test.ts', marker: 'const restored = (await app.read()).projects.find((project) => project.id === app.projectId)!;', note: 'the same case clicks Restore and re-reads the hub, so the second status change is observed too' },
  },
  {
    action: 'project.delete',
    request: { marker: 'export async function deleteProject', reason: 'the request is the exported delete operation with the project and the revision; what the verb means for the members is the creator decision the module refuses to invent' },
    effect: 'nothing: this operation has no success branch',
    success: { marker: "readonly outcome: 'created' | 'updated' | 'archived' | 'restored';", status: 'n/a', reason: 'deleteProject always answers policy-not-decided, and the project success union names created, updated, archived and restored and deliberately no delete, so there is no success half for this row to carry' },
    shape: 'refusing',
    conflictNote: 'the revision is checked before the policy question, so a caller that lost a race is refused as stale-revision rather than answered with the policy question',
    refusal: { marker: "'policy-not-decided'", reason: 'the refusal is the answer the row is about: deterministic, typed, in the taxonomy vocabulary, naming the question and the counts it would affect while writing nothing' },
    idsGap: { file: 'src/app/projectMutations.ts', marker: 'affectedRecordIds', witness: 'would affect', reason: 'the only answer this verb gives summarises a multi-record effect as counts - how many tasks and events deleting would affect - and never names which ones, so a caller cannot enumerate the question it is being asked' },
    observable: { file: 'tests/projectMutations.test.ts', marker: 'expect((await app.bytes())).toEqual(before);', note: 'the case snapshots every record file byte and revision before the refusal and asserts the store is byte-identical afterwards, which is the observable state of a verb that wrote nothing' },
  },
]);

/** The workflow-stage family. */
const STAGE_CONTRACT_ROWS: readonly ContractRow[] = contractRows(STAGE_CONTRACT, [
  {
    action: 'workflow stage create',
    request: { marker: 'export interface CreateWorkflowStageRequest', reason: 'a stage is created by naming its project and its name, and no caller supplies an id for a create' },
    effect: "'created'",
    shape: 'create',
    refusal: { marker: "'a workflow stage needs a name'", reason: 'a create that names nothing is refused by name before the project is even read' },
    observable: { file: 'tests/workflowStageBoard.test.ts', marker: 'stage: async (id) => {', note: 'the board suite reads a stage back out of the store through its own helper before asserting what the create left in it' },
  },
  {
    action: 'workflow stage rename',
    request: { marker: 'export async function renameWorkflowStage', reason: 'a rename names the stage, the revision the board was rendering and the new name, so a stale board is told rather than overwriting' },
    effect: "'renamed'",
    shape: 'write',
    refusal: { marker: 'a workflow stage name may be at most ${MAX_NAME_LENGTH} characters', reason: 'a name that is empty or too long is refused with its own bounded sentence before the record is read' },
    observable: { file: 'tests/workflowStageBoard.test.ts', marker: 'const observation = await store.read(id);', note: 'the rename case settles the stage by reading it out of the store, so the name that landed is the store own' },
  },
  {
    action: 'workflow stage delete/remap',
    request: { marker: 'export type WorkflowStageRemapTarget', reason: 'the delete request carries the target the cards go to, or nothing at all when the caller has not decided, which is what makes the refusal a question rather than a wall' },
    effect: "'deleted'",
    shape: 'write',
    refusal: { marker: 'the stage still holds ${members.length} task(s); say where they go before deleting it', reason: 'a stage that still holds tasks is refused with the count and the question, and a target in another project is a semantic conflict' },
    ids: { marker: 'readonly remappedTaskIds: readonly OpaqueRecordId[]', reason: 'a delete that moves cards returns every id it moved in the order it moved them, and a delete that stopped part-way carries the ids that had already moved in the failure rather than a count' },
    observable: { file: 'tests/workflowStageBoard.test.ts', marker: 'const observation = await store.read(id);', note: 'the delete case reads the stage back out of the store and reads the moved cards out too, so both halves of the remap are observed' },
  },
]);

/** The property-schema family, which has operations and no surface. */
const SCHEMA_CONTRACT_ROWS: readonly ContractRow[] = contractRows(SCHEMA_CONTRACT, [
  {
    action: 'property schema create/update/delete',
    request: { marker: 'export interface CreatePropertySchemaRequest', reason: 'a create names the property and its definition, and the update and delete requests are closed object types on their exported operations; a definition is validated by the domain constructor rather than by a second copy of its rules' },
    effect: "'created', 'updated' or 'deleted'",
    shape: 'write',
    conflictNote: 'the update and the delete refuse a lost race with stale-revision and the revision that beat them, and the create half carries the collision that is possible instead - a record already holding that id',
    refusal: { marker: "'an update with no field to change is not an update'", reason: 'an update that names neither a name nor a definition is refused by name, and a delete is refused while records still carry a value for the property' },
    observable: { file: 'tests/propertySchemaMutations.test.ts', marker: 'const projection = projectRecordState(await worldValue.deps.store.list());', note: 'the create case reads the store back through the projection every surface uses and finds the property there, and the delete case asserts the record is gone' },
  },
  {
    action: 'schema options',
    request: { marker: 'export type SchemaOptionMutation', reason: 'one option at a time - add, rename or remove - because an option id is what a stored value points at, so a bulk options rewrite could not be validated against the values that use it' },
    effect: "'option-added', 'option-renamed' or 'option-removed'",
    shape: 'write',
    refusal: { marker: "'only a select or multi-select property has options'", reason: 'the verb refuses a property that has no options, a duplicate label, and an option id the schema does not declare' },
    observable: { file: 'tests/propertySchemaMutations.test.ts', marker: 'expectedRevision: (await worldValue.deps.store.read(schemaId))!.observedRevision,', note: 'the option case reads the schema revision back out of the store for each conditional write, so an option write that had not landed would be refused as stale' },
  },
  {
    action: 'formula/rollup/relation schema edits',
    request: { marker: 'export async function updateSchemaField', reason: 'the field verb edits an expression, an aggregation, a target list or an option list and may not change the kind of value the property holds' },
    effect: "'updated'",
    shape: 'write',
    refusal: { marker: 'a field edit may not change ${current.record.definition.type} into ${input.definition.type}', reason: 'a field edit that would change the kind of value is refused with a sentence naming both kinds, because that is a value migration rather than an edit' },
    observable: { gap: { file: 'tests/propertySchemaMutations.test.ts', marker: 'store.read(formula.recordId)', witness: "expect(edited.record).toMatchObject({ name: 'Score', definition: { type: 'formula', expression: 'weight * 3' } });", reason: 'the field-edit case asserts the definition the operation returned and never reads the schema record back out of the store, so the authoritative post-action state of this verb is not observed by any test' } },
  },
]);

/** The walker every family test uses: the Templates assertions, row by row. */
function assertContractRows(rows: readonly ContractRow[]): void {
  for (const row of rows) {
    expect(row.cells.map((cell) => cell.column), `${row.action}: the ten columns must be in the AUTHOR's order`).toEqual([...CONTRACT_COLUMNS]);
    for (const cell of row.cells) {
      const text = source(cell.file);
      let scoped = text;
      if (cell.from !== undefined) {
        // The anchor is asserted before it scopes anything: indexOf returning -1 would slice the last
        // character and leave the anchor check passing on a file that never carried the anchor.
        expect(text, `${row.action} / ${cell.column}: ${cell.file} must contain the anchor ${cell.from}`).toContain(cell.from);
        scoped = text.slice(text.indexOf(cell.from));
      }
      if (cell.witness !== undefined) {
        expect(scoped, `${row.action} / ${cell.column}: ${cell.file} must carry the witness ${cell.witness}`).toContain(cell.witness);
      }
      // A satisfied cell or a not-applicable note must carry its marker; a gap must not, which is what
      // makes a gap fail the day it closes rather than staying a gap nobody revisits.
      expect(scoped.includes(cell.marker), `${row.action} / ${cell.column} (${cell.status}): ${cell.reason}`)
        .toBe(cell.absent !== true);
    }
  }
}

describe('Stage 17 task contract matrix', () => {
  it('records the ten columns for every task row the file carries, the operation-only one included', () => {
    // The matrix covers exactly the rows above: a row added to the table without contract cells, or a
    // contract row left behind by a removed action, fails here rather than passing unnoticed.
    expect(TASK_CONTRACT_ROWS.map((row) => row.action)).toEqual([
      ...TASK_ROWS.map((row) => row.action),
      ...OPERATION_ONLY_ROWS.map((row) => row.action),
    ]);
    assertContractRows(TASK_CONTRACT_ROWS);
  });
});

describe('Stage 17 event contract matrix', () => {
  it('records the ten columns for every event row the file carries, the retained rule included', () => {
    expect(EVENT_CONTRACT_ROWS.map((row) => row.action)).toEqual([
      ...EVENT_ROWS.map((row) => row.action),
      ...EVENT_OPERATION_ONLY_ROWS.map((row) => row.action),
    ]);
    assertContractRows(EVENT_CONTRACT_ROWS);
  });
});

describe('Stage 17 project contract matrix', () => {
  it('records the ten columns for every project row, the refusing delete included', () => {
    expect(PROJECT_CONTRACT_ROWS.map((row) => row.action)).toEqual(PROJECT_ROWS.map((row) => row.action));
    assertContractRows(PROJECT_CONTRACT_ROWS);
  });
});

describe('Stage 17 workflow-stage contract matrix', () => {
  it('records the ten columns for every workflow-stage row', () => {
    expect(STAGE_CONTRACT_ROWS.map((row) => row.action)).toEqual(WORKFLOW_STAGE_ROWS.map((row) => row.action));
    assertContractRows(STAGE_CONTRACT_ROWS);
  });
});

describe('Stage 17 schema contract matrix', () => {
  it('records the ten columns for every schema row, which are operation-only', () => {
    expect(SCHEMA_CONTRACT_ROWS.map((row) => row.action)).toEqual(SCHEMA_ROWS.map((row) => row.action));
    assertContractRows(SCHEMA_CONTRACT_ROWS);
  });
});