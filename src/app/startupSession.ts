import { bootstrapRestoredHandle, type BootstrapInspection, type ReadPermissionProvider, type RestoredHandleStore } from './handleBootstrap.js';
import { createSourceSession, type SourceCandidate, type SourceMode, type SourceSession, type SourceSessionOptions } from './sourceSession.js';
import type { StateSource } from './stateSource.js';
import { loadVaultState } from './vaultRepository.js';
import { detectLayout } from './vaultLayout.js';

export interface StartupSessionOptions extends Omit<SourceSessionOptions, 'initial'> {
  fixture: SourceCandidate;
  restored: { store: RestoredHandleStore; permissions: ReadPermissionProvider };
  /**
   * The record store, when startup decided it is canonical.
   *
   * Present means records come from here in every case — including when a restored vault
   * handle exists, because a creator's vault is where *artifacts* live and not where records
   * live once the store is canonical. Absent means the legacy reader is the record source,
   * which is what a store with no activation marker means.
   */
  recordStore?: StateSource | null;
  /** Why the store was or was not chosen, for the startup inspection. */
  sourceDecision?: { kind: 'record-store' | 'legacy'; reason: string; detail: string } | null;
}

export interface StartupInspection {
  startupSourceMode: SourceMode;
  restoredHandlePresent: boolean;
  bootstrapStatus: BootstrapInspection['bootstrapStatus'];
  sourceGeneration: number;
  sessionState: 'stable' | 'switching' | 'failed';
  problemCodes: string[];
  /** Which source startup chose and why, so a fallback is never invisible. */
  sourceDecisionKind: 'record-store' | 'legacy';
  sourceDecisionReason: string;
  sourceDecisionDetail: string;
}

export interface StartupSessionResult {
  session: SourceSession;
  inspection: StartupInspection;
}

export interface StartupSessionOrchestrator {
  start(): Promise<StartupSessionResult>;
  dispose(): void;
}

function inspection(
  bootstrap: BootstrapInspection,
  session: SourceSession,
  extraCodes: string[] = [],
  decision: StartupSessionOptions['sourceDecision'] = null,
): StartupInspection {
  const state = session.snapshot();
  return {
    startupSourceMode: state.sourceMode,
    restoredHandlePresent: bootstrap.restoredHandlePresent,
    bootstrapStatus: bootstrap.bootstrapStatus,
    sourceGeneration: state.sourceGeneration,
    sessionState: state.transitionState,
    problemCodes: [...new Set([...bootstrap.problemCodes, ...extraCodes])].map((code) => code.slice(0, 100)).slice(0, 20),
    // A fallback that is not reported is invisible, and "why is this reading Markdown?" is the
    // first question an operator asks at a cutover.
    sourceDecisionKind: decision?.kind ?? (state.sourceMode === 'record-store' ? 'record-store' : 'legacy'),
    sourceDecisionReason: decision?.reason ?? (state.sourceMode === 'record-store' ? 'activated' : 'not-decided'),
    sourceDecisionDetail: decision?.detail ?? '',
  };
}

function activationFailed(load: Awaited<ReturnType<typeof loadVaultState>>): boolean {
  return load.problems.some((problem) => problem.code === 'directory-unreadable' || problem.code === 'unreadable');
}

/**
 * Creates exactly one source session per orchestrator instance. Restored-handle
 * acquisition/permission is delegated to 6G; this layer only composes its result.
 */
export function createStartupSessionOrchestrator(options: StartupSessionOptions): StartupSessionOrchestrator {
  let result: StartupSessionResult | null = null;
  let starting: Promise<StartupSessionResult> | null = null;
  return {
    start() {
      if (result) return Promise.resolve(result);
      if (starting) return starting;
      starting = (async () => {
        const bootstrapResult = await bootstrapRestoredHandle(options.restored.store, options.restored.permissions);
        const bootstrap = bootstrapResult.inspection;
        let initial = options.fixture;
        let extraCodes: string[] = [];
        // The record store wins when startup chose it, and the restored vault handle — if any —
        // becomes the artifact reader of that candidate rather than a competing record source.
        // A creator's vault is where notes live, not where records live once the store is
        // canonical; treating a restored handle as a source switch here would silently undo
        // the cutover on every launch with a remembered folder.
        if (options.recordStore) {
          initial = {
            mode: 'record-store',
            reader: options.fixture.reader,
            source: options.recordStore,
            initial: await options.recordStore.load(),
          };
        }
        if (bootstrapResult.reader) {
          // Which layout, before reading. A restored source is a real creator vault
          // and may use either supported layout; assuming the preferred one made a
          // legacy vault look empty, fail activation, and fall back to fixture
          // bytes without ever saying why. Ambiguity is not resolved by preference —
          // the read is simply not attempted.
          const detection = await detectLayout(bootstrapResult.reader);
          if (detection.kind === 'ambiguous') {
            extraCodes = ['layout-ambiguous'];
          } else {
            const loaded = await loadVaultState(
              bootstrapResult.reader,
              detection.layout ? { layout: detection.layout } : {},
            );
            if (activationFailed(loaded)) {
              extraCodes = ['activation-failed'];
            } else if (options.recordStore) {
              // The store keeps the records; the restored vault becomes this candidate's
              // artifact reader, so notes come from the creator's real folder.
              initial = { ...initial, reader: bootstrapResult.reader };
            } else {
              initial = { mode: 'external', reader: bootstrapResult.reader, initial: loaded };
            }
          }
        }
        const session = createSourceSession({ ...options, initial });
        result = { session, inspection: inspection(bootstrap, session, extraCodes, options.sourceDecision ?? null) };
        return result;
      })();
      return starting;
    },
    dispose() {
      result?.session.dispose();
    },
  };
}
