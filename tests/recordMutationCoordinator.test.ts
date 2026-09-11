import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createRecordMutationCoordinator,
} from '../src/app/recordMutation.js';
import {
  createDurableRecoveryStore,
  type RecoveryJournalBackend,
  type RecoveryStore,
} from '../src/app/vaultRecovery.js';
import {
  fixedClock,
  sequentialIdGenerator,
} from '../src/domain/clock.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileMutationResult,
  RecordStoreFileName,
} from '../src/ports/recordStore.js';

const RECORD_FILE = (
  'pxr_00000000000000000000000000000001.json'
) as RecordStoreFileName;

class MemoryRecordBackend
implements RecordStoreFileBackend {
  private readonly files =
    new Map<
      string,
      {
        text: string;
        revision: string;
      }
    >();

  private nextRevision = 2;

  constructor(
    private readonly events:
      string[] = [],
  ) {}

  seed(
    fileName: RecordStoreFileName,
    text: string,
    revision = 'record-r1',
  ): void {
    this.files.set(
      fileName,
      {
        text,
        revision,
      },
    );
  }

  text(
    fileName: RecordStoreFileName,
  ): string | undefined {
    return this.files
      .get(fileName)
      ?.text;
  }

  async listRecordFiles():
  Promise<readonly string[]> {
    return [
      ...this.files.keys(),
    ].sort();
  }

  async readRecordFile(
    fileName: RecordStoreFileName,
  ) {
    this.events.push(
      'record:read',
    );

    const value =
      this.files.get(
        fileName,
      );

    return value
      ? { ...value }
      : undefined;
  }

  async createRecordFile(
    fileName: RecordStoreFileName,
    text: string,
  ): Promise<
    RecordStoreFileMutationResult
  > {
    this.events.push(
      'record:create',
    );

    const current =
      this.files.get(
        fileName,
      );

    if (current) {
      return {
        ok: false,
        reason:
          'already-exists',
        actualRevision:
          current.revision,
      };
    }

    const revision =
      this.revision();

    this.files.set(
      fileName,
      {
        text,
        revision,
      },
    );

    return {
      ok: true,
      revision,
    };
  }

  async writeRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    text: string,
    expectedRevision: string,
  ): Promise<
    RecordStoreFileMutationResult
  > {
    this.events.push(
      'record:update',
    );

    const current =
      this.files.get(
        fileName,
      );

    if (!current) {
      return {
        ok: false,
        reason: 'missing',
      };
    }

    if (
      current.revision
      !== expectedRevision
    ) {
      return {
        ok: false,
        reason: 'stale',
        actualRevision:
          current.revision,
      };
    }

    const revision =
      this.revision();

    this.files.set(
      fileName,
      {
        text,
        revision,
      },
    );

    return {
      ok: true,
      revision,
    };
  }

  async deleteRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    expectedRevision: string,
  ): Promise<
    RecordStoreFileMutationResult
  > {
    this.events.push(
      'record:delete',
    );

    const current =
      this.files.get(
        fileName,
      );

    if (!current) {
      return {
        ok: false,
        reason: 'missing',
      };
    }

    if (
      current.revision
      !== expectedRevision
    ) {
      return {
        ok: false,
        reason: 'stale',
        actualRevision:
          current.revision,
      };
    }

    this.files.delete(
      fileName,
    );

    return {
      ok: true,
      revision:
        `deleted:${current.revision}`,
    };
  }

  private revision(): string {
    return `record-r${
      this.nextRevision++
    }`;
  }
}

function durableJournal(
  events: string[] = [],
  failWrite:
    ((writeNumber: number) => boolean)
    | undefined = undefined,
): {
  backend: RecoveryJournalBackend;
  raw(): string | undefined;
} {
  let value:
    string | undefined;

  let writes = 0;

  return {
    backend: {
      async read() {
        return value;
      },

      async write(next) {
        writes += 1;

        if (
          failWrite?.(
            writes,
          )
        ) {
          throw new Error(
            'journal write failed',
          );
        }

        value = next;

        const parsed = JSON.parse(next) as Array<{ status?: string }>;

        events.push(
          `journal:${
            parsed.at(-1)
              ?.status
              ?? 'prepared'
          }`,
        );
      },
    },

    raw() {
      return value;
    },
  };
}

function coordinator(
  backend:
    RecordStoreFileBackend,
  recovery:
    RecoveryStore,
) {
  return createRecordMutationCoordinator({
    backend,
    recovery,
    clock:
      fixedClock(
        '2026-09-11T04:00:00.000Z',
      ),
    ids:
      sequentialIdGenerator(),
  });
}

function text(
  value:
    Uint8Array
    | undefined,
): string | undefined {
  return value
    ? new TextDecoder()
        .decode(value)
    : undefined;
}

describe(
  'Stage 7 slice 5 record mutation coordinator foundation',
  () => {
    it(
      'durably prepares an update before the checked record commit and marks it committed afterward',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'old',
        );

        const io =
          durableJournal(
            events,
          );

        const recovery =
          createDurableRecoveryStore(
            io.backend,
          );

        const result =
          await coordinator(
            records,
            recovery,
          ).execute({
            kind: 'update',
            fileName:
              RECORD_FILE,
            text: 'new',
            expectedRevision:
              'record-r1',
            requestId:
              'request-update-1',
          });

        expect(result)
          .toMatchObject({
            ok: true,
            requestId:
              'request-update-1',
            kind: 'update',
            fileName:
              RECORD_FILE,
          });

        expect(
          records.text(
            RECORD_FILE,
          ),
        ).toBe('new');

        expect(events)
          .toEqual([
            'record:read',
            'journal:prepared',
            'record:update',
            'journal:committed',
          ]);

        const restarted =
          createDurableRecoveryStore(
            io.backend,
          );

        await restarted.load();

        const loaded =
          restarted.list();

        expect(loaded)
          .toHaveLength(1);

        expect(loaded[0])
          .toMatchObject({
            requestId:
              'request-update-1',
            operation: 'update',
            path: RECORD_FILE,
            revision:
              'record-r1',
            createdAt:
              '2026-09-11T04:00:00.000Z',
            status:
              'committed',
          });

        expect(
          text(
            loaded[0]?.bytes,
          ),
        ).toBe('old');

        expect(
          text(
            loaded[0]?.nextBytes,
          ),
        ).toBe('new');

        expect(
          loaded[0]
            ?.priorFingerprint,
        ).toEqual({
          size: 3,
          hash:
            expect.any(String),
        });

        expect(
          loaded[0]
            ?.intendedFingerprint,
        ).toEqual({
          size: 3,
          hash:
            expect.any(String),
        });
      },
    );

    it(
      'classifies a definite stale refusal as recovered without changing record bytes',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'current',
          'record-r2',
        );

        const io =
          durableJournal(
            events,
          );

        const recovery =
          createDurableRecoveryStore(
            io.backend,
          );

        const result =
          await coordinator(
            records,
            recovery,
          ).execute({
            kind: 'update',
            fileName:
              RECORD_FILE,
            text:
              'stale-write',
            expectedRevision:
              'record-r1',
            requestId:
              'request-stale-1',
          });

        expect(result)
          .toEqual({
            ok: false,
            requestId:
              'request-stale-1',
            kind: 'update',
            fileName:
              RECORD_FILE,
            reason: 'stale',
            actualRevision:
              'record-r2',
          });

        expect(
          records.text(
            RECORD_FILE,
          ),
        ).toBe('current');

        expect(events)
          .toEqual([
            'record:read',
            'journal:prepared',
            'record:update',
            'journal:recovered',
          ]);

        const restarted =
          createDurableRecoveryStore(
            io.backend,
          );

        await restarted.load();

        expect(
          restarted.list()[0],
        ).toMatchObject({
          requestId:
            'request-stale-1',
          status:
            'recovered',
          revision:
            'record-r2',
        });
      },
    );

    it(
      'refuses to touch the record when durable prepared-state persistence fails',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'old',
        );

        const recovery:
          RecoveryStore = {
            async save() {
              throw new Error(
                'journal unavailable',
              );
            },

            async markCommitted() {
              return true;
            },

            async updateStatus() {
              return true;
            },

            list() {
              return [];
            },
          };

        const result =
          await coordinator(
            records,
            recovery,
          ).execute({
            kind: 'update',
            fileName:
              RECORD_FILE,
            text: 'new',
            expectedRevision:
              'record-r1',
            requestId:
              'request-prepare-failure',
          });

        expect(result)
          .toEqual({
            ok: false,
            requestId:
              'request-prepare-failure',
            kind: 'update',
            fileName:
              RECORD_FILE,
            reason:
              'recovery-required',
          });

        expect(events)
          .toEqual([
            'record:read',
          ]);

        expect(
          records.text(
            RECORD_FILE,
          ),
        ).toBe('old');
      },
    );

    it(
      'returns recovery-required when the record effect commits but committed-state persistence fails',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'old',
        );

        const io =
          durableJournal(
            events,
            (writeNumber) =>
              writeNumber === 2,
          );

        const recovery =
          createDurableRecoveryStore(
            io.backend,
          );

        const result =
          await coordinator(
            records,
            recovery,
          ).execute({
            kind: 'update',
            fileName:
              RECORD_FILE,
            text: 'new',
            expectedRevision:
              'record-r1',
            requestId:
              'request-commit-journal-failure',
          });

        expect(result)
          .toEqual({
            ok: false,
            requestId:
              'request-commit-journal-failure',
            kind: 'update',
            fileName:
              RECORD_FILE,
            reason:
              'recovery-required',
          });

        expect(
          records.text(
            RECORD_FILE,
          ),
        ).toBe('new');

        expect(events)
          .toEqual([
            'record:read',
            'journal:prepared',
            'record:update',
          ]);

        expect(
          io.raw(),
        ).toEqual(
          expect.any(String),
        );

        const restarted =
          createDurableRecoveryStore(
            io.backend,
          );

        await restarted.load();

        expect(
          restarted.list()[0],
        ).toMatchObject({
          requestId:
            'request-commit-journal-failure',
          status:
            'prepared',
          operation:
            'update',
        });
      },
    );

    it(
      'uses the same prepared then committed ordering for checked delete',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'old',
        );

        const io =
          durableJournal(
            events,
          );

        const recovery =
          createDurableRecoveryStore(
            io.backend,
          );

        const result =
          await coordinator(
            records,
            recovery,
          ).execute({
            kind: 'delete',
            fileName:
              RECORD_FILE,
            expectedRevision:
              'record-r1',
            requestId:
              'request-delete-1',
          });

        expect(result)
          .toMatchObject({
            ok: true,
            requestId:
              'request-delete-1',
            kind: 'delete',
            fileName:
              RECORD_FILE,
          });

        expect(
          records.text(
            RECORD_FILE,
          ),
        ).toBeUndefined();

        expect(events)
          .toEqual([
            'record:read',
            'journal:prepared',
            'record:delete',
            'journal:committed',
          ]);

        const restarted =
          createDurableRecoveryStore(
            io.backend,
          );

        await restarted.load();

        expect(
          restarted.list()[0],
        ).toMatchObject({
          requestId:
            'request-delete-1',
          operation: 'delete',
          path: RECORD_FILE,
          revision:
            'record-r1',
          status:
            'committed',
        });
      },
    );

    it(
      'rejects a path-shaped target before reading the record or writing recovery state',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        const recovery:
          RecoveryStore = {
            async save() {
              events.push(
                'journal:save',
              );
            },

            async markCommitted() {
              return true;
            },

            async updateStatus() {
              return true;
            },

            list() {
              return [];
            },
          };

        const invalid = (
          'D:/Creator Vault/task.json'
        ) as RecordStoreFileName;

        const result =
          await coordinator(
            records,
            recovery,
          ).execute({
            kind: 'update',
            fileName: invalid,
            text: 'no',
            expectedRevision:
              'revision',
            requestId:
              'request-invalid-path',
          });

        expect(result)
          .toEqual({
            ok: false,
            requestId:
              'request-invalid-path',
            kind: 'update',
            fileName: invalid,
            reason:
              'invalid-record-file-name',
          });

        expect(events)
          .toEqual([]);
      },
    );
  },
);
