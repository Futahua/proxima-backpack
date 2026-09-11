import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createActionDispatcher, type ProximaAction } from '../src/app/actionProtocol.js';
import { categoryOf, registeredActionTypes } from '../src/app/actionTaxonomy.js';
import { fixedClock } from '../src/domain/clock.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

const WIRED_UI_RECORD_MUTATIONS = [
  'canvas.node.geometry.change', 'canvas.node.remove', 'task.execution.move',
  'project.create', 'event.schedule.create', 'event.schedule.change', 'task.timeline.change',
] as const;
const UNWIRED_UI_RECORD_MUTATIONS = [
  'project.archive', 'project.restore', 'project.delete', 'event.schedule.recurrence.change',
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

  it('keeps browser mutation gestures on the typed dispatcher and gives the UI no RecordStore authority', async () => {
    const source = await readFile(new URL('../src/browser/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('const result = actionDispatcher.dispatch(input);');
    const dispatcherLine = source.split('\n').find((line) => line.includes('actionDispatcher = createActionDispatcher({'));
    expect(dispatcherLine).toBeDefined();
    for (const forbidden of ['RecordStore', 'RecordMutationCoordinator', 'RecordStoreFileBackend', 'recordStore', 'backend', 'recovery', 'mutationAuthority']) expect(dispatcherLine).not.toContain(forbidden);
    for (const forbidden of ['jsonRecordStore', 'recordRecoveryStartup', 'opfsRecordStoreFileBackend', 'createCanonicalJsonRecordStore(', 'createRecordMutationCoordinator(', 'startRecordMutationAuthority(', 'createBrowserOpfsRecordStoreFileBackend(', '.updateIfUnchanged(', '.deleteIfUnchanged(']) expect(source).not.toContain(forbidden);
    for (const type of WIRED_UI_RECORD_MUTATIONS) expect(source).toMatch(new RegExp(`dispatchAction\\(\\{[\\s\\S]{0,500}?type:\\s*'${escapeRegExp(type)}'`));
    for (const type of UNWIRED_UI_RECORD_MUTATIONS) expect(source).not.toContain(`type: '${type}'`);
    expect([...WIRED_UI_RECORD_MUTATIONS, ...UNWIRED_UI_RECORD_MUTATIONS].sort()).toEqual(registeredActionTypes().filter((type) => categoryOf(type) === 'record-mutation'));
  });
});
