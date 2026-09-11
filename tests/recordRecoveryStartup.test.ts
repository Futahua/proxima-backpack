import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  startRecordMutationAuthority,
} from '../src/app/recordRecoveryStartup.js';
import {
  createDurableRecoveryStore,
  type RecoveryJournalBackend,
  type RecoveryRecord,
} from '../src/app/vaultRecovery.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileMutationResult,
  RecordStoreFileName,
} from '../src/ports/recordStore.js';

const RECORD_FILE = (
  'pxr_00000000000000000000000000000001.json'
) as RecordStoreFileName;

function bytes(
  value: string,
): Uint8Array {
  return new TextEncoder()
    .encode(value);
}

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

  constructor(
    private readonly events:
      string[] = [],
  ) {}

  seed(
    fileName: RecordStoreFileName,
    text: string,
    revision: string,
  ): void {
    this.files.set(
      fileName,
      {
        text,
        revision,
      },
    );
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
    _fileName: RecordStoreFileName,
    _text: string,
  ): Promise<RecordStoreFileMutationResult> {
    throw new Error(
      'unexpected record create',
    );
  }

  async writeRecordFileIfUnchanged(
    _fileName: RecordStoreFileName,
    _text: string,
    _expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult> {
    throw new Error(
      'unexpected record update',
    );
  }

  async deleteRecordFileIfUnchanged(
    _fileName: RecordStoreFileName,
    _expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult> {
    throw new Error(
      'unexpected record delete',
    );
  }
}

class MemoryRecoveryJournal
implements RecoveryJournalBackend {
  private raw:
    string | undefined;

  constructor(
    private readonly events:
      string[] = [],
  ) {}

  async read():
  Promise<string | undefined> {
    this.events.push(
      'journal:read',
    );

    return this.raw;
  }

  async write(
    value: string,
  ): Promise<void> {
    this.events.push(
      'journal:write',
    );

    this.raw = value;
  }

  async seed(
    record: RecoveryRecord,
  ): Promise<void> {
    const writer =
      createDurableRecoveryStore(
        this,
      );

    await writer.save(record);

    this.events.length = 0;
  }
}

function recoveryRecord(
  requestId: string,
  status:
    | 'prepared'
    | 'recovery-required'
    | 'committed'
    | 'recovered'
    | 'blocked',
): RecoveryRecord {
  return {
    requestId,
    operation: 'update',
    path: RECORD_FILE,
    revision:
      'record-r1',
    bytes:
      bytes('old'),
    nextBytes:
      bytes('new'),
    createdAt:
      '2026-09-11T06:00:00.000Z',
    status,
  };
}

describe(
  'Stage 7 slice 6 record recovery startup authority',
  () => {
    it(
      'loads the durable journal before exposing record mutation authority',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        const journal =
          new MemoryRecoveryJournal(
            events,
          );

        const recovery =
          createDurableRecoveryStore(
            journal,
          );

        const result =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(events)
          .toEqual([
            'journal:read',
          ]);

        expect(result)
          .toMatchObject({
            mutationAuthority:
              'available',
            outcomes: [],
            unresolved: 0,
          });

        if (
          result.mutationAuthority
          !== 'available'
        ) {
          throw new Error(
            'record mutation authority unexpectedly blocked',
          );
        }

        expect(
          result.coordinator,
        ).toBeDefined();
      },
    );

    it(
      'blocks authority and exposes no coordinator when durable journal loading fails',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        const recovery =
          createDurableRecoveryStore({
            async read() {
              events.push(
                'journal:read',
              );

              throw new Error(
                'journal unavailable',
              );
            },

            async write() {
              events.push(
                'journal:write',
              );
            },
          });

        const result =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(result)
          .toEqual({
            mutationAuthority:
              'blocked',
            outcomes: [],
            unresolved: 0,
            reason:
              'journal unavailable',
          });

        expect(result)
          .not
          .toHaveProperty(
            'coordinator',
          );

        expect(events)
          .toEqual([
            'journal:read',
          ]);
      },
    );

    it(
      'loads a prepared update and classifies an already-present effect as committed before exposing authority',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'new',
          'record-r2',
        );

        const journal =
          new MemoryRecoveryJournal(
            events,
          );

        await journal.seed(
          recoveryRecord(
            'prepared-effect',
            'prepared',
          ),
        );

        const recovery =
          createDurableRecoveryStore(
            journal,
          );

        const result =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(events)
          .toEqual([
            'journal:read',
            'record:read',
            'record:read',
            'journal:write',
          ]);

        expect(result)
          .toMatchObject({
            mutationAuthority:
              'available',
            unresolved: 1,
            outcomes: [
              {
                requestId:
                  'prepared-effect',
                classification:
                  'effect-present',
                status:
                  'committed',
              },
            ],
          });

        if (
          result.mutationAuthority
          !== 'available'
        ) {
          throw new Error(
            'prepared effect unexpectedly blocked authority',
          );
        }

        expect(
          result.coordinator,
        ).toBeDefined();

        const persisted =
          createDurableRecoveryStore(
            journal,
          );

        await persisted.load();

        expect(
          persisted.list()[0],
        ).toMatchObject({
          requestId:
            'prepared-effect',
          status: 'committed',
        });
      },
    );

    it(
      'loads a recovery-required update and classifies unchanged prior bytes as recovered before exposing authority',
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
          'record-r1',
        );

        const journal =
          new MemoryRecoveryJournal(
            events,
          );

        await journal.seed(
          recoveryRecord(
            'recovery-required-no-effect',
            'recovery-required',
          ),
        );

        const recovery =
          createDurableRecoveryStore(
            journal,
          );

        const result =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(events)
          .toEqual([
            'journal:read',
            'record:read',
            'record:read',
            'journal:write',
          ]);

        expect(result)
          .toMatchObject({
            mutationAuthority:
              'available',
            unresolved: 1,
            outcomes: [
              {
                requestId:
                  'recovery-required-no-effect',
                classification:
                  'not-applied',
                status:
                  'recovered',
              },
            ],
          });

        if (
          result.mutationAuthority
          !== 'available'
        ) {
          throw new Error(
            'recovered no-effect state unexpectedly blocked authority',
          );
        }

        expect(
          result.coordinator,
        ).toBeDefined();

        const persisted =
          createDurableRecoveryStore(
            journal,
          );

        await persisted.load();

        expect(
          persisted.list()[0],
        ).toMatchObject({
          requestId:
            'recovery-required-no-effect',
          status: 'recovered',
        });
      },
    );

    it(
      'blocks instead of guessing when unresolved record bytes match neither prior nor intended state',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'peer-bytes',
          'record-r2',
        );

        const journal =
          new MemoryRecoveryJournal(
            events,
          );

        await journal.seed(
          recoveryRecord(
            'ambiguous-peer-state',
            'prepared',
          ),
        );

        const recovery =
          createDurableRecoveryStore(
            journal,
          );

        const result =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(events)
          .toEqual([
            'journal:read',
            'record:read',
            'record:read',
            'journal:write',
          ]);

        expect(result)
          .toEqual({
            mutationAuthority:
              'blocked',
            outcomes: [
              {
                requestId:
                  'ambiguous-peer-state',
                classification:
                  'conflict',
                status:
                  'blocked',
                reason:
                  'conflict',
              },
            ],
            unresolved: 1,
            reason:
              'blocked recovery record requires explicit resolution',
          });

        expect(result)
          .not
          .toHaveProperty(
            'coordinator',
          );

        const persisted =
          createDurableRecoveryStore(
            journal,
          );

        await persisted.load();

        expect(
          persisted.list()[0],
        ).toMatchObject({
          requestId:
            'ambiguous-peer-state',
          status: 'blocked',
        });

        expect(
          (
            await records
              .readRecordFile(
                RECORD_FILE,
              )
          )?.text,
        ).toBe(
          'peer-bytes',
        );
      },
    );

    it(
      'blocks instead of guessing when the durable recovery journal is corrupt',
      async () => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        const recovery =
          createDurableRecoveryStore({
            async read() {
              events.push(
                'journal:read',
              );

              return '{bad';
            },

            async write() {
              events.push(
                'journal:write',
              );
            },
          });

        const result =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(result)
          .toMatchObject({
            mutationAuthority:
              'blocked',
            outcomes: [],
            unresolved: 0,
            reason:
              expect.any(String),
          });

        expect(result)
          .not
          .toHaveProperty(
            'coordinator',
          );

        expect(events)
          .toEqual([
            'journal:read',
          ]);
      },
    );

    it.each([
      {
        status:
          'committed' as const,
        expectedAuthority:
          'available' as const,
        expectedOutcomes: [
          {
            requestId:
              'terminal-committed',
            classification:
              'already-committed',
            status:
              'already-committed',
            reason:
              'journal already committed',
          },
        ],
      },
      {
        status:
          'recovered' as const,
        expectedAuthority:
          'available' as const,
        expectedOutcomes: [],
      },
      {
        status:
          'blocked' as const,
        expectedAuthority:
          'blocked' as const,
        expectedOutcomes: [
          {
            requestId:
              'terminal-blocked',
            classification:
              'conflict',
            status:
              'blocked',
            reason:
              'journal already blocked',
          },
        ],
      },
    ])(
      'is idempotent across repeated startup for terminal $status recovery state',
      async ({
        status,
        expectedAuthority,
        expectedOutcomes,
      }) => {
        const events:
          string[] = [];

        const records =
          new MemoryRecordBackend(
            events,
          );

        records.seed(
          RECORD_FILE,
          'peer-bytes',
          'record-r9',
        );

        const journal =
          new MemoryRecoveryJournal(
            events,
          );

        await journal.seed(
          recoveryRecord(
            `terminal-${status}`,
            status,
          ),
        );

        const recovery =
          createDurableRecoveryStore(
            journal,
          );

        const first =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(events)
          .toEqual([
            'journal:read',
          ]);

        expect(
          first.mutationAuthority,
        ).toBe(
          expectedAuthority,
        );

        expect(
          first.unresolved,
        ).toBe(0);

        expect(
          first.outcomes,
        ).toEqual(
          expectedOutcomes,
        );

        expect(
          first.outcomes,
        ).toHaveLength(
          expectedOutcomes.length,
        );

        if (
          expectedAuthority
          === 'available'
        ) {
          expect(first)
            .toHaveProperty(
              'coordinator',
            );
        } else {
          expect(first)
            .not
            .toHaveProperty(
              'coordinator',
            );

          expect(first)
            .toMatchObject({
              reason:
                'blocked recovery record requires explicit resolution',
            });
        }

        events.length = 0;

        const second =
          await startRecordMutationAuthority({
            backend: records,
            recovery,
          });

        expect(events)
          .toEqual([
            'journal:read',
          ]);

        expect(
          second.mutationAuthority,
        ).toBe(
          first.mutationAuthority,
        );

        expect(
          second.unresolved,
        ).toBe(0);

        expect(
          second.outcomes,
        ).toEqual(
          expectedOutcomes,
        );

        expect(
          second.outcomes,
        ).toHaveLength(
          expectedOutcomes.length,
        );

        if (
          expectedAuthority
          === 'available'
        ) {
          expect(second)
            .toHaveProperty(
              'coordinator',
            );
        } else {
          expect(second)
            .not
            .toHaveProperty(
              'coordinator',
            );

          expect(second)
            .toMatchObject({
              reason:
                'blocked recovery record requires explicit resolution',
            });
        }

        events.length = 0;

        const persisted =
          createDurableRecoveryStore(
            journal,
          );

        await persisted.load();

        expect(events)
          .toEqual([
            'journal:read',
          ]);
      },
    );
  },
);
