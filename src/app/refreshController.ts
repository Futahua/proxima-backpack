import { isBlocking, type LoadProblem } from '../domain/problems.js';
import type { VaultReader } from '../ports/vault.js';
import { loadVaultState, type LoadOptions } from './vaultRepository.js';
import type { StateSource, StateSourceLoad } from './stateSource.js';
import { boundDiagnosticProblems, type SourceDiagnosticCode } from './diagnostics.js';

export const REFRESH_REASONS = ['manual', 'focus', 'interval', 'external-signal'] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];
export type RefreshOutcome = 'unchanged' | 'changed' | 'deleted' | 'renamed' | 'unreadable' | 'malformed';
export type RefreshState = 'idle' | 'refreshing' | 'degraded';

export interface RefreshControllerSnapshot {
  sourceRevision: number;
  lastSuccessfulRefreshRevision: number;
  refreshState: RefreshState;
  stale: boolean;
  lastRefreshReason: RefreshReason | null;
  lastRefreshProblemCode: SourceDiagnosticCode | null;
  pendingRefreshCount: number;
  load: StateSourceLoad;
}

export interface RefreshResult {
  ok: boolean;
  reason: RefreshReason;
  outcome: RefreshOutcome;
  changed: boolean;
  snapshot: RefreshControllerSnapshot;
}

/**
 * Where the next load comes from.
 *
 * A legacy caller passes `vault` (and optionally the layout that produced its first read); a
 * record-store caller passes `source`. Exactly one is required, and the controller says so
 * rather than silently refreshing from nothing.
 */
export interface RefreshControllerOptions {
  initial: StateSourceLoad;
  source?: StateSource;
  vault?: VaultReader;
  loadOptions?: LoadOptions;
}

export interface RefreshController {
  refreshSource(reason: RefreshReason): Promise<RefreshResult>;
  snapshot(): RefreshControllerSnapshot;
}

/**
 * Rebound a load's diagnostics, keeping whatever else the source answered.
 *
 * The spread matters: a vault load carries its layout and census, and spreading keeps them
 * for callers that pass the snapshot back in as the next initial load. A record-store load
 * carries none of them, and none is invented for it.
 */
function boundedLoad<T extends StateSourceLoad>(load: T): T {
  return {
    ...load,
    state: load.state,
    problems: boundDiagnosticProblems(load.problems),
    revisions: {
      ...load.revisions,
    },
  };
}

function revisionMap(load: StateSourceLoad): Map<string, string> {
  return new Map(Object.entries(load.revisions));
}

function identityMap(load: StateSourceLoad): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of [...load.state.projects, ...load.state.tasks, ...load.state.events]) map.set(`${record.source.kind}:${record.id}`, record.source.path);
  return map;
}

function problemSignature(problems: LoadProblem[]): string {
  return problems.map((problem) => `${problem.code}|${problem.severity}|${problem.kind ?? ''}|${problem.id ?? ''}|${problem.path}|${problem.detail}`).sort().join('\n');
}

function classify(previous: StateSourceLoad, next: StateSourceLoad): RefreshOutcome {
  const oldRevisions = revisionMap(previous);
  const newRevisions = revisionMap(next);
  const removed = [...oldRevisions.keys()].filter((path) => !newRevisions.has(path));
  const added = [...newRevisions.keys()].filter((path) => !oldRevisions.has(path));
  const changed = [...oldRevisions.keys()].some((path) => newRevisions.has(path) && newRevisions.get(path) !== oldRevisions.get(path));
  const oldIdentities = identityMap(previous);
  const newIdentities = identityMap(next);
  const renamed = [...oldIdentities].some(([identity, path]) => newIdentities.get(identity) !== undefined && newIdentities.get(identity) !== path);
  if (renamed) return 'renamed';
  if (removed.length > 0 && added.length === 0 && !changed) return 'deleted';
  if (changed || removed.length > 0 || added.length > 0 || problemSignature(previous.problems) !== problemSignature(next.problems)) return 'changed';
  return 'unchanged';
}

function isFrontmatterParseFailure(problem: LoadProblem): boolean {
  return problem.code === 'frontmatter-parse-failure';
}

function refreshFailureOutcome(problems: LoadProblem[]): 'unreadable' | 'malformed' | null {
  const failure = problems.find(
    (problem) => isBlocking(problem) || isFrontmatterParseFailure(problem),
  );
  if (!failure) return null;
  return failure.code === 'unreadable' || failure.code === 'directory-unreadable' ? 'unreadable' : 'malformed';
}

function refreshFailureCode(problems: LoadProblem[]): SourceDiagnosticCode {
  return problems.find(isBlocking)?.code
    ?? problems.find(isFrontmatterParseFailure)?.code
    ?? 'refresh-failed';
}

export function createRefreshController(options: RefreshControllerOptions): RefreshController {
  if (options.source === undefined && options.vault === undefined) {
    throw new Error('refresh controller needs a source or a vault');
  }

  const loadOnce = async (): Promise<StateSourceLoad> => (
    options.source === undefined
      ? loadVaultState(options.vault!, options.loadOptions)
      : options.source.load()
  );

  let accepted = boundedLoad(options.initial);
  let sourceRevision = 1;
  let lastSuccessfulRefreshRevision = 1;
  let refreshState: RefreshState = 'idle';
  let stale = false;
  let lastRefreshReason: RefreshReason | null = null;
  let lastRefreshProblemCode: SourceDiagnosticCode | null = null;
  let pendingRefreshCount = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const snapshot = (): RefreshControllerSnapshot => ({
    sourceRevision,
    lastSuccessfulRefreshRevision,
    refreshState,
    stale,
    lastRefreshReason,
    lastRefreshProblemCode,
    pendingRefreshCount,
    load: accepted,
  });

  const run = async (reason: RefreshReason): Promise<RefreshResult> => {
    pendingRefreshCount -= 1;
    refreshState = 'refreshing';
    lastRefreshReason = reason;
    try {
      const next = boundedLoad(await loadOnce());
      const failure = refreshFailureOutcome(next.problems);
      if (failure) {
        refreshState = 'degraded';
        stale = true;
        lastRefreshProblemCode = refreshFailureCode(next.problems);
        return { ok: false, reason, outcome: failure, changed: false, snapshot: snapshot() };
      }
      const outcome = classify(accepted, next);
      const changed = outcome !== 'unchanged';
      if (changed) sourceRevision += 1;
      accepted = next;
      lastSuccessfulRefreshRevision = sourceRevision;
      refreshState = 'idle';
      stale = false;
      lastRefreshProblemCode = null;
      return { ok: true, reason, outcome, changed, snapshot: snapshot() };
    } catch {
      refreshState = 'degraded';
      stale = true;
      lastRefreshProblemCode = 'refresh-failed';
      return { ok: false, reason, outcome: 'unreadable', changed: false, snapshot: snapshot() };
    }
  };

  return {
    refreshSource(reason) {
      pendingRefreshCount += 1;
      const operation = queue.then(() => run(reason));
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    snapshot,
  };
}
