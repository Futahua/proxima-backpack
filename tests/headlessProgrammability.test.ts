import { describe, expect, it } from 'vitest';
import {
  createActionDispatcher,
  type ActionResult,
} from '../src/app/actionProtocol.js';
import {
  evidenceFromInspection,
  isScenarioEvidence,
} from '../src/app/evidence.js';
import {
  createInspectionProjection,
  isInspectionProjection,
} from '../src/app/inspection.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  fixedClock,
  sequentialIdGenerator,
} from '../src/domain/clock.js';
import { fixtureVault } from './fixtures.js';

const BUILD = {
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

async function headlessDispatcher() {
  const loaded = await loadVaultState(
    fixtureVault('vault-basic'),
  );

  return createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode: 'fixture',
    initialSourceRevision: 1,
    initialCalendarMonth: '2026-09-01',
    clock: fixedClock(BUILD.fixedClock),
    idGenerator: sequentialIdGenerator(),
  });
}

function transcript(
  results: readonly ActionResult[],
) {
  return results.map((result) => ({
    actionType: result.actionType,
    ok: result.ok,
    stateRevision: result.stateRevision,
    ...(!result.ok
      ? { errorCode: result.error.code }
      : {}),
  }));
}

describe('Stage 6 slice 17 headless programmability', () => {
  it('drives semantic application state in the default Node test environment without browser or Papers globals', async () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
    expect('papers' in globalThis).toBe(false);

    const dispatcher = await headlessDispatcher();

    const surface = dispatcher.dispatch({
      type: 'surface.select',
      surface: 'projects',
    });
    expect(surface).toMatchObject({
      ok: true,
      actionType: 'surface.select',
      changed: true,
      stateRevision: 2,
      snapshot: {
        surface: 'projects',
      },
    });

    const tab = dispatcher.dispatch({
      type: 'project.workspace-tab.select',
      tab: 'task-board',
    });
    expect(tab).toMatchObject({
      ok: true,
      actionType: 'project.workspace-tab.select',
      changed: true,
      stateRevision: 3,
      snapshot: {
        surface: 'projects',
        projectWorkspaceTab: 'task-board',
      },
    });

    const refresh = dispatcher.dispatch({
      type: 'source.refresh',
    });
    expect(refresh).toMatchObject({
      ok: true,
      actionType: 'source.refresh',
      changed: false,
      stateRevision: 3,
    });

    expect(dispatcher.snapshot()).toMatchObject({
      surface: 'projects',
      projectWorkspaceTab: 'task-board',
      stateRevision: 3,
      settledRevision: 3,
      settled: true,
    });
  });

  it('inspects the headlessly driven state without renderer implementation or Papers participation', async () => {
    const dispatcher = await headlessDispatcher();

    dispatcher.dispatch({
      type: 'surface.select',
      surface: 'projects',
    });
    dispatcher.dispatch({
      type: 'project.workspace-tab.select',
      tab: 'task-board',
    });

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );

    expect(isInspectionProjection(inspection)).toBe(true);
    expect(inspection).toMatchObject({
      mode: 'fixture',
      applicationStateRevision: 3,
      surface: 'projects',
      submode: 'task-board',
      settled: {
        state: 'settled',
        revision: 3,
      },
      pendingOperations: {
        tracking: 'unavailable',
        items: [],
      },
    });

    expect(Array.isArray(inspection.projects)).toBe(true);
    expect(Array.isArray(inspection.board.tasks)).toBe(true);
    expect(Array.isArray(inspection.calendar.events)).toBe(true);
  });

  it('produces deterministic headless events and valid scenario evidence without inventing Papers identity', async () => {
    const dispatcher = await headlessDispatcher();

    const results = [
      dispatcher.dispatch({
        type: 'surface.select',
        surface: 'projects',
      }),
      dispatcher.dispatch({
        type: 'project.workspace-tab.select',
        tab: 'task-board',
      }),
      dispatcher.dispatch({
        type: 'source.refresh',
      }),
    ];

    const events = dispatcher.events();
    expect(events.map((event) => event.sequence))
      .toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      events.every(
        (event) => event.timestamp === BUILD.fixedClock,
      ),
    ).toBe(true);
    expect(
      events.map((event) => event.requestId),
    ).toEqual([
      'request-0001',
      'request-0001',
      'request-0002',
      'request-0002',
      'request-0003',
      'request-0003',
    ]);

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );
    const evidence = evidenceFromInspection(
      inspection,
      transcript(results),
      events,
      'headless-programmability',
      'sequential',
    );

    expect(isScenarioEvidence(evidence)).toBe(true);
    expect(evidence.scenarioId)
      .toBe('headless-programmability');
    expect(evidence.papers).toBeUndefined();
    expect(evidence.actionTranscript).toHaveLength(3);
    expect(evidence.eventTranscript).toHaveLength(6);
    expect(evidence.finalStateRevision).toBe(3);
  });

  it('keeps eventual mutation typed unavailable in the same headless dispatcher without changing record state', async () => {
    const dispatcher = await headlessDispatcher();
    const beforeState = JSON.stringify(
      dispatcher.snapshot().state,
    );
    const beforeRevision =
      dispatcher.snapshot().stateRevision;

    const result = dispatcher.dispatch({
      type: 'project.create',
      name: 'Must not be written',
      description: 'record-store cutover has not happened',
    });

    expect(result).toMatchObject({
      ok: false,
      actionType: 'project.create',
      category: 'record-mutation',
      outcome: 'unavailable',
      stateRevision: beforeRevision,
      error: {
        code: 'action-not-available',
      },
    });

    expect(
      JSON.stringify(dispatcher.snapshot().state),
    ).toBe(beforeState);
    expect(dispatcher.snapshot().stateRevision)
      .toBe(beforeRevision);

    expect(dispatcher.events()).toEqual([
      expect.objectContaining({
        sequence: 1,
        kind: 'action.rejected',
        category: 'diagnostic',
        actionType: 'project.create',
        stateRevision: beforeRevision,
        errorCode: 'action-not-available',
      }),
    ]);

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );
    expect(inspection.pendingOperations).toEqual({
      tracking: 'unavailable',
      items: [],
    });
  });
});
