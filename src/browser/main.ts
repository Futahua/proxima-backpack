import { createActionDispatcher, type ProximaActionDispatcher, type Surface } from '../app/actionProtocol.js';
import { createInspectionProjection } from '../app/inspection.js';
import type { ReadOnlyProjection } from '../app/readOnlyProjection.js';
import { evaluateRealVaultAcceptance, isRealVaultAcceptanceReport, type RealVaultAcceptanceReport } from '../app/realVaultAcceptance.js';
import { evaluateCreatorVaultPreflight, isCreatorVaultPreflightReport, type CreatorVaultPreflightReport } from '../app/creatorVaultPreflight.js';
import { coexistenceReadiness, declareCoexistenceReadiness } from './coexistenceReadiness.js';
import { evaluateRealVaultRunbook } from '../app/realVaultRunbook.js';
import { createStartupSessionOrchestrator, type StartupInspection } from '../app/startupSession.js';
import type { SourceSession } from '../app/sourceSession.js';
import { createUiHealthModel, type UiHealthModel } from '../app/uiHealth.js';
import { evaluateCleanProfileAcceptance } from '../app/fsaEvidence.js';
import { pickAndProbeDirectory, rereadSelectedDirectory, restoreAndProbeDirectory } from '../app/fsaProbe.js';
import { loadVaultState } from '../app/vaultRepository.js';
import { calculateElasticTimeline, elasticCardHeights } from '../domain/elastic.js';
import { fixedClock, sequentialIdGenerator } from '../domain/clock.js';
import type { LoadProblem } from '../domain/problems.js';
import { ALL_PROJECTS, UNCATEGORISED, elasticBoard, eventsByDay, eventsForSelection, projectsFor, reconcileSelection, tasksForSelection } from '../domain/selectors.js';
import { localDateKey } from '../domain/time.js';
import type { CalendarEvent, ProximaState, Task } from '../domain/types.js';
import { BUILD_IDENTITY } from './generated/buildIdentity.generated.js';
import { createHttpDirectoryHandle } from '../adapters/httpDirectory.js';
import { refreshEvidenceFromProjections, renameDeleteEvidenceFromProjections } from './realVaultLive.js';
import { createBrowserSource } from './sourceFactory.js';

const FIXTURE_NAME = 'vault-basic';
const FIXED_CLOCK = fixedClock(BUILD_IDENTITY.fixedClock);
const DETERMINISTIC_IDS = sequentialIdGenerator();
let appState: ProximaState | null = null;
let loadProblems: LoadProblem[] = [];
let selection = ALL_PROJECTS;
let surface: Surface = 'board';
let calendarCursor = new Date(FIXED_CLOCK.now());
let actionDispatcher: ProximaActionDispatcher | null = null;
let sourceSession: SourceSession | null = null;
let startupInspection: StartupInspection | null = null;
let sourceProjection: ReadOnlyProjection | null = null;
let lastRefreshEvidence: Parameters<typeof evaluateRealVaultAcceptance>[0]['refreshEvidence'];
let lastRenameDeleteEvidence: Parameters<typeof evaluateRealVaultAcceptance>[0]['renameDeleteEvidence'];

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

function setBootState(state: 'loading' | 'ready' | 'error'): void {
  const root = element<HTMLElement>('#proxima-app');
  root.dataset.proximaMode = 'fixture';
  root.dataset.proximaHydrated = state === 'ready' ? 'true' : 'false';
  root.dataset.proximaBootState = state;
}

function projectName(state: ProximaState, projectId: string | null): string {
  if (!projectId) return 'Uncategorised';
  return state.projects.find((project) => project.id === projectId)?.name ?? projectId;
}

function selectionLabel(state: ProximaState, selected: string): string {
  if (selected === ALL_PROJECTS) return 'All projects';
  if (selected === UNCATEGORISED) return 'Uncategorised';
  return projectName(state, selected);
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
  const active = state.projects.filter((project) => project.status === 'active').slice().sort((a, b) => a.id.localeCompare(b.id));
  const items = [
    { id: ALL_PROJECTS, label: 'All projects', detail: 'Board and calendar', project: undefined },
    { id: UNCATEGORISED, label: 'Uncategorised', detail: 'Records without a project', project: undefined },
    ...active.map((project) => ({ id: project.id, label: project.name, detail: project.projectType === 'schedule' ? 'Calendar project' : 'Task project', project })),
  ];
  return `<nav class="project-navigation" data-c1-key="project-navigation" aria-label="Projects">
    <div class="region-heading"><span>Projects</span><span class="count">${active.length}</span></div><div class="project-list">
    ${items.map((item) => {
      const activeItem = selection === item.id;
      const wrongSurface = item.project !== undefined && ((surface === 'board' && item.project.projectType === 'schedule') || (surface === 'calendar' && item.project.projectType === 'task'));
      return `<button type="button" class="project-item${activeItem ? ' selected' : ''}" data-action="select-project" data-project-id="${escapeHtml(item.id)}" data-c1-key="project-item-${escapeHtml(item.id || 'uncategorised')}" aria-current="${activeItem ? 'page' : 'false'}" title="${escapeHtml(item.detail)}"><span class="project-dot ${item.project?.projectType ?? 'all'}"></span><span class="project-item-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>${wrongSurface ? '<span class="surface-hint">↗</span>' : ''}</button>`;
    }).join('')}</div>
  </nav>`;
}

function surfaceSwitcher(): string {
  return `<div class="surface-switcher" data-c1-key="surface-switcher" role="tablist" aria-label="Proxima surfaces"><button type="button" class="surface-tab${surface === 'board' ? ' selected' : ''}" data-action="switch-surface" data-surface="board" role="tab" aria-selected="${surface === 'board'}" data-c1-key="surface-tab-board">Elastic board</button><button type="button" class="surface-tab${surface === 'calendar' ? ' selected' : ''}" data-action="switch-surface" data-surface="calendar" role="tab" aria-selected="${surface === 'calendar'}" data-c1-key="surface-tab-calendar">Calendar</button></div>`;
}

function taskCard(state: ProximaState, task: Task, height?: number): string {
  const deadline = task.deadline ? new Date(task.deadline).toLocaleDateString() : 'No deadline';
  const style = height === undefined ? '' : ` style="min-height:${Math.round(height)}px"`;
  return `<article class="task-card" data-c1-key="task-card-${escapeHtml(task.id)}"${style}><div class="task-card-top"><span class="task-status">${escapeHtml(task.status)}</span>${task.isCompleted ? '<span class="task-complete">Done</span>' : ''}</div><h3>${escapeHtml(task.name)}</h3><p>${escapeHtml(task.description || 'No description')}</p><footer><span>${escapeHtml(projectName(state, task.projectId))}</span><span>${escapeHtml(deadline)}</span></footer></article>`;
}

function boardSurface(state: ProximaState): string {
  const taskProjectIds = new Set(projectsFor(state.projects, 'task').map((project) => project.id));
  const boardTasks = state.tasks.filter((task) => task.projectId === null || taskProjectIds.has(task.projectId));
  const selectedTasks = tasksForSelection(boardTasks, selection);
  const board = elasticBoard(selectedTasks, state.statuses);
  const now = new Date(FIXED_CLOCK.now());
  const futureDeadlines = board.running.map((task) => (task.deadline ? new Date(task.deadline) : null)).filter((date): date is Date => date !== null && Number.isFinite(date.getTime()) && date.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime());
  const end = futureDeadlines[0] ?? new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const heights = elasticCardHeights(board.running, calculateElasticTimeline(board.running, now, end), 460);
  const columns: Array<{ id: 'backlog' | 'running' | 'finished'; label: string; tasks: Task[] }> = [{ id: 'backlog', label: 'Backlog', tasks: board.backlog }, { id: 'running', label: 'Running', tasks: board.running }, { id: 'finished', label: 'Finished', tasks: board.finished }];
  return `<section class="surface board-surface" data-c1-key="board-region" aria-label="Elastic board"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(selectionLabel(state, selection))}</p><h2>Elastic board</h2><p class="surface-description">Running work expands by time remaining; status determines the column.</p></div><span class="surface-count">${selectedTasks.length} tasks</span></header><div class="board-grid">${columns.map((column) => `<section class="board-column" data-c1-key="board-column-${column.id}" aria-label="${column.label} column"><header><h3>${column.label}</h3><span>${column.tasks.length}</span></header><div class="column-cards">${column.tasks.length === 0 ? `<p class="empty-state" data-c1-key="board-empty-${column.id}">No tasks here.</p>` : column.tasks.map((task) => taskCard(state, task, column.id === 'running' ? heights[task.id] : undefined)).join('')}</div></section>`).join('')}</div></section>`;
}

function monthTitle(date: Date): string { return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }

function calendarDays(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}

function eventCard(event: CalendarEvent, state: ProximaState, dayKey: string): string { return `<article class="event-card" data-c1-key="event-${escapeHtml(event.id)}-${escapeHtml(dayKey)}" title="${escapeHtml(event.description || event.name)}"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(state, event.projectId))}</small></article>`; }

function calendarSurface(state: ProximaState, problems: LoadProblem[]): string {
  const scheduleIds = new Set(projectsFor(state.projects, 'schedule').map((project) => project.id));
  const calendarEvents = eventsForSelection(state.events.filter((event) => event.projectId === null || scheduleIds.has(event.projectId)), selection);
  const byDay = eventsByDay(calendarEvents, problems);
  const days = calendarDays(calendarCursor);
  const today = localDateKey(new Date(FIXED_CLOCK.now()));
  return `<section class="surface calendar-surface" data-c1-key="calendar-region" aria-label="Calendar"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(selectionLabel(state, selection))}</p><h2>Calendar</h2><p class="surface-description">Local civil days, inclusive event ranges, and fail-visible diagnostics.</p></div><div class="calendar-controls"><button type="button" class="icon-button" data-action="calendar-shift" data-delta="-1" data-c1-key="calendar-previous" aria-label="Previous month">←</button><strong>${escapeHtml(monthTitle(calendarCursor))}</strong><button type="button" class="icon-button" data-action="calendar-shift" data-delta="1" data-c1-key="calendar-next" aria-label="Next month">→</button></div></header><div class="weekday-row" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${days.map((day) => { const key = localDateKey(day); const events = byDay.get(key) ?? []; const outside = day.getMonth() !== calendarCursor.getMonth(); return `<div class="calendar-day${outside ? ' outside' : ''}${key === today ? ' today' : ''}" data-c1-key="calendar-day-${escapeHtml(key)}" aria-label="${escapeHtml(key)}"><span class="day-number">${day.getDate()}</span><div class="day-events">${events.map((event) => eventCard(event, state, key)).join('')}</div></div>`; }).join('')}</div></section>`;
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
    session: { sourceMode: session?.sourceMode === 'external' ? 'external' : 'fixture', sourceGeneration: session?.sourceGeneration ?? sourceProjection?.generation ?? 1, transitionState: session?.transitionState ?? 'stable' },
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

function render(): void {
  if (!appState) return;
  const root = element<HTMLElement>('#proxima-app');
  const problems = visibleProblems([...loadProblems]);
  root.dataset.proximaSurface = surface;
  root.dataset.proximaSelection = selection;
  const health = currentUiHealth();
  root.dataset.proximaHealthGeneration = String(health.sourceRevision);
  const sourceLabel = sourceSession?.snapshot().sourceMode === 'external' ? 'Read-only external source' : 'Read-only fixture';
  root.innerHTML = `<div class="app-shell" data-c1-key="app-root"><header class="app-header"><div class="brand"><span class="brand-mark">P</span><div><h1>Proxima</h1><span>Read-only workspace</span></div></div><div class="header-state"><span class="read-only-badge">${sourceLabel}</span><span class="hydrated-badge" data-c1-key="hydration-state">Hydrated</span><button type="button" data-action="source-refresh" data-c1-key="source-refresh-button">Refresh source</button><button type="button" data-action="fsa-probe" data-c1-key="fsa-probe-button">Select disposable folder</button><button type="button" data-action="fsa-reread" data-c1-key="fsa-reread-button">Re-read selected folder</button></div></header>${healthSurface(health)}<div class="app-layout">${projectNavigation(appState)}<main class="main-content">${surfaceSwitcher()}${surface === 'board' ? boardSurface(appState) : calendarSurface(appState, problems)}${diagnosticsSurface(problems)}</main></div><footer class="app-footer" data-c1-key="app-footer"><span>Fixed clock ${escapeHtml(BUILD_IDENTITY.fixedClock)}</span><span>Build ${escapeHtml(BUILD_IDENTITY.gitSha.slice(0, 8))}</span></footer><details class="build-details"><summary>Build identity and hydration evidence</summary><pre id="build-identity">${escapeHtml(JSON.stringify(BUILD_IDENTITY, null, 2))}</pre><pre id="hydration-summary"></pre><pre id="fsa-probe-status">Not run</pre><pre id="fsa-acceptance-status">Not run</pre><pre id="real-vault-acceptance-status">Not run</pre><pre id="creator-vault-preflight-status" data-c1-key="creator-vault-preflight-status">Not run</pre></details></div>`;
  updateHydrationSummary(appState, problems);
  exposeInspection();
}

function dispatchAction(input: unknown): void {
  if (!actionDispatcher) return;
  const result = actionDispatcher.dispatch(input);
  if (result.ok) {
    const next = actionDispatcher.snapshot();
    selection = next.selection;
    surface = next.surface;
    calendarCursor = new Date(`${next.calendarMonth}T00:00:00`);
    render();
  } else {
    setText('#boot-status', `Action failed: ${result.error.code}`);
  }
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

function applyProjection(next: ReadOnlyProjection, mode: 'fixture' | 'external', result?: import('../app/refreshController.js').RefreshResult): void {
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

async function refreshFromSource(reason: 'manual' | 'focus' | 'interval' | 'external-signal'): Promise<void> {
  await sourceSession?.refresh(reason);
}

function bindInteractions(): void {
  const root = element<HTMLElement>('#proxima-app');
  if (root.dataset.interactionsBound === 'true') return;
  root.dataset.interactionsBound = 'true';
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
      if (next !== 'board' && next !== 'calendar') return;
      dispatchAction({ type: 'surface.select', surface: next });
    } else if (action === 'select-project') {
      dispatchAction({ type: 'project.select', projectId: button.dataset.projectId ?? ALL_PROJECTS });
    } else if (action === 'calendar-shift') {
      const delta = Number(button.dataset.delta ?? 0);
      if (delta === -1 || delta === 1) dispatchAction({ type: 'calendar.shift-month', delta });
    } else if (action === 'source-refresh') {
      void refreshFromSource('manual');
    }
  });
  window.addEventListener('focus', () => { void refreshFromSource('focus'); });
}

async function boot(): Promise<void> {
  setBootState('loading');
  const bridgeUrl = new URLSearchParams(window.location.search).get('bridge');
  const automationDirectory = bridgeUrl ? createHttpDirectoryHandle(bridgeUrl) : null;
  const fixture = createBrowserSource();
  const loaded = await loadVaultState(fixture.reader);
  const startup = createStartupSessionOrchestrator({
    fixture: { mode: 'fixture', reader: fixture.reader, initial: loaded },
    restored: { store: { restore: async () => automationDirectory }, permissions: { queryPermission: async () => automationDirectory ? 'granted' : 'denied' } },
    intervalMs: 60_000,
    onProjection: (projection, mode, result) => applyProjection(projection, mode, result),
  });
  const started = await startup.start();
  sourceSession = started.session;
  startupInspection = started.inspection;
  applyProjection(sourceSession.projection(), sourceSession.snapshot().sourceMode);
  actionDispatcher = createActionDispatcher({ state: appState!, problems: loadProblems, revisions: sourceProjection!.revisions, mode: sourceSession.snapshot().sourceMode === 'external' ? 'live' : 'fixture', initialSourceRevision: sourceProjection!.generation, initialCalendarMonth: '2026-09-01', clock: FIXED_CLOCK, idGenerator: DETERMINISTIC_IDS });
  const initial = actionDispatcher.snapshot();
  selection = initial.selection;
  surface = initial.surface;
  calendarCursor = new Date(`${initial.calendarMonth}T00:00:00`);
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
  void restoreAndProbeDirectory().then((report) => { if (report) renderFsaProbe(report); }).catch(() => undefined);
}

boot().catch((error: unknown) => {
  setBootState('error');
  setText('#boot-status', 'Fixture boot failed');
  setText('#hydration-summary', error instanceof Error ? error.message : String(error));
});
