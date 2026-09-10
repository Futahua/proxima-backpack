import type { ActionResult } from './actionProtocol.js';
import type {
  RefreshReason,
  RefreshResult,
} from './refreshController.js';

export interface SourceRefreshActionDependencies {
  dispatch(input: unknown): ActionResult | null;
  refresh(
    reason: Extract<RefreshReason, 'manual'>,
  ): Promise<RefreshResult | null>;
}

export interface SourceRefreshActionExecution {
  action: ActionResult | null;
  refresh: RefreshResult | null;
}

/**
 * Headless semantic composition for a manual source refresh.
 *
 * Action acceptance means only that the semantic request was admitted.
 * RefreshResult remains the truth about whether the source read itself
 * completed, changed, degraded, or retained last-good state.
 */
export async function executeSourceRefreshAction(
  dependencies: SourceRefreshActionDependencies,
): Promise<SourceRefreshActionExecution> {
  const action = dependencies.dispatch({ type: 'source.refresh' });

  if (!action?.ok) {
    return {
      action,
      refresh: null,
    };
  }

  const refresh = await dependencies.refresh('manual');

  return {
    action,
    refresh,
  };
}
