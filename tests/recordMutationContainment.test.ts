import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createActionDispatcher, type ProximaAction } from '../src/app/actionProtocol.js';
import { categoryOf, registeredActionTypes } from '../src/app/actionTaxonomy.js';
import { fixedClock } from '../src/domain/clock.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

/**
 * Record-mutation action types the UI reaches through the typed dispatcher. Each is refused
 * there with a typed reason, which is the truthful answer while the dispatcher holds no store
 * authority of its own.
 */
const DISPATCHER_UI_RECORD_MUTATIONS = [
  'canvas.node.geometry.change', 'canvas.node.remove',
] as const;

/**
 * The record mutations with a semantic write path: the UI reaches each through a sequence in
 * `src/app/`, which either writes through the operation layer or refuses with a typed reason. They
 * are deliberately *not* dispatched any more — the dispatcher would answer `action-not-available`,
 * and recording a rejection the reader never experienced is worse than recording nothing.
 *
 * `task.execution.move` joined at `abf8204` (the Elastic drop). The four project verbs joined when
 * the Projects Hub's two forms and its three lifecycle controls were wired to
 * `src/app/projectLifecycleActions.ts`: `project.delete` is in this list even though it refuses,
 * because its refusal is the operation's own answer (`policy-not-decided`) rather than the
 * dispatcher's placeholder.
 */
const OPERATION_UI_RECORD_MUTATIONS = [
  'task.execution.move', 'project.create', 'project.archive', 'project.restore', 'project.delete',
  'event.schedule.create', 'event.schedule.change', 'task.timeline.change',
] as const;

const UNWIRED_UI_RECORD_MUTATIONS = [
  'event.schedule.recurrence.change',
] as const;
/** How a mutation reaches storage must live behind the adapter seam, never in the shell. */
const STORE_AUTHORITY_COMPOSITION = [
  'createCanonicalJsonRecordStore(', 'createRecordMutationCoordinator(', 'startRecordMutationAuthority(',
  'createBrowserOpfsRecordStoreFileBackend(', "from '../app/jsonRecordStore.js'",
  "from '../ports/recordStore.js'", "from '../adapters/opfsRecordStoreFileBackend.js'",
  '.createIfAbsent(', '.updateIfUnchanged(', '.deleteIfUnchanged(',
] as const;

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

describe('Stage 7 slice 18 semantic/UI mutation containment', () => {
  it('keeps every registered record-mutation action typed-unavailable through programmatic dispatch', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const project = loaded.state.projects[0]; const task = loaded.state.tasks[0]; const event = loaded.state.events[0];
    if (!project || !task || !event) throw new Error('vault-basic must expose a project, task and event for mutation-containment evidence');
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture', clock: fixedClock('2026-09-06T12:00:00.000Z'), canvasNodeExists: () => true });
    const beforeRevision = dispatcher.snapshot().stateRevision; const beforeState = JSON.stringify(dispatcher.snapshot().state);
    const actions: ProximaAction[] = [
      { type: 'project.create', name: 'Containment proof', description: '' },
      { type: 'project.archive', projectId: project.id }, { type: 'project.restore', projectId: project.id }, { type: 'project.delete', projectId: project.id },
      { type: 'canvas.node.geometry.change', nodeId: 'containment-node', operation: 'move', proposedX: 100, proposedY: 120, proposedWidth: 320, proposedHeight: 240 },
      { type: 'canvas.node.remove', nodeId: 'containment-node' },
      { type: 'task.timeline.change', taskId: task.id, operation: 'move', proposedStartDate: '2026-09-07T10:00:00.000Z', proposedDeadline: '2026-09-07T11:00:00.000Z', targetRowIndex: 0 },
      { type: 'task.execution.move', taskId: task.id, targetColumn: 'running', targetIndex: 0 },
      { type: 'event.schedule.change', eventId: event.id, operation: 'move', proposedStartDate: '2026-09-07T10:00:00.000Z', proposedDeadline: '2026-09-07T11:00:00.000Z' },
      { type: 'event.schedule.create', name: 'Containment proof', projectId: project.id, description: '', startDate: '2026-09-07T10:00:00.000Z', deadline: '2026-09-07T11:00:00.000Z' },
      { type: 'event.schedule.recurrence.change', eventId: event.id, scope: 'series', occurrenceStartDate: '2026-09-07T10:00:00.000Z', proposedStartDate: '2026-09-07T10:15:00.000Z', proposedDeadline: '2026-09-07T11:15:00.000Z' },
    ];
    const registeredMutations = registeredActionTypes().filter((type) => categoryOf(type) === 'record-mutation');
    expect(actions.map((action) => action.type).sort()).toEqual(registeredMutations);
    expect(registeredMutations).toHaveLength(11);
    for (const action of actions) expect(dispatcher.dispatch(action)).toMatchObject({ ok: false, actionType: action.type, category: 'record-mutation', outcome: 'unavailable', stateRevision: beforeRevision, error: { code: 'action-not-available' } });
    expect(dispatcher.snapshot().stateRevision).toBe(beforeRevision);
    expect(JSON.stringify(dispatcher.snapshot().state)).toBe(beforeState);
  });

  it('keeps RecordStore mutation authority out of dispatcher options and dispatcher execution', async () => {
    const source = await readFile(new URL('../src/app/actionProtocol.ts', import.meta.url), 'utf8');
    const optionsStart = source.indexOf('export interface ActionDispatcherOptions {'); const optionsEnd = source.indexOf('export interface ProximaActionDispatcher {');
    expect(optionsStart).toBeGreaterThanOrEqual(0); expect(optionsEnd).toBeGreaterThan(optionsStart);
    const options = source.slice(optionsStart, optionsEnd);
    for (const forbidden of ['RecordStore', 'RecordMutationCoordinator', 'RecordStoreFileBackend', 'recordStore', 'backend', 'recovery', 'mutationAuthority']) expect(options).not.toContain(forbidden);
    for (const forbidden of ["from './jsonRecordStore.js'", "from '../ports/recordStore.js'", "from './recordRecoveryStartup.js'", "from '../adapters/opfsRecordStoreFileBackend.js'", 'createCanonicalJsonRecordStore(', 'createRecordMutationCoordinator(', 'startRecordMutationAuthority(', 'createBrowserOpfsRecordStoreFileBackend(', '.updateIfUnchanged(', '.deleteIfUnchanged(']) expect(source).not.toContain(forbidden);
    expect(source).toContain("import type {\n  RecordMutationOutcome,\n} from './recordMutation.js';");
    expect(source).toContain('recordMutationRecoveryActionFailure(');
  });

  it('routes the Elastic drop through the semantic write path instead of the dispatcher', async () => {
    const source = await readFile(new URL('../src/browser/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('const result = actionDispatcher.dispatch(input);');
    const dispatcherLine = source.split('\n').find((line) => line.includes('actionDispatcher = createActionDispatcher({'));
    expect(dispatcherLine).toBeDefined();
    for (const forbidden of ['RecordStore', 'RecordMutationCoordinator', 'RecordStoreFileBackend', 'recordStore', 'backend', 'recovery', 'mutationAuthority']) expect(dispatcherLine).not.toContain(forbidden);
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(source).not.toContain(forbidden);

    // Wired: a drop becomes one semantic gesture, it carries the revision it read at, and the
    // surfaces are refreshed from the store afterwards rather than drawn optimistically. The
    // sequence itself lives in the app layer, where tests execute it against a real store; the
    // shell keeps only the sinks a render needs.
    expect(source).toContain("from '../adapters/browserTaskMutations.js'");
    expect(source).toContain('resolveBrowserTaskMutations(');
    expect(source).toContain('performElasticDrop(');
    expect(source).toMatch(/moveTask:\s*\(\{ taskId, targetColumn, targetIndex \}\) => \{[\s\S]{0,200}?moveTaskFromDrop\(/);
    expect(source).toContain('refresh: refreshFromSource,');
    expect(source).toContain('setRefusal: (reason) => { elasticDropRefusal = reason; },');
    expect(source).not.toContain("type: 'task.execution.move'");

    const dropAction = await readFile(new URL('../src/app/elasticDropAction.ts', import.meta.url), 'utf8');
    expect(dropAction).toContain('expectedRevision: task.source.revision');
    expect(dropAction).toContain('moveTaskByGesture(');
    // And the app layer holds no storage either: it takes operations, not a store.
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(dropAction).not.toContain(forbidden);
    expect(dropAction).not.toContain('RecordStore');

    // The Task editor's Save and Delete are wired the same way: intents from the binder, sequences
    // in the app layer, and the shell's only decisions are its own two pieces of state.
    expect(source).toContain('saveTaskAction(');
    expect(source).toContain('deleteTaskAction(');
    expect(source).toMatch(/saveTask:\s*\(\)\s*=>\s*\{[\s\S]{0,120}?saveTaskFromEditorAction\(\)/);
    expect(source).toMatch(/deleteTask:\s*\(\)\s*=>\s*\{[\s\S]{0,120}?deleteTaskFromEditorAction\(\)/);
    const editorWrite = await readFile(new URL('../src/app/taskEditorWrite.ts', import.meta.url), 'utf8');
    expect(editorWrite).toContain('expectedRevision: task.source.revision');
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(editorWrite).not.toContain(forbidden);
    expect(editorWrite).not.toContain('RecordStore');
    // The modal's write view is the shell's own resolution, so a form cannot offer a write this
    // run has no path for.
    expect(source).toContain('taskWrites: taskModalWriteView(),');
    expect(source).toContain('taskMutations === null');

    // The New Task form is wired the third way, and it is the same way: the shell opens a draft,
    // the app layer plans and executes it.
    expect(source).toContain('createTaskAction(');
    expect(source).toContain('newTaskDraftFor(');
    expect(source).toMatch(/createTask:\s*\(\)\s*=>\s*\{[\s\S]{0,120}?createTaskFromFormAction\(\)/);
    const create = await readFile(new URL('../src/app/taskCreate.ts', import.meta.url), 'utf8');
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(create).not.toContain(forbidden);
    expect(create).not.toContain('RecordStore');
    // And the request it writes comes from the plan, not from the form's markup.
    expect(create).toContain('planTaskCreate(deps.state, input.draft)');

    // The Projects Hub's forms and its three lifecycle controls are wired the same way, and they are
    // the last record-mutation UI to leave the dispatcher: the shell runs the sequence, holds the
    // answer the form or the hub draws, and re-reads; the app layer owns validation, the revision
    // and the write. A project form does not name an action type, so the guard follows the
    // sequences instead — that is what "routed to the operation layer" means here.
    expect(source).toContain('createProjectAction(');
    expect(source).toContain('updateProjectAction(');
    expect(source).toContain('archiveProjectAction(');
    expect(source).toContain('restoreProjectAction(');
    expect(source).toContain('deleteProjectAction(');
    expect(source).toMatch(/createProject:\s*\(\{ name, description \}\)\s*=>\s*\{[\s\S]{0,120}?createProjectFromFormAction\(/);
    expect(source).toMatch(/saveProjectEdit:\s*\(\{ projectId, name, description \}\)\s*=>\s*\{[\s\S]{0,120}?saveProjectEditAction\(/);
    expect(source).toMatch(/archiveProject:\s*\(projectId\)\s*=>\s*\{[\s\S]{0,120}?runProjectLifecycle\('archive'/);
    const lifecycleActions = await readFile(new URL('../src/app/projectLifecycleActions.ts', import.meta.url), 'utf8');
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(lifecycleActions).not.toContain(forbidden);
    expect(lifecycleActions).not.toContain('RecordStore');
    // The revision a lifecycle write carries is the one the surface was rendering, and the re-read
    // follows an accepted write rather than a redraw from a guess. It reaches the sequence through the
    // resolver - the hub answers with the project it was showing - so the assertion follows the fact.
    expect(lifecycleActions).toContain("    : deps.state?.projects.find((candidate) => candidate.id === projectId)?.source.revision ?? null;");
    expect(lifecycleActions).toContain('convergeAfterWrite(');
    // The editor's mutations are planned from the record and the draft, not read out of the markup.
    const editor = await readFile(new URL('../src/app/projectEditor.ts', import.meta.url), 'utf8');
    expect(editor).toContain('planProjectFieldMutations');
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(editor).not.toContain(forbidden);

    // The Schedule's three write paths, wired the same way: the grid's binder hands over an intent,
    // the shell runs the sequence, and the app layer owns the span rule and the write.
    expect(source).toContain('createEventAction(');
    expect(source).toContain('rescheduleEventAction(');
    expect(source).toContain('resizeEventAction(');
    expect(source).toMatch(/createEvent:\s*\(\{ name, projectId, description, startDate, deadline \}\)\s*=>\s*\{[\s\S]{0,120}?createEventFromSeed\(/);
    expect(source).toMatch(/changeEvent:\s*\(\{ eventId, operation, proposedStartDate, proposedDeadline \}\)\s*=>\s*\{[\s\S]{0,120}?changeEventFromGesture\(/);
    const eventActions = await readFile(new URL('../src/app/eventWriteActions.ts', import.meta.url), 'utf8');
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(eventActions).not.toContain(forbidden);
    expect(eventActions).not.toContain('RecordStore');
    // The revision is the one the surface was rendering, and a lost race re-reads. It reaches the sequence
    // through the resolver rather than from a projection the operation reads for itself - the same split the
    // Gantt below has - so the assertion follows the fact to where it now lives.
    expect(eventActions).toContain('const event = deps.state?.events.find((candidate) => candidate.id === eventId);');
    expect(eventActions).toContain('return event === undefined ? null : { revision: event.source.revision, record: event };');
    expect(eventActions).toContain('convergeAfterWrite(');

    // The Gantt's date change is wired the same way, and the guard follows it: the shell runs a
    // sequence, and the row the bar landed in is *reported* rather than written, because A3 keeps
    // Gantt row placement local instead of making it a third durable task order.
    expect(source).toContain('changeTaskDatesAction(');
    expect(source).toMatch(/changeTask:\s*\(\{ taskId, operation, proposedStartDate, proposedDeadline, targetRowIndex \}\)\s*=>\s*\{[\s\S]{0,140}?changeTaskDatesFromGantt\(/);
    const timeline = await readFile(new URL('../src/app/timelineChangeAction.ts', import.meta.url), 'utf8');
    for (const forbidden of STORE_AUTHORITY_COMPOSITION) expect(timeline).not.toContain(forbidden);
    expect(timeline).not.toContain('RecordStore');
    expect(timeline).toContain('expectedRevision: task.source.revision');
    expect(timeline).toContain('rowApplied: false');
    expect(timeline).toContain('convergeAfterWrite(');

    for (const type of DISPATCHER_UI_RECORD_MUTATIONS) expect(source).toMatch(new RegExp(`dispatchAction\\(\\{[\\s\\S]{0,500}?type:\\s*'${escapeRegExp(type)}'`));
    for (const type of UNWIRED_UI_RECORD_MUTATIONS) expect(source).not.toContain(`type: '${type}'`);
    expect([...DISPATCHER_UI_RECORD_MUTATIONS, ...OPERATION_UI_RECORD_MUTATIONS, ...UNWIRED_UI_RECORD_MUTATIONS].sort()).toEqual(registeredActionTypes().filter((type) => categoryOf(type) === 'record-mutation'));
  });

  it('keeps every record-store composition behind the adapter, out of the whole shell directory', async () => {
    const directory = new URL('../src/browser/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.ts'));
    expect(names.length).toBeGreaterThan(10);
    const sources = await Promise.all(names.map(async (name) => ({ name, text: await readFile(new URL(name, directory), 'utf8') })));

    for (const forbidden of STORE_AUTHORITY_COMPOSITION) {
      expect(sources.filter((source) => source.text.includes(forbidden)).map((source) => source.name)).toEqual([]);
    }

    // The sanctioned composition exists, and it is in the adapter that hands the shell
    // operations: backend, journal, activation marker and Stage 7's recovery gate.
    const adapter = await readFile(new URL('../src/adapters/browserTaskMutations.ts', import.meta.url), 'utf8');
    for (const required of ['createCanonicalJsonRecordStore(', 'createBrowserOpfsRecordStoreFileBackend(', 'createBrowserOpfsRecordRecoveryJournalBackend(', 'startRecordMutationAuthority(', 'readRecordStoreActivation(']) expect(adapter).toContain(required);
    // And it refuses to hand anything back without all three conditions, each named.
    for (const reason of ["'not-activated'", "'recovery-blocked'", "'store-unreadable'"]) expect(adapter).toContain(reason);
  });
});
