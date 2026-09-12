import { calculateElasticTimeline, elasticCardHeights } from '../domain/elastic.js';
import { elasticBoard } from '../domain/selectors.js';
import type { ElasticColumn, ProximaState, Task, TimelineSlice } from '../domain/types.js';
import { projectTaskEditor, TASK_EDITOR_SAVE_NOTE, TASK_EDITOR_SAVE_REFUSAL, type TaskEditorDraft, type TaskEditorEdit } from '../app/taskEditor.js';
import { ELASTIC_EDITOR_HOOKS, NEW_TASK_EDITOR_HOOKS, renderTaskEditorField, taskEditorEditFrom } from './taskEditorFields.js';
import { renderNewTaskModal } from './newTaskModal.js';

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
  /** The Task editor's provisional edits, or null while nothing has been edited. */
  editorDraft: TaskEditorDraft | null;
  dropRefusal: string | null;
  /** Whether this run may write records, and the last refusal the editor produced. */
  taskWrites: TaskModalWriteView;
  /** The New Task form's provisional values, or null while the form is closed. */
  newTaskDraft: TaskEditorDraft | null;
  /** The last refusal the New Task form produced. */
  newTaskRefusal: string | null;
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
  /** One edit of the Task editor's form, before anything is saved. */
  editTask(edit: TaskEditorEdit): void;
  /** Discard the provisional edits and show the record again. */
  cancelTaskEdit(): void;
  /** Write the provisional edits to the record. */
  saveTask(): void;
  /** Delete the record the editor is showing. */
  deleteTask(): void;
  /** Open the New Task form. */
  openNewTask(): void;
  /** Close the New Task form and discard what was typed. */
  cancelNewTask(): void;
  /** One edit of the New Task form. */
  editNewTask(edit: TaskEditorEdit): void;
  /** Create the task the New Task form describes. */
  createTask(): void;
}

/**
 * What the Task editor is allowed to do about writing.
 *
 * `refusal === null` means a record write path exists, and Save and Delete become real controls.
 * Anything else is the typed reason they are not — which is a different thing from a *failed*
 * save, and that is `editorRefusal`, shown beside the form rather than instead of it.
 */
export interface TaskModalWriteView {
  readonly refusal: string | null;
  readonly editorRefusal: string | null;
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
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hour = date.getHours().toString().padStart(2, '0');
  const minute = date.getMinutes().toString().padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function shouldTickElasticProgress(
  sourceMode: 'fixture' | 'external',
  surface: string,
  tasksMode: string,
  lockedAt: string | null,
): boolean {
  return sourceMode === 'external'
    && surface === 'tasks'
    && tasksMode === 'elastic'
    && lockedAt !== null;
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

  return `<div class="task-property-pills" data-papers-visual-key="elastic-properties-${escapeHtml(task.id)}">${entries.map(([key, value]) => `<span class="task-property-pill" data-papers-visual-key="elastic-property-${escapeHtml(task.id)}-${escapeHtml(key)}"><strong>${escapeHtml(labels.get(key) ?? key)}</strong><span>${escapeHtml(propertyText(value))}</span></span>`).join('')}</div>`;
}

function renderDropSlot(column: ElasticColumn, index: number): string {
  return `<div class="elastic-drop-slot" data-papers-visual-key="elastic-drop-${column}-${index}" data-elastic-drop-column="${column}" data-elastic-drop-index="${index}"><div class="elastic-insertion-placeholder" data-papers-visual-key="elastic-placeholder-${column}-${index}" style="height:0px;min-height:0;overflow:hidden;opacity:0;border:1px dashed currentColor;border-radius:8px"></div></div>`;
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

  return `<article class="task-card" draggable="true" data-elastic-action="open-task" data-elastic-task-id="${escapeHtml(task.id)}" data-elastic-column="${column}" data-elastic-height="${height}" data-papers-visual-key="elastic-task-${escapeHtml(task.id)}" style="min-height:${height}px"><div class="task-card-top"><span class="task-status">${escapeHtml(task.status)}</span>${task.isCompleted ? '<span class="task-complete">Done</span>' : ''}</div><h3>${escapeHtml(task.name)}</h3><p>${escapeHtml(task.description || 'No description')}</p>${renderProperties(state, task)}${column === 'running' ? `<div class="elastic-allocation" data-papers-visual-key="elastic-allocation-${escapeHtml(task.id)}"><span>${Math.round(allocation)}m allocated</span><div class="elastic-progress-track"><div class="elastic-progress-fill" data-papers-visual-key="elastic-progress-${escapeHtml(task.id)}" data-progress-ratio="${progress.toFixed(4)}" style="width:${(progress * 100).toFixed(2)}%"></div></div></div>` : ''}<footer><span>${escapeHtml(projectName(projectNames, task))}</span><span${overdue ? ' class="task-overdue"' : ''}>${overdue ? 'Overdue · ' : ''}${escapeHtml(deadlineText)}</span></footer></article>`;
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

  return `<section class="board-column" data-papers-visual-key="board-column-${column}" data-elastic-column-region="${column}" aria-label="${label} column"><header><h3>${label}</h3><span>${tasks.length}</span></header><div class="column-cards">${tasks.length === 0 ? `<p class="empty-state" data-papers-visual-key="board-empty-${column}">No tasks here.</p>` : ''}${pieces.join('')}</div></section>`;
}

/**
 * The Task editor.
 *
 * Everything it shows comes from `projectTaskEditor`, so which fields exist, what each
 * one is worth and which of them are derived is a decision this function consumes rather
 * than makes. What it may *do* about writing is not decided here either: `write.refusal` is the
 * write path's answer, so a form that cannot save says so where the button is and a form that
 * can save lets the write path refuse the save if it has a reason to.
 */
export function renderTaskModal(
  state: ProximaState,
  taskId: string | null,
  draft: TaskEditorDraft | null,
  write: TaskModalWriteView,
): string {
  if (!taskId) return '';
  const editor = projectTaskEditor(state, taskId, draft);
  if (!editor) return '';

  const sections = editor.sections.map((section) => `<fieldset class="task-editor-section" data-papers-visual-key="task-editor-section-${escapeHtml(section.id)}"><legend>${escapeHtml(section.label)}</legend>${section.fields.map((field) => renderTaskEditorField(field, ELASTIC_EDITOR_HOOKS)).join('')}</fieldset>`).join('');
  const note = write.refusal === null
    ? 'Save writes them to the record store.'
    : TASK_EDITOR_SAVE_NOTE;
  const status = editor.dirty
    ? `<p class="task-editor-dirty" data-papers-visual-key="task-editor-dirty" data-task-editor-dirty="true">Unsaved changes. ${escapeHtml(note)}</p>`
    : `<p class="task-editor-clean" data-papers-visual-key="task-editor-clean" data-task-editor-dirty="false">${escapeHtml(write.refusal === null ? 'Nothing has been edited yet.' : note)}</p>`;
  const refusal = write.editorRefusal === null
    ? ''
    : `<p class="diagnostics" data-papers-visual-key="task-editor-refusal" data-task-editor-refusal="${escapeHtml(write.editorRefusal)}">Save refused: ${escapeHtml(write.editorRefusal)}. The record was not changed.</p>`;

  const deleteControl = write.refusal === null
    ? '<button type="button" data-elastic-action="delete-task" data-papers-visual-key="elastic-task-delete">Delete</button>'
    : `<button type="button" data-papers-visual-key="elastic-task-delete" data-task-editor-delete-refusal="${escapeHtml(write.refusal)}" disabled>Delete unavailable</button>`;
  // Save is offered only when there is something to write: a form that matches the record has no
  // save, and the button saying so is clearer than a click that comes back refused.
  const saveControl = write.refusal === null
    ? `<button type="button" data-elastic-action="save-task" data-papers-visual-key="elastic-task-save"${editor.dirty ? '' : ' disabled'}>Save</button>`
    : `<button type="button" data-papers-visual-key="elastic-task-save" data-task-editor-save-refusal="${escapeHtml(write.refusal)}" disabled>Save unavailable</button>`;

  return `<section class="task-modal" role="dialog" aria-modal="true" aria-label="Task editor" data-papers-visual-key="elastic-task-modal" data-task-editor-task-id="${escapeHtml(editor.taskId)}" data-task-editor-field-count="${editor.fieldCount}" data-task-editor-writes="${write.refusal === null ? 'available' : 'unavailable'}"><header><h2>${escapeHtml(editor.title)}</h2><button type="button" data-elastic-action="close-task" data-papers-visual-key="elastic-task-modal-close" aria-label="Close task editor">×</button></header>${status}${refusal}${sections}<footer><button type="button" data-elastic-action="cancel-task-edit" data-papers-visual-key="task-editor-cancel">Cancel changes</button>${deleteControl}${saveControl}</footer></section>`;
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
  const newTaskControl = '<button type="button" data-elastic-action="open-new-task" data-papers-visual-key="elastic-new-task">New task</button>';
  const newTaskModal = options.newTaskDraft === null
    ? ''
    : renderNewTaskModal(options.state, options.newTaskDraft, { refusal: options.taskWrites.refusal, editorRefusal: options.newTaskRefusal });

  return `<section class="surface board-surface" data-papers-visual-key="board-region" aria-label="Elastic board"><header class="surface-header"><div><p class="eyebrow">${escapeHtml(options.selectionLabel)}</p><h2>Elastic Boards</h2><p class="surface-description">Backlog, live execution and finished work.</p></div><span class="surface-count">${options.tasks.length} tasks</span>${newTaskControl}</header><section class="elastic-session-controls" data-papers-visual-key="elastic-session-controls"><label>Execution target<input type="datetime-local" value="${escapeHtml(targetValue)}" data-elastic-action="target" data-papers-visual-key="elastic-target-input"${locked ? ' disabled' : ''}></label>${locked ? '<button type="button" data-elastic-action="unlock" data-papers-visual-key="elastic-unlock">Unlock</button>' : `<button type="button" data-elastic-action="lock" data-papers-visual-key="elastic-lock"${presentation.targetExpired ? ' disabled' : ''}>Lock</button>`}<div class="elastic-run-progress" data-papers-visual-key="elastic-run-progress" data-progress-ratio="${presentation.overallProgress.toFixed(4)}"><div class="elastic-progress-fill" style="width:${(presentation.overallProgress * 100).toFixed(2)}%"></div></div>${presentation.targetExpired ? '<span class="task-overdue" data-papers-visual-key="elastic-target-expired">Target has passed</span>' : ''}</section>${options.dropRefusal ? `<p class="diagnostics" data-papers-visual-key="elastic-drop-refusal">Move unavailable: ${escapeHtml(options.dropRefusal)}. Task data was not changed.</p>` : ''}<div class="board-grid">${renderColumn(options.state, 'backlog', 'Backlog', board.backlog, presentation, options.projectNames, options.now)}${renderColumn(options.state, 'running', 'Running', board.running, presentation, options.projectNames, options.now)}${renderColumn(options.state, 'finished', 'Finished', board.finished, presentation, options.projectNames, options.now)}</div>${renderTaskModal(options.state, options.selectedTaskId, options.editorDraft, options.taskWrites)}${newTaskModal}</section>`;
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
    column.style.outline = '';
    column.style.outlineOffset = '';
  });
}

function clearDragPickup(source: HTMLElement | null): void {
  if (!source) return;
  delete source.dataset.elasticPickup;
  source.style.opacity = '';
  source.style.transform = '';
}

export function bindElasticCockpitInteractions(root: HTMLElement, handlers: ElasticCockpitHandlers): void {
  let draggedTaskId: string | null = null;
  let draggedSource: HTMLElement | null = null;
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
    } else if (action === 'cancel-task-edit') {
      handlers.cancelTaskEdit();
    } else if (action === 'save-task') {
      handlers.saveTask();
    } else if (action === 'delete-task') {
      handlers.deleteTask();
    } else if (action === 'open-new-task') {
      handlers.openNewTask();
    } else if (action === 'cancel-new-task') {
      handlers.cancelNewTask();
    } else if (action === 'create-task') {
      handlers.createTask();
    } else if (action === 'lock') {
      handlers.lock();
    } else if (action === 'unlock') {
      handlers.unlock();
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The editor first: it is the modal that can be open over the board. The New Task form is the
    // other one, and Escape closes whichever is actually there.
    if (root.querySelector('[data-task-editor-task-id]')) {
      handlers.cancelTaskEdit();
      return;
    }
    if (root.querySelector('[data-papers-visual-key="new-task-modal"]')) handlers.cancelNewTask();
  });

  /**
   * The New Task form's own controls.
   *
   * A separate listener over separate attributes on purpose: both forms can be on the board at
   * once, and a shared attribute would have one binder answering the other form's keystroke — the
   * failure the hooks in `taskEditorFields` exist to prevent.
   */
  root.addEventListener('input', (event) => {
    const control = (event.target as HTMLElement).closest<HTMLElement>('[data-new-task-field]');
    if (!control) return;
    const edit = taskEditorEditFrom(root, NEW_TASK_EDITOR_HOOKS, control);
    if (edit !== null) handlers.editNewTask(edit);
  });

  /**
   * A form control reports what it now holds, and the handler decides what that means.
   * A multi-select's group is read as a whole, so unticking one option reports the
   * remaining ones rather than a removal the model would have to infer.
   */
  root.addEventListener('input', (event) => {
    const control = (event.target as HTMLElement).closest<HTMLInputElement>('[data-task-editor-field]');
    if (!control) return;
    const fieldId = control.dataset.taskEditorField;
    if (!fieldId) return;

    if (control.dataset.taskEditorEdit === 'check') {
      handlers.editTask({ fieldId, checked: control.checked });
      return;
    }

    if (control.dataset.taskEditorEdit === 'selection') {
      const selected = Array.from(root.querySelectorAll<HTMLInputElement>(`[data-task-editor-field="${fieldId}"][data-task-editor-option]`))
        .filter((option) => option.checked)
        .map((option) => option.dataset.taskEditorOption ?? '')
        .filter((optionId) => optionId.length > 0);
      handlers.editTask({ fieldId, selected });
      return;
    }

    handlers.editTask({ fieldId, value: control.value });
  });

  root.addEventListener('change', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-elastic-action="target"]');
    if (!input) return;
    const parsed = new Date(input.value);
    if (!Number.isFinite(parsed.getTime())) return;
    handlers.setTarget(parsed.toISOString());
  });

  root.addEventListener('mouseover', (event) => {
    const task = (event.target as HTMLElement).closest<HTMLElement>('[data-elastic-task-id]');
    if (!task) return;
    const related = event.relatedTarget;
    if (related instanceof Node && task.contains(related)) return;
    task.dataset.elasticHover = 'true';
    task.style.outline = '1px solid currentColor';
    task.style.outlineOffset = '2px';
  });

  root.addEventListener('mouseout', (event) => {
    const task = (event.target as HTMLElement).closest<HTMLElement>('[data-elastic-task-id]');
    if (!task) return;
    const related = event.relatedTarget;
    if (related instanceof Node && task.contains(related)) return;
    delete task.dataset.elasticHover;
    task.style.outline = '';
    task.style.outlineOffset = '';
  });

  root.addEventListener('dragstart', (event) => {
    const source = (event.target as HTMLElement).closest<HTMLElement>('[data-elastic-task-id]');
    if (!source) return;
    draggedTaskId = source.dataset.elasticTaskId ?? null;
    draggedSource = source;
    source.dataset.elasticPickup = 'true';
    source.style.opacity = '0.65';
    source.style.transform = 'scale(0.98)';
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
      placeholder.style.height = `${Math.min(90, draggedHeight)}px`;
      placeholder.style.opacity = '1';
    }

    const targetColumn = slot.closest<HTMLElement>('[data-elastic-column-region]');
    if (targetColumn) {
      targetColumn.classList.add('elastic-drag-target');
      targetColumn.style.outline = '2px solid currentColor';
      targetColumn.style.outlineOffset = '2px';
    }
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
    clearDragPickup(draggedSource);
    draggedSource = null;

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
    clearDragPickup(draggedSource);
    draggedSource = null;
  });
}
