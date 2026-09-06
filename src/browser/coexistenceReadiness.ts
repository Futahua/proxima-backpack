/**
 * Coexistence readiness the browser surface is allowed to claim.
 *
 * This replaces a literal in the render path that read
 * `{ passed: false, zeroWrites: true, sourceBoundsValid: true, hostCapabilityResolved: true }`.
 * The `false` made READY_FOR_NATIVE_GRANT unreachable no matter what evidence
 * existed; the three `true`s were worse, because they asserted facts nobody had
 * observed. A preflight that both cannot pass and lies about why is not a
 * conservative default — it is an unfalsifiable one.
 *
 * So readiness is a declared input with a single honest default: nothing observed.
 * An acceptance run that has actually produced Gate 6M evidence declares it; the
 * browser never infers it, and no field may be hardcoded true at a call site again.
 */

export interface CoexistenceReadiness {
  /** A disposable peer-writer coexistence simulation actually passed. */
  passed: boolean;
  /** Zero writes was proved by instrumentation, not by an unassigned counter. */
  zeroWrites: boolean;
  /** Source paths stayed inside the granted root and never leaked. */
  sourceBoundsValid: boolean;
  /** The host capability question was resolved rather than assumed. */
  hostCapabilityResolved: boolean;
}

/**
 * The default. Every field false: no simulation has run in this page, so the
 * preflight reports `coexistence-simulation-missing` and stays BLOCKED — which is
 * the true state of a freshly booted surface.
 */
export const NO_COEXISTENCE_EVIDENCE: Readonly<CoexistenceReadiness> = Object.freeze({
  passed: false,
  zeroWrites: false,
  sourceBoundsValid: false,
  hostCapabilityResolved: false,
});

let declared: CoexistenceReadiness = { ...NO_COEXISTENCE_EVIDENCE };

/**
 * Record evidence produced elsewhere — a Gate 6P acceptance run — for this page.
 *
 * Booleans are coerced explicitly so a truthy string or a missing field cannot
 * become a claim, and the value is copied so a later mutation of the caller's
 * object cannot change what the surface reports.
 */
export function declareCoexistenceReadiness(evidence: Partial<CoexistenceReadiness>): CoexistenceReadiness {
  declared = {
    passed: evidence.passed === true,
    zeroWrites: evidence.zeroWrites === true,
    sourceBoundsValid: evidence.sourceBoundsValid === true,
    hostCapabilityResolved: evidence.hostCapabilityResolved === true,
  };
  return { ...declared };
}

export function coexistenceReadiness(): CoexistenceReadiness {
  return { ...declared };
}

/** Return the surface to "nothing observed". Used between acceptance scenarios. */
export function resetCoexistenceReadiness(): void {
  declared = { ...NO_COEXISTENCE_EVIDENCE };
}
