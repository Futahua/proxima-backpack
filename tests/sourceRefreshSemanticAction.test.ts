import { describe, expect, it } from 'vitest';
import {
  ACTION_SCHEMA_VERSION,
  createActionDispatcher,
  isActionResult,
  parseAction,
} from '../src/app/actionProtocol.js';
import {
  ACTION_TAXONOMY_VERSION,
  categoryOf,
} from '../src/app/actionTaxonomy.js';
import { executeSourceRefreshAction } from '../src/app/sourceRefreshAction.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

async function dispatcher(mode: 'fixture' | 'live' = 'fixture') {
  const loaded = await loadVaultState(fixtureVault('vault-basic'));
  return createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode,
  });
}

describe('Stage 6 slice 5 semantic source refresh seam', () => {
  it('versions, classifies and parses source.refresh as a read-side semantic action', () => {
    expect(ACTION_SCHEMA_VERSION).toBe(4);
    expect(ACTION_TAXONOMY_VERSION).toBe(4);
    expect(categoryOf('source.refresh')).toBe('local-state');

    expect(parseAction({
      type: 'source.refresh',
    })).toEqual({
      ok: true,
      action: {
        type: 'source.refresh',
      },
    });
  });

  it('admits a fixture refresh request without pretending the source itself changed', async () => {
    const d = await dispatcher();
    const beforeState = JSON.stringify(d.snapshot().state);
    const beforeRevision = d.snapshot().stateRevision;

    const result = d.dispatch({
      type: 'source.refresh',
    });

    expect(result).toMatchObject({
      schemaVersion: 4,
      ok: true,
      actionType: 'source.refresh',
      category: 'local-state',
      outcome: 'accepted',
      changed: false,
      stateRevision: beforeRevision,
      entityIds: [],
    });
    expect(isActionResult(result)).toBe(true);
    expect(JSON.stringify(d.snapshot().state)).toBe(beforeState);
    expect(d.snapshot().stateRevision).toBe(beforeRevision);
  });

  it('admits the same read-only refresh request in live mode without granting mutation authority', async () => {
    const d = await dispatcher('live');
    const beforeState = JSON.stringify(d.snapshot().state);
    const beforeRevision = d.snapshot().stateRevision;

    const result = d.dispatch({
      type: 'source.refresh',
    });

    expect(result).toMatchObject({
      ok: true,
      actionType: 'source.refresh',
      category: 'local-state',
      outcome: 'accepted',
      changed: false,
      stateRevision: beforeRevision,
    });
    expect(JSON.stringify(d.snapshot().state)).toBe(beforeState);
    expect(d.snapshot().stateRevision).toBe(beforeRevision);
  });

  it('executes an admitted semantic request through the existing manual SourceSession refresh seam and fails closed without admission', async () => {
    const d = await dispatcher();
    const reasons: string[] = [];

    const executed = await executeSourceRefreshAction({
      dispatch: (input) => d.dispatch(input),
      refresh: async (reason) => {
        reasons.push(reason);
        return null;
      },
    });

    expect(executed.action).toMatchObject({
      ok: true,
      actionType: 'source.refresh',
    });
    expect(executed.refresh).toBeNull();
    expect(reasons).toEqual(['manual']);

    const blockedReasons: string[] = [];
    const blocked = await executeSourceRefreshAction({
      dispatch: () => null,
      refresh: async (reason) => {
        blockedReasons.push(reason);
        return null;
      },
    });

    expect(blocked).toEqual({
      action: null,
      refresh: null,
    });
    expect(blockedReasons).toEqual([]);
  });
});
