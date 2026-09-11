import type { ActionErrorCode } from '../app/actionProtocol.js';
import type { Project, ProximaState, Task } from '../domain/types.js';
import type { BacklogViewState } from '../app/backlogView.js';
import { projectBacklog } from '../app/backlogView.js';
import { EMPTY_BACKLOG_QUERY, type BacklogQuery } from '../domain/backlogQuery.js';
export type ProjectBacklogWriteRefusal=Extract<ActionErrorCode,'action-not-available'>;
export const PROJECT_BACKLOG_WRITE_REFUSAL:ProjectBacklogWriteRefusal='action-not-available';
export interface ProjectBacklogMoveIntent{taskId:string;targetIndex:number;}
/**
 * The Backlog's view state: the shared projection state (selected project, the query)
 * plus the interaction state only the browser layer owns.
 */
export interface ProjectBacklogViewState extends BacklogViewState{dragTaskId:string|null;dragTargetIndex:number|null;writeRefusal:ProjectBacklogWriteRefusal|null;lastRefusedMove:ProjectBacklogMoveIntent|null;}
export const EMPTY_PROJECT_BACKLOG_VIEW:ProjectBacklogViewState={projectId:null,selectedTaskId:null,query:EMPTY_BACKLOG_QUERY,dragTaskId:null,dragTargetIndex:null,writeRefusal:null,lastRefusedMove:null};
export interface ProjectBacklogHandlers{openTask(taskId:string):void;closeTask():void;startDrag(taskId:string):void;previewMove(intent:ProjectBacklogMoveIntent):void;refuseMove(intent:ProjectBacklogMoveIntent):void;clearDrag():void;}
const esc=(v:unknown)=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const ord=(a:Task,b:Task)=>(Number(a.orderIndex)||0)-(Number(b.orderIndex)||0)||a.id.localeCompare(b.id);
/**
 * Render one project Backlog.
 *
 * The rows come from `projectBacklog`, so search, filters and ordering are the
 * projection's decisions rather than the renderer's, and the same decisions are
 * covered by tests. Every `data-project-backlog-*` hook below is consumed by
 * `bindProjectBacklogInteractions` or by `main.ts` and must not be renamed
 * without changing them.
 */
export function renderProjectBacklog(state:ProximaState,project:Project,view:ProjectBacklogViewState=EMPTY_PROJECT_BACKLOG_VIEW):string{
  const projection=projectBacklog(state,project,view);
  const ts=state.tasks.filter(t=>t.projectId===project.id).sort(ord);
  const active=view.projectId===project.id;
  const sel=active?view.selectedTaskId:null;
  const rows=projection.rows.map((r,i)=>'<div class="project-backlog-row" data-project-backlog-row-index="'+i+'"><div class="project-backlog-drop-slot" data-project-backlog-drop-index="'+i+'" data-c1-key="project-backlog-drop-'+esc(project.id)+'-'+i+'"><div class="project-backlog-insertion-placeholder"></div></div><button type="button" class="project-backlog-task'+(r.completed?' completed':'')+(r.taskId===sel?' selected':'')+'" draggable="true" data-project-backlog-action="open-task" data-project-backlog-task-id="'+esc(r.taskId)+'" data-project-backlog-order="'+esc(r.orderIndex)+'" data-c1-key="project-backlog-task-'+esc(r.taskId)+'"><strong>'+esc(r.name)+'</strong><span>'+esc(r.description||'No description')+'</span><small>'+esc(r.deadline??'No deadline')+'</small></button></div>').join('')+'<div class="project-backlog-drop-slot" data-project-backlog-drop-index="'+projection.rows.length+'"><div class="project-backlog-insertion-placeholder"></div></div>';
  const queried=projection.search.trim().length>0||projection.filterChips.length>0||projection.sortIndicator!==null;
  const chips=projection.filterChips.length>0?'<ul class="project-backlog-filter-chips" data-project-backlog-filter-chips>'+projection.filterChips.map(c=>'<li data-project-backlog-filter-chip="'+esc(c.id)+'" data-project-backlog-filter-field="'+esc(c.field)+'" data-project-backlog-filter-operator="'+esc(c.operator)+'" data-c1-key="project-backlog-chip-'+esc(c.id)+'"><span>'+esc(c.label)+'</span></li>').join('')+'</ul>':'';
  const search=projection.search.length>0?'<p class="project-backlog-search" data-project-backlog-search="'+esc(projection.search)+'">Search: <strong>'+esc(projection.search)+'</strong></p>':'';
  const sort=projection.sortIndicator===null?'':'<p class="project-backlog-sort" data-project-backlog-sort-indicator data-project-backlog-sort-field="'+esc(projection.sortIndicator.field)+'" data-project-backlog-sort-direction="'+esc(projection.sortIndicator.direction)+'">Sorted by '+esc(projection.sortIndicator.field)+' '+(projection.sortIndicator.direction==='ascending'?'▲':'▼')+'</p>';
  const query=queried?'<div class="project-backlog-query" data-project-backlog-query="active">'+search+sort+chips+'</div>':'';
  let insp='';if(sel){const t=ts.find(x=>x.id===sel);if(t)insp='<section class="project-backlog-task-inspector" data-project-backlog-inspector-task-id="'+esc(t.id)+'"><header><h3>'+esc(t.name)+'</h3><button type="button" data-project-backlog-action="close-task" data-c1-key="project-backlog-task-inspector-close" aria-label="Close task details">×</button></header><p>'+esc(t.description||'No description')+'</p><dl><div><dt>Status</dt><dd>'+esc(t.status)+'</dd></div><div><dt>Order</dt><dd>'+esc(t.orderIndex)+'</dd></div></dl><footer><button type="button" disabled data-project-backlog-write-action="edit" data-project-backlog-write-refusal="'+PROJECT_BACKLOG_WRITE_REFUSAL+'">Edit unavailable</button><button type="button" disabled data-project-backlog-write-action="delete" data-project-backlog-write-refusal="'+PROJECT_BACKLOG_WRITE_REFUSAL+'">Delete unavailable</button></footer></section>';}
  const ref=active&&view.writeRefusal?'<p data-project-backlog-write-refusal="'+view.writeRefusal+'">Move unavailable until record-store cutover. Task data was not changed.</p>':'';
  const counts=queried?projection.visibleCount+' of '+projection.totalCount+' project task'+(projection.totalCount===1?'':'s'):projection.totalCount+' project task'+(projection.totalCount===1?'':'s');
  const empty=projection.emptyReason==='no-tasks'?'<p class="empty-state" data-c1-key="project-backlog-empty">No project tasks.</p>':projection.emptyReason==='no-matches'?'<p class="empty-state" data-project-backlog-empty-reason="no-matches" data-c1-key="project-backlog-empty">No project tasks match the current search or filters.</p>':'';
  return '<section class="project-workspace-panel project-backlog-panel" data-project-workspace-panel="backlog" data-project-backlog-project-id="'+esc(project.id)+'" data-project-backlog-write-authority="unavailable" data-c1-key="project-workspace-backlog"><header><h3>Backlog</h3><small>'+esc(counts)+' · order writes unavailable</small></header>'+query+'<div class="project-backlog-list">'+(rows+empty)+'</div>'+insp+ref+'</section>';}
export function bindProjectBacklogInteractions(root:HTMLElement,h:ProjectBacklogHandlers):void{let drag:string|null=null;root.addEventListener('click',e=>{const c=(e.target as HTMLElement).closest<HTMLElement>('[data-project-backlog-action]');if(!c||!root.contains(c))return;if(c.dataset.projectBacklogAction==='open-task'&&c.dataset.projectBacklogTaskId)h.openTask(c.dataset.projectBacklogTaskId);else if(c.dataset.projectBacklogAction==='close-task')h.closeTask();});root.addEventListener('keydown',e=>{if(e.key==='Escape'&&root.querySelector('[data-project-backlog-inspector-task-id]')){e.preventDefault();h.closeTask();}});root.addEventListener('dragstart',e=>{const c=(e.target as HTMLElement).closest<HTMLElement>('[data-project-backlog-task-id]');if(!c||!c.dataset.projectBacklogTaskId)return;drag=c.dataset.projectBacklogTaskId;(e as DragEvent).dataTransfer?.setData('text/plain',drag);h.startDrag(drag);});root.addEventListener('dragover',e=>{if(!drag)return;const s=(e.target as HTMLElement).closest<HTMLElement>('[data-project-backlog-drop-index]');if(!s)return;const ix=Number(s.dataset.projectBacklogDropIndex);if(!Number.isInteger(ix))return;e.preventDefault();s.dataset.projectBacklogPreview='true';const p=s.querySelector<HTMLElement>('.project-backlog-insertion-placeholder');if(p){p.style.height='54px';p.style.opacity='1';}h.previewMove({taskId:drag,targetIndex:ix});});root.addEventListener('drop',e=>{if(!drag)return;const s=(e.target as HTMLElement).closest<HTMLElement>('[data-project-backlog-drop-index]');if(!s)return;const ix=Number(s.dataset.projectBacklogDropIndex);if(!Number.isInteger(ix))return;e.preventDefault();const id=drag;drag=null;h.refuseMove({taskId:id,targetIndex:ix});});root.addEventListener('dragend',()=>{drag=null;h.clearDrag();});}
