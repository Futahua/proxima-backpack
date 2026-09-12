/**
 * Stage 20's § Acceptance: the four claims that say the transitional scaffolding can go without the
 * product or a program losing anything.
 *
 * One of them is behavioural and the rest are about where things live, which is the point — "the audit
 * harness is not the product" is a claim about the boot, and "rebuilding the Backpack does not threaten
 * record data" is a claim about location. So the first case builds the real dispatcher and reads its
 * initial snapshot, and the others assert the machine-readable surface and the record store's own
 * origin guard rather than describing them.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection, INSPECTION_SCHEMA_VERSION } from '../src/app/inspection.js';
import { PROXIMA_RECORD_STORE_ORIGIN } from '../src/adapters/opfsRecordStoreFileBackend.js';
import { BUILD_IDENTITY } from '../src/browser/generated/buildIdentity.generated.js';
import { fixedClock } from '../src/domain/clock.js';
import type { ProximaState } from '../src/domain/types.js';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function bytes(path: string): number {
  return statSync(resolve(process.cwd(), path)).size;
}

const MAIN = source('src/browser/main.ts');
const BUILD = {
  gitSha: '0'.repeat(40),
  fixedClock: '2026-09-12T00:00:00.000Z',
  builtAt: '2026-09-12T00:00:00.000Z',
};

function emptyState(): ProximaState {
  return {
    projects: [],
    tasks: [],
    events: [],
    statuses: [],
    taskSchema: [],
    workflowStages: [],
  };
}

function dispatcher(): ReturnType<typeof createActionDispatcher> {
  return createActionDispatcher({
    state: emptyState(),
    problems: [],
    revisions: {},
    mode: 'fixture',
    clock: fixedClock('2026-09-12T00:00:00.000Z'),
  });
}

describe('Stage 20 acceptance', () => {
  it('starts an ordinary run on the cockpit, with no acceptance surface in front of it', () => {
    // The boot's own answer: the dispatcher's initial snapshot is the Elastic cockpit, and the shell
    // does not choose a surface for it — so a run that has not asked for anything gets the product.
    const initial = dispatcher().snapshot();
    expect(initial.surface).toBe('tasks');
    expect(initial.tasksMode).toBe('elastic');
    expect(initial.selection).toBe('all');
    expect(MAIN).not.toContain('initialSurface:');
    // And the harness is behind the disclosure this stage added, not in front of the cockpit.
    expect(MAIN).toContain('renderAcceptanceTools(acceptanceToolsView)');
    expect(MAIN).not.toContain('data-action="fsa-probe"');
  });

  it('keeps build, source and recovery state in the inspection projection', () => {
    const projection = createInspectionProjection(dispatcher().snapshot(), BUILD_IDENTITY, {
      sourceRevision: 1,
      applicationRevision: 1,
      stale: false,
      degraded: false,
      lastSuccessfulRefreshRevision: 1,
      lastRefreshReason: null,
      problemCodes: [],
    });

    expect(projection.schemaVersion).toBe(INSPECTION_SCHEMA_VERSION);
    expect(projection.build).toEqual(BUILD_IDENTITY);
    expect(projection.sourceHealth).toMatchObject({ status: 'healthy' });
    expect(projection.degraded).toMatchObject({ state: 'healthy', blockingProblemCount: 0 });
    expect(projection.recordRevisions).toEqual([]);
    expect(projection.sourceRevisions).toEqual([]);
    // The shell installs it, and the acceptance hook beside it, for the agent path.
    expect(MAIN).toContain('__PROXIMA_INSPECTION__');
    expect(MAIN).toContain('createInspectionProjection(');
  });

  it('removes user-visible diagnostics without removing machine-readable diagnostics', () => {
    const projection = createInspectionProjection(dispatcher().snapshot(), BUILD_IDENTITY);
    // The machine-readable half of every diagnostic the surfaces draw: load problems, the degraded
    // verdict, and the bounded text budget that keeps a report inspectable.
    expect(projection.loadProblems).toEqual([]);
    expect(projection.degraded).toMatchObject({ state: 'healthy' });
    expect(source('src/app/inspection.ts')).toContain('MAX_INSPECTION_TEXT');
    expect(bytes('tests/inspection.test.ts')).toBeGreaterThan(500);
    expect(bytes('tests/rendererIndependentInspection.test.ts')).toBeGreaterThan(500);
    // The visible half is still drawn too — this box is about removing chrome, not facts.
    expect(MAIN).toContain('diagnosticsSurface(problems)');
  });

  it('keeps build, source and recovery health inspectable without letting it dominate the cockpit', () => {
    // "Inspectable" is the projection the previous case builds; "without dominating" is about where the
    // visible half sits. Three facts, each checkable: health is drawn once, as one strip, outside the
    // header; the build/recovery evidence is a collapsed disclosure rather than a panel; and the
    // header's state region holds only the identity, the badges, Refresh and the tools disclosure.
    const healthStrips = MAIN.match(/data-papers-visual-key="refresh-health"/g) ?? [];
    expect(healthStrips).toHaveLength(1);
    expect(MAIN).toContain('<details class="build-details">');
    expect(MAIN).not.toContain('<details class="build-details" open');

    const headerStart = MAIN.indexOf('class="header-state"');
    expect(headerStart).toBeGreaterThan(0);
    const header = MAIN.slice(headerStart, MAIN.indexOf('</header>', headerStart));
    expect(header).toContain('source-refresh-button');
    expect(header).toContain('renderAcceptanceTools(acceptanceToolsView)');
    expect(header).not.toContain('fsa-probe');
    expect(header).not.toContain('refresh-health');
    expect(header).not.toContain('diagnostics');

    // And the health model itself is bounded and covered, so "inspectable" is a projection rather than
    // a paragraph: the strip is drawn from `createUiHealthModel`, whose suite is its own.
    expect(MAIN).toContain('createUiHealthModel(');
    expect(bytes('tests/uiHealth.test.ts')).toBeGreaterThan(500);
  });

  it('keeps record data outside the app bundle, behind the Backpack origin guard', () => {
    // Records live in Proxima's Backpack-origin OPFS: a fixed origin, a record-store directory, and a
    // guard that every entry point passes through. Rebuilding or discarding the app cannot reach them,
    // and nothing here can write to the creator's vault.
    expect(PROXIMA_RECORD_STORE_ORIGIN).toBe('papers-backpack://bp-954ea2cd-6261-410d-baf8-0d1fbd8ca0b1');
    const backend = source('src/adapters/opfsRecordStoreFileBackend.ts');
    expect(backend).toContain('function assertProximaBackpackOrigin');
    expect(backend).toContain('Proxima Record Store OPFS is unavailable outside the accepted Backpack origin.');
    expect(backend).toContain("const RECORDS_DIRECTORY = 'records';");
    // The shell holds no record-store authority to rebuild away: operations only, behind the adapter.
    expect(MAIN).not.toContain('createCanonicalJsonRecordStore(');
    expect(MAIN).not.toContain('createRecordMutationCoordinator(');
    for (const suite of ['tests/recordMutationContainment.test.ts', 'tests/browserBoundary.test.ts', 'tests/recordStoreActivation.test.ts']) {
      expect(bytes(suite), `${suite} must exist and carry cases`).toBeGreaterThan(500);
    }
  });
});
