import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RECORD_SCHEMA_VERSION,
  defineCanonicalRecordHeader,
  opaqueRecordIdFromRandomBytes,
  parseOpaqueRecordId,
  type CanonicalRecordHeader,
  type CanonicalRecordKind,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';

import {
  createJsonRecordStore,
  RecordStoreFormatError,
} from '../src/app/jsonRecordStore.js';

import type {
  RecordStoreCodec,
  RecordStoreFileBackend,
  RecordStoreFileMutationResult,
  RecordStoreFileName,
} from '../src/ports/recordStore.js';

const KINDS =
  new Set<CanonicalRecordKind>([
    'task',
    'project',
    'event',
    'schema',
    'workflow-stage',
  ]);

function recordId(
  value: number,
): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

function isRecordKind(
  value: unknown,
): value is CanonicalRecordKind {
  return typeof value === 'string'
    && KINDS.has(value as CanonicalRecordKind);
}

const headerCodec: RecordStoreCodec<CanonicalRecordHeader> = {
  encode(record) {
    return {
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      id: record.id,
      name: record.name,
    };
  },

  decode(value) {
    if (
      typeof value !== 'object'
      || value === null
    ) {
      throw new Error('record is not an object');
    }

    const item =
      value as Record<string, unknown>;

    const keys =
      Object.keys(item).sort();

    if (
      keys.length !== 4
      || keys[0] !== 'id'
      || keys[1] !== 'kind'
      || keys[2] !== 'name'
      || keys[3] !== 'schemaVersion'
    ) {
      throw new Error('unexpected record fields');
    }

    if (
      item.schemaVersion
        !== CANONICAL_RECORD_SCHEMA_VERSION
      || !isRecordKind(item.kind)
      || typeof item.id !== 'string'
      || typeof item.name !== 'string'
    ) {
      throw new Error('invalid canonical header');
    }

    return defineCanonicalRecordHeader({
      kind: item.kind,
      id: parseOpaqueRecordId(item.id),
      name: item.name,
    });
  },
};

function revision(
  value: number,
): string {
  return `memory-revision-${value}`;
}

class MemoryRecordFileBackend
implements RecordStoreFileBackend {
  private readonly files =
    new Map<
      string,
      {
        text: string;
        revision: number;
      }
    >();

  readCalls = 0;

  listRecordFiles(): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.files.keys()],
    );
  }

  readRecordFile(
    fileName: RecordStoreFileName,
  ) {
    this.readCalls += 1;
    const found =
      this.files.get(fileName);

    return Promise.resolve(
      found
        ? {
            text: found.text,
            revision:
              revision(found.revision),
          }
        : undefined,
    );
  }

  createRecordFile(
    fileName: RecordStoreFileName,
    text: string,
  ): Promise<RecordStoreFileMutationResult> {
    const existing =
      this.files.get(fileName);

    if (existing) {
      return Promise.resolve({
        ok: false,
        reason: 'already-exists',
        actualRevision:
          revision(existing.revision),
      });
    }

    this.files.set(
      fileName,
      {
        text,
        revision: 1,
      },
    );

    return Promise.resolve({
      ok: true,
      revision: revision(1),
    });
  }

  writeRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    text: string,
    expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult> {
    const existing =
      this.files.get(fileName);

    if (!existing) {
      return Promise.resolve({
        ok: false,
        reason: 'missing',
      });
    }

    const actualRevision =
      revision(existing.revision);

    if (
      actualRevision
      !== expectedRevision
    ) {
      return Promise.resolve({
        ok: false,
        reason: 'stale',
        actualRevision,
      });
    }

    const nextRevision =
      existing.revision + 1;

    this.files.set(
      fileName,
      {
        text,
        revision: nextRevision,
      },
    );

    return Promise.resolve({
      ok: true,
      revision:
        revision(nextRevision),
    });
  }

  deleteRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult> {
    const existing =
      this.files.get(fileName);

    if (!existing) {
      return Promise.resolve({
        ok: false,
        reason: 'missing',
      });
    }

    const actualRevision =
      revision(existing.revision);

    if (
      actualRevision
      !== expectedRevision
    ) {
      return Promise.resolve({
        ok: false,
        reason: 'stale',
        actualRevision,
      });
    }

    this.files.delete(fileName);

    return Promise.resolve({
      ok: true,
      revision:
        revision(
          existing.revision + 1,
        ),
    });
  }

  seed(
    fileName: string,
    text: string,
  ): void {
    this.files.set(
      fileName,
      {
        text,
        revision: 1,
      },
    );
  }

  names(): string[] {
    return [...this.files.keys()];
  }
}

function store(
  backend: MemoryRecordFileBackend,
) {
  return createJsonRecordStore(
    backend,
    headerCodec,
  );
}

function task(
  id: OpaqueRecordId,
  name: string,
): CanonicalRecordHeader<'task'> {
  return defineCanonicalRecordHeader({
    kind: 'task',
    id,
    name,
  });
}

function documentFor(
  record: unknown,
): string {
  return JSON.stringify({
    formatVersion: 1,
    record,
  });
}

describe('Stage 7 slice 1 JSON RecordStore contract', () => {
  it('creates one opaque-id JSON file and returns typed read metadata', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const records = store(backend);
    const id = recordId(1);
    const record =
      task(id, 'Human title');

    const created =
      await records.createIfAbsent(
        record,
      );

    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(
        'fixture creation failed',
      );
    }

    expect(backend.names()).toEqual([
      `${id}.json`,
    ]);
    expect(
      backend.names()[0],
    ).not.toContain('Human title');

    await expect(
      records.read(id),
    ).resolves.toEqual({
      record,
      id,
      kind: 'task',
      observedRevision:
        created.revision,
    });

    expect(records).not.toHaveProperty(
      'patch',
    );
  });

  it('refuses create-if-absent when the record already exists', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const records = store(backend);
    const id = recordId(2);
    const record =
      task(id, 'First');

    const first =
      await records.createIfAbsent(
        record,
      );
    expect(first.ok).toBe(true);

    await expect(
      records.createIfAbsent(
        task(id, 'Second'),
      ),
    ).resolves.toMatchObject({
      ok: false,
      recordId: id,
      reason: 'already-exists',
    });
  });

  it('updates only at the observed revision and returns a new revision', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const records = store(backend);
    const id = recordId(3);

    await records.createIfAbsent(
      task(id, 'Before'),
    );

    const observed =
      await records.read(id);

    if (!observed) {
      throw new Error(
        'fixture record missing',
      );
    }

    const accepted =
      await records.updateIfUnchanged(
        task(id, 'After'),
        observed.observedRevision,
      );

    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      throw new Error(
        'fixture update failed',
      );
    }

    expect(accepted.revision).not.toBe(
      observed.observedRevision,
    );

    await expect(
      records.updateIfUnchanged(
        task(id, 'Stale writer'),
        observed.observedRevision,
      ),
    ).resolves.toMatchObject({
      ok: false,
      recordId: id,
      reason: 'stale',
      actualRevision:
        accepted.revision,
    });
  });

  it('deletes only at the observed revision', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const records = store(backend);
    const id = recordId(4);

    await records.createIfAbsent(
      task(id, 'Delete me'),
    );

    const observed =
      await records.read(id);

    if (!observed) {
      throw new Error(
        'fixture record missing',
      );
    }

    await expect(
      records.deleteIfUnchanged(
        id,
        'wrong-revision',
      ),
    ).resolves.toMatchObject({
      ok: false,
      recordId: id,
      reason: 'stale',
      actualRevision:
        observed.observedRevision,
    });

    const deleted =
      await records.deleteIfUnchanged(
        id,
        observed.observedRevision,
      );

    expect(deleted.ok).toBe(true);
    await expect(
      records.read(id),
    ).resolves.toBeUndefined();
  });

  it('changes a human-facing name without renaming the physical JSON file', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const records = store(backend);
    const id = recordId(5);

    await records.createIfAbsent(
      task(id, 'Before rename'),
    );

    const observed =
      await records.read(id);

    if (!observed) {
      throw new Error(
        'fixture record missing',
      );
    }

    await records.updateIfUnchanged(
      task(
        id,
        'After: / rename ? *',
      ),
      observed.observedRevision,
    );

    expect(backend.names()).toEqual([
      `${id}.json`,
    ]);

    expect(
      (await records.read(id))
        ?.record.name,
    ).toBe(
      'After: / rename ? *',
    );
  });

  it('fails visibly on corrupt JSON', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const id = recordId(6);

    backend.seed(
      `${id}.json`,
      '{ definitely not json',
    );

    const records = store(backend);

    await expect(
      records.read(id),
    ).rejects.toMatchObject({
      name: 'RecordStoreFormatError',
      code: 'corrupt-json',
    } satisfies Partial<RecordStoreFormatError>);
  });

  it('fails visibly when the required codec rejects a record document', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const id = recordId(7);

    backend.seed(
      `${id}.json`,
      documentFor({
        schemaVersion: 999,
        kind: 'task',
        id,
        name: 'Wrong schema',
      }),
    );

    await expect(
      store(backend).read(id),
    ).rejects.toMatchObject({
      name: 'RecordStoreFormatError',
      code: 'schema-invalid',
    } satisfies Partial<RecordStoreFormatError>);
  });

  it('fails visibly when file identity and record identity disagree', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const fileId = recordId(8);
    const recordIdValue =
      recordId(9);

    backend.seed(
      `${fileId}.json`,
      documentFor(
        headerCodec.encode(
          task(
            recordIdValue,
            'Wrong identity',
          ),
        ),
      ),
    );

    await expect(
      store(backend).read(fileId),
    ).rejects.toMatchObject({
      name: 'RecordStoreFormatError',
      code: 'record-id-mismatch',
    } satisfies Partial<RecordStoreFormatError>);
  });

  it('fails visibly on an unknown file name in the record namespace', async () => {
    const backend =
      new MemoryRecordFileBackend();

    backend.seed(
      'Human Task Name.json',
      '{}',
    );

    await expect(
      store(backend).list(),
    ).rejects.toMatchObject({
      name: 'RecordStoreFormatError',
      code: 'invalid-file-name',
    } satisfies Partial<RecordStoreFormatError>);
  });

  it('rejects a creator-vault path before the backend receives a read', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const records = store(backend);
    const creatorVaultPath =
      'D:/Creator Vault/Tasks/task.md' as OpaqueRecordId;

    await expect(
      records.read(
        creatorVaultPath,
      ),
    ).rejects.toThrow(
      /Invalid opaque Proxima record id/,
    );

    expect(backend.readCalls).toBe(0);
  });

  it('can be recreated over the same supplied backend without losing the record', async () => {
    const backend =
      new MemoryRecordFileBackend();
    const id = recordId(10);

    const first = store(backend);
    await first.createIfAbsent(
      task(id, 'Persistent backend record'),
    );

    const beforeRestart =
      await first.read(id);

    const afterRestart =
      await store(backend).read(id);

    expect(afterRestart).toEqual(
      beforeRestart,
    );
  });
});
