import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { createRefreshPolicy } from '../src/app/refreshPolicy.js';
import { createUiHealthModel } from '../src/app/uiHealth.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';
import { eventsForSelection, projectsFor } from '../src/domain/selectors.js';

const build = {
  proximaVersion: '0.1.0', gitSha: 'test-sha', buildMode: 'fixture', domainSchemaVersion: '1',
  controlSchemaVersion: '0', fixtureSchemaVersion: '1', fixtureHash: 'fixture-hash',
  lockfileHash: 'lock-hash', fixedClock: '2026-09-06T12:00:00.000Z',
};

describe('Gate 6E fixture-mode end-to-end refresh wiring', () => {
  it('boots and manually refreshes through the complete stack with one coherent generation', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({ vault, initial });
    let projection = createReadOnlyProjection(controller.snapshot());
    const dispatcher = createActionDispatcher({ state: projection.state, problems: projection.problems, revisions: projection.revisions, mode: 'fixture', initialSourceRevision: projection.generation });
    const policy = createRefreshPolicy({ controller, enabled: false, onResult(result) {
      if (!result.ok) { projection = createReadOnlyProjection(result.snapshot, dispatcher.snapshot().stateRevision); return; }
      const next = createReadOnlyProjection(result.snapshot);
      const applied = dispatcher.replaceSource({ state: next.state, problems: next.problems, revisions: next.revisions, sourceRevision: next.generation });
      projection = createReadOnlyProjection(result.snapshot, applied.stateRevision);
    } });

    expect((await policy.trigger('manual'))?.changed).toBe(false);
    expect(dispatcher.snapshot().sourceRevision).toBe(1);
    vault.set('Proxima/projects/Term Calendar.md', '---\nid: proj-term\nname: Calendar Recovered\nprojectType: schedule\nstatus: active\ncreatedAt: 2026-08-20T08:00:00.000Z\n---\nUpdated.\n');
    const refreshed = await policy.trigger('manual');
    const inspection = createInspectionProjection(dispatcher.snapshot(), build, projection.health);

    expect(refreshed?.changed).toBe(true);
    expect(projection.generation).toBe(2);
    expect(dispatcher.snapshot().sourceRevision).toBe(2);
    expect(inspection.sourceHealth).toEqual(createUiHealthModel(projection.health));
    expect(inspection.projects.find((project) => project.id === 'proj-term')?.name).toBe('Calendar Recovered');
    expect(inspection.calendar.events.every((event) => event.provenance.sourceRevision.length > 0)).toBe(true);
    expect(inspection.board.tasks).toHaveLength(7);
    expect(inspection.settled.state).toBe('settled');
    expect(inspection.pendingOperations).toEqual({
      tracking: 'unavailable',
      items: [],
    });
    expect(dispatcher.events().filter((event) => event.actionType === 'source.refresh')).toHaveLength(2);
  });

  it('removes a deleted selected project without leaving a ghost selection', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({ vault, initial });
    const policy = createRefreshPolicy({ controller, enabled: false });
    let projection = createReadOnlyProjection(controller.snapshot());
    const dispatcher = createActionDispatcher({ state: projection.state, problems: projection.problems, revisions: projection.revisions, mode: 'fixture', initialSourceRevision: projection.generation, initialSurface: 'calendar', initialSelection: 'proj-term' });
    expect(dispatcher.snapshot().selection).toBe('proj-term');
    vault.delete('Proxima/projects/Term Calendar.md');
    const refreshed = await policy.trigger('manual');
    projection = createReadOnlyProjection(refreshed!.snapshot);
    dispatcher.replaceSource({ state: projection.state, problems: projection.problems, revisions: projection.revisions, sourceRevision: projection.generation });

    expect(dispatcher.snapshot().selection).toBe('all');
    expect(dispatcher.snapshot().state.projects.some((project) => project.id === 'proj-term')).toBe(false);
    const scheduleProjects = projectsFor(dispatcher.snapshot().state.projects, 'schedule');
    const visibleEvents = eventsForSelection(dispatcher.snapshot().state.events.filter((event) => event.projectId === null || scheduleProjects.some((project) => project.id === event.projectId)), dispatcher.snapshot().selection);
    expect(visibleEvents.some((event) => event.projectId === 'proj-term')).toBe(false);
  });

  it('keeps the full browser-facing generation intact through failure and recovery', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    let readable = false;
    const reader = { ...vault, read: async (path: string) => { if (!readable) throw new Error('fixture temporarily unreadable'); return vault.read(path); } };
    const controller = createRefreshController({ vault: reader, initial });
    const policy = createRefreshPolicy({ controller, enabled: false });
    let projection = createReadOnlyProjection(controller.snapshot());
    const dispatcher = createActionDispatcher({ state: projection.state, problems: projection.problems, revisions: projection.revisions, mode: 'fixture', initialSourceRevision: projection.generation });
    const failed = await policy.trigger('focus');
    projection = createReadOnlyProjection(failed!.snapshot, dispatcher.snapshot().stateRevision);
    let inspection = createInspectionProjection(dispatcher.snapshot(), build, projection.health);
    expect(inspection.sourceHealth.status).toBe('degraded');
    expect(inspection.board.tasks).toHaveLength(7);
    expect(inspection.calendar.events).toHaveLength(3);
    expect(inspection.projects).toHaveLength(3);

    readable = true;
    vault.set('Proxima/tasks/Daily standup.md', '---\nid: task-standup\nname: Recovered standup\nproject: proj-backpack\nstatus: running\ncreatedAt: 2026-09-01T09:00:00.000Z\nfixedDuration: 15\n---\n');
    const recovered = await policy.trigger('manual');
    projection = createReadOnlyProjection(recovered!.snapshot);
    const applied = dispatcher.replaceSource({ state: projection.state, problems: projection.problems, revisions: projection.revisions, sourceRevision: projection.generation });
    projection = createReadOnlyProjection(recovered!.snapshot, applied.stateRevision);
    inspection = createInspectionProjection(dispatcher.snapshot(), build, projection.health);
    expect(inspection.sourceHealth.status).toBe('healthy');
    expect(inspection.sourceHealth.sourceRevision).toBe(2);
    expect(inspection.board.tasks.some((task) => task.name === 'Recovered standup')).toBe(true);
    expect(inspection.settled.state).toBe('settled');
  });
});
