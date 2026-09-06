import { describe, expect, it } from 'vitest';
import { createScenarioEvidence, isScenarioEvidence, MAX_EVIDENCE_ITEMS } from '../src/app/evidence.js';
import { EVENT_SCHEMA_VERSION } from '../src/app/eventRing.js';

const build = { proximaVersion: '0.1.0', gitSha: 'test', buildMode: 'fixture', domainSchemaVersion: '1', controlSchemaVersion: '0', fixtureSchemaVersion: '1', fixtureHash: 'fixture', lockfileHash: 'lock', fixedClock: '2026-09-06T12:00:00.000Z' };

describe('Gate 3B evidence schema', () => {
  it('creates a bounded, machine-readable scenario record', () => {
    const events = Array.from({ length: MAX_EVIDENCE_ITEMS + 10 }, (_, index) => ({ schemaVersion: EVENT_SCHEMA_VERSION as 1, sequence: index + 1, kind: 'state.settled' as const, category: 'lifecycle' as const, entityIds: ['x'], requestId: `r-${index}`, actionType: 'fixture.reset', stateRevision: 1, timestamp: '2026-09-06T12:00:00.000Z' }));
    const evidence = createScenarioEvidence({ scenarioId: 'gate-3b-fixture', proximaBuild: build, fixture: { hash: 'fixture', fixedClock: build.fixedClock, idSeed: 'fixture-0001' }, actionTranscript: [], eventTranscript: events, initialStateRevision: 1, finalStateRevision: 1, domainAssertions: [], c1Assertions: [], diagnostics: [], captures: [], passed: true });
    expect(isScenarioEvidence(evidence)).toBe(true);
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.eventTranscript).toHaveLength(MAX_EVIDENCE_ITEMS);
  });
});
