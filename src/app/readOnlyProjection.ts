import type { LoadProblem } from '../domain/problems.js';
import type { SourceRef, SourcedRecord } from '../domain/records.js';
import type { ProximaState } from '../domain/types.js';
import type { RefreshControllerSnapshot, RefreshReason } from './refreshController.js';
import { boundDiagnosticProblems, DIAGNOSTIC_LIMITS, type SourceDiagnosticCode } from './diagnostics.js';

const MAX_TEXT = 400;

export interface RecordProvenance {
  logicalId: string;
  sourceKind: SourceRef['kind'];
  relativeSourcePath: string;
  sourceRevision: string;
  idOrigin: SourceRef['idOrigin'];
}

export interface ReadOnlyProjectionHealth {
  sourceRevision: number;
  applicationRevision: number;
  stale: boolean;
  degraded: boolean;
  lastSuccessfulRefreshRevision: number;
  lastRefreshReason: RefreshReason | null;
  problemCodes: SourceDiagnosticCode[];
}

export interface ReadOnlyProjection {
  /** One immutable generation consumed by every product surface. */
  generation: number;
  state: ProximaState;
  problems: LoadProblem[];
  revisions: Record<string, string>;
  health: ReadOnlyProjectionHealth;
}

function bounded(value: string, limit = MAX_TEXT): string { return value.slice(0, limit); }

function clone<T>(value: T): T {
  return structuredClone(value);
}

function relativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (/^(?:[A-Za-z]:|\/)/.test(normalized)) return '';
  return bounded(normalized, 260);
}

function boundedProblems(problems: LoadProblem[]): LoadProblem[] {
  return boundDiagnosticProblems(problems).map((problem) => ({
    ...problem,
    path: relativePath(problem.path),
  }));
}

export function sourceProvenance(record: SourcedRecord): RecordProvenance {
  return {
    logicalId: bounded(record.id),
    sourceKind: record.source.kind,
    relativeSourcePath: relativePath(record.source.path),
    sourceRevision: bounded(record.source.revision),
    idOrigin: record.source.idOrigin,
  };
}

/**
 * Project one accepted refresh snapshot into a copy-safe product generation.
 * This function consumes the snapshot only; it has no reader or filesystem authority.
 */
export function createReadOnlyProjection(snapshot: RefreshControllerSnapshot, applicationRevision = snapshot.sourceRevision): ReadOnlyProjection {
  const problems = boundedProblems(snapshot.load.problems);
  const problemCodes = [...new Set([...problems.map((problem) => problem.code), ...(snapshot.lastRefreshProblemCode ? [snapshot.lastRefreshProblemCode] : [])])].slice(0, DIAGNOSTIC_LIMITS.problemCodes);
  return {
    generation: snapshot.sourceRevision,
    state: clone(snapshot.load.state),
    problems: clone(problems),
    revisions: { ...snapshot.load.revisions },
    health: {
      sourceRevision: snapshot.sourceRevision,
      applicationRevision,
      stale: snapshot.stale,
      degraded: snapshot.refreshState === 'degraded',
      lastSuccessfulRefreshRevision: snapshot.lastSuccessfulRefreshRevision,
      lastRefreshReason: snapshot.lastRefreshReason,
      problemCodes,
    },
  };
}
