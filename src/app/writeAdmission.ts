/**
 * Whether this product may write, and to which bytes.
 *
 * Gate 14 closed creator-vault writes with a boundary *report*: `evaluateFsaWriteBoundary()` returns
 * `writerEnabled: false`, `evaluateOwnerAuthorityBoundary()` returns `writeAuthority: 'disabled'` —
 * and no runtime code called either one. A boundary nothing consults is a statement the product
 * makes about itself rather than a rule it enforces, which is the "capability present, not
 * exercised" pattern this checklist refuses elsewhere. This module is the rule, and it is a pure
 * function of five facts so that each one is a caller's argument rather than a lookup: which source
 * is in front of the product, which record type is being written, whether a write path resolved at
 * all, what the creator has enrolled, and whether the host has a commit primitive.
 *
 * The first rule is the one the surface has to mirror. `fixture` and `record-store` are this
 * product's own bytes — bundled fixture files, and canonical records behind the record store's own
 * boundary — while `external` is *live data*: the creator's notes behind a reader this process did
 * not create. Live bytes are refused **before enrollment is consulted**, so an enrollment listing
 * every record type still cannot write them. Enrollment is permission, not capability, and the
 * order of the checks below is where that sentence stops being a slogan.
 */
import type { SourceMode } from './sourceSession.js';

/** The creator's decision (Gate 14's second box). Nothing in this repository makes it. */
export interface WriteEnrollment {
  /** Flipped only by an explicit creator decision; every in-tree value is the default below. */
  readonly enrolled: boolean;
  /** The smallest set first (Gate 14's sixth box): record types, in the order enrolled. */
  readonly recordTypes: readonly string[];
}

/**
 * The default, and the only value any code in this tree constructs.
 *
 * `tests/writeAdmission.test.ts` asserts that by scanning the source rather than by trusting this
 * comment. A repository that can enroll itself is a repository where "disabled by default" is
 * decoration, and the scan is what makes the difference checkable rather than promised.
 */
export const DEFAULT_WRITE_ENROLLMENT: WriteEnrollment = Object.freeze({
  enrolled: false,
  recordTypes: Object.freeze([] as string[]),
});

export type WriteAdmissionRefusal =
  | 'native-transaction-required'
  | 'writes-disabled-by-default'
  | 'record-type-not-enrolled'
  | 'writes-unavailable';

export interface WriteAdmissionRequest {
  readonly sourceMode: SourceMode;
  /** What is being written. Compared by name against the enrolled set, never by position. */
  readonly recordType: string;
  /** Whether an ordinary write path resolved for this source at all. */
  readonly writePathAvailable: boolean;
  readonly enrollment: WriteEnrollment;
  /** Measured by the host boundary rather than assumed: FSA exposes no compare-and-swap commit. */
  readonly nativeTransactionAvailable: boolean;
}

export type WriteAdmission =
  | {
    readonly allowed: true;
    readonly sourceMode: SourceMode;
    readonly recordType: string;
    readonly liveData: boolean;
  }
  | {
    readonly allowed: false;
    readonly reason: WriteAdmissionRefusal;
    readonly detail: string;
    readonly liveData: boolean;
  };

/**
 * Live data is the creator's own bytes: the one mode whose reader this process did not create.
 *
 * `fixture` reads bundled files and `record-store` reads this product's own store, so neither is
 * *owned* by anyone else; `external` is a directory or restored handle the creator supplied.
 */
export function isLiveSource(mode: SourceMode): boolean {
  return mode === 'external';
}

function refused(reason: WriteAdmissionRefusal, detail: string, liveData: boolean): WriteAdmission {
  return { allowed: false, reason, detail, liveData };
}

/**
 * The gate.
 *
 * The order of the live checks is the contract rather than an implementation detail: capability,
 * then permission, then scope. A caller that reads the refusal learns the *first* thing standing in
 * the way instead of the last, and the first one — the missing atomic commit — is the only one this
 * repository cannot fix on its own.
 */
export function admitWrite(request: WriteAdmissionRequest): WriteAdmission {
  const liveData = isLiveSource(request.sourceMode);
  if (liveData) {
    if (!request.nativeTransactionAvailable) {
      return refused(
        'native-transaction-required',
        'the host exposes no atomic compare-and-swap commit, so a live write could silently overwrite a concurrent edit',
        liveData,
      );
    }
    if (!request.enrollment.enrolled) {
      return refused(
        'writes-disabled-by-default',
        'no explicit creator decision to allow writes has been recorded',
        liveData,
      );
    }
    if (!request.enrollment.recordTypes.includes(request.recordType)) {
      return refused(
        'record-type-not-enrolled',
        `the enrolled record types do not include ${request.recordType}`,
        liveData,
      );
    }
  }
  if (!request.writePathAvailable) {
    return refused('writes-unavailable', 'no write path resolved for this source', liveData);
  }
  return { allowed: true, sourceMode: request.sourceMode, recordType: request.recordType, liveData };
}
