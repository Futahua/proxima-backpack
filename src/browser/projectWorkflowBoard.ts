/**
 * The project workflow board: columns are stages, and a drop moves a task between them.
 *
 * This is a board of its own rather than a mode of the status board, and the reason is the whole
 * point of HARD GATE A2. The status board groups by execution state — Backlog, Running, Finished —
 * which is the Elastic question. This one groups by **project workflow stage**, which is an
 * independent question with an independent answer: a task sitting in Review is still Running, and a
 * board that folded one into the other would be the silo A4 removed.
 *
 * So a card here shows both facts: which stage column it is in, and what its execution state is.
 * The machine keys and attributes are this surface's own (`data-project-workflow-*`) for the same
 * reason the two Task editors have separate hooks — both boards can be on the page, and one binder
 * answering the other's drop is exactly the failure that namespace prevents.
 *
 * A task in no stage still has to be reachable, so the board appends a "No stage" column rather
 * than hiding it — the same rule the status board uses for a status the vault never declared.
 */
import type { Project, ProximaState, Task, WorkflowStage } from '../domain/types.js';

/** The stage id a drop into the trailing column carries: no stage at all. */
export const NO_WORKFLOW_STAGE = '' as const;

export interface ProjectWorkflowMoveIntent {
  readonly taskId: string;
  /** Null when the drop leaves the workflow, which is the trailing column. */
  readonly targetStageId: string | null;
  readonly targetIndex: number;
}

export interface ProjectWorkflowBoardViewState {
  projectId: string | null;
  selectedTaskId: string | null;
  dragTaskId: string | null;
  /** The column under the pointer, or null while no column is previewed. */
  dragTargetStageId: string | null;
  dragTargetIndex: number | null;
  writeRefusal: string | null;
  lastRefusedMove: ProjectWorkflowMoveIntent | null;
}

export const EMPTY_PROJECT_WORKFLOW_BOARD_VIEW: ProjectWorkflowBoardViewState = {
  projectId: null,
  selectedTaskId: null,
  dragTaskId: null,
  dragTargetStageId: null,
  dragTargetIndex: null,
  writeRefusal: null,
  lastRefusedMove: null,
};

export interface ProjectWorkflowBoardHandlers {
  openTask(taskId: string): void;
  closeTask(): void;
  startDrag(taskId: string): void;
  previewMove(intent: ProjectWorkflowMoveIntent): void;
  /** A drop the board could not complete locally: the shell decides what the write means. */
  dropMove(intent: ProjectWorkflowMoveIntent): void;
  clearDrag(): void;
}

/** The stages this project declares, in the order the state carries them. */
export function workflowStagesFor(state: ProximaState, project: Project): WorkflowStage[] {
  return (state.workflowStages ?? []).filter((stage) => stage.projectId === project.id);
}

/** True when this project has a workflow to group by: a legacy vault declares none. */
export function projectHasWorkflow(state: ProximaState, project: Project): boolean {
  return workflowStagesFor(state, project).length > 0;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Workflow order first: a task with no position sorts after the ones that have one. */
function byWorkflowOrder(left: Task, right: Task): number {
  const leftOrder = typeof left.workflowOrder === 'number' ? left.workflowOrder : Number.MAX_SAFE_INTEGER;
  const rightOrder = typeof right.workflowOrder === 'number' ? right.workflowOrder : Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder || left.id.localeCompare(right.id);
}

function stageKeyOf(stageId: string | null): string {
  return stageId === null ? 'no-stage' : stageId;
}

function card(task: Task, selected: string | null): string {
  const isSelected = task.id === selected;
  return `<button type="button" class="project-board-task project-workflow-task${task.isCompleted ? ' completed' : ''}${isSelected ? ' selected' : ''}" draggable="true" data-project-workflow-action="open-task" data-project-workflow-task-id="${escapeHtml(task.id)}" data-project-workflow-stage="${escapeHtml(task.workflowStageId ?? '')}" data-project-workflow-execution-state="${escapeHtml(task.status)}" data-c1-key="project-workflow-task-${escapeHtml(task.id)}" aria-pressed="${isSelected}"><span class="project-board-task-top"><span class="task-status">${escapeHtml(task.status)}</span>${task.isCompleted ? '<span class="task-complete">Done</span>' : ''}</span><strong>${escapeHtml(task.name)}</strong><span class="project-board-task-description">${escapeHtml(task.description || 'No description')}</span><small>${escapeHtml(task.deadline ?? 'No deadline')}</small></button>`;
}

function column(input: {
  project: Project;
  stageId: string | null;
  label: string;
  tasks: readonly Task[];
  selected: string | null;
  previewTarget: boolean;
}): string {
  const key = stageKeyOf(input.stageId);
  const dropStage = input.stageId ?? NO_WORKFLOW_STAGE;
  const slots = (index: number): string => `<div class="project-board-drop-slot" data-project-workflow-drop-stage="${escapeHtml(dropStage)}" data-project-workflow-drop-index="${index}" data-c1-key="project-workflow-drop-${escapeHtml(input.project.id)}-${escapeHtml(key)}-${index}"><div class="project-board-insertion-placeholder"></div></div>`;
  const cards = input.tasks.map((task, index) => card(task, input.selected) + slots(index + 1)).join('');

  return `<section class="project-board-column project-workflow-column" data-project-workflow-stage-column="${escapeHtml(key)}" data-project-workflow-drag-target="${input.previewTarget ? 'true' : 'false'}" data-c1-key="project-workflow-column-${escapeHtml(key)}"><header><strong>${escapeHtml(input.label)}</strong><span>${input.tasks.length}</span></header><div class="project-board-column-cards">${input.tasks.length === 0 ? '<p class="empty-state">No tasks.</p>' : ''}${slots(0)}${cards}</div></section>`;
}

function inspector(state: ProximaState, project: Project, task: Task): string {
  const stage = workflowStagesFor(state, project).find((candidate) => candidate.id === task.workflowStageId);
  return `<section class="project-board-task-inspector" role="dialog" aria-label="Task details" data-project-workflow-inspector-task-id="${escapeHtml(task.id)}" data-c1-key="project-workflow-task-inspector"><header><div><small>Task details</small><h3>${escapeHtml(task.name)}</h3></div><button type="button" class="icon-button" data-project-workflow-action="close-task" data-c1-key="project-workflow-inspector-close" aria-label="Close task details">×</button></header><p>${escapeHtml(task.description || 'No description')}</p><dl class="project-board-task-properties"><div data-project-workflow-detail="stage"><dt>Workflow stage</dt><dd>${escapeHtml(stage?.name ?? 'No stage')}</dd></div><div data-project-workflow-detail="execution-state"><dt>Execution state</dt><dd>${escapeHtml(task.status)}</dd></div><div data-project-workflow-detail="deadline"><dt>Deadline</dt><dd>${escapeHtml(task.deadline ?? 'No deadline')}</dd></div></dl></section>`;
}

/**
 * Draw the workflow board.
 *
 * @param state - the loaded world, which supplies this project's stages and tasks.
 * @param project - the project whose workflow is being shown.
 * @param view - the surface's own state: selection, drag preview and the last refusal.
 * @returns the board's markup.
 */
export function renderProjectWorkflowBoard(
  state: ProximaState,
  project: Project,
  view: ProjectWorkflowBoardViewState = EMPTY_PROJECT_WORKFLOW_BOARD_VIEW,
): string {
  const stages = workflowStagesFor(state, project);
  const tasks = state.tasks.filter((task) => task.projectId === project.id);
  const active = view.projectId === project.id;
  const selected = active ? view.selectedTaskId : null;
  const unstaged = tasks.filter((task) => task.workflowStageId === null || task.workflowStageId === undefined);

  const columns = [
    ...stages.map((stage) => column({
      project,
      stageId: stage.id,
      label: stage.name,
      tasks: tasks.filter((task) => task.workflowStageId === stage.id).sort(byWorkflowOrder),
      selected,
      previewTarget: active && view.dragTargetStageId === stage.id,
    })),
    column({
      project,
      stageId: null,
      label: 'No stage',
      tasks: [...unstaged].sort(byWorkflowOrder),
      selected,
      previewTarget: active && view.dragTargetStageId === NO_WORKFLOW_STAGE,
    }),
  ].join('');

  const selectedTask = selected === null ? undefined : tasks.find((task) => task.id === selected);
  const inspectorMarkup = selectedTask === undefined ? '' : inspector(state, project, selectedTask);
  const refusal = active && view.writeRefusal !== null
    ? `<p class="diagnostics" data-project-workflow-write-refusal="${escapeHtml(view.writeRefusal)}">Workflow drop refused: ${escapeHtml(view.writeRefusal)}. No task was changed.</p>`
    : '';

  return `<section class="project-workspace-panel project-workflow-board" data-project-workflow-project-id="${escapeHtml(project.id)}" data-project-workflow-stage-count="${stages.length}" data-c1-key="project-workflow-board"><header><h3>Task board</h3><small>${stages.length} workflow ${stages.length === 1 ? 'stage' : 'stages'} · ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}</small></header><div class="project-board-grid project-workflow-grid">${columns}</div>${refusal}${inspectorMarkup}</section>`;
}

function markPreview(root: HTMLElement, stage: string | null, slot: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-project-workflow-stage-column]').forEach((element) => {
    element.dataset.projectWorkflowDragTarget = element.dataset.projectWorkflowStageColumn === stageKeyOf(stage) ? 'true' : 'false';
  });
  root.querySelectorAll<HTMLElement>('.project-board-insertion-placeholder').forEach((placeholder) => {
    placeholder.style.height = '0px';
    placeholder.style.opacity = '0';
  });
  const placeholder = slot.querySelector<HTMLElement>('.project-board-insertion-placeholder');
  if (placeholder !== null) {
    placeholder.style.height = '54px';
    placeholder.style.opacity = '1';
  }
}

/**
 * Bind the workflow board's own interactions.
 *
 * The attributes are this surface's, so a status board on the same page cannot answer its drops —
 * and a drop is reported rather than performed: what a workflow move *means* is the app layer's,
 * which is why the binder hands over an intent instead of writing anything.
 */
export function bindProjectWorkflowBoardInteractions(root: HTMLElement, handlers: ProjectWorkflowBoardHandlers): void {
  let drag: string | null = null;

  root.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement).closest<HTMLElement>('[data-project-workflow-action]');
    if (!control || !root.contains(control)) return;
    if (control.dataset.projectWorkflowAction === 'open-task' && control.dataset.projectWorkflowTaskId) {
      handlers.openTask(control.dataset.projectWorkflowTaskId);
    } else if (control.dataset.projectWorkflowAction === 'close-task') {
      handlers.closeTask();
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!root.querySelector('[data-project-workflow-inspector-task-id]')) return;
    event.preventDefault();
    handlers.closeTask();
  });

  root.addEventListener('dragstart', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-project-workflow-task-id]');
    if (!card || !root.contains(card) || !card.dataset.projectWorkflowTaskId) return;
    drag = card.dataset.projectWorkflowTaskId;
    (event as DragEvent).dataTransfer?.setData('text/plain', drag);
    handlers.startDrag(drag);
  });

  const slotUnder = (event: DragEvent): { slot: HTMLElement; stageId: string | null; index: number } | null => {
    const slot = (event.target as HTMLElement).closest<HTMLElement>('[data-project-workflow-drop-stage]');
    if (!slot || !root.contains(slot)) return null;
    const raw = slot.dataset.projectWorkflowDropStage;
    const index = Number(slot.dataset.projectWorkflowDropIndex);
    if (raw === undefined || !Number.isInteger(index)) return null;
    return { slot, stageId: raw === NO_WORKFLOW_STAGE ? null : raw, index };
  };

  root.addEventListener('dragover', (event) => {
    if (drag === null) return;
    const target = slotUnder(event as DragEvent);
    if (target === null) return;
    event.preventDefault();
    target.slot.dataset.projectWorkflowPreview = 'true';
    markPreview(root, target.stageId, target.slot);
    handlers.previewMove({ taskId: drag, targetStageId: target.stageId, targetIndex: target.index });
  });

  root.addEventListener('drop', (event) => {
    if (drag === null) return;
    const target = slotUnder(event as DragEvent);
    if (target === null) return;
    event.preventDefault();
    const taskId = drag;
    drag = null;
    handlers.dropMove({ taskId, targetStageId: target.stageId, targetIndex: target.index });
  });

  root.addEventListener('dragend', () => {
    drag = null;
    root.querySelectorAll<HTMLElement>('[data-project-workflow-stage-column]').forEach((element) => {
      element.dataset.projectWorkflowDragTarget = 'false';
    });
    handlers.clearDrag();
  });
}
