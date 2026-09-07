import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { promoteProjectIdentity } from '../src/app/projectIdentityPromotion.js';

function readerFor(vault: ReturnType<typeof createMemoryVault>) { return { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = new TextEncoder().encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('large'); return { ...file, bytes }; } }; }
function project(id: string, path: string, revision: string, idOrigin: 'filename' | 'folder' | 'frontmatter') { return { id, source: { path, revision, kind: 'project' as const, idOrigin } }; }
const body = '---\r\nname: Legacy\r\nstatus: active\r\nprojectType: task\r\ndescription: Keep\r\nlinkedFolders: Notes|Notes\r\nforeign: &x value\r\n---\r\nbody\r\n';

describe('13.2J legacy project identity promotion', () => {
  it('promotes flat filename and folder/index identities without moving or rewriting other bytes', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/flat.md': body, 'Proxima/projects/folder/index.md': body }); const reader = readerFor(vault); const recovery = createMemoryRecoveryStore({ now: () => 0 }); const coordinator = createVaultMutationCoordinator({ reader, writer: vault, recovery });
    let observed = await reader.read('Proxima/projects/flat.md'); expect(await promoteProjectIdentity({ project: project('flat', observed.path, observed.revision, 'filename'), reader, coordinator })).toMatchObject({ ok: true });
    observed = await reader.read('Proxima/projects/folder/index.md'); expect(await promoteProjectIdentity({ project: project('folder', observed.path, observed.revision, 'folder'), reader, coordinator })).toMatchObject({ ok: true });
    expect((await reader.read('Proxima/projects/flat.md')).text).toContain('id: flat\r\n---\r\nbody\r\n'); expect((await reader.read('Proxima/projects/folder/index.md')).text).toContain('id: folder\r\n---\r\nbody\r\n');
    const loaded = await loadVaultState(reader); expect(loaded.state.projects.find((p) => p.id === 'flat')).toMatchObject({ source: { idOrigin: 'frontmatter', path: 'Proxima/projects/flat.md' } }); expect(loaded.state.projects.find((p) => p.id === 'folder')).toMatchObject({ source: { idOrigin: 'frontmatter', path: 'Proxima/projects/folder/index.md' } }); expect(recovery.list().every((e) => e.status === 'committed')).toBe(true);
  });

  it('returns explicit no-op for frontmatter identity and refuses mismatched/fabricated provenance before reads', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/flat.md': body }); let reads = 0; const base = readerFor(vault); const reader = { ...base, readBinary: async (path: string, maxBytes: number) => { reads += 1; return base.readBinary(path, maxBytes); } }; const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); const rev = (await reader.read('Proxima/projects/flat.md')).revision;
    expect(await promoteProjectIdentity({ project: project('flat', 'Proxima/projects/flat.md', rev, 'frontmatter'), reader, coordinator })).toMatchObject({ ok: true, noOp: true }); expect(reads).toBe(0);
    expect(await promoteProjectIdentity({ project: project('wrong', 'Proxima/projects/flat.md', rev, 'filename'), reader, coordinator })).toMatchObject({ ok: false, reason: 'identity-mismatch' }); expect(await promoteProjectIdentity({ project: project('x', 'Notes/x.md', rev, 'filename'), reader, coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' }); expect(reads).toBe(0);
  });

  it('refuses malformed or duplicate id targets and stale peers', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/bad.md': 'body', 'Proxima/projects/dup.md': '---\nid: one\nid: two\n---\nbody', 'Proxima/projects/stale.md': body }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault });
    let rev = (await reader.read('Proxima/projects/bad.md')).revision; expect(await promoteProjectIdentity({ project: project('bad', 'Proxima/projects/bad.md', rev, 'filename'), reader, coordinator })).toMatchObject({ ok: false, reason: 'no-frontmatter' }); rev = (await reader.read('Proxima/projects/dup.md')).revision; expect(await promoteProjectIdentity({ project: project('dup', 'Proxima/projects/dup.md', rev, 'filename'), reader, coordinator })).toMatchObject({ ok: false, reason: 'target-ambiguous' });
    const old = await reader.read('Proxima/projects/stale.md'); vault.set(old.path, '---\nname: peer\n---\npeer'); expect(await promoteProjectIdentity({ project: project('stale', old.path, old.revision, 'filename'), reader, coordinator })).toMatchObject({ ok: false, reason: 'stale' }); expect((await vault.read(old.path)).text).toContain('name: peer');
  });
});
