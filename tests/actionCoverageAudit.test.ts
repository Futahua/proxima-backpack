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