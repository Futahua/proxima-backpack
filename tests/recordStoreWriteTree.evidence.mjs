import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = join(tmpdir(), 'proxima-stage7-slice16-vault-fixtures.json');
const FIXTURE_VAULTS = ['vault-basic', 'vault-duplicates', 'vault-legacy', 'vault-malformed'];
const RECORD_FILE = 'pxr_00000000000000000000000000000001.json';
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const slash = (value) => value.split(sep).join('/');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

async function snapshotTree(root, includeMtime) {
  const rows = [];
  async function walk(absolute) {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(absolute, entry.name);
      const path = slash(relative(root, absolutePath));
      const info = await lstat(absolutePath);
      if (info.isDirectory()) { await walk(absolutePath); continue; }
      if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        rows.push({ path, kind: 'file', size: bytes.byteLength, sha256: sha256(bytes), ...(includeMtime ? { mtimeMs: info.mtimeMs } : {}) });
      } else if (info.isSymbolicLink()) {
        rows.push({ path, kind: 'symlink', target: await readlink(absolutePath), ...(includeMtime ? { mtimeMs: info.mtimeMs } : {}) });
      } else rows.push({ path, kind: 'other', ...(includeMtime ? { mtimeMs: info.mtimeMs } : {}) });
    }
  }
  await walk(root);
  return rows;
}

async function snapshotFixtureVaults() {
  const fixtures = [];
  for (const name of FIXTURE_VAULTS) {
    const root = join(REPO_ROOT, 'fixtures', name);
    assert((await lstat(root)).isDirectory(), `Missing fixture vault: ${name}`);
    fixtures.push({ name, tree: await snapshotTree(root, true) });
  }
  return fixtures;
}

function changedFixturePaths(before, after) {
  const map = (items) => new Map(items.flatMap((fixture) => fixture.tree.map((entry) => [`${fixture.name}/${entry.path}`, JSON.stringify(entry)])));
  const a = map(before); const b = map(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
}

function changedTreePaths(before, after) {
  const map = (items) => new Map(items.map((entry) => [entry.path, JSON.stringify(entry)]));
  const a = map(before); const b = map(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
}

const revisionFor = (text) => `sha256:${sha256(Buffer.from(text, 'utf8'))}`;

async function loadProductionModules() {
  const mutation = await import(new URL('../public/build/app/recordMutation.js', import.meta.url).href);
  const recovery = await import(new URL('../public/build/app/vaultRecovery.js', import.meta.url).href);
  return { createRecordMutationCoordinator: mutation.createRecordMutationCoordinator, createDurableRecoveryStore: recovery.createDurableRecoveryStore };
}

async function runDisposableWriteTreeProbe() {
  const root = await mkdtemp(join(tmpdir(), 'proxima-record-store-tree-'));
  try {
    const creatorVault = join(root, 'creator-vault');
    const creatorNotes = join(creatorVault, 'Notes');
    const creatorPlugin = join(creatorVault, '.obsidian', 'plugins', 'proxima');
    const ownedRoot = join(root, 'proxima-owned', 'record-store');
    const recordsRoot = join(ownedRoot, 'records');
    const recoveryRoot = join(ownedRoot, 'recovery');
    await mkdir(creatorNotes, { recursive: true }); await mkdir(creatorPlugin, { recursive: true });
    await mkdir(recordsRoot, { recursive: true }); await mkdir(recoveryRoot, { recursive: true });
    await writeFile(join(creatorNotes, 'creator-note.md'), '# Creator fixture\nunchanged\n', 'utf8');
    await writeFile(join(creatorPlugin, 'data.json'), '{"creatorFixture":true}\n', 'utf8');
    const recordPath = join(recordsRoot, RECORD_FILE); const journalPath = join(recoveryRoot, 'journal.json');
    await writeFile(recordPath, '{"value":"old"}', 'utf8');
    const before = await snapshotTree(root, false);
    const { createRecordMutationCoordinator, createDurableRecoveryStore } = await loadProductionModules();
    const backend = {
      async listRecordFiles() { return (await readdir(recordsRoot)).filter((name) => /^pxr_[0-9a-f]{32}\.json$/.test(name)).sort(); },
      async readRecordFile(fileName) { assert(/^pxr_[0-9a-f]{32}\.json$/.test(fileName), 'Disposable backend received an invalid record filename.'); const text = await optionalText(join(recordsRoot, fileName)); return text === undefined ? undefined : { text, revision: revisionFor(text) }; },
      async createRecordFile(fileName, text) { assert(/^pxr_[0-9a-f]{32}\.json$/.test(fileName), 'Disposable backend received an invalid record filename.'); const target = join(recordsRoot, fileName); const current = await optionalText(target); if (current !== undefined) return { ok: false, reason: 'already-exists', actualRevision: revisionFor(current) }; await writeFile(target, text, 'utf8'); return { ok: true, revision: revisionFor(text) }; },
      async writeRecordFileIfUnchanged(fileName, text, expectedRevision) { assert(/^pxr_[0-9a-f]{32}\.json$/.test(fileName), 'Disposable backend received an invalid record filename.'); const target = join(recordsRoot, fileName); const current = await optionalText(target); if (current === undefined) return { ok: false, reason: 'missing' }; const actualRevision = revisionFor(current); if (actualRevision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision }; await writeFile(target, text, 'utf8'); return { ok: true, revision: revisionFor(text) }; },
      async deleteRecordFileIfUnchanged(fileName, expectedRevision) { const target = join(recordsRoot, fileName); const current = await optionalText(target); if (current === undefined) return { ok: false, reason: 'missing' }; const actualRevision = revisionFor(current); if (actualRevision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision }; await unlink(target); return { ok: true, revision: `deleted:${actualRevision}` }; },
    };
    const recovery = createDurableRecoveryStore({ async read() { return optionalText(journalPath); }, async write(value) { await writeFile(journalPath, value, 'utf8'); } });
    const observation = await backend.readRecordFile(RECORD_FILE); assert(observation, 'Disposable record observation is missing.');
    const result = await createRecordMutationCoordinator({ backend, recovery }).execute({ kind: 'update', fileName: RECORD_FILE, text: '{"value":"new"}', expectedRevision: observation.revision, requestId: 'write-tree-confinement' });
    assert(result.ok === true, 'Disposable record mutation did not commit.');
    const after = await snapshotTree(root, false);
    const changedPaths = changedTreePaths(before, after);
    const expected = [`proxima-owned/record-store/records/${RECORD_FILE}`, 'proxima-owned/record-store/recovery/journal.json'];
    assert(JSON.stringify(changedPaths) === JSON.stringify(expected), `Unexpected disposable write tree: ${JSON.stringify(changedPaths)}`);
    assert(changedPaths.every((path) => path.startsWith('proxima-owned/record-store/')), 'A disposable record-store write escaped the Proxima-owned root.');
    const creatorBefore = before.filter((entry) => entry.path.startsWith('creator-vault/')); const creatorAfter = after.filter((entry) => entry.path.startsWith('creator-vault/'));
    assert(JSON.stringify(creatorBefore) === JSON.stringify(creatorAfter), 'Disposable creator-vault fixture changed during record-store mutation.');
    assert(await readFile(recordPath, 'utf8') === '{"value":"new"}', 'Disposable record did not retain the intended update.');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')); assert(Array.isArray(journal) && journal.length === 1 && journal[0]?.requestId === 'write-tree-confinement' && journal[0]?.status === 'committed', 'Disposable recovery journal did not finish committed.');
    return { creatorVaultFixtureUnchanged: true, changedPaths, allowedWritePrefix: 'proxima-owned/record-store/' };
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function snapshotMode() {
  const fixtures = await snapshotFixtureVaults();
  await writeFile(SNAPSHOT_PATH, JSON.stringify({ schemaVersion: 1, fixtures }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, mode: 'snapshot', fixtureVaults: FIXTURE_VAULTS }, null, 2));
}

async function verifyMode() {
  const before = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')); assert(before.schemaVersion === 1, 'Unsupported fixture snapshot schema.');
  const changedFixtures = changedFixturePaths(before.fixtures, await snapshotFixtureVaults()); assert(changedFixtures.length === 0, `Creator-vault fixtures changed during test execution: ${JSON.stringify(changedFixtures)}`);
  const probe = await runDisposableWriteTreeProbe(); await rm(SNAPSHOT_PATH, { force: true });
  console.log(JSON.stringify({ ok: true, evidence: 'record-store-write-tree-confinement', repositoryFixtureVaultsUnchanged: true, fixtureVaults: FIXTURE_VAULTS, creatorVaultFixtureUnchanged: probe.creatorVaultFixtureUnchanged, changedPaths: probe.changedPaths, allowedWritePrefix: probe.allowedWritePrefix, snapshotRemoved: true }, null, 2));
}

if (process.argv[2] === 'snapshot') await snapshotMode();
else if (process.argv[2] === 'verify') await verifyMode();
else throw new Error('Usage: node tests/recordStoreWriteTree.evidence.mjs snapshot|verify');
