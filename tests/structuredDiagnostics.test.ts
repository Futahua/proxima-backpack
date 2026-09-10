import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import {
  DIAGNOSTIC_CODES,
  isDiagnosticCode,
} from '../src/app/diagnostics.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { renderWithBoundary } from '../src/browser/renderBoundary.js';
import { PROBLEM_CODES } from '../src/domain/problems.js';
import type { VaultReader } from '../src/ports/vault.js';
import { fixtureFiles, fixtureVault } from './fixtures.js';

describe('Stage 6 slice 6 structured diagnostic code catalog', () => {
  it('publishes one unique machine-readable catalog for load, refresh and renderer diagnostics', () => {
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
    expect(
      PROBLEM_CODES.every((code) => isDiagnosticCode(code)),
    ).toBe(true);
    expect(isDiagnosticCode('refresh-failed')).toBe(true);
    expect(isDiagnosticCode('renderer-failure')).toBe(true);

    for (const value of [
      'TypeError',
      'malformed',
      'permission denied',
      '/Users/creator/private-vault',
    ]) {
      expect(isDiagnosticCode(value)).toBe(false);
    }
  });

  it('keeps malformed as an outcome while exposing the actual unsupported-frontmatter diagnostic code', async () => {
    const vault = createMemoryVault(fixtureFiles('vault-basic'));
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({
      vault,
      initial,
    });
    const path = 'Proxima/tasks/Write fixture vault.md';

    vault.set(path, '---\nstatus: [broken\n---\n');

    const degraded = await controller.refreshSource('external-signal');
    const projection = createReadOnlyProjection(degraded.snapshot);

    expect(degraded).toMatchObject({
      ok: false,
      outcome: 'malformed',
      changed: false,
      snapshot: {
        lastRefreshProblemCode: 'unsupported-frontmatter',
      },
    });
    expect(
      isDiagnosticCode(degraded.snapshot.lastRefreshProblemCode),
    ).toBe(true);
    expect(projection.health.problemCodes)
      .toContain('unsupported-frontmatter');
    expect(projection.health.problemCodes)
      .not.toContain('malformed');
  });

  it('collapses an unexpected refresh exception to refresh-failed instead of emitting runtime error names or details as codes', async () => {
    const initial = await loadVaultState(fixtureVault('vault-basic'));
    const explodingVault = {
      async list() {
        return [];
      },
      async read() {
        throw new Error('unused');
      },
      async exists() {
        return false;
      },
      async walk() {
        throw new Error('walk failed');
      },
      get presence(): never {
        throw new TypeError(
          'C:\\private\\creator-vault secret-token',
        );
      },
    } as unknown as VaultReader;

    const controller = createRefreshController({
      vault: explodingVault,
      initial,
    });
    const failure = await controller.refreshSource('manual');

    expect(failure).toMatchObject({
      ok: false,
      outcome: 'unreadable',
      changed: false,
      snapshot: {
        stale: true,
        refreshState: 'degraded',
        lastRefreshProblemCode: 'refresh-failed',
      },
    });
    expect(
      isDiagnosticCode(failure.snapshot.lastRefreshProblemCode),
    ).toBe(true);

    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain('TypeError');
    expect(serialized).not.toContain('secret-token');
  });

  it('keeps the existing bounded renderer-failure code inside the same catalog', () => {
    const result = renderWithBoundary(() => {
      throw new Error(
        '<script>alert(1)</script>\n' + 'x'.repeat(500),
      );
    });

    expect(result.failure?.code).toBe('renderer-failure');
    expect(isDiagnosticCode(result.failure?.code)).toBe(true);
    expect(result.failure?.detail.length).toBeLessThanOrEqual(180);
    expect(result.markup).toContain(
      'data-c1-key="renderer-failure"',
    );
    expect(result.markup).not.toContain('<script>');
  });
});
