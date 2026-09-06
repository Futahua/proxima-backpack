import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { evaluateTreeDelta, runAcceptance } from '../tools/agent-accept.mjs';
import { copyFixtureToDisk, removeDiskFixture } from './test-disk-vault.js';
import { fixtureFiles } from './fixtures.js';

/**
 * Gate 6P — the unattended acceptance harness.
 *
 * The harness is the thing that will be pointed at the creator's real vault with
 * nobody watching, so these tests are mostly about what it refuses to do: name the
 * root, pass without observing, or stay silent when the tree moved underneath it.
 */

async function disposableVault(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
  return root;
}

describe('Gate 6P bridge-backed acceptance harness', () => {
  it('passes against a real disposable directory and reports the transport honestly', async () => {
    const root = await disposableVault('proxima-6p-pass-');
    try {
      const report = await runAcceptance({ root });
      expect(report.status).toBe('PASS');
      expect(report.blockerCodes).toEqual([]);
      expect(report.counts?.records).toBe(13);
      expect(report.observedReads).toBeGreaterThan(0);

      // A pass here is never Papers evidence, and must say so in the result itself.
      expect(report.transport).toBe('loopback-agent-bridge');
      expect(report.papersHosted).toBe(false);
      expect(report.readOnly).toBe(true);
      expect(report.open).toContain('native-fsa-grant');
      expect(report.open).toContain('real-obsidian-coexistence');
    } finally { await removeDiskFixture(root); }
  }, 30_000);

  it('cannot pass when the witness is unwired, however clean the source is', async () => {
    // The reviewer's regression: someone constructs the witness correctly and then
    // hands the unwrapped reader to the code under test. Nothing is wrong with the
    // vault, so only the liveness check can catch it.
    const root = await disposableVault('proxima-6p-unwired-');
    try {
      const report = await runAcceptance({ root, unwireWitness: true });
      expect(report.status).not.toBe('PASS');
      expect(report.status).toBe('ABORTED');
      expect(report.blockerCodes).toContain('zero-write-witness-unwired');
      expect(report.observedReads).toBe(0);
    } finally { await removeDiskFixture(root); }
  }, 30_000);

  it('never emits the supplied root, in any field of any outcome', async () => {
    const root = await disposableVault('proxima-6p-quiet-');
    try {
      for (const options of [{ root }, { root, unwireWitness: true }]) {
        const serialised = JSON.stringify(await runAcceptance(options));
        expect(serialised).not.toContain(root);
        expect(serialised).not.toMatch(/ENOENT|scandir|[A-Za-z]:\\\\/);
      }
    } finally { await removeDiskFixture(root); }
  }, 45_000);

  it('reports a source it cannot read as a bounded blocker rather than throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-6p-empty-'));
    try {
      const report = await runAcceptance({ root });
      expect(report.status).not.toBe('PASS');
      expect(report.blockerCodes.length).toBeGreaterThan(0);
      expect(JSON.stringify(report)).not.toContain(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it('treats a file added between runs as part of the source, not as a violation', async () => {
    const root = await disposableVault('proxima-6p-mutated-');
    try {
      const report = await runAcceptance({ root });
      expect(report.status).toBe('PASS');

      // Now declare nothing while actually changing a file: the effect witness must
      // notice even though the capability witness saw only reads.
      await writeFile(join(root, 'Proxima', 'tasks', 'Injected.md'), '---\nid: injected\n---\n');
      const second = await runAcceptance({ root });
      // The new file is present before and after this second run, so it is not a
      // delta for that run — it simply becomes part of the source.
      expect(second.counts?.records).toBe(14);
    } finally { await removeDiskFixture(root); }
  }, 45_000);

  it('fails the run for an undeclared change, and attributes a rename only if both ends were declared', () => {
    const before = new Map([['a.md', '1:aaaa'], ['b.md', '2:bbbb']]);

    // Nothing declared: any movement is the code under test's fault.
    expect(evaluateTreeDelta(before, new Map([['a.md', '1:zzzz'], ['b.md', '2:bbbb']]), []).ok).toBe(false);
    expect(evaluateTreeDelta(before, new Map([['a.md', '1:zzzz'], ['b.md', '2:bbbb']]), []).unattributed).toEqual(['a.md']);

    // A rename touches two paths. Declaring only the destination must still fail —
    // this is the exact omission that slipped through before.
    const renamed = new Map([['c.md', '1:aaaa'], ['b.md', '2:bbbb']]);
    expect(evaluateTreeDelta(before, renamed, ['c.md']).unattributed).toEqual(['a.md']);
    expect(evaluateTreeDelta(before, renamed, ['c.md', 'a.md']).ok).toBe(true);

    // An unchanged tree is clean with nothing declared at all.
    expect(evaluateTreeDelta(before, new Map(before), []).ok).toBe(true);
  });

  it('requires an explicitly supplied root and never discovers one', async () => {
    await expect(runAcceptance({})).rejects.toThrow(/root is required/i);
  });
});
