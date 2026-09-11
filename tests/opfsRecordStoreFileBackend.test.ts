import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createBrowserOpfsRecordStoreFileBackend,
  PROXIMA_RECORD_STORE_ORIGIN,
} from '../src/adapters/opfsRecordStoreFileBackend.js';
import {
  createCanonicalJsonRecordStore,
} from '../src/app/canonicalRecordCodec.js';
import {
  RecordStoreFormatError,
} from '../src/app/jsonRecordStore.js';
import {
  opaqueRecordIdFromRandomBytes,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import type {
  RecordStoreFileName,
} from '../src/ports/recordStore.js';

function notFound(): Error {
  return Object.assign(
    new Error('not found'),
    {
      name: 'NotFoundError',
    },
  );
}

function typeMismatch(): Error {
  return Object.assign(
    new Error('type mismatch'),
    {
      name: 'TypeMismatchError',
    },
  );
}

class FakeFileHandle {
  readonly kind = 'file' as const;

  private value: string;
  private modified = 1;

  constructor(
    value = '',
  ) {
    this.value = value;
  }

  async getFile() {
    const value =
      this.value;
    const modified =
      this.modified;

    return {
      text: async () => value,
      size:
        new TextEncoder()
          .encode(value)
          .byteLength,
      lastModified: modified,
    };
  }

  async createWritable() {
    let pending = '';

    return {
      write: async (
        data: string,
      ) => {
        pending = data;
      },
      close: async () => {
        this.value = pending;
        this.modified += 1;
      },
    };
  }

  replace(
    value: string,
  ): void {
    this.value = value;
    this.modified += 1;
  }

  textValue(): string {
    return this.value;
  }
}

type FakeHandle =
  | FakeFileHandle
  | FakeDirectoryHandle;

class FakeDirectoryHandle {
  readonly kind = 'directory' as const;

  readonly children =
    new Map<string, FakeHandle>();

  async *entries():
  AsyncIterableIterator<
    [string, FakeHandle]
  > {
    for (
      const entry
      of [...this.children.entries()]
        .sort(
          ([left], [right]) =>
            left.localeCompare(right),
        )
    ) {
      yield entry;
    }
  }

  async getDirectoryHandle(
    name: string,
    options: {
      readonly create?: boolean;
    } = {},
  ): Promise<FakeDirectoryHandle> {
    const existing =
      this.children.get(name);

    if (existing) {
      if (
        existing.kind
        !== 'directory'
      ) {
        throw typeMismatch();
      }
      return existing;
    }

    if (!options.create) {
      throw notFound();
    }

    const created =
      new FakeDirectoryHandle();

    this.children.set(
      name,
      created,
    );
    return created;
  }

  async getFileHandle(
    name: string,
    options: {
      readonly create?: boolean;
    } = {},
  ): Promise<FakeFileHandle> {
    const existing =
      this.children.get(name);

    if (existing) {
      if (
        existing.kind
        !== 'file'
      ) {
        throw typeMismatch();
      }
      return existing;
    }

    if (!options.create) {
      throw notFound();
    }

    const created =
      new FakeFileHandle();

    this.children.set(
      name,
      created,
    );

    return created;
  }

  async removeEntry(
    name: string,
  ): Promise<void> {
    if (
      !this.children.delete(name)
    ) {
      throw notFound();
    }
  }

  setFile(
    name: string,
    text: string,
  ): FakeFileHandle {
    const existing =
      this.children.get(name);

    if (
      existing?.kind === 'file'
    ) {
      existing.replace(text);
      return existing;
    }

    const file =
      new FakeFileHandle(text);

    this.children.set(
      name,
      file,
    );

    return file;
  }
}

function recordId(
  value: number,
): OpaqueRecordId {
  const bytes =
    new Uint8Array(16);

  bytes[15] = value;

  return opaqueRecordIdFromRandomBytes(
    bytes,
  );
}

function recordFileName(
  id: OpaqueRecordId,
): RecordStoreFileName {
  return (
    `${id}.json`
  ) as RecordStoreFileName;
}

function installBrowserOpfs(
  root: FakeDirectoryHandle,
  href =
    `${PROXIMA_RECORD_STORE_ORIGIN}/surface`,
) {
  const getDirectory =
    vi.fn(async () => root);

  vi.stubGlobal(
    'location',
    new URL(href),
  );
  vi.stubGlobal(
    'navigator',
    {
      storage: {
        getDirectory,
      },
    },
  );

  return getDirectory;
}

async function recordsDirectory(
  root: FakeDirectoryHandle,
): Promise<FakeDirectoryHandle> {
  const store =
    await root.getDirectoryHandle(
      'record-store',
    );

  return store.getDirectoryHandle(
    'records',
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(
  'Stage 7 slice 3 browser OPFS RecordStoreFileBackend',
  () => {
    it(
      'acquires OPFS only from the accepted Backpack origin and creates only record-store/records',
      async () => {
        const root =
          new FakeDirectoryHandle();
        const getDirectory =
          installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();

        expect(
          getDirectory,
        ).toHaveBeenCalledTimes(1);

        expect(
          [...root.children.keys()],
        ).toEqual([
          'record-store',
        ]);

        const store =
          await root.getDirectoryHandle(
            'record-store',
          );

        expect(
          [...store.children.keys()],
        ).toEqual([
          'records',
        ]);
        expect(
          store.children.has(
            'recovery',
          ),
        ).toBe(false);

        expect(
          Object.keys(backend).sort(),
        ).toEqual([
          'createRecordFile',
          'deleteRecordFileIfUnchanged',
          'listRecordFiles',
          'readRecordFile',
          'writeRecordFileIfUnchanged',
        ]);
        expect(backend)
          .not
          .toHaveProperty('root');
        expect(backend)
          .not
          .toHaveProperty('recordsDirectory');
      },
    );

    it(
      'creates, reads, updates and deletes one opaque record file with changing revisions',
      async () => {
        const root =
          new FakeDirectoryHandle();
        installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();
        const name =
          recordFileName(
            recordId(1),
          );

        const created =
          await backend
            .createRecordFile(
              name,
              'first',
            );

        expect(created.ok)
          .toBe(true);

        if (!created.ok) {
          throw new Error(
            'fixture create failed',
          );
        }

        await expect(
          backend.listRecordFiles(),
        ).resolves.toEqual([
          name,
        ]);

        const first =
          await backend
            .readRecordFile(name);

        expect(first?.text)
          .toBe('first');
        expect(first?.revision)
          .toBe(created.revision);

        if (!first) {
          throw new Error(
            'fixture read failed',
          );
        }

        const updated =
          await backend
            .writeRecordFileIfUnchanged(
              name,
              'second',
              first.revision,
            );

        expect(updated.ok)
          .toBe(true);

        if (!updated.ok) {
          throw new Error(
            'fixture update failed',
          );
        }

        expect(updated.revision)
          .not
          .toBe(first.revision);
        expect(
          (
            await backend
              .readRecordFile(name)
          )?.text,
        ).toBe('second');

        const deleted =
          await backend
            .deleteRecordFileIfUnchanged(
              name,
              updated.revision,
            );

        expect(deleted.ok)
          .toBe(true);
        await expect(
          backend.readRecordFile(name),
        ).resolves.toBeUndefined();
      },
    );

    it(
      'refuses create-if-absent when the opaque record file already exists',
      async () => {
        const root =
          new FakeDirectoryHandle();
        installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();
        const name =
          recordFileName(
            recordId(2),
          );

        const first =
          await backend
            .createRecordFile(
              name,
              'first',
            );

        expect(first.ok)
          .toBe(true);

        await expect(
          backend.createRecordFile(
            name,
            'replacement',
          ),
        ).resolves.toMatchObject({
          ok: false,
          reason: 'already-exists',
          actualRevision:
            first.ok
              ? first.revision
              : undefined,
        });

        expect(
          (
            await backend
              .readRecordFile(name)
          )?.text,
        ).toBe('first');
      },
    );

    it(
      'refuses stale conditional update and delete without changing the accepted bytes',
      async () => {
        const root =
          new FakeDirectoryHandle();
        installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();
        const name =
          recordFileName(
            recordId(3),
          );

        const created =
          await backend
            .createRecordFile(
              name,
              'one',
            );

        if (!created.ok) {
          throw new Error(
            'fixture create failed',
          );
        }

        const accepted =
          await backend
            .writeRecordFileIfUnchanged(
              name,
              'two',
              created.revision,
            );

        if (!accepted.ok) {
          throw new Error(
            'fixture update failed',
          );
        }

        await expect(
          backend
            .writeRecordFileIfUnchanged(
              name,
              'stale-write',
              created.revision,
            ),
        ).resolves.toEqual({
          ok: false,
          reason: 'stale',
          actualRevision:
            accepted.revision,
        });

        await expect(
          backend
            .deleteRecordFileIfUnchanged(
              name,
              created.revision,
            ),
        ).resolves.toEqual({
          ok: false,
          reason: 'stale',
          actualRevision:
            accepted.revision,
        });

        expect(
          (
            await backend
              .readRecordFile(name)
          )?.text,
        ).toBe('two');
      },
    );

    it(
      'rejects arbitrary names and paths before they can target an OPFS entry',
      async () => {
        const root =
          new FakeDirectoryHandle();
        installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();

        const invalidNames = [
          '../escape.json',
          'D:/Creator Vault/task.json',
          'Human Task Name.json',
          'pxr_00000000000000000000000000000001.json/child',
        ] as RecordStoreFileName[];

        for (
          const invalid
          of invalidNames
        ) {
          await expect(
            backend
              .readRecordFile(
                invalid,
              ),
          ).rejects.toThrow(
            /Invalid Proxima record-store file name/,
          );
        }

        const machinePath = (
          'D:/Creator Vault/task.json'
        ) as RecordStoreFileName;

        await expect(
          backend.createRecordFile(
            machinePath,
            'no',
          ),
        ).rejects.toThrow(
          /Invalid Proxima record-store file name/,
        );

        await expect(
          backend
            .writeRecordFileIfUnchanged(
              machinePath,
              'no',
              'revision',
            ),
        ).rejects.toThrow(
          /Invalid Proxima record-store file name/,
        );

        await expect(
          backend
            .deleteRecordFileIfUnchanged(
              machinePath,
              'revision',
            ),
        ).rejects.toThrow(
          /Invalid Proxima record-store file name/,
        );

        expect(
          (
            await recordsDirectory(root)
          ).children.size,
        ).toBe(0);
      },
    );

    it(
      'is isolated to record-store/records and ignores root and reserved recovery siblings',
      async () => {
        const root =
          new FakeDirectoryHandle();
        installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();

        root.setFile(
          'outside.json',
          'outside',
        );

        const store =
          await root.getDirectoryHandle(
            'record-store',
          );
        const recovery =
          await store
            .getDirectoryHandle(
              'recovery',
              { create: true },
            );

        recovery.setFile(
          'journal.json',
          'reserved',
        );

        const records =
          await recordsDirectory(root);
        const name =
          recordFileName(
            recordId(4),
          );

        records.setFile(
          name,
          'inside',
        );

        await expect(
          backend.listRecordFiles(),
        ).resolves.toEqual([
          name,
        ]);

        expect(
          (
            await backend
              .readRecordFile(name)
          )?.text,
        ).toBe('inside');

        expect(
          root.children.get(
            'outside.json',
          ),
        ).toBeInstanceOf(
          FakeFileHandle,
        );
        expect(
          recovery.children.get(
            'journal.json',
          ),
        ).toBeInstanceOf(
          FakeFileHandle,
        );
      },
    );

    it(
      'preserves corrupt JSON and invalid canonical bytes for visible JSON/codec failure',
      async () => {
        const root =
          new FakeDirectoryHandle();
        installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();
        const id =
          recordId(5);
        const name =
          recordFileName(id);
        const records =
          await recordsDirectory(root);

        records.setFile(
          name,
          '{ definitely not json',
        );

        const store =
          createCanonicalJsonRecordStore(
            backend,
          );

        await expect(
          store.read(id),
        ).rejects.toMatchObject({
          name: 'RecordStoreFormatError',
          code: 'corrupt-json',
        } satisfies Partial<
          RecordStoreFormatError
        >);

        records.setFile(
          name,
          JSON.stringify({
            formatVersion: 1,
            record: {
              schemaVersion: 999,
              kind: 'task',
              id,
              name: 'Invalid schema',
            },
          }),
        );

        await expect(
          store.read(id),
        ).rejects.toMatchObject({
          name: 'RecordStoreFormatError',
          code: 'schema-invalid',
        } satisfies Partial<
          RecordStoreFormatError
        >);
      },
    );

    it(
      'reacquires the OPFS root when a fresh backend instance is created without passing a handle',
      async () => {
        const root =
          new FakeDirectoryHandle();
        const getDirectory =
          installBrowserOpfs(root);
        const name =
          recordFileName(
            recordId(6),
          );

        const first =
          await createBrowserOpfsRecordStoreFileBackend();

        const created =
          await first
            .createRecordFile(
              name,
              'persisted in origin root',
            );

        expect(created.ok)
          .toBe(true);

        const second =
          await createBrowserOpfsRecordStoreFileBackend();

        expect(
          getDirectory,
        ).toHaveBeenCalledTimes(2);
        expect(
          (
            await second
              .readRecordFile(name)
          )?.text,
        ).toBe(
          'persisted in origin root',
        );
      },
    );

    it(
      'does not hide an externally introduced invalid filename from the JSON RecordStore',
      async () => {
        const root =
          new FakeDirectoryHandle();
        installBrowserOpfs(root);

        const backend =
          await createBrowserOpfsRecordStoreFileBackend();
        const records =
          await recordsDirectory(root);

        records.setFile(
          'Human Task Name.json',
          '{}',
        );

        await expect(
          createCanonicalJsonRecordStore(
            backend,
          ).list(),
        ).rejects.toMatchObject({
          name: 'RecordStoreFormatError',
          code: 'invalid-file-name',
        } satisfies Partial<
          RecordStoreFormatError
        >);
      },
    );

    it(
      'refuses the backend outside the exact accepted Proxima Backpack origin before acquiring OPFS',
      async () => {
        const root =
          new FakeDirectoryHandle();
        const getDirectory =
          installBrowserOpfs(
            root,
            'https://example.com/not-proxima',
          );

        await expect(
          createBrowserOpfsRecordStoreFileBackend(),
        ).rejects.toThrow(
          /accepted Backpack origin/,
        );

        expect(
          getDirectory,
        ).not.toHaveBeenCalled();
        expect(root.children.size)
          .toBe(0);
      },
    );
  },
);
