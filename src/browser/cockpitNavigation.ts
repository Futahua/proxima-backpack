import type {
  ProjectWorkspaceTab,
  ScheduleMode,
  Surface,
  TasksMode,
} from '../app/actionProtocol.js';

export interface CockpitNavigationState {
  surface: Surface;
  tasksMode: TasksMode;
  scheduleMode: ScheduleMode;
  projectWorkspaceTab: ProjectWorkspaceTab;
}

function tab(
  selected: boolean,
  action: string,
  dataName: string,
  dataValue: string,
  key: string,
  label: string,
): string {
  return `<button type="button" class="surface-tab${selected ? ' selected' : ''}" data-action="${action}" data-${dataName}="${dataValue}" role="tab" aria-selected="${selected}" data-papers-visual-key="${key}">${label}</button>`;
}

export function cockpitSubmode(state: CockpitNavigationState): string | null {
  if (state.surface === 'tasks') return state.tasksMode;
  if (state.surface === 'schedule') return state.scheduleMode;
  if (state.surface === 'projects') return state.projectWorkspaceTab;
  return null;
}

export function renderCockpitNavigation(state: CockpitNavigationState): string {
  const primary = [
    tab(state.surface === 'tasks', 'switch-surface', 'surface', 'tasks', 'surface-tab-tasks', 'Tasks'),
    tab(state.surface === 'schedule', 'switch-surface', 'surface', 'schedule', 'surface-tab-schedule', 'Schedule'),
    tab(state.surface === 'projects', 'switch-surface', 'surface', 'projects', 'surface-tab-projects', 'Projects Hub'),
    tab(state.surface === 'canvas', 'switch-surface', 'surface', 'canvas', 'surface-tab-canvas', 'Canvas'),
  ].join('');

  let secondary = '';

  if (state.surface === 'tasks') {
    secondary = [
      tab(state.tasksMode === 'elastic', 'select-tasks-mode', 'tasks-mode', 'elastic', 'tasks-mode-elastic', 'Elastic Boards'),
      tab(state.tasksMode === 'timekeeping', 'select-tasks-mode', 'tasks-mode', 'timekeeping', 'tasks-mode-timekeeping', 'Timekeeping'),
    ].join('');
  } else if (state.surface === 'schedule') {
    secondary = [
      tab(state.scheduleMode === 'day', 'select-schedule-mode', 'schedule-mode', 'day', 'schedule-mode-day', 'Day'),
      tab(state.scheduleMode === 'four-day', 'select-schedule-mode', 'schedule-mode', 'four-day', 'schedule-mode-four-day', '4-Day'),
      tab(state.scheduleMode === 'week', 'select-schedule-mode', 'schedule-mode', 'week', 'schedule-mode-week', 'Week'),
      tab(state.scheduleMode === 'month', 'select-schedule-mode', 'schedule-mode', 'month', 'schedule-mode-month', 'Month'),
      tab(state.scheduleMode === 'year', 'select-schedule-mode', 'schedule-mode', 'year', 'schedule-mode-year', 'Year'),
      tab(state.scheduleMode === 'agenda', 'select-schedule-mode', 'schedule-mode', 'agenda', 'schedule-mode-agenda', 'Agenda'),
    ].join('');
  } else if (state.surface === 'projects') {
    secondary = [
      tab(state.projectWorkspaceTab === 'notes', 'select-project-workspace-tab', 'project-tab', 'notes', 'project-tab-notes', 'Notes'),
      tab(state.projectWorkspaceTab === 'task-board', 'select-project-workspace-tab', 'project-tab', 'task-board', 'project-tab-task-board', 'Task Board'),
      tab(state.projectWorkspaceTab === 'backlog', 'select-project-workspace-tab', 'project-tab', 'backlog', 'project-tab-backlog', 'Backlog'),
      tab(state.projectWorkspaceTab === 'deadlines', 'select-project-workspace-tab', 'project-tab', 'deadlines', 'project-tab-deadlines', 'Deadlines'),
      tab(state.projectWorkspaceTab === 'schedule', 'select-project-workspace-tab', 'project-tab', 'schedule', 'project-tab-schedule', 'Schedule'),
    ].join('');
  }

  return `<div class="cockpit-navigation" data-papers-visual-key="cockpit-navigation"><div class="surface-switcher" data-papers-visual-key="surface-switcher" role="tablist" aria-label="Proxima surfaces">${primary}</div>${secondary ? `<div class="surface-switcher secondary" data-papers-visual-key="subsurface-switcher" role="tablist" aria-label="Current workspace">${secondary}</div>` : ''}</div>`;
}
