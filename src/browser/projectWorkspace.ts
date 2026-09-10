import type { ProjectWorkspaceTab } from '../app/actionProtocol.js';
import type { Project, ProximaState } from '../domain/types.js';
import { EMPTY_PROJECT_NOTES_VIEW, renderProjectNotes, type ProjectNotesViewState } from './projectNotes.js';
import { EMPTY_PROJECT_TASK_BOARD_VIEW, renderProjectTaskBoard, type ProjectTaskBoardViewState } from './projectTaskBoard.js';
import { EMPTY_PROJECT_BACKLOG_VIEW, renderProjectBacklog, type ProjectBacklogViewState } from './projectBacklog.js';
import { EMPTY_PROJECT_DEADLINES_VIEW, renderProjectDeadlines, type ProjectDeadlinesViewState } from './projectDeadlines.js';
import { EMPTY_PROJECT_SCHEDULE_VIEW, renderProjectSchedule, type ProjectScheduleViewState } from './projectSchedule.js';
export interface ProjectWorkspaceRenderOptions { state:ProximaState; project:Project; tab:ProjectWorkspaceTab; now:Date; notes?:ProjectNotesViewState; taskBoard?:ProjectTaskBoardViewState; backlog?:ProjectBacklogViewState; deadlines?:ProjectDeadlinesViewState; schedule?:ProjectScheduleViewState; }
export function renderProjectWorkspace(options:ProjectWorkspaceRenderOptions):string { if(options.tab==='notes')return renderProjectNotes(options.project,options.notes??EMPTY_PROJECT_NOTES_VIEW); if(options.tab==='task-board')return renderProjectTaskBoard(options.state,options.project,options.taskBoard??EMPTY_PROJECT_TASK_BOARD_VIEW); if(options.tab==='backlog')return renderProjectBacklog(options.state,options.project,options.backlog??EMPTY_PROJECT_BACKLOG_VIEW); if(options.tab==='deadlines')return renderProjectDeadlines(options.state,options.project,options.now,options.deadlines??EMPTY_PROJECT_DEADLINES_VIEW); return renderProjectSchedule(options.state,options.project,options.now,options.schedule??EMPTY_PROJECT_SCHEDULE_VIEW); }
