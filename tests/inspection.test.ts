import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection, isInspectionProjection, MAX_INSPECTION_ITEMS } from '../src/app/inspection.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

const build = {
  proximaVersion: '0.1.0',
  gitSha: 'test-sha',
  buildMode: 'fixture',
  domainSchemaVersion: '1',
  controlSchemaVersion: '0',
  fixtureSchemaVersion: '1',
  fixtureHash: 'fixture-hash',
  lockfileHash: 'lock-hash',
  fixedClock: '2026-09-06T12:00:00.000Z',
};

describe('Gate 3A inspection projection', () => {
  it('projects fixture state without depending on renderer or store details', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture' });
    const projection = createInspectionProjection(dispatcher.snapshot(), build);

    expect(isInspectionProjection(projection)).toBe(true);
    expect(projection).toMatchObject({
      schemaVersion: 3,
      mode: 'fixture',
      applicationStateRevision: 1,
      surface: 'tasks',
      submode: 'elastic',
      selection: 'all',
      localState: {
        surface: 'tasks',
        selection: 'all',
        tasksMode: 'elastic',
        scheduleMode: 'month',
        projectWorkspaceTab: 'notes',
        calendarMonth: '2026-09-01',
      },
      board: {
        counts: {
          backlog: 1,
          running: 5,
          finished: 1,
        },
      },
      pendingOperations: {
        tracking: 'unavailable',
        items: [],
      },
      eventSequences: {
        action: 0,
        mutation: null,
      },
      latestEventSequence: 0,
      settled: {
        state: 'settled',
        revision: 1,
      },
    });

    expect(projection.projects).toHaveLength(3);
    expect(projection.board.tasks).toHaveLength(7);
    expect(projection.calendar.events).toHaveLength(3);
    expect(projection.calendar.events.find((event) => event.id === 'evt-studio-week')?.dayKeys).toHaveLength(6);
    expect(projection.recordRevisions).toHaveLength(13);
    expect(projection.recordRevisions).toEqual(projection.sourceRevisions);
    expect(projection.sourceRevisions.every((entry) => entry.path && !entry.path.includes(':'))).toBe(true);
  });

  it('reflects dispatcher actions, exposes settled state, and redacts source paths for live mode', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'live' });

    expect(dispatcher.dispatch({ type: 'surface.select', surface: 'schedule' })).toMatchObject({ ok: true, snapshot: { surface: 'schedule' } });
    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'proj-term' })).toMatchObject({ ok: true, snapshot: { selection: 'proj-term' } });

    const projection = createInspectionProjection(dispatcher.snapshot(), build);

    expect(projection.surface).toBe('schedule');
    expect(projection.submode).toBe('month');
    expect(projection.selection).toBe('proj-term');
    expect(projection.localState).toMatchObject({
      surface: 'schedule',
      selection: 'proj-term',
      tasksMode: 'elastic',
      scheduleMode: 'month',
      projectWorkspaceTab: 'notes',
      calendarMonth: '2026-09-01',
      elasticLockedAt: null,
    });
    expect(Number.isFinite(Date.parse(projection.localState.elasticTargetTime))).toBe(true);
    expect(projection.eventSequences.action).toBe(projection.latestEventSequence);
    expect(projection.eventSequences.action).toBeGreaterThan(0);
    expect(projection.eventSequences.mutation).toBeNull();
    expect(projection.pendingOperations).toEqual({
      tracking: 'unavailable',
      items: [],
    });
    expect(projection.settled).toEqual({
      state: 'settled',
      revision: projection.applicationStateRevision,
    });
    expect(projection.recordRevisions.every((entry) => entry.path === undefined)).toBe(true);
    expect(projection.sourceRevisions.every((entry) => entry.path === undefined)).toBe(true);
    expect(projection.loadProblems.every((problem) => !problem.path || !problem.path.includes(':'))).toBe(true);
  });

  it('reports busy state directly so callers can wait on inspection rather than sleeps', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture' });
    const state = dispatcher.snapshot();
    const projection = createInspectionProjection({
      ...state,
      settled: false,
      settledRevision: 0,
    }, build);

    expect(isInspectionProjection(projection)).toBe(true);
    expect(projection.settled).toEqual({
      state: 'busy',
      revision: 0,
    });
    expect(projection.applicationStateRevision).toBe(state.stateRevision);
  });

  it('accepts canvas inspection and rejects dishonest pending or mutation state', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture' });

    expect(dispatcher.dispatch({ type: 'surface.select', surface: 'canvas' })).toMatchObject({
      ok: true,
      snapshot: {
        surface: 'canvas',
      },
    });

    const projection = createInspectionProjection(dispatcher.snapshot(), build);

    expect(projection.surface).toBe('canvas');
    expect(isInspectionProjection(projection)).toBe(true);
    expect(isInspectionProjection({
      ...projection,
      pendingOperations: [],
    })).toBe(false);
    expect(isInspectionProjection({
      ...projection,
      pendingOperations: {
        tracking: 'unavailable',
        items: ['pretend-pending-operation'],
      },
    })).toBe(false);
    expect(isInspectionProjection({
      ...projection,
      eventSequences: {
        ...projection.eventSequences,
        mutation: 0,
      },
    })).toBe(false);
  });

  it('keeps diagnostic detail bounded and reports degraded state from blocking problems', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-duplicates'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, mode: 'fixture' });
    const projection = createInspectionProjection(dispatcher.snapshot(), build);

    expect(projection.degraded.state).toBe('degraded');
    expect(projection.degraded.blockingProblemCount).toBeGreaterThan(0);
    expect(projection.loadProblems.every((problem) => problem.detail.length <= 400)).toBe(true);

    const manyProblems = Array.from({ length: MAX_INSPECTION_ITEMS + 25 }, (_, index) => ({
      code: 'unreadable' as const,
      severity: 'error' as const,
      path: `fixture/${index}.md`,
      detail: 'x'.repeat(1000),
    }));
    const bounded = createInspectionProjection({ ...dispatcher.snapshot(), problems: manyProblems }, build);

    expect(bounded.loadProblems).toHaveLength(MAX_INSPECTION_ITEMS);
    expect(bounded.loadProblems.every((problem) => problem.detail.length <= 400)).toBe(true);
  });
});
