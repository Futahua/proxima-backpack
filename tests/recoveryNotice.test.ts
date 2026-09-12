/**
 * What a boot is allowed to say about its own recovery.
 *
 * The case that matters most is the negative one: `not-run` must never render as a clean
 * reconciliation. Recovery is a gate on mutation authority, so an agent or a person reading the
 * header after a crash has to be able to tell "we reconciled and there was nothing to do" from "we
 * never asked" — and a notice that rendered the second like the first would be worse than no notice
 * at all. The rest of the cases pin the machine-readable half, so a selector never has to parse prose.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StartupRecoveryInspection } from '../src/app/startupSession.js';
import { recoveryNoticeFor } from '../src/browser/recoveryNotice.js';

const MAIN_SOURCE = readFileSync(resolve(process.cwd(), 'src/browser/main.ts'), 'utf8');

function inspection(overrides: Partial<StartupRecoveryInspection> = {}): StartupRecoveryInspection {
  return {
    status: 'reconciled',
    mutationAuthority: 'available',
    outcomes: 2,
    unresolved: 0,
    reason: null,
    ...overrides,
  };
}

describe('the recovery notice', () => {
  it('never renders "we did not ask" as "we asked and it was clean"', () => {
    const neverAsked = recoveryNoticeFor(null);
    const answered = recoveryNoticeFor(inspection());

    expect(neverAsked.machineValue).toBe('not-run');
    expect(neverAsked.tone).toBe('attention');
    expect(neverAsked.mutationAuthority).toBe('unknown');
    expect(neverAsked.sentence).toContain('not run');
    // The two states are distinguishable on every axis a reader or a selector could use.
    expect(neverAsked.machineValue).not.toBe(answered.machineValue);
    expect(neverAsked.tone).not.toBe(answered.tone);
    expect(neverAsked.sentence).not.toBe(answered.sentence);

    // An explicit `not-run` answer is the same notice as no answer at all.
    expect(recoveryNoticeFor(inspection({ status: 'not-run' }))).toEqual(neverAsked);
  });

  it('calls a reconciliation clean only when it resolved everything it found', () => {
    const clean = recoveryNoticeFor(inspection());
    expect(clean.tone).toBe('clean');
    expect(clean.sentence).toContain('nothing unresolved');
    expect(clean.sentence).toContain('2 outcomes');
    expect(clean.unresolved).toBe(0);

    // Reconciled with something left over is not clean: those are the entries a reader must decide.
    const leftOver = recoveryNoticeFor(inspection({ unresolved: 3 }));
    expect(leftOver.tone).toBe('attention');
    expect(leftOver.sentence).toContain('3 unresolved');

    // Nor is a reconciliation that still left mutation authority closed.
    const closed = recoveryNoticeFor(inspection({ mutationAuthority: 'blocked' }));
    expect(closed.tone).toBe('attention');
    expect(closed.mutationAuthority).toBe('blocked');
  });

  it('carries the reason a blocked or failed boot gives, and says writes stay closed', () => {
    const blocked = recoveryNoticeFor(inspection({ status: 'blocked', mutationAuthority: 'blocked', unresolved: 1, reason: 'effect-present' }));
    expect(blocked.machineValue).toBe('blocked');
    expect(blocked.sentence).toContain('effect-present');
    expect(blocked.sentence).toContain('writes stay closed');

    const failed = recoveryNoticeFor(inspection({ status: 'failed', reason: 'recovery-failed: TypeError' }));
    expect(failed.machineValue).toBe('failed');
    expect(failed.sentence).toContain('recovery-failed: TypeError');

    // A status with no reason still renders a sentence rather than an empty gap.
    expect(recoveryNoticeFor(inspection({ status: 'failed', reason: null })).sentence).toContain('could not be read');
    expect(recoveryNoticeFor(inspection({ status: 'blocked', reason: null })).sentence).toContain('could not be reconciled');
  });

  it('names one outcome in the singular, because a notice that says "1 outcomes" reads as a bug', () => {
    expect(recoveryNoticeFor(inspection({ outcomes: 1 })).sentence).toContain('1 outcome,');
    expect(recoveryNoticeFor(inspection({ outcomes: 0 })).sentence).toContain('0 outcomes');
  });

  it('is consumed by the shell rather than restated in it', () => {
    expect(MAIN_SOURCE).toContain('recoveryNoticeFor(startupInspection?.recovery ?? null)');
    expect(MAIN_SOURCE).toContain('data-papers-visual-key="startup-recovery"');
    expect(MAIN_SOURCE).toContain('data-startup-recovery-tone=');
    expect(MAIN_SOURCE).toContain('data-startup-recovery-authority=');
  });
});
