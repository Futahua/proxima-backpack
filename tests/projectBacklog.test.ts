// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { bindProjectBacklogInteractions, EMPTY_PROJECT_BACKLOG_VIEW, PROJECT_BACKLOG_BULK_NOTE, PROJECT_BACKLOG_WRITE_REFUSAL, renderProjectBacklog, type ProjectBacklogViewState } from '../src/browser/projectBacklog.js';
import { applyBacklogControl, buildBacklogFilter, buildBacklogPropertyFilter, clearBacklogSelection, resizeBacklogColumn, selectAllBacklogVisible, toggleBacklogSelection } from '../src/app/backlogControls.js';
import { propertyValueTypeFor } from '../src/app/backlogView.js';
import { applyTaskEditorEdit, taskEditorDraftFor } from '../src/app/taskEditor.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import type { Project, ProximaState, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';
const project:Project={id:'backlog-project',source:sourceRef('project','backlog-project'),name:'Backlog',description:'',createdAt:'2026-09-01T00:00:00.000Z',status:'active',projectType:'task',linkedFolders:[]};
const other:Project={...project,id:'other',source:sourceRef('project','other'),name:'Other'};
const task=(id:string,pid:string,ix:number):Task=>({id,source:sourceRef('task',id),name:id,description:'<script>x</script>',projectId:pid,status:'todo',weight:1,orderIndex:ix,isFixedDuration:false,fixedDuration:null,maxDuration:null,isCompleted:false,createdAt:'2026-09-01T00:00:00.000Z',startDate:null,deadline:null,properties:{}});
const state=():ProximaState=>({projects:[project,other],tasks:[task('second',project.id,2),task('first',project.id,1),task('other',other.id,0)],events:[],statuses:[],taskSchema:[]});
/** The query controls a case does not exercise, so each case states only its own. */
const quiet={setSearch:()=>{},addFilter:()=>{},removeFilter:()=>{},sortBy:()=>{},clearSort:()=>{},clearQuery:()=>{},toggleSelection:()=>{},selectAllVisible:()=>{},clearSelection:()=>{},openTemplate:()=>{},closeTemplate:()=>{},setTemplateText:()=>{},resizeColumn:()=>{},editTask:()=>{},cancelTaskEdit:()=>{},bulkComplete:()=>{},bulkDelete:()=>{}};
beforeEach(()=>{document.body.innerHTML='';});
describe('Stage 5 slice 7 detailed Backlog interactions',()=>{
 it('orders and scopes tasks without mutation',()=>{const s=state(),before=JSON.stringify(s);document.body.innerHTML=renderProjectBacklog(s,project);expect(Array.from(document.querySelectorAll('[data-project-backlog-task-id]')).map(x=>(x as HTMLElement).dataset.projectBacklogTaskId)).toEqual(['first','second']);expect(document.querySelector('[data-project-backlog-task-id="other"]')).toBeNull();expect(JSON.stringify(s)).toBe(before);});
 it('opens the Task editor for the row that was clicked',()=>{
  const s=state();
  let v:ProjectBacklogViewState=EMPTY_PROJECT_BACKLOG_VIEW;
  const r=()=>{document.body.innerHTML=renderProjectBacklog(s,project,v);};
  r();
  bindProjectBacklogInteractions(document.body,{openTask:id=>{v={...v,projectId:project.id,selectedTaskId:id,editorDraft:null};r();},closeTask:()=>{v={...v,selectedTaskId:null,editorDraft:null};r();},startDrag:()=>{},previewMove:()=>{},refuseMove:()=>{},clearDrag:()=>{},...quiet});
  createInteractionHarness(document).click('project-backlog-task-first');
  const editor=document.querySelector('[data-project-backlog-editor-task-id="first"]');
  expect(editor).not.toBeNull();
  expect(editor!.getAttribute('aria-label')).toBe('Task editor');
  // The form carries the record's values, under this surface's own hooks.
  expect((document.querySelector('[data-c1-key="project-backlog-editor-name"]') as HTMLInputElement).value).toBe('first');
  expect((document.querySelector('[data-c1-key="project-backlog-editor-executionState"]') as HTMLSelectElement).value).toBe('todo');
  // The read-only inspector it replaced is gone, rather than shown twice.
  expect(document.querySelector('.project-backlog-task-inspector')).toBeNull();
 });
 it('takes a typed edit into a draft, and Cancel discards it',()=>{
  const s=state();
  const before=JSON.stringify(s);
  const run=session(s);
  run.harness.click('project-backlog-task-first');
  expect(run.root().querySelector('[data-project-backlog-editor-dirty="false"]')).not.toBeNull();
  run.harness.typeText('project-backlog-editor-name','!');
  expect(run.view().editorDraft!.values.name).toBe('first!');
  run.draw();
  expect((run.root().querySelector('[data-c1-key="project-backlog-editor-name"]') as HTMLInputElement).value).toBe('first!');
  expect(run.root().querySelector('[data-project-backlog-editor-dirty="true"]')).not.toBeNull();
  run.harness.click('project-backlog-editor-cancel');
  expect(run.view().editorDraft).toBeNull();
  expect((run.root().querySelector('[data-c1-key="project-backlog-editor-name"]') as HTMLInputElement).value).toBe('first');
  expect(run.root().querySelector('[data-project-backlog-editor-dirty="false"]')).not.toBeNull();
  // Nothing was written: a draft that is discarded is a draft that never existed.
  expect(JSON.stringify(s)).toBe(before);
  run.stop();
 });
 it('refuses provisional reorder drops',()=>{const s=state();let v:ProjectBacklogViewState={...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id};let refused:any=null;const r=()=>{document.body.innerHTML=renderProjectBacklog(s,project,v);};r();bindProjectBacklogInteractions(document.body,{openTask:()=>{},closeTask:()=>{},startDrag:id=>{v={...v,dragTaskId:id};},previewMove:()=>{},refuseMove:i=>{refused=i;v={...v,writeRefusal:PROJECT_BACKLOG_WRITE_REFUSAL};r();},clearDrag:()=>{},...quiet});const h=createInteractionHarness(document),d=h.beginDrag('project-backlog-task-first',{clientX:0,clientY:0});d.move('project-backlog-drop-'+project.id+'-1',{clientX:1,clientY:1});expect(document.querySelector('[data-project-backlog-drop-index="1"] .project-backlog-insertion-placeholder')?.getAttribute('style')).toContain('height');d.drop('project-backlog-drop-'+project.id+'-1',{clientX:1,clientY:1});expect(refused).toEqual({taskId:'first',targetIndex:1});});
 it('does not leak foreign view state',()=>{const v:ProjectBacklogViewState={...EMPTY_PROJECT_BACKLOG_VIEW,projectId:other.id,selectedTaskId:'other',writeRefusal:PROJECT_BACKLOG_WRITE_REFUSAL,lastRefusedMove:{taskId:'other',targetIndex:0}};document.body.innerHTML=renderProjectBacklog(state(),project,v);expect(document.querySelector('[data-project-backlog-editor-task-id]')).toBeNull();expect(document.querySelector('[data-project-backlog-write-refusal]')).toBeNull();});
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
  openTask:id=>{view={...view,projectId:project.id,selectedTaskId:id,editorDraft:null};draw();},
  closeTask:()=>{view={...view,selectedTaskId:null};draw();},
  startDrag:()=>{},previewMove:()=>{},refuseMove:()=>{},clearDrag:()=>{},
  setSearch:search=>{apply({kind:'set-search',search});draw();},
  // Mirrors `main.ts`: an expression beginning `property.` names a custom property, and the
  // type it is compared as comes from the schema — the same lookup the menu used.
  addFilter:(expression,value)=>{
   if(expression.startsWith('property.')){
    const key=expression.slice('property.'.length,expression.indexOf('|'));
    const built=buildBacklogPropertyFilter(view.query.propertyFilters,expression,value,propertyValueTypeFor(s.taskSchema,key),view.query.filters);
    built.ok?apply({kind:'add-property-filter',filter:built.filter}):refuse(built.reason);
    draw();
    return;
   }
   const built=buildBacklogFilter(view.query.filters,expression,value,view.query.propertyFilters);
   built.ok?apply({kind:'add-filter',filter:built.filter}):refuse(built.reason);
   draw();
  },
  removeFilter:filterId=>{apply({kind:'remove-filter',filterId});draw();},
  sortBy:field=>{apply({kind:'sort-by',field});draw();},
  clearSort:()=>{apply({kind:'clear-sort'});draw();},
  clearQuery:()=>{apply({kind:'clear-query'});draw();},
  toggleSelection:(taskId)=>{view={...view,projectId:project.id,selectedTaskIds:toggleBacklogSelection(view.selectedTaskIds,taskId)};draw();},
  selectAllVisible:(visibleTaskIds)=>{view={...view,projectId:project.id,selectedTaskIds:selectAllBacklogVisible(view.selectedTaskIds,visibleTaskIds)};draw();},
  clearSelection:()=>{view={...view,projectId:project.id,selectedTaskIds:clearBacklogSelection(view.selectedTaskIds)};draw();},
  openTemplate:()=>{view={...view,projectId:project.id,templateOpen:true};draw();},
  closeTemplate:()=>{view={...view,projectId:project.id,templateOpen:false};draw();},
  setTemplateText:(text)=>{view={...view,projectId:project.id,templateText:text};draw();},
  resizeColumn:(columnId,width)=>{view={...view,projectId:project.id,columnWidths:resizeBacklogColumn(view.columnWidths,columnId,width)};draw();},
  editTask:(edit)=>{const record=s.tasks.find(x=>x.id===view.selectedTaskId);if(!record)return;view={...view,editorDraft:applyTaskEditorEdit(view.editorDraft??taskEditorDraftFor(record),edit)};},
  cancelTaskEdit:()=>{view={...view,editorDraft:null};draw();},
  bulkComplete:()=>{},
  bulkDelete:()=>{},
 });
 return {root:()=>host,harness:createInteractionHarness(host),draw,view:()=>view,rows:()=>Array.from(host.querySelectorAll('[data-project-backlog-task-id]')).map(x=>(x as HTMLElement).dataset.projectBacklogTaskId),chipIds:()=>Array.from(host.querySelectorAll('[data-project-backlog-filter-chip]')).map(x=>(x as HTMLElement).dataset.projectBacklogFilterChip),stop};
}
describe('Stage 6 Backlog query controls, driven through the document',()=>{
 it('searches as the field is typed, and shows the text that is searching',()=>{const s=state();const run=session(s);run.harness.typeText('project-backlog-search-input','d');expect(run.rows()).toEqual(['second']);expect((document.querySelector('[data-project-backlog-search-input]') as HTMLInputElement).value).toBe('d');expect(document.querySelector('[data-project-backlog-empty-reason]')).toBeNull();run.stop();});
 it('says so when a search matches nothing',()=>{const s=state();const run=session(s);run.harness.typeText('project-backlog-search-input','z');expect(run.rows()).toEqual([]);expect(document.querySelector('[data-project-backlog-empty-reason="no-matches"]')).not.toBeNull();run.stop();});
 it('adds the filter the menu was left on, and shows the chip that removes it',()=>{const s=state();const run=session(s);(document.querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='name|contains';(document.querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='fir';run.harness.click('project-backlog-add-filter');expect(run.chipIds()).toEqual(['filter-1']);expect(run.rows()).toEqual(['first']);expect(document.querySelector('[data-project-backlog-filter-chip="filter-1"] span')?.textContent).toBe('Name contains fir');run.stop();});
 it('removes the filter a chip names, bringing its tasks back',()=>{const s=state();const run=session(s,{...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id,query:{search:'',filters:[{id:'filter-1',field:'name',operator:'contains',value:'fir'}],propertyFilters:[],sort:null}});expect(run.rows()).toEqual(['first']);run.harness.click('project-backlog-chip-remove-filter-1');expect(run.rows()).toEqual(['first','second']);expect(run.chipIds()).toEqual([]);expect(run.view().query.filters).toEqual([]);run.stop();});
 it('refuses a value that cannot be compared, and keeps the query it had',()=>{const s=state();const run=session(s);(document.querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='weight|greater-than';(document.querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='heavy';run.harness.click('project-backlog-add-filter');expect(run.view().queryRefusal).toBe('"heavy" is not a number');expect(document.querySelector('[data-project-backlog-query-refusal]')?.textContent).toBe('"heavy" is not a number');expect(run.rows()).toEqual(['first','second']);expect(run.chipIds()).toEqual([]);run.stop();});
 it('sorts a column ascending, then the same column descending, then clears it',()=>{const s=state();const run=session(s);run.harness.click('project-backlog-sort-name');expect(run.rows()).toEqual(['first','second']);expect(document.querySelector('[data-project-backlog-sort-indicator]')?.getAttribute('data-project-backlog-sort-direction')).toBe('ascending');run.harness.click('project-backlog-sort-name');expect(run.rows()).toEqual(['second','first']);expect(document.querySelector('[data-project-backlog-sort-indicator]')?.getAttribute('data-project-backlog-sort-direction')).toBe('descending');expect(document.querySelector('[data-project-backlog-sort-by="name"]')?.getAttribute('aria-pressed')).toBe('true');run.harness.click('project-backlog-clear-sort');expect(run.view().query.sort).toBeNull();expect(document.querySelector('[data-project-backlog-sort-indicator]')).toBeNull();expect(run.rows()).toEqual(['first','second']);run.stop();});
 it('clears a whole query at once, and leaves nothing to clear',()=>{const s=state();const run=session(s,{...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id,query:{search:'s',filters:[{id:'filter-1',field:'weight',operator:'is',value:1}],propertyFilters:[],sort:{field:'name',direction:'descending'}}});run.harness.click('project-backlog-clear-query');expect(run.view().query).toEqual({search:'',filters:[],propertyFilters:[],sort:null});expect(run.rows()).toEqual(['first','second']);expect(document.querySelector('[data-project-backlog-action="clear-query"]')?.hasAttribute('disabled')).toBe(true);expect((document.querySelector('[data-project-backlog-search-input]') as HTMLInputElement).value).toBe('');run.stop();});
 it('does not write to a record for any control it was given',()=>{const s=state();const before=JSON.stringify(s);const run=session(s);run.harness.typeText('project-backlog-search-input','d');(document.querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='name|contains';(document.querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='sec';run.harness.click('project-backlog-add-filter');run.harness.click('project-backlog-sort-name');run.harness.click('project-backlog-chip-remove-filter-1');run.harness.click('project-backlog-clear-query');expect(JSON.stringify(s)).toBe(before);run.stop();});
});
describe('Stage 6 Backlog column table',()=>{
 it('names each custom-property column once, above the cells that belong to it',()=>{
  const s=derivedState();const run=session(s);
  const header=run.root().querySelector('[data-project-backlog-columns]')!;
  expect(header).not.toBeNull();
  const columns=Array.from(run.root().querySelectorAll('[data-project-backlog-column]')).map(x=>x as HTMLElement);
  expect(columns.map(x=>x.dataset.projectBacklogColumn)).toEqual(['property:blocks','property:childCount','property:estimate','property:progress']);
  // The label is the schema's name, and the header sits above the list it names.
  expect(columns.map(x=>x.querySelector('span')!.textContent)).toEqual(['Blocks','Child count','Estimate','Progress']);
  // The header sits directly above the list it names.
  expect(header.nextElementSibling).toBe(run.root().querySelector('.project-backlog-list'));
  run.stop();
 });
 it('draws a column header only for the columns the rows actually draw',()=>{
  const bare=state();const run=session(bare);
  expect(run.root().querySelector('[data-project-backlog-columns]')).toBeNull();
  run.stop();
 });
 it('gives the header and every cell of a column the same width',()=>{
  const s=derivedState();const run=session(s);
  const width=(selector:string)=>(run.root().querySelector(selector) as HTMLElement).style.width;
  const header=width('[data-project-backlog-column="property:blocks"]');
  expect(header).toBe('160px');
  expect(width('[data-project-backlog-cell="property:blocks"]')).toBe(header);
  run.stop();
 });
 it('resizes a column by dragging its edge, and keeps the header and cells together',()=>{
  const s=derivedState();const before=JSON.stringify(s);const run=session(s);
  const drag=run.harness.beginResize('project-backlog-column-resize-property:blocks',{clientX:300,clientY:10});
  drag.move('project-backlog-column-resize-property:blocks',{clientX:360,clientY:10});
  drag.release('project-backlog-column-resize-property:blocks',{clientX:360,clientY:10});
  expect(run.view().columnWidths['property:blocks']).toBe(220);
  const width=(selector:string)=>(run.root().querySelector(selector) as HTMLElement).style.width;
  expect(width('[data-project-backlog-column="property:blocks"]')).toBe('220px');
  expect(width('[data-project-backlog-cell="property:blocks"]')).toBe('220px');
  // The other columns are untouched, and nothing about the project's data changed.
  expect(run.view().columnWidths['property:progress']).toBeUndefined();
  expect(width('[data-project-backlog-column="property:progress"]')).toBe('160px');
  expect(JSON.stringify(s)).toBe(before);
  run.stop();
 });
 it('clamps a drag that would make a column unreadable or swallow the table',()=>{
  const s=derivedState();const run=session(s);
  const edge='project-backlog-column-resize-property:blocks';
  const shrink=run.harness.beginResize(edge,{clientX:300,clientY:10});
  shrink.move(edge,{clientX:-900,clientY:10});
  shrink.release(edge,{clientX:-900,clientY:10});
  expect(run.view().columnWidths['property:blocks']).toBe(96);
  const grow=run.harness.beginResize(edge,{clientX:300,clientY:10});
  grow.move(edge,{clientX:9000,clientY:10});
  grow.release(edge,{clientX:9000,clientY:10});
  expect(run.view().columnWidths['property:blocks']).toBe(640);
  run.stop();
 });
});
/** A project whose tasks declare a relation, a rollup, a formula and an unset property. */
function derivedState():ProximaState{
 const properties={blocks:'task-9',childCount:3,progress:'2/5',estimate:null};
 return {...state(),tasks:[{...task('first',project.id,1),properties},{...task('second',project.id,2),properties:{}}],taskSchema:[{id:'blocks',name:'Blocks',type:'relation',relationProperty:'blocks'},{id:'childCount',name:'Child count',type:'rollup',aggregation:'count',targetProperty:'children'},{id:'progress',name:'Progress',type:'formula',expression:'done / total'},{id:'estimate',name:'Estimate',type:'number'}]};
}
describe('Stage 6 Backlog property filters',()=>{
 /** The same project, with the number property set so a numeric filter can match. */
 function filterState():ProximaState{
  const base=derivedState();
  return {...base,tasks:[{...base.tasks[0]!,properties:{...base.tasks[0]!.properties,estimate:5}},base.tasks[1]!]};
 }
 it('offers each declared property with only the comparisons its type admits',()=>{
  const s=derivedState();const run=session(s);
  const groups=Array.from(run.root().querySelectorAll('[data-project-backlog-property-menu]')).map(x=>x as HTMLElement);
  expect(groups.map(g=>g.dataset.projectBacklogPropertyMenu)).toEqual(['blocks','childCount','estimate','progress']);
  expect(groups.map(g=>g.getAttribute('label'))).toEqual(['Blocks','Child count','Estimate','Progress']);
  // The number property offers ordering; the text-ish ones do not.
  const options=(key:string)=>Array.from(groups.find(g=>g.dataset.projectBacklogPropertyMenu===key)!.querySelectorAll('option')).map(o=>o.value);
  expect(options('estimate')).toContain('property.estimate|greater-than');
  expect(options('estimate')).not.toContain('property.estimate|contains');
  expect(groups.find(g=>g.dataset.projectBacklogPropertyMenu==='estimate')!.dataset.projectBacklogPropertyType).toBe('number');
  expect(options('progress')).toContain('property.progress|contains');
  expect(options('progress')).not.toContain('property.progress|before');
  run.stop();
 });
 it('filters the rows by a property, and chips it like any other filter',()=>{
  const s=filterState();const run=session(s);
  expect(run.rows()).toEqual(['first','second']);
  (run.root().querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='property.estimate|greater-than';
  (run.root().querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='4';
  run.harness.click('project-backlog-add-filter');
  expect(run.rows()).toEqual(['first']);
  expect(run.view().query.propertyFilters).toEqual([{id:'filter-1',propertyKey:'estimate',valueType:'number',operator:'greater-than',value:4}]);
  const chip=run.root().querySelector('[data-project-backlog-filter-property="estimate"]')!;
  expect(chip.getAttribute('data-project-backlog-filter-property-type')).toBe('number');
  expect(chip.textContent).toContain('Estimate > 4');
  // Removing the chip brings the hidden task back, through the same control as any filter.
  run.harness.click('project-backlog-chip-remove-filter-1');
  expect(run.view().query.propertyFilters).toEqual([]);
  expect(run.rows()).toEqual(['first','second']);
  run.stop();
 });
 it('refuses a value the property type cannot compare, and keeps the query it had',()=>{
  const s=filterState();const run=session(s);
  (run.root().querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='property.estimate|greater-than';
  (run.root().querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='many';
  run.harness.click('project-backlog-add-filter');
  expect(run.view().queryRefusal).toBe('"many" is not a number');
  expect(run.view().query.propertyFilters).toEqual([]);
  expect(run.rows()).toEqual(['first','second']);
  run.stop();
 });
 it('applies a property filter together with a field filter and the search',()=>{
  const s=filterState();const run=session(s);
  (run.root().querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='property.estimate|greater-than';
  (run.root().querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='4';
  run.harness.click('project-backlog-add-filter');
  (run.root().querySelector('[data-project-backlog-filter-expression]') as HTMLSelectElement).value='name|contains';
  (run.root().querySelector('[data-project-backlog-filter-value]') as HTMLInputElement).value='fir';
  run.harness.click('project-backlog-add-filter');
  expect(run.rows()).toEqual(['first']);
  expect(run.view().query.filters).toHaveLength(1);
  expect(run.view().query.propertyFilters).toHaveLength(1);
  // Two filters, two distinct ids: minting spans both lists, because one chip id naming two
  // filters would remove both at once. Chips are drawn field filters first, then properties —
  // the order the query keeps them in, rather than the order they arrived.
  const chipIds=Array.from(run.root().querySelectorAll('[data-project-backlog-filter-chip]')).map(x=>x.getAttribute('data-project-backlog-filter-chip'));
  expect(chipIds).toEqual(['filter-2','filter-1']);
  expect(new Set(chipIds).size).toBe(chipIds.length);
  run.stop();
 });
});
describe('Stage 6 Backlog derived and relation display',()=>{
 it('shows every custom property of a row, and says which kind each one is',()=>{
  const s=derivedState();
  document.body.innerHTML=renderProjectBacklog(s,project);
  const cells=(taskId:string)=>Array.from(document.querySelectorAll(`[data-project-backlog-cells="${taskId}"] [data-project-backlog-cell]`)).map(x=>x as HTMLElement);
  // Property columns are ordered by key, the way the projection builds them.
  expect(cells('first').map(x=>`${x.dataset.projectBacklogCell}:${x.dataset.projectBacklogCellKind}`)).toEqual(['property:blocks:relation','property:childCount:rollup','property:estimate:number','property:progress:formula']);
  expect(cells('first').map(x=>[x.querySelector('strong')!.textContent,x.querySelector('span')!.textContent])).toEqual([['Blocks','task-9'],['Child count','3'],['Estimate',''],['Progress','2/5']]);
  // The value the record holds is what is displayed, including for a derived property:
  // computing a rollup from its relations is not this surface's job yet.
  expect(cells('first')[1]!.querySelector('span')!.textContent).toBe('3');
  expect(cells('first')[3]!.querySelector('span')!.textContent).toBe('2/5');
  // A property a task has not set is still shown, and says it is empty.
  expect(cells('first').map(x=>x.dataset.projectBacklogCellEmpty)).toEqual(['false','false','true','false']);
  expect(cells('second').map(x=>x.dataset.projectBacklogCellEmpty)).toEqual(['true','true','true','true']);
  expect(cells('second').every(x=>(x.querySelector('span')?.textContent ?? '')==='')).toBe(true);
 });
 it('keys each cell by task and column, so two rows cannot share one',()=>{
  const s=derivedState();
  document.body.innerHTML=renderProjectBacklog(s,project);
  expect(document.querySelector('[data-c1-key="project-backlog-cell-first-property:blocks"]')).not.toBeNull();
  expect(document.querySelector('[data-c1-key="project-backlog-cell-second-property:blocks"]')).not.toBeNull();
  const keys=Array.from(document.querySelectorAll('[data-project-backlog-cell]')).map(x=>x.getAttribute('data-c1-key'));
  expect(new Set(keys).size).toBe(keys.length);
 });
 it('shows a row without properties without an empty cell list',()=>{
  const s=state();
  document.body.innerHTML=renderProjectBacklog(s,project);
  expect(document.querySelector('[data-project-backlog-cells]')).toBeNull();
 });
});
describe('Stage 6 Backlog bulk controls',()=>{
 const activeView={...EMPTY_PROJECT_BACKLOG_VIEW,projectId:project.id};
 it('shows both bulk controls and refuses with a typed result',()=>{
  const s=state();
  document.body.innerHTML=renderProjectBacklog(s,project,activeView);
  const complete=document.querySelector<HTMLButtonElement>('[data-c1-key="project-backlog-bulk-complete"]')!;
  const remove=document.querySelector<HTMLButtonElement>('[data-c1-key="project-backlog-bulk-delete"]')!;
  expect(complete.disabled).toBe(true);
  expect(remove.disabled).toBe(true);
  expect(complete.getAttribute('data-project-backlog-write-action')).toBe('bulk-complete');
  expect(remove.getAttribute('data-project-backlog-write-action')).toBe('bulk-delete');
  expect(complete.getAttribute('data-project-backlog-write-refusal')).toBe(PROJECT_BACKLOG_WRITE_REFUSAL);
  expect(remove.getAttribute('data-project-backlog-write-refusal')).toBe(PROJECT_BACKLOG_WRITE_REFUSAL);
  expect(document.querySelector('[data-project-backlog-bulk]')!.textContent).toContain(PROJECT_BACKLOG_BULK_NOTE);
 });
 it('shows them before any query is active, and changes nothing when they are clicked',()=>{
  const s=state();
  const before=JSON.stringify(s);
  document.body.innerHTML=renderProjectBacklog(s,project,activeView);
  expect(document.querySelector('[data-project-backlog-query]')).toBeNull();
  expect(document.querySelector('[data-c1-key="project-backlog-bulk-complete"]')).not.toBeNull();
  const harness=createInteractionHarness(document);
  harness.click('project-backlog-bulk-complete');
  harness.click('project-backlog-bulk-delete');
  expect(JSON.stringify(s)).toBe(before);
  expect(document.querySelector('[data-project-backlog-inspector-task-id]')).toBeNull();
 });
});
describe('Stage 6 Backlog selection',()=>{
 it('marks a row from its checkbox and reports how many of the shown rows are marked',()=>{
  const s=state();const run=session(s);
  expect(run.root().querySelector('[data-project-backlog-selection-count]')!.getAttribute('data-project-backlog-selection-count')).toBe('0');
  run.harness.click('project-backlog-select-first');
  expect(run.root().querySelector('[data-project-backlog-select="first"]')!.hasAttribute('checked')).toBe(true);
  expect(run.root().querySelector('[data-project-backlog-selected="true"]')).not.toBeNull();
  const summary=()=>run.root().querySelector('[data-project-backlog-selection-count]')!;
  expect(summary().getAttribute('data-project-backlog-selection-count')).toBe('1');
  expect(summary().getAttribute('data-project-backlog-selection-all-visible')).toBe('false');
  expect(summary().textContent).toContain('1 of 2 selected');
  // The checkbox reports which task it is for; the view state decides what that means.
  expect(run.view().selectedTaskIds).toEqual(['first']);
  run.harness.click('project-backlog-select-first');
  expect(run.view().selectedTaskIds).toEqual([]);
  expect(summary().getAttribute('data-project-backlog-selection-count')).toBe('0');
  run.stop();
 });
 it('selects every shown row at once, and clears the selection again',()=>{
  const s=state();const run=session(s);
  run.harness.click('project-backlog-select-all');
  expect(run.view().selectedTaskIds).toEqual(['first','second']);
  expect(run.root().querySelector('[data-project-backlog-selection-count]')!.getAttribute('data-project-backlog-selection-all-visible')).toBe('true');
  // With everything shown already selected there is nothing left to add.
  expect(run.root().querySelector('[data-c1-key="project-backlog-select-all"]')!.hasAttribute('disabled')).toBe(true);
  run.harness.click('project-backlog-select-none');
  expect(run.view().selectedTaskIds).toEqual([]);
  expect(run.root().querySelector('[data-c1-key="project-backlog-select-none"]')!.hasAttribute('disabled')).toBe(true);
  run.stop();
 });
 it('counts a marked task the query hides instead of letting the selection cover it silently',()=>{
  const s=state();const run=session(s);
  run.harness.click('project-backlog-select-all');
  expect(run.view().selectedTaskIds).toEqual(['first','second']);
  // Hiding one of them leaves the mark in place, reports the gap, and says "select all" is
  // not satisfied by the rows on screen.
  run.harness.typeText('project-backlog-search-input','d');
  const summary=()=>run.root().querySelector('[data-project-backlog-selection-count]')!;
  expect(run.rows()).toEqual(['second']);
  expect(summary().getAttribute('data-project-backlog-selection-count')).toBe('1');
  expect(summary().getAttribute('data-project-backlog-selection-hidden')).toBe('1');
  expect(summary().textContent).toContain('1 selected hidden by the query');
  // Select all now means the one row on screen, and it is already marked.
  expect(run.root().querySelector('[data-c1-key="project-backlog-select-all"]')!.hasAttribute('disabled')).toBe(true);
  run.harness.click('project-backlog-select-none');
  expect(run.view().selectedTaskIds).toEqual([]);
  run.stop();
 });
 it('keeps the order a selection was made in, and never writes a record',()=>{
  const s=state();const before=JSON.stringify(s);const run=session(s);
  run.harness.click('project-backlog-select-second');
  run.harness.click('project-backlog-select-first');
  expect(run.view().selectedTaskIds).toEqual(['second','first']);
  expect(JSON.stringify(s)).toBe(before);
  run.stop();
 });
});
describe('Stage 6 template composer',()=>{
 it('opens from the Backlog, takes text, and previews the tasks it read',()=>{
  const s=state();const run=session(s);
  expect(run.root().querySelector('[data-c1-key="template-composer"]')).toBeNull();
  run.harness.click('project-backlog-open-template');
  expect(run.root().querySelector('[data-c1-key="template-composer"]')).not.toBeNull();
  expect((run.root().querySelector('[data-template-text]') as HTMLTextAreaElement).value).toBe('');
  expect(run.root().querySelector('[data-template-preview-empty="true"]')).not.toBeNull();
  // Typing re-renders, so the preview and the report follow the text as it is written.
  run.harness.typeText('template-text','S');
  expect(run.view().templateText).toBe('S');
  expect((run.root().querySelector('[data-template-text]') as HTMLTextAreaElement).value).toBe('S');
  expect(run.root().querySelector('[data-template-preview-task="S"]')).not.toBeNull();
  expect(run.root().querySelector('[data-template-preview-count]')!.getAttribute('data-template-preview-count')).toBe('1');
  expect(run.root().querySelector('[data-template-errors-clean="true"]')).not.toBeNull();
  run.stop();
 });
 it('reports one positioned complaint per line it could not read, and keeps the rest',()=>{
  const s=state();const run=session(s);
  run.harness.click('project-backlog-open-template');
  const text=['Ship','  weight: heavy','  nope: x','Notes'].join('\n');
  run.harness.target('template-text').textContent=text;
  (run.root().querySelector('[data-template-text]') as HTMLTextAreaElement).value=text;
  (run.root().querySelector('[data-template-text]') as HTMLTextAreaElement).dispatchEvent(new Event('input',{bubbles:true}));
  const errors=Array.from(run.root().querySelectorAll('[data-template-error]')).map(x=>x as HTMLElement);
  expect(errors.map(x=>x.dataset.templateError)).toEqual(['invalid-number','unknown-field']);
  expect(errors.map(x=>x.dataset.templateErrorLine)).toEqual(['2','3']);
  expect(errors[0]!.textContent).toContain('Line 2, column 11');
  expect(run.root().querySelector('[data-template-error-count]')!.getAttribute('data-template-error-count')).toBe('2');
  // Both tasks were still read, and the message quotes the line it is about.
  expect(Array.from(run.root().querySelectorAll('[data-template-preview-task]')).map(x=>x.getAttribute('data-template-preview-task'))).toEqual(['Ship','Notes']);
  expect(errors[1]!.querySelector('code')!.textContent).toBe('nope: x');
  run.stop();
 });
 it('refuses execution with a typed result rather than hiding the control',()=>{
  const s=state();const before=JSON.stringify(s);const run=session(s);
  run.harness.click('project-backlog-open-template');
  const execute=run.root().querySelector<HTMLButtonElement>('[data-c1-key="template-execute"]')!;
  expect(execute.disabled).toBe(true);
  expect(execute.getAttribute('data-template-execute-refusal')).toBe('action-not-available');
  expect(run.root().querySelector('[data-c1-key="template-execute-note"]')!.textContent).toContain('until task records can be written');
  expect(JSON.stringify(s)).toBe(before);
  run.stop();
 });
 it('closes on Cancel, and forgets nothing about the project',()=>{
  const s=state();const before=JSON.stringify(s);const run=session(s);
  run.harness.click('project-backlog-open-template');
  run.harness.typeText('template-text','S');
  run.harness.click('template-composer-cancel');
  expect(run.root().querySelector('[data-c1-key="template-composer"]')).toBeNull();
  expect(run.view().templateOpen).toBe(false);
  expect(JSON.stringify(s)).toBe(before);
  run.stop();
 });
});
