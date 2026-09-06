import { describe, expect, it } from 'vitest';
import { createActionDispatcher, isActionResult, parseAction } from '../src/app/actionProtocol.js';
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
  });

  it('uses one dispatcher for project/surface/calendar intent and increments revision only when state changes', async () => {
    const dispatcher = await fixtureDispatcher();
    expect(dispatcher.snapshot()).toMatchObject({ surface: 'board', selection: 'all', calendarMonth: '2026-09-01', stateRevision: 1 });

    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'proj-backpack' })).toMatchObject({ ok: true, changed: true, stateRevision: 2 });
    expect(dispatcher.snapshot().selection).toBe('proj-backpack');

    const switched = dispatcher.dispatch({ type: 'surface.select', surface: 'calendar' });
    expect(switched).toMatchObject({ ok: true, changed: true, stateRevision: 3, snapshot: { selection: 'all', surface: 'calendar' } });

    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'proj-term' })).toMatchObject({ ok: true, changed: true, stateRevision: 4 });
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
});
