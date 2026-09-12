import { createActionDispatcher, type ActionResult, type ProjectWorkspaceTab, type ProximaActionDispatcher, type ScheduleMode, type Surface, type TasksMode, type TimekeepingPanelVisibility } from '../app/actionProtocol.js';
import type { SemanticAuditEvent } from '../app/semanticAudit.js';
import { createInspectionProjection } from '../app/inspection.js';
import type { ReadOnlyProjection } from '../app/readOnlyProjection.js';
import { evaluateRealVaultAcceptance, isRealVaultAcceptanceReport, type RealVaultAcceptanceReport } from '../app/realVaultAcceptance.js';
import { evaluateCreatorVaultPreflight, isCreatorVaultPreflightReport, type CreatorVaultPreflightReport } from '../app/creatorVaultPreflight.js';
import { coexistenceReadiness, declareCoexistenceReadiness } from './coexistenceReadiness.js';
import { evaluateRealVaultRunbook } from '../app/realVaultRunbook.js';
import { createStartupSessionOrchestrator, type StartupInspection } from '../app/startupSession.js';
import { resolveBrowserRecordStoreSource } from '../adapters/recordStoreStartupSource.js';
import { resolveBrowserTaskMutations, type BrowserRecordMutations } from '../adapters/browserTaskMutations.js';
import { performElasticDrop } from '../app/elasticDropAction.js';
import { performWorkflowDrop } from '../app/workflowBoardDrop.js';
import { bulkCompleteTasks, bulkDeleteTasks, type BulkTaskActionReport } from '../app/bulkTaskActions.js';
import { deleteTaskAction, saveTaskAction } from '../app/taskEditorWrite.js';
import { createTaskAction, newTaskDraft as newTaskDraftFor } from '../app/taskCreate.js';
import { bindTemplateExecuteInteractions } from './templateExecuteBinding.js';
import { TASK_EDITOR_SAVE_REFUSAL } from '../app/taskEditor.js';
import type { SourceMode, SourceSession } from '../app/sourceSession.js';
import type { RefreshReason, RefreshResult } from '../app/refreshController.js';
import { executeSourceRefreshAction } from '../app/sourceRefreshAction.js';
import { loadProjectNotePreview, loadProjectNotesTree } from '../app/projectNotes.js';
import { createUiHealthModel, type UiHealthModel } from '../app/uiHealth.js';
import { evaluateCleanProfileAcceptance } from '../app/fsaEvidence.js';
import { pickAndProbeDirectory, rereadSelectedDirectory, restoreAndProbeDirectory } from '../app/fsaProbe.js';
import { loadVaultState } from '../app/vaultRepository.js';
import { fixedClock, sequentialIdGenerator, systemClock } from '../domain/clock.js';
import type { LoadProblem } from '../domain/problems.js';
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import { opaqueRecurrenceSeriesIdFromRandomBytes } from '../domain/canonicalRecurrence.js';
import { ALL_PROJECTS, UNCATEGORISED, elasticBoard, projectsFor, reconcileSelection, tasksForSelection } from '../domain/selectors.js';
import type { ProximaState, ElasticColumn, Task } from '../domain/types.js';
import { BUILD_IDENTITY } from './generated/buildIdentity.generated.js';
import { createHttpDirectoryHandle } from '../adapters/httpDirectory.js';
import { refreshEvidenceFromProjections, renameDeleteEvidenceFromProjections } from './realVaultLive.js';
import { bindRefreshWiring } from './refreshWiring.js';
import { createBrowserSource } from './sourceFactory.js';
import { bindCanvasSurfaceInteractions, CANVAS_SURFACE_WRITE_REFUSAL, createCanvasDropQueue, EMPTY_CANVAS_SURFACE, EMPTY_CANVAS_SURFACE_VIEW, renderCanvasSurface, type CanvasSurfaceState, type CanvasSurfaceViewState } from './canvasSurface.js';
import type { BrowserFileLike } from './canvasFileAdmission.js';
import { createCanvasPreviewRegistry, disposeCanvasPreviewsOnPageHide } from './canvasPreview.js';
import { createCanvasExcalidrawPreviewRegistry, disposeCanvasExcalidrawPreviewsOnPageHide } from './canvasExcalidrawPreview.js';
import { renderWithBoundary } from './renderBoundary.js';
import { createCanvasTextPreviewRegistry, disposeCanvasTextPreviewsOnPageHide } from './canvasTextPreview.js';
import { boardElasticPresentation, type DeadlineState } from './boardElasticPresentation.js';
import { bindElasticCockpitInteractions, renderElasticCockpit, shouldTickElasticProgress } from './elasticCockpit.js';
import { bindTimekeepingCockpitInteractions, renderTimekeepingCockpit, startTimekeepingCountdownTicker } from './timekeepingCockpit.js';
import { resizeTimekeepingPanel } from '../app/panelSizing.js';
import { bindScheduleTimeGridInteractions, renderScheduleTimeGrid, startScheduleTimeTicker, type ScheduleEventChangeIntent, type ScheduleEventCreateIntent, type ScheduleEventDraft, type ScheduleTimeGridMode } from './scheduleTimeGrid.js';
import { bindScheduleProjectionInteractions, renderScheduleProjection, type ScheduleProjectionMode } from './scheduleProjection.js';
import { scheduleNavigationDateKey, type ScheduleNavigationDirection } from './scheduleNavigation.js';
import { scheduleEventsForSelection } from './scheduleSelection.js';
import { bindScheduleRecurrenceInteractions, type ScheduleRecurrenceScope, type ScheduleRecurringOccurrenceSelection } from './scheduleRecurrence.js';
import { renderProjectNavigation } from './projectNavigation.js';
import { eventRecurrenceFor } from './eventModal.js';
import { bindProjectsHubInteractions, renderProjectsHub, type ProjectCreateIntent, type ProjectEditView, type ProjectFormRefusal, type ProjectsHubFilter } from './projectsHub.js';
import { bindProjectNotesInteractions, EMPTY_PROJECT_NOTES_VIEW, PROJECT_NOTE_WRITE_REFUSAL, type ProjectNotesViewState } from './projectNotes.js';
import { bindProjectTaskBoardInteractions, EMPTY_PROJECT_TASK_BOARD_VIEW, PROJECT_TASK_BOARD_WRITE_REFUSAL, type ProjectTaskBoardViewState } from './projectTaskBoard.js';
import { bindProjectWorkflowBoardInteractions, EMPTY_PROJECT_WORKFLOW_BOARD_VIEW, NO_WORKFLOW_STAGE, type ProjectWorkflowBoardViewState } from './projectWorkflowBoard.js';
import { bindProjectBacklogInteractions, EMPTY_PROJECT_BACKLOG_VIEW, PROJECT_BACKLOG_WRITE_REFUSAL, type ProjectBacklogViewState } from './projectBacklog.js';
import {
  propertySchemaEditor,
  schemaAddOptionSubmission,
  schemaCreateOptionSubmissions,
  schemaCreateSubmission,
  schemaDeleteSubmission,
  schemaRenameSubmission,
  type PropertySchemaCreateForm,
} from '../app/propertySchemaEditor.js';
import { submitPropertySchemaAction } from '../app/propertySchemaActions.js';
import {
  bindPropertySchemaPanelInteractions,
  EMPTY_PROPERTY_SCHEMA_PANEL_VIEW,
  type PropertySchemaPanelView,
} from './propertySchemaPanel.js';
import { applyBacklogControl, buildBacklogFilter, buildBacklogPropertyFilter, clearBacklogSelection, resizeBacklogColumn, selectAllBacklogVisible, toggleBacklogSelection } from '../app/backlogControls.js';
import { propertyValueTypeFor } from '../app/backlogView.js';
import { applyTaskEditorEdit, taskEditorDraftFor, type TaskEditorDraft } from '../app/taskEditor.js';
import { bindProjectDeadlinesInteractions, EMPTY_PROJECT_DEADLINES_VIEW, type ProjectDeadlinesViewState } from './projectDeadlines.js';
import { bindProjectScheduleInteractions, EMPTY_PROJECT_SCHEDULE_VIEW, type ProjectScheduleViewState } from './projectSchedule.js';
import { applyBootState, type BootState } from './bootState.js';
import { createProjectNameLookup, projectLabel } from './projectLookup.js';
import { bridgeUrlForLaunch } from './agentBridge.js';
import { cockpitSubmode, renderCockpitNavigation } from './cockpitNavigation.js';
import { sourceLabelFor, workspaceIdentityFor, workspaceWritesFor } from './workspaceIdentity.js';
import { archiveProjectAction, createProjectAction, deleteProjectAction, restoreProjectAction, updateProjectAction, type ProjectLifecycleOutcome } from '../app/projectLifecycleActions.js';
import { planProjectFieldMutations, projectEditorDraftFor, type ProjectEditorDraft } from '../app/projectEditor.js';
import { createEventAction, deleteEventAction, rescheduleEventAction, resizeEventAction, saveEventAction, saveEventFormAction, type EventFormSaveOutcome, type EventWriteOutcome } from '../app/eventWriteActions.js';
import { changeTaskDatesAction } from '../app/timelineChangeAction.js';
import { acceptanceToolsAfterToggle, EMPTY_ACCEPTANCE_TOOLS_VIEW, renderAcceptanceTools, type AcceptanceToolsViewState } from './acceptanceTools.js';
import { createWorkflowStageAction, deleteWorkflowStageAction, renameWorkflowStageAction, type WorkflowStageWriteOutcome } from '../app/workflowStageWriteActions.js';
import { skipOccurrenceFromScope, updateOccurrenceFromScope } from './scheduleScopeWiring.js';
import { eventEditorDraftFor, type EventEditorDraft } from '../app/eventEditor.js';
import type { EventFormValues } from '../app/eventFormPlan.js';

const FIXTURE_NAME = 'vault-basic';
const FIXED_CLOCK = fixedClock(BUILD_IDENTITY.fixedClock);
const DETERMINISTIC_IDS = sequentialIdGenerator();
/** What the Hub's lifecycle controls say while nothing has happened yet and a write path exists. */
const PROJECT_LIFECYCLE_IDLE_FEEDBACK = 'Archive and Restore write the project status; Delete reports the deletion policy.';
let appState: ProximaState | null = null;
let loadProblems: LoadProblem[] = [];
let selection = ALL_PROJECTS;
let surface: Surface = 'tasks';
let tasksMode: TasksMode = 'elastic';
let timekeepingPanels: TimekeepingPanelVisibility = {
  calendar: true,
  timeline: false,
  countdowns: false,
};
/**
 * How wide the reader has dragged each Timekeeping panel, which is local state like the visibility above.
 *
 * It is deliberately **not** in the action snapshot beside `timekeepingPanels`: a width is disposable view
 * state rather than a fact about the session, and the pattern it follows - the Backlog's column widths - lives
 * here for the same reason. Nothing that holds a width can reach a store, so a resize cannot become a write.
 */
let timekeepingPanelWidths: Readonly<Record<string, number>> = {};
let selectedScheduleEventId: string | null = null;
let scheduleEventDraft: ScheduleEventDraft | null = null;
let selectedScheduleRecurringOccurrence: ScheduleRecurringOccurrenceSelection | null = null;
let selectedScheduleRecurringScope: ScheduleRecurrenceScope | null = null;
let scheduleMode: ScheduleMode = 'month';
let projectWorkspaceTab: ProjectWorkspaceTab = 'notes';
let projectsHubFilter: ProjectsHubFilter = 'active';
let projectCreateOpen = false;
/** What the New Project form's last save answered, drawn on the form rather than replacing it. */
let projectCreateRefusal: ProjectFormRefusal | null = null;
/** What the New Project form currently says, so a refused save does not empty it. */
let projectCreateDraft: ProjectCreateIntent | null = null;
/** The open project editor, null while it is closed. The draft is the form, not the record. */
let projectEditor: ProjectEditView | null = null;
/** The last refused Schedule write, drawn on the block it was about rather than in a banner. */
let scheduleWriteRefusal: { eventId: string; code: string } | null = null;
/** What the seeded form's last save answered, drawn on the form. */
let scheduleSeedRefusal: string | null = null;
/** The last Schedule write's own sentence. */
let scheduleWriteFeedback: string | null = null;
/** The refusal code that sentence belongs to, null when the last write was accepted. */
let scheduleWriteRefusalCode: string | null = null;
/** The Event editor's provisional values, so a refused save does not empty the form (D58). */
let scheduleEventEditorDraft: EventEditorDraft | null = null;
/** The scope modal's provisional dates, so a refused scope save does not empty it. */
let scheduleOccurrenceDraft: { startDate: string; deadline: string } | null = null;
/** The last refused Gantt date change, drawn on the bar it was about. */
let timelineWriteRefusal: { taskId: string; code: string } | null = null;
/** The last Gantt change's own sentence. */
let timelineWriteFeedback: string | null = null;
let projectTaskBoardView: ProjectTaskBoardViewState = EMPTY_PROJECT_TASK_BOARD_VIEW;
/** The workflow board's own state: it groups by stage, so it previews and refuses separately. */
let projectWorkflowBoardView: ProjectWorkflowBoardViewState = EMPTY_PROJECT_WORKFLOW_BOARD_VIEW;
let projectWorkflowRefusal: string | null = null;
/** The workflow board's stage form, the refusal a stage write produced, and what it did. */
let projectWorkflowStageForm: ProjectWorkflowBoardViewState['stageForm'] = null;
let projectWorkflowStageRefusal: string | null = null;
let projectWorkflowStageFeedback: string | null = null;
/** The acceptance-probe disclosure: closed on an ordinary boot, so the product leads. */
let acceptanceToolsView: AcceptanceToolsViewState = EMPTY_ACCEPTANCE_TOOLS_VIEW;
/** The lifecycle line the Projects Hub draws: an outcome's own words, or the refusal's. */
let projectLifecycleFeedback: string | null = null;
/** The refusal code that sentence belongs to, null when the last attempt was accepted. */
let projectLifecycleRefusalCode: string | null = null;
let projectBacklogView: ProjectBacklogViewState = EMPTY_PROJECT_BACKLOG_VIEW;
/**
 * The property-schema editor's view state, and the projection it draws.
 *
 * Separate from the Backlog's own state because the schema is not a fact about one project: the records are
 * global, and a reader who opens the panel while looking at one project should not lose it by switching. The
 * projection is loaded rather than derived, because it reads the canonical records for the revision and the
 * definition that `appState.taskSchema` does not carry.
 */
let propertySchemaPanelView: PropertySchemaPanelView = EMPTY_PROPERTY_SCHEMA_PANEL_VIEW;
let propertySchemaProjection = propertySchemaEditor([]);
let projectDeadlinesView: ProjectDeadlinesViewState = EMPTY_PROJECT_DEADLINES_VIEW;
let projectScheduleView: ProjectScheduleViewState = EMPTY_PROJECT_SCHEDULE_VIEW;
let projectNotesView: ProjectNotesViewState = EMPTY_PROJECT_NOTES_VIEW;
let projectNotesTreeRequestKey: string | null = null;
let projectNotesPreviewRequestKey: string | null = null;
let scheduleCursor = new Date(FIXED_CLOCK.now());
let calendarCursor = new Date(FIXED_CLOCK.now());
let elasticTargetTime = new Date(FIXED_CLOCK.now() + 4 * 60 * 60 * 1000).toISOString();
let elasticLockedAt: string | null = null;
let elasticSelectedTaskId: string | null = null;
/**
 * The Task editor's provisional edits. Null means nothing has been edited, which is what
 * Cancel restores and what makes `dirty` exact — the draft is never a rebuilt guess at
 * the record.
 */
let taskEditorDraft: TaskEditorDraft | null = null;
let elasticDropRefusal: string | null = null;
/** The browser's task-write operations once a record-store run has been cleared to write. */
let taskMutations: BrowserRecordMutations | null = null;
let taskMutationResolution: Promise<BrowserRecordMutations | null> | null = null;
/** Why there is no write path, in the shell's own words, for the refusal banner. */
let taskMutationUnavailable: string | null = null;
/** The last refusal the Task editor's Save or Delete produced, shown beside the form. */
let taskEditorRefusal: string | null = null;
/** The New Task form's provisional values while it is open, null while it is closed. */
let newTaskFormDraft: TaskEditorDraft | null = null;
let newTaskRefusal: string | null = null;
let elasticProgressTimer: number | null = null;
let actionDispatcher: ProximaActionDispatcher | null = null;
let sourceSession: SourceSession | null = null;
let startupInspection: StartupInspection | null = null;
let sourceProjection: ReadOnlyProjection | null = null;
let lastRefreshEvidence: Parameters<typeof evaluateRealVaultAcceptance>[0]['refreshEvidence'];
let lastRenameDeleteEvidence: Parameters<typeof evaluateRealVaultAcceptance>[0]['renameDeleteEvidence'];
let canvasState: CanvasSurfaceState = EMPTY_CANVAS_SURFACE;
let canvasView: CanvasSurfaceViewState = EMPTY_CANVAS_SURFACE_VIEW;
const canvasPreviewRegistry = createCanvasPreviewRegistry({ createObjectURL: (blob) => URL.createObjectURL(blob), revokeObjectURL: (url) => URL.revokeObjectURL(url) });
const canvasExcalidrawPreviewRegistry = createCanvasExcalidrawPreviewRegistry();
const canvasTextPreviewRegistry = createCanvasTextPreviewRegistry();
const canvasDropQueue = createCanvasDropQueue(DETERMINISTIC_IDS, EMPTY_CANVAS_SURFACE, canvasPreviewRegistry, canvasExcalidrawPreviewRegistry, canvasTextPreviewRegistry);

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Proxima boot element missing: ${selector}`);
  return found;
}

function setText(selector: string, text: string): void {
  const found = document.querySelector<HTMLElement>(selector);
  if (found) found.textContent = text;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function setBootState(state: BootState): void {
  const root = element<HTMLElement>('#proxima-app');
  applyBootState(root.dataset, state);
}

function projectName(state: ProximaState, projectId: string | null, lookup?: Map<string, string>): string {
  return projectLabel(lookup ?? createProjectNameLookup(state), projectId);
}

function selectionLabel(state: ProximaState, selected: string, lookup?: Map<string, string>): string {
  if (selected === ALL_PROJECTS) return 'All projects';
  if (selected === UNCATEGORISED) return 'Uncategorised';
  return projectName(state, selected, lookup);
}

function visibleProblems(problems: LoadProblem[]): LoadProblem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = [problem.code, problem.kind, problem.id ?? '', problem.path, problem.detail].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function surfaceSwitcher(): string {
  return renderCockpitNavigation({
    surface,
    tasksMode,
    scheduleMode,
    projectWorkspaceTab,
  });
}

function taskCard(state: ProximaState, task: Task, height?: number, deadlineState?: DeadlineState, lookup?: Map<string, string>): string {
  const deadline = task.deadline ? new Date(task.deadline).toLocaleDateString() : 'No deadline';
  const deadlineText = deadlineState === 'expired' ? `Overdue · ${deadline}` : deadline;
  const style = height === undefined ? '' : ` style="min-height:${Math.round(height)}px"`;
  return `<article class="task-card" data-c1-key="task-card-${escapeHtml(task.id)}"${style}><div class="task-card-top"><span class="task-status">${escapeHtml(task.status)}</span>${task.isCompleted ? '<span class="task-complete">Done</span>' : ''}</div><h3>${escapeHtml(task.name)}</h3><p>${escapeHtml(task.description || 'No description')}</p><footer><span>${escapeHtml(projectName(state, task.projectId, lookup))}</span><span${deadlineState === 'expired' ? ' class="task-overdue"' : ''}>${escapeHtml(deadlineText)}</span></footer></article>`;
}

function legacyBoardSurface(state: ProximaState, lookup: Map<string, string>): string {
  const taskProjectIds = new Set(projectsFor(state.projects, 'task').map((project) => project.id));
  const boardTasks = state.tasks.filter((task) => task.projectId === null || taskProjectIds.has(task.projectId));
  const selectedTasks = tasksForSelection(boardTasks, selection);
  const board = elasticBoard(selectedTasks, state.statuses);
  const presentation = boardElasticPresentation(board.running, new Date(FIXED_CLOCK.now()), 460);
  const columns: Array<{ id: 'backlog' | 'running' | 'finished'; label: string; tasks: Task[] }> = [{ id: 'backlog', label: 'Backlog', tasks: board.backlog }, { id: 'running', label: 'Running', tasks: board.running }, { id: 'finished', label: 'Finished', tasks: board.finished }];
  return `<section class="surface board-surface" data-c1-key="board-region" aria-label="Elastic board"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(selectionLabel(state, selection, lookup))}</p><h2>Elastic board</h2><p class="surface-description">Running work expands by time remaining; status determines the column.</p></div><span class="surface-count">${selectedTasks.length} tasks</span></header><div class="board-grid">${columns.map((column) => `<section class="board-column" data-c1-key="board-column-${column.id}" aria-label="${column.label} column"><header><h3>${column.label}</h3><span>${column.tasks.length}</span></header><div class="column-cards">${column.tasks.length === 0 ? `<p class="empty-state" data-c1-key="board-empty-${column.id}">No tasks here.</p>` : column.tasks.map((task) => taskCard(state, task, column.id === 'running' ? presentation.heights[task.id] : undefined, column.id === 'running' ? presentation.deadlineState[task.id] : undefined, lookup)).join('')}</div></section>`).join('')}</div></section>`;
}

function boardSurface(state: ProximaState, lookup: Map<string, string>): string {
  const taskProjectIds = new Set(projectsFor(state.projects, 'task').map((project) => project.id));
  const boardTasks = state.tasks.filter((task) => task.projectId === null || taskProjectIds.has(task.projectId));
  const selectedTasks = tasksForSelection(boardTasks, selection);
  const now = currentSourceMode() === 'external' ? new Date() : new Date(FIXED_CLOCK.now());

  return renderElasticCockpit({
    state,
    tasks: selectedTasks,
    projectNames: lookup,
    selectionLabel: selectionLabel(state, selection, lookup),
    session: {
      targetTime: elasticTargetTime,
      lockedAt: elasticLockedAt,
    },
    now,
    selectedTaskId: elasticSelectedTaskId,
    editorDraft: taskEditorDraft,
    dropRefusal: elasticDropRefusal,
    taskWrites: taskModalWriteView(),
    newTaskDraft: newTaskFormDraft,
    newTaskRefusal,
    containerHeight: 460,
  });
}

/**
 * What the Task editor may do about writing, as the shell currently understands it.
 *
 * A resolved write path means Save and Delete are real controls; anything else is the typed
 * reason they are not, which the modal renders where the buttons are. This is deliberately
 * derived from the same resolution a gesture uses, so the two cannot disagree about whether
 * this run can write.
 */
function taskModalWriteView(): { refusal: string | null; editorRefusal: string | null } {
  return {
    refusal: taskMutations === null
      ? taskMutationUnavailable ?? TASK_EDITOR_SAVE_REFUSAL
      : null,
    editorRefusal: taskEditorRefusal,
  };
}

function scheduleProjectionSurface(
  mode: ScheduleProjectionMode,
  state: ProximaState,
  problems: LoadProblem[],
  lookup: Map<string, string>,
): string {
  const scheduleEvents = scheduleEventsForSelection(
    state,
    selection,
  );
  const now = currentSourceMode() === 'external'
    ? new Date()
    : new Date(FIXED_CLOCK.now());

  return renderScheduleProjection({
    mode,
    events: scheduleEvents,
    projectNames: lookup,
    selectionLabel: selectionLabel(state, selection, lookup),
    calendarCursor: scheduleCursor,
    now,
    selectedEventId: selectedScheduleEventId,
    selectedRecurringOccurrence: selectedScheduleRecurringOccurrence,
    selectedRecurringScope: selectedScheduleRecurringScope,
    problems,
    eventEditorWrites: eventEditorWrites(),
    eventEditorDraft: scheduleEventEditorDraft,
    recurrenceScopeWrites: recurrenceScopeWrites(),
    occurrenceDraft: scheduleOccurrenceDraft,
  });
}

function timekeepingSurface(state: ProximaState, lookup: Map<string, string>): string {
  const selectedTasks = tasksForSelection(state.tasks, selection);
  const now = currentSourceMode() === 'external'
    ? new Date()
    : new Date(FIXED_CLOCK.now());

  return renderTimekeepingCockpit({
    state,
    tasks: selectedTasks,
    projectNames: lookup,
    selectionLabel: selectionLabel(state, selection, lookup),
    panels: timekeepingPanels,
    panelWidths: timekeepingPanelWidths,
    calendarCursor,
    now,
    selectedTaskId: elasticSelectedTaskId,
    editorDraft: taskEditorDraft,
    timelineWrites: timelineWriteRefusal,
    timelineFeedback: timelineWriteFeedback,
  });
}

function scheduleTimeGridSurface(
  mode: ScheduleTimeGridMode,
  state: ProximaState,
  lookup: Map<string, string>,
): string {
  const now = currentSourceMode() === 'external'
    ? new Date()
    : new Date(FIXED_CLOCK.now());
  const scheduleEvents = scheduleEventsForSelection(
    state,
    selection,
  );

  return renderScheduleTimeGrid({
    mode,
    events: scheduleEvents,
    projectNames: lookup,
    selectionLabel: selectionLabel(state, selection, lookup),
    calendarCursor: scheduleCursor,
    now,
    selectedEventId: selectedScheduleEventId,
    seededEvent: scheduleEventDraft,
    selectedRecurringOccurrence: selectedScheduleRecurringOccurrence,
    selectedRecurringScope: selectedScheduleRecurringScope,
    writeRefusal: scheduleWriteRefusal,
    writeFeedback: scheduleWriteFeedback,
    seedRefusal: scheduleSeedRefusal,
    eventEditorWrites: eventEditorWrites(),
    eventEditorDraft: scheduleEventEditorDraft,
    recurrenceScopeWrites: recurrenceScopeWrites(),
    occurrenceDraft: scheduleOccurrenceDraft,
  });
}

function projectNotesSourceGeneration(): number { return sourceSession?.snapshot().sourceGeneration ?? 0; }
function syncProjectNotesTree(state: ProximaState): void {
  if (surface !== 'projects' || projectWorkspaceTab !== 'notes') return;
  const project = state.projects.find((candidate) => candidate.id === selection);
  if (!project) return;
  const generation = projectNotesSourceGeneration();
  if (projectNotesView.projectId === project.id && projectNotesView.sourceGeneration === generation && projectNotesView.treeStatus !== 'idle') return;
  projectNotesPreviewRequestKey = null;
  if (project.linkedFolders.length === 0) { projectNotesTreeRequestKey = null; projectNotesView = { ...EMPTY_PROJECT_NOTES_VIEW, projectId: project.id, sourceGeneration: generation, treeStatus: 'ready', tree: { projectId: project.id, roots: [], fileCount: 0 } }; return; }
  const reader = sourceSession?.reader?.();
  if (!reader) { projectNotesTreeRequestKey = null; projectNotesView = { ...EMPTY_PROJECT_NOTES_VIEW, projectId: project.id, sourceGeneration: generation, treeStatus: 'unavailable' }; return; }
  const key = `${generation}:${project.id}`;
  if (projectNotesTreeRequestKey === key) return;
  projectNotesTreeRequestKey = key;
  projectNotesView = { ...EMPTY_PROJECT_NOTES_VIEW, projectId: project.id, sourceGeneration: generation, treeStatus: 'loading' };
  void loadProjectNotesTree(reader, project).then((tree) => { if (projectNotesTreeRequestKey !== key || selection !== project.id || projectNotesSourceGeneration() !== generation) return; projectNotesTreeRequestKey = null; projectNotesView = { ...EMPTY_PROJECT_NOTES_VIEW, projectId: project.id, sourceGeneration: generation, treeStatus: 'ready', tree, expandedPaths: tree.roots.filter((r) => r.status === 'ready').map((r) => r.path) }; render(); }).catch(() => { if (projectNotesTreeRequestKey !== key || selection !== project.id || projectNotesSourceGeneration() !== generation) return; projectNotesTreeRequestKey = null; projectNotesView = { ...EMPTY_PROJECT_NOTES_VIEW, projectId: project.id, sourceGeneration: generation, treeStatus: 'unavailable' }; render(); });
}
function selectProjectNote(path: string): void {
  const projectId = selection; const generation = projectNotesSourceGeneration();
  const knownFile = projectNotesView.tree?.roots.some((root) => root.entries.some((entry) => entry.kind === 'file' && entry.path === path)) ?? false; if (!knownFile) return;
  const reader = sourceSession?.reader?.(); projectNotesView = { ...projectNotesView, selectedPath: path, previewStatus: reader ? 'loading' : 'unavailable', preview: null, previewFailure: reader ? null : 'unreadable', contextPath: null, writeRefusal: null, lastRefusedMove: null }; render(); if (!reader) return;
  const key = `${generation}:${projectId}:${path}`; projectNotesPreviewRequestKey = key;
  void loadProjectNotePreview(reader, path).then((result) => { if (projectNotesPreviewRequestKey !== key || selection !== projectId || projectNotesSourceGeneration() !== generation || projectNotesView.selectedPath !== path) return; projectNotesPreviewRequestKey = null; projectNotesView = { ...projectNotesView, previewStatus: result.preview ? 'ready' : 'unavailable', preview: result.preview, previewFailure: result.failure }; render(); }).catch(() => { if (projectNotesPreviewRequestKey !== key || selection !== projectId || projectNotesSourceGeneration() !== generation || projectNotesView.selectedPath !== path) return; projectNotesPreviewRequestKey = null; projectNotesView = { ...projectNotesView, previewStatus: 'unavailable', preview: null, previewFailure: 'unreadable' }; render(); });
}
function projectsHubSurface(state: ProximaState): string {
  // A resolved write path is what makes the controls real; the reason there is none is drawn
  // beside them rather than swallowed.
  const lifecycleWrites = {
    refusal: taskMutations === null ? taskMutationUnavailable ?? TASK_EDITOR_SAVE_REFUSAL : null,
    feedback: projectLifecycleFeedback ?? (taskMutations === null ? null : PROJECT_LIFECYCLE_IDLE_FEEDBACK),
    feedbackRefusal: projectLifecycleRefusalCode,
  };
  const projectForms = {
    projectCreateRefusal,
    projectCreateDraft,
    projectEdit: projectEditor,
  };
  const now = currentSourceMode() === 'external' ? new Date() : new Date(FIXED_CLOCK.now());
  return renderProjectsHub({ state, selection, filter: projectsHubFilter, workspaceTab: projectWorkspaceTab, now, newProjectOpen: projectCreateOpen, projectNotes: projectNotesView, projectTaskBoard: projectTaskBoardView, projectWorkflowBoard: {
      ...projectWorkflowBoardView,
      writeRefusal: projectWorkflowRefusal,
      // The same resolution the drop path uses: a stage control is a record write, so it is real
      // exactly when this run can write, and otherwise carries the reason that it is not.
      stageWriteRefusal: taskMutations === null ? taskMutationUnavailable ?? TASK_EDITOR_SAVE_REFUSAL : null,
    }, projectBacklog: { ...projectBacklogView, schemaPanel: propertySchemaPanelView, schemaProjection: propertySchemaProjection, schemaWriteRefusal: taskMutations === null ? taskMutationUnavailable ?? TASK_EDITOR_SAVE_REFUSAL : null, bulkWriteRefusal: taskMutations === null ? taskMutationUnavailable ?? TASK_EDITOR_SAVE_REFUSAL : null }, projectDeadlines: projectDeadlinesView, projectSchedule: projectScheduleView, projectWrites: lifecycleWrites, ...projectForms });
}

function diagnosticsSurface(problems: LoadProblem[]): string {
  if (problems.length === 0) return `<section class="diagnostics clean" data-c1-key="diagnostics"><span class="diagnostic-ok">✓</span><span>No load or calendar problems.</span></section>`;
  return `<section class="diagnostics" data-c1-key="diagnostics" aria-label="Diagnostics"><header><strong>Diagnostics</strong><span>${problems.length}</span></header><ul>${problems.map((problem) => `<li data-c1-key="diagnostic-${escapeHtml(problem.code)}-${escapeHtml(problem.id ?? problem.path)}"><span class="severity ${problem.severity}">${escapeHtml(problem.severity)}</span><span><strong>${escapeHtml(problem.code)}</strong><small>${escapeHtml(problem.detail)}</small></span></li>`).join('')}</ul></section>`;
}

function currentUiHealth(): UiHealthModel {
  return createUiHealthModel(sourceProjection?.health);
}

function healthSurface(health: UiHealthModel): string {
  const label = health.status === 'healthy' ? 'Source current' : health.status === 'stale' ? 'Source stale' : 'Source degraded';
  return `<section class="refresh-health ${health.status}" data-c1-key="refresh-health" aria-label="Source refresh health" data-health-generation="${health.sourceRevision}"><strong>${label}</strong><span>Generation ${health.sourceRevision} · app ${health.applicationRevision}</span><span>Last successful ${health.lastSuccessfulRefreshRevision} · ${health.lastRefreshReason ?? 'initial'}</span>${health.problemCodes.length > 0 ? `<code>${escapeHtml(health.problemCodes.join(', '))}</code>` : ''}</section>`;
}

function updateHydrationSummary(state: ProximaState, problems: LoadProblem[]): void {
  setText('#hydration-summary', JSON.stringify({ mode: currentSourceMode(), fixture: currentSourceMode() === 'external' ? null : FIXTURE_NAME, hydrationRevision: currentSourceMode() === 'external' ? `external:${sourceProjection?.generation ?? 0}` : `fixture:${BUILD_IDENTITY.fixtureHash.slice(0, 16)}:1`, applicationStateRevision: actionDispatcher?.snapshot().stateRevision ?? 0, sourceHealth: currentUiHealth(), surface, selection, projects: state.projects.length, tasks: state.tasks.length, events: state.events.length, problems: problems.length, fixedClock: BUILD_IDENTITY.fixedClock, deterministicIds: true }, null, 2));
}

function exposeInspection(): void {
  if (!actionDispatcher) return;
  const inspection = createInspectionProjection(actionDispatcher.snapshot(), BUILD_IDENTITY, currentUiHealth());
  const session = sourceSession?.snapshot();
  const report = evaluateRealVaultAcceptance({
    build: BUILD_IDENTITY,
    startup: startupInspection ?? { startupSourceMode: 'fixture', restoredHandlePresent: false, bootstrapStatus: 'no-restored-handle' },
    session: { sourceMode: session?.sourceMode ?? 'fixture', sourceGeneration: session?.sourceGeneration ?? sourceProjection?.generation ?? 1, transitionState: session?.transitionState ?? 'stable' },
    projection: sourceProjection ?? { generation: 1, state: actionDispatcher.snapshot().state, health: currentUiHealth(), revisions: actionDispatcher.snapshot().revisions, problems: actionDispatcher.snapshot().problems },
    inspection,
    refreshEvidence: lastRefreshEvidence,
    renameDeleteEvidence: lastRenameDeleteEvidence,
    writeInvariant: { writesAttempted: 0, writerMethodsCalled: [] },
  });
  const runbook = evaluateRealVaultRunbook({ report, expectedBuildSha: BUILD_IDENTITY.gitSha });
  const preflight = evaluateCreatorVaultPreflight({ acceptance: report, runbook, coexistence: coexistenceReadiness(), expectedBuildSha: BUILD_IDENTITY.gitSha });
  const target = globalThis as typeof globalThis & { __PROXIMA_INSPECTION__?: () => typeof inspection; __PROXIMA_REAL_VAULT_ACCEPTANCE__?: (report: unknown) => void; __PROXIMA_CREATOR_VAULT_PREFLIGHT__?: (report: unknown) => void; __PROXIMA_DECLARE_COEXISTENCE__?: (evidence: unknown) => void };
  target.__PROXIMA_INSPECTION__ = () => createInspectionProjection(actionDispatcher!.snapshot(), BUILD_IDENTITY, currentUiHealth());
  target.__PROXIMA_REAL_VAULT_ACCEPTANCE__ = (report) => { if (isRealVaultAcceptanceReport(report)) renderRealVaultAcceptance(report); };
  target.__PROXIMA_CREATOR_VAULT_PREFLIGHT__ = (report) => { if (isCreatorVaultPreflightReport(report)) renderCreatorVaultPreflight(report); };
  // An acceptance run declares observed Gate 6M evidence here; the surface never
  // infers it. Absent a declaration the preflight stays BLOCKED, which is true.
  target.__PROXIMA_DECLARE_COEXISTENCE__ = (evidence) => {
    if (!evidence || typeof evidence !== 'object') return;
    declareCoexistenceReadiness(evidence as Record<string, boolean>);
    exposeInspection();
  };
  const root = element<HTMLElement>('#proxima-app');
  root.dataset.proximaStateRevision = String(inspection.applicationStateRevision);
  root.dataset.proximaHealthGeneration = String(inspection.sourceHealth.sourceRevision);
  renderRealVaultAcceptance(report);
  renderCreatorVaultPreflight(preflight);
}

function renderFsaProbe(report: unknown): void {
  setText('#fsa-probe-status', JSON.stringify(report, null, 2));
  setText('#fsa-acceptance-status', JSON.stringify(evaluateCleanProfileAcceptance(report, {
    proximaVersion: BUILD_IDENTITY.proximaVersion,
    gitSha: BUILD_IDENTITY.gitSha,
    buildMode: BUILD_IDENTITY.buildMode,
    fixtureHash: BUILD_IDENTITY.fixtureHash,
  }), null, 2));
}

function renderRealVaultAcceptance(report: RealVaultAcceptanceReport): void {
  if (isRealVaultAcceptanceReport(report)) setText('#real-vault-acceptance-status', JSON.stringify(report, null, 2));
}

function renderCreatorVaultPreflight(report: CreatorVaultPreflightReport): void {
  if (isCreatorVaultPreflightReport(report)) setText('#creator-vault-preflight-status', JSON.stringify(report, null, 2));
}

async function runFsaProbe(): Promise<void> {
  try { renderFsaProbe(await pickAndProbeDirectory()); }
  catch (error) { renderFsaProbe({ error: error instanceof Error ? error.message : String(error) }); }
}

function syncElasticProgressTimer(): void {
  const shouldTick = shouldTickElasticProgress(
    currentSourceMode(),
    surface,
    tasksMode,
    elasticLockedAt,
  );

  if (shouldTick && elasticProgressTimer === null) {
    elasticProgressTimer = window.setInterval(() => render(), 1_000);
  } else if (!shouldTick && elasticProgressTimer !== null) {
    window.clearInterval(elasticProgressTimer);
    elasticProgressTimer = null;
  }
}

function render(): void {
  if (!appState) return;
  const currentState = appState;
  syncProjectNotesTree(currentState);
  const root = element<HTMLElement>('#proxima-app');
  const problems = visibleProblems([...loadProblems]);
  root.dataset.proximaSurface = surface;
  root.dataset.proximaSubmode = cockpitSubmode({ surface, tasksMode, scheduleMode, projectWorkspaceTab }) ?? 'none';
  root.dataset.proximaSelection = selection;
  const health = currentUiHealth();
  const projectNames = createProjectNameLookup(appState);
  root.dataset.proximaHealthGeneration = String(health.sourceRevision);
  const sourceMode = sourceSession?.snapshot().sourceMode ?? 'fixture';
  const sourceLabel = sourceLabelFor(sourceMode);
  // HARD GATE C item 6: the product stops calling itself read-only exactly when it can write, and
  // the claim is derived from the same resolution the writes use so the two cannot drift apart.
  const writesAvailable = taskMutations !== null;
  const workspaceIdentity = workspaceIdentityFor(sourceMode, writesAvailable);
  const surfaceMarkup = renderWithBoundary(() => {
    if (surface === 'tasks') {
      return tasksMode === 'elastic'
        ? boardSurface(currentState, projectNames)
        : timekeepingSurface(currentState, projectNames);
    }
    if (surface === 'schedule') {
      if (
        scheduleMode === 'month'
        || scheduleMode === 'year'
        || scheduleMode === 'agenda'
      ) {
        return scheduleProjectionSurface(
          scheduleMode,
          currentState,
          problems,
          projectNames,
        );
      }
      return scheduleTimeGridSurface(
        scheduleMode,
        currentState,
        projectNames,
      );
    }
    if (surface === 'projects') {
      return projectsHubSurface(currentState);
    }
    return renderCanvasSurface(
      canvasState,
      canvasPreviewRegistry.snapshot(),
      canvasExcalidrawPreviewRegistry.snapshot(),
      canvasTextPreviewRegistry.snapshot(),
      canvasView,
    );
  });
  if (surfaceMarkup.failure) root.dataset.proximaRendererFailure = surfaceMarkup.failure.code;
  else delete root.dataset.proximaRendererFailure;
  root.innerHTML = `<div class="app-shell" data-c1-key="app-root"><header class="app-header"><div class="brand"><span class="brand-mark">P</span><div><h1>Proxima</h1><span data-c1-key="workspace-identity" data-workspace-writes="${workspaceWritesFor(sourceMode, writesAvailable)}">${escapeHtml(workspaceIdentity)}</span></div></div><div class="header-state"><span class="read-only-badge">${sourceLabel}</span><span class="hydrated-badge" data-c1-key="hydration-state">Hydrated</span><button type="button" data-action="source-refresh" data-c1-key="source-refresh-button">Refresh source</button>${renderAcceptanceTools(acceptanceToolsView)}</div></header>${healthSurface(health)}<div class="app-layout">${renderProjectNavigation(appState, selection)}<main class="main-content">${surfaceSwitcher()}${surfaceMarkup.markup}${diagnosticsSurface(problems)}</main></div><footer class="app-footer" data-c1-key="app-footer"><span>Fixed clock ${escapeHtml(BUILD_IDENTITY.fixedClock)}</span><span>Build ${escapeHtml(BUILD_IDENTITY.gitSha.slice(0, 8))}</span></footer><details class="build-details"><summary>Build identity and hydration evidence</summary><pre id="build-identity">${escapeHtml(JSON.stringify(BUILD_IDENTITY, null, 2))}</pre><pre id="hydration-summary"></pre><pre id="fsa-probe-status">Not run</pre><pre id="fsa-acceptance-status">Not run</pre><pre id="real-vault-acceptance-status">Not run</pre><pre id="creator-vault-preflight-status" data-c1-key="creator-vault-preflight-status">Not run</pre></details></div>`;
  syncElasticProgressTimer();
  updateHydrationSummary(appState, problems);
  exposeInspection();
}

function dispatchAction(input: unknown): ActionResult | null {
  if (!actionDispatcher) return null;
  const result = actionDispatcher.dispatch(input);
  if (result.ok) {
    const next = actionDispatcher.snapshot();
    selection = next.selection;
    surface = next.surface;
    tasksMode = next.tasksMode;
    timekeepingPanels = { ...next.timekeepingPanels };
    scheduleMode = next.scheduleMode;
    scheduleCursor = new Date(`${next.scheduleDate}T00:00:00`);
    projectWorkspaceTab = next.projectWorkspaceTab;
    calendarCursor = new Date(`${next.calendarMonth}T00:00:00`);
    elasticTargetTime = next.elasticTargetTime;
    elasticLockedAt = next.elasticLockedAt;
    if (canvasView.selectedNodeId !== next.canvasSelectedNodeId) {
      canvasView = {
        ...EMPTY_CANVAS_SURFACE_VIEW,
        selectedNodeId: next.canvasSelectedNodeId,
      };
    }
    render();
  } else {
    setText('#boot-status', `Action failed: ${result.error.code}`);
  }
  return result;
}

/**
 * What this page is actually reading.
 *
 * The summary used to report `mode: fixture` unconditionally, so a page serving the
 * creator's real vault described itself as bundled fixture bytes. That is exactly
 * the machine-readable field an agent would trust to decide whether it is looking at
 * disposable data, and it was wrong in the one direction that matters.
 */
function currentSourceMode(): 'fixture' | 'external' {
  return sourceSession?.snapshot().sourceMode === 'external' ? 'external' : 'fixture';
}

function applyProjection(next: ReadOnlyProjection, mode: SourceMode, result?: RefreshResult): void {
  const previous = sourceProjection;
  if (result) {
    lastRefreshEvidence = refreshEvidenceFromProjections(previous, next, result);
    lastRenameDeleteEvidence = renameDeleteEvidenceFromProjections(previous, next, result.outcome) ?? lastRenameDeleteEvidence;
  }
  if (actionDispatcher) {
    const applied = actionDispatcher.replaceSource({ state: next.state, problems: next.problems, revisions: next.revisions, sourceRevision: next.generation });
    sourceProjection = { ...next, health: { ...next.health, applicationRevision: applied.stateRevision } };
    appState = sourceProjection.state;
    loadProblems = sourceProjection.problems;
  } else {
    sourceProjection = next;
    appState = next.state;
    loadProblems = next.problems;
  }
  if (actionDispatcher) {
    const session = sourceSession?.snapshot();
    const root = element<HTMLElement>('#proxima-app');
    root.dataset.proximaSourceMode = mode;
    root.dataset.proximaSourceGeneration = String(session?.sourceGeneration ?? next.generation);
  }
  render();
}

async function refreshFromSource(
  reason: RefreshReason,
): Promise<RefreshResult | null> {
  return await sourceSession?.refresh(reason) ?? null;
}

/**
 * The browser's task-write operations, resolved on first use.
 *
 * The shell receives *operations*, never storage: the record backend, the recovery journal and
 * Stage 7's recovery gate are composed behind the adapter, and this call returns either the
 * four callables or a typed reason there are none. A run whose records are still legacy
 * Markdown has no record write path at all — the honest answer is a refusal that names why,
 * not a gesture that appears to work and reverts on the next read.
 */
async function resolveTaskWritePath(): Promise<BrowserRecordMutations | null> {
  if (taskMutations !== null) return taskMutations;

  if (taskMutationResolution === null) {
    taskMutationResolution = (async () => {
      if (sourceSession?.snapshot().sourceMode !== 'record-store') {
        taskMutationUnavailable = 'record-writes-need-an-activated-store';
        return null;
      }
      const resolved = await resolveBrowserTaskMutations({
        // The same clock rule the dispatcher follows: a deterministic run stays deterministic,
        // and only a live external source gets wall time. A record store reached by an
        // acceptance run is deterministic on purpose.
        clock: sourceSession?.snapshot().sourceMode === 'external' ? systemClock : FIXED_CLOCK,
      });
      if (!resolved.ok) {
        taskMutationUnavailable = resolved.reason;
        return null;
      }
      taskMutations = resolved.mutations;
      taskMutationUnavailable = null;
      return taskMutations;
    })();
  }

  const resolved = await taskMutationResolution;
  // A refusal is not cached: a page that activates a store later in its life must not be held
  // to the answer it would have given before.
  if (resolved === null) taskMutationResolution = null;
  return resolved;
}

/**
 * Re-read the canonical schema records and project them for the panel.
 *
 * Called after every schema write and once at startup, for the same reason every other write in this tree is
 * followed by a re-read: the panel should draw what the store holds rather than what this session believes it
 * asked for. A run that cannot resolve a write path leaves the projection as it was, because there is nothing
 * to have changed.
 */
async function reloadPropertySchemaProjection(): Promise<void> {
  const writes = await resolveTaskWritePath();
  if (writes === null) return;
  propertySchemaProjection = propertySchemaEditor(await writes.readPropertySchemaRecords());
}

/**
 * Run one schema submission and draw what came back.
 *
 * The submission goes to `submitPropertySchemaAction`, which is the same entry the agent wire uses - so a
 * refusal a person sees here is the refusal an agent gets for the same submission, because there is one parser
 * and one set of sentences. Nothing in this function decides anything about the schema: it hands over a
 * submission and prints the answer.
 */
async function submitSchemaSubmission(submission: unknown): Promise<boolean> {
  const writes = await resolveTaskWritePath();
  if (writes === null) {
    propertySchemaPanelView = { ...propertySchemaPanelView, refusal: taskMutationUnavailable ?? 'record-writes-need-an-activated-store', feedback: null };
    render();
    return false;
  }

  const outcome = await submitPropertySchemaAction(
    {
      writes: async () => writes,
      unavailableReason: () => taskMutationUnavailable,
      ids: DETERMINISTIC_IDS,
      // The dispatcher's sink is the shell's one journal, so a schema write leaves its event in the same ring as
      // every other action rather than in a private one this file would have to keep in step.
      audit: { append: (event: SemanticAuditEvent) => { actionDispatcher?.auditSemantic(event); } },
    },
    submission,
  );

  if (!outcome.ok) {
    propertySchemaPanelView = { ...propertySchemaPanelView, refusal: outcome.detail, feedback: null };
    render();
    return false;
  }

  await reloadPropertySchemaProjection();
  propertySchemaPanelView = { ...propertySchemaPanelView, refusal: null, feedback: `saved ${outcome.actionType}` };
  render();
  return true;
}

/**
 * The create form's Save: the schema, then one option verb per label.
 *
 * Sequenced rather than batched, because a canonical option carries an id the record layer allocates and the
 * option verb is what allocates it - so the labels cannot travel with the create, and each write creates the
 * revision the next one must name. A run that stops after the create therefore leaves a select with no options
 * rather than a broken schema, which is the honest half-way state.
 */
async function createSchemaFromPanel(): Promise<void> {
  const form: PropertySchemaCreateForm = {
    name: propertySchemaPanelView.createName,
    type: propertySchemaPanelView.createType,
    options: propertySchemaPanelView.createOptions,
  };
  const submission = schemaCreateSubmission(form);
  if (submission === null) {
    propertySchemaPanelView = { ...propertySchemaPanelView, refusal: `${form.type} is not a type this form can create`, feedback: null };
    render();
    return;
  }

  const writes = await resolveTaskWritePath();
  if (writes === null) {
    propertySchemaPanelView = { ...propertySchemaPanelView, refusal: taskMutationUnavailable ?? 'record-writes-need-an-activated-store', feedback: null };
    render();
    return;
  }

  const created = await submitPropertySchemaAction(
    { writes: async () => writes, unavailableReason: () => taskMutationUnavailable, ids: DETERMINISTIC_IDS, audit: { append: (event: SemanticAuditEvent) => { actionDispatcher?.auditSemantic(event); } } },
    submission,
  );
  if (!created.ok) {
    propertySchemaPanelView = { ...propertySchemaPanelView, refusal: created.detail, feedback: null };
    render();
    return;
  }

  // Each label at the revision the previous write returned, read out of the outcome rather than assumed.
  let revision = created.revision;
  for (const optionSubmission of schemaCreateOptionSubmissions(form, created.recordId, created.revision)) {
    const added = await submitPropertySchemaAction(
      { writes: async () => writes, unavailableReason: () => taskMutationUnavailable, ids: DETERMINISTIC_IDS, audit: { append: (event: SemanticAuditEvent) => { actionDispatcher?.auditSemantic(event); } } },
      { ...(optionSubmission as Record<string, unknown>), expectedRevision: revision },
    );
    if (!added.ok) {
      propertySchemaPanelView = { ...propertySchemaPanelView, refusal: added.detail, feedback: null };
      await reloadPropertySchemaProjection();
      render();
      return;
    }
    revision = added.revision;
  }

  await reloadPropertySchemaProjection();
  propertySchemaPanelView = { ...propertySchemaPanelView, refusal: null, feedback: `created ${form.name}`, createName: '', createOptions: '' };
  render();
}

/**
 * The card editor's Save and Delete.
 *
 * Both sequences live in `src/app/taskEditorWrite.ts`, where tests execute them against a real
 * store; the shell supplies where the operations come from, what to say when this run has none,
 * and the two sinks a render needs. A successful save clears the draft, because the record now
 * *is* what the form says — Cancel and Save both stop being offered, which is the honest state
 * after a write rather than a form still claiming unsaved changes.
 */
function taskEditorWriteDependencies() {
  return {
    state: appState,
    writes: resolveTaskWritePath,
    unavailableReason: () => taskMutationUnavailable,
    refresh: refreshFromSource,
    setRefusal: (reason: string | null) => { taskEditorRefusal = reason; },
    render,
    // The same envelope and sink every applicable write gets: the action mints the id, and the event goes
    // into the one ring the surfaces are inspected through, with the dispatcher's real state revision.
    ids: DETERMINISTIC_IDS,
    audit: {
      append: (event: SemanticAuditEvent) => {
        actionDispatcher?.auditSemantic(event);
      },
    },
  };
}

async function saveTaskFromEditorAction(): Promise<void> {
  const effect = await saveTaskAction(taskEditorWriteDependencies(), {
    taskId: elasticSelectedTaskId,
    draft: taskEditorDraft,
  });
  if (effect.clearDraft) {
    taskEditorDraft = null;
    render();
  }
}

async function deleteTaskFromEditorAction(): Promise<void> {
  const effect = await deleteTaskAction(taskEditorWriteDependencies(), { taskId: elasticSelectedTaskId });
  if (effect.closeEditor) {
    elasticSelectedTaskId = null;
    taskEditorDraft = null;
    render();
  }
}

/**
 * The New Task form's Save.
 *
 * The sequence lives in `src/app/taskCreate.ts`; the shell supplies the same pieces it supplies the
 * editor, plus the selection the form's project defaults from. An accepted create closes the form,
 * because the task it described now exists and the board is about to draw it.
 */
function taskCreateDependencies() {
  return {
    state: appState,
    writes: resolveTaskWritePath,
    unavailableReason: () => taskMutationUnavailable,
    refresh: refreshFromSource,
    setRefusal: (reason: string | null) => { newTaskRefusal = reason; },
    render,
    // The semantic envelope and the audit sink every applicable write owes. The id is minted by the action
    // from this generator, and the sink journals into the one ring the surfaces are inspected through, so a
    // semantic event carries the dispatcher's real state revision rather than one the record layer invented.
    ids: DETERMINISTIC_IDS,
    audit: {
      append: (event: SemanticAuditEvent) => {
        actionDispatcher?.auditSemantic(event);
      },
    },
  };
}

/**
 * A Backlog bulk action over the marked selection.
 *
 * The report is the view state: the entities are drawn where the selection is, so a reader sees
 * which rows changed and which refused rather than only how many. An accepted run also clears the
 * selection, because the rows it referred to are no longer the same rows.
 */
async function runBacklogBulk(action: 'task.bulk.complete' | 'task.bulk.delete'): Promise<void> {
  const taskIds = [...projectBacklogView.selectedTaskIds];
  // One envelope per run, whatever the selection holds: a bulk action is one semantic operation, and the
  // event it leaves carries every id that landed rather than one event per member.
  const bulkDependencies = () => ({
    state: appState,
    writes: resolveTaskWritePath,
    unavailableReason: () => taskMutationUnavailable,
    refresh: refreshFromSource,
    render,
    ids: DETERMINISTIC_IDS,
    audit: {
      append: (event: SemanticAuditEvent) => {
        actionDispatcher?.auditSemantic(event);
      },
    },
  });
  const report: BulkTaskActionReport = action === 'task.bulk.delete'
    ? await bulkDeleteTasks(bulkDependencies(), { taskIds })
    : await bulkCompleteTasks(bulkDependencies(), { taskIds });

  projectBacklogView = {
    ...projectBacklogView,
    bulkReport: report,
    // A run that wrote nothing leaves the selection alone: the reader's marks still mean something.
    selectedTaskIds: report.accepted > 0 ? [] : projectBacklogView.selectedTaskIds,
  };
  render();
}

/**
 * The composer's Execute, bound where a test can reach the listener.
 *
 * The binding itself lives in `src/browser/templateExecuteBinding.ts`, because the AUTHOR ruled on
 * 2026-09-12 that a claim about this chain has to be a claim about a running listener: the shell composes on
 * import, so no test can import it, and reading this file as text proves only that a string is present.
 * What the shell keeps is what the shell owns - where the text comes from, the two states a run passes
 * through, and the source refresh a write owes afterwards.
 */
function bindTemplateExecute(root: HTMLElement): void {
  bindTemplateExecuteInteractions(root, {
    template: () => projectBacklogView.templateText,
    action: taskCreateDependencies,
    begin: () => {
      projectBacklogView = { ...projectBacklogView, templateExecuting: true, templateResult: null };
    },
    finish: (result) => {
      projectBacklogView = { ...projectBacklogView, templateExecuting: false, templateResult: result };
    },
    afterRun: async () => {
      await executeSourceRefreshAction({
        dispatch: (input) => dispatchAction(input),
        refresh: refreshFromSource,
      });
    },
  });
}

async function createTaskFromFormAction(): Promise<void> {
  const effect = await createTaskAction(taskCreateDependencies(), { draft: newTaskFormDraft });
  if (effect.closeEditor) {
    newTaskFormDraft = null;
    render();
  }
}

/**
 * An Elastic drop.
 *
 * The sequence itself lives in `src/app/elasticDropAction.ts`, where it is executed by tests
 * against a real store; what stays here is the shell's half — where the write operations come
 * from, what to say when this run has none, and the two sinks a render needs.
 */
async function moveTaskFromDrop(
  taskId: string,
  targetColumn: ElasticColumn,
  targetIndex: number,
): Promise<void> {
  await performElasticDrop(
    {
      state: appState,
      writes: resolveTaskWritePath,
      unavailableReason: () => taskMutationUnavailable,
      refresh: refreshFromSource,
      setRefusal: (reason) => { elasticDropRefusal = reason; },
      render,
      // The drop mints the run's id and hands it to the gesture, so a drop refused before the gesture is
      // reached is journalled with the same id an accepted one would have carried.
      ids: DETERMINISTIC_IDS,
      audit: {
        append: (event: SemanticAuditEvent) => {
          actionDispatcher?.auditSemantic(event);
        },
      },
    },
    { taskId, targetColumn, targetIndex },
  );
}

/**
 * A dropped card on the project workflow board.
 *
 * The sequence lives in `src/app/workflowBoardDrop.ts`; the shell supplies the same pieces it
 * supplies a drop on the Elastic board, and the refusal it draws is this board's own — the two
 * boards report their own drops because they are two dimensions, and one banner for both would say
 * something happened somewhere.
 */
async function moveTaskFromWorkflowDrop(intent: { taskId: string; targetStageId: string | null; targetIndex: number }): Promise<void> {
  const outcome = await performWorkflowDrop(
    {
      state: appState,
      writes: resolveTaskWritePath,
      unavailableReason: () => taskMutationUnavailable,
      refresh: refreshFromSource,
      setRefusal: (reason) => { projectWorkflowRefusal = reason; },
      render,
    },
    intent,
  );
  projectWorkflowBoardView = {
    ...projectWorkflowBoardView,
    projectId: selection,
    dragTaskId: null,
    dragTargetStageId: null,
    dragTargetIndex: null,
    writeRefusal: outcome.ok ? null : outcome.reason,
    lastRefusedMove: outcome.ok ? null : { ...intent },
  };
  render();
}

/**
 * The workflow board's stage controls.
 *
 * The sequences live in `src/app/workflowStageWriteActions.ts`, where tests execute them against a
 * real store; the shell supplies the resolved operations, what to say when this run has none, and
 * the two sinks the board draws. An accepted write closes the form, because the stage it described
 * now is what the board is about to draw.
 *
 * Delete is offered on the same terms as Rename. A stage that still holds cards is answered by the
 * operation with the count and the question — `semantic-conflict`, naming how many cards would be
 * affected — rather than this shell quietly deciding to empty someone's workflow. A caller that has
 * decided passes `remapTo`; the board's own button does not decide for the reader.
 */
function workflowStageWriteDependencies() {
  return {
    state: appState,
    writes: resolveTaskWritePath,
    unavailableReason: () => taskMutationUnavailable,
    refresh: refreshFromSource,
    setRefusal: (reason: string | null) => { projectWorkflowStageRefusal = reason; },
    setFeedback: (message: string | null) => { projectWorkflowStageFeedback = message; },
    render,
    // One envelope for the three stage verbs: the run journals the stage and every card a delete moved.
    ids: DETERMINISTIC_IDS,
    audit: {
      append: (event: SemanticAuditEvent) => {
        actionDispatcher?.auditSemantic(event);
      },
    },
  };
}

async function saveWorkflowStageFormAction(): Promise<void> {
  const form = projectWorkflowStageForm;
  if (form === null || form === undefined) return;
  const outcome: WorkflowStageWriteOutcome = form.kind === 'create'
    ? await createWorkflowStageAction(workflowStageWriteDependencies(), { projectId: selection, name: form.name })
    : await renameWorkflowStageAction(workflowStageWriteDependencies(), { stageId: form.stageId, name: form.name });
  if (outcome.ok) {
    projectWorkflowStageForm = null;
    render();
  }
}

/** Delete a stage at the revision the board was rendering; a full stage answers with its question. */
async function deleteWorkflowStageFromBoardAction(stageId: string): Promise<void> {
  await deleteWorkflowStageAction(workflowStageWriteDependencies(), { stageId });
}
/**
 * The Projects Hub's lifecycle controls.
 *
 * Archive, Restore and Delete all reach the same sequence in `src/app/projectLifecycleActions.ts`,
 * where tests execute it against a real store; the shell supplies the resolved record operations,
 * what to say when this run has none, and the sink the feedback line is drawn from.
 *
 * Delete is offered on exactly the same terms as the other two. While the deletion policy is
 * undecided its operation answers `policy-not-decided` — with the member counts it would affect —
 * and that answer is what the reader gets, because it is a question a reader can answer. A disabled
 * button would say the feature is missing, which is not what is true.
 */
function projectLifecycleDependencies() {
  return {
    state: appState,
    writes: resolveTaskWritePath,
    unavailableReason: () => taskMutationUnavailable,
    refresh: refreshFromSource,
    setRefusal: (reason: string | null) => { projectLifecycleFeedback = reason; projectLifecycleRefusalCode = reason; },
    render,
    // One envelope for all five lifecycle verbs, because they all run through one sequence - including the
    // delete whose policy refusal is a real answer rather than a missing feature.
    ids: DETERMINISTIC_IDS,
    audit: {
      append: (event: SemanticAuditEvent) => {
        actionDispatcher?.auditSemantic(event);
      },
    },
  };
}

/** One place where an outcome becomes the sentence the hub draws beside its controls. */
function recordLifecycleOutcome(outcome: ProjectLifecycleOutcome): void {
  projectLifecycleFeedback = projectLifecycleSentence(outcome);
  projectLifecycleRefusalCode = outcome.ok ? null : outcome.reason;
}

function projectLifecycleSentence(outcome: ProjectLifecycleOutcome): string {
  if (outcome.ok) return `${outcome.outcome} at revision ${outcome.revision}`;
  return `${outcome.reason}: ${outcome.detail}`;
}

async function runProjectLifecycle(kind: 'archive' | 'restore' | 'delete', projectId: string): Promise<void> {
  const dependencies = projectLifecycleDependencies();
  const outcome = kind === 'archive'
    ? await archiveProjectAction(dependencies, { projectId })
    : kind === 'restore'
      ? await restoreProjectAction(dependencies, { projectId })
      : await deleteProjectAction(dependencies, { projectId });
  // The operation's own sentence replaces the progress line, and stays until the next attempt.
  recordLifecycleOutcome(outcome);
  render();
}

/**
 * The New Project form's Save.
 *
 * The sequence is `src/app/projectLifecycleActions.ts`; the shell supplies the resolved record
 * operations, what to say when this run has none, and the sink the form's refusal is drawn from. An
 * accepted create closes the form, because the project it described now exists and the hub is about
 * to draw it; a refused one keeps the form open with the reader's values still in it.
 */
async function createProjectFromFormAction(intent: ProjectCreateIntent): Promise<void> {
  // The draft is held before the write, so a refusal leaves the reader's words where they were.
  projectCreateDraft = { ...intent };
  const outcome = await createProjectAction(projectLifecycleDependencies(), intent);
  recordLifecycleOutcome(outcome);
  if (outcome.ok) { projectCreateOpen = false; projectCreateDraft = null; }
  else projectCreateRefusal = { code: outcome.reason, sentence: projectLifecycleSentence(outcome) };
  render();
}

/**
 * The project editor's Save.
 *
 * The mutations are planned from the record and the draft (`src/app/projectEditor.ts`), so only the
 * fields that actually changed are submitted, and a save with nothing changed is answered by the
 * operation rather than written as a record that says the same thing. An accepted save closes the
 * editor: the record now says what the form said, so a form still offering unsaved changes would be
 * describing a state that no longer exists.
 */
async function saveProjectEditAction(projectId: string, draft: ProjectEditorDraft): Promise<void> {
  const project = appState?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    projectEditor = null;
    render();
    return;
  }

  const outcome = await updateProjectAction(projectLifecycleDependencies(), {
    projectId,
    mutations: planProjectFieldMutations(project, draft),
  });
  recordLifecycleOutcome(outcome);
  projectEditor = outcome.ok
    ? null
    : { projectId, draft, refusal: { code: outcome.reason, sentence: projectLifecycleSentence(outcome) } };
  render();
}

/**
 * The Schedule's write sequences.
 *
 * A drag or a resize is one of two verbs — `event.reschedule` when the block moved, `event.resize`
 * when its bottom edge did — and the seeded form's Save is `event.create`. All three run in
 * `src/app/eventWriteActions.ts`; the shell supplies the resolved operations, the reason there are
 * none when this run has no record path, and the two sinks the surfaces draw.
 *
 * The refusal is kept *per event* because a schedule draws the same event in several columns: a
 * refusal that belonged to no block would leave a reader looking for which one moved.
 */
function eventWriteDependencies() {
  return {
    // A **live** state rather than the snapshot this call started with. One Save can be two writes - the fields
    // through `event.update` and the rule through its own series verb - and the second one has to read the
    // revision the first one left. The session hands this shell the re-read projection through `onProjection` as
    // each write converges, so this getter answers with what the store now holds rather than with what it held
    // when the sequence began. A page that never re-projects refuses the second write as a lost race, which is
    // the safe direction for this to fail in.
    get state() { return appState; },
    writes: resolveTaskWritePath,
    unavailableReason: () => taskMutationUnavailable,
    refresh: refreshFromSource,
    setRefusal: (reason: string | null) => { scheduleWriteFeedback = reason; },
    render,
    // One envelope for all five event verbs, because they all run through one sequence: the id is minted by
    // that sequence, and the event lands in the ring the surfaces are inspected through.
    ids: DETERMINISTIC_IDS,
    audit: {
      append: (event: SemanticAuditEvent) => {
        actionDispatcher?.auditSemantic(event);
      },
    },
  };
}

function eventWriteSentence(outcome: EventWriteOutcome): string {
  return outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
}

/**
 * What a Save says, including what happened to the rule.
 *
 * A reader who changed both halves is owed both sentences, and a rule that was set or cleared is a fact about
 * the record rather than a detail of the field write.
 */
function eventFormSaveSentence(outcome: EventFormSaveOutcome): string {
  if (!outcome.ok) return `${outcome.reason}: ${outcome.detail}`;
  const rule = outcome.recurrence === 'unchanged' ? '' : `, recurrence ${outcome.recurrence}`;
  return `${outcome.outcome}${rule} at revision ${outcome.revision}`;
}

/**
 * Recurrence-series ids, from the same counter the record ids come from.
 *
 * The domain mints a series id from sixteen bytes, so this hands it sixteen bytes: the sequence number in the
 * first four and nothing in the rest. Deterministic on purpose — an acceptance run compares evidence bundles,
 * and a random id in every bundle would make them differ for no reason — and unique because the counter is.
 */
const SERIES_IDS = (() => {
  let serial = 0;
  return {
    next: () => {
      serial += 1;
      const bytes = new Uint8Array(16);
      bytes[0] = (serial >>> 24) & 0xff;
      bytes[1] = (serial >>> 16) & 0xff;
      bytes[2] = (serial >>> 8) & 0xff;
      bytes[3] = serial & 0xff;
      return opaqueRecurrenceSeriesIdFromRandomBytes(bytes);
    },
  };
})();

async function createEventFromSeed(intent: ScheduleEventCreateIntent): Promise<void> {
  const outcome = await createEventAction(eventWriteDependencies(), {
    values: {
      name: intent.name,
      description: intent.description,
      projectId: intent.projectId,
      startDate: intent.startDate,
      deadline: intent.deadline,
      isCompleted: false,
      // A seeded form creates a plain event: recurrence is something the editor offers once the record exists.
      recurrence: { kind: 'none' },
    },
  });
  scheduleSeedRefusal = outcome.ok ? null : outcome.reason;
  scheduleWriteFeedback = eventWriteSentence(outcome);
  // An accepted create closes the form: the event it described now exists, and the grid is about to
  // draw it. A refused one keeps the form, with the reader's values still in it.
  if (outcome.ok) scheduleEventDraft = null;
  render();
}

async function changeEventFromGesture(intent: ScheduleEventChangeIntent): Promise<void> {
  const outcome = intent.operation === 'resize-end'
    ? await resizeEventAction(eventWriteDependencies(), {
        eventId: intent.eventId,
        target: { kind: 'end', value: intent.proposedDeadline },
      })
    : await rescheduleEventAction(eventWriteDependencies(), {
        eventId: intent.eventId,
        startDate: intent.proposedStartDate,
      });
  scheduleWriteRefusal = outcome.ok ? null : { eventId: intent.eventId, code: outcome.reason };
  scheduleWriteFeedback = eventWriteSentence(outcome);
  render();
}

/**
 * The Event editor's Save and Delete.
 *
 * The same two sequences the gesture path uses for its own verbs, and the same rule about the form:
 * the mutations are planned from the record and what was typed, so only what changed is submitted,
 * and a refusal leaves the form open with the reader's values still in it (D58). An accepted save or
 * delete closes the editor, because the record now says what the form said.
 */
async function saveEventFromEditor(intent: { eventId: string; values: EventFormValues }): Promise<void> {
  const outcome = await saveEventFormAction(eventWriteDependencies(), {
    eventId: intent.eventId,
    values: intent.values,
    // A series id is minted only when the event had no series, and it is minted here because identity is
    // injected like every other id in this tree: sixteen bytes with this run's own sequence number in the
    // first four, so a deterministic run stays deterministic and two series cannot collide.
    allocateSeriesId: () => SERIES_IDS.next(),
  });
  scheduleWriteFeedback = eventFormSaveSentence(outcome);
  scheduleWriteRefusalCode = outcome.ok ? null : outcome.reason;
  if (outcome.ok) {
    selectedScheduleEventId = null;
    scheduleEventEditorDraft = null;
  } else {
    // The draft is the form's own values, which is what makes the next render show them again.
    scheduleEventEditorDraft = eventEditorDraftFromValues(intent.eventId, intent.values);
  }
  render();
}

async function deleteEventFromEditor(eventId: string): Promise<void> {
  const outcome = await deleteEventAction(eventWriteDependencies(), { eventId });
  scheduleWriteFeedback = eventWriteSentence(outcome);
  scheduleWriteRefusalCode = outcome.ok ? null : outcome.reason;
  if (outcome.ok) {
    selectedScheduleEventId = null;
    scheduleEventEditorDraft = null;
  }
  render();
}

/** The form's values as a draft: the record with what was typed over it, which is what D58 asks for. */
function eventEditorDraftFromValues(eventId: string, values: EventFormValues): EventEditorDraft | null {
  const event = appState?.events.find((candidate) => candidate.id === eventId);
  if (event === undefined) return null;
  return eventEditorDraftFor(
    {
      ...event,
      name: values.name,
      description: values.description,
      projectId: values.projectId,
      startDate: values.startDate,
      deadline: values.deadline,
      isCompleted: values.isCompleted,
    },
    eventRecurrenceForView(event),
  );
}

/** The recurrence the editor shows for an event, which the draft has to carry with its values. */
function eventRecurrenceForView(event: ProximaState['events'][number]) {
  return eventRecurrenceFor(event);
}

/** What the Event editor draws: the write path, the last answer, and the form's draft. */
function eventEditorWrites(): { refusal: string | null; feedback: string | null; feedbackRefusal: string | null } {
  return {
    refusal: taskMutations === null ? taskMutationUnavailable ?? TASK_EDITOR_SAVE_REFUSAL : null,
    feedback: scheduleWriteFeedback,
    feedbackRefusal: scheduleWriteRefusalCode,
  };
}

/**
 * The recurrence scope modal's two writes.
 *
 * They live in `scheduleScopeWiring.ts` because the modal is the one surface whose *shell* half is
 * more than a re-render: an accepted write closes the modal and clears the occurrence, a refused one
 * leaves it open with the reader's dates and the operation's own sentence. Keeping that here would
 * have made `main.ts` carry a second copy of the same shape.
 */
function recurrenceScopeWrites(): { refusal: string | null; feedback: string | null; feedbackRefusal: string | null } {
  return {
    refusal: taskMutations === null ? taskMutationUnavailable ?? TASK_EDITOR_SAVE_REFUSAL : null,
    feedback: scheduleWriteFeedback,
    feedbackRefusal: scheduleWriteRefusalCode,
  };
}

/**
 * What a scope write owes the shell afterwards.
 *
 * An accepted write closes the modal and clears the occurrence it was about — the occurrence has
 * moved or gone, so leaving the reader pointing at the old instant would be a lie about the record. A
 * refused one keeps both, with the dates that were typed, so the reader can fix them (D58).
 */
function closeScopeOnAcceptance(accepted: boolean, form: { startDate: string; deadline: string } | null): void {
  if (accepted) {
    selectedScheduleRecurringOccurrence = null;
    selectedScheduleRecurringScope = null;
    scheduleOccurrenceDraft = null;
  } else {
    scheduleOccurrenceDraft = form;
  }
  render();
}

/**
 * A Gantt bar drag or edge resize, released.
 *
 * The gesture hands over the two dates the bar would draw and the row it landed in; the sequence in
 * `src/app/timelineChangeAction.ts` decides whether they are a span, submits them as one `dates`
 * mutation at the revision the bar was drawn from, and reports that the row was *not* written —
 * Gantt row placement is local state (A3), so a scoped row movement cannot reorder the Elastic board.
 */
async function changeTaskDatesFromGantt(intent: {
  taskId: string;
  operation: 'move' | 'resize-start' | 'resize-end';
  proposedStartDate: string | null;
  proposedDeadline: string | null;
  targetRowIndex: number;
}): Promise<void> {
  const outcome = await changeTaskDatesAction(
    {
      state: appState,
      writes: resolveTaskWritePath,
      unavailableReason: () => taskMutationUnavailable,
      refresh: refreshFromSource,
      setRefusal: (reason) => { timelineWriteFeedback = reason; },
      render,
    },
    intent,
  );
  timelineWriteRefusal = outcome.ok ? null : { taskId: intent.taskId, code: outcome.reason };
  timelineWriteFeedback = outcome.ok
    ? `dates written at revision ${outcome.revision}`
    : `${outcome.reason}: ${outcome.detail}`;
  render();
}

function bindInteractions(): void {
  const root = element<HTMLElement>('#proxima-app');
  if (root.dataset.interactionsBound === 'true') return;
  root.dataset.interactionsBound = 'true';
  bindCanvasSurfaceInteractions(root, {
    openNode: (nodeId) => {
      dispatchAction({ type: 'canvas.node.select', nodeId });
    },
    closeNode: () => {
      dispatchAction({ type: 'canvas.node.select', nodeId: null });
    },
    refuseGeometry: (intent) => {
      const selected = dispatchAction({
        type: 'canvas.node.select',
        nodeId: intent.nodeId,
      });
      if (!selected?.ok) return;

      const result = dispatchAction({
        type: 'canvas.node.geometry.change',
        nodeId: intent.nodeId,
        operation: intent.kind,
        proposedX: intent.proposed.x,
        proposedY: intent.proposed.y,
        proposedWidth: intent.proposed.width,
        proposedHeight: intent.proposed.height,
      });
      if (!result || result.ok || result.error.code !== CANVAS_SURFACE_WRITE_REFUSAL) return;
      canvasView = {
        ...EMPTY_CANVAS_SURFACE_VIEW,
        selectedNodeId: intent.nodeId,
        writeRefusal: CANVAS_SURFACE_WRITE_REFUSAL,
        lastRefusedGeometry: {
          nodeId: intent.nodeId,
          kind: intent.kind,
          proposed: { ...intent.proposed },
        },
      };
      render();
    },
    requestRemove: (nodeId) => {
      if (!canvasState.items.some((item) => item.node.id === nodeId)) return;
      canvasView = {
        ...EMPTY_CANVAS_SURFACE_VIEW,
        selectedNodeId: nodeId,
        removeCandidateNodeId: nodeId,
      };
      render();
    },
    cancelRemove: () => {
      const selectedNodeId =
        canvasView.selectedNodeId !== null
        && canvasState.items.some(
          (item) => item.node.id === canvasView.selectedNodeId,
        )
          ? canvasView.selectedNodeId
          : null;
      canvasView = {
        ...EMPTY_CANVAS_SURFACE_VIEW,
        selectedNodeId,
      };
      render();
    },
    refuseRemove: (nodeId) => {
      const result = dispatchAction({ type: 'canvas.node.remove', nodeId });
      if (!result || result.ok || result.error.code !== CANVAS_SURFACE_WRITE_REFUSAL) return;
      canvasView = {
        ...EMPTY_CANVAS_SURFACE_VIEW,
        selectedNodeId: nodeId,
        writeRefusal: CANVAS_SURFACE_WRITE_REFUSAL,
        lastRefusedRemovalNodeId: nodeId,
      };
      render();
    },
  });

  bindElasticCockpitInteractions(root, {
    openTask: (taskId) => {
      elasticSelectedTaskId = taskId;
      taskEditorDraft = null;
      taskEditorRefusal = null;
      render();
    },
    closeTask: () => {
      elasticSelectedTaskId = null;
      taskEditorDraft = null;
      taskEditorRefusal = null;
      render();
    },
    editTask: (edit) => {
      const task = appState?.tasks.find((candidate) => candidate.id === elasticSelectedTaskId);
      if (!task) return;
      // No render: a keystroke must not be able to take the field away from the reader.
      // The draft is what the next render, Cancel and Save all read.
      taskEditorDraft = applyTaskEditorEdit(taskEditorDraft ?? taskEditorDraftFor(task), edit);
      taskEditorRefusal = null;
    },
    cancelTaskEdit: () => {
      taskEditorDraft = null;
      taskEditorRefusal = null;
      render();
    },
    saveTask: () => {
      void saveTaskFromEditorAction();
    },
    deleteTask: () => {
      void deleteTaskFromEditorAction();
    },
    openNewTask: () => {
      // The form starts from where the reader is: a real project selection becomes the default
      // project, and a selection that is not a project defaults to no project rather than guessing.
      if (appState === null) return;
      newTaskFormDraft = newTaskDraftFor(appState, selection);
      newTaskRefusal = null;
      render();
    },
    cancelNewTask: () => {
      newTaskFormDraft = null;
      newTaskRefusal = null;
      render();
    },
    editNewTask: (edit) => {
      if (newTaskFormDraft === null) return;
      // No render, for the same reason the editor's keystrokes do not render: the field a person is
      // typing into must not be taken away from them mid-word.
      newTaskFormDraft = applyTaskEditorEdit(newTaskFormDraft, edit);
      newTaskRefusal = null;
    },
    createTask: () => {
      void createTaskFromFormAction();
    },
    setTarget: (targetTime) => {
      elasticDropRefusal = null;
      dispatchAction({ type: 'elastic.target.set', targetTime });
    },
    lock: () => {
      elasticDropRefusal = null;
      dispatchAction({ type: 'elastic.lock' });
    },
    unlock: () => {
      elasticDropRefusal = null;
      dispatchAction({ type: 'elastic.unlock' });
    },
    moveTask: ({ taskId, targetColumn, targetIndex }) => {
      void moveTaskFromDrop(taskId, targetColumn, targetIndex);
    },
  });

  bindProjectsHubInteractions(root, {
    setFilter: (filter) => { projectsHubFilter = filter; render(); },
    openProject: (projectId) => { dispatchAction({ type: 'project.select', projectId }); },
    showHub: () => { dispatchAction({ type: 'project.select', projectId: ALL_PROJECTS }); },
    openNewProject: () => { projectCreateOpen = true; projectCreateRefusal = null; projectCreateDraft = { name: '', description: '' }; render(); },
    closeNewProject: () => { projectCreateOpen = false; projectCreateRefusal = null; projectCreateDraft = null; render(); },
    createProject: ({ name, description }) => { void createProjectFromFormAction({ name, description }); },
    openProjectEditor: (projectId) => {
      const project = appState?.projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) return;
      projectEditor = { projectId, draft: projectEditorDraftFor(project), refusal: null };
      render();
    },
    closeProjectEditor: () => { projectEditor = null; render(); },
    saveProjectEdit: ({ projectId, name, description }) => { void saveProjectEditAction(projectId, { name, description }); },
    archiveProject: (projectId) => { void runProjectLifecycle('archive', projectId); },
    restoreProject: (projectId) => { void runProjectLifecycle('restore', projectId); },
    deleteProject: (projectId) => { void runProjectLifecycle('delete', projectId); },
  });
  bindProjectTaskBoardInteractions(root, {
    openTask: (taskId) => { const task = appState?.tasks.find((candidate) => candidate.id === taskId && candidate.projectId === selection); if (!task) return; projectTaskBoardView = { ...EMPTY_PROJECT_TASK_BOARD_VIEW, projectId: selection, selectedTaskId: taskId }; render(); },
    closeTask: () => { projectTaskBoardView = { ...projectTaskBoardView, selectedTaskId: null }; render(); },
    startDrag: (taskId) => { projectTaskBoardView = { ...projectTaskBoardView, projectId: selection, dragTaskId: taskId, dragTargetStatus: null, dragTargetIndex: null, writeRefusal: null, lastRefusedMove: null }; },
    previewMove: ({ taskId, targetStatus, targetIndex }) => { projectTaskBoardView = { ...projectTaskBoardView, projectId: selection, dragTaskId: taskId, dragTargetStatus: targetStatus, dragTargetIndex: targetIndex }; },
    refuseMove: (intent) => { projectTaskBoardView = { ...projectTaskBoardView, projectId: selection, dragTaskId: null, dragTargetStatus: null, dragTargetIndex: null, writeRefusal: PROJECT_TASK_BOARD_WRITE_REFUSAL, lastRefusedMove: { ...intent } }; render(); },
    clearDrag: () => { projectTaskBoardView = { ...projectTaskBoardView, dragTaskId: null, dragTargetStatus: null, dragTargetIndex: null }; },
  });
  bindProjectWorkflowBoardInteractions(root, {
    openTask: (taskId) => { const task = appState?.tasks.find((candidate) => candidate.id === taskId && candidate.projectId === selection); if (!task) return; projectWorkflowBoardView = { ...EMPTY_PROJECT_WORKFLOW_BOARD_VIEW, projectId: selection, selectedTaskId: taskId }; render(); },
    closeTask: () => { projectWorkflowBoardView = { ...projectWorkflowBoardView, selectedTaskId: null }; render(); },
    startDrag: (taskId) => { projectWorkflowBoardView = { ...projectWorkflowBoardView, projectId: selection, dragTaskId: taskId, dragTargetStageId: null, dragTargetIndex: null, writeRefusal: null, lastRefusedMove: null }; },
    previewMove: ({ taskId, targetStageId, targetIndex }) => { projectWorkflowBoardView = { ...projectWorkflowBoardView, projectId: selection, dragTaskId: taskId, dragTargetStageId: targetStageId ?? NO_WORKFLOW_STAGE, dragTargetIndex: targetIndex }; },
    dropMove: (intent) => { void moveTaskFromWorkflowDrop(intent); },
    clearDrag: () => { projectWorkflowBoardView = { ...projectWorkflowBoardView, dragTaskId: null, dragTargetStageId: null, dragTargetIndex: null }; },
    // A stage control carries the same meaning as the drop: a record write. The form's value lives
    // here rather than in the DOM, so what Save submits is what the reader typed.
    openStageForm: (form) => {
      if (form.kind === 'create') {
        projectWorkflowStageForm = { kind: 'create', name: '' };
      } else {
        const stage = (appState?.workflowStages ?? []).find((candidate) => candidate.id === form.stageId);
        if (stage === undefined) return;
        projectWorkflowStageForm = { kind: 'rename', stageId: form.stageId, name: stage.name };
      }
      projectWorkflowStageRefusal = null;
      projectWorkflowStageFeedback = null;
      projectWorkflowBoardView = { ...projectWorkflowBoardView, projectId: selection };
      render();
    },
    editStageName: (value) => {
      const form = projectWorkflowStageForm;
      if (form === null || form === undefined) return;
      projectWorkflowStageForm = { ...form, name: value };
      render();
      const field = root.querySelector<HTMLInputElement>('[data-project-workflow-stage-name]');
      if (field === null) return;
      field.focus();
      field.setSelectionRange(value.length, value.length);
    },
    saveStageForm: () => { void saveWorkflowStageFormAction(); },
    deleteStage: (stageId) => { void deleteWorkflowStageFromBoardAction(stageId); },
    closeStageForm: () => { projectWorkflowStageForm = null; projectWorkflowStageRefusal = null; render(); },
  });
  const restoreBacklogSearchFocus = (caret: number) => { const field = root.querySelector<HTMLInputElement>('[data-project-backlog-search-input]'); if (!field) return; field.focus(); field.setSelectionRange(caret, caret); };
  // The schema panel's own binding, beside the Backlog's because that is the surface it is drawn in. It is
  // bound from the shell rather than from the Backlog's handler table so that the panel's four verbs stay in
  // one place a reader can find: a write to a schema is not a Backlog gesture, it only happens to be drawn
  // there.
  bindPropertySchemaPanelInteractions(
    root,
    propertySchemaProjection,
    () => propertySchemaPanelView,
    {
      toggle: () => { propertySchemaPanelView = { ...propertySchemaPanelView, open: !propertySchemaPanelView.open, refusal: null, feedback: null }; render(); },
      setCreateName: (value) => { propertySchemaPanelView = { ...propertySchemaPanelView, createName: value }; },
      setCreateType: (value) => { propertySchemaPanelView = { ...propertySchemaPanelView, createType: value }; },
      setCreateOptions: (value) => { propertySchemaPanelView = { ...propertySchemaPanelView, createOptions: value }; },
      setRowName: (schemaId, value) => { propertySchemaPanelView = { ...propertySchemaPanelView, rowNames: { ...propertySchemaPanelView.rowNames, [schemaId]: value } }; },
      setRowOptionLabel: (schemaId, value) => { propertySchemaPanelView = { ...propertySchemaPanelView, rowOptionLabels: { ...propertySchemaPanelView.rowOptionLabels, [schemaId]: value } }; },
      create: () => { void createSchemaFromPanel(); },
      rename: ({ schemaId, name }) => {
        // The revision comes from the projection the panel was drawn from, never from the form: a revision a
        // caller typed is not a revision it read, which is the whole rule the field exists for.
        const row = propertySchemaProjection.rows.find((candidate) => candidate.schemaId === schemaId);
        if (row === undefined) return;
        void submitSchemaSubmission(schemaRenameSubmission({ schemaId, revision: row.revision, name }));
      },
      addOption: ({ schemaId, label }) => {
        const row = propertySchemaProjection.rows.find((candidate) => candidate.schemaId === schemaId);
        if (row === undefined) return;
        void submitSchemaSubmission(schemaAddOptionSubmission({ schemaId, revision: row.revision, label }));
      },
      remove: (schemaId) => {
        const row = propertySchemaProjection.rows.find((candidate) => candidate.schemaId === schemaId);
        if (row === undefined) return;
        void submitSchemaSubmission(schemaDeleteSubmission(schemaId, row.revision));
      },
    },
  );

  bindProjectBacklogInteractions(root, {
    // A row click opens that task in the Backlog's Task editor, which starts with no draft:
    // the record is what the form shows until something is typed.
    openTask: (taskId) => { const task = appState?.tasks.find((candidate) => candidate.id === taskId && candidate.projectId === selection); if (!task) return; projectBacklogView = { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: selection, selectedTaskId: taskId, editorDraft: null }; render(); },
    closeTask: () => { projectBacklogView = { ...projectBacklogView, selectedTaskId: null, editorDraft: null }; render(); },
    startDrag: (taskId) => { projectBacklogView = { ...projectBacklogView, projectId: selection, dragTaskId: taskId, dragTargetIndex: null, writeRefusal: null, lastRefusedMove: null }; },
    previewMove: ({ taskId, targetIndex }) => { projectBacklogView = { ...projectBacklogView, projectId: selection, dragTaskId: taskId, dragTargetIndex: targetIndex }; },
    refuseMove: (intent) => { projectBacklogView = { ...projectBacklogView, projectId: selection, dragTaskId: null, dragTargetIndex: null, writeRefusal: PROJECT_BACKLOG_WRITE_REFUSAL, lastRefusedMove: { ...intent } }; render(); },
    clearDrag: () => { projectBacklogView = { ...projectBacklogView, dragTaskId: null, dragTargetIndex: null }; },
    bulkComplete: () => { void runBacklogBulk('task.bulk.complete'); },
    bulkDelete: () => { void runBacklogBulk('task.bulk.delete'); },
    setSearch: (search) => { projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: null, query: applyBacklogControl(projectBacklogView.query, { kind: 'set-search', search }) }; render(); restoreBacklogSearchFocus(search.length); },
    // One menu, two builders: an expression beginning `property.` names a custom property, and
    // the type it is compared as comes from the schema — the same lookup the menu used to
    // offer it, so the menu and the filter cannot disagree about what a property holds.
    addFilter: (expression, value) => {
      if (expression.startsWith('property.')) {
        const key = expression.slice('property.'.length, expression.indexOf('|') === -1 ? undefined : expression.indexOf('|'));
        const built = buildBacklogPropertyFilter(projectBacklogView.query.propertyFilters, expression, value, propertyValueTypeFor(appState?.taskSchema ?? [], key), projectBacklogView.query.filters);
        if (!built.ok) { projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: built.reason }; render(); return; }
        projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: null, query: applyBacklogControl(projectBacklogView.query, { kind: 'add-property-filter', filter: built.filter }) };
        render();
        return;
      }
      const built = buildBacklogFilter(projectBacklogView.query.filters, expression, value, projectBacklogView.query.propertyFilters);
      if (!built.ok) { projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: built.reason }; render(); return; }
      projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: null, query: applyBacklogControl(projectBacklogView.query, { kind: 'add-filter', filter: built.filter }) };
      render();
    },
    removeFilter: (filterId) => { projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: null, query: applyBacklogControl(projectBacklogView.query, { kind: 'remove-filter', filterId }) }; render(); },
    sortBy: (field) => { projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: null, query: applyBacklogControl(projectBacklogView.query, { kind: 'sort-by', field }) }; render(); },
    clearSort: () => { projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: null, query: applyBacklogControl(projectBacklogView.query, { kind: 'clear-sort' }) }; render(); },
    clearQuery: () => { projectBacklogView = { ...projectBacklogView, projectId: selection, queryRefusal: null, query: applyBacklogControl(projectBacklogView.query, { kind: 'clear-query' }) }; render(); },
    // Selection is view state: it marks tasks for a bulk action that cannot run yet, and it
    // never touches a record. "Select all" means the rows the query leaves visible, and the
    // projection reports any marked task the query hides rather than letting it be forgotten.
    toggleSelection: (taskId) => { projectBacklogView = { ...projectBacklogView, projectId: selection, selectedTaskIds: toggleBacklogSelection(projectBacklogView.selectedTaskIds, taskId) }; render(); },
    selectAllVisible: (visibleTaskIds) => { projectBacklogView = { ...projectBacklogView, projectId: selection, selectedTaskIds: selectAllBacklogVisible(projectBacklogView.selectedTaskIds, visibleTaskIds) }; render(); },
    clearSelection: () => { projectBacklogView = { ...projectBacklogView, projectId: selection, selectedTaskIds: clearBacklogSelection(projectBacklogView.selectedTaskIds) }; render(); },
    // The template composer is the Backlog's: a template plans tasks for the project being
    // looked at, and the panel parses on render rather than keeping a second copy of what
    // the text means. Typing re-renders (so the preview and the error list follow the text),
    // which is why the caret is put back afterwards.
    openTemplate: () => { projectBacklogView = { ...projectBacklogView, projectId: selection, templateOpen: true }; render(); },
    closeTemplate: () => { projectBacklogView = { ...projectBacklogView, projectId: selection, templateOpen: false }; render(); },
    // A column width is how this reader is looking at the table, not what the table means: it never leaves view state.
    resizeColumn: (columnId, width) => { projectBacklogView = { ...projectBacklogView, projectId: selection, columnWidths: resizeBacklogColumn(projectBacklogView.columnWidths, columnId, width) }; render(); },
    // The Backlog's own Task editor draft, drawn from the same projection the board's modal
    // draws. An edit does not re-render, so a keystroke cannot take the field away from the
    // reader; Cancel restores the record by discarding the draft, which is `null` again.
    editTask: (edit) => { const task = appState?.tasks.find((candidate) => candidate.id === projectBacklogView.selectedTaskId); if (!task) return; projectBacklogView = { ...projectBacklogView, editorDraft: applyTaskEditorEdit(projectBacklogView.editorDraft ?? taskEditorDraftFor(task), edit) }; },
    cancelTaskEdit: () => { projectBacklogView = { ...projectBacklogView, editorDraft: null }; render(); },
    setTemplateText: (text) => { projectBacklogView = { ...projectBacklogView, projectId: selection, templateText: text }; render(); const field = root.querySelector<HTMLTextAreaElement>('[data-template-text]'); if (field) { field.focus(); field.setSelectionRange(text.length, text.length); } },
  });
  bindProjectDeadlinesInteractions(root, {
    setFilter: (filter) => { projectDeadlinesView = { ...projectDeadlinesView, projectId: selection, filter, selectedTaskId: null }; render(); },
    openTask: (taskId) => { if (!appState?.tasks.some((task) => task.id === taskId && task.projectId === selection)) return; projectDeadlinesView = { ...projectDeadlinesView, projectId: selection, selectedTaskId: taskId }; render(); },
    closeTask: () => { projectDeadlinesView = { ...projectDeadlinesView, selectedTaskId: null }; render(); },
  });
  bindProjectScheduleInteractions(root, {
    setFilter: (filter) => { projectScheduleView = { ...projectScheduleView, projectId: selection, filter, selectedEventId: null }; render(); },
    openEvent: (eventId) => { if (!appState?.events.some((event) => event.id === eventId && event.projectId === selection)) return; projectScheduleView = { ...projectScheduleView, projectId: selection, selectedEventId: eventId }; render(); },
    closeEvent: () => { projectScheduleView = { ...projectScheduleView, selectedEventId: null }; render(); },
  });
  bindProjectNotesInteractions(root, {
    toggleFolder: (path) => { const expanded = new Set(projectNotesView.expandedPaths); if (expanded.has(path)) expanded.delete(path); else expanded.add(path); projectNotesView = { ...projectNotesView, expandedPaths: [...expanded].sort() }; render(); },
    selectFile: (path) => { selectProjectNote(path); },
    openContext: (path) => { projectNotesView = { ...projectNotesView, contextPath: path }; render(); },
    closeContext: () => { projectNotesView = { ...projectNotesView, contextPath: null }; render(); },
    startDrag: (path) => { projectNotesView = { ...projectNotesView, dragSourcePath: path, dragTargetPath: null, writeRefusal: null, lastRefusedMove: null }; },
    previewDrag: (sourcePath, targetPath) => { projectNotesView = { ...projectNotesView, dragSourcePath: sourcePath, dragTargetPath: targetPath }; },
    refuseDrop: (sourcePath, targetPath) => { projectNotesView = { ...projectNotesView, dragSourcePath: null, dragTargetPath: null, writeRefusal: PROJECT_NOTE_WRITE_REFUSAL, lastRefusedMove: { sourcePath, targetPath } }; render(); },
    clearDrag: () => { projectNotesView = { ...projectNotesView, dragSourcePath: null, dragTargetPath: null }; },
  });
  bindScheduleRecurrenceInteractions(root, {
    openOccurrence: (occurrence) => {
      selectedScheduleEventId = null;
      scheduleEventDraft = null;
      selectedScheduleRecurringOccurrence = { ...occurrence };
      selectedScheduleRecurringScope = null;
      render();
    },
    closeOccurrence: () => {
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      render();
    },
    selectScope: (scope) => {
      selectedScheduleRecurringScope = scope;
      scheduleOccurrenceDraft = null;
      render();
    },
    saveOccurrence: ({ eventId, occurrenceStart, scope, startDate, deadline }) => {
      void (async () => {
        const outcome = await updateOccurrenceFromScope({
          eventId,
          occurrenceStart,
          scope,
          change: { kind: 'reschedule', startDate, deadline },
          deps: eventWriteDependencies(),
        });
        closeScopeOnAcceptance(outcome.ok, { startDate, deadline });
      })();
    },
    skipOccurrence: ({ eventId, occurrenceStart }) => {
      void (async () => {
        const outcome = await skipOccurrenceFromScope({ eventId, occurrenceStart, deps: eventWriteDependencies() });
        closeScopeOnAcceptance(outcome.ok, null);
      })();
    },
  });
  bindScheduleProjectionInteractions(root, {
    openEvent: (eventId) => {
      scheduleEventDraft = null;
      // The editor starts from the record: the draft is what has been typed since, and nothing has.
      scheduleEventEditorDraft = null;
      scheduleWriteFeedback = null;
      scheduleWriteRefusalCode = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      selectedScheduleEventId = eventId;
      render();
    },
    closeEvent: () => {
      selectedScheduleEventId = null;
      scheduleEventDraft = null;
      scheduleEventEditorDraft = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      render();
    },
    saveEvent: ({ eventId, values }) => { void saveEventFromEditor({ eventId, values }); },
    deleteEvent: ({ eventId }) => { void deleteEventFromEditor(eventId); },
    selectMonth: (month) => {
      dispatchAction({
        type: 'schedule.cursor.set',
        date: month,
      });
    },
    drillMonth: (month) => {
      const selected = dispatchAction({
        type: 'schedule.cursor.set',
        date: month,
      });
      if (selected?.ok) {
        dispatchAction({
          type: 'schedule.mode.select',
          mode: 'month',
        });
      }
    },
  });
  bindScheduleTimeGridInteractions(root, {
    openEvent: (eventId) => {
      scheduleEventDraft = null;
      scheduleEventEditorDraft = null;
      scheduleWriteFeedback = null;
      scheduleWriteRefusalCode = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      selectedScheduleEventId = eventId;
      render();
    },
    closeEvent: () => {
      selectedScheduleEventId = null;
      scheduleEventDraft = null;
      scheduleEventEditorDraft = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      render();
    },
    saveEvent: ({ eventId, values }) => { void saveEventFromEditor({ eventId, values }); },
    deleteEvent: ({ eventId }) => { void deleteEventFromEditor(eventId); },
    seedEvent: (draft) => {
      selectedScheduleEventId = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      scheduleEventDraft = { ...draft };
      render();
    },
    createEvent: ({ name, projectId, description, startDate, deadline }) => {
      void createEventFromSeed({ name, projectId, description, startDate, deadline });
    },
    changeEvent: ({ eventId, operation, proposedStartDate, proposedDeadline }) => {
      void changeEventFromGesture({ eventId, operation, proposedStartDate, proposedDeadline });
    },
  });

  bindTemplateExecute(root);

  bindTimekeepingCockpitInteractions(root, {
    openTask: (taskId) => {
      elasticSelectedTaskId = taskId;
      taskEditorDraft = null;
      render();
    },
    setPanelVisible: (panel, visible) => {
      dispatchAction({
        type: 'timekeeping.panel.set-visible',
        panel,
        visible,
      });
    },
    resizePanel: (panel, width) => {
      // No dispatch: a width is not an action, and there is no record and no snapshot field for it to reach.
      // The clamp lives in the app layer beside the Backlog's, so the value held here is always inside it.
      timekeepingPanelWidths = resizeTimekeepingPanel(timekeepingPanelWidths, panel, width);
      render();
    },
    navigateMonth: (direction) => {
      dispatchAction({
        type: 'calendar.navigate',
        direction,
      });
    },
    today: () => {
      dispatchAction({ type: 'calendar.today' });
    },
    changeTask: ({ taskId, operation, proposedStartDate, proposedDeadline, targetRowIndex }) => {
      void changeTaskDatesFromGantt({ taskId, operation, proposedStartDate, proposedDeadline, targetRowIndex });
    },
  });

  startTimekeepingCountdownTicker(root, () => {
    render();
  });

  startScheduleTimeTicker(
    root,
    () => currentSourceMode() === 'external',
    () => {
      render();
    },
  );
  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!button || !appState) return;
    const action = button.dataset.action;
    if (action === 'acceptance-tools') {
      acceptanceToolsView = acceptanceToolsAfterToggle(acceptanceToolsView);
      render();
    } else if (action === 'fsa-probe') {
      void runFsaProbe();
    } else if (action === 'fsa-reread') {
      void rereadSelectedDirectory().then((report) => renderFsaProbe(report ?? { error: 'No selected directory handle' }));
    } else if (action === 'switch-surface') {
      const next = button.dataset.surface as Surface;
      if (next !== 'tasks' && next !== 'schedule' && next !== 'projects' && next !== 'canvas') return;
      dispatchAction({ type: 'surface.select', surface: next });
    } else if (action === 'select-tasks-mode') {
      const mode = button.dataset.tasksMode as TasksMode;
      if (mode !== 'elastic' && mode !== 'timekeeping') return;
      dispatchAction({ type: 'tasks.mode.select', mode });
    } else if (action === 'select-schedule-mode') {
      const mode = button.dataset.scheduleMode as ScheduleMode;
      if (mode !== 'day' && mode !== 'four-day' && mode !== 'week' && mode !== 'month' && mode !== 'year' && mode !== 'agenda') return;
      dispatchAction({ type: 'schedule.mode.select', mode });
    } else if (action === 'select-project-workspace-tab') {
      const tab = button.dataset.projectTab as ProjectWorkspaceTab;
      if (tab !== 'notes' && tab !== 'task-board' && tab !== 'backlog' && tab !== 'deadlines' && tab !== 'schedule') return;
      dispatchAction({ type: 'project.workspace-tab.select', tab });
    } else if (action === 'select-project') {
      dispatchAction({ type: 'project.select', projectId: button.dataset.projectId ?? ALL_PROJECTS });
    } else if (action === 'schedule-navigate') {
      const direction = button.dataset.direction as ScheduleNavigationDirection;
      if (
        direction !== 'previous'
        && direction !== 'today'
        && direction !== 'next'
      ) {
        return;
      }
      const today = currentSourceMode() === 'external'
        ? new Date()
        : new Date(FIXED_CLOCK.now());
      dispatchAction({
        type: 'schedule.cursor.set',
        date: scheduleNavigationDateKey(
          scheduleCursor,
          scheduleMode,
          direction,
          today,
        ),
      });
    } else if (action === 'calendar-navigate') {
      const direction = button.dataset.direction;
      if (direction !== 'previous' && direction !== 'next') return;
      dispatchAction({ type: 'calendar.navigate', direction });
    } else if (action === 'calendar-today') {
      dispatchAction({ type: 'calendar.today' });
    } else if (action === 'source-refresh') {
    }
  });
  root.addEventListener('dragover', (event) => {
    if ((event.target as HTMLElement).closest('[data-c1-key="canvas-drop-zone"]')) event.preventDefault();
  });
  root.addEventListener('drop', (event) => {
    if (!(event.target as HTMLElement).closest('[data-c1-key="canvas-drop-zone"]')) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []) as unknown as BrowserFileLike[];
    void canvasDropQueue.enqueue(files).then((next) => { canvasState = next; render(); });
  });
  bindRefreshWiring({ documentTarget: document, windowTarget: window, setVisible: (visible, options) => sourceSession?.setVisible(visible, options), refresh: refreshFromSource });
  window.addEventListener('pagehide', (event) => { disposeCanvasPreviewsOnPageHide(event, canvasPreviewRegistry); disposeCanvasExcalidrawPreviewsOnPageHide(event, canvasExcalidrawPreviewRegistry); disposeCanvasTextPreviewsOnPageHide(event, canvasTextPreviewRegistry); });
}

async function boot(): Promise<void> {
  setBootState('loading');
  const bridgeUrl = bridgeUrlForLaunch(window.location.search, BUILD_IDENTITY.agentBridgeEnabled);
  const automationDirectory = bridgeUrl ? createHttpDirectoryHandle(bridgeUrl) : null;
  const fixture = createBrowserSource();
  const loaded = await loadVaultState(fixture.reader);

  // HARD GATE C: an activated record store is the record source; anything else keeps the
  // legacy reader and says why. The resolution happens in the adapter layer and hands back a
  // read-only source, because the shell must hold no RecordStore authority of its own — the
  // containment guard asserts that, and it is a better rule than a comment.
  const resolved = await resolveBrowserRecordStoreSource();
  const recordStore = resolved.source;
  const sourceDecision = resolved.decision;

  const startup = createStartupSessionOrchestrator({
    fixture: { mode: 'fixture', reader: fixture.reader, initial: loaded },
    recordStore,
    sourceDecision,
    restored: { store: { restore: async () => automationDirectory }, permissions: { queryPermission: async () => automationDirectory ? 'granted' : 'denied' } },
    intervalMs: 60_000,
    onProjection: (projection, mode, result) => applyProjection(projection, mode, result),
  });
  const started = await startup.start();
  sourceSession = started.session;
  startupInspection = started.inspection;
  applyProjection(sourceSession.projection(), sourceSession.snapshot().sourceMode);
  actionDispatcher = createActionDispatcher({ state: appState!, problems: loadProblems, revisions: sourceProjection!.revisions, mode: sourceSession.snapshot().sourceMode === 'external' ? 'live' : 'fixture', initialSourceRevision: sourceProjection!.generation, initialCalendarMonth: '2026-09-01', clock: sourceSession.snapshot().sourceMode === 'external' ? systemClock : FIXED_CLOCK, idGenerator: DETERMINISTIC_IDS, canvasNodeExists: (nodeId) => canvasState.items.some((item) => item.node.id === nodeId) });
  const initial = actionDispatcher.snapshot();
  selection = initial.selection;
  surface = initial.surface;
  tasksMode = initial.tasksMode;
  timekeepingPanels = { ...initial.timekeepingPanels };
  scheduleMode = initial.scheduleMode;
  scheduleCursor = new Date(`${initial.scheduleDate}T00:00:00`);
  projectWorkspaceTab = initial.projectWorkspaceTab;
  calendarCursor = new Date(`${initial.calendarMonth}T00:00:00`);
  elasticTargetTime = initial.elasticTargetTime;
  elasticLockedAt = initial.elasticLockedAt;
  const root = element<HTMLElement>('#proxima-app');
  root.dataset.proximaFixture = FIXTURE_NAME;
  root.dataset.proximaMode = sourceSession.snapshot().sourceMode;
  root.dataset.proximaSourceMode = sourceSession.snapshot().sourceMode;
  root.dataset.proximaClock = new Date(FIXED_CLOCK.now()).toISOString();
  root.dataset.proximaIdSeed = DETERMINISTIC_IDS.next('fixture');
  setBootState('ready');
  setText('#boot-mode', sourceSession.snapshot().sourceMode === 'external' ? 'External source — restored read-only handle' : 'Fixture mode — bundled vault bytes');
  setText('#boot-status', 'Hydrated');
  bindInteractions();
  render();
  // Resolved once so the Task editor knows whether Save and Delete are real controls before a
  // reader opens it: the answer is a property of this run, not of the gesture that needs it.
  void resolveTaskWritePath().then(async () => { await reloadPropertySchemaProjection(); render(); }).catch(() => undefined);
  void restoreAndProbeDirectory().then((report) => { if (report) renderFsaProbe(report); }).catch(() => undefined);
}

boot().catch((error: unknown) => {
  setBootState('error');
  setText('#boot-status', 'Fixture boot failed');
  setText('#hydration-summary', error instanceof Error ? error.message : String(error));
});
