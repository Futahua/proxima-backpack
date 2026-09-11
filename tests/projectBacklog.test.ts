// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { bindProjectBacklogInteractions, EMPTY_PROJECT_BACKLOG_VIEW, PROJECT_BACKLOG_WRITE_REFUSAL, renderProjectBacklog, type ProjectBacklogViewState } from '../src/browser/projectBacklog.js';
import { applyBacklogControl, buildBacklogFilter } from '../src/app/backlogControls.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import type { Project, ProximaState, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';
const project:Project={id:'backlog-project',source:sourceRef('project','backlog-project'),name:'Backlog',description:'',createdAt:'2026-09-01T00:00:00.000Z',status:'active',projectType:'task',linkedFolders:[]};
const other:Project={...project,id:'other',source:sourceRef('project','other'),name:'Other'};
const task=(id:string,pid:string,ix:number):Task=>({id,source:sourceRef('task',id),name:id,description:'<script>x</script>',projectId:pid,status:'todo',weight:1,orderIndex:ix,isFixedDuration:false,fixedDuration:null,maxDuration:null,isCompleted:false,createdAt:'2026-09-01T00:00:00.000Z',startDate:null,deadline:null,properties:{}});
const state=():ProximaState=>({projects:[project,other],tasks:[task('second',project.id,2),task('first',project.id,1),task('other',other.id,0)],events:[],statuses:[],taskSchema:[]});
/** The query controls a case does not exercise, so each case states only its own. */
const quiet={setSearch:()=>{},addFilter:()=>{},removeFilter:()=>{},sortBy:()=>{},clearSort:()=>{},clearQuery:()=>{}};
beforeEach(()=>{document.body.innerHTML='';});
describe('Stage 5 slice 7 detailed Backlog interactions',()=>{
 it('orders and scopes tasks without mutation',()=>{const s=state(),before=JSON.stringify(s);document.body.innerHTML=renderProjectBacklog(s,project);expect(Array.from(document.querySelectorAll('[data-project-backlog-task-id]')).map(x=>(x as HTMLElement).dataset.projectBacklogTaskId)).toEqual(['first','second']);expect(document.querySelector('[data-project-backlog-task-id="other"]')).toBeNull();expect(JSON.stringify(s)).toBe(before);});
 it('opens a read-only inspector',()=>{const s=state();let v:ProjectBacklogViewState=EMPTY_PROJECT_BACKLOG_VIEW;const r=()=>{document.body.innerHTML=renderProjectBacklog(s,project,v);};r();bindProjectBacklogInteractions(document.body,{openTask:id=>{v={...v,projectId:project.id,selectedTaskId:id};r();},closeTask:()=>{v={...v,selectedTaskId:null};r();},startDrag:()=>{},previewMove:()=>{},refuseMove:()=>{},clearDrag:()=>{},...quiet});createInteractionHarness(document).click('project-backlog-task-first');expect(document.querySelector('[data-project-backlog-inspector-task-id="first"]')).not.toBeNull();expect(document.querySelector('.project-backlog-task-inspector script')).toBeNull();});
 it('refuses provisional reorder drops',()=>{const s=state();let v:ProjectBacklogViewState={...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id};let refused:any=null;const r=()=>{document.body.innerHTML=renderProjectBacklog(s,project,v);};r();bindProjectBacklogInteractions(document.body,{openTask:()=>{},closeTask:()=>{},startDrag:id=>{v={...v,dragTaskId:id};},previewMove:()=>{},refuseMove:i=>{refused=i;v={...v,writeRefusal:PROJECT_BACKLOG_WRITE_REFUSAL};r();},clearDrag:()=>{},...quiet});const h=createInteractionHarness(document),d=h.beginDrag('project-backlog-task-first',{clientX:0,clientY:0});d.move('project-backlog-drop-'+project.id+'-1',{clientX:1,clientY:1});expect(document.querySelector('[data-project-backlog-drop-index="1"] .project-backlog-insertion-placeholder')?.getAttribute('style')).toContain('height');d.drop('project-backlog-drop-'+project.id+'-1',{clientX:1,clientY:1});expect(refused).toEqual({taskId:'first',targetIndex:1});});
 it('does not leak foreign view state',()=>{const v:ProjectBacklogViewState={...EMPTY_PROJECT_BACKLOG_VIEW,projectId:other.id,selectedTaskId:'other',writeRefusal:PROJECT_BACKLOG_WRITE_REFUSAL,lastRefusedMove:{taskId:'other',targetIndex:0}};document.body.innerHTML=renderProjectBacklog(state(),project,v);expect(document.querySelector('[data-project-backlog-inspector-task-id]')).toBeNull();expect(document.querySelector('[data-project-backlog-write-refusal]')).toBeNull();});
});
/**
 * Drives the Backlog through the real loop — render, click, the handler applies one
 * control, render again — so a control is evidence of reachability rather than of a
 * function that happens to exist.
 *
 * Each session renders into its own host element: binding is additive, so a suite that
 * bound every case to `document.body` would leave earlier cases' handlers attached and
 * answer one click several times.
 */
function session(s:ProximaState,start:ProjectBacklogViewState={...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id}){
 const host=document.createElement('div');
 document.body.appendChild(host);
 let view:ProjectBacklogViewState=start;
 const draw=()=>{host.innerHTML=renderProjectBacklog(s,project,view);};
 const apply=(control:Parameters<typeof applyBacklogControl>[1])=>{view={...view,projectId:project.id,queryRefusal:null,query:applyBacklogControl(view.query,control)};};
 const refuse=(reason:string)=>{view={...view,projectId:project.id,queryRefusal:reason};};
 const stop=()=>{host.remove();};
 draw();
 bindProjectBacklogInteractions(host,{
  openTask:id=>{view={...view,projectId:project.id,selectedTaskId:id};draw();},
  closeTask:()=>{view={...view,selectedTaskId:null};draw();},
  startDrag:()=>{},previewMove:()=>{},refuseMove:()=>{},clearDrag:()=>{},
  setSearch:search=>{apply({kind:'set-search',search});draw();},
  addFilter:(expression,value)=>{const built=buildBacklogFilter(view.query.filters,expression,value);built.ok?apply({kind:'add-filter',filter:built.filter}):refuse(built.reason);draw();},
  removeFilter:filterId=>{apply({kind:'remove-filter',filterId});draw();},
  sortBy:field=>{apply({kind:'sort-by',field});draw();},
  clearSort:()=>{apply({kind:'clear-sort'});draw();},
  clearQuery:()=>{apply({kind:'clear-query'});draw();},
 });
 return {harness:createInteractionHarness(host),view:()=>view,rows:()=>Array.from(host.querySelectorAll('[data-project-backlog-task-id]')).map(x=>(x as HTMLElement).dataset.projectBacklogTaskId),chipIds:()=>Array.from(host.querySelectorAll('[data-project-backlog-filter-chip]')).map(x=>(x as HTMLElement).dataset.projectBacklogFilterChip),stop};
}
describe('Stage 6 Backlog query controls, driven through the document',()=>{
 it('searches as the field is typed, and shows the text that is searching',()=>{const s=state();const run=session(s);run.harness.typeText('project-backlog-search-input','d');expect(run.rows()).toEqual(['second']);expect((document.querySelector('[data-project-backlog-search-input]') as HTMLInputElement).value).toBe('d');expect(document.querySelector('[data-project-backlog-empty-reason]')).toBeNull();run.stop();});
 it('says so when a search matches nothing',()=>{const s=state();const run=session(s);run.harness.typeText('project-backlog-search-input','z');expect(run.rows()).toEqual([]);expect(document.querySelector('[data-project-backlog-empty-reason="no-matches"]')).not.toBeNull();run.stop();});
 it('adds the filter the menu was left on, and shows the chip that removes it',()=>{const s=state();const run=session(s);(document.querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='name|contains';(document.querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='fir';run.harness.click('project-backlog-add-filter');expect(run.chipIds()).toEqual(['filter-1']);expect(run.rows()).toEqual(['first']);expect(document.querySelector('[data-project-backlog-filter-chip="filter-1"] span')?.textContent).toBe('Name contains fir');run.stop();});
 it('removes the filter a chip names, bringing its tasks back',()=>{const s=state();const run=session(s,{...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id,query:{search:'',filters:[{id:'filter-1',field:'name',operator:'contains',value:'fir'}],sort:null}});expect(run.rows()).toEqual(['first']);run.harness.click('project-backlog-chip-remove-filter-1');expect(run.rows()).toEqual(['first','second']);expect(run.chipIds()).toEqual([]);expect(run.view().query.filters).toEqual([]);run.stop();});
 it('refuses a value that cannot be compared, and keeps the query it had',()=>{const s=state();const run=session(s);(document.querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='weight|greater-than';(document.querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='heavy';run.harness.click('project-backlog-add-filter');expect(run.view().queryRefusal).toBe('"heavy" is not a number');expect(document.querySelector('[data-project-backlog-query-refusal]')?.textContent).toBe('"heavy" is not a number');expect(run.rows()).toEqual(['first','second']);expect(run.chipIds()).toEqual([]);run.stop();});
 it('sorts a column ascending, then the same column descending, then clears it',()=>{const s=state();const run=session(s);run.harness.click('project-backlog-sort-name');expect(run.rows()).toEqual(['first','second']);expect(document.querySelector('[data-project-backlog-sort-indicator]')?.getAttribute('data-project-backlog-sort-direction')).toBe('ascending');run.harness.click('project-backlog-sort-name');expect(run.rows()).toEqual(['second','first']);expect(document.querySelector('[data-project-backlog-sort-indicator]')?.getAttribute('data-project-backlog-sort-direction')).toBe('descending');expect(document.querySelector('[data-project-backlog-sort-by="name"]')?.getAttribute('aria-pressed')).toBe('true');run.harness.click('project-backlog-clear-sort');expect(run.view().query.sort).toBeNull();expect(document.querySelector('[data-project-backlog-sort-indicator]')).toBeNull();expect(run.rows()).toEqual(['first','second']);run.stop();});
 it('clears a whole query at once, and leaves nothing to clear',()=>{const s=state();const run=session(s,{...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id,query:{search:'s',filters:[{id:'filter-1',field:'weight',operator:'is',value:1}],sort:{field:'name',direction:'descending'}}});run.harness.click('project-backlog-clear-query');expect(run.view().query).toEqual({search:'',filters:[],sort:null});expect(run.rows()).toEqual(['first','second']);expect(document.querySelector('[data-project-backlog-action="clear-query"]')?.hasAttribute('disabled')).toBe(true);expect((document.querySelector('[data-project-backlog-search-input]') as HTMLInputElement).value).toBe('');run.stop();});
 it('does not write to a record for any control it was given',()=>{const s=state();const before=JSON.stringify(s);const run=session(s);run.harness.typeText('project-backlog-search-input','s');(document.querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='name|contains';(document.querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='sec';run.harness.click('project-backlog-add-filter');run.harness.click('project-backlog-sort-name');run.harness.click('project-backlog-chip-remove-filter-1');run.harness.click('project-backlog-clear-query');expect(JSON.stringify(s)).toBe(before);run.stop();});
});
