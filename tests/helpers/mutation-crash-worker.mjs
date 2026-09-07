import { mkdir, readFile, stat, writeFile, unlink, rename, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createVaultMutationCoordinator } from '../../public/build/app/vaultMutation.js';
import { createDurableRecoveryStore } from '../../public/build/app/vaultRecovery.js';

const [root, operation, phase] = process.argv.slice(2);
const path = 'task.md';
const destination = 'moved.md';
const rootPath = resolve(root);
const absolute = (relative) => join(rootPath, relative);
const hash = (bytes) => {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
};
const current = async (relative) => {
  const file = absolute(relative);
  const metadata = await stat(file);
  const bytes = new Uint8Array(await readFile(file));
  return { file, bytes, revision: `${metadata.mtime.toISOString()}:${metadata.size}:${hash(bytes)}` };
};
const reader = {
  async list() { return []; },
  async walk() { return []; },
  async exists(relative) { try { await stat(absolute(relative)); return true; } catch { return false; } },
  async read(relative) {
    const item = await current(relative);
    return { path: relative, text: new TextDecoder().decode(item.bytes), size: item.bytes.byteLength, modifiedAt: (await stat(item.file)).mtime.toISOString(), revision: item.revision };
  },
  async readBinary(relative) {
    const item = await current(relative);
    return { path: relative, bytes: item.bytes, size: item.bytes.byteLength, modifiedAt: (await stat(item.file)).mtime.toISOString(), revision: item.revision };
  },
};
const writer = {
  async createIfAbsent(relative, bytes) {
    const target = absolute(relative);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    return { ok: true, revision: (await current(relative)).revision };
  },
  async writeIfUnchanged(relative, bytes, expectedRevision) {
    const before = await current(relative);
    if (before.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: before.revision };
    await writeFile(before.file, bytes);
    if (phase === 'after-commit') process.exit(17);
    return { ok: true, revision: (await current(relative)).revision };
  },
  async moveIfUnchanged(relative, targetRelative, expectedRevision) {
    const before = await current(relative);
    if (before.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: before.revision };
    try { await access(absolute(targetRelative)); return { ok: false, reason: 'destination-exists' }; } catch { /* absent */ }
    await mkdir(resolve(absolute(targetRelative), '..'), { recursive: true });
    await rename(before.file, absolute(targetRelative));
    if (phase === 'after-commit') process.exit(17);
    return { ok: true, revision: (await current(targetRelative)).revision };
  },
  async deleteIfUnchanged(relative, expectedRevision) {
    const before = await current(relative);
    if (before.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: before.revision };
    await unlink(before.file);
    if (phase === 'after-commit') process.exit(17);
    return { ok: true, revision: `${relative}@deleted` };
  },
};
const backend = {
  async read() { try { return await readFile(absolute('recovery.json'), 'utf8'); } catch { return undefined; } },
  async write(value) { await writeFile(absolute('recovery.json'), value, 'utf8'); },
};
const recovery = createDurableRecoveryStore(backend);
await recovery.load();
if (phase === 'before') {
  const originalWriter = writer.writeIfUnchanged;
  writer.writeIfUnchanged = async (...args) => { process.exit(17); return originalWriter(...args); };
  const originalDelete = writer.deleteIfUnchanged;
  writer.deleteIfUnchanged = async (...args) => { process.exit(17); return originalDelete(...args); };
  const originalMove = writer.moveIfUnchanged;
  writer.moveIfUnchanged = async (...args) => { process.exit(17); return originalMove(...args); };
}
if (phase === 'after-mark') {
  const originalMarkCommitted = recovery.markCommitted?.bind(recovery);
  recovery.markCommitted = async (...args) => { await originalMarkCommitted?.(...args); process.exit(17); };
}
const prior = await reader.read(path);
const coordinator = createVaultMutationCoordinator({ reader, writer, recovery, ids: { next: () => `crash-${operation}-${phase}` }, clock: { now: () => Date.parse('2026-09-08T00:00:00.000Z') } });
const mutation = operation === 'update'
  ? { kind: 'update', path, bytes: new TextEncoder().encode('proxima'), expectedRevision: prior.revision }
  : operation === 'delete'
    ? { kind: 'delete', path, expectedRevision: prior.revision }
    : { kind: 'move', from: path, to: destination, expectedRevision: prior.revision };
await coordinator.execute(mutation);
