import { calculateElasticTimeline, elasticCardHeights } from '../domain/elastic.js';
import { elasticBoard } from '../domain/selectors.js';
import type { ElasticColumn, ProximaState, Task, TimelineSlice } from '../domain/types.js';

export interface ElasticSessionView {
  targetTime: string;
  lockedAt: string | null;
}

export interface ElasticExecutionPresentation {
  heights: Record<string, number>;
  allocationMinutes: Record<string, number>;
  progress: Record<string, number>;
  overallProgress: number;
  targetExpired: boolean;
  timeline: TimelineSlice[];
}

export interface ElasticCockpitRenderOptions {
  state: ProximaState;
  tasks: Task[];
  projectNames: Map<string, string>;
  selectionLabel: string;
  session: ElasticSessionView;
  now: Date;
  selectedTaskId: string | null;
  dropRefusal: string | null;
  containerHeight?: number;
}

export interface ElasticMoveIntent {
  taskId: string;
  targetColumn: ElasticColumn;
  targetIndex: number;
}

export interface ElasticCockpitHandlers {
  openTask(taskId: string): void;
  closeTask(): void;
  setTarget(targetTime: string): void;
  lock(): void;
  unlock(): void;
  moveTask(intent: ElasticMoveIntent): void;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function propertyText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item) => propertyText(item)).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function localTargetValue(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

function timelineProgress(slice: TimelineSlice, now: Date): number {
  const start = Date.parse(slice.startTime);
  const end = Date.parse(slice.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end <= start) return now.getTime() >= end ? 1 : 0;
  return clamp((now.getTime() - start) / (end - start));
}

export function elasticExecutionPresentation(
  running: Task[],
  session: ElasticSessionView,
  now: Date,
  containerHeight = 460,
): ElasticExecutionPresentation {
  const target = new Date(session.targetTime);
  const lock = session.lockedAt ? new Date(session.lockedAt) : null;
  const start = lock && Number.isFinite(lock.getTime()) ? lock : now;
  const targetValid = Number.isFinite(target.getTime());
  const timeline = targetValid ? calculateElasticTimeline(running, start, target) : [];
  const heights = elasticCardHeights(running, timeline, containerHeight);
  const allocationMinutes: Record<string, number> = {};
  const progress: Record<string, number> = {};

  for (const task of running) {
    allocationMinutes[task.id] = 0;
    progress[task.id] = 0;
  }

  for (const slice of timeline) {
    allocationMinutes[slice.taskId] = slice.duration;
    if (session.lockedAt !== null) progress[slice.taskId] = timelineProgress(slice, now);
  }

  const overallProgress = session.lockedAt === null || !targetValid
    ? 0
    : clamp((now.getTime() - start.getTime()) / (target.getTime() - start.getTime()));

  return {
    heights,
    allocationMinutes,
    progress,
    overallProgress,
    targetExpired: !targetValid || target.getTime() <= now.getTime(),
    timeline,
  };
}

function projectName(projectNames: Map<string, string>, task: Task): string {
  if (!task.projectId) return 'Uncategorised';
  return projectNames.get(task.projectId) ?? task.projectId;
}

function renderProperties(state: ProximaState, task: Task): string {
  const labels = new Map(state.taskSchema.map((property) => [property.id, property.name]));
  const entries = Object.entries(task.properties);
  if (entries.length === 0) return '';

  return `<div class="task-property-pills" data-c1-key="elastic-properties-${escapeHtml(task.id)}">${entries.map(([key, value]) => `<span class="task-property-pill" data-c1-key="elastic-property-${escapeHtml(task.id)}-${escapeHtml(key)}"><strong>${escapeHtml(labels.get(key) ?? key)}</strong><span>${escapeHtml(propertyText(value))}</span></span>`).join('')}</div>`;
}

function renderDropSlot(column: ElasticColumn, index: number): string {
  return `<div class="elastic-drop-slot" data-c1-key="elastic-drop-${column}-${index}" data-elastic-drop-column="${column}" data-elastic-drop-index="${index}"><div class="elastic-insertion-placeholder" data-c1-key="elastic-placeholder-${column}-${index}" style="height:0px;min-height:0;overflow:hidden;opacity:0;border:1px dashed currentColor;border-radius:8px"></div></div>`;
}

function renderTaskCard(
  state: ProximaState,
  task: Task,
  column: ElasticColumn,
  presentation: ElasticExecutionPresentation,
  projectNames: Map<string, string>,
  now: Date,
): string {
  const runningHeight = presentation.heights[task.id];
  const height = Math.max(125, Math.round(column === 'running' ? runningHeight ?? 125 : 125));
  const deadline = task.deadline ? new Date(task.deadline) : null;
  const deadlineValid = deadline !== null && Number.isFinite(deadline.getTime());
  const overdue = deadlineValid && deadline!.getTime() < now.getTime() && !task.isCompleted;
  const deadlineText = deadlineValid ? deadline!.toLocaleDateString() : 'No deadline';
  const progress = presentation.progress[task.id] ?? 0;
  const allocation = presentation.allocationMinutes[task.id] ?? 0;

  return `<article class="task-card" draggable="true" data-elastic-action="open-task" data-elastic-task-id="${escapeHtml(task.id)}" data-elastic-column="${column}" data-elastic-height="${height}" data-c1-key="elastic-task-${escapeHtml(task.id)}" style="min-height:${height}px"><div class="task-card-top"><span class="task-status">${escapeHtml(task.status)}</span>${task.isCompleted ? '<span class="task-complete">Done</span>' : ''}</div><h3>${escapeHtml(task.name)}</h3><p>${escapeHtml(task.description || 'No description')}</p>${renderProperties(state, task)}${column === 'running' ? `<div class="elastic-allocation" data-c1-key="elastic-allocation-${escapeHtml(task.id)}"><span>${Math.round(allocation)}m allocated</span><div class="elastic-progress-track"><div class="elastic-progress-fill" data-c1-key="elastic-progress-${escapeHtml(task.id)}" data-progress-ratio="${progress.toFixed(4)}" style="width:${(progress * 100).toFixed(2)}%"></div></div></div>` : ''}<footer><span>${escapeHtml(projectName(projectNames, task))}</span><span${overdue ? ' class="task-overdue"' : ''}>${overdue ? 'Overdue · ' : ''}${escapeHtml(deadlineText)}</span></footer></article>`;
}

function renderColumn(
  state: ProximaState,
  column: ElasticColumn,
  label: string,
  tasks: Task[],
  presentation: ElasticExecutionPresentation,
  projectNames: Map<string, string>,
  now: Date,
): string {
  const pieces: string[] = [renderDropSlot(column, 0)];

  tasks.forEach((task, index) => {
    pieces.push(renderTaskCard(state, task, column, presentation, projectNames, now));
    pieces.push(renderDropSlot(column, index + 1));
  });

  return `<section class="board-column" data-c1-key="board-column-${column}" data-elastic-column-region="${column}" aria-label="${label} column"><header><h3>${label}</h3><span>${tasks.length}</span></header><div class="column-cards">${tasks.length === 0 ? `<p class="empty-state" data-c1-key="board-empty-${column}">No tasks here.</p>` : ''}${pieces.join('')}</div></section>`;
}

function renderTaskModal(state: ProximaState, taskId: string | null, projectNames: Map<string, string>): string {
  if (!taskId) return '';
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return '';

  return `<section class="task-modal" role="dialog" aria-modal="true" aria-label="Task quick editor" data-c1-key="elastic-task-modal"><header><h2>${escapeHtml(task.name)}</h2><button type="button" data-elastic-action="close-task" data-c1-key="elastic-task-modal-close" aria-label="Close task editor">×</button></header><label>Name<input data-c1-key="elastic-task-name" value="${escapeHtml(task.name)}" readonly></label><label>Status<input data-c1-key="elastic-task-status" value="${escapeHtml(task.status)}" readonly></label><label>Project<input data-c1-key="elastic-task-project" value="${escapeHtml(projectName(projectNames, task))}" readonly></label><label>Weight<input data-c1-key="elastic-task-weight" value="${escapeHtml(task.weight)}" readonly></label><label>Start<input data-c1-key="elastic-task-start" value="${escapeHtml(task.startDate ?? '')}" readonly></label><label>Deadline<input data-c1-key="elastic-task-deadline" value="${escapeHtml(task.deadline ?? '')}" readonly></label>${renderProperties(state, task)}<footer><button type="button" data-c1-key="elastic-task-delete" disabled>Delete unavailable</button><button type="button" data-c1-key="elastic-task-save" disabled>Save unavailable</button></footer></section>`;
}

export function renderElasticCockpit(options: ElasticCockpitRenderOptions): string {
  const board = elasticBoard(options.tasks, options.state.statuses);
  const presentation = elasticExecutionPresentation(
    board.running,
    options.session,
    options.now,
    options.containerHeight ?? 460,
  );
  const locked = options.session.lockedAt !== null;
  const targetValue = localTargetValue(options.session.targetTime);

  return `<section class="surface board-surface" data-c1-key="board-region" aria-label="Elastic board"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Elastic Boards</h2><p class="surface-description">Backlog, live execution and finished work.</p></div><span class="surface-count">${options.tasks.length} tasks</span></header><section class="elastic-session-controls" data-c1-key="elastic-session-controls"><label>Execution target<input type="datetime-local" value="${escapeHtml(targetValue)}" data-elastic-action="target" data-c1-key="elastic-target-input"${locked ? ' disabled' : ''}></label>${locked ? '<button type="button" data-elastic-action="unlock" data-c1-key="elastic-unlock">Unlock</button>' : `<button type="button" data-elastic-action="lock" data-c1-key="elastic-lock"${presentation.targetExpired ? ' disabled' : ''}>Lock</button>`}<div class="elastic-run-progress" data-c1-key="elastic-run-progress" data-progress-ratio="${presentation.overallProgress.toFixed(4)}"><div class="elastic-progress-fill" style="width:${(presentation.overallProgress * 100).toFixed(2)}%"></div></div>${presentation.targetExpired ? '<span class="task-overdue" data-c1-key="elastic-target-expired">Target has passed</span>' : ''}</section>${options.dropRefusal ? `<p class="diagnostics" data-c1-key="elastic-drop-refusal">Move unavailable: ${escapeHtml(options.dropRefusal)}. Task data was not changed.</p>` : ''}<div class="board-grid">${renderColumn(options.state, 'backlog', 'Backlog', board.backlog, presentation, options.projectNames, options.now)}${renderColumn(options.state, 'running', 'Running', board.running, presentation, options.projectNames, options.now)}${renderColumn(options.state, 'finished', 'Finished', board.finished, presentation, options.projectNames, options.now)}</div>${renderTaskModal(options.state, options.selectedTaskId, options.projectNames)}</section>`;
}

function clearDragFeedback(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-elastic-drop-column]').forEach((slot) => {
    delete slot.dataset.elasticPreview;
  });
  root.querySelectorAll<HTMLElement>('.elastic-insertion-placeholder').forEach((placeholder) => {
    placeholder.style.height = '0px';
    placeholder.style.opacity = '0';
  });
  root.querySelectorAll<HTMLElement>('[data-elastic-column-region]').forEach((column) => {
    column.classList.remove('elastic-drag-target');
  });
}

export function bindElasticCockpitInteractions(root: HTMLElement, handlers: ElasticCockpitHandlers): void {
  let draggedTaskId: string | null = null;
  let draggedHeight = 125;

  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement).closest<HTMLElement>('[data-elastic-action]');
    if (!control) return;

    const action = control.dataset.elasticAction;
    if (action === 'open-task') {
      const taskId = control.dataset.elasticTaskId;
      if (taskId) handlers.openTask(taskId);
    } else if (action === 'close-task') {
      handlers.closeTask();
    } else if (action === 'lock') {
      handlers.lock();
    } else if (action === 'unlock') {
      handlers.unlock();
    }
  });

  root.addEventListener('change', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-elastic-action="target"]');
    if (!input) return;
    const parsed = new Date(input.value);
    if (!Number.isFinite(parsed.getTime())) return;
    handlers.setTarget(parsed.toISOString());
  });

  root.addEventListener('dragstart', (event) => {
    const source = (event.target as HTMLElement).closest<HTMLElement>('[data-elastic-task-id]');
    if (!source) return;
    draggedTaskId = source.dataset.elasticTaskId ?? null;
    const height = Number(source.dataset.elasticHeight);
    draggedHeight = Number.isFinite(height) && height > 0 ? height : 125;
    if (draggedTaskId) event.dataTransfer?.setData('text/plain', draggedTaskId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });

  root.addEventListener('dragover', (event) => {
    if (!draggedTaskId) return;
    const slot = (event.target as HTMLElement).closest<HTMLElement>('[data-elastic-drop-column]');
    if (!slot) return;

    event.preventDefault();
    clearDragFeedback(root);
    slot.dataset.elasticPreview = 'true';

    const placeholder = slot.querySelector<HTMLElement>('.elastic-insertion-placeholder');
    if (placeholder) {
      placeholder.style.height = `${draggedHeight}px`;
      placeholder.style.opacity = '1';
    }

    slot.closest<HTMLElement>('[data-elastic-column-region]')?.classList.add('elastic-drag-target');
  });

  root.addEventListener('drop', (event) => {
    if (!draggedTaskId) return;
    const slot = (event.target as HTMLElement).closest<HTMLElement>('[data-elastic-drop-column]');
    if (!slot) return;

    event.preventDefault();
    const targetColumn = slot.dataset.elasticDropColumn;
    const targetIndex = Number(slot.dataset.elasticDropIndex);
    const taskId = draggedTaskId;
    draggedTaskId = null;
    clearDragFeedback(root);

    if (
      (targetColumn === 'backlog' || targetColumn === 'running' || targetColumn === 'finished')
      && Number.isInteger(targetIndex)
      && targetIndex >= 0
    ) {
      handlers.moveTask({ taskId, targetColumn, targetIndex });
    }
  });

  root.addEventListener('dragend', () => {
    draggedTaskId = null;
    clearDragFeedback(root);
  });
}
