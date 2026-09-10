import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import {
  createInspectionProjection,
  isInspectionProjection,
} from '../src/app/inspection.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

const INSPECTION_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/inspection.ts'),
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

async function dispatcher() {
  const loaded = await loadVaultState(
    fixtureVault('vault-basic'),
  );

  return createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode: 'fixture',
    initialCalendarMonth: '2026-09-01',
  });
}

describe('Stage 6 slice 19 renderer-independent inspection', () => {
  it('keeps the canonical inspection implementation outside browser and renderer dependencies', () => {
    expect(INSPECTION_SOURCE)
      .not.toMatch(/from ['"]\.\.\/browser\//);
    expect(INSPECTION_SOURCE)
      .not.toContain('renderWithBoundary');
    expect(INSPECTION_SOURCE)
      .not.toContain('data-c1-key');
    expect(INSPECTION_SOURCE)
      .not.toMatch(/\b(?:window|document|HTMLElement)\b/);
  });

  it('inspects semantic state directly in Node after dispatcher actions without browser globals', async () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);

    const d = await dispatcher();

    expect(d.dispatch({
      type: 'surface.select',
      surface: 'projects',
    })).toMatchObject({
      ok: true,
      snapshot: {
        surface: 'projects',
      },
    });

    expect(d.dispatch({
      type: 'project.workspace-tab.select',
      tab: 'task-board',
    })).toMatchObject({
      ok: true,
      snapshot: {
        projectWorkspaceTab: 'task-board',
      },
    });

    const projection = createInspectionProjection(
      d.snapshot(),
      BUILD,
    );

    expect(isInspectionProjection(projection)).toBe(true);
    expect(projection).toMatchObject({
      mode: 'fixture',
      surface: 'projects',
      submode: 'task-board',
      localState: {
        surface: 'projects',
        projectWorkspaceTab: 'task-board',
      },
      pendingOperations: {
        tracking: 'unavailable',
        items: [],
      },
      settled: {
        state: 'settled',
        revision: projection.applicationStateRevision,
      },
    });

    expect(Array.isArray(projection.projects)).toBe(true);
    expect(Array.isArray(projection.board.tasks)).toBe(true);
    expect(Array.isArray(projection.calendar.events)).toBe(true);
  });

  it('reads inspection repeatedly without mutating dispatcher state or event history', async () => {
    const d = await dispatcher();

    d.dispatch({
      type: 'surface.select',
      surface: 'schedule',
    });

    const beforeState = JSON.stringify(d.snapshot());
    const beforeEvents = structuredClone(d.events());

    const first = createInspectionProjection(
      d.snapshot(),
      BUILD,
    );
    const second = createInspectionProjection(
      d.snapshot(),
      BUILD,
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(d.snapshot())).toBe(beforeState);
    expect(d.events()).toEqual(beforeEvents);
    expect(first.applicationStateRevision)
      .toBe(d.snapshot().stateRevision);
    expect(first.latestEventSequence)
      .toBe(d.snapshot().latestEventSequence);
  });

  it('exposes semantic inspection data rather than renderer markup or visual implementation details', async () => {
    const d = await dispatcher();
    const projection = createInspectionProjection(
      d.snapshot(),
      BUILD,
    );

    expect(isInspectionProjection(projection)).toBe(true);

    expect(projection.projects.length).toBeGreaterThan(0);
    expect(projection.board.tasks.length).toBeGreaterThan(0);
    expect(projection.calendar.events.length).toBeGreaterThan(0);
    expect(projection.recordRevisions.length)
      .toBeGreaterThan(0);

    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain('data-c1-key');
    expect(serialized).not.toContain('innerHTML');
    expect(serialized).not.toContain('querySelector');
    expect(serialized).not.toContain('<section');
    expect(serialized).not.toContain('<button');
  });
});
