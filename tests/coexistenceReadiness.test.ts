import { beforeEach, describe, expect, it } from 'vitest';
import {
  NO_COEXISTENCE_EVIDENCE,
  coexistenceReadiness,
  declareCoexistenceReadiness,
  resetCoexistenceReadiness,
} from '../src/browser/coexistenceReadiness.js';
import { evaluateCreatorVaultPreflight } from '../src/app/creatorVaultPreflight.js';

/**
 * The browser surface used to pass a literal
 * `{ passed: false, zeroWrites: true, sourceBoundsValid: true, hostCapabilityResolved: true }`
 * into the preflight. READY was unreachable, and three facts were claimed without
 * observation. These tests pin the replacement: nothing is claimed by default, and
 * a claim can only enter through an explicit declaration.
 */
describe('coexistence readiness', () => {
  beforeEach(() => resetCoexistenceReadiness());

  it('claims nothing until evidence is declared', () => {
    expect(coexistenceReadiness()).toEqual(NO_COEXISTENCE_EVIDENCE);
    expect(Object.values(coexistenceReadiness()).every((value) => value === false)).toBe(true);
  });

  it('keeps the preflight blocked, and says the honest reason', () => {
    const preflight = evaluateCreatorVaultPreflight({
      acceptance: null as never,
      runbook: null as never,
      coexistence: coexistenceReadiness(),
      expectedBuildSha: 'deadbeef',
    });
    expect(preflight.status).not.toBe('READY_FOR_NATIVE_GRANT');
    expect(preflight.blockerCodes).toContain('coexistence-simulation-missing');
    expect(preflight.stages.coexistence6M).toBe('OPEN');
  });

  it('accepts only literal true, so a truthy value cannot become a claim', () => {
    declareCoexistenceReadiness({ passed: 'yes' as unknown as boolean, zeroWrites: 1 as unknown as boolean });
    expect(coexistenceReadiness()).toEqual(NO_COEXISTENCE_EVIDENCE);
  });

  it('records a declaration and ignores later mutation of the caller’s object', () => {
    const evidence = { passed: true, zeroWrites: true, sourceBoundsValid: true, hostCapabilityResolved: true };
    declareCoexistenceReadiness(evidence);
    evidence.passed = false;
    expect(coexistenceReadiness().passed).toBe(true);
  });

  it('treats a missing field as unobserved rather than inherited', () => {
    declareCoexistenceReadiness({ passed: true });
    expect(coexistenceReadiness()).toEqual({ passed: true, zeroWrites: false, sourceBoundsValid: false, hostCapabilityResolved: false });
  });

  it('can be returned to nothing observed between scenarios', () => {
    declareCoexistenceReadiness({ passed: true, zeroWrites: true, sourceBoundsValid: true, hostCapabilityResolved: true });
    resetCoexistenceReadiness();
    expect(coexistenceReadiness()).toEqual(NO_COEXISTENCE_EVIDENCE);
  });
});
