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
  EVENT_SCHEMA_VERSION,
  type ProximaEvent,
} from '../src/app/eventRing.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  fixedClock,
  sequentialIdGenerator,
} from '../src/domain/clock.js';
import { fixtureVault } from './fixtures.js';

const FIXED_INSTANT = '2026-09-06T12:00:00.000Z';

const BUILD = {
  proximaVersion: '0.1.0',
  gitSha: 'test-sha',
  buildMode: 'fixture',
  domainSchemaVersion: '1',
  controlSchemaVersion: '0',
  fixtureSchemaVersion: '1',
  fixtureHash: 'fixture-hash',
  lockfileHash: 'lock-hash',
  fixedClock: FIXED_INSTANT,
};

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

async function runScenario() {
  const loaded = await loadVaultState(
    fixtureVault('vault-basic'),
  );

  const dispatcher = createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode: 'fixture',
    initialSourceRevision: 1,
    initialCalendarMonth: '2026-09-01',
    clock: fixedClock(FIXED_INSTANT),
    idGenerator: sequentialIdGenerator(),
  });

  const beforeMutationState = JSON.stringify(
    dispatcher.snapshot().state,
  );

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
    dispatcher.dispatch({
      type: 'project.create',
      name: 'Unavailable deterministic project',
      description: 'record-store cutover has not happened',
    }),
  ];

  const events = dispatcher.events();
  const inspection = createInspectionProjection(
    dispatcher.snapshot(),
    BUILD,
  );
  const evidence = evidenceFromInspection(
    inspection,
    transcript(results),
    events,
    'deterministic-events-evidence',
    'sequential',
  );

  return {
    beforeMutationState,
    results,
    events,
    evidence,
    snapshot: dispatcher.snapshot(),
  };
}

describe('Stage 6 slice 20 deterministic events and evidence', () => {
  it('produces identical event streams and scenario evidence from identical injected inputs', async () => {
    const first = await runScenario();
    const second = await runScenario();

    expect(second.events).toEqual(first.events);
    expect(second.evidence).toEqual(first.evidence);

    expect(JSON.stringify(second.events))
      .toBe(JSON.stringify(first.events));
    expect(JSON.stringify(second.evidence))
      .toBe(JSON.stringify(first.evidence));
  });

  it('pins deterministic sequence, request identity, timestamp, action type and state revision', async () => {
    const run = await runScenario();

    expect(
      run.events.map((event) => ({
        schemaVersion: event.schemaVersion,
        sequence: event.sequence,
        kind: event.kind,
        category: event.category,
        requestId: event.requestId,
        actionType: event.actionType,
        stateRevision: event.stateRevision,
        errorCode: event.errorCode,
      })),
    ).toEqual([
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: 1,
        kind: 'action.accepted',
        category: 'domain',
        requestId: 'request-0001',
        actionType: 'surface.select',
        stateRevision: 2,
        errorCode: undefined,
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: 2,
        kind: 'state.settled',
        category: 'lifecycle',
        requestId: 'request-0001',
        actionType: 'surface.select',
        stateRevision: 2,
        errorCode: undefined,
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: 3,
        kind: 'action.accepted',
        category: 'domain',
        requestId: 'request-0002',
        actionType: 'project.workspace-tab.select',
        stateRevision: 3,
        errorCode: undefined,
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: 4,
        kind: 'state.settled',
        category: 'lifecycle',
        requestId: 'request-0002',
        actionType: 'project.workspace-tab.select',
        stateRevision: 3,
        errorCode: undefined,
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: 5,
        kind: 'action.accepted',
        category: 'domain',
        requestId: 'request-0003',
        actionType: 'source.refresh',
        stateRevision: 3,
        errorCode: undefined,
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: 6,
        kind: 'state.settled',
        category: 'lifecycle',
        requestId: 'request-0003',
        actionType: 'source.refresh',
        stateRevision: 3,
        errorCode: undefined,
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: 7,
        kind: 'action.rejected',
        category: 'diagnostic',
        requestId: 'request-0004',
        actionType: 'project.create',
        stateRevision: 3,
        errorCode: 'action-not-available',
      },
    ]);

    expect(
      run.events.every(
        (event) => event.timestamp === FIXED_INSTANT,
      ),
    ).toBe(true);

    expect(run.snapshot.latestEventSequence).toBe(7);
    expect(run.snapshot.stateRevision).toBe(3);
    expect(run.snapshot.settledRevision).toBe(3);
    expect(run.snapshot.settled).toBe(true);
  });

  it('reproduces the canonical event transcript inside validated bounded scenario evidence', async () => {
    const run = await runScenario();

    expect(isScenarioEvidence(run.evidence)).toBe(true);
    expect(run.evidence).toMatchObject({
      schemaVersion: 1,
      scenarioId: 'deterministic-events-evidence',
      fixture: {
        hash: BUILD.fixtureHash,
        fixedClock: FIXED_INSTANT,
        idSeed: 'sequential',
      },
      initialStateRevision: 1,
      finalStateRevision: 3,
    });

    expect(run.evidence.papers).toBeUndefined();
    expect(run.evidence.actionTranscript)
      .toEqual(transcript(run.results));
    expect(run.evidence.eventTranscript)
      .toEqual(run.events);
    expect(run.evidence.eventTranscript)
      .toHaveLength(7);

    expect(
      run.evidence.eventTranscript.map(
        (event: ProximaEvent) => event.sequence,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('records typed-unavailable mutation refusal deterministically without changing record state', async () => {
    const run = await runScenario();
    const refusal = run.results[3];

    expect(refusal).toMatchObject({
      ok: false,
      actionType: 'project.create',
      category: 'record-mutation',
      outcome: 'unavailable',
      stateRevision: 3,
      requestId: 'request-0004',
      error: {
        code: 'action-not-available',
      },
    });

    expect(run.evidence.actionTranscript[3]).toEqual({
      actionType: 'project.create',
      ok: false,
      stateRevision: 3,
      errorCode: 'action-not-available',
    });

    expect(run.evidence.eventTranscript[6]).toMatchObject({
      sequence: 7,
      kind: 'action.rejected',
      category: 'diagnostic',
      requestId: 'request-0004',
      actionType: 'project.create',
      stateRevision: 3,
      errorCode: 'action-not-available',
    });

    expect(JSON.stringify(run.snapshot.state))
      .toBe(run.beforeMutationState);
  });
});
