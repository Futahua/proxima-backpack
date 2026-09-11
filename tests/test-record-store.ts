/**
 * The smallest honest record-file backend: names in a map, revisions by write count.
 *
 * Shared by the tests that need a real store rather than a hand-written observation list, so
 * that "the store's boundary" means the same thing in each of them. It implements the port
 * exactly — list, read, create-if-absent, write-if-unchanged, delete-if-unchanged — and
 * refuses stale writes rather than accepting them, because a backend that cannot be stale
 * would make a concurrency test meaningless.
 */
import type { RecordStoreFileBackend, RecordStoreFileMutationResult, RecordStoreFileName } from '../src/ports/recordStore.js';

export class MemoryRecordFiles implements RecordStoreFileBackend {
  private readonly files = new Map<string, { text: string; revision: number }>();

  async listRecordFiles(): Promise<readonly string[]> {
    return [...this.files.keys()].sort();
  }

  async readRecordFile(fileName: RecordStoreFileName) {
    const file = this.files.get(fileName);
    return file === undefined ? undefined : { text: file.text, revision: `${fileName}@${file.revision}` };
  }

  async createRecordFile(fileName: RecordStoreFileName, text: string): Promise<RecordStoreFileMutationResult> {
    if (this.files.has(fileName)) return { ok: false, reason: 'already-exists' };
    this.files.set(fileName, { text, revision: 1 });
    return { ok: true, revision: `${fileName}@1` };
  }

  async writeRecordFileIfUnchanged(fileName: RecordStoreFileName, text: string, expectedRevision: string): Promise<RecordStoreFileMutationResult> {
    const file = this.files.get(fileName);
    if (file === undefined) return { ok: false, reason: 'missing' };
    const current = `${fileName}@${file.revision}`;
    if (current !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: current };
    file.text = text;
    file.revision += 1;
    return { ok: true, revision: `${fileName}@${file.revision}` };
  }

  async deleteRecordFileIfUnchanged(fileName: RecordStoreFileName, expectedRevision: string): Promise<RecordStoreFileMutationResult> {
    const file = this.files.get(fileName);
    if (file === undefined) return { ok: false, reason: 'missing' };
    const current = `${fileName}@${file.revision}`;
    if (current !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: current };
    this.files.delete(fileName);
    return { ok: true, revision: current };
  }

  /** How many record files the backend holds, for a test that means "nothing was written". */
  get size(): number {
    return this.files.size;
  }
}
