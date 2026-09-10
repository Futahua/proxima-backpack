import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import {
  boundDiagnosticProblem,
  redactDiagnosticDisclosure,
} from '../src/app/diagnostics.js';
import { createScenarioEvidence } from '../src/app/evidence.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { renderWithBoundary } from '../src/browser/renderBoundary.js';
import type { VaultReader } from '../src/ports/vault.js';
import { fixtureFiles, fixtureVault } from './fixtures.js';

const WINDOWS_ROOT = 'C:\\Users\\creator\\PrivateVault';
const WINDOWS_FILE =
  `${WINDOWS_ROOT}\\Proxima\\tasks\\private.md`;
const POSIX_ROOT = '/Users/creator/PrivateVault';
const POSIX_FILE =
  `${POSIX_ROOT}/Proxima/tasks/private.md`;
const UNC_FILE =
  '\\\\creator-host\\private-share\\vault\\private.md';
const TASK_PATH = 'Proxima/tasks/Write fixture vault.md';

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

function expectMachinePathsAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(WINDOWS_ROOT);
  expect(serialized).not.toContain(POSIX_ROOT);
  expect(serialized).not.toContain(
    '\\\\creator-host\\private-share',
  );
}

describe('Stage 6 slice 16 machine-path-safe diagnostics', () => {
  it('redacts Windows, POSIX and UNC absolute paths while preserving useful vault-relative paths', () => {
    const diagnostic = [
      `windows=${WINDOWS_FILE}`,
      `posix="${POSIX_FILE}"`,
      `unc=${UNC_FILE}`,
      'relative=Proxima/tasks/private.md',
    ].join('; ');

    const redacted = redactDiagnosticDisclosure(diagnostic);

    expectMachinePathsAbsent(redacted);
    expect(redacted).toContain('[redacted]');
    expect(redacted).toContain(
      'relative=Proxima/tasks/private.md',
    );
  });

  it('redacts an absolute structured problem path completely while retaining relative problem paths', () => {
    const absolute = boundDiagnosticProblem({
      code: 'unreadable',
      severity: 'error',
      path: `${WINDOWS_ROOT}\\Folder With Spaces\\task.md`,
      kind: 'task',
      detail: `EACCES while reading ${POSIX_FILE}`,
    });

    expect(absolute.path).toBe('[redacted]');
    expect(absolute.detail).toContain('[redacted]');
    expectMachinePathsAbsent(absolute);

    const relative = boundDiagnosticProblem({
      code: 'unreadable',
      severity: 'error',
      path: TASK_PATH,
      kind: 'task',
      detail: 'repository read failed',
    });

    expect(relative.path).toBe(TASK_PATH);
    expect(relative.detail).toBe('repository read failed');
  });

  it('sanitizes repository exception paths before LoadResult and live inspection disclosure', async () => {
    const base = createMemoryVault(
      fixtureFiles('vault-basic'),
    );

    const reader: VaultReader = {
      list: (directory) => base.list(directory),
      walk: (directory) => base.walk(directory),
      exists: (path) => base.exists(path),
      presence: (directory) => base.presence!(directory),
      read: async (path, maxChars) => {
        if (path === TASK_PATH) {
          throw new Error(
            `EACCES opening ${WINDOWS_FILE}`,
          );
        }
        return await base.read(path, maxChars);
      },
    };

    const loaded = await loadVaultState(reader);
    const unreadable = loaded.problems.find(
      (problem) =>
        problem.code === 'unreadable'
        && problem.path === TASK_PATH,
    );

    expect(unreadable).toBeDefined();
    expect(unreadable?.path).toBe(TASK_PATH);
    expect(unreadable?.detail).toContain('[redacted]');
    expectMachinePathsAbsent(loaded.problems);

    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'live',
    });
    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );

    expect(
      inspection.loadProblems.some(
        (problem) =>
          problem.code === 'unreadable'
          && problem.path === undefined
          && problem.detail.includes('[redacted]'),
      ),
    ).toBe(true);
    expectMachinePathsAbsent(inspection);
  });

  it('fails closed on absolute source provenance in live inspection without exposing the machine root', async () => {
    const loaded = await loadVaultState(
      fixtureVault('vault-basic'),
    );
    const state = structuredClone(loaded.state);
    const project = state.projects[0]!;
    const projectId = project.id;

    project.source.path = WINDOWS_FILE;

    const dispatcher = createActionDispatcher({
      state,
      problems: [
        ...loaded.problems,
        {
          code: 'unreadable',
          severity: 'error',
          path: WINDOWS_FILE,
          kind: 'project',
          id: projectId,
          detail: `source failed at "${POSIX_FILE}"`,
        },
      ],
      revisions: loaded.revisions,
      mode: 'live',
    });

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );
    const inspectedProject = inspection.projects.find(
      (candidate) => candidate.id === projectId,
    );

    expect(inspectedProject?.provenance.relativeSourcePath)
      .toBe('');
    expect(
      inspection.recordRevisions.every(
        (entry) => entry.path === undefined,
      ),
    ).toBe(true);
    expect(
      inspection.sourceRevisions.every(
        (entry) => entry.path === undefined,
      ),
    ).toBe(true);

    const problem = inspection.loadProblems.find(
      (candidate) =>
        candidate.code === 'unreadable'
        && candidate.id === projectId,
    );
    expect(problem?.path).toBeUndefined();
    expect(problem?.detail).toContain('[redacted]');
    expectMachinePathsAbsent(inspection);
  });

  it('redacts absolute machine paths from renderer and evidence diagnostic disclosure without schema changes', () => {
    const rendered = renderWithBoundary(() => {
      throw new Error(
        `renderer failed at ${WINDOWS_FILE}`,
      );
    });

    expect(rendered.failure?.code).toBe('renderer-failure');
    expect(rendered.failure?.detail).toContain('[redacted]');
    expectMachinePathsAbsent(rendered);

    const evidence = createScenarioEvidence({
      scenarioId: 'machine-path-redaction',
      proximaBuild: BUILD,
      fixture: {
        hash: BUILD.fixtureHash,
        fixedClock: BUILD.fixedClock,
        idSeed: 'sequential',
      },
      actionTranscript: [],
      eventTranscript: [],
      initialStateRevision: 1,
      finalStateRevision: 1,
      domainAssertions: ['diagnostics remain read-only'],
      c1Assertions: [],
      diagnostics: [
        `repository failed at ${POSIX_FILE}`,
        `secondary path ${UNC_FILE}`,
      ],
      captures: [],
      passed: false,
    });

    expect(evidence.schemaVersion).toBe(1);
    expect(
      evidence.diagnostics.every(
        (diagnostic) => diagnostic.includes('[redacted]'),
      ),
    ).toBe(true);
    expectMachinePathsAbsent(evidence);
  });
});
