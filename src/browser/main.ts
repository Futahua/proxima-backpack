import { createMemoryVault } from '../adapters/memoryVault.js';
import { loadVaultState } from '../app/vaultRepository.js';
import { calculateElasticTimeline, elasticCardHeights } from '../domain/elastic.js';
import { fixedClock, sequentialIdGenerator } from '../domain/clock.js';
import type { LoadProblem } from '../domain/problems.js';
import { ALL_PROJECTS, UNCATEGORISED, elasticBoard, eventsByDay, eventsForSelection, projectsFor, reconcileSelection, tasksForSelection } from '../domain/selectors.js';
import { localDateKey } from '../domain/time.js';
import type { CalendarEvent, ProximaState, Task } from '../domain/types.js';
import { BUILD_IDENTITY } from './generated/buildIdentity.generated.js';
import { FIXTURE_VAULTS } from './generated/fixtureVault.generated.js';

const FIXTURE_NAME = 'vault-basic';
const FIXTURE_ROOT = FIXTURE_VAULTS[FIXTURE_NAME];
const FIXED_CLOCK = fixedClock(BUILD_IDENTITY.fixedClock);
const DETERMINISTIC_IDS = sequentialIdGenerator();
type Surface = 'board' | 'calendar';

let appState: ProximaState | null = null;
let loadProblems: LoadProblem[] = [];
let selection = ALL_PROJECTS;
let surface: Surface = 'board';
let calendarCursor = new Date(FIXED_CLOCK.now());

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

function eventCard(event: CalendarEvent, state: ProximaState): string { return `<article class="event-card" data-c1-key="event-${escapeHtml(event.id)}" title="${escapeHtml(event.description || event.name)}"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(projectName(state, event.projectId))}</small></article>`; }

function calendarSurface(state: ProximaState, problems: LoadProblem[]): string {
  const scheduleIds = new Set(projectsFor(state.projects, 'schedule').map((project) => project.id));
  const calendarEvents = eventsForSelection(state.events.filter((event) => event.projectId === null || scheduleIds.has(event.projectId)), selection);
  const byDay = eventsByDay(calendarEvents, problems);
  const days = calendarDays(calendarCursor);
  const today = localDateKey(new Date(FIXED_CLOCK.now()));
  return `<section class="surface calendar-surface" data-c1-key="calendar-region" aria-label="Calendar"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(selectionLabel(state, selection))}</p><h2>Calendar</h2><p class="surface-description">Local civil days, inclusive event ranges, and fail-visible diagnostics.</p></div><div class="calendar-controls"><button type="button" class="icon-button" data-action="calendar-shift" data-delta="-1" data-c1-key="calendar-previous" aria-label="Previous month">←</button><strong>${escapeHtml(monthTitle(calendarCursor))}</strong><button type="button" class="icon-button" data-action="calendar-shift" data-delta="1" data-c1-key="calendar-next" aria-label="Next month">→</button></div></header><div class="weekday-row" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${days.map((day) => { const key = localDateKey(day); const events = byDay.get(key) ?? []; const outside = day.getMonth() !== calendarCursor.getMonth(); return `<div class="calendar-day${outside ? ' outside' : ''}${key === today ? ' today' : ''}" data-c1-key="calendar-day-${escapeHtml(key)}" aria-label="${escapeHtml(key)}"><span class="day-number">${day.getDate()}</span><div class="day-events">${events.map((event) => eventCard(event, state)).join('')}</div></div>`; }).join('')}</div></section>`;
}

function diagnosticsSurface(problems: LoadProblem[]): string {
  if (problems.length === 0) return `<section class="diagnostics clean" data-c1-key="diagnostics"><span class="diagnostic-ok">✓</span><span>No load or calendar problems.</span></section>`;
  return `<section class="diagnostics" data-c1-key="diagnostics" aria-label="Diagnostics"><header><strong>Diagnostics</strong><span>${problems.length}</span></header><ul>${problems.map((problem) => `<li data-c1-key="diagnostic-${escapeHtml(problem.code)}-${escapeHtml(problem.id ?? problem.path)}"><span class="severity ${problem.severity}">${escapeHtml(problem.severity)}</span><span><strong>${escapeHtml(problem.code)}</strong><small>${escapeHtml(problem.detail)}</small></span></li>`).join('')}</ul></section>`;
}

function updateHydrationSummary(state: ProximaState, problems: LoadProblem[]): void {
  setText('#hydration-summary', JSON.stringify({ mode: 'fixture', fixture: FIXTURE_NAME, hydrationRevision: `fixture:${BUILD_IDENTITY.fixtureHash.slice(0, 16)}:1`, surface, selection, projects: state.projects.length, tasks: state.tasks.length, events: state.events.length, problems: problems.length, fixedClock: BUILD_IDENTITY.fixedClock, deterministicIds: true }, null, 2));
}

function render(): void {
  if (!appState) return;
  const root = element<HTMLElement>('#proxima-app');
  const problems = visibleProblems([...loadProblems]);
  root.dataset.proximaSurface = surface;
  root.dataset.proximaSelection = selection;
  root.innerHTML = `<div class="app-shell" data-c1-key="app-root"><header class="app-header"><div class="brand"><span class="brand-mark">P</span><div><h1>Proxima</h1><span>Fixture workspace</span></div></div><div class="header-state"><span class="read-only-badge">Read-only fixture</span><span class="hydrated-badge" data-c1-key="hydration-state">Hydrated</span></div></header><div class="app-layout">${projectNavigation(appState)}<main class="main-content">${surfaceSwitcher()}${surface === 'board' ? boardSurface(appState) : calendarSurface(appState, problems)}${diagnosticsSurface(problems)}</main></div><footer class="app-footer" data-c1-key="app-footer"><span>Fixed clock ${escapeHtml(BUILD_IDENTITY.fixedClock)}</span><span>Build ${escapeHtml(BUILD_IDENTITY.gitSha.slice(0, 8))}</span></footer><details class="build-details"><summary>Build identity and hydration evidence</summary><pre id="build-identity">${escapeHtml(JSON.stringify(BUILD_IDENTITY, null, 2))}</pre><pre id="hydration-summary"></pre></details></div>`;
  updateHydrationSummary(appState, problems);
}

function bindInteractions(): void {
  const root = element<HTMLElement>('#proxima-app');
  if (root.dataset.interactionsBound === 'true') return;
  root.dataset.interactionsBound = 'true';
  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!button || !appState) return;
    const action = button.dataset.action;
    if (action === 'switch-surface') {
      const next = button.dataset.surface as Surface;
      if (next !== 'board' && next !== 'calendar') return;
      surface = next;
      selection = reconcileSelection(appState.projects, selection, surface);
      render();
    } else if (action === 'select-project') {
      selection = reconcileSelection(appState.projects, button.dataset.projectId ?? ALL_PROJECTS, surface);
      render();
    } else if (action === 'calendar-shift') {
      const delta = Number(button.dataset.delta ?? 0);
      if (Number.isFinite(delta)) calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + delta, 1);
      render();
    }
  });
}

async function boot(): Promise<void> {
  setBootState('loading');
  const vault = createMemoryVault(FIXTURE_ROOT);
  const loaded = await loadVaultState(vault);
  appState = loaded.state;
  loadProblems = loaded.problems;
  const root = element<HTMLElement>('#proxima-app');
  root.dataset.proximaFixture = FIXTURE_NAME;
  root.dataset.proximaClock = new Date(FIXED_CLOCK.now()).toISOString();
  root.dataset.proximaIdSeed = DETERMINISTIC_IDS.next('fixture');
  setBootState('ready');
  setText('#boot-mode', 'Fixture mode — bundled vault bytes');
  setText('#boot-status', 'Hydrated');
  bindInteractions();
  render();
}

boot().catch((error: unknown) => {
  setBootState('error');
  setText('#boot-status', 'Fixture boot failed');
  setText('#hydration-summary', error instanceof Error ? error.message : String(error));
});
