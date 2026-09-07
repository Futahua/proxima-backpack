import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { updateProjectOptional } from '../src/app/projectOptionalMutation.js';

const source = '\uFEFF---\r\nid: p1\r\nname: Project\r\nstatus: active\r\nprojectType: task\r\ntabBgColor: "#111111" # bg\r\nlinkedFolders: Notes|Notes\r\nforeign: &x value\r\n---\r\nbody\r\n';
function readerFor(vault: ReturnType<typeof createMemoryVault>) { return { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = new TextEncoder().encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('large'); return { ...file, bytes }; } }; }
function project(revision: string, path = 'Proxima/projects/p1.md') { return { id: 'p1', source: { path, revision, kind: 'project' as const, idOrigin: 'frontmatter' as const } }; }

describe('13.2H project optional metadata set/clear', () => {
  it('clears and sets flat colors while preserving exact unrelated bytes and reloading', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/p1.md': source }); const reader = readerFor(vault); const recovery = createMemoryRecoveryStore({ now: () => 0 }); const coordinator = createVaultMutationCoordinator({ reader, writer: vault, recovery });
    let observed = await reader.read('Proxima/projects/p1.md');
    expect(await updateProjectOptional({ project: project(observed.revision), path: observed.path, reader, coordinator, mutation: { kind: 'clear', field: 'tabBgColor' } })).toMatchObject({ ok: true });
    observed = await reader.read('Proxima/projects/p1.md');
    expect(await updateProjectOptional({ project: project(observed.revision), path: observed.path, reader, coordinator, mutation: { kind: 'set', field: 'tabBgColor', value: '#abcdef' } })).toMatchObject({ ok: true });
    const text = (await reader.read('Proxima/projects/p1.md')).text; expect(text).toContain('tabBgColor: "#abcdef"\r\n'); expect(text).not.toContain('# bg'); expect(text).toContain('linkedFolders: Notes|Notes\r\nforeign: &x value\r\n'); expect(text).toContain('---\r\nbody\r\n');
    expect((await loadVaultState(reader)).state.projects.find((p) => p.id === 'p1')).toMatchObject({ tabBgColor: '#abcdef', source: { path: 'Proxima/projects/p1.md' } }); expect(recovery.list().every((e) => e.status === 'committed')).toBe(true);
  });

  it('inserts missing folder/index color and clear becomes a no-op when absent', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/folder/index.md': '---\nid: p2\nname: Folder\nstatus: active\nprojectType: task\n---\nbody' }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); let observed = await reader.read('Proxima/projects/folder/index.md');
    expect(await updateProjectOptional({ project: project(observed.revision, observed.path), path: observed.path, reader, coordinator, mutation: { kind: 'set', field: 'tabTextColor', value: 'white' } })).toMatchObject({ ok: true });
    observed = await reader.read('Proxima/projects/folder/index.md'); expect((await updateProjectOptional({ project: project(observed.revision, observed.path), path: observed.path, reader, coordinator, mutation: { kind: 'clear', field: 'tabBgColor' } })).noOp).toBe(true);
    expect((await loadVaultState(reader)).state.projects.find((p) => p.id === 'p2')).toMatchObject({ tabTextColor: 'white', source: { path: observed.path } });
  });

  it('rejects invalid authority and stale edits before unsafe writes', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/p1.md': source }); let reads = 0; const base = readerFor(vault); const reader = { ...base, readBinary: async (path: string, maxBytes: number) => { reads += 1; return base.readBinary(path, maxBytes); } }; const coordinator = createVaultMutationCoordinator({ reader, writer: vault });
    const observed = await reader.read('Proxima/projects/p1.md'); const common = { project: project(observed.revision), path: observed.path, reader, coordinator };
    expect(await updateProjectOptional({ ...common, mutation: { kind: 'set', field: 'name' as never, value: 'x' } })).toMatchObject({ ok: false, reason: 'field-not-allowed' });
    expect(await updateProjectOptional({ ...common, mutation: { kind: 'set', field: 'tabBgColor', value: '' } })).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(await updateProjectOptional({ ...common, project: project(observed.revision, 'Proxima/projects/deep/x/index.md'), mutation: { kind: 'clear', field: 'tabBgColor' } })).toMatchObject({ ok: false, reason: 'invalid-provenance' }); expect(reads).toBe(0);
    const old = await base.read('Proxima/projects/p1.md'); vault.set('Proxima/projects/p1.md', '---\nid: p1\nname: peer\nstatus: active\nprojectType: task\n---\npeer'); expect(await updateProjectOptional({ project: project(old.revision), path: old.path, reader: base, coordinator, mutation: { kind: 'set', field: 'tabTextColor', value: 'mine' } })).toMatchObject({ ok: false, reason: 'stale' }); expect((await vault.read(old.path)).text).toContain('name: peer');
  });
});
