import type {
  Clock,
  IdGenerator,
} from '../domain/clock.js';
import {
  randomIdGenerator,
  systemClock,
} from '../domain/clock.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileName,
} from '../ports/recordStore.js';
import type {
  RecoveryRecord,
  RecoveryStore,
} from './vaultRecovery.js';

const RECORD_FILE_NAME =
  /^pxr_[0-9a-f]{32}\.json$/;

export type RecordMutation =
  | {
      readonly kind: 'update';
      readonly fileName: RecordStoreFileName;
      readonly text: string;
      readonly expectedRevision: string;
      readonly requestId?: string;
    }
  | {
      readonly kind: 'delete';
      readonly fileName: RecordStoreFileName;
      readonly expectedRevision: string;
      readonly requestId?: string;
    };

export type RecordMutationFailureReason =
  | 'invalid-record-file-name'
  | 'missing'
  | 'already-exists'
  | 'stale'
  | 'recovery-required'
  | 'storage-failure';

export type RecordMutationOutcome =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly kind: RecordMutation['kind'];
      readonly fileName: RecordStoreFileName;
      readonly revision: string;
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly kind: RecordMutation['kind'];
      readonly fileName: RecordStoreFileName;
      readonly reason: RecordMutationFailureReason;
      readonly actualRevision?: string;
    };

export interface RecordMutationCoordinatorOptions {
  readonly backend: RecordStoreFileBackend;
  readonly recovery: RecoveryStore;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface RecordMutationCoordinator {
  execute(
    mutation: RecordMutation,
  ): Promise<RecordMutationOutcome>;
}

function fingerprint(
  bytes: Uint8Array,
): {
  size: number;
  hash: string;
} {
  let value = 2166136261;

  for (const byte of bytes) {
    value =
      Math.imul(
        value ^ byte,
        16777619,
      );
  }

  return {
    size: bytes.byteLength,
    hash:
      (value >>> 0)
        .toString(16)
        .padStart(8, '0'),
  };
}

function validRecordFileName(
  fileName: RecordStoreFileName,
): boolean {
  return RECORD_FILE_NAME.test(
    fileName,
  );
}

/**
 * Crash-durability foundation for canonical record update/delete.
 *
 * The coordinator receives only the already-pathless RecordStoreFileBackend
 * seam and a RecoveryStore. It writes a durable `prepared` record before the
 * conditional record commit and persists `committed` only after that commit
 * succeeds.
 *
 * This module does not expose semantic mutation authority. Startup loading,
 * reconciliation, process-death injection and multi-caller policy remain
 * separate Stage 7 operations.
 */
export function createRecordMutationCoordinator(
  options: RecordMutationCoordinatorOptions,
): RecordMutationCoordinator {
  const clock =
    options.clock
    ?? systemClock;

  const ids =
    options.ids
    ?? randomIdGenerator();

  async function execute(
    mutation: RecordMutation,
  ): Promise<RecordMutationOutcome> {
    const requestId =
      mutation.requestId
      ?? ids.next(
        'record-mutation',
      );

    const base = {
      requestId,
      kind: mutation.kind,
      fileName: mutation.fileName,
    } as const;

    if (
      !validRecordFileName(
        mutation.fileName,
      )
    ) {
      return {
        ...base,
        ok: false,
        reason:
          'invalid-record-file-name',
      };
    }

    let prior:
      | {
          readonly text: string;
          readonly revision: string;
        }
      | undefined;

    try {
      prior =
        await options.backend
          .readRecordFile(
            mutation.fileName,
          );
    } catch {
      return {
        ...base,
        ok: false,
        reason: 'storage-failure',
      };
    }

    if (!prior) {
      return {
        ...base,
        ok: false,
        reason: 'missing',
      };
    }

    const priorBytes =
      new TextEncoder()
        .encode(prior.text);

    const nextBytes =
      mutation.kind === 'update'
        ? new TextEncoder()
            .encode(
              mutation.text,
            )
        : undefined;

    const recoveryRecord:
      RecoveryRecord = {
        requestId,
        operation:
          mutation.kind,
        path:
          mutation.fileName,
        revision:
          prior.revision,
        bytes:
          priorBytes,
        priorFingerprint:
          fingerprint(
            priorBytes,
          ),
        ...(nextBytes
          ? {
              nextBytes,
              intendedFingerprint:
                fingerprint(
                  nextBytes,
                ),
            }
          : {}),
        createdAt:
          new Date(
            clock.now(),
          ).toISOString(),
        status: 'prepared',
      };

    try {
      await options.recovery
        .save(
          recoveryRecord,
        );
    } catch {
      return {
        ...base,
        ok: false,
        reason:
          'recovery-required',
      };
    }

    let result:
      Awaited<
        ReturnType<
          RecordStoreFileBackend[
            'writeRecordFileIfUnchanged'
          ]
        >
      >;

    try {
      result =
        mutation.kind === 'update'
          ? await options.backend
              .writeRecordFileIfUnchanged(
                mutation.fileName,
                mutation.text,
                mutation.expectedRevision,
              )
          : await options.backend
              .deleteRecordFileIfUnchanged(
                mutation.fileName,
                mutation.expectedRevision,
              );
    } catch {
      try {
        await options.recovery
          .updateStatus?.(
            requestId,
            'recovery-required',
          );
      } catch {
        // The already-durable prepared record is intentionally left unresolved.
      }

      return {
        ...base,
        ok: false,
        reason:
          'recovery-required',
      };
    }

    if (!result.ok) {
      try {
        if (
          !options.recovery
            .updateStatus
          || !(
            await options.recovery
              .updateStatus(
                requestId,
                'recovered',
              )
          )
        ) {
          throw new Error(
            'recovery record missing',
          );
        }
      } catch {
        return {
          ...base,
          ok: false,
          reason:
            'recovery-required',
          ...(result.actualRevision
            ? {
                actualRevision:
                  result.actualRevision,
              }
            : {}),
        };
      }

      return {
        ...base,
        ok: false,
        reason: result.reason,
        ...(result.actualRevision
          ? {
              actualRevision:
                result.actualRevision,
            }
          : {}),
      };
    }

    try {
      if (
        !options.recovery
          .markCommitted
        || !(
          await options.recovery
            .markCommitted(
              requestId,
            )
        )
      ) {
        throw new Error(
          'recovery record missing',
        );
      }
    } catch {
      return {
        ...base,
        ok: false,
        reason:
          'recovery-required',
      };
    }

    return {
      ...base,
      ok: true,
      revision:
        result.revision,
    };
  }

  return {
    execute,
  };
}
