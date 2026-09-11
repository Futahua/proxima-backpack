// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bindProjectDeadlinesInteractions, EMPTY_PROJECT_DEADLINES_VIEW, PROJECT_DEADLINES_WRITE_REFUSAL, renderProjectDeadlines, type ProjectDeadlinesViewState } from '../src/browser/projectDeadlines.js';
import { countdownBucketForRemaining, deadlineCalendarProjection } from '../src/browser/timekeepingCockpit.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import type { Project, ProximaState, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';
const now=new Date('2026-09-06T12:00:00.000Z');const project:Project={id:'deadlines-project',source:sourceRef('project','deadlines-project'),name:'Deadlines',description:'',createdAt:'2026-09-01T00:00:00.000Z',status:'active',projectType:'task',linkedFolders:[]};const other={...project,id:'other-project',source:sourceRef('project','other-project')};
const task=(id:string,pid:string,d:string|null,c=false):Task=>({id,source:sourceRef('task',id),name:id,description:'<script>not executable</script>',projectId:pid,status:c?'done':'todo',weight:1,orderIndex:1,isFixedDuration:false,fixedDuration:null,maxDuration:null,isCompleted:c,createdAt:'2026-09-01T00:00:00.000Z',startDate:null,deadline:d,properties:{priority:'high'}});
const state=():ProximaState=>({projects:[project,other],tasks:[task('upcoming',project.id,'2026-09-08T09:00:00.000Z'),task('completed',project.id,'2026-09-05T09:00:00.000Z',true),task('overdue',project.id,'2026-09-04T09:00:00.000Z'),task('undated',project.id,null),task('invalid',project.id,'not-a-date'),task('foreign',other.id,'2026-09-03T09:00:00.000Z')],events:[],statuses:[],taskSchema:[]});
beforeEach(()=>{document.body.innerHTML='';});
describe('Stage 5 slice 8 detailed Deadlines interactions',()=>{
 it('projects deterministic scoped deadline states',()=>{const s=state();document.body.innerHTML=renderProjectDeadlines(s,project,now);expect(document.querySelector('[data-project-deadline-projection]')?.getAttribute('data-project-deadline-projection')).toBe('timekeeping');expect(Array.from(document.querySelectorAll('[data-project-deadline-task-id]')).map(x=>(x as HTMLElement).dataset.projectDeadlineTaskId)).toEqual(['overdue','completed','upcoming']);expect(document.querySelector('[data-project-deadline-task-id="foreign"]')).toBeNull();});
 it('filters locally',()=>{const s=state();let v:ProjectDeadlinesViewState={...EMPTY_PROJECT_DEADLINES_VIEW,projectId:project.id};const r=()=>{document.body.innerHTML=renderProjectDeadlines(s,project,now,v);};r();bindProjectDeadlinesInteractions(document.body,{setFilter:f=>{v={...v,filter:f};r();},openTask:()=>{},closeTask:()=>{}});const h=createInteractionHarness(document);h.click('project-deadlines-filter-overdue');expect(Array.from(document.querySelectorAll('[data-project-deadline-task-id]')).map(x=>(x as HTMLElement).dataset.projectDeadlineTaskId)).toEqual(['overdue']);});
 it('opens escaped read-only inspector',()=>{const s=state();let v:ProjectDeadlinesViewState={...EMPTY_PROJECT_DEADLINES_VIEW,projectId:project.id};const r=()=>{document.body.innerHTML=renderProjectDeadlines(s,project,now,v);};r();bindProjectDeadlinesInteractions(document.body,{setFilter:()=>{},openTask:id=>{v={...v,selectedTaskId:id};r();},closeTask:()=>{v={...v,selectedTaskId:null};r();}});createInteractionHarness(document).click('project-deadline-task-upcoming');expect(document.querySelector('[data-project-deadline-inspector-task-id="upcoming"]')).not.toBeNull();expect(document.querySelector('.project-deadline-task-inspector script')).toBeNull();expect(document.querySelectorAll('[data-project-deadline-write-action]')).toHaveLength(3);expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-project-deadline-write-action]')).every(x=>x.disabled&&x.getAttribute('aria-disabled')==='true'&&x.dataset.projectDeadlineWriteRefusal===PROJECT_DEADLINES_WRITE_REFUSAL)).toBe(true);});
 it('does not leak foreign state',()=>{const v:ProjectDeadlinesViewState={projectId:other.id,filter:'overdue',selectedTaskId:'foreign'};document.body.innerHTML=renderProjectDeadlines(state(),project,now,v);expect(document.querySelector('[data-project-deadline-inspector-task-id]')).toBeNull();expect(document.querySelector('[data-project-deadline-task-id="foreign"]')).toBeNull();});
 it('takes its deadline order and states from the Timekeeping implementation',()=>{
  const s=state();
  const scoped=s.tasks.filter(candidate=>candidate.projectId===project.id);
  const entries=deadlineCalendarProjection(scoped,now);
  document.body.innerHTML=renderProjectDeadlines(s,project,now,{...EMPTY_PROJECT_DEADLINES_VIEW,projectId:project.id});
  const rows=Array.from(document.querySelectorAll<HTMLElement>('[data-project-deadline-task-id]'));
  expect(rows.map(row=>row.dataset.projectDeadlineTaskId)).toEqual(entries.map(entry=>entry.taskId));
  for(const row of rows){
   const entry=entries.find(candidate=>candidate.taskId===row.dataset.projectDeadlineTaskId)!;
   const scopedTask=scoped.find(candidate=>candidate.id===entry.taskId)!;
   expect(row.dataset.projectDeadlineDay).toBe(entry.dayKey);
   expect(row.dataset.projectDeadlineValue).toBe(entry.deadline);
   expect(row.dataset.projectDeadlineState).toBe(scopedTask.isCompleted?'completed':countdownBucketForRemaining(entry.remainingMs)==='overdue'?'overdue':'upcoming');
  }
  const boundary:Task=task('boundary',project.id,now.toISOString());
  document.body.innerHTML=renderProjectDeadlines({...s,tasks:[...s.tasks,boundary]},project,now,{...EMPTY_PROJECT_DEADLINES_VIEW,projectId:project.id});
  expect(document.querySelector<HTMLElement>('[data-project-deadline-task-id="boundary"]')?.dataset.projectDeadlineState).toBe('upcoming');
  expect(countdownBucketForRemaining(0)).toBe('under-one-day');
  expect(readFileSync(resolve(process.cwd(),'src/browser/projectDeadlines.ts'),'utf8')).toContain("import { countdownBucketForRemaining, deadlineCalendarProjection } from './timekeepingCockpit.js';");
});
});
