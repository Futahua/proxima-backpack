import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import {
  boundDiagnosticProblem,
  redactDiagnosticSecrets,
} from '../src/app/diagnostics.js';
import { createScenarioEvidence } from '../src/app/evidence.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { renderWithBoundary } from '../src/browser/renderBoundary.js';
import type { VaultReader } from '../src/ports/vault.js';
import { fixtureFiles } from './fixtures.js';

const TASK_PATH = 'Proxima/tasks/Write fixture vault.md';

const BEARER_TOKEN =
  'ghp_0123456789abcdefghijklmnopqrstuv';
const API_KEY =
  'sk-0123456789abcdefghijklmnopqrstuvwxyz';
const PASSWORD =
  'creator-password-value';

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

function expectSecretsAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(BEARER_TOKEN);
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).not.toContain(PASSWORD);
}

describe('Stage 6 slice 15 credential-safe diagnostics', () => {
  it('redacts recognized credential-bearing forms without rewriting ordinary diagnostic prose', () => {
    const ordinary =
      'task reader failed after three attempts';
    expect(redactDiagnosticSecrets(ordinary)).toBe(ordinary);

    const diagnostic = [
      `Authorization: Bearer ${BEARER_TOKEN}`,
      `api_key="${API_KEY}"`,
      `password=${PASSWORD}`,
      `https://creator:${PASSWORD}@example.invalid/api`,
      `provider returned ${API_KEY}`,
    ].join('; ');

    const redacted = redactDiagnosticSecrets(diagnostic);

    expectSecretsAbsent(redacted);
    expect(redacted).toContain('[redacted]');
    expect(redacted).toContain('Authorization: [redacted]');
    expect(redacted).toContain('api_key=[redacted]');
    expect(redacted).toContain('password=[redacted]');
  });

  it('redacts credential-shaped values in bounded problem path, logical id and detail while preserving diagnostic structure', () => {
    const problem = boundDiagnosticProblem({
      code: 'unreadable',
      severity: 'error',
      path: `Proxima/token=${BEARER_TOKEN}.md`,
      kind: 'task',
      id: `client_secret=${API_KEY}`,
      detail:
        `read failed password='${PASSWORD}'`,
    });

    expect(problem).toMatchObject({
      code: 'unreadable',
      severity: 'error',
      kind: 'task',
    });
    expect(problem.path).toContain('[redacted]');
    expect(problem.id).toContain('[redacted]');
    expect(problem.detail).toContain('[redacted]');
    expectSecretsAbsent(problem);
  });

  it('sanitizes repository diagnostics before LoadResult and downstream read-only inspection expose them', async () => {
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
            `Authorization: Bearer ${BEARER_TOKEN}; api_key=${API_KEY}; password=${PASSWORD}`,
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
    expect(unreadable?.detail).toContain('[redacted]');
    expectSecretsAbsent(loaded.problems);

    const controller = createRefreshController({
      vault: reader,
      initial: loaded,
    });
    const projection = createReadOnlyProjection(
      controller.snapshot(),
    );

    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
    });
    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );

    expectSecretsAbsent(projection.problems);
    expectSecretsAbsent(inspection.loadProblems);
    expect(
      inspection.loadProblems.some(
        (problem) => problem.code === 'unreadable',
      ),
    ).toBe(true);
  });

  it('redacts credentials from renderer failure detail and escaped fallback markup without changing renderer-failure identity', () => {
    const result = renderWithBoundary(() => {
      throw new Error(
        `render failed Authorization: Bearer ${BEARER_TOKEN}; token=${API_KEY}; password=${PASSWORD}`,
      );
    });

    expect(result.failure?.code).toBe('renderer-failure');
    expect(result.failure?.detail).toContain('[redacted]');
    expect(result.markup).toContain(
      'data-papers-visual-key="renderer-failure"',
    );
    expectSecretsAbsent(result);
  });

  it('redacts credential-shaped diagnostic evidence without changing the evidence schema or non-diagnostic fields', () => {
    const evidence = createScenarioEvidence({
      scenarioId: 'credential-diagnostic-test',
      proximaBuild: BUILD,
      fixture: {
        hash: 'fixture-hash',
        fixedClock: BUILD.fixedClock,
        idSeed: 'sequential',
      },
      actionTranscript: [],
      eventTranscript: [],
      initialStateRevision: 1,
      finalStateRevision: 1,
      domainAssertions: ['reader remains read-only'],
      c1Assertions: [],
      diagnostics: [
        `Authorization: Bearer ${BEARER_TOKEN}`,
        `api_key=${API_KEY}`,
        `password=${PASSWORD}`,
      ],
      captures: [],
      passed: false,
    });

    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.scenarioId)
      .toBe('credential-diagnostic-test');
    expect(evidence.domainAssertions)
      .toEqual(['reader remains read-only']);
    expect(
      evidence.diagnostics.every(
        (diagnostic) => diagnostic.includes('[redacted]'),
      ),
    ).toBe(true);
    expectSecretsAbsent(evidence);
  });
});
