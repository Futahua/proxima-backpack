import { createReadOnlyProjection, type ReadOnlyProjection } from './readOnlyProjection.js';
import type { RefreshControllerSnapshot, RefreshReason, RefreshResult } from './refreshController.js';
import type { SourceMode, SourceSession, SourceSessionSnapshot } from './sourceSession.js';
import type { StateSource, StateSourceLoad } from './stateSource.js';
import type { VaultReader } from '../ports/vault.js';

export interface StandaloneRecoveryCandidate {
  readonly mutationAuthority: 'available' | 'blocked';
  readonly outcomes: number;
  readonly unresolved: number;
  readonly reason: string | null;
}

export interface StandaloneRecoveryInspection extends StandaloneRecoveryCandidate {
  readonly status: 'reconciled' | 'blocked' | 'failed' | 'not-run';
}

export interface StandaloneStartupInspection {
  readonly startupSourceMode: 'record-store';
  readonly restoredHandlePresent: false;
  readonly bootstrapStatus: 'no-restored-handle';
  readonly sourceGeneration: number;
  readonly sessionState: 'stable';
  readonly problemCodes: string[];
  readonly sourceDecisionKind: 'record-store';
  readonly sourceDecisionReason: string;
  readonly sourceDecisionDetail: string;
  readonly recovery: StandaloneRecoveryInspection;
}

export interface StandaloneStartupSessionOptions {
  readonly source: StateSource;
  readonly reader: VaultReader;
  readonly initial: StateSourceLoad;
  readonly sourceDecision: { readonly reason: string; readonly detail: string };
  readonly intervalMs?: number;
  readonly onProjection?: (projection: ReadOnlyProjection, mode: SourceMode, result?: RefreshResult) => void;
  readonly runRecovery?: (context: { readonly sourceMode: 'record-store' }) => Promise<StandaloneRecoveryCandidate>;
}

const DEFAULT_INTERVAL_MS = 60_000;
const NOT_RUN: StandaloneRecoveryInspection = Object.freeze({
  status: 'not-run',
  mutationAuthority: 'blocked',
  outcomes: 0,
  unresolved: 0,
  reason: null,
});

function signature(load: StateSourceLoad): string {
  return JSON.stringify({ state: load.state, problems: load.problems, revisions: load.revisions });
}

function snapshotFor(
  load: StateSourceLoad,
  sourceRevision: number,
  reason: RefreshReason | null,
): RefreshControllerSnapshot {
  return {
    sourceRevision,
    lastSuccessfulRefreshRevision: sourceRevision,
    refreshState: 'idle',
    stale: false,
    lastRefreshReason: reason,
    lastRefreshProblemCode: null,
    pendingRefreshCount: 0,
    load,
  };
}

async function recoveryFor(
  runRecovery: StandaloneStartupSessionOptions['runRecovery'],
): Promise<StandaloneRecoveryInspection> {
  if (!runRecovery) return NOT_RUN;
  try {
    const result = await runRecovery({ sourceMode: 'record-store' });
    return {
      status: result.mutationAuthority === 'available' ? 'reconciled' : 'blocked',
      mutationAuthority: result.mutationAuthority,
      outcomes: Number.isSafeInteger(result.outcomes) && result.outcomes > 0 ? result.outcomes : 0,
      unresolved: Number.isSafeInteger(result.unresolved) && result.unresolved > 0 ? result.unresolved : 0,
      reason: result.reason === null ? null : result.reason.slice(0, 200),
    };
  } catch (error) {
    return {
      status: 'failed',
      mutationAuthority: 'blocked',
      outcomes: 0,
      unresolved: 0,
      reason: `recovery-failed: ${error instanceof Error ? error.name.slice(0, 60) : 'unknown'}`,
    };
  }
}

export function createStandaloneStartupSession(options: StandaloneStartupSessionOptions): {
  start(): Promise<{ readonly session: SourceSession; readonly inspection: StandaloneStartupInspection }>;
  dispose(): void;
} {
  let result: { readonly session: SourceSession; readonly inspection: StandaloneStartupInspection } | null = null;
  let starting: Promise<{ readonly session: SourceSession; readonly inspection: StandaloneStartupInspection }> | null = null;

  return {
    start() {
      if (result) return Promise.resolve(result);
      if (starting) return starting;
      starting = (async () => {
        let sourceGeneration = 1;
        let currentLoad = options.initial;
        let currentProjection = createReadOnlyProjection(snapshotFor(currentLoad, sourceGeneration, null));
        let transitionState: SourceSessionSnapshot['transitionState'] = 'stable';
        let lastTransitionReason: SourceSessionSnapshot['lastTransitionReason'] = 'activate';
        let lastFailureCode: string | null = null;
        let disposed = false;
        let visible = true;
        let timer: ReturnType<typeof setInterval> | null = null;
        let refreshInFlight: Promise<RefreshResult | null> | null = null;

        const policy = () => ({
          enabled: true,
          intervalMs: Math.max(1_000, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS)),
          lastTriggerReason: null as RefreshReason | null,
          triggerCount: 0,
          coalescedTriggerCount: 0,
          timerActive: timer !== null,
          visible,
        });
        const sessionSnapshot = (): SourceSessionSnapshot => ({
          sourceMode: 'record-store',
          sourceGeneration,
          transitionState,
          lastTransitionReason,
          lastFailureCode,
          policy: policy(),
        });
        const refresh = async (reason: RefreshReason): Promise<RefreshResult | null> => {
          if (disposed) return null;
          if (refreshInFlight) return refreshInFlight;
          refreshInFlight = (async () => {
            const next = await options.source.load();
            const changed = signature(next) !== signature(currentLoad);
            if (changed) {
              sourceGeneration += 1;
              currentLoad = next;
              currentProjection = createReadOnlyProjection(snapshotFor(currentLoad, sourceGeneration, reason), currentProjection.health.applicationRevision);
              options.onProjection?.(currentProjection, 'record-store');
            }
            const refreshSnapshot = snapshotFor(currentLoad, sourceGeneration, reason);
            const outcome: RefreshResult['outcome'] = changed ? 'changed' : 'unchanged';
            return { ok: true, reason, outcome, changed, snapshot: refreshSnapshot };
          })().finally(() => { refreshInFlight = null; });
          return refreshInFlight;
        };
        const arm = (): void => {
          if (disposed || !visible || timer !== null) return;
          timer = setInterval(() => { void refresh('interval'); }, policy().intervalMs);
        };
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          if (timer !== null) clearInterval(timer);
          timer = null;
        };
        const session: SourceSession = {
          switchTo: async () => ({ ok: false, sourceMode: 'record-store', snapshot: sessionSnapshot(), projection: currentProjection }),
          refresh,
          setVisible(nextVisible, settings) {
            const wasVisible = visible;
            visible = nextVisible;
            if (!visible) {
              if (timer !== null) clearInterval(timer);
              timer = null;
              return;
            }
            arm();
            if (!wasVisible && (settings?.refreshOnVisible ?? true)) void refresh('focus');
          },
          dispose,
          snapshot: sessionSnapshot,
          projection: () => currentProjection,
          reader: () => options.reader,
        };
        arm();
        const recovery = await recoveryFor(options.runRecovery);
        const inspection: StandaloneStartupInspection = {
          startupSourceMode: 'record-store',
          restoredHandlePresent: false,
          bootstrapStatus: 'no-restored-handle',
          sourceGeneration,
          sessionState: 'stable',
          problemCodes: recovery.status === 'failed' ? ['recovery-failed'] : recovery.status === 'blocked' ? ['recovery-blocked'] : [],
          sourceDecisionKind: 'record-store',
          sourceDecisionReason: options.sourceDecision.reason,
          sourceDecisionDetail: options.sourceDecision.detail,
          recovery,
        };
        result = { session, inspection };
        return result;
      })();
      return starting;
    },
    dispose() {
      result?.session.dispose();
    },
  };
}
