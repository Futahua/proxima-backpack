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
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

const NODE_ID = 'canvas-node-0001';

async function dispatcherWithCanvas(
  nodeIds: ReadonlySet<string> = new Set([NODE_ID]),
) {
  const loaded = await loadVaultState(fixtureVault('vault-basic'));
  return createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode: 'fixture',
    canvasNodeExists: (nodeId) => nodeIds.has(nodeId),
  });
}

describe('Stage 6 slice 4 Canvas semantic action seam', () => {
  it('versions and classifies Canvas selection separately from eventual record mutations', () => {
    expect(ACTION_SCHEMA_VERSION).toBe(4);
    expect(ACTION_TAXONOMY_VERSION).toBe(4);

    expect(categoryOf('canvas.node.select')).toBe('local-state');
    expect(categoryOf('canvas.node.geometry.change'))
      .toBe('record-mutation');
    expect(categoryOf('canvas.node.remove'))
      .toBe('record-mutation');
  });

  it('schema-validates Canvas selection, removal and bounded geometry proposals', () => {
    expect(parseAction({
      type: 'canvas.node.select',
      nodeId: NODE_ID,
    })).toEqual({
      ok: true,
      action: {
        type: 'canvas.node.select',
        nodeId: NODE_ID,
      },
    });

    expect(parseAction({
      type: 'canvas.node.select',
      nodeId: null,
    })).toEqual({
      ok: true,
      action: {
        type: 'canvas.node.select',
        nodeId: null,
      },
    });

    expect(parseAction({
      type: 'canvas.node.remove',
      nodeId: NODE_ID,
    }).ok).toBe(true);

    const geometry = {
      type: 'canvas.node.geometry.change',
      nodeId: NODE_ID,
      operation: 'move',
      proposedX: 100_000,
      proposedY: -100_000,
      proposedWidth: 160,
      proposedHeight: 1_200,
    } as const;

    expect(parseAction(geometry)).toEqual({
      ok: true,
      action: geometry,
    });

    for (const invalid of [
      { type: 'canvas.node.select', nodeId: '' },
      { type: 'canvas.node.remove', nodeId: '' },
      { ...geometry, operation: 'rotate' },
      { ...geometry, proposedX: 100_001 },
      { ...geometry, proposedY: Number.NaN },
      { ...geometry, proposedWidth: 159 },
      { ...geometry, proposedWidth: 1_601 },
      { ...geometry, proposedHeight: 119 },
      { ...geometry, proposedHeight: 1_201 },
    ]) {
      expect(parseAction(invalid).ok).toBe(false);
    }
  });

  it('selects and clears only known Canvas nodes and exposes the selection through validated results', async () => {
    const dispatcher = await dispatcherWithCanvas();
    const initialRevision = dispatcher.snapshot().stateRevision;

    const selected = dispatcher.dispatch({
      type: 'canvas.node.select',
      nodeId: NODE_ID,
    });
    expect(selected).toMatchObject({
      ok: true,
      actionType: 'canvas.node.select',
      category: 'local-state',
      changed: true,
      entityIds: [NODE_ID],
      stateRevision: initialRevision + 1,
      snapshot: {
        canvasSelectedNodeId: NODE_ID,
      },
    });
    expect(isActionResult(selected)).toBe(true);

    const missing = dispatcher.dispatch({
      type: 'canvas.node.select',
      nodeId: 'missing-node',
    });
    expect(missing).toMatchObject({
      ok: false,
      category: 'local-state',
      outcome: 'not-found',
      error: {
        code: 'record-not-found',
        field: 'nodeId',
      },
    });
    expect(dispatcher.snapshot().canvasSelectedNodeId).toBe(NODE_ID);

    const cleared = dispatcher.dispatch({
      type: 'canvas.node.select',
      nodeId: null,
    });
    expect(cleared).toMatchObject({
      ok: true,
      changed: true,
      snapshot: {
        canvasSelectedNodeId: null,
      },
    });

    expect(dispatcher.dispatch({
      type: 'canvas.node.select',
      nodeId: NODE_ID,
    }).ok).toBe(true);
    expect(dispatcher.snapshot().canvasSelectedNodeId).toBe(NODE_ID);

    const reset = dispatcher.dispatch({ type: 'fixture.reset' });
    expect(reset).toMatchObject({
      ok: true,
      changed: true,
      snapshot: {
        canvasSelectedNodeId: null,
      },
    });
  });

  it('returns typed unavailable for existing-node geometry/removal without changing application or record state', async () => {
    const dispatcher = await dispatcherWithCanvas();
    const beforeState = JSON.stringify(dispatcher.snapshot().state);
    const beforeRevision = dispatcher.snapshot().stateRevision;

    const geometry = dispatcher.dispatch({
      type: 'canvas.node.geometry.change',
      nodeId: NODE_ID,
      operation: 'resize',
      proposedX: 10,
      proposedY: 20,
      proposedWidth: 400,
      proposedHeight: 260,
    });
    expect(geometry).toMatchObject({
      ok: false,
      actionType: 'canvas.node.geometry.change',
      category: 'record-mutation',
      outcome: 'unavailable',
      stateRevision: beforeRevision,
      entityIds: [NODE_ID],
      error: {
        code: 'action-not-available',
      },
    });
    expect(isActionResult(geometry)).toBe(true);

    const removal = dispatcher.dispatch({
      type: 'canvas.node.remove',
      nodeId: NODE_ID,
    });
    expect(removal).toMatchObject({
      ok: false,
      actionType: 'canvas.node.remove',
      category: 'record-mutation',
      outcome: 'unavailable',
      stateRevision: beforeRevision,
      entityIds: [NODE_ID],
      error: {
        code: 'action-not-available',
      },
    });

    const missing = dispatcher.dispatch({
      type: 'canvas.node.remove',
      nodeId: 'missing-node',
    });
    expect(missing).toMatchObject({
      ok: false,
      category: 'record-mutation',
      outcome: 'not-found',
      stateRevision: beforeRevision,
      error: {
        code: 'record-not-found',
      },
    });

    expect(JSON.stringify(dispatcher.snapshot().state)).toBe(beforeState);
    expect(dispatcher.snapshot().stateRevision).toBe(beforeRevision);
  });

  it('fails closed when no Canvas inventory resolver is available', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
    });
    const beforeState = JSON.stringify(dispatcher.snapshot().state);
    const beforeRevision = dispatcher.snapshot().stateRevision;

    const selection = dispatcher.dispatch({
      type: 'canvas.node.select',
      nodeId: NODE_ID,
    });
    expect(selection).toMatchObject({
      ok: false,
      category: 'local-state',
      outcome: 'unavailable',
      error: {
        code: 'action-not-available',
      },
    });

    for (const action of [
      {
        type: 'canvas.node.geometry.change',
        nodeId: NODE_ID,
        operation: 'move',
        proposedX: 0,
        proposedY: 0,
        proposedWidth: 320,
        proposedHeight: 200,
      },
      {
        type: 'canvas.node.remove',
        nodeId: NODE_ID,
      },
    ]) {
      const result = dispatcher.dispatch(action);
      expect(result).toMatchObject({
        ok: false,
        category: 'record-mutation',
        outcome: 'unavailable',
        error: {
          code: 'action-not-available',
        },
      });
    }

    expect(dispatcher.snapshot().canvasSelectedNodeId).toBeNull();
    expect(JSON.stringify(dispatcher.snapshot().state)).toBe(beforeState);
    expect(dispatcher.snapshot().stateRevision).toBe(beforeRevision);
  });
});
