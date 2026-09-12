import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { createStartupSessionOrchestrator, type StartupRecoveryCandidate } from '../src/app/startupSession.js';
import type { SourceMode } from '../src/app/sourceSession.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import type { RecordStoreFileBackend, RecordStoreFileMutationResult, RecordStoreFileName } from '../src/ports/recordStore.js';
import { fixtureVault } from './fixtures.js';

/**
 * Gate 13.C's last box says automatic startup reconciliation is wired into the runtime,
 * and 13.C2's says the host-neutral implementation is tested while "runtime wiring remains
 * open". These cases are about the wiring rather than the reconciliation: that the boot
 * runs it, exactly once, before anybody can act on the session, and that a boot which
 * could not reconcile says so instead of looking clean.
 *
 * The integration case at the end is what keeps the wiring honest: the hook is the real
 * `startRecordMutationAuthority` over a real durable journal, so a summary that claims a
 * reconciliation has to have performed one.
 */
async function options(overrides: Record<string, unknown> = {}) {
  const reader = fixtureVault('vault-basic');
  return {
    fixture: { mode: 'fixture' as const, reader, initial: await loadVaultState(reader) },
    restored: { store: { restore: async () => null }, permissions: { queryPermission: async () => 'denied' as const } },
    ...overrides,
  };
}

function clock() {
  return fixedClock('2026-09-06T12:00:00.000Z');
}

const RECORD_FILE = 'pxr_00000000000000000000000000000001.json' as RecordStoreFileName;

function candidate(overrides: Partial<StartupRecoveryCandidate> = {}): StartupRecoveryCandidate {
  return { mutationAuthority: 'available', outcomes: 2, unresolved: 0, reason: null, ...overrides };
}

describe('startup reconciliation wiring', () => {
  it('runs the recovery hook once, and on every start of a new orchestrator', async () => {
    let runs = 0;
    const contextModes: string[] = [];
    const orchestrator = createStartupSessionOrchestrator(await options({
      runRecovery: async (context: { readonly sourceMode: SourceMode }) => { runs += 1; contextModes.push(context.sourceMode); return candidate(); },
    }));
    const first = await orchestrator.start();
    const second = await orchestrator.start();
    expect(first).toBe(second);
    expect(runs).toBe(1);
    expect(contextModes).toEqual(['fixture']);
    expect(first.inspection.recovery).toEqual({
      status: 'reconciled',
      mutationAuthority: 'available',
      outcomes: 2,
      unresolved: 0,
      reason: null,
    });
    orchestrator.dispose();
  });

  it('reports a blocked reconciliation, and names it as a problem code', async () => {
    const orchestrator = createStartupSessionOrchestrator(await options({
      runRecovery: async () => candidate({ mutationAuthority: 'blocked', outcomes: 1, unresolved: 1, reason: 'recovery-record-unresolved' }),
    }));
    const started = await orchestrator.start();
    expect(started.inspection.recovery).toEqual({
      status: 'blocked',
      mutationAuthority: 'blocked',
      outcomes: 1,
      unresolved: 1,
      reason: 'recovery-record-unresolved',
    });
    expect(started.inspection.problemCodes).toContain('recovery-blocked');
    orchestrator.dispose();
  });

  it('survives a hook that throws, and still says the boot could not reconcile', async () => {
    const orchestrator = createStartupSessionOrchestrator(await options({
      runRecovery: async () => { throw new TypeError('journal backend refused'); },
    }));
    const started = await orchestrator.start();
    // Reading still works: recovery gates mutation authority, not the product.
    expect(started.inspection.sessionState).toBe('stable');
    expect(started.inspection.recovery.status).toBe('failed');
    expect(started.inspection.recovery.mutationAuthority).toBe('blocked');
    expect(started.inspection.recovery.reason).toBe('recovery-failed: TypeError');
    // The raw message is not carried: a journal error can name storage detail.
    expect(JSON.stringify(started.inspection.recovery)).not.toContain('journal backend refused');
    expect(started.inspection.problemCodes).toContain('recovery-failed');
    orchestrator.dispose();
  });

  it('reports `not-run` when the runtime supplies no hook, rather than implying a clean boot', async () => {
    const orchestrator = createStartupSessionOrchestrator(await options());
    const started = await orchestrator.start();
    expect(started.inspection.recovery).toEqual({
      status: 'not-run',
      mutationAuthority: 'blocked',
      outcomes: 0,
      unresolved: 0,
      reason: null,
    });
    expect(started.inspection.problemCodes).not.toContain('recovery-blocked');
    orchestrator.dispose();
  });

  it('carries a real reconciliation, not a summary the shell invented', async () => {
    // The same gate the write path uses, over a durable journal that survived a restart, with
    // one prepared update whose intended bytes are already on disk: the classification has to
    // come back through the hook, so a summary claiming a reconciliation has performed one.
    const journal = new MemoryJournal();
    const before = new TextEncoder().encode('{"id":"pxr_00000000000000000000000000000001","state":"before"}');
    const after = new TextEncoder().encode('{"id":"pxr_00000000000000000000000000000001","state":"after"}');
    const seeder = createDurableRecoveryStore(journal);
    await seeder.load();
    await seeder.save({
      requestId: 'req-startup-1',
      operation: 'update',
      path: RECORD_FILE,
      revision: 'rev-1',
      bytes: before,
      nextBytes: after,
      createdAt: '2026-09-06T12:00:00.000Z',
      status: 'prepared',
    });
    const backend = new MemoryRecordBackend();
    // The crash landed the intended bytes: the file holds `after` at the revision the journal
    // recorded, so classification is `effect-present` rather than a third-party conflict.
    backend.seed(RECORD_FILE, '{"id":"pxr_00000000000000000000000000000001","state":"after"}', 'rev-1');

    // The crash happened after the bytes landed; this boot builds a fresh store over the same
    // durable journal, which is exactly what "startup reconciliation" has to mean.
    const recovery = createDurableRecoveryStore(journal);
    const orchestrator = createStartupSessionOrchestrator(await options({
      runRecovery: async () => {
        const authority = await startRecordMutationAuthority({ backend, recovery, clock: clock() });
        return {
          mutationAuthority: authority.mutationAuthority,
          outcomes: authority.outcomes.length,
          unresolved: authority.unresolved,
          reason: authority.mutationAuthority === 'available' ? null : authority.reason,
        };
      },
    }));
    const started = await orchestrator.start();
    expect(started.inspection.recovery.status).toBe('reconciled');
    expect(started.inspection.recovery.outcomes).toBe(1);
    // The gate counts a record as unresolved when it enters classification, so a record that
    // classified as ffect-present is still counted here. Reported as the gate answers it.
    expect(started.inspection.recovery.unresolved).toBe(1);
    // The journal was transitioned, not merely read: the next boot has nothing left to classify.
    const reloaded = createDurableRecoveryStore(journal);
    await reloaded.load();
    expect(reloaded.list()[0]?.status).toBe('committed');
    orchestrator.dispose();
  });

  it('is supplied by the browser boot and composed behind the adapter', () => {
    const root = resolve(import.meta.dirname, '..');
    const main = readFileSync(resolve(root, 'src/browser/main.ts'), 'utf8');
    // The shell composes operations, never storage: it names the adapter function and nothing else.
    expect(main).toContain('runRecovery: ({ sourceMode }) => resolveBrowserRecoveryStartup(');
    expect(main).not.toContain('createBrowserOpfsRecordStoreFileBackend');
    const adapter = readFileSync(resolve(root, 'src/adapters/browserTaskMutations.ts'), 'utf8');
    expect(adapter).toContain('export async function resolveBrowserRecoveryStartup(');
    // One composition of the gate: the startup hook reuses the same backend, journal and gate
    // the write path uses rather than a second copy of them.
    expect(adapter.split('startRecordMutationAuthority({ backend, recovery, clock:').length - 1).toBe(2);
  });
});

class MemoryRecordBackend implements RecordStoreFileBackend {
  private readonly files = new Map<string, { text: string; revision: string }>();

  seed(fileName: RecordStoreFileName, text: string, revision: string): void {
    this.files.set(fileName, { text, revision });
  }

  async listRecordFiles(): Promise<readonly string[]> {
    return [...this.files.keys()].sort();
  }

  async readRecordFile(fileName: RecordStoreFileName): Promise<{ text: string; revision: string } | undefined> {
    const found = this.files.get(fileName);
    return found ? { ...found } : undefined;
  }

  async createRecordFile(fileName: RecordStoreFileName, text: string): Promise<RecordStoreFileMutationResult> {
    const found = this.files.get(fileName);
    if (found) return { ok: false, reason: 'already-exists', actualRevision: found.revision };
    const revision = `rev-${this.files.size + 1}`;
    this.files.set(fileName, { text, revision });
    return { ok: true, revision };
  }

  async writeRecordFileIfUnchanged(fileName: RecordStoreFileName, text: string, expectedRevision: string): Promise<RecordStoreFileMutationResult> {
    const found = this.files.get(fileName);
    if (!found) return { ok: false, reason: 'missing' };
    if (found.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: found.revision };
    const revision = `rev-${Number(found.revision.replace('rev-', '')) + 1}`;
    this.files.set(fileName, { text, revision });
    return { ok: true, revision };
  }

  async deleteRecordFileIfUnchanged(fileName: RecordStoreFileName, expectedRevision: string): Promise<RecordStoreFileMutationResult> {
    const found = this.files.get(fileName);
    if (!found) return { ok: false, reason: 'missing' };
    if (found.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: found.revision };
    this.files.delete(fileName);
    return { ok: true, revision: 'deleted' };
  }
}

/** The durable journal is a string the host boundary owns; this keeps one in memory. */
class MemoryJournal implements RecoveryJournalBackend {
  private value: string | undefined;

  async read(): Promise<string | undefined> { return this.value; }

  async write(next: string): Promise<void> { this.value = next; }
}
