import {
  CANONICAL_RECORD_SCHEMA_VERSION,
  parseOpaqueRecordId,
  type CanonicalRecordHeader,
  type OpaqueRecordId,
} from '../domain/canonicalIdentity.js';

import type {
  RecordStore,
  RecordStoreCodec,
  RecordStoreFileBackend,
  RecordStoreFileName,
  RecordStoreMutationResult,
  RecordStoreObservation,
} from '../ports/recordStore.js';

const RECORD_JSON_FORMAT_VERSION = 1 as const;
const RECORD_FILE_NAME =
  /^(pxr_[0-9a-f]{32})\.json$/;

export type RecordStoreFormatErrorCode =
  | 'invalid-file-name'
  | 'corrupt-json'
  | 'invalid-document'
  | 'schema-invalid'
  | 'record-id-mismatch'
  | 'listed-file-missing'
  | 'duplicate-record-file';

export class RecordStoreFormatError extends Error {
  readonly code: RecordStoreFormatErrorCode;

  constructor(
    code: RecordStoreFormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecordStoreFormatError';
    this.code = code;
  }
}

function recordFileName(
  id: OpaqueRecordId,
): RecordStoreFileName {
  const checked = parseOpaqueRecordId(id);
  return `${checked}.json` as RecordStoreFileName;
}

function recordIdFromFileName(
  value: string,
): OpaqueRecordId {
  const match = RECORD_FILE_NAME.exec(value);

  if (!match?.[1]) {
    throw new RecordStoreFormatError(
      'invalid-file-name',
      `Unknown Proxima record-store file name: ${value}`,
    );
  }

  return parseOpaqueRecordId(match[1]);
}

function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function decodeDocument<
  T extends CanonicalRecordHeader,
>(
  text: string,
  expectedId: OpaqueRecordId,
  codec: RecordStoreCodec<T>,
): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RecordStoreFormatError(
      'corrupt-json',
      `Corrupt JSON for canonical record ${expectedId}.`,
    );
  }

  const document = objectValue(parsed);
  if (!document) {
    throw new RecordStoreFormatError(
      'invalid-document',
      `Canonical record document ${expectedId} is not an object.`,
    );
  }

  const documentKeys = Object.keys(document).sort();
  if (
    documentKeys.length !== 2
    || documentKeys[0] !== 'formatVersion'
    || documentKeys[1] !== 'record'
    || document.formatVersion !== RECORD_JSON_FORMAT_VERSION
  ) {
    throw new RecordStoreFormatError(
      'invalid-document',
      `Canonical record document ${expectedId} has an invalid envelope.`,
    );
  }

  let record: T;

  try {
    record = codec.decode(document.record);
  } catch {
    throw new RecordStoreFormatError(
      'schema-invalid',
      `Canonical record ${expectedId} failed domain-schema validation.`,
    );
  }

  if (
    record.schemaVersion
    !== CANONICAL_RECORD_SCHEMA_VERSION
  ) {
    throw new RecordStoreFormatError(
      'schema-invalid',
      `Canonical record ${expectedId} has an unsupported schema version.`,
    );
  }

  let actualId: OpaqueRecordId;

  try {
    actualId = parseOpaqueRecordId(record.id);
  } catch {
    throw new RecordStoreFormatError(
      'schema-invalid',
      `Canonical record ${expectedId} has an invalid opaque id.`,
    );
  }

  if (actualId !== expectedId) {
    throw new RecordStoreFormatError(
      'record-id-mismatch',
      `Canonical record file ${expectedId} contains record ${actualId}.`,
    );
  }

  return record;
}

function encodeDocument<
  T extends CanonicalRecordHeader,
>(
  record: T,
  codec: RecordStoreCodec<T>,
): string {
  const id = parseOpaqueRecordId(record.id);

  let encoded: unknown;
  let validated: T;

  try {
    encoded = codec.encode(record);
    validated = codec.decode(encoded);
  } catch {
    throw new RecordStoreFormatError(
      'schema-invalid',
      `Canonical record ${id} failed domain-schema validation before write.`,
    );
  }

  if (
    validated.schemaVersion
      !== CANONICAL_RECORD_SCHEMA_VERSION
    || validated.id !== id
    || validated.kind !== record.kind
  ) {
    throw new RecordStoreFormatError(
      'schema-invalid',
      `Canonical record ${id} changed identity or schema while encoding.`,
    );
  }

  return `${JSON.stringify(
    {
      formatVersion: RECORD_JSON_FORMAT_VERSION,
      record: encoded,
    },
    null,
    2,
  )}\n`;
}

function mutationResult(
  recordId: OpaqueRecordId,
  result:
    | {
        readonly ok: true;
        readonly revision: string;
      }
    | {
        readonly ok: false;
        readonly reason:
          | 'missing'
          | 'already-exists'
          | 'stale';
        readonly actualRevision?: string;
      },
): RecordStoreMutationResult {
  if (result.ok) {
    return {
      ok: true,
      recordId,
      revision: result.revision,
    };
  }

  return {
    ok: false,
    recordId,
    reason: result.reason,
    ...(result.actualRevision
      ? { actualRevision: result.actualRevision }
      : {}),
  };
}

/**
 * JSON record-store adapter over an already-authorized backing namespace.
 *
 * The backend's physical location remains intentionally absent from this
 * adapter. HARD GATE B selects Proxima's Backpack-origin OPFS for browser
 * production while this JSON layer stays location-agnostic.
 */
export function createJsonRecordStore<
  T extends CanonicalRecordHeader,
>(
  backend: RecordStoreFileBackend,
  codec: RecordStoreCodec<T>,
): RecordStore<T> {
  return {
    async list() {
      const fileNames = await backend.listRecordFiles();
      const seen = new Set<OpaqueRecordId>();
      const observations: RecordStoreObservation<T>[] = [];

      for (const rawFileName of fileNames) {
        const id = recordIdFromFileName(rawFileName);

        if (seen.has(id)) {
          throw new RecordStoreFormatError(
            'duplicate-record-file',
            `Record-store listing contains duplicate record ${id}.`,
          );
        }
        seen.add(id);

        const fileName =
          recordFileName(id);

        const file =
          await backend.readRecordFile(fileName);

        if (!file) {
          throw new RecordStoreFormatError(
            'listed-file-missing',
            `Record-store listing named ${rawFileName} but it could not be read.`,
          );
        }

        const record =
          decodeDocument(
            file.text,
            id,
            codec,
          );

        observations.push({
          record,
          id: record.id,
          kind: record.kind,
          observedRevision: file.revision,
        });
      }

      return observations;
    },

    async read(id) {
      const checkedId =
        parseOpaqueRecordId(id);
      const file =
        await backend.readRecordFile(
          recordFileName(checkedId),
        );

      if (!file) {
        return undefined;
      }

      const record =
        decodeDocument(
          file.text,
          checkedId,
          codec,
        );

      return {
        record,
        id: record.id,
        kind: record.kind,
        observedRevision: file.revision,
      };
    },

    async createIfAbsent(record) {
      const id =
        parseOpaqueRecordId(record.id);
      const text =
        encodeDocument(record, codec);

      return mutationResult(
        id,
        await backend.createRecordFile(
          recordFileName(id),
          text,
        ),
      );
    },

    async updateIfUnchanged(
      record,
      expectedRevision,
    ) {
      const id =
        parseOpaqueRecordId(record.id);
      const text =
        encodeDocument(record, codec);

      return mutationResult(
        id,
        await backend.writeRecordFileIfUnchanged(
          recordFileName(id),
          text,
          expectedRevision,
        ),
      );
    },

    async deleteIfUnchanged(
      id,
      expectedRevision,
    ) {
      const checkedId =
        parseOpaqueRecordId(id);

      return mutationResult(
        checkedId,
        await backend.deleteRecordFileIfUnchanged(
          recordFileName(checkedId),
          expectedRevision,
        ),
      );
    },
  };
}
