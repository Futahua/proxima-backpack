import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { createUiHealthModel } from '../src/app/uiHealth.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

const build = {
  proximaVersion: '0.1.0', gitSha: 'test-sha', buildMode: 'fixture', domainSchemaVersion: '1',
  controlSchemaVersion: '0', fixtureSchemaVersion: '1', fixtureHash: 'fixture-hash',
  lockfileHash: 'lock-hash', fixedClock: '2026-09-06T12:00:00.000Z',
};

describe('Gate 6D stale/degraded UI and inspection health', () => {
  it('normalizes one bounded health model for both UI and inspection', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const controller = createRefreshController({ vault: fixtureVault('vault-basic'), initial: loaded });
    const projection = createReadOnlyProjection(controller.snapshot(), 7);
    const health = createUiHealthModel(projection.health);
    const dispatcher = createActionDispatcher({ state: projection.state, problems: projection.problems, revisions: projection.revisions, mode: 'fixture' });
    const inspection = createInspectionProjection(dispatcher.snapshot(), build, projection.health);

    expect(inspection.sourceHealth).toEqual(health);
    expect(health).toMatchObject({ sourceRevision: 1, applicationRevision: 7, status: 'healthy', stale: false, degraded: false });
    expect(health.problemCodes.length).toBeLessThanOrEqual(20);
  });

  it('keeps Projects, Board, and Calendar content while exposing the same degraded generation', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    const failingVault = { ...vault, read: async () => { throw new Error('cannot read source'); } };
    const controller = createRefreshController({ vault: failingVault, initial });
    const failure = await controller.refreshSource('external-signal');
    const projection = createReadOnlyProjection(failure.snapshot);
    const dispatcher = createActionDispatcher({ state: projection.state, problems: projection.problems, revisions: projection.revisions, mode: 'fixture' });
    const inspection = createInspectionProjection(dispatcher.snapshot(), build, projection.health);

    expect(projection.state.projects).toHaveLength(3);
    expect(projection.state.tasks).toHaveLength(7);
    expect(projection.state.events).toHaveLength(3);
    expect(inspection.projects).toHaveLength(3);
    expect(inspection.board.tasks).toHaveLength(7);
    expect(inspection.calendar.events).toHaveLength(3);
    expect(inspection.sourceHealth).toMatchObject({ sourceRevision: 1, applicationRevision: 1, stale: true, degraded: true, status: 'degraded', lastRefreshReason: 'external-signal' });
    expect(inspection.sourceHealth.sourceRevision).toBe(projection.generation);
  });

  it('clears stale/degraded state on recovery and isolates inspection health copies', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    let unreadable = true;
    const reader = { ...vault, read: async (path: string) => { if (unreadable) throw new Error('temporary'); return vault.read(path); } };
    const controller = createRefreshController({ vault: reader, initial });
    const failed = await controller.refreshSource('focus');
    const failedProjection = createReadOnlyProjection(failed.snapshot);
    unreadable = false;
    vault.set('Proxima/tasks/Daily standup.md', '---\nid: task-standup\nname: Recovered standup\nproject: proj-backpack\nstatus: running\ncreatedAt: 2026-09-01T09:00:00.000Z\nfixedDuration: 15\n---\n');
    const recovered = await controller.refreshSource('manual');
    const recoveredProjection = createReadOnlyProjection(recovered.snapshot);
    const dispatcher = createActionDispatcher({ state: recoveredProjection.state, problems: recoveredProjection.problems, revisions: recoveredProjection.revisions, mode: 'fixture' });
    const inspection = createInspectionProjection(dispatcher.snapshot(), build, recoveredProjection.health);

    expect(failedProjection.health).toMatchObject({ stale: true, degraded: true });
    expect(recoveredProjection.health).toMatchObject({ sourceRevision: 2, stale: false, degraded: false, lastRefreshReason: 'manual' });
    expect(inspection.sourceHealth).toEqual(createUiHealthModel(recoveredProjection.health));
    inspection.sourceHealth.problemCodes.push('local-only');
    expect(recoveredProjection.health.problemCodes).not.toContain('local-only');
    expect(inspection.board.tasks.some((task) => task.name === 'Recovered standup')).toBe(true);
  });
});
