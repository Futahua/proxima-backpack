import { describe, expect, it } from 'vitest';
import { createReadOnlyProjection, sourceProvenance } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { elasticBoard, eventsForSelection, projectsFor } from '../src/domain/selectors.js';
import { fixtureVault } from './fixtures.js';

describe('Gate 6B provenance-aware read-only projection', () => {
  it('projects one accepted generation to coherent board and calendar consumers', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({ vault, initial });
    const first = createReadOnlyProjection(controller.snapshot());

    vault.set('Proxima/projects/Term Calendar.md', '---\nid: proj-term\nname: Renamed Calendar\nprojectType: schedule\nstatus: active\ncreatedAt: 2026-08-20T08:00:00.000Z\n---\nDated commitments.\n');
    const refreshed = await controller.refreshSource('external-signal');
    const next = createReadOnlyProjection(refreshed.snapshot);
    const schedule = projectsFor(next.state.projects, 'schedule');
    const calendarEvents = eventsForSelection(next.state.events, 'proj-term');
    const board = elasticBoard(next.state.tasks, next.state.statuses);

    expect(first.generation).toBe(1);
    expect(next.generation).toBe(2);
    expect(next.health.sourceRevision).toBe(next.generation);
    expect(next.health.stale).toBe(false);
    expect(schedule[0]?.name).toBe('Renamed Calendar');
    expect(calendarEvents.every((event) => event.projectId === schedule[0]?.id)).toBe(true);
    expect(board.backlog.length + board.running.length + board.finished.length).toBe(7);
    expect(sourceProvenance(schedule[0]!)).toMatchObject({ logicalId: 'proj-term', sourceKind: 'project', relativeSourcePath: 'Proxima/projects/Term Calendar.md', idOrigin: 'frontmatter' });
    expect(sourceProvenance(calendarEvents[0]!)).toMatchObject({ logicalId: calendarEvents[0]?.id, sourceKind: 'event', idOrigin: 'frontmatter' });
  });

  it('retains last-good domain data while exposing degraded health on refresh failure', async () => {
    const vault = fixtureVault('vault-basic');
    const initial = await loadVaultState(vault);
    const failingVault = {
      ...vault,
      read: async () => { throw new Error('simulated unreadable source'); },
    };
    const controller = createRefreshController({ vault: failingVault, initial });
    const result = await controller.refreshSource('focus');
    const projection = createReadOnlyProjection(result.snapshot);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('unreadable');
    expect(projection.state.projects).toHaveLength(initial.state.projects.length);
    expect(projection.health).toMatchObject({ sourceRevision: 1, lastSuccessfulRefreshRevision: 1, stale: true, degraded: true, lastRefreshReason: 'focus' });
    expect(projection.health.problemCodes).toContain('unreadable');
  });

  it('returns copy-safe state and bounded provenance rather than controller-owned objects', async () => {
    const vault = fixtureVault('vault-basic');
    const loaded = await loadVaultState(vault);
    const controller = createRefreshController({ vault, initial: loaded });
    const projection = createReadOnlyProjection(controller.snapshot());
    projection.state.projects[0]!.name = 'local mutation';
    projection.problems[0]?.detail && (projection.problems[0].detail = 'local mutation');
    const snapshot = controller.snapshot();

    expect(snapshot.load.state.projects[0]?.name).not.toBe('local mutation');
    expect(snapshot.load.problems[0]?.detail).not.toBe('local mutation');
    expect(projection.state.projects[0]!.source.path).not.toMatch(/^[A-Za-z]:|^\\|^\//);
    expect(projection.state.projects[0]!.source.revision.length).toBeLessThanOrEqual(400);
  });
});
