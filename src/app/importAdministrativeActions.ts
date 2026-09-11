import {
  LEGACY_IMPORT_PLAN_SCHEMA_VERSION,
  type LegacyImportPlan,
  type LegacyImportProjectSelection,
} from './importPlanner.js';
import type {
  LegacyImportVerificationResult,
} from './importVerification.js';
import {
  parseOpaqueRecordId,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';

export const LEGACY_IMPORT_ADMIN_ACTION_SCHEMA_VERSION =
  1 as const;

export type LegacyImportAdministrativeAction =
  | {
      readonly type:
        'import.plan';
    }
  | {
      readonly type:
        'import.inspect';
    }
  | {
      readonly type:
        'import.status';
    }
  | {
      readonly type:
        'import.resolve';

      /**
       * The candidate project record to apply, for every ambiguous project
       * reference whose candidate set contains it. An id that is a candidate of
       * no ambiguous reference is refused rather than silently ignored.
       */
      readonly candidateProjectRecordId:
        OpaqueRecordId;
    }
  | {
      readonly type:
        'import.commit';
    };

export type LegacyImportAdministrativeActionType =
  LegacyImportAdministrativeAction[
    'type'
  ];

export type LegacyImportAdministrativeOpenCheck =
  | 'unsupported-frontmatter-importability'
  | 'recurrence-migration'
  | 'event-all-day-intent';

export interface LegacyImportAdministrativeStatus {
  readonly phase:
    | 'not-planned'
    | 'planned'
    | 'verified'
    | 'blocked';

  readonly planSchemaVersion:
    number | null;

  readonly verificationSchemaVersion:
    number | null;

  readonly verificationVerdict:
    | 'verified'
    | 'blocked'
    | null;

  readonly plannedPhysicalRecords:
    number;

  readonly verifiedPhysicalRecords:
    number;

  readonly blockedPhysicalRecords:
    number;

  readonly deferredChecks:
    readonly LegacyImportAdministrativeOpenCheck[];

  readonly liveWritesAuthorized:
    false;
}

export type LegacyImportAdministrativeActionData =
  | {
      readonly kind:
        'plan';
      readonly plan:
        LegacyImportPlan;
    }
  | {
      readonly kind:
        'inspection';
      readonly verification:
        LegacyImportVerificationResult;
    }
  | {
      readonly kind:
        'status';
      readonly status:
        LegacyImportAdministrativeStatus;
    };

export interface LegacyImportAdministrativeActionSuccess {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_ADMIN_ACTION_SCHEMA_VERSION;

  readonly ok:
    true;

  readonly actionType:
    LegacyImportAdministrativeActionType;

  readonly outcome:
    'accepted';

  readonly requestId:
    string;

  readonly durableChange:
    false;

  readonly data:
    LegacyImportAdministrativeActionData;
}

export type LegacyImportAdministrativeFailureCode =
  | 'invalid-action'
  | 'invalid-action-input'
  | 'action-not-available'
  | 'dependency-failure'
  | 'invalid-evidence';

export interface LegacyImportAdministrativeActionFailure {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_ADMIN_ACTION_SCHEMA_VERSION;

  readonly ok:
    false;

  readonly actionType:
    string;

  readonly outcome:
    | 'validation-refused'
    | 'unavailable'
    | 'dependency-failure'
    | 'invalid-evidence';

  readonly requestId:
    string;

  readonly durableChange:
    false;

  readonly error: {
    readonly code:
      LegacyImportAdministrativeFailureCode;

    readonly message:
      string;

    readonly deferredChecks?:
      readonly LegacyImportAdministrativeOpenCheck[];
  };
}

export type LegacyImportAdministrativeActionResult =
  | LegacyImportAdministrativeActionSuccess
  | LegacyImportAdministrativeActionFailure;

export interface LegacyImportAdministrativeActionDependencies {
  /**
   * Produce the already-authored zero-write dry-run import plan.
   *
   * The administrative action surface receives no vault writer, staging writer,
   * Record Store writer or activation capability itself.
   */
  readonly plan:
    (
      selection?:
        LegacyImportProjectSelection | null,
    ) => Promise<
      LegacyImportPlan
    >;

  /**
   * Inspect one accepted dry-run plan using the already-authored read-only
   * verification boundary.
   */
  readonly inspect:
    (
      plan:
        LegacyImportPlan,
    ) => Promise<
      LegacyImportVerificationResult
    >;
}

export interface LegacyImportAdministrativeActions {
  dispatch(
    input:
      unknown,
  ): Promise<
    LegacyImportAdministrativeActionResult
  >;
}

const OPEN_CHECKS:
  readonly LegacyImportAdministrativeOpenCheck[] = [
    'unsupported-frontmatter-importability',
    'recurrence-migration',
    'event-all-day-intent',
  ];

function isRecord(
  value:
    unknown,
): value is Readonly<
  Record<
    string,
    unknown
  >
> {
  return typeof value
    === 'object'
    && value
      !== null
    && !Array.isArray(
      value,
    );
}

function isAdministrativeActionType(
  value:
    unknown,
): value is LegacyImportAdministrativeActionType {
  return value
    === 'import.plan'
    || value
      === 'import.inspect'
    || value
      === 'import.status'
    || value
      === 'import.resolve'
    || value
      === 'import.commit';
}

export function parseLegacyImportAdministrativeAction(
  input:
    unknown,
):
  | {
      readonly ok:
        true;
      readonly action:
        LegacyImportAdministrativeAction;
    }
  | {
      readonly ok:
        false;
      readonly error: {
        readonly code:
          'invalid-action'
          | 'invalid-action-input';
        readonly message:
          string;
      };
    } {
  if (
    !isRecord(
      input,
    )
    || typeof input.type
      !== 'string'
  ) {
    return {
      ok: false,
      error: {
        code:
          'invalid-action',
        message:
          'import administrative action must be an object with a string type',
      },
    };
  }

  if (
    !isAdministrativeActionType(
      input.type,
    )
  ) {
    return {
      ok: false,
      error: {
        code:
          'invalid-action',
        message:
          `unsupported import administrative action type: ${input.type}`,
      },
    };
  }

  const actionType =
    input.type;

  if (
    actionType
    === 'import.resolve'
  ) {
    if (
      Object.keys(
        input,
      ).length
      !== 2
      || !(
        'candidateProjectRecordId'
        in input
      )
    ) {
      return {
        ok: false,
        error: {
          code:
            'invalid-action-input',
          message:
            'import.resolve requires exactly one candidateProjectRecordId input',
        },
      };
    }

    const requested =
      input
        .candidateProjectRecordId;

    if (
      typeof requested
        !== 'string'
      || requested
        .length
        === 0
    ) {
      return {
        ok: false,
        error: {
          code:
            'invalid-action-input',
          message:
            'import.resolve candidateProjectRecordId must be a non-empty string',
        },
      };
    }

    let candidateProjectRecordId:
      OpaqueRecordId;

    try {
      candidateProjectRecordId =
        parseOpaqueRecordId(
          requested,
        );
    } catch {
      return {
        ok: false,
        error: {
          code:
            'invalid-action-input',
          message:
            'import.resolve candidateProjectRecordId must be an opaque Proxima record id',
        },
      };
    }

    return {
      ok: true,
      action: {
        type:
          'import.resolve',
        candidateProjectRecordId,
      },
    };
  }

  if (
    Object.keys(
      input,
    ).length
    !== 1
  ) {
    return {
      ok: false,
      error: {
        code:
          'invalid-action-input',
        message:
          `${actionType} does not accept a payload in this import slice`,
      },
    };
  }

  return {
    ok: true,
    action: {
      type:
        actionType,
    },
  };
}

function sameStringSet(
  left:
    readonly string[],
  right:
    readonly string[],
): boolean {
  return JSON.stringify(
    [
      ...left,
    ].sort(),
  ) === JSON.stringify(
    [
      ...right,
    ].sort(),
  );
}

function isAcceptedDryRunPlan(
  plan:
    LegacyImportPlan,
): boolean {
  return plan.schemaVersion
    === LEGACY_IMPORT_PLAN_SCHEMA_VERSION
    && plan.mode
      === 'dry-run'
    && plan.writes
      .legacyMarkdown
      === 0
    && plan.writes
      .recordStore
      === 0
    && plan.writes
      .staging
      === 0
    && plan.counts
      .physicalCandidates
      === plan.conversions
        .length;
}

function isAcceptedVerification(
  plan:
    LegacyImportPlan,
  verification:
    LegacyImportVerificationResult,
): boolean {
  return verification.mode
    === 'verification'
    && verification.source
      === 'legacy-import-plan-and-staging-results'
    && (
      verification.verdict
        === 'verified'
      || verification.verdict
        === 'blocked'
    )
    && verification.counts
      .total
      .planned
      === plan.conversions
        .length
    && verification.counts
      .total
      .accounted
      === verification.counts
        .total
        .planned
    && verification.dispositions
      .length
      === verification.counts
        .total
        .planned
    && verification.verifierWrites
      .legacyMarkdown
      === 0
    && verification.verifierWrites
      .staging
      === 0
    && verification.verifierWrites
      .recordStore
      === 0
    && verification.verifierWrites
      .externalArtifacts
      === 0
    && verification.verifierWrites
      .activation
      === 0
    && sameStringSet(
      verification
        .deferredChecks,
      OPEN_CHECKS,
    );
}

function statusFor(
  plan:
    LegacyImportPlan | null,
  verification:
    LegacyImportVerificationResult | null,
): LegacyImportAdministrativeStatus {
  if (
    plan === null
  ) {
    return {
      phase:
        'not-planned',
      planSchemaVersion:
        null,
      verificationSchemaVersion:
        null,
      verificationVerdict:
        null,
      plannedPhysicalRecords:
        0,
      verifiedPhysicalRecords:
        0,
      blockedPhysicalRecords:
        0,
      deferredChecks: [
        ...OPEN_CHECKS,
      ],
      liveWritesAuthorized:
        false,
    };
  }

  if (
    verification === null
  ) {
    return {
      phase:
        'planned',
      planSchemaVersion:
        plan.schemaVersion,
      verificationSchemaVersion:
        null,
      verificationVerdict:
        null,
      plannedPhysicalRecords:
        plan.counts
          .physicalCandidates,
      verifiedPhysicalRecords:
        0,
      blockedPhysicalRecords:
        0,
      deferredChecks: [
        ...OPEN_CHECKS,
      ],
      liveWritesAuthorized:
        false,
    };
  }

  return {
    phase:
      verification.verdict
        === 'verified'
        ? 'verified'
        : 'blocked',
    planSchemaVersion:
      plan.schemaVersion,
    verificationSchemaVersion:
      verification
        .schemaVersion,
    verificationVerdict:
      verification.verdict,
    plannedPhysicalRecords:
      verification.counts
        .total
        .planned,
    verifiedPhysicalRecords:
      verification.counts
        .total
        .stagedVerified,
    blockedPhysicalRecords:
      verification.counts
        .total
        .blocked,
    deferredChecks: [
      ...OPEN_CHECKS,
    ],
    liveWritesAuthorized:
      false,
  };
}

export function createLegacyImportAdministrativeActions(
  dependencies:
    LegacyImportAdministrativeActionDependencies,
): LegacyImportAdministrativeActions {
  let latestPlan:
    LegacyImportPlan | null =
      null;

  let latestVerification:
    LegacyImportVerificationResult | null =
      null;

  let requestSequence =
    0;

  const nextRequestId =
    (): string => {
      requestSequence +=
        1;

      return `import-admin-${requestSequence}`;
    };

  const failure = (
    actionType:
      string,
    requestId:
      string,
    outcome:
      LegacyImportAdministrativeActionFailure[
        'outcome'
      ],
    code:
      LegacyImportAdministrativeFailureCode,
    message:
      string,
    includeDeferredChecks =
      false,
  ): LegacyImportAdministrativeActionFailure => ({
    schemaVersion:
      LEGACY_IMPORT_ADMIN_ACTION_SCHEMA_VERSION,
    ok:
      false,
    actionType,
    outcome,
    requestId,
    durableChange:
      false,
    error: {
      code,
      message,
      ...(includeDeferredChecks
        ? {
            deferredChecks: [
              ...OPEN_CHECKS,
            ],
          }
        : {}),
    },
  });

  const success = (
    actionType:
      LegacyImportAdministrativeActionType,
    requestId:
      string,
    data:
      LegacyImportAdministrativeActionData,
  ): LegacyImportAdministrativeActionSuccess => ({
    schemaVersion:
      LEGACY_IMPORT_ADMIN_ACTION_SCHEMA_VERSION,
    ok:
      true,
    actionType,
    outcome:
      'accepted',
    requestId,
    durableChange:
      false,
    data,
  });

  return {
    async dispatch(
      input:
        unknown,
    ): Promise<
      LegacyImportAdministrativeActionResult
    > {
      const requestId =
        nextRequestId();

      const parsed =
        parseLegacyImportAdministrativeAction(
          input,
        );

      if (
        !parsed.ok
      ) {
        return failure(
          isRecord(
            input,
          )
          && typeof input.type
            === 'string'
            ? input.type
            : 'unknown',
          requestId,
          'validation-refused',
          parsed.error
            .code,
          parsed.error
            .message,
        );
      }

      const action =
        parsed.action;

      if (
        action.type
        === 'import.status'
      ) {
        return success(
          action.type,
          requestId,
          {
            kind:
              'status',
            status:
              statusFor(
                latestPlan,
                latestVerification,
              ),
          },
        );
      }

      if (
        action.type
        === 'import.resolve'
      ) {
        if (
          latestPlan
          === null
        ) {
          return failure(
            action.type,
            requestId,
            'unavailable',
            'action-not-available',
            'import.resolve needs an accepted import.plan result first',
            true,
          );
        }

        const isCandidateOfAmbiguity =
          latestPlan
            .projectReferences
            .some(
              (reference) =>
                reference
                  .resolution
                === 'ambiguous'
                && (
                  reference
                    .candidateProjectRecordIds
                  ?? []
                ).includes(
                  action
                    .candidateProjectRecordId,
                ),
            );

        if (
          !isCandidateOfAmbiguity
        ) {
          return failure(
            action.type,
            requestId,
            'validation-refused',
            'invalid-action-input',
            `import.resolve candidate ${action.candidateProjectRecordId} is not a candidate of any ambiguous project reference in the accepted plan`,
          );
        }

        let resolvedPlan:
          LegacyImportPlan;

        try {
          resolvedPlan =
            await dependencies
              .plan({
                candidateProjectRecordId:
                  action
                    .candidateProjectRecordId,
              });
        } catch {
          return failure(
            action.type,
            requestId,
            'dependency-failure',
            'dependency-failure',
            'import.resolve dependency failed',
          );
        }

        if (
          !isAcceptedDryRunPlan(
            resolvedPlan,
          )
        ) {
          return failure(
            action.type,
            requestId,
            'invalid-evidence',
            'invalid-evidence',
            'import.resolve dependency returned evidence outside the accepted zero-write dry-run contract',
            true,
          );
        }

        latestPlan =
          resolvedPlan;

        /**
         * The accepted verification described the pre-resolution plan, so it is
         * discarded rather than carried over. `import.inspect` re-verifies the
         * resolved plan when asked.
         */
        latestVerification =
          null;

        return success(
          action.type,
          requestId,
          {
            kind:
              'plan',
            plan:
              resolvedPlan,
          },
        );
      }

      if (
        action.type
        === 'import.commit'
      ) {
        return failure(
          action.type,
          requestId,
          'unavailable',
          'action-not-available',
          'import.commit remains unavailable while migration policy and activation gates remain open',
          true,
        );
      }

      if (
        action.type
        === 'import.plan'
      ) {
        let plan:
          LegacyImportPlan;

        try {
          plan =
            await dependencies
              .plan();
        } catch {
          return failure(
            action.type,
            requestId,
            'dependency-failure',
            'dependency-failure',
            'import.plan dependency failed',
          );
        }

        if (
          !isAcceptedDryRunPlan(
            plan,
          )
        ) {
          return failure(
            action.type,
            requestId,
            'invalid-evidence',
            'invalid-evidence',
            'import.plan dependency returned evidence outside the accepted zero-write dry-run contract',
          );
        }

        latestPlan =
          plan;

        latestVerification =
          null;

        return success(
          action.type,
          requestId,
          {
            kind:
              'plan',
            plan,
          },
        );
      }

      if (
        latestPlan
        === null
      ) {
        return failure(
          action.type,
          requestId,
          'unavailable',
          'action-not-available',
          'import.inspect needs an accepted import.plan result first',
          true,
        );
      }

      let verification:
        LegacyImportVerificationResult;

      try {
        verification =
          await dependencies
            .inspect(
              latestPlan,
            );
      } catch {
        return failure(
          action.type,
          requestId,
          'dependency-failure',
          'dependency-failure',
          'import.inspect dependency failed',
        );
      }

      if (
        !isAcceptedVerification(
          latestPlan,
          verification,
        )
      ) {
        return failure(
          action.type,
          requestId,
          'invalid-evidence',
          'invalid-evidence',
          'import.inspect dependency returned evidence outside the accepted read-only verification contract',
          true,
        );
      }

      latestVerification =
        verification;

      return success(
        action.type,
        requestId,
        {
          kind:
            'inspection',
          verification,
        },
      );
    },
  };
}
