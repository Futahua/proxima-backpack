import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection, isInspectionProjection } from '../src/app/inspection.js';
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
    expect(projection).toMatchObject({ schemaVersion: 1, mode: 'fixture', applicationStateRevision: 1, surface: 'board', selection: 'all', board: { counts: { backlog: 1, running: 5, finished: 1 } }, pendingOperations: [], latestEventSequence: 0 });
    expect(projection.projects).toHaveLength(3);
    expect(projection.board.tasks).toHaveLength(7);
    expect(projection.calendar.events).toHaveLength(3);
    expect(projection.calendar.events.find((event) => event.id === 'evt-studio-week')?.dayKeys).toHaveLength(6);
    expect(projection.sourceRevisions).toHaveLength(13);
    expect(projection.sourceRevisions.every((entry) => entry.path && !entry.path.includes(':'))).toBe(true);
  });

  it('reflects the same dispatcher actions and redacts source paths for live mode', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'live' });
    expect(dispatcher.dispatch({ type: 'surface.select', surface: 'calendar' })).toMatchObject({ ok: true, snapshot: { surface: 'calendar' } });
    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'proj-term' })).toMatchObject({ ok: true, snapshot: { selection: 'proj-term' } });
    const projection = createInspectionProjection(dispatcher.snapshot(), build);

    expect(projection.surface).toBe('calendar');
    expect(projection.selection).toBe('proj-term');
    expect(projection.sourceRevisions.every((entry) => entry.path === undefined)).toBe(true);
    expect(projection.loadProblems.every((problem) => !problem.path || !problem.path.includes(':'))).toBe(true);
  });

  it('keeps diagnostic detail bounded and reports degraded state from blocking problems', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-duplicates'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, mode: 'fixture' });
    const projection = createInspectionProjection(dispatcher.snapshot(), build);
    expect(projection.degraded.state).toBe('degraded');
    expect(projection.degraded.blockingProblemCount).toBeGreaterThan(0);
    expect(projection.loadProblems.every((problem) => problem.detail.length <= 400)).toBe(true);
  });
});
