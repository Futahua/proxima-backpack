import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  recordMutationRecoveryActionFailure,
} from '../src/app/actionProtocol.js';
import {
  createRecordRecoveryBlockedInspection,
  isRecordRecoveryBlockedInspection,
} from '../src/app/inspection.js';
import {
  createRecordMutationCoordinator,
} from '../src/app/recordMutation.js';
import {
  startRecordMutationAuthority,
} from '../src/app/recordRecoveryStartup.js';
import type {
  StartupRecoveryStore,
} from '../src/app/ownerRecoveryStartup.js';
import type {
  RecoveryRecord,
  RecoveryStore,
} from '../src/app/vaultRecovery.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileMutationResult,
  RecordStoreFileName,
} from '../src/ports/recordStore.js';

const RECORD_FILE = (
  'pxr_00000000000000000000000000000001.json'
) as RecordStoreFileName;

const RECORD_ID =
  'pxr_00000000000000000000000000000001';

function unexpectedMutationResult():
RecordStoreFileMutationResult {
  throw new Error(
    'unexpected record mutation',
  );
}

describe(
  'Stage 7 slice 11 machine-readable record recovery disclosure',
  () => {
    it(
      'projects an actual recovery-required record mutation into the existing typed ActionFailure seam without exposing the storage target',
      async () => {
        const backend:
          RecordStoreFileBackend = {
            async listRecordFiles() {
              return [
                RECORD_FILE,
              ];
            },

            async readRecordFile(
              fileName,
            ) {
              expect(fileName)
                .toBe(
                  RECORD_FILE,
                );

              return {
                text: 'old',
                revision:
                  'record-r1',
              };
            },

            async createRecordFile() {
              return unexpectedMutationResult();
            },

            async writeRecordFileIfUnchanged(
              fileName,
              text,
              expectedRevision,
            ) {
              expect(fileName)
                .toBe(
                  RECORD_FILE,
                );
              expect(text)
                .toBe('new');
              expect(
                expectedRevision,
              ).toBe(
                'record-r1',
              );

              return {
                ok: true,
                revision:
                  'record-r2',
              };
            },

            async deleteRecordFileIfUnchanged() {
              return unexpectedMutationResult();
            },
          };

        const recovery:
          RecoveryStore = {
            async save() {},

            async markCommitted() {
              throw new Error(
                'journal finalization failed',
              );
            },

            async updateStatus() {
              return true;
            },

            list() {
              return [];
            },
          };

        const mutation =
          await createRecordMutationCoordinator({
            backend,
            recovery,
          }).execute({
            kind: 'update',
            fileName:
              RECORD_FILE,
            text: 'new',
            expectedRevision:
              'record-r1',
            requestId:
              'request-agent-recovery',
          });

        expect(mutation)
          .toEqual({
            ok: false,
            requestId:
              'request-agent-recovery',
            kind: 'update',
            fileName:
              RECORD_FILE,
            reason:
              'recovery-required',
          });

        const disclosed =
          recordMutationRecoveryActionFailure({
            actionType:
              'task.execution.move',
            stateRevision: 12,
            entityIds: [
              RECORD_ID,
            ],
            result:
              mutation,
          });

        expect(disclosed)
          .toEqual({
            schemaVersion: 4,
            ok: false,
            actionType:
              'task.execution.move',
            category:
              'record-mutation',
            outcome:
              'recovery-required',
            stateRevision: 12,
            requestId:
              'request-agent-recovery',
            entityIds: [
              RECORD_ID,
            ],
            error: {
              code:
                'recovery-required',
              message:
                'record mutation requires recovery reconciliation',
            },
          });

        const serialized =
          JSON.stringify(
            disclosed,
          );

        expect(serialized)
          .not
          .toContain(
            RECORD_FILE,
          );
        expect(serialized)
          .not
          .toContain(
            'fileName',
          );
        expect(serialized)
          .not
          .toContain(
            'D:/',
          );
      },
    );

    it(
      'projects an actual blocked startup result into a bounded pathless inspection with a stable blocked code',
      async () => {
        const blockedRecord:
          RecoveryRecord = {
            requestId:
              'startup-blocked-request',
            operation:
              'update',
            path:
              RECORD_FILE,
            revision:
              'record-r1',
            bytes:
              new TextEncoder()
                .encode(
                  'old',
                ),
            nextBytes:
              new TextEncoder()
                .encode(
                  'new',
                ),
            createdAt:
              '2026-09-11T09:00:00.000Z',
            status:
              'blocked',
          };

        const recovery:
          StartupRecoveryStore = {
            async load() {},

            async save() {
              throw new Error(
                'unexpected recovery write',
              );
            },

            async updateStatus() {
              throw new Error(
                'unexpected recovery status write',
              );
            },

            list() {
              return [
                blockedRecord,
              ];
            },
          };

        const backend:
          RecordStoreFileBackend = {
            async listRecordFiles() {
              throw new Error(
                'unexpected record access',
              );
            },

            async readRecordFile() {
              throw new Error(
                'unexpected record access',
              );
            },

            async createRecordFile() {
              return unexpectedMutationResult();
            },

            async writeRecordFileIfUnchanged() {
              return unexpectedMutationResult();
            },

            async deleteRecordFileIfUnchanged() {
              return unexpectedMutationResult();
            },
          };

        const startup =
          await startRecordMutationAuthority({
            backend,
            recovery,
          });

        expect(startup)
          .toEqual({
            mutationAuthority:
              'blocked',
            outcomes: [
              {
                requestId:
                  'startup-blocked-request',
                classification:
                  'conflict',
                status:
                  'blocked',
                reason:
                  'journal already blocked',
              },
            ],
            unresolved: 0,
            reason:
              'blocked recovery record requires explicit resolution',
          });

        if (
          startup.mutationAuthority
          !== 'blocked'
        ) {
          throw new Error(
            'expected blocked startup',
          );
        }

        const inspection =
          createRecordRecoveryBlockedInspection(
            startup,
          );

        expect(inspection)
          .toEqual({
            schemaVersion: 1,
            code:
              'record-recovery-blocked',
            mutationAuthority:
              'blocked',
            unresolved: 0,
            reason:
              'blocked recovery record requires explicit resolution',
            outcomes: [
              {
                requestId:
                  'startup-blocked-request',
                classification:
                  'conflict',
                status:
                  'blocked',
                reason:
                  'journal already blocked',
              },
            ],
          });

        expect(
          isRecordRecoveryBlockedInspection(
            inspection,
          ),
        ).toBe(true);

        expect(
          isRecordRecoveryBlockedInspection({
            ...inspection,
            code: 'blocked',
          }),
        ).toBe(false);

        const serialized =
          JSON.stringify(
            inspection,
          );

        expect(serialized)
          .not
          .toContain(
            RECORD_FILE,
          );
        expect(serialized)
          .not
          .toContain(
            'path',
          );
        expect(serialized)
          .not
          .toContain(
            'D:/',
          );
      },
    );
  },
);
