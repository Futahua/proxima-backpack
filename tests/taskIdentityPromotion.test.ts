import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { promoteTaskIdentity } from '../src/app/taskIdentityPromotion.js';
import { renameTaskSource } from '../src/app/taskSourceLifecycle.js';

const source = '---\nname: Legacy task\nstatus: running\nforeign: &x value\nalias: *x\ndescription: |\n  preserve\n---\nbody\n';
function task(revision: string) { return { id: 'Legacy task', source: { path: 'Proxima/tasks/Legacy task.md', revision, kind: 'task' as const, idOrigin: 'filename' as const } }; }

describe('13.2F legacy task identity promotion', () => {
  it('inserts the filename-derived id only, preserves source bytes and enables later rename', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/Legacy task.md': source });
    const reader = { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = new TextEncoder().encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('too large'); return { ...file, bytes }; } };
    const recovery = createMemoryRecoveryStore({ now: () => 0 }); const coordinator = createVaultMutationCoordinator({ reader, writer: vault, recovery });
    const observed = await reader.read('Proxima/tasks/Legacy task.md');
    const result = await promoteTaskIdentity({ task: task(observed.revision), reader, coordinator });
    expect(result).toMatchObject({ ok: true, kind: 'update' });
    const promoted = (await reader.read('Proxima/tasks/Legacy task.md')).text;
    expect(promoted).toContain('name: Legacy task\nstatus: running');
    expect(promoted).toContain('description: |\n  preserve\nid: Legacy task\n---');
    expect(promoted).toContain('foreign: &x value\nalias: *x\ndescription: |\n  preserve\n');
    expect(recovery.list()[0]?.status).toBe('committed');
    const loaded = await loadVaultState(reader); const promotedTask = loaded.state.tasks[0];
    expect(promotedTask).toMatchObject({ id: 'Legacy task', source: { path: 'Proxima/tasks/Legacy task.md', idOrigin: 'frontmatter' } });
    const renamed = await renameTaskSource({ task: promotedTask!, newFileStem: 'renamed', coordinator });
    expect(renamed).toMatchObject({ ok: true });
    expect((await vault.read('Proxima/tasks/renamed.md')).text).toBe(promoted);
  });

  it('refuses fabricated/mismatched/duplicate or malformed promotion before writing', async () => {
    const vault = createMemoryVault({
      'Proxima/tasks/Legacy task.md': source,
      'Proxima/tasks/Bad.md': 'body',
      'Proxima/tasks/Duplicate.md': '---\nid: old\nid: duplicate\n---\nbody',
    });
    let reads = 0; const reader = { ...vault, readBinary: async (path: string, maxBytes: number) => { reads += 1; const file = await vault.read(path); return { ...file, bytes: new TextEncoder().encode(file.text) }; } };
    const base = createVaultMutationCoordinator({ reader, writer: vault }); let calls = 0;
    const coordinator = { execute: async (...args: Parameters<typeof base.execute>) => { calls += 1; return base.execute(...args); }, events: base.events };
    const revision = (await reader.read('Proxima/tasks/Legacy task.md')).revision;
    expect(await promoteTaskIdentity({ task: { ...task(revision), id: 'wrong' }, reader, coordinator })).toMatchObject({ ok: false, reason: 'identity-mismatch' });
    expect(await promoteTaskIdentity({ task: { ...task(revision), source: { ...task(revision).source, path: 'Notes/creator.md' } }, reader, coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await promoteTaskIdentity({ task: { ...task(revision), source: { ...task(revision).source, idOrigin: 'folder' } as never }, reader, coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    const badRevision = (await reader.read('Proxima/tasks/Bad.md')).revision;
    expect(await promoteTaskIdentity({ task: { id: 'Bad', source: { path: 'Proxima/tasks/Bad.md', revision: badRevision, kind: 'task', idOrigin: 'filename' } }, reader, coordinator })).toMatchObject({ ok: false, reason: 'no-frontmatter' });
    const duplicateRevision = (await reader.read('Proxima/tasks/Duplicate.md')).revision;
    expect(await promoteTaskIdentity({ task: { id: 'Duplicate', source: { path: 'Proxima/tasks/Duplicate.md', revision: duplicateRevision, kind: 'task', idOrigin: 'filename' } }, reader, coordinator })).toMatchObject({ ok: false, reason: 'target-ambiguous' });
    expect(calls).toBe(0); expect(reads).toBe(2);
    const baseTask = task(revision);
    expect(await promoteTaskIdentity({ task: { ...baseTask, id: 'x'.repeat(201) }, reader, coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await promoteTaskIdentity({ task: { ...baseTask, source: { ...baseTask.source, path: `Proxima/tasks/${'x'.repeat(260)}.md` } }, reader, coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await promoteTaskIdentity({ task: { ...baseTask, source: { ...baseTask.source, revision: '' } }, reader, coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await promoteTaskIdentity({ task: { ...baseTask, source: { ...baseTask.source, revision: 'r'.repeat(401) } }, reader, coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(reads).toBe(2);
  });

  it('returns an explicit no-op for already explicit identity and refuses stale peer edits', async () => {
    const explicit = createMemoryVault({ 'Proxima/tasks/explicit.md': '---\nid: explicit\n---\nbody' }); let reads = 0;
    const explicitReader = { ...explicit, readBinary: async (path: string, maxBytes: number) => { reads += 1; const file = await explicit.read(path); return { ...file, bytes: new TextEncoder().encode(file.text) }; } };
    const coordinator = createVaultMutationCoordinator({ reader: explicitReader, writer: explicit }); const revision = (await explicitReader.read('Proxima/tasks/explicit.md')).revision;
    expect(await promoteTaskIdentity({ task: { id: 'explicit', source: { path: 'Proxima/tasks/explicit.md', revision, kind: 'task', idOrigin: 'frontmatter' } }, reader: explicitReader, coordinator })).toMatchObject({ ok: true, noOp: true });
    expect(reads).toBe(0);

    const legacy = createMemoryVault({ 'Proxima/tasks/legacy.md': '---\nname: legacy\n---\nbody' });
    const reader = { ...legacy, readBinary: async (path: string, maxBytes: number) => { const file = await legacy.read(path); return { ...file, bytes: new TextEncoder().encode(file.text) }; } };
    const writer = createVaultMutationCoordinator({ reader, writer: legacy, recovery: createMemoryRecoveryStore({ now: () => 0 }) });
    const old = await reader.read('Proxima/tasks/legacy.md'); legacy.set('Proxima/tasks/legacy.md', '---\nname: peer\n---\nbody');
    expect(await promoteTaskIdentity({ task: { id: 'legacy', source: { path: 'Proxima/tasks/legacy.md', revision: old.revision, kind: 'task', idOrigin: 'filename' } }, reader, coordinator: writer })).toMatchObject({ ok: false, reason: 'stale' });
    expect((await legacy.read('Proxima/tasks/legacy.md')).text).toContain('name: peer');
  });
});
