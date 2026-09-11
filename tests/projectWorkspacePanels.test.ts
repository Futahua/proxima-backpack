// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectWorkspaceTab } from '../src/app/actionProtocol.js';
import { loadProjectNotePreview, loadProjectNotesTree } from '../src/app/projectNotes.js';
import { renderProjectsHub } from '../src/browser/projectsHub.js';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import type { CalendarEvent, Project, ProximaState, StatusDefinition, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';
const NOW=new Date('2026-09-06T12:00:00.000Z');
const project:Project={id:'mixed-project',source:sourceRef('project','mixed-project'),name:'Mixed Project',description:'Tasks and events coexist here.',createdAt:'2026-08-01T00:00:00.000Z',status:'active',projectType:'schedule',linkedFolders:[{name:'Research',path:'Projects/Mixed/Research'},{name:'Notes',path:'Projects/Mixed/Notes'}]};
const otherProject:Project={...project,id:'other-project',source:sourceRef('project','other-project'),name:'Other Project',linkedFolders:[]};
const statuses:StatusDefinition[]=[{id:'todo',name:'Todo',color:'#112233',column:'backlog'},{id:'doing',name:'Doing',color:'#445566',column:'running'},{id:'done',name:'Done',color:'#778899',column:'finished'}];
function task(id:string,projectId:string,status:string,orderIndex:number,deadline:string|null):Task{return{id,source:sourceRef('task',id),name:id,description:`${id} description`,projectId,status,weight:1,orderIndex,isFixedDuration:false,fixedDuration:null,maxDuration:null,isCompleted:status==='done',createdAt:'2026-09-01T00:00:00.000Z',startDate:null,deadline,properties:{}};}
function calendarEvent(id:string,projectId:string,startDate:string):CalendarEvent{return{id,source:sourceRef('event',id),name:id,description:`${id} description`,projectId,createdAt:'2026-09-01T00:00:00.000Z',startDate,deadline:new Date(Date.parse(startDate)+60*60*1000).toISOString(),isCompleted:false,properties:{}};}
function workspaceState():ProximaState{return{projects:[project,otherProject],tasks:[task('shared-task',project.id,'todo',2,'2026-09-08T09:00:00.000Z'),task('first-task',project.id,'doing',1,null),task('completed-task',project.id,'done',3,'2026-09-05T09:00:00.000Z'),task('other-task',otherProject.id,'todo',0,'2026-09-07T09:00:00.000Z')],events:[calendarEvent('mixed-event',project.id,'2026-09-07T10:00:00.000Z'),calendarEvent('other-event',otherProject.id,'2026-09-07T11:00:00.000Z')],statuses,taskSchema:[]};}
function renderTab(state:ProximaState,tab:ProjectWorkspaceTab):void{document.body.innerHTML=renderProjectsHub({state,selection:project.id,filter:'active',workspaceTab:tab,now:NOW});}
beforeEach(()=>{document.body.innerHTML='';});
describe('Stage 5 read-only project workspace panels',()=>{
 it('renders truthful project-scoped content in all five workspace tabs without projectType gating or record mutation',()=>{const state=workspaceState();const before=JSON.stringify(state);for(const tab of ['notes','task-board','backlog','deadlines','schedule'] as const){renderTab(state,tab);expect(document.querySelector<HTMLElement>('[data-project-workspace-panel]')?.dataset.projectWorkspacePanel).toBe(tab);expect(document.querySelector(`[data-c1-key="project-workspace-${tab}"]`)).not.toBeNull();expect(JSON.stringify(state)).toBe(before);}renderTab(state,'notes');expect(document.querySelectorAll('[data-project-note-root]')).toHaveLength(2);expect(document.querySelector('[data-project-note-root-path="Projects/Mixed/Research"]')).not.toBeNull();renderTab(state,'task-board');expect(document.querySelector('[data-project-board-task-id="shared-task"]')).not.toBeNull();expect(document.querySelector('[data-project-board-task-id="other-task"]')).toBeNull();renderTab(state,'backlog');expect(document.querySelector('[data-project-backlog-task-id="shared-task"]')).not.toBeNull();expect(document.querySelector('[data-project-backlog-task-id="other-task"]')).toBeNull();renderTab(state,'deadlines');expect(document.querySelector('[data-project-deadline-task-id="shared-task"]')).not.toBeNull();expect(document.querySelector('[data-project-deadline-task-id="other-task"]')).toBeNull();renderTab(state,'schedule');expect(document.querySelector('[data-project-schedule-event-id="mixed-event"]')).not.toBeNull();expect(document.querySelector('[data-project-schedule-event-id="other-event"]')).toBeNull();expect(JSON.stringify(state)).toBe(before);});
 it('keeps task ordering deterministic and reuses the Timekeeping deadline projection',()=>{const state=workspaceState();renderTab(state,'backlog');expect(Array.from(document.querySelectorAll<HTMLElement>('[data-project-backlog-task-id]')).map((row)=>row.dataset.projectBacklogTaskId)).toEqual(['first-task','shared-task','completed-task']);renderTab(state,'deadlines');expect(document.querySelector<HTMLElement>('[data-project-workspace-panel="deadlines"]')?.dataset.projectDeadlineProjection).toBe('timekeeping');expect(Array.from(document.querySelectorAll<HTMLElement>('[data-project-deadline-task-id]')).map((row)=>row.dataset.projectDeadlineTaskId)).toEqual(['completed-task','shared-task']);expect(document.querySelector<HTMLElement>('[data-project-deadline-task-id="shared-task"]')?.dataset.projectDeadlineDay).toBe('2026-09-08');});
 it('keeps Schedule bounded while Notes, Task Board, Backlog and Deadlines expose local interactions',()=>{const state=workspaceState();const before=JSON.stringify(state);renderTab(state,'schedule');const schedule=document.querySelector<HTMLElement>('[data-project-workspace-panel="schedule"]');expect(schedule!.querySelector('[draggable="true"]')).toBeNull();expect(schedule!.querySelectorAll('[data-project-schedule-action="set-filter"]')).toHaveLength(5);renderTab(state,'task-board');const board=document.querySelector<HTMLElement>('[data-project-workspace-panel="task-board"]');expect(board!.querySelectorAll('[draggable="true"]')).toHaveLength(3);renderTab(state,'backlog');const backlog=document.querySelector<HTMLElement>('[data-project-workspace-panel="backlog"]');expect(backlog!.querySelectorAll('[draggable="true"]')).toHaveLength(3);renderTab(state,'deadlines');const deadlines=document.querySelector<HTMLElement>('[data-project-workspace-panel="deadlines"]');expect(deadlines!.querySelectorAll('[data-project-deadlines-action="set-filter"]')).toHaveLength(4);expect(JSON.stringify(state)).toBe(before);});
 it('renders the same workspace panel whatever projectType claims',()=>{
  const asSchedule=workspaceState();
  const asTask:ProximaState={...asSchedule,projects:[{...asSchedule.projects[0]!,projectType:'task'},asSchedule.projects[1]!]};
  const panel=(state:ProximaState,tab:ProjectWorkspaceTab)=>{
   document.body.innerHTML=renderProjectsHub({state,selection:project.id,filter:'active',workspaceTab:tab,now:NOW});
   return document.querySelector<HTMLElement>('[data-project-workspace-panel]')?.outerHTML;
  };
  for(const tab of ['notes','task-board','backlog','deadlines','schedule'] as const){
   const schedulePanel=panel(asSchedule,tab);
   expect(schedulePanel).not.toBeUndefined();
   expect(panel(asTask,tab)).toBe(schedulePanel);
  }
 });
 it('switches the open project in the cockpit without changing records or vault bytes',async()=>{
  const state=workspaceState();
  const before=JSON.stringify(state);
  const vault=createMemoryVault({'Projects/Mixed/Research/note.md':'# Note','Projects/Mixed/Notes/other.md':'# Other'});
  const open=(selection:string)=>{
   document.body.innerHTML=renderProjectsHub({state,selection,filter:'active',workspaceTab:'task-board',now:NOW});
   return document.querySelector<HTMLElement>('[data-project-workspace-panel="task-board"]');
  };
  const first=open(project.id);
  expect(first?.dataset.projectBoardProjectId).toBe(project.id);
  expect(first?.querySelector('[data-project-board-task-id="shared-task"]')).not.toBeNull();
  expect(first?.querySelector('[data-project-board-task-id="other-task"]')).toBeNull();
  expect(JSON.stringify(state)).toBe(before);
  const second=open(otherProject.id);
  expect(second?.dataset.projectBoardProjectId).toBe(otherProject.id);
  expect(second?.querySelector('[data-project-board-task-id="shared-task"]')).toBeNull();
  expect(second?.querySelector('[data-project-board-task-id="other-task"]')).not.toBeNull();
  expect(JSON.stringify(state)).toBe(before);
  const tree=await loadProjectNotesTree(vault,project);
  expect(tree.fileCount).toBe(2);
  expect(tree.roots.map(root=>root.status)).toEqual(['ready','ready']);
  const preview=await loadProjectNotePreview(vault,'Projects/Mixed/Research/note.md');
  expect(preview.preview?.kind).toBe('markdown');
  expect((await vault.read('Projects/Mixed/Research/note.md')).text).toBe('# Note');
  expect(JSON.stringify(state)).toBe(before);
 });
});
