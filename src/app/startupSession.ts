import { bootstrapRestoredHandle, type BootstrapInspection, type ReadPermissionProvider, type RestoredHandleStore } from './handleBootstrap.js';
import { createSourceSession, type SourceCandidate, type SourceMode, type SourceSession, type SourceSessionOptions } from './sourceSession.js';
import { loadVaultState } from './vaultRepository.js';
import { detectLayout } from './vaultLayout.js';

export interface StartupSessionOptions extends Omit<SourceSessionOptions, 'initial'> {
  fixture: SourceCandidate;
  restored: { store: RestoredHandleStore; permissions: ReadPermissionProvider };
}

export interface StartupInspection {
  startupSourceMode: SourceMode;
  restoredHandlePresent: boolean;
  bootstrapStatus: BootstrapInspection['bootstrapStatus'];
  sourceGeneration: number;
  sessionState: 'stable' | 'switching' | 'failed';
  problemCodes: string[];
}

export interface StartupSessionResult {
  session: SourceSession;
  inspection: StartupInspection;
}

export interface StartupSessionOrchestrator {
  start(): Promise<StartupSessionResult>;
  dispose(): void;
}

function inspection(bootstrap: BootstrapInspection, session: SourceSession, extraCodes: string[] = []): StartupInspection {
  const state = session.snapshot();
  return {
    startupSourceMode: state.sourceMode,
    restoredHandlePresent: bootstrap.restoredHandlePresent,
    bootstrapStatus: bootstrap.bootstrapStatus,
    sourceGeneration: state.sourceGeneration,
    sessionState: state.transitionState,
    problemCodes: [...new Set([...bootstrap.problemCodes, ...extraCodes])].map((code) => code.slice(0, 100)).slice(0, 20),
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
            if (!activationFailed(loaded)) initial = { mode: 'external', reader: bootstrapResult.reader, initial: loaded };
            else extraCodes = ['activation-failed'];
          }
        }
        const session = createSourceSession({ ...options, initial });
        result = { session, inspection: inspection(bootstrap, session, extraCodes) };
        return result;
      })();
      return starting;
    },
    dispose() {
      result?.session.dispose();
    },
  };
}
