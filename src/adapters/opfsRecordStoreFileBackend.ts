import type {
  RecoveryJournalBackend,
} from '../app/vaultRecovery.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileMutationResult,
  RecordStoreFileName,
  RecordStoreFileRead,
} from '../ports/recordStore.js';

export const PROXIMA_RECORD_STORE_ORIGIN =
  'papers-backpack://bp-954ea2cd-6261-410d-baf8-0d1fbd8ca0b1';

const RECORD_STORE_DIRECTORY = 'record-store';
const RECORDS_DIRECTORY = 'records';
const RECOVERY_DIRECTORY = 'recovery';
const RECOVERY_JOURNAL_FILE = 'journal.json';
const RECORD_FILE_NAME =
  /^pxr_[0-9a-f]{32}\.json$/;

interface OpfsFileSnapshotLike {
  readonly size: number;
  readonly lastModified: number;
  text(): Promise<string>;
}

interface OpfsWritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface OpfsFileHandleLike {
  readonly kind: 'file';
  getFile(): Promise<OpfsFileSnapshotLike>;
  createWritable(): Promise<OpfsWritableLike>;
}

interface OpfsDirectoryHandleLike {
  readonly kind: 'directory';
  entries(): AsyncIterableIterator<
    [string, OpfsHandleLike]
  >;
  getDirectoryHandle(
    name: string,
    options?: {
      readonly create?: boolean;
    },
  ): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: {
      readonly create?: boolean;
    },
  ): Promise<OpfsFileHandleLike>;
  removeEntry(
    name: string,
  ): Promise<void>;
}

type OpfsHandleLike =
  | OpfsFileHandleLike
  | OpfsDirectoryHandleLike;

interface BrowserRuntimeLike {
  readonly location?: {
    readonly protocol?: string;
    readonly host?: string;
  };
  readonly navigator?: {
    readonly storage?: {
      getDirectory?: () => Promise<unknown>;
    };
  };
}

interface ExistingRecordFile
  extends RecordStoreFileRead {
  readonly handle: OpfsFileHandleLike;
}

function browserRuntime(): BrowserRuntimeLike {
  return globalThis as unknown as BrowserRuntimeLike;
}

function assertProximaBackpackOrigin(): void {
  const location =
    browserRuntime().location;
  const actual =
    `${location?.protocol ?? ''}//${location?.host ?? ''}`;

  if (
    actual
    !== PROXIMA_RECORD_STORE_ORIGIN
  ) {
    throw new Error(
      'Proxima Record Store OPFS is unavailable outside the accepted Backpack origin.',
    );
  }
}

async function acquireOpfsRoot():
Promise<OpfsDirectoryHandleLike> {
  assertProximaBackpackOrigin();

  const storage =
    browserRuntime()
      .navigator
      ?.storage;

  if (
    typeof storage?.getDirectory
    !== 'function'
  ) {
    throw new Error(
      'Proxima Record Store OPFS is unavailable.',
    );
  }

  const root =
    await storage.getDirectory();

  if (
    typeof root !== 'object'
    || root === null
    || (root as { kind?: unknown }).kind
      !== 'directory'
  ) {
    throw new Error(
      'Proxima Record Store OPFS root is invalid.',
    );
  }

  return root as OpfsDirectoryHandleLike;
}

function checkedRecordFileName(
  fileName: RecordStoreFileName,
): string {
  if (
    !RECORD_FILE_NAME.test(fileName)
  ) {
    throw new Error(
      'Invalid Proxima record-store file name.',
    );
  }

  return fileName;
}

function isNotFound(
  error: unknown,
): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && (
      error as {
        readonly name?: unknown;
      }
    ).name === 'NotFoundError'
  );
}

function hashText(
  text: string,
): string {
  let value = 2166136261;

  for (
    let index = 0;
    index < text.length;
    index += 1
  ) {
    value =
      Math.imul(
        value
          ^ text.charCodeAt(index),
        16777619,
      );
  }

  return (value >>> 0)
    .toString(16)
    .padStart(8, '0');
}

function revisionFor(
  snapshot: OpfsFileSnapshotLike,
  text: string,
): string {
  return [
    'opfs',
    snapshot.lastModified,
    snapshot.size,
    hashText(text),
  ].join(':');
}

async function readHandle(
  handle: OpfsFileHandleLike,
): Promise<RecordStoreFileRead> {
  const snapshot =
    await handle.getFile();
  const text =
    await snapshot.text();

  return {
    text,
    revision:
      revisionFor(snapshot, text),
  };
}

async function existingRecordFile(
  recordsDirectory:
    OpfsDirectoryHandleLike,
  fileName: string,
): Promise<
  ExistingRecordFile | undefined
> {
  let handle: OpfsFileHandleLike;

  try {
    handle =
      await recordsDirectory
        .getFileHandle(fileName);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const read =
    await readHandle(handle);

  return {
    handle,
    ...read,
  };
}

async function writeWholeFile(
  handle: OpfsFileHandleLike,
  text: string,
): Promise<RecordStoreFileRead> {
  const writable =
    await handle.createWritable();

  await writable.write(text);
  await writable.close();

  return readHandle(handle);
}

/**
 * Opens the creator-accepted HARD GATE B record namespace:
 *
 *   papers-backpack://bp-954ea2cd-6261-410d-baf8-0d1fbd8ca0b1
 *     OPFS/
 *       record-store/
 *         records/
 *
 * This factory still opens only `records/`. The sibling `recovery/` namespace
 * is opened only by the recovery-journal factory below. Raw OPFS handles remain
 * closure-private and never cross either injected storage seam.
 */
export async function
createBrowserOpfsRecordStoreFileBackend():
Promise<RecordStoreFileBackend> {
  const root =
    await acquireOpfsRoot();

  const recordStoreDirectory =
    await root.getDirectoryHandle(
      RECORD_STORE_DIRECTORY,
      { create: true },
    );

  const recordsDirectory =
    await recordStoreDirectory
      .getDirectoryHandle(
        RECORDS_DIRECTORY,
        { create: true },
      );

  return {
    async listRecordFiles() {
      const names: string[] = [];

      for await (
        const [name, handle]
        of recordsDirectory.entries()
      ) {
        if (handle.kind !== 'file') {
          throw new Error(
            'Unexpected non-file entry in the Proxima record-store records namespace.',
          );
        }

        /*
         * Do not silently filter an invalid external entry here. The JSON
         * RecordStore owns the visible invalid-file-name classification and
         * must be allowed to observe such a file.
         */
        names.push(name);
      }

      return names.sort(
        (left, right) =>
          left.localeCompare(right),
      );
    },

    async readRecordFile(fileName) {
      const checked =
        checkedRecordFileName(
          fileName,
        );

      const existing =
        await existingRecordFile(
          recordsDirectory,
          checked,
        );

      if (!existing) {
        return undefined;
      }

      return {
        text: existing.text,
        revision:
          existing.revision,
      };
    },

    async createRecordFile(
      fileName,
      text,
    ): Promise<
      RecordStoreFileMutationResult
    > {
      const checked =
        checkedRecordFileName(
          fileName,
        );

      const existing =
        await existingRecordFile(
          recordsDirectory,
          checked,
        );

      if (existing) {
        return {
          ok: false,
          reason: 'already-exists',
          actualRevision:
            existing.revision,
        };
      }

      const handle =
        await recordsDirectory
          .getFileHandle(
            checked,
            { create: true },
          );

      const written =
        await writeWholeFile(
          handle,
          text,
        );

      return {
        ok: true,
        revision:
          written.revision,
      };
    },

    async writeRecordFileIfUnchanged(
      fileName,
      text,
      expectedRevision,
    ): Promise<
      RecordStoreFileMutationResult
    > {
      const checked =
        checkedRecordFileName(
          fileName,
        );

      const existing =
        await existingRecordFile(
          recordsDirectory,
          checked,
        );

      if (!existing) {
        return {
          ok: false,
          reason: 'missing',
        };
      }

      if (
        existing.revision
        !== expectedRevision
      ) {
        return {
          ok: false,
          reason: 'stale',
          actualRevision:
            existing.revision,
        };
      }

      const written =
        await writeWholeFile(
          existing.handle,
          text,
        );

      return {
        ok: true,
        revision:
          written.revision,
      };
    },

    async deleteRecordFileIfUnchanged(
      fileName,
      expectedRevision,
    ): Promise<
      RecordStoreFileMutationResult
    > {
      const checked =
        checkedRecordFileName(
          fileName,
        );

      const existing =
        await existingRecordFile(
          recordsDirectory,
          checked,
        );

      if (!existing) {
        return {
          ok: false,
          reason: 'missing',
        };
      }

      if (
        existing.revision
        !== expectedRevision
      ) {
        return {
          ok: false,
          reason: 'stale',
          actualRevision:
            existing.revision,
        };
      }

      try {
        await recordsDirectory
          .removeEntry(checked);
      } catch (error) {
        if (isNotFound(error)) {
          return {
            ok: false,
            reason: 'missing',
          };
        }
        throw error;
      }

      return {
        ok: true,
        revision:
          `deleted:${existing.revision}`,
      };
    },
  };
}

/**
 * Opens only the durable recovery sibling selected by HARD GATE B:
 *
 *   record-store/
 *     recovery/
 *       journal.json
 *
 * The journal filename is fixed by Proxima. No caller supplies a directory,
 * filename, machine path, vault path or OPFS handle.
 */
export async function
createBrowserOpfsRecordRecoveryJournalBackend():
Promise<RecoveryJournalBackend> {
  const root =
    await acquireOpfsRoot();

  const recordStoreDirectory =
    await root.getDirectoryHandle(
      RECORD_STORE_DIRECTORY,
      { create: true },
    );

  const recoveryDirectory =
    await recordStoreDirectory
      .getDirectoryHandle(
        RECOVERY_DIRECTORY,
        { create: true },
      );

  return {
    async read() {
      let handle:
        OpfsFileHandleLike;

      try {
        handle =
          await recoveryDirectory
            .getFileHandle(
              RECOVERY_JOURNAL_FILE,
            );
      } catch (error) {
        if (isNotFound(error)) {
          return undefined;
        }

        throw error;
      }

      const snapshot =
        await handle.getFile();

      return snapshot.text();
    },

    async write(value) {
      const handle =
        await recoveryDirectory
          .getFileHandle(
            RECOVERY_JOURNAL_FILE,
            { create: true },
          );

      const writable =
        await handle.createWritable();

      await writable.write(value);
      await writable.close();
    },
  };
}
