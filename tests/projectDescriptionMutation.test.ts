import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { updateProjectDescription } from '../src/app/projectDescriptionMutation.js';

function readerFor(vault: ReturnType<typeof createMemoryVault>) { return { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = new TextEncoder().encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('large'); return { ...file, bytes }; } }; }
function project(path: string, revision: string) { return { id: path.includes('folder') ? 'p2' : 'p1', source: { path, revision, kind: 'project' as const, idOrigin: 'frontmatter' as const } }; }
const flat = '---\r\nid: p1\r\nname: Project\r\nstatus: active\r\nprojectType: task\r\ndescription: Old text # keep\r\nlinkedFolders: Notes|Notes\r\nforeign: &x value\r\n---\r\nbody fallback\r\n';

describe('13.2I project description override/body fallback', () => {
  it('sets existing and uses body on flat source while preserving body and foreign bytes', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/p1.md': flat }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); let observed = await reader.read('Proxima/projects/p1.md');
    expect(await updateProjectDescription({ project: project(observed.path, observed.revision), path: observed.path, reader, coordinator, mutation: { kind: 'set', value: 'New text' } })).toMatchObject({ ok: true });
    observed = await reader.read(observed.path); expect((await loadVaultState(reader)).state.projects.find((p) => p.id === 'p1')).toMatchObject({ description: 'New text' });
    expect(await updateProjectDescription({ project: project(observed.path, observed.revision), path: observed.path, reader, coordinator, mutation: { kind: 'use-body' } })).toMatchObject({ ok: true });
    const text = (await reader.read(observed.path)).text; expect(text).toContain('body fallback\r\n'); expect(text).toContain('linkedFolders: Notes|Notes\r\nforeign: &x value\r\n'); expect(text).not.toContain('description:'); expect((await loadVaultState(reader)).state.projects.find((p) => p.id === 'p1')).toMatchObject({ description: 'body fallback' });
  });

  it('inserts missing description for folder/index and missing use-body is a no-op', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/folder/index.md': '---\nid: p2\nname: Folder\nstatus: active\nprojectType: task\n---\nfolder body' }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); let observed = await reader.read('Proxima/projects/folder/index.md');
    expect(await updateProjectDescription({ project: project(observed.path, observed.revision), path: observed.path, reader, coordinator, mutation: { kind: 'set', value: 'Folder description' } })).toMatchObject({ ok: true }); observed = await reader.read(observed.path); expect((await loadVaultState(reader)).state.projects.find((p) => p.id === 'p2')).toMatchObject({ description: 'Folder description' });
    expect(await updateProjectDescription({ project: project(observed.path, observed.revision), path: observed.path, reader, coordinator, mutation: { kind: 'use-body' } })).toMatchObject({ ok: true });
  });

  it('refuses empty, malformed, block and out-of-scope descriptions before writes', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/p1.md': flat }); let reads = 0; const base = readerFor(vault); const reader = { ...base, readBinary: async (path: string, maxBytes: number) => { reads += 1; return base.readBinary(path, maxBytes); } }; const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); const observed = await reader.read('Proxima/projects/p1.md'); const common = { project: project(observed.path, observed.revision), path: observed.path, reader, coordinator };
    expect(await updateProjectDescription({ ...common, mutation: { kind: 'set', value: '' } })).toMatchObject({ ok: false, reason: 'invalid-value' }); expect(await updateProjectDescription({ ...common, mutation: { kind: 'clear' as never } })).toMatchObject({ ok: false, reason: 'field-not-allowed' }); expect(await updateProjectDescription({ ...common, project: project('Proxima/projects/deep/x/index.md', observed.revision), mutation: { kind: 'use-body' } })).toMatchObject({ ok: false, reason: 'invalid-provenance' }); expect(reads).toBe(0);
    vault.set('Proxima/projects/p1.md', '---\nid: p1\ndescription: |\n  block\n---\nbody'); const blockObserved = await reader.read('Proxima/projects/p1.md'); expect(await updateProjectDescription({ ...common, project: project(blockObserved.path, blockObserved.revision), mutation: { kind: 'use-body' } })).toMatchObject({ ok: false, reason: 'target-unsupported' });
  });
});
