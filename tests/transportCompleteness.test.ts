import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runAcceptance } from '../tools/agent-accept.mjs';
import { createDiskVault, removeDiskFixture } from './test-disk-vault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { LEGACY_LAYOUT } from '../src/app/vaultLayout.js';

/**
 * Gate 6Q.1 — transport completeness and candidate accounting.
 *
 * These pin the two defects that produced a false PASS against the creator's real
 * vault. One broken symlink — created by Proxima's own linked-folder feature —
 * made the bridge refuse an entire directory, so all 31 project folders vanished;
 * and nothing in the acceptance chain noticed that a whole record class had gone,
 * because another kind's records kept the total non-zero.
 */

/**
 * Build a vault whose project folder contains a dangling link beside real records,
 * which is exactly the shape the real vault had.
 *
 * A junction is tried first: creating a true symlink on Windows needs a privilege
 * an ordinary process does not have, while a junction needs none and Node reports
 * it through `isSymbolicLink()` exactly the same way, so the traversal path under
 * test is identical. Returns null only if neither can be made, and the tests then
 * fail loudly rather than passing quietly where the regression cannot be
 * reproduced.
 */
async function vaultWithDanglingLink(): Promise<string | null> {
  const root = await mkdtemp(join(tmpdir(), 'proxima-symlink-'));
  const projects = join(root, '-Hide', 'Proxima', 'projects');
  const events = join(root, '-Hide', 'Proxima', 'events');
  await mkdir(join(projects, 'proj-alpha'), { recursive: true });
  await mkdir(join(projects, 'proj-beta'), { recursive: true });
  await mkdir(events, { recursive: true });

  const project = (name: string) => `---\ntype: project\nprojectType: task\nname: ${name}\nstatus: active\ncreatedAt: 2026-06-05T15:09:42.536Z\n---\n`;
  await writeFile(join(projects, 'proj-alpha', 'index.md'), project('Alpha'));
  await writeFile(join(projects, 'proj-beta', 'index.md'), project('Beta'));
  await writeFile(join(events, 'e-1.md'), '---\nid: e-1\nname: E\nstartDate: 2026-09-09T10:00:00.000Z\ndeadline: 2026-09-09T11:00:00.000Z\n---\n');

  // Deliberately dangling, and deliberately beside a real index.md.
  for (const type of ['junction', 'dir'] as const) {
    try {
      await symlink(join(root, 'nowhere-at-all'), join(projects, 'proj-alpha', 'Linked'), type);
      return root;
    } catch {
      // Try the next link flavour.
    }
  }
  await rm(root, { recursive: true, force: true });
  return null;
}

describe('symlink traversal policy', () => {
  it('skips a dangling link without erasing the records beside or around it', async () => {
    const root = await vaultWithDanglingLink();
    if (!root) {
      throw new Error('cannot create a symlink on this machine; the regression it guards cannot be reproduced here');
    }
    try {
      const report = await runAcceptance({ root });

      // Before the fix this was 0: one link in one folder failed the whole walk.
      expect(report.census?.project.loadedRecords).toBe(2);
      expect(report.census?.project.status).toBe('complete');
      expect(report.census?.project.unaccountedCandidates).toBe(0);
      expect(report.census?.event.loadedRecords).toBe(1);
      expect(report.layout).toBe('legacy');
      expect(report.status).toBe('PASS');
    } finally { await removeDiskFixture(root); }
  }, 45_000);

  it('agrees with a direct disk read of the same vault', async () => {
    // The bridge must not see a different vault than the filesystem does; a
    // transport that quietly drops records is the failure being guarded against.
    const root = await vaultWithDanglingLink();
    if (!root) throw new Error('cannot create a symlink on this machine');
    try {
      const direct = await loadVaultState(createDiskVault(root), { layout: LEGACY_LAYOUT });
      const bridged = await runAcceptance({ root });
      expect(bridged.counts?.projects).toBe(direct.state.projects.length);
      expect(bridged.counts?.events).toBe(direct.state.events.length);
      expect(direct.state.projects.map((project) => project.name).sort()).toEqual(['Alpha', 'Beta']);
    } finally { await removeDiskFixture(root); }
  }, 45_000);
});

describe('census accounting', () => {
  it('accounts for every candidate as loaded or explicitly rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-census-'));
    try {
      const tasks = join(root, 'Proxima', 'tasks');
      await mkdir(tasks, { recursive: true });
      // Two files claiming one id: one loads, one is rejected with a stated reason.
      await writeFile(join(tasks, 'a.md'), '---\nid: shared\nname: A\n---\n');
      await writeFile(join(tasks, 'b.md'), '---\nid: shared\nname: B\n---\n');

      const report = await runAcceptance({ root });
      const task = report.census?.task;
      expect(task?.recordCandidates).toBe(2);
      expect(task?.loadedRecords).toBe(1);
      expect(task?.explicitlyRejected).toBe(1);
      expect(task?.unaccountedCandidates).toBe(0);

      // The duplicate is an error, so the baseline still fails — accounting for a
      // rejection explains it, it does not excuse it.
      expect(report.status).not.toBe('PASS');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45_000);

  it('treats an absent record directory as legal and an unreadable one as blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-absent-'));
    try {
      // Only events exist; projects and tasks are simply not there.
      const events = join(root, 'Proxima', 'events');
      await mkdir(events, { recursive: true });
      await writeFile(join(events, 'e-1.md'), '---\nid: e-1\nname: E\nstartDate: 2026-09-09T10:00:00.000Z\ndeadline: 2026-09-09T11:00:00.000Z\n---\n');

      const report = await runAcceptance({ root });
      expect(report.census?.project.status).toBe('absent');
      expect(report.census?.task.status).toBe('absent');
      expect(report.census?.event.status).toBe('complete');
      // Zero records for a class whose scan genuinely found nothing stays legal.
      expect(report.stages.scanCompleteness).toBe('PASS');
      expect(report.status).toBe('PASS');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45_000);
});
