import type { BuildIdentityLike, InspectionProjection } from './inspection.js';
import type { ProximaEvent } from './eventRing.js';

export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const MAX_EVIDENCE_ITEMS = 500;

export interface ScenarioEvidence {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  scenarioId: string;
  proximaBuild: BuildIdentityLike;
  papers?: { build: string; processIdentity?: string };
  fixture: { hash: string; fixedClock: string; idSeed: string };
  actionTranscript: Array<{ actionType: string; ok: boolean; stateRevision: number; errorCode?: string }>;
  eventTranscript: ProximaEvent[];
  initialStateRevision: number;
  finalStateRevision: number;
  domainAssertions: string[];
  c1Assertions: string[];
  diagnostics: string[];
  captures: Array<{ id: string; sha256: string }>;
  passed: boolean;
}

export interface ScenarioEvidenceInput extends Omit<ScenarioEvidence, 'schemaVersion'> {}

/** Build bounded, JSON-safe evidence from a completed deterministic scenario. */
export function createScenarioEvidence(input: ScenarioEvidenceInput): ScenarioEvidence {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    ...input,
    actionTranscript: input.actionTranscript.slice(0, MAX_EVIDENCE_ITEMS).map((item) => ({ ...item })),
    eventTranscript: input.eventTranscript.slice(0, MAX_EVIDENCE_ITEMS).map((event) => ({ ...event, entityIds: [...event.entityIds] })),
    domainAssertions: input.domainAssertions.slice(0, MAX_EVIDENCE_ITEMS),
    c1Assertions: input.c1Assertions.slice(0, MAX_EVIDENCE_ITEMS),
    diagnostics: input.diagnostics.slice(0, MAX_EVIDENCE_ITEMS),
    captures: input.captures.slice(0, MAX_EVIDENCE_ITEMS).map((capture) => ({ ...capture })),
  };
}

export function isScenarioEvidence(value: unknown): value is ScenarioEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ScenarioEvidence>;
  return candidate.schemaVersion === EVIDENCE_SCHEMA_VERSION && typeof candidate.scenarioId === 'string' && typeof candidate.proximaBuild === 'object' && candidate.proximaBuild !== null && typeof candidate.fixture === 'object' && candidate.fixture !== null && Array.isArray(candidate.actionTranscript) && Array.isArray(candidate.eventTranscript) && Array.isArray(candidate.domainAssertions) && Array.isArray(candidate.c1Assertions) && Array.isArray(candidate.diagnostics) && Array.isArray(candidate.captures) && typeof candidate.initialStateRevision === 'number' && typeof candidate.finalStateRevision === 'number' && typeof candidate.passed === 'boolean';
}

export function evidenceFromInspection(projection: InspectionProjection, actions: ScenarioEvidenceInput['actionTranscript'], events: ProximaEvent[], scenarioId: string, idSeed: string): ScenarioEvidence {
  return createScenarioEvidence({
    scenarioId,
    proximaBuild: projection.build,
    fixture: { hash: projection.build.fixtureHash, fixedClock: projection.build.fixedClock, idSeed },
    actionTranscript: actions,
    eventTranscript: events,
    initialStateRevision: 1,
    finalStateRevision: projection.applicationStateRevision,
    domainAssertions: [`projects=${projection.projects.length}`, `tasks=${projection.board.tasks.length}`, `events=${projection.calendar.events.length}`],
    c1Assertions: [],
    diagnostics: projection.loadProblems.map((problem) => problem.code),
    captures: [],
    passed: projection.degraded.state === 'healthy',
  });
}
