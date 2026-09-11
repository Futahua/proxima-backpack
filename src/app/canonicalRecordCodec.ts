import {
  decodeCanonicalRecordV2,
  encodeCanonicalRecordV2,
  type CanonicalRecordV2,
} from '../domain/canonicalRecordV2.js';
import { createJsonRecordStore } from './jsonRecordStore.js';
import type {
  RecordStore,
  RecordStoreCodec,
  RecordStoreFileBackend,
} from '../ports/recordStore.js';

export const canonicalRecordV2Codec = {
  decode: decodeCanonicalRecordV2,
  encode: encodeCanonicalRecordV2,
} satisfies RecordStoreCodec<CanonicalRecordV2>;

/**
 * Canonical Stage 7 RecordStore boundary.
 *
 * The low-level JSON adapter remains location-agnostic; callers that mean the
 * canonical Proxima record store use this factory so canonical-domain-v2
 * validation cannot be replaced by an ad-hoc weaker codec.
 */
export function createCanonicalJsonRecordStore(
  backend: RecordStoreFileBackend,
): RecordStore<CanonicalRecordV2> {
  return createJsonRecordStore(
    backend,
    canonicalRecordV2Codec,
  );
}
