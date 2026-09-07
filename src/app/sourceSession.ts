import type { VaultReader } from '../ports/vault.js';
import type { LoadResult } from './vaultRepository.js';
import { createReadOnlyProjection, type ReadOnlyProjection } from './readOnlyProjection.js';
import { createRefreshController, type RefreshController, type RefreshReason, type RefreshResult } from './refreshController.js';
import { createRefreshPolicy, type RefreshPolicy, type RefreshScheduler } from './refreshPolicy.js';

export type SourceMode = 'fixture' | 'external';
export type SourceTransitionState = 'stable' | 'switching' | 'failed';

export interface SourceCandidate {
  mode: SourceMode;
  reader: VaultReader;
  initial: LoadResult;
}

export interface SourceSessionSnapshot {
  sourceMode: SourceMode;
  sourceGeneration: number;
  transitionState: SourceTransitionState;
  lastTransitionReason: 'activate' | 'switch' | 'refresh' | null;
  lastFailureCode: string | null;
  policy: ReturnType<RefreshPolicy['snapshot']>;
}

export interface SourceTransitionResult {
  ok: boolean;
  sourceMode: SourceMode;
  snapshot: SourceSessionSnapshot;
  projection: ReadOnlyProjection;
}

export interface SourceSessionOptions {
  initial: SourceCandidate;
  intervalMs?: number;
  scheduler?: RefreshScheduler;
  onProjection?: (projection: ReadOnlyProjection, mode: SourceMode, result?: RefreshResult) => void;
}

export interface SourceSession {
  switchTo(candidate: SourceCandidate): Promise<SourceTransitionResult>;
  refresh(reason: RefreshReason): Promise<RefreshResult | null>;
  dispose(): void;
  snapshot(): SourceSessionSnapshot;
  projection(): ReadOnlyProjection;
}

interface ActiveSource {
  candidate: SourceCandidate;
  controller: RefreshController;
  policy: RefreshPolicy;
  projection: ReadOnlyProjection;
}

function validCandidate(candidate: SourceCandidate): boolean {
  return !!candidate && (candidate.mode === 'fixture' || candidate.mode === 'external') && !!candidate.reader && !!candidate.initial && typeof candidate.initial.state === 'object';
}

/**
 * Serializes source transitions. It accepts already-authorized readers and loaded
 * snapshots only; acquisition, permission, and filesystem work stay outside.
 */
export function createSourceSession(options: SourceSessionOptions): SourceSession {
  if (!validCandidate(options.initial)) throw new Error('invalid initial source candidate');
  let sourceGeneration = 1;
  let transitionState: SourceTransitionState = 'stable';
  let lastTransitionReason: SourceSessionSnapshot['lastTransitionReason'] = 'activate';
  let lastFailureCode: string | null = null;
  let disposed = false;
  let active!: ActiveSource;
  let queue: Promise<unknown> = Promise.resolve();

  const projectionFor = (snapshot: Parameters<typeof createReadOnlyProjection>[0], generation: number, previous?: ReadOnlyProjection): ReadOnlyProjection => createReadOnlyProjection({
    ...snapshot,
    sourceRevision: generation,
    lastSuccessfulRefreshRevision: snapshot.stale ? (previous?.health.lastSuccessfulRefreshRevision ?? generation) : generation,
  }, previous?.health.applicationRevision ?? generation);

  const activate = (candidate: SourceCandidate, generation: number): ActiveSource => {
    // Refresh with the layout that produced this state, not the default. Without
    // this a legacy vault read correctly at startup and then degraded on the first
    // refresh, because the reload looked for the preferred directories and reported
    // them unreadable — the surface said DEGRADED about a vault that had not
    // changed at all.
    const controller = createRefreshController({
      vault: candidate.reader,
      initial: candidate.initial,
      loadOptions: { layout: candidate.initial.layout },
    });
    const source: ActiveSource = { candidate, controller, policy: undefined as unknown as RefreshPolicy, projection: projectionFor(controller.snapshot(), generation) };
    source.policy = createRefreshPolicy({ controller, intervalMs: options.intervalMs, scheduler: options.scheduler, onResult(result) {
      if (disposed || active !== source) return;
      if (result.ok && result.changed) sourceGeneration += 1;
      source.projection = projectionFor(result.snapshot, sourceGeneration, source.projection);
      options.onProjection?.(source.projection, source.candidate.mode, result);
    } });
    source.policy.start();
    return source;
  };

  active = activate(options.initial, sourceGeneration);

  const snapshot = (): SourceSessionSnapshot => ({
    sourceMode: active.candidate.mode,
    sourceGeneration,
    transitionState,
    lastTransitionReason,
    lastFailureCode,
    policy: active.policy.snapshot(),
  });

  return {
    switchTo(candidate) {
      const operation = queue.then(async (): Promise<SourceTransitionResult> => {
        if (disposed) return { ok: false, sourceMode: active.candidate.mode, snapshot: snapshot(), projection: active.projection };
        transitionState = 'switching';
        lastTransitionReason = 'switch';
        const previous = active;
        const previousLoad = previous.controller.snapshot().load;
        previous.policy.dispose();
        try {
          if (!validCandidate(candidate)) throw new Error('invalid-source-candidate');
          sourceGeneration += 1;
          active = activate(candidate, sourceGeneration);
          transitionState = 'stable';
          lastFailureCode = null;
          options.onProjection?.(active.projection, active.candidate.mode);
          return { ok: true, sourceMode: active.candidate.mode, snapshot: snapshot(), projection: active.projection };
        } catch (error) {
          lastFailureCode = error instanceof Error ? error.message.slice(0, 100) : 'source-switch-failed';
          active = activate({ ...previous.candidate, initial: previousLoad }, sourceGeneration);
          transitionState = 'failed';
          options.onProjection?.(active.projection, active.candidate.mode);
          return { ok: false, sourceMode: active.candidate.mode, snapshot: snapshot(), projection: active.projection };
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    refresh(reason) {
      if (disposed || transitionState === 'switching') return Promise.resolve(null);
      lastTransitionReason = 'refresh';
      return active.policy.trigger(reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active.policy.dispose();
    },
    snapshot,
    projection() { return active.projection; },
  };
}
