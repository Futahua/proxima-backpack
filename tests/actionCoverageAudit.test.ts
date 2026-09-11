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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

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

/** The one task action the record layer accepts and no surface offers yet. */
const OPERATION_ONLY_ROWS = [
  { action: 'task recurrence (retained)', module: 'src/app/taskMutations.ts', marker: "kind: 'recurrence'" },
] as const;

describe('Stage 17 task action coverage', () => {
  it('names a module, a caller and a test for every task action the UI reaches', () => {
    for (const row of TASK_ROWS) {
      const text = source(row.module);
      expect(text, `${row.action}: ${row.module} must carry ${row.marker}`).toContain(row.marker);
      const callerText = row.callerFile === undefined ? MAIN : source(row.callerFile);
      expect(callerText, `\: \ must reach it`).toContain(row.caller!);
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