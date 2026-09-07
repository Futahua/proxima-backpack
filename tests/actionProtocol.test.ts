import { describe, expect, it } from 'vitest';
import { createActionDispatcher, isActionResult, parseAction } from '../src/app/actionProtocol.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

async function fixtureDispatcher() {
  const loaded = await loadVaultState(fixtureVault('vault-basic'));
  return createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture' });
}

describe('Gate 3A semantic action protocol', () => {
  it('rejects malformed actions with stable machine-readable errors', () => {
    expect(parseAction(null)).toEqual({ ok: false, error: { code: 'invalid-action', message: 'action must be an object with a string type', field: 'type' } });
    expect(parseAction({ type: 'calendar.shift-month', delta: 2 })).toEqual({ ok: false, error: { code: 'invalid-action-input', message: 'delta must be -1 or 1', field: 'delta' } });
    expect(parseAction({ type: 'unknown.action' })).toMatchObject({ ok: false, error: { code: 'invalid-action' } });
    expect(parseAction({ type: 'surface.select', surface: 'canvas' })).toEqual({ ok: true, action: { type: 'surface.select', surface: 'canvas' } });
    expect(parseAction({ type: 'surface.select', surface: 'bogus' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', message: 'surface must be board, calendar or canvas', field: 'surface' } });
  });

  it('uses one dispatcher for project/surface/calendar intent and increments revision only when state changes', async () => {
    const dispatcher = await fixtureDispatcher();
    expect(dispatcher.snapshot()).toMatchObject({ surface: 'board', selection: 'all', calendarMonth: '2026-09-01', stateRevision: 1 });

    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'proj-backpack' })).toMatchObject({ ok: true, changed: true, stateRevision: 2 });
    expect(dispatcher.snapshot().selection).toBe('proj-backpack');

    const switched = dispatcher.dispatch({ type: 'surface.select', surface: 'calendar' });
    expect(switched).toMatchObject({ ok: true, changed: true, stateRevision: 3, snapshot: { selection: 'all', surface: 'calendar' } });

    const canvas = dispatcher.dispatch({ type: 'surface.select', surface: 'canvas' });
    expect(canvas).toMatchObject({ ok: true, snapshot: { surface: 'canvas', selection: 'all' } });
    expect(isActionResult(canvas)).toBe(true);

    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'proj-term' })).toMatchObject({ ok: true, changed: false, stateRevision: 4 });
    expect(dispatcher.dispatch({ type: 'calendar.shift-month', delta: 1 })).toMatchObject({ ok: true, changed: true, stateRevision: 5, snapshot: { calendarMonth: '2026-10-01' } });
    expect(dispatcher.dispatch({ type: 'fixture.reset' })).toMatchObject({ ok: true, changed: true, stateRevision: 6, snapshot: { selection: 'all', surface: 'board', calendarMonth: '2026-09-01' } });

    const noOp = dispatcher.dispatch({ type: 'fixture.reset' });
    expect(noOp).toMatchObject({ ok: true, changed: false, stateRevision: 6 });
    expect(isActionResult(dispatcher.dispatch({ type: 'calendar.shift-month', delta: -1 }))).toBe(true);
  });

  it('does not turn an unknown project id into an all-projects action', async () => {
    const dispatcher = await fixtureDispatcher();
    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'not-a-project' })).toMatchObject({ ok: false, error: { code: 'project-not-found', field: 'projectId' }, stateRevision: 1 });
  });

  it('keeps fixture-only reset unavailable for a live dispatcher', async () => {
    const fixture = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: fixture.state, mode: 'live' });
    expect(dispatcher.dispatch({ type: 'fixture.reset' })).toMatchObject({ ok: false, error: { code: 'action-not-available' } });
  });

  it('settles synchronously and emits deterministic accepted/rejected events for the same actions', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, clock: fixedClock('2026-09-06T12:00:00.000Z'), idGenerator: sequentialIdGenerator(), eventCapacity: 8 });
    const accepted = dispatcher.dispatch({ type: 'project.select', projectId: 'proj-backpack' });
    const rejected = dispatcher.dispatch({ type: 'project.select', projectId: 'missing' });
    expect(accepted).toMatchObject({ ok: true, requestId: 'request-0001', stateRevision: 2 });
    expect(rejected).toMatchObject({ ok: false, requestId: 'request-0002', stateRevision: 2 });
    expect(dispatcher.snapshot()).toMatchObject({ stateRevision: 2, settled: true, settledRevision: 2, latestEventSequence: 3 });
    expect(dispatcher.events().map((event) => [event.sequence, event.kind, event.stateRevision])).toEqual([[1, 'action.accepted', 2], [2, 'state.settled', 2], [3, 'action.rejected', 2]]);
    expect(dispatcher.events(2)[0]).toMatchObject({ sequence: 3, errorCode: 'project-not-found', timestamp: '2026-09-06T12:00:00.000Z' });
  });
});
