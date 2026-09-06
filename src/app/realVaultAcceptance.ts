import type { BuildIdentityLike, InspectionProjection } from './inspection.js';
import type { ReadOnlyProjectionHealth } from './readOnlyProjection.js';
import type { StartupInspection } from './startupSession.js';
import type { ProximaState } from '../domain/types.js';

export const REAL_VAULT_ACCEPTANCE_SCHEMA_VERSION = 1 as const;
const MAX_TEXT = 400;
const MAX_CODES = 20;
const MAX_REVISIONS = 200;

export type AcceptanceVerdict = 'PASS' | 'FAIL' | 'OPEN';
export type AcceptanceStageName = 'baselineRead' | 'externalEdit' | 'renameDelete' | 'obsidianCoexistence' | 'writeInvariant' | 'overall';

export interface AcceptanceStage {
  verdict: AcceptanceVerdict;
  failureCodes: string[];
}

export interface RealVaultAcceptanceInput {
  build: BuildIdentityLike;
  startup: Pick<StartupInspection, 'startupSourceMode' | 'restoredHandlePresent' | 'bootstrapStatus'>;
  session: { sourceMode: 'fixture' | 'external'; sourceGeneration: number; transitionState: 'stable' | 'switching' | 'failed' };
  projection: { generation: number; state: ProximaState; health: ReadOnlyProjectionHealth; revisions: Record<string, string>; problems: Array<{ code: string; path: string; detail: string }> };
  inspection: InspectionProjection;
  refreshEvidence?: { outcome: 'changed' | 'deleted' | 'renamed' | 'unchanged'; changed: boolean; previousGeneration: number; currentGeneration: number; beforeRevision: string; afterRevision: string; beforeMarker: string; afterMarker: string };
  renameDeleteEvidence?: { outcome: 'deleted' | 'renamed'; removedPath: string; addedPath?: string };
  writeInvariant: { writesAttempted: number; writerMethodsCalled: string[] };
  obsidianEvidence?: { passed: boolean };
}

export interface RealVaultAcceptanceReport {
  schemaVersion: typeof REAL_VAULT_ACCEPTANCE_SCHEMA_VERSION;
  build: BuildIdentityLike;
  sourceMode: 'fixture' | 'external';
  restoredHandlePresent: boolean;
  bootstrapStatus: string;
  transitionState: 'stable' | 'switching' | 'failed';
  sourceGeneration: number;
  counts: { projects: number; tasks: number; events: number };
  sourceRevisions: Array<{ path: string; revision: string }>;
  provenanceSamples: Array<{ kind: string; logicalId: string; relativeSourcePath: string; sourceRevision: string; idOrigin: string }>;
  health: { status: 'healthy' | 'stale' | 'degraded'; stale: boolean; degraded: boolean; lastSuccessfulRefreshRevision: number; lastRefreshReason: string | null; problemCodes: string[] };
  refreshEvidence: { outcome: string; changed: boolean; previousGeneration: number; currentGeneration: number; beforeRevision: string; afterRevision: string } | null;
  externalChangeEvidence: { beforeMarker: string; afterMarker: string } | null;
  renameDeleteEvidence: { outcome: 'deleted' | 'renamed'; removedPath: string; addedPath?: string } | null;
  writeInvariant: { writesAttempted: number; writerMethodsCalled: string[] };
  stages: Record<AcceptanceStageName, AcceptanceStage>;
  passed: boolean;
}

function text(value: unknown, limit = MAX_TEXT): string { return String(value ?? '').slice(0, limit); }
function codes(values: string[]): string[] { return [...new Set(values.map((value) => text(value, 100)))].slice(0, MAX_CODES); }
function relative(path: string): string | null {
  const value = path.replaceAll('\\', '/');
  return /^(?:[A-Za-z]:|\/)/.test(value) || value.split('/').some((part) => part === '..' || part === '.') ? null : text(value, 260);
}
function stage(verdict: AcceptanceVerdict, failureCodes: string[] = []): AcceptanceStage { return { verdict, failureCodes: codes(failureCodes) }; }
function safeBuild(build: BuildIdentityLike): BuildIdentityLike {
  return Object.fromEntries(Object.entries(build).map(([key, value]) => [key, text(value, 260)])) as unknown as BuildIdentityLike;
}

function provenanceSamples(state: ProximaState): { samples: RealVaultAcceptanceReport['provenanceSamples']; failures: string[] } {
  const records = [
    ...state.projects.map((record) => ({ kind: 'project', record })),
    ...state.tasks.map((record) => ({ kind: 'task', record })),
    ...state.events.map((record) => ({ kind: 'event', record })),
  ];
  const samples: RealVaultAcceptanceReport['provenanceSamples'] = [];
  const failures: string[] = [];
  for (const kind of ['project', 'task', 'event']) {
    const found = records.find((item) => item.kind === kind);
    if (!found) continue;
    const path = relative(found.record.source.path);
    if (!path) { failures.push('absolute-path'); continue; }
    samples.push({ kind, logicalId: text(found.record.id), relativeSourcePath: path, sourceRevision: text(found.record.source.revision), idOrigin: found.record.source.idOrigin });
  }
  return { samples: samples.slice(0, 20), failures };
}

/** Pure staged readiness evaluator. It consumes bounded snapshots and never reads or writes a source. */
export function evaluateRealVaultAcceptance(input: RealVaultAcceptanceInput): RealVaultAcceptanceReport {
  const { samples, failures: provenanceFailures } = provenanceSamples(input.projection.state);
  const generationCoherent = input.session.sourceGeneration === input.projection.generation && input.inspection.sourceHealth.sourceRevision === input.projection.generation;
  const baselineFailures: string[] = [];
  if (input.startup.startupSourceMode !== 'external' || input.session.sourceMode !== 'external') baselineFailures.push('wrong-source-mode');
  if (!input.startup.restoredHandlePresent || input.startup.bootstrapStatus !== 'ready') baselineFailures.push('permission-not-granted');
  if (input.session.transitionState !== 'stable') baselineFailures.push('session-not-stable');
  if (input.projection.health.stale || input.projection.health.degraded || input.inspection.sourceHealth.status !== 'healthy') baselineFailures.push('degraded-baseline');
  if (!generationCoherent) baselineFailures.push('mixed-generation');
  if (provenanceFailures.length > 0 || samples.length === 0) baselineFailures.push('missing-provenance');
  if (input.projection.problems.length > 0) baselineFailures.push('baseline-problems');

  const externalFailures: string[] = [];
  const edit = input.refreshEvidence;
  if (edit && (edit.outcome !== 'changed' || !edit.changed || edit.previousGeneration >= edit.currentGeneration)) externalFailures.push('missing-external-edit');
  if (edit && (edit.beforeRevision === edit.afterRevision || edit.beforeMarker === edit.afterMarker)) externalFailures.push('missing-revision-change');

  const renameFailures: string[] = [];
  const rename = input.renameDeleteEvidence;
  if (rename && (rename.outcome !== 'deleted' && rename.outcome !== 'renamed')) renameFailures.push('missing-rename-delete');
  if (rename && (!relative(rename.removedPath) || (rename.addedPath !== undefined && !relative(rename.addedPath)))) renameFailures.push('absolute-path');

  const writeFailures: string[] = [];
  if (input.writeInvariant.writesAttempted !== 0 || input.writeInvariant.writerMethodsCalled.length !== 0) writeFailures.push('write-authority');
  const health = input.inspection.sourceHealth;
  const obsidianFailures = input.obsidianEvidence?.passed === false ? ['obsidian-failure'] : [];
  const overallFailures = [...baselineFailures, ...externalFailures, ...renameFailures, ...obsidianFailures, ...writeFailures];
  const overallVerdict: AcceptanceVerdict = overallFailures.length > 0 ? 'FAIL' : edit && rename ? 'PASS' : 'OPEN';
  const stages: Record<AcceptanceStageName, AcceptanceStage> = {
    baselineRead: stage(baselineFailures.length === 0 ? 'PASS' : 'FAIL', baselineFailures),
    externalEdit: stage(edit ? (externalFailures.length === 0 ? 'PASS' : 'FAIL') : 'OPEN', externalFailures),
    renameDelete: stage(rename ? (renameFailures.length === 0 ? 'PASS' : 'FAIL') : 'OPEN', renameFailures),
    obsidianCoexistence: input.obsidianEvidence ? stage(input.obsidianEvidence.passed ? 'PASS' : 'FAIL', obsidianFailures) : stage('OPEN'),
    writeInvariant: stage(writeFailures.length === 0 ? 'PASS' : 'FAIL', writeFailures),
    overall: stage(overallVerdict, overallFailures),
  };
  return {
    schemaVersion: REAL_VAULT_ACCEPTANCE_SCHEMA_VERSION,
    build: safeBuild(input.build),
    sourceMode: input.session.sourceMode,
    restoredHandlePresent: input.startup.restoredHandlePresent,
    bootstrapStatus: text(input.startup.bootstrapStatus, 100),
    transitionState: input.session.transitionState,
    sourceGeneration: input.projection.generation,
    counts: { projects: input.projection.state.projects.length, tasks: input.projection.state.tasks.length, events: input.projection.state.events.length },
    sourceRevisions: Object.entries(input.projection.revisions).slice(0, MAX_REVISIONS).flatMap(([path, revision]) => { const safePath = relative(path); return safePath ? [{ path: safePath, revision: text(revision) }] : []; }),
    provenanceSamples: samples,
    health: { status: health.status === 'healthy' ? 'healthy' : health.degraded ? 'degraded' : 'stale', stale: health.stale, degraded: health.degraded, lastSuccessfulRefreshRevision: health.lastSuccessfulRefreshRevision, lastRefreshReason: health.lastRefreshReason, problemCodes: codes(health.problemCodes) },
    refreshEvidence: edit ? { outcome: edit.outcome, changed: edit.changed, previousGeneration: edit.previousGeneration, currentGeneration: edit.currentGeneration, beforeRevision: text(edit.beforeRevision), afterRevision: text(edit.afterRevision) } : null,
    externalChangeEvidence: edit ? { beforeMarker: text(edit.beforeMarker), afterMarker: text(edit.afterMarker) } : null,
    renameDeleteEvidence: rename ? { outcome: rename.outcome, removedPath: relative(rename.removedPath) ?? '', ...(rename.addedPath === undefined ? {} : { addedPath: relative(rename.addedPath) ?? '' }) } : null,
    writeInvariant: { writesAttempted: input.writeInvariant.writesAttempted, writerMethodsCalled: input.writeInvariant.writerMethodsCalled.slice(0, MAX_CODES).map((method) => text(method, 100)) },
    stages,
    passed: stages.overall.verdict === 'PASS',
  };
}

export function isRealVaultAcceptanceReport(value: unknown): value is RealVaultAcceptanceReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RealVaultAcceptanceReport>;
  return candidate.schemaVersion === REAL_VAULT_ACCEPTANCE_SCHEMA_VERSION && typeof candidate.sourceMode === 'string' && typeof candidate.sourceGeneration === 'number' && typeof candidate.passed === 'boolean' && Array.isArray(candidate.provenanceSamples) && typeof candidate.stages === 'object' && candidate.stages !== null;
}
