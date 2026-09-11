import type {
  Clock,
  IdGenerator,
} from '../domain/clock.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileName,
} from '../ports/recordStore.js';
import {
  createRecordMutationCoordinator,
  type RecordMutationCoordinator,
} from './recordMutation.js';
import {
  reconcileOwnerRecoveryOnStartup,
  type StartupRecoveryOutcome,
  type StartupRecoveryStore,
} from './ownerRecoveryStartup.js';
import type {
  RecoveryReadSource,
} from './vaultRecoveryReconcile.js';

const RECORD_FILE_NAME =
  /^pxr_[0-9a-f]{32}\.json$/;

export interface RecordMutationAuthorityStartupOptions {
  readonly backend: RecordStoreFileBackend;
  readonly recovery: StartupRecoveryStore;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly maxOutcomes?: number;
}

export interface AvailableRecordMutationAuthority {
  readonly mutationAuthority: 'available';
  readonly outcomes: readonly StartupRecoveryOutcome[];
  readonly unresolved: number;
  readonly coordinator: RecordMutationCoordinator;
}

export interface BlockedRecordMutationAuthority {
  readonly mutationAuthority: 'blocked';
  readonly outcomes: readonly StartupRecoveryOutcome[];
  readonly unresolved: number;
  readonly reason: string;
}

export type RecordMutationAuthorityStartupResult =
  | AvailableRecordMutationAuthority
  | BlockedRecordMutationAuthority;

function checkedRecoveryFileName(
  path: string,
): RecordStoreFileName {
  if (!RECORD_FILE_NAME.test(path)) {
    throw new Error(
      'Invalid record recovery target.',
    );
  }

  return path as RecordStoreFileName;
}

function createRecordRecoveryReader(
  backend: RecordStoreFileBackend,
): RecoveryReadSource {
  return {
    async exists(path) {
      const fileName =
        checkedRecoveryFileName(path);

      return (
        await backend.readRecordFile(
          fileName,
        )
      ) !== undefined;
    },

    async read(path) {
      const fileName =
        checkedRecoveryFileName(path);

      const observed =
        await backend.readRecordFile(
          fileName,
        );

      if (!observed) {
        throw new Error(
          'Record disappeared during recovery classification.',
        );
      }

      return observed;
    },
  };
}

/**
 * Startup gate for future canonical record mutation authority.
 *
 * Durable recovery state is loaded and reconciled through the existing
 * recovery semantics before a RecordMutationCoordinator can be returned.
 * A load, classification, status-persistence or already-blocked recovery
 * failure returns no coordinator.
 *
 * This is infrastructure only. No semantic action is wired to this startup
 * gate by Stage 7 slice 6.
 */
export async function startRecordMutationAuthority(
  options: RecordMutationAuthorityStartupOptions,
): Promise<RecordMutationAuthorityStartupResult> {
  const recovery =
    await reconcileOwnerRecoveryOnStartup(
      options.recovery,
      createRecordRecoveryReader(
        options.backend,
      ),
      options.maxOutcomes ?? 128,
    );

  if (
    recovery.mutationAuthority
    !== 'available'
  ) {
    return {
      mutationAuthority: 'blocked',
      outcomes: recovery.outcomes,
      unresolved:
        recovery.unresolved,
      reason:
        recovery.reason
        ?? 'record recovery blocks mutation authority',
    };
  }

  return {
    mutationAuthority: 'available',
    outcomes: recovery.outcomes,
    unresolved:
      recovery.unresolved,
    coordinator:
      createRecordMutationCoordinator({
        backend:
          options.backend,
        recovery:
          options.recovery,
        clock:
          options.clock,
        ids:
          options.ids,
      }),
  };
}
