import { rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createReadOnlyProjection, type ReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createSourceSession, type SourceMode } from '../src/app/sourceSession.js';
import { ALL_PROJECTS } from '../src/domain/selectors.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { refreshEvidenceFromProjections, renameDeleteEvidenceFromProjections } from '../src/browser/realVaultLive.js';
import { createDiskVault, copyFixtureToDisk, removeDiskFixture } from './test-disk-vault.js';
import { changedPaths, createZeroWriteWitness } from './zero-write-witness.js';
import { fixtureFiles } from './fixtures.js';

async function childWrite(path: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2], "utf8")', path, text], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });
}

async function childAppend(path: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'require("node:fs").appendFileSync(process.argv[1], process.argv[2], "utf8")', path, text], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });
}

describe('Gate 6M disposable peer-writer coexistence', () => {
  it('observes independent edit/create/rename/delete and malformed recovery while remaining read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-gate6m-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      // Zero-write is proved by instrumentation, not by an untouched counter: the
      // reader is proxied so a write attempt throws and is recorded, and the tree is
      // fingerprinted so any change Proxima caused would surface as unattributed.
      const witness = createZeroWriteWitness(createDiskVault(root), root);
      const vault = witness.reader;
      const peerWrites: string[] = [];
      const before = await witness.snapshot();
      const initial = await loadVaultState(vault);
      let projection: ReadOnlyProjection = createReadOnlyProjection({ sourceRevision: 1, lastSuccessfulRefreshRevision: 1, refreshState: 'idle', stale: false, lastRefreshReason: null, lastRefreshProblemCode: null, pendingRefreshCount: 0, load: initial });
      const dispatcher = createActionDispatcher({ state: projection.state, problems: projection.problems, revisions: projection.revisions, mode: 'live', initialSourceRevision: projection.generation });
      let editEvidence: ReturnType<typeof refreshEvidenceFromProjections> | null = null;
      let deltaEvidence: ReturnType<typeof renameDeleteEvidenceFromProjections> | null = null;
      const session = createSourceSession({ initial: { mode: 'fixture', reader: vault, initial }, intervalMs: 60_000, onProjection(next, _mode: SourceMode, result) {
        if (result) {
          editEvidence = refreshEvidenceFromProjections(projection, next, result);
          deltaEvidence = renameDeleteEvidenceFromProjections(projection, next, result.outcome);
        }
        const applied = dispatcher.replaceSource({ state: next.state, problems: next.problems, revisions: next.revisions, sourceRevision: next.generation });
        projection = { ...next, health: { ...next.health, applicationRevision: applied.stateRevision } };
      } });
      const taskPath = join(root, 'Proxima', 'tasks', 'Write fixture vault.md');
      const newProjectPath = join(root, 'Proxima', 'projects', 'External peer project.md');
      const renamedTaskPath = join(root, 'Proxima', 'tasks', 'Write fixture vault-renamed.md');
      await childAppend(taskPath, '\nexternal-peer-edit');
      const edited = await session.refresh('external-signal');
      expect(edited?.outcome).toBe('changed');
      const capturedEdit = editEvidence as unknown as { beforeRevision: string; afterRevision: string };
      expect(capturedEdit.afterRevision).not.toBe(capturedEdit.beforeRevision);
      await childWrite(newProjectPath, '---\nid: external-peer\nname: External peer\nprojectType: task\nstatus: active\n---\nCreated by peer writer.\n');
      const created = await session.refresh('manual');
      expect(created?.changed).toBe(true);
      expect(projection.state.projects.some((project) => project.id === 'external-peer')).toBe(true);
      // A rename touches both ends: the source disappears and the destination
      // appears, so both are peer-caused.
      peerWrites.push('Proxima/tasks/Write fixture vault-renamed.md', 'Proxima/tasks/Write fixture vault.md');
      await rename(taskPath, renamedTaskPath);
      const renamed = await session.refresh('external-signal');
      expect(renamed?.outcome).toBe('renamed');
      expect((deltaEvidence as unknown as { outcome: string }).outcome).toBe('renamed');
      expect(projection.state.tasks.some((task) => task.source.path.endsWith('Write fixture vault-renamed.md'))).toBe(true);
      const validRenamedText = (await vault.read('Proxima/tasks/Write fixture vault-renamed.md')).text;
      await childWrite(renamedTaskPath, '---\nid: task-fixtures\nname: "unfinished\n---\n');
      const malformed = await session.refresh('manual');
      expect(malformed?.ok).toBe(false);
      expect(malformed?.outcome).toBe('malformed');
      expect(projection.health.stale).toBe(true);
      await writeFile(renamedTaskPath, validRenamedText);
      const recovered = await session.refresh('manual');
      expect(recovered?.ok).toBe(true);
      expect(projection.health.stale).toBe(false);
      const selectedProject = projection.state.projects.find((project) => project.id === 'external-peer');
      if (!selectedProject) throw new Error('created project missing');
      dispatcher.dispatch({ type: 'project.select', projectId: selectedProject.id });
      await rm(newProjectPath);
      const deleted = await session.refresh('external-signal');
      expect(deleted?.changed).toBe(true);
      expect(projection.state.projects.some((project) => project.id === 'external-peer')).toBe(false);
      expect(dispatcher.snapshot().selection).toBe(ALL_PROJECTS);
      // The instrument must have been live, and nothing outside the read surface
      // may have been touched.
      witness.assertObserved();
      expect(witness.violations).toEqual([]);
      expect(witness.reads.length).toBeGreaterThan(0);
      // Every on-disk difference must be attributable to a declared peer write.
      const unattributed = changedPaths(before, await witness.snapshot()).filter((path) => !peerWrites.includes(path));
      expect(unattributed).toEqual([]);
      expect(dispatcher.snapshot().sourceRevision).toBe(projection.generation);
    } finally { await removeDiskFixture(root); }
  });

  it('serializes rapid peer changes so the latest accepted generation wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-gate6m-rapid-'));
    try {
      await copyFixtureToDisk(fixtureFiles('vault-basic'), root);
      // Zero-write is proved by instrumentation, not by an untouched counter: the
      // reader is proxied so a write attempt throws and is recorded, and the tree is
      // fingerprinted so any change Proxima caused would surface as unattributed.
      const witness = createZeroWriteWitness(createDiskVault(root), root);
      const vault = witness.reader;
      const peerWrites: string[] = [];
      const before = await witness.snapshot();
      const initial = await loadVaultState(vault);
      const session = createSourceSession({ initial: { mode: 'fixture', reader: vault, initial }, intervalMs: 60_000 });
      const path = join(root, 'Proxima', 'tasks', 'Write fixture vault.md');
      await childAppend(path, '\nrapid-one');
      const first = session.refresh('external-signal');
      await childAppend(path, '\nrapid-two');
      const second = session.refresh('external-signal');
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result?.ok)).toBe(true);
      expect(session.projection().generation).toBeGreaterThanOrEqual(2);
      expect((await vault.read('Proxima/tasks/Write fixture vault.md')).text).toContain('rapid-two');
      session.dispose();
    } finally { await removeDiskFixture(root); }
  });
});
