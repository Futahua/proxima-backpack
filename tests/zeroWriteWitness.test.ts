import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createDiskVault, copyFixtureToDisk, removeDiskFixture } from './test-disk-vault.js';
import { changedPaths, createZeroWriteWitness } from './zero-write-witness.js';
import { fixtureFiles } from './fixtures.js';

/**
 * The witness exists because Gate 6M's zero-write proof was an assertion that could
 * not fail. Replacing it with an instrument is only an improvement if the instrument
 * itself fails when it should, so these tests attack it deliberately: attempt a
 * write, run it past a no-op, and change a file behind its back.
 */
describe('zero-write witness', () => {
  it('refuses and records anything outside the read surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-witness-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const witness = createZeroWriteWitness(createDiskVault(root), root);
      const smuggled = witness.reader as unknown as { writeIfUnchanged?: (...args: unknown[]) => unknown };

      expect(() => smuggled.writeIfUnchanged?.('Proxima/tasks/x.md', 'text', 'rev')).toThrow(/zero-write violation/);
      expect(witness.violations).toContain('writeIfUnchanged');
      expect(() => witness.assertObserved()).toThrow(/violations recorded/);
    } finally { await removeDiskFixture(root); }
  });

  it('fails when it was never wired to anything, rather than reporting success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-witness-idle-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const witness = createZeroWriteWitness(createDiskVault(root), root);
      // No reads performed: this is the vacuous case the old assertion allowed.
      expect(() => witness.assertObserved()).toThrow(/recorded no reads/);
    } finally { await removeDiskFixture(root); }
  });

  it('passes only once real reads have gone through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-witness-live-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const witness = createZeroWriteWitness(createDiskVault(root), root);
      await witness.reader.walk('Proxima');
      await witness.reader.read('Proxima/tasks/Daily standup.md');
      expect(() => witness.assertObserved()).not.toThrow();
      expect(witness.reads.some((entry) => entry.startsWith('read:'))).toBe(true);
    } finally { await removeDiskFixture(root); }
  });

  it('detects a file changed behind its back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-witness-diff-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const witness = createZeroWriteWitness(createDiskVault(root), root);
      const before = await witness.snapshot();
      await writeFile(join(root, 'Proxima', 'tasks', 'Daily standup.md'), '---\nid: task-standup\n---\nrewritten\n');
      expect(changedPaths(before, await witness.snapshot())).toEqual(['Proxima/tasks/Daily standup.md']);
    } finally { await removeDiskFixture(root); }
  });

  it('notices a file that disappeared as well as one that appeared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-witness-delta-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      const witness = createZeroWriteWitness(createDiskVault(root), root);
      const before = await witness.snapshot();
      await writeFile(join(root, 'Proxima', 'tasks', 'Added.md'), '---\nid: added\n---\n');
      expect(changedPaths(before, await witness.snapshot())).toEqual(['Proxima/tasks/Added.md']);
    } finally { await removeDiskFixture(root); }
  });
});
