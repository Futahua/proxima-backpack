/**
 * Evidence that a committed write changed exactly what it declared, and nothing else.
 *
 * Gate 14 asks for proof rather than assurance: "Evidence proves no unrelated bytes changed". The
 * proof is a disposable vault, the real conditional writer, and the project's own whole-tree
 * fingerprint taken before and after — the same implementation the zero-write acceptance uses, so
 * there is one definition of "what changed" rather than two that can disagree.
 *
 * The subtlety worth stating is *where* the fingerprint hashes bytes rather than size and mtime.
 * Only the record directories Proxima parses get content hashes, because a real vault is mostly
 * binaries and hashing all of it is slow and hostile to the binaries. That leaves an obvious hole: a
 * same-size edit that also preserves the timestamp would look unchanged. One case below closes it
 * deliberately - it writes the same number of bytes and then puts the original mtime back, so size
 * and mtime are identical and only the content hash can notice. If the hashing ever regressed to
 * `size:mtime`, that case goes red instead of quietly passing.
 */
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyFixtureToDisk, createDiskVault, removeDiskFixture } from './test-disk-vault.js';
import { changedPaths, fingerprint } from './zero-write-witness.js';
import { fingerprint as fingerprintWithOptions } from '../tools/tree-fingerprint.mjs';

/**
 * The same sweep with every region reduced to size and mtime — the cheap fingerprint a caller gets
 * when nothing is worth hashing. It exists in this file to be the control: a case that catches an
 * edit the loose sweep also catches proves nothing about hashing.
 */
function looseFingerprint(root: string): Promise<Map<string, string>> {
  return fingerprintWithOptions(root, { contentRoots: [] }) as Promise<Map<string, string>>;
}

/** The record whose contents one case edits in place, named once so the edit cannot drift from it. */
const ALPHA = '{"id":"alpha","name":"Alpha","revision":1}';

const FIXTURE: Record<string, string> = {
  'Proxima/records/tasks/alpha.md': ALPHA,
  'Proxima/records/tasks/beta.md': '{"id":"beta","name":"Beta","revision":1}',
  'Proxima/records/events/kickoff.md': '{"id":"kickoff","name":"Kickoff","revision":1}',
  'attachments/probe.bin': 'not-a-record',
};

const roots: string[] = [];

async function disposableVault(): Promise<{ root: string; vault: ReturnType<typeof createDiskVault> }> {
  const root = await mkdtemp(join(tmpdir(), 'proxima-after-image-'));
  roots.push(root);
  await copyFixtureToDisk(FIXTURE, root);
  return { root, vault: createDiskVault(root) };
}

/** Every file in the fixture, as bytes, so "unchanged" is a statement about content. */
async function bytesOf(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of Object.keys(FIXTURE)) {
    result[path] = Buffer.from(await readFile(join(root, path))).toString('base64');
  }
  return result;
}

afterAll(async () => {
  for (const root of roots) await removeDiskFixture(root);
});

describe('the after-image of a write', () => {
  it('changes exactly the file it declared, and nothing else in the tree', async () => {
    const { root, vault } = await disposableVault();
    const before = await fingerprint(root);
    const beforeBytes = await bytesOf(root);

    const current = await vault.read('Proxima/records/tasks/alpha.md');
    const written = await vault.writeIfUnchanged(
      'Proxima/records/tasks/alpha.md',
      new TextEncoder().encode('{"id":"alpha","name":"Alpha renamed","revision":2}'),
      current.revision,
    );
    expect(written.ok).toBe(true);

    const after = await fingerprint(root);
    // The whole claim in one assertion: the delta is the declared write, no more and no less.
    expect(changedPaths(before, after)).toEqual(['Proxima/records/tasks/alpha.md']);

    // And the same claim about bytes rather than about a fingerprint.
    const afterBytes = await bytesOf(root);
    expect(afterBytes['Proxima/records/tasks/alpha.md']).not.toBe(beforeBytes['Proxima/records/tasks/alpha.md']);
    for (const path of Object.keys(FIXTURE)) {
      if (path === 'Proxima/records/tasks/alpha.md') continue;
      expect(afterBytes[path]).toBe(beforeBytes[path]);
    }
  });

  it('subtracts exactly the writes a caller declared', async () => {
    const { root, vault } = await disposableVault();
    const before = await fingerprint(root);

    const alpha = await vault.read('Proxima/records/tasks/alpha.md');
    await vault.writeIfUnchanged('Proxima/records/tasks/alpha.md', new TextEncoder().encode('{"id":"alpha","revision":2}'), alpha.revision);
    const created = await vault.createIfAbsent('Proxima/records/tasks/gamma.md', new TextEncoder().encode('{"id":"gamma","revision":1}'));
    expect(created.ok).toBe(true);

    const declared = ['Proxima/records/tasks/alpha.md', 'Proxima/records/tasks/gamma.md'];
    const after = await fingerprint(root);
    const remaining = changedPaths(before, after).filter((path) => !declared.includes(path));
    expect(remaining).toEqual([]);
    expect(changedPaths(before, after)).toEqual(declared);
  });

  it('leaves the tree byte-identical when the write is refused', async () => {
    const { root, vault } = await disposableVault();
    const before = await fingerprint(root);
    const beforeBytes = await bytesOf(root);

    // A revision that is not the record's: exactly what a lost race looks like at this boundary.
    const refusal = await vault.writeIfUnchanged(
      'Proxima/records/tasks/beta.md',
      new TextEncoder().encode('{"id":"beta","name":"Beta","revision":2}'),
      'the-revision-this-caller-read-before-someone-else-wrote',
    );

    expect(refusal).toMatchObject({ ok: false, reason: 'stale' });
    if (refusal.ok) throw new Error('unreachable');
    // The refusal is attributable: it names the revision that beat the caller, so a surface can say
    // what happened rather than only that something did.
    const current = await vault.read('Proxima/records/tasks/beta.md');
    expect(refusal.actualRevision).toBe(current.revision);
    expect(refusal.actualRevision).not.toBe('the-revision-this-caller-read-before-someone-else-wrote');

    const after = await fingerprint(root);
    expect(changedPaths(before, after)).toEqual([]);
    expect(await bytesOf(root)).toEqual(beforeBytes);
  });

  it('notices a same-size edit by its content rather than by its size', async () => {
    const { root } = await disposableVault();
    const target = join(root, 'Proxima/records/tasks/alpha.md');
    const path = 'Proxima/records/tasks/alpha.md';

    // The clock is normalised first so that it can be handed back *exactly*: `utimes` cannot restore
    // sub-millisecond precision (a first attempt left 1789222903471 against the original
    // 1789222903471.0327), and a case that cannot stand the clock still proves nothing about hashing.
    // A whole-second mtime survives the round trip, which is what makes the pair below decisive.
    const coarse = new Date(Math.floor((await stat(target)).mtimeMs / 1000) * 1000);
    await utimes(target, coarse, coarse);
    const metadata = await stat(target);
    const before = await fingerprint(root);
    // The same tree, swept the cheap way: size and mtime only, with no content-hashed region.
    const looseBefore = await looseFingerprint(root);

    const original = ALPHA;
    const edited = original.replace('"Alpha"', '"Alphi"');
    expect(edited.length).toBe(original.length);
    await writeFile(target, edited, 'utf8');
    await utimes(target, metadata.atime, metadata.mtime);

    const restored = await stat(target);
    expect(restored.size).toBe(metadata.size);
    expect(restored.mtimeMs).toBe(metadata.mtimeMs);

    // Decisive pair: identical size, identical timestamp, one sweep blind and one not.
    expect(changedPaths(looseBefore, await looseFingerprint(root))).toEqual([]);
    const after = await fingerprint(root);
    expect(changedPaths(before, after)).toEqual([path]);
    // And stated as the mechanism: the size component agrees, the content hash does not.
    const [beforeSize, beforeHash] = (before.get(path) as string).split(':');
    const [afterSize, afterHash] = (after.get(path) as string).split(':');
    expect(afterSize).toBe(beforeSize);
    expect(afterHash).not.toBe(beforeHash);
  });
});
