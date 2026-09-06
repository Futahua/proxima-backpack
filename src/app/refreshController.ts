import { isBlocking, type LoadProblem } from '../domain/problems.js';
import type { VaultReader } from '../ports/vault.js';
import { loadVaultState, type LoadOptions, type LoadResult } from './vaultRepository.js';

export const REFRESH_REASONS = ['manual', 'focus', 'interval', 'external-signal'] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];
export type RefreshOutcome = 'unchanged' | 'changed' | 'deleted' | 'renamed' | 'unreadable' | 'malformed';
export type RefreshState = 'idle' | 'refreshing' | 'degraded';

const MAX_PROBLEMS = 100;

export interface RefreshControllerSnapshot {
  sourceRevision: number;
  lastSuccessfulRefreshRevision: number;
  refreshState: RefreshState;
  stale: boolean;
  lastRefreshReason: RefreshReason | null;
  lastRefreshProblemCode: string | null;
  pendingRefreshCount: number;
  load: LoadResult;
}

export interface RefreshResult {
  ok: boolean;
  reason: RefreshReason;
  outcome: RefreshOutcome;
  changed: boolean;
  snapshot: RefreshControllerSnapshot;
}

export interface RefreshControllerOptions {
  vault: VaultReader;
  loadOptions?: LoadOptions;
  initial: LoadResult;
}

export interface RefreshController {
  refreshSource(reason: RefreshReason): Promise<RefreshResult>;
  snapshot(): RefreshControllerSnapshot;
}

function boundedProblems(problems: LoadProblem[]): LoadProblem[] {
  return problems.slice(0, MAX_PROBLEMS).map((problem) => ({ ...problem, detail: problem.detail.slice(0, 400) }));
}

function boundedLoad(load: LoadResult): LoadResult {
  return { state: load.state, problems: boundedProblems(load.problems), revisions: { ...load.revisions }, layout: load.layout, census: load.census };
}

function revisionMap(load: LoadResult): Map<string, string> {
  return new Map(Object.entries(load.revisions));
}

function identityMap(load: LoadResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of [...load.state.projects, ...load.state.tasks, ...load.state.events]) map.set(`${record.source.kind}:${record.id}`, record.source.path);
  return map;
}

function problemSignature(problems: LoadProblem[]): string {
  return problems.map((problem) => `${problem.code}|${problem.severity}|${problem.kind ?? ''}|${problem.id ?? ''}|${problem.path}|${problem.detail}`).sort().join('\n');
}

function classify(previous: LoadResult, next: LoadResult): RefreshOutcome {
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

function refreshFailureOutcome(problems: LoadProblem[]): 'unreadable' | 'malformed' | null {
  const failure = problems.find((problem) => isBlocking(problem) || problem.code === 'unsupported-frontmatter');
  if (!failure) return null;
  return failure.code === 'unreadable' || failure.code === 'directory-unreadable' ? 'unreadable' : 'malformed';
}

export function createRefreshController(options: RefreshControllerOptions): RefreshController {
  let accepted = boundedLoad(options.initial);
  let sourceRevision = 1;
  let lastSuccessfulRefreshRevision = 1;
  let refreshState: RefreshState = 'idle';
  let stale = false;
  let lastRefreshReason: RefreshReason | null = null;
  let lastRefreshProblemCode: string | null = null;
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
      const next = boundedLoad(await loadVaultState(options.vault, options.loadOptions));
      const failure = refreshFailureOutcome(next.problems);
      if (failure) {
        refreshState = 'degraded';
        stale = true;
        lastRefreshProblemCode = next.problems.find(isBlocking)?.code ?? failure;
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
    } catch (error) {
      refreshState = 'degraded';
      stale = true;
      lastRefreshProblemCode = error instanceof Error ? error.name : 'refresh-failed';
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
