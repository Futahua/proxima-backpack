import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import {
  evidenceFromInspection,
  isScenarioEvidence,
} from '../src/app/evidence.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createStartupSessionOrchestrator } from '../src/app/startupSession.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { bridgeUrlForLaunch } from '../src/browser/agentBridge.js';
import { fixtureVault } from './fixtures.js';

const MAIN_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/browser/main.ts'),
  'utf8',
);

const BUILD = {
  proximaVersion: '0.1.0',
  gitSha: 'test-sha',
  buildMode: 'fixture',
  domainSchemaVersion: '1',
  controlSchemaVersion: '0',
  fixtureSchemaVersion: '1',
  fixtureHash: 'fixture-hash',
  lockfileHash: 'lock-hash',
  fixedClock: '2026-09-06T12:00:00.000Z',
};

describe('Stage 6 slice 21 optional Papers control', () => {
  it('keeps the developer bridge an explicit opt-in rather than a launch prerequisite', () => {
    const query =
      '?bridge=http%3A%2F%2F127.0.0.1%3A4174';

    expect(bridgeUrlForLaunch(query, false)).toBeNull();
    expect(bridgeUrlForLaunch('', true)).toBeNull();
    expect(bridgeUrlForLaunch(query, true))
      .toBe('http://127.0.0.1:4174');
  });

  it('keeps browser startup viable when the optional bridge resolves to no automation directory', () => {
    expect(MAIN_SOURCE).toContain(
      'const bridgeUrl = bridgeUrlForLaunch(window.location.search, BUILD_IDENTITY.agentBridgeEnabled);',
    );
    expect(MAIN_SOURCE).toContain(
      'const automationDirectory = bridgeUrl ? createHttpDirectoryHandle(bridgeUrl) : null;',
    );
    expect(MAIN_SOURCE).toContain(
      'const fixture = createBrowserSource();',
    );
    expect(MAIN_SOURCE).toContain(
      "restored: { store: { restore: async () => automationDirectory }, permissions: { queryPermission: async () => automationDirectory ? 'granted' : 'denied' } },",
    );

    expect(MAIN_SOURCE).not.toContain('window.papers');
    expect(MAIN_SOURCE).not.toContain('postMessage(');
  });

  it('starts the canonical source session without Papers control or restored external transport', async () => {
    expect('papers' in globalThis).toBe(false);

    const reader = fixtureVault('vault-basic');
    const initial = await loadVaultState(reader);

    const startup = createStartupSessionOrchestrator({
      fixture: {
        mode: 'fixture',
        reader,
        initial,
      },
      restored: {
        store: {
          restore: async () => null,
        },
        permissions: {
          queryPermission: async () => 'denied',
        },
      },
    });

    const started = await startup.start();

    try {
      expect(started.inspection).toMatchObject({
        startupSourceMode: 'fixture',
        restoredHandlePresent: false,
        bootstrapStatus: 'no-restored-handle',
        sourceGeneration: 1,
        sessionState: 'stable',
      });

      expect(started.session.snapshot()).toMatchObject({
        sourceMode: 'fixture',
        sourceGeneration: 1,
        transitionState: 'stable',
      });

      expect(
        started.session.projection().state.projects.length,
      ).toBeGreaterThan(0);
      expect(
        started.session.projection().state.tasks.length,
      ).toBeGreaterThan(0);
    } finally {
      startup.dispose();
    }
  });

  it('keeps Papers identity optional in valid evidence while preserving typed-unavailable mutation semantics', async () => {
    const loaded = await loadVaultState(
      fixtureVault('vault-basic'),
    );
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
    });

    const beforeState = JSON.stringify(
      dispatcher.snapshot().state,
    );
    const beforeRevision =
      dispatcher.snapshot().stateRevision;

    const refusal = dispatcher.dispatch({
      type: 'project.create',
      name: 'No Papers control required',
      description: 'record-store cutover has not happened',
    });

    expect(refusal).toMatchObject({
      ok: false,
      actionType: 'project.create',
      category: 'record-mutation',
      outcome: 'unavailable',
      stateRevision: beforeRevision,
      error: {
        code: 'action-not-available',
      },
    });

    if (refusal.ok) {
      throw new Error('expected project.create to remain unavailable');
    }

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );
    const evidence = evidenceFromInspection(
      inspection,
      [
        {
          actionType: refusal.actionType,
          ok: refusal.ok,
          stateRevision: refusal.stateRevision,
          errorCode: refusal.error.code,
        },
      ],
      dispatcher.events(),
      'papers-control-optional',
      'sequential',
    );

    expect(isScenarioEvidence(evidence)).toBe(true);
    expect(evidence.papers).toBeUndefined();
    expect(evidence.actionTranscript).toEqual([
      {
        actionType: 'project.create',
        ok: false,
        stateRevision: beforeRevision,
        errorCode: 'action-not-available',
      },
    ]);
    expect(JSON.stringify(dispatcher.snapshot().state))
      .toBe(beforeState);
    expect(dispatcher.snapshot().stateRevision)
      .toBe(beforeRevision);
  });
});
