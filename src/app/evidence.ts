import type { BuildIdentityLike, InspectionProjection } from './inspection.js';
import type { ProximaEvent } from './eventRing.js';
import { redactDiagnosticSecrets } from './diagnostics.js';

export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const MAX_EVIDENCE_ITEMS = 500;
export const MAX_EVIDENCE_TEXT = 400;

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

const text = (value: string, limit = MAX_EVIDENCE_TEXT): string => value.slice(0, limit);

/** Build bounded, JSON-safe evidence from a completed deterministic scenario. */
export function createScenarioEvidence(input: ScenarioEvidenceInput): ScenarioEvidence {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    scenarioId: text(input.scenarioId),
    proximaBuild: Object.fromEntries(Object.entries(input.proximaBuild).map(([key, value]) => [key, text(String(value), 260)])) as unknown as BuildIdentityLike,
    ...(input.papers ? { papers: { build: text(input.papers.build), ...(input.papers.processIdentity ? { processIdentity: text(input.papers.processIdentity) } : {}) } } : {}),
    fixture: { hash: text(input.fixture.hash), fixedClock: text(input.fixture.fixedClock), idSeed: text(input.fixture.idSeed) },
    actionTranscript: input.actionTranscript.slice(0, MAX_EVIDENCE_ITEMS).map((item) => ({ actionType: text(item.actionType), ok: item.ok, stateRevision: item.stateRevision, ...(item.errorCode ? { errorCode: text(item.errorCode) } : {}) })),
    eventTranscript: input.eventTranscript.slice(0, MAX_EVIDENCE_ITEMS).map((event) => ({ ...event, actionType: text(event.actionType), requestId: text(event.requestId), timestamp: text(event.timestamp), entityIds: event.entityIds.slice(0, 20).map((id) => text(id)), ...(event.errorCode ? { errorCode: text(event.errorCode) } : {}) })),
    initialStateRevision: input.initialStateRevision,
    finalStateRevision: input.finalStateRevision,
    domainAssertions: input.domainAssertions.slice(0, MAX_EVIDENCE_ITEMS).map((value) => text(value)),
    c1Assertions: input.c1Assertions.slice(0, MAX_EVIDENCE_ITEMS).map((value) => text(value)),
    diagnostics: input.diagnostics.slice(0, MAX_EVIDENCE_ITEMS).map((value) => text(redactDiagnosticSecrets(value))),
    captures: input.captures.slice(0, MAX_EVIDENCE_ITEMS).map((capture) => ({ id: text(capture.id), sha256: text(capture.sha256, 128) })),
    passed: input.passed,
  };
}

export function isScenarioEvidence(value: unknown): value is ScenarioEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ScenarioEvidence>;
  if (candidate.schemaVersion !== EVIDENCE_SCHEMA_VERSION || typeof candidate.scenarioId !== 'string' || typeof candidate.proximaBuild !== 'object' || candidate.proximaBuild === null || typeof candidate.fixture !== 'object' || candidate.fixture === null || !Array.isArray(candidate.actionTranscript) || !Array.isArray(candidate.eventTranscript) || !Array.isArray(candidate.domainAssertions) || !Array.isArray(candidate.c1Assertions) || !Array.isArray(candidate.diagnostics) || !Array.isArray(candidate.captures) || typeof candidate.initialStateRevision !== 'number' || typeof candidate.finalStateRevision !== 'number' || typeof candidate.passed !== 'boolean') return false;
  const build = candidate.proximaBuild as unknown as Record<string, unknown>;
  const fixture = candidate.fixture as Record<string, unknown>;
  const strings = ['proximaVersion', 'gitSha', 'buildMode', 'domainSchemaVersion', 'controlSchemaVersion', 'fixtureSchemaVersion', 'fixtureHash', 'lockfileHash', 'fixedClock'];
  if (!strings.every((key) => typeof build[key] === 'string') || !['hash', 'fixedClock', 'idSeed'].every((key) => typeof fixture[key] === 'string')) return false;
  if (candidate.papers !== undefined && (typeof candidate.papers !== 'object' || candidate.papers === null || typeof (candidate.papers as { build?: unknown }).build !== 'string')) return false;
  const validActions = candidate.actionTranscript.every((item) => typeof item === 'object' && item !== null && typeof (item as { actionType?: unknown }).actionType === 'string' && typeof (item as { ok?: unknown }).ok === 'boolean' && typeof (item as { stateRevision?: unknown }).stateRevision === 'number');
  const validEvents = candidate.eventTranscript.every((event) => typeof event === 'object' && event !== null && (event as { schemaVersion?: unknown }).schemaVersion === 1 && typeof (event as { sequence?: unknown }).sequence === 'number' && typeof (event as { requestId?: unknown }).requestId === 'string' && Array.isArray((event as { entityIds?: unknown }).entityIds));
  const validCaptures = candidate.captures.every((capture) => typeof capture === 'object' && capture !== null && typeof (capture as { id?: unknown }).id === 'string' && typeof (capture as { sha256?: unknown }).sha256 === 'string');
  return validActions && validEvents && validCaptures;
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
