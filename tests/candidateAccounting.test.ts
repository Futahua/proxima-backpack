import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import type { DirectoryPresence, VaultEntry, VaultFile, VaultReader } from '../src/ports/vault.js';

/**
 * Gate 6Q.1a — every candidate has an outcome, and absence is proved rather than
 * assumed.
 *
 * Two holes in the first accounting attempt. Rejections raised while scanning —
 * an unreadable file, a discovery veto — were counted from a problem-array snapshot
 * taken after the scan, so they were invisible and produced phantom unaccounted
 * candidates. And absence was inferred from a second failed directory operation, so
 * a permission-denied directory looked exactly like one that was not there, which
 * is the same shape as the false PASS this whole gate exists to prevent.
 */

const project = (name: string) => `---\ntype: project\nprojectType: task\nname: ${name}\nstatus: active\n---\n`;

describe('candidate outcome accounting', () => {
  it('accounts for a discovery veto raised during the scan', async () => {
    const vault = createMemoryVault({
      // `type: note` vetoes the project reading; the candidate still existed.
      'Proxima/projects/real/index.md': project('Real'),
      'Proxima/projects/vetoed/index.md': '---\ntype: note\nname: Not a project\n---\n',
    });
    const { census } = await loadVaultState(vault);
    expect(census.project.recordCandidates).toBe(2);
    expect(census.project.loadedRecords).toBe(1);
    expect(census.project.explicitlyRejected).toBe(1);
    expect(census.project.unaccountedCandidates).toBe(0);
  });

  it('accounts for a candidate that could not be read', async () => {
    const base = createMemoryVault({
      'Proxima/tasks/a.md': '---\nid: a\nname: A\n---\n',
      'Proxima/tasks/b.md': '---\nid: b\nname: B\n---\n',
    });
    const failing: VaultReader = {
      list: (directory) => base.list(directory),
      walk: (directory) => base.walk(directory),
      exists: (path) => base.exists(path),
      presence: (directory) => base.presence!(directory),
      read: async (path): Promise<VaultFile> => {
        if (path.endsWith('b.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return base.read(path);
      },
    };
    const { census } = await loadVaultState(failing);
    expect(census.task.recordCandidates).toBe(2);
    expect(census.task.loadedRecords).toBe(1);
    expect(census.task.explicitlyRejected).toBe(1);
    expect(census.task.unaccountedCandidates).toBe(0);
  });

  it('accounts for an identity collision raised after the scan', async () => {
    const vault = createMemoryVault({
      'Proxima/events/one.md': '---\nid: shared\nname: One\nstartDate: 2026-09-09T10:00:00.000Z\n---\n',
      'Proxima/events/two.md': '---\nid: shared\nname: Two\nstartDate: 2026-09-09T10:00:00.000Z\n---\n',
    });
    const { census } = await loadVaultState(vault);
    expect(census.event.recordCandidates).toBe(2);
    expect(census.event.loadedRecords).toBe(1);
    expect(census.event.explicitlyRejected).toBe(1);
    expect(census.event.unaccountedCandidates).toBe(0);
  });

  it('does not count a warning on a loaded record as a rejection', async () => {
    const vault = createMemoryVault({
      'Proxima/tasks/a.md': '---\nid: a\nname: A\nweight: not-a-number\n---\n',
    });
    const { census, problems } = await loadVaultState(vault);
    expect(problems.length).toBeGreaterThan(0);
    expect(census.task.loadedRecords).toBe(1);
    expect(census.task.explicitlyRejected).toBe(0);
    expect(census.task.unaccountedCandidates).toBe(0);
  });
});

/** A reader whose traversal always fails, answering presence however we choose. */
function unreadableDirectories(presence: DirectoryPresence | null): VaultReader {
  const deny = async (): Promise<never> => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  const reader: VaultReader = {
    list: deny as () => Promise<VaultEntry[]>,
    walk: deny as () => Promise<string[]>,
    read: deny as () => Promise<VaultFile>,
    exists: async () => false,
  };
  if (presence) reader.presence = async () => presence;
  return reader;
}

describe('absent versus unreadable', () => {
  it('calls a present but unreadable directory failed, not absent', async () => {
    const { census, problems } = await loadVaultState(unreadableDirectories('present'));
    expect(census.project.status).toBe('failed');
    expect(problems.some((problem) => problem.code === 'directory-unreadable' && problem.severity === 'error')).toBe(true);
  });

  it('calls a genuinely missing directory absent, and only warns', async () => {
    const { census, problems } = await loadVaultState(unreadableDirectories('missing'));
    expect(census.task.status).toBe('absent');
    expect(problems.every((problem) => problem.code !== 'directory-unreadable' || problem.severity === 'warning')).toBe(true);
  });

  it('fails closed when presence cannot be established', async () => {
    // Both walk and the probe fail: the honest answer is "unknown", and unknown
    // must never be reported as absence.
    expect((await loadVaultState(unreadableDirectories('unknown'))).census.event.status).toBe('failed');
  });

  it('fails closed when the reader offers no presence probe at all', async () => {
    // This is the case that matters most: inferring absence from a second failed
    // directory operation is exactly what turned a hole in the evidence into a
    // warning the first time.
    expect((await loadVaultState(unreadableDirectories(null))).census.event.status).toBe('failed');
  });
});
