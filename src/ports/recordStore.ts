import type {
  CanonicalRecordHeader,
  OpaqueRecordId,
} from '../domain/canonicalIdentity.js';

declare const recordStoreFileNameBrand: unique symbol;

/**
 * One opaque record-file name inside an already-authorized Proxima-owned
 * record-files namespace.
 *
 * This is deliberately not a filesystem/vault path. Physical backing location
 * remains a host concern and is unresolved while HARD GATE B is open.
 */
export type RecordStoreFileName = string & {
  readonly [recordStoreFileNameBrand]: 'RecordStoreFileName';
};

export interface RecordStoreFileRead {
  readonly text: string;
  readonly revision: string;
}

export type RecordStoreFileMutationResult =
  | {
      readonly ok: true;
      readonly revision: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'already-exists' | 'stale';
      readonly actualRevision?: string;
    };

/**
 * Lowest storage seam required by the JSON record adapter.
 *
 * It receives record file names only. No vault root, machine path or arbitrary
 * caller-selected target path crosses this boundary.
 */
export interface RecordStoreFileBackend {
  listRecordFiles(): Promise<readonly string[]>;

  readRecordFile(
    fileName: RecordStoreFileName,
  ): Promise<RecordStoreFileRead | undefined>;

  createRecordFile(
    fileName: RecordStoreFileName,
    text: string,
  ): Promise<RecordStoreFileMutationResult>;

  writeRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    text: string,
    expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult>;

  deleteRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult>;
}

/**
 * Runtime schema boundary supplied to the store.
 *
 * Stage 7 must never trust parsed JSON merely because TypeScript says it has a
 * record type. The complete canonical-v2 codec is a later Stage 7 slice; this
 * port makes validation mandatory rather than optional.
 */
export interface RecordStoreCodec<
  T extends CanonicalRecordHeader = CanonicalRecordHeader,
> {
  decode(value: unknown): T;
  encode(record: T): unknown;
}

export interface RecordStoreObservation<
  T extends CanonicalRecordHeader = CanonicalRecordHeader,
> {
  readonly record: T;
  readonly id: OpaqueRecordId;
  readonly kind: T['kind'];
  readonly observedRevision: string;
}

export type RecordStoreMutationResult =
  | {
      readonly ok: true;
      readonly recordId: OpaqueRecordId;
      readonly revision: string;
    }
  | {
      readonly ok: false;
      readonly recordId: OpaqueRecordId;
      readonly reason: 'missing' | 'already-exists' | 'stale';
      readonly actualRevision?: string;
    };

/**
 * Headless canonical-record storage API.
 *
 * There is intentionally no arbitrary JSON patch operation and no caller-
 * supplied path. Semantic application operations must eventually construct a
 * complete validated record and call this boundary through the mutation
 * coordinator.
 */
export interface RecordStore<
  T extends CanonicalRecordHeader = CanonicalRecordHeader,
> {
  list(): Promise<readonly RecordStoreObservation<T>[]>;

  read(
    id: OpaqueRecordId,
  ): Promise<RecordStoreObservation<T> | undefined>;

  createIfAbsent(
    record: T,
  ): Promise<RecordStoreMutationResult>;

  updateIfUnchanged(
    record: T,
    expectedRevision: string,
  ): Promise<RecordStoreMutationResult>;

  deleteIfUnchanged(
    id: OpaqueRecordId,
    expectedRevision: string,
  ): Promise<RecordStoreMutationResult>;
}
