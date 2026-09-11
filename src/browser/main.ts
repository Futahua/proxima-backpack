import { createActionDispatcher, type ActionResult, type ProjectWorkspaceTab, type ProximaActionDispatcher, type ScheduleMode, type Surface, type TasksMode, type TimekeepingPanelVisibility } from '../app/actionProtocol.js';
import { createInspectionProjection } from '../app/inspection.js';
import type { ReadOnlyProjection } from '../app/readOnlyProjection.js';
import { evaluateRealVaultAcceptance, isRealVaultAcceptanceReport, type RealVaultAcceptanceReport } from '../app/realVaultAcceptance.js';
import { evaluateCreatorVaultPreflight, isCreatorVaultPreflightReport, type CreatorVaultPreflightReport } from '../app/creatorVaultPreflight.js';
import { coexistenceReadiness, declareCoexistenceReadiness } from './coexistenceReadiness.js';
import { evaluateRealVaultRunbook } from '../app/realVaultRunbook.js';
import { createStartupSessionOrchestrator, type StartupInspection } from '../app/startupSession.js';
import { resolveBrowserRecordStoreSource } from '../adapters/recordStoreStartupSource.js';
import { resolveBrowserTaskMutations, type BrowserTaskMutations } from '../adapters/browserTaskMutations.js';
import { performElasticDrop } from '../app/elasticDropAction.js';
import { deleteTaskAction, saveTaskAction } from '../app/taskEditorWrite.js';
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
import { bindScheduleTimeGridInteractions, renderScheduleTimeGrid, startScheduleTimeTicker, type ScheduleEventDraft, type ScheduleTimeGridMode } from './scheduleTimeGrid.js';
import { bindScheduleProjectionInteractions, renderScheduleProjection, type ScheduleProjectionMode } from './scheduleProjection.js';
import { scheduleNavigationDateKey, type ScheduleNavigationDirection } from './scheduleNavigation.js';
import { scheduleEventsForSelection } from './scheduleSelection.js';
import { bindScheduleRecurrenceInteractions, type ScheduleRecurrenceScope, type ScheduleRecurringOccurrenceSelection } from './scheduleRecurrence.js';
import { projectPresentation } from './projectPresentation.js';
import { bindProjectsHubInteractions, renderProjectsHub, type ProjectsHubFilter } from './projectsHub.js';
import { bindProjectNotesInteractions, EMPTY_PROJECT_NOTES_VIEW, PROJECT_NOTE_WRITE_REFUSAL, type ProjectNotesViewState } from './projectNotes.js';
import { bindProjectTaskBoardInteractions, EMPTY_PROJECT_TASK_BOARD_VIEW, PROJECT_TASK_BOARD_WRITE_REFUSAL, type ProjectTaskBoardViewState } from './projectTaskBoard.js';
import { bindProjectBacklogInteractions, EMPTY_PROJECT_BACKLOG_VIEW, PROJECT_BACKLOG_WRITE_REFUSAL, type ProjectBacklogViewState } from './projectBacklog.js';
import { applyBacklogControl, buildBacklogFilter, buildBacklogPropertyFilter, clearBacklogSelection, resizeBacklogColumn, selectAllBacklogVisible, toggleBacklogSelection } from '../app/backlogControls.js';
import { propertyValueTypeFor } from '../app/backlogView.js';
import { applyTaskEditorEdit, taskEditorDraftFor, type TaskEditorDraft } from '../app/taskEditor.js';
import { bindProjectDeadlinesInteractions, EMPTY_PROJECT_DEADLINES_VIEW, type ProjectDeadlinesViewState } from './projectDeadlines.js';
import { bindProjectScheduleInteractions, EMPTY_PROJECT_SCHEDULE_VIEW, type ProjectScheduleViewState } from './projectSchedule.js';
import { applyBootState, type BootState } from './bootState.js';
import { createProjectNameLookup, projectLabel } from './projectLookup.js';
import { bridgeUrlForLaunch } from './agentBridge.js';
import { cockpitSubmode, renderCockpitNavigation } from './cockpitNavigation.js';

const FIXTURE_NAME = 'vault-basic';
const FIXED_CLOCK = fixedClock(BUILD_IDENTITY.fixedClock);
const DETERMINISTIC_IDS = sequentialIdGenerator();
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
let selectedScheduleEventId: string | null = null;
let scheduleEventDraft: ScheduleEventDraft | null = null;
let selectedScheduleRecurringOccurrence: ScheduleRecurringOccurrenceSelection | null = null;
let selectedScheduleRecurringScope: ScheduleRecurrenceScope | null = null;
let scheduleMode: ScheduleMode = 'month';
let projectWorkspaceTab: ProjectWorkspaceTab = 'notes';
let projectsHubFilter: ProjectsHubFilter = 'active';
let projectCreateOpen = false;
let projectTaskBoardView: ProjectTaskBoardViewState = EMPTY_PROJECT_TASK_BOARD_VIEW;
let projectBacklogView: ProjectBacklogViewState = EMPTY_PROJECT_BACKLOG_VIEW;
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
let taskMutations: BrowserTaskMutations | null = null;
let taskMutationResolution: Promise<BrowserTaskMutations | null> | null = null;
/** Why there is no write path, in the shell's own words, for the refusal banner. */
let taskMutationUnavailable: string | null = null;
/** The last refusal the Task editor's Save or Delete produced, shown beside the form. */
let taskEditorRefusal: string | null = null;
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

function projectNavigation(state: ProximaState): string {
  const projects = state.projects.slice().sort((a, b) => a.id.localeCompare(b.id));
  const active = projects.filter((project) => project.status === 'active');
  const items = [
    { id: ALL_PROJECTS, label: 'All projects', detail: 'All Proxima work', project: undefined },
    { id: UNCATEGORISED, label: 'Uncategorised', detail: 'Records without a project', project: undefined },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      detail: `${project.status === 'archived' ? 'Archived · ' : ''}Project`,
      project,
    })),
  ];
  const selectedProject = state.projects.find((project) => project.id === selection);
  const detail = selectedProject ? projectPresentation(selectedProject) : null;
  return `<nav class="project-navigation" data-c1-key="project-navigation" aria-label="Projects">
    <div class="region-heading"><span>Projects</span><span class="count">${active.length}</span></div><div class="project-list">
    ${items.map((item) => {
      const activeItem = selection === item.id;
      const disabled = item.project?.status === 'archived';
      const body = `<span class="project-dot ${item.project?.projectType ?? 'all'}"></span><span class="project-item-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>`;
      return disabled
        ? `<div class="project-item archived" data-c1-key="project-item-${escapeHtml(item.id)}" title="${escapeHtml(item.detail)}" aria-label="${escapeHtml(item.label)}">${body}</div>`
        : `<button type="button" class="project-item${activeItem ? ' selected' : ''}" data-action="select-project" data-project-id="${escapeHtml(item.id)}" data-c1-key="project-item-${escapeHtml(item.id || 'uncategorised')}" aria-current="${activeItem ? 'page' : 'false'}" title="${escapeHtml(item.detail)}">${body}</button>`;
    }).join('')}</div>
    ${detail ? `<section class="project-details" data-c1-key="project-details" aria-label="Project details"><header><strong>${escapeHtml(detail.name)}</strong><small>${escapeHtml(detail.statusLabel)}</small></header><p>${escapeHtml(detail.description || 'No description')}</p>${detail.linkedFolders.length > 0 ? `<div><small>Linked folders</small><ul>${detail.linkedFolders.map((folder) => `<li><strong>${escapeHtml(folder.name)}</strong><span>${escapeHtml(folder.path)}</span></li>`).join('')}</ul></div>` : '<small>No linked folders</small>'}<footer><small>Source</small><code>${escapeHtml(detail.sourcePath)}</code><small>ID from ${escapeHtml(detail.sourceIdOrigin)}</small></footer></section>` : '<section class="project-details empty" data-c1-key="project-details"><small>Select a project to inspect its read-only details.</small></section>'}
  </nav>`;
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
    calendarCursor,
    now,
    selectedTaskId: elasticSelectedTaskId,
    editorDraft: taskEditorDraft,
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
  const now = currentSourceMode() === 'external' ? new Date() : new Date(FIXED_CLOCK.now());
  return renderProjectsHub({ state, selection, filter: projectsHubFilter, workspaceTab: projectWorkspaceTab, now, newProjectOpen: projectCreateOpen, projectNotes: projectNotesView, projectTaskBoard: projectTaskBoardView, projectBacklog: projectBacklogView, projectDeadlines: projectDeadlinesView, projectSchedule: projectScheduleView });
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
  const sourceLabel = sourceMode === 'external'
    ? 'Read-only external source'
    : sourceMode === 'record-store'
      // Records come from the record store; notes, drawings and attachments stay vault
      // artifacts, which is why both halves are named rather than saying "record store" and
      // letting a reader assume the vault is gone.
      ? 'Record store records · vault notes'
      : 'Read-only fixture';
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
  root.innerHTML = `<div class="app-shell" data-c1-key="app-root"><header class="app-header"><div class="brand"><span class="brand-mark">P</span><div><h1>Proxima</h1><span>Read-only workspace</span></div></div><div class="header-state"><span class="read-only-badge">${sourceLabel}</span><span class="hydrated-badge" data-c1-key="hydration-state">Hydrated</span><button type="button" data-action="source-refresh" data-c1-key="source-refresh-button">Refresh source</button><button type="button" data-action="fsa-probe" data-c1-key="fsa-probe-button">Select disposable folder</button><button type="button" data-action="fsa-reread" data-c1-key="fsa-reread-button">Re-read selected folder</button></div></header>${healthSurface(health)}<div class="app-layout">${projectNavigation(appState)}<main class="main-content">${surfaceSwitcher()}${surfaceMarkup.markup}${diagnosticsSurface(problems)}</main></div><footer class="app-footer" data-c1-key="app-footer"><span>Fixed clock ${escapeHtml(BUILD_IDENTITY.fixedClock)}</span><span>Build ${escapeHtml(BUILD_IDENTITY.gitSha.slice(0, 8))}</span></footer><details class="build-details"><summary>Build identity and hydration evidence</summary><pre id="build-identity">${escapeHtml(JSON.stringify(BUILD_IDENTITY, null, 2))}</pre><pre id="hydration-summary"></pre><pre id="fsa-probe-status">Not run</pre><pre id="fsa-acceptance-status">Not run</pre><pre id="real-vault-acceptance-status">Not run</pre><pre id="creator-vault-preflight-status" data-c1-key="creator-vault-preflight-status">Not run</pre></details></div>`;
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
async function resolveTaskWritePath(): Promise<BrowserTaskMutations | null> {
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
    },
    { taskId, targetColumn, targetIndex },
  );
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
    openNewProject: () => { projectCreateOpen = true; render(); },
    closeNewProject: () => { projectCreateOpen = false; render(); },
    createProject: ({ name, description }) => dispatchAction({ type: 'project.create', name, description }),
  });
  bindProjectTaskBoardInteractions(root, {
    openTask: (taskId) => { const task = appState?.tasks.find((candidate) => candidate.id === taskId && candidate.projectId === selection); if (!task) return; projectTaskBoardView = { ...EMPTY_PROJECT_TASK_BOARD_VIEW, projectId: selection, selectedTaskId: taskId }; render(); },
    closeTask: () => { projectTaskBoardView = { ...projectTaskBoardView, selectedTaskId: null }; render(); },
    startDrag: (taskId) => { projectTaskBoardView = { ...projectTaskBoardView, projectId: selection, dragTaskId: taskId, dragTargetStatus: null, dragTargetIndex: null, writeRefusal: null, lastRefusedMove: null }; },
    previewMove: ({ taskId, targetStatus, targetIndex }) => { projectTaskBoardView = { ...projectTaskBoardView, projectId: selection, dragTaskId: taskId, dragTargetStatus: targetStatus, dragTargetIndex: targetIndex }; },
    refuseMove: (intent) => { projectTaskBoardView = { ...projectTaskBoardView, projectId: selection, dragTaskId: null, dragTargetStatus: null, dragTargetIndex: null, writeRefusal: PROJECT_TASK_BOARD_WRITE_REFUSAL, lastRefusedMove: { ...intent } }; render(); },
    clearDrag: () => { projectTaskBoardView = { ...projectTaskBoardView, dragTaskId: null, dragTargetStatus: null, dragTargetIndex: null }; },
  });
  const restoreBacklogSearchFocus = (caret: number) => { const field = root.querySelector<HTMLInputElement>('[data-project-backlog-search-input]'); if (!field) return; field.focus(); field.setSelectionRange(caret, caret); };
  bindProjectBacklogInteractions(root, {
    // A row click opens that task in the Backlog's Task editor, which starts with no draft:
    // the record is what the form shows until something is typed.
    openTask: (taskId) => { const task = appState?.tasks.find((candidate) => candidate.id === taskId && candidate.projectId === selection); if (!task) return; projectBacklogView = { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: selection, selectedTaskId: taskId, editorDraft: null }; render(); },
    closeTask: () => { projectBacklogView = { ...projectBacklogView, selectedTaskId: null, editorDraft: null }; render(); },
    startDrag: (taskId) => { projectBacklogView = { ...projectBacklogView, projectId: selection, dragTaskId: taskId, dragTargetIndex: null, writeRefusal: null, lastRefusedMove: null }; },
    previewMove: ({ taskId, targetIndex }) => { projectBacklogView = { ...projectBacklogView, projectId: selection, dragTaskId: taskId, dragTargetIndex: targetIndex }; },
    refuseMove: (intent) => { projectBacklogView = { ...projectBacklogView, projectId: selection, dragTaskId: null, dragTargetIndex: null, writeRefusal: PROJECT_BACKLOG_WRITE_REFUSAL, lastRefusedMove: { ...intent } }; render(); },
    clearDrag: () => { projectBacklogView = { ...projectBacklogView, dragTaskId: null, dragTargetIndex: null }; },
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
      render();
    },
  });
  bindScheduleProjectionInteractions(root, {
    openEvent: (eventId) => {
      scheduleEventDraft = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      selectedScheduleEventId = eventId;
      render();
    },
    closeEvent: () => {
      selectedScheduleEventId = null;
      scheduleEventDraft = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      render();
    },
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
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      selectedScheduleEventId = eventId;
      render();
    },
    closeEvent: () => {
      selectedScheduleEventId = null;
      scheduleEventDraft = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      render();
    },
    seedEvent: (draft) => {
      selectedScheduleEventId = null;
      selectedScheduleRecurringOccurrence = null;
      selectedScheduleRecurringScope = null;
      scheduleEventDraft = { ...draft };
      render();
    },
    createEvent: ({
      name,
      projectId,
      description,
      startDate,
      deadline,
    }) => dispatchAction({
      type: 'event.schedule.create',
      name,
      projectId,
      description,
      startDate,
      deadline,
    }),
    changeEvent: ({
      eventId,
      operation,
      proposedStartDate,
      proposedDeadline,
    }) => dispatchAction({
      type: 'event.schedule.change',
      eventId,
      operation,
      proposedStartDate,
      proposedDeadline,
    }),
  });

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
    navigateMonth: (direction) => {
      dispatchAction({
        type: 'calendar.navigate',
        direction,
      });
    },
    today: () => {
      dispatchAction({ type: 'calendar.today' });
    },
    changeTask: ({
      taskId,
      operation,
      proposedStartDate,
      proposedDeadline,
      targetRowIndex,
    }) => dispatchAction({
      type: 'task.timeline.change',
      taskId,
      operation,
      proposedStartDate,
      proposedDeadline,
      targetRowIndex,
    }),
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
    if (action === 'fsa-probe') {
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
      void executeSourceRefreshAction({
        dispatch: (input) => dispatchAction(input),
        refresh: refreshFromSource,
      });
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
  void resolveTaskWritePath().then(() => { render(); }).catch(() => undefined);
  void restoreAndProbeDirectory().then((report) => { if (report) renderFsaProbe(report); }).catch(() => undefined);
}

boot().catch((error: unknown) => {
  setBootState('error');
  setText('#boot-status', 'Fixture boot failed');
  setText('#hydration-summary', error instanceof Error ? error.message : String(error));
});
