import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator, type VaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { updateProjectScalar, type ProjectScalarMutation } from '../src/app/projectSourceMutation.js';

const flatSource = '---\nid: project-1\nname: Old project\nstatus: active\nprojectType: task\ntabBgColor: "#111111"\ntabTextColor: white\nlinkedFolders: Notes|Notes\nforeign: &x value\ndescription: |\n  keep this\n---\nbody\n';
function readerFor(vault: ReturnType<typeof createMemoryVault>) { return { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = new TextEncoder().encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('too large'); return { ...file, bytes }; } }; }
function project(path: string, revision: string, idOrigin: 'frontmatter' | 'filename' | 'folder' = 'frontmatter') { return { id: path.includes('folder') ? 'folder' : 'project-1', source: { path, revision, kind: 'project' as const, idOrigin } }; }

describe('13.2G existing project scalar mutation', () => {
  it('updates flat project scalars while preserving body, aliases and unsupported YAML', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/project-1.md': flatSource }); const reader = readerFor(vault);
    const recovery = createMemoryRecoveryStore({ now: () => 0 }); const coordinator = createVaultMutationCoordinator({ reader, writer: vault, recovery });
    const fields = [
      ['name', 'New project'], ['status', 'archived'], ['projectType', 'schedule'], ['tabBgColor', '#abcdef'], ['tabTextColor', 'black'],
    ] as const;
    for (const [field, value] of fields) {
      const observed = await reader.read('Proxima/projects/project-1.md');
      expect(await updateProjectScalar({ project: project('Proxima/projects/project-1.md', observed.revision), path: 'Proxima/projects/project-1.md', reader, coordinator, mutation: { field, value } as ProjectScalarMutation })).toMatchObject({ ok: true });
    }
    const text = (await reader.read('Proxima/projects/project-1.md')).text;
    expect(text).toContain('linkedFolders: Notes|Notes\nforeign: &x value\ndescription: |\n  keep this\n---\nbody\n');
    const loaded = await loadVaultState(reader); const record = loaded.state.projects.find((item) => item.id === 'project-1');
    expect(record).toMatchObject({ name: 'New project', status: 'archived', projectType: 'schedule', tabBgColor: '#abcdef', tabTextColor: 'black', linkedFolders: [{ path: 'Notes' }], description: 'body' });
    expect(recovery.list().every((entry) => entry.status === 'committed')).toBe(true);
  });

  it('updates one-level folder/index projects with the same source-preserving rules', async () => {
    const source = '---\nid: folder-project\nname: Folder project\nstatus: active\nprojectType: task\n---\nfolder body';
    const vault = createMemoryVault({ 'Proxima/projects/folder/index.md': source }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault });
    const observed = await reader.read('Proxima/projects/folder/index.md');
    const result = await updateProjectScalar({ project: project('Proxima/projects/folder/index.md', observed.revision, 'folder'), path: 'Proxima/projects/folder/index.md', reader, coordinator, mutation: { field: 'projectType', value: 'schedule' } });
    expect(result).toMatchObject({ ok: true });
    const loaded = await loadVaultState(reader); expect(loaded.state.projects.find((item) => item.id === 'folder-project')).toMatchObject({ projectType: 'schedule', source: { path: 'Proxima/projects/folder/index.md' } });
  });

  it('refuses unknown/invalid/malformed/out-of-scope sources before reads and stale edits preserve peer bytes', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/project-1.md': flatSource }); let reads = 0; const reader = { ...readerFor(vault), readBinary: async (path: string, maxBytes: number) => { reads += 1; const file = await vault.read(path); return { ...file, bytes: new TextEncoder().encode(file.text) }; } };
    const base = createVaultMutationCoordinator({ reader, writer: vault }); let calls = 0; const coordinator = { execute: async (...args: Parameters<typeof base.execute>) => { calls += 1; return base.execute(...args); }, events: base.events };
    const revision = (await reader.read('Proxima/projects/project-1.md')).revision; const common = { project: project('Proxima/projects/project-1.md', revision), path: 'Proxima/projects/project-1.md', reader, coordinator };
    expect(await updateProjectScalar({ ...common, mutation: { field: 'foreign' as never, value: 'x' as never } })).toMatchObject({ ok: false, reason: 'field-not-allowed' });
    expect(await updateProjectScalar({ ...common, mutation: { field: 'status', value: 'paused' as never } })).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(await updateProjectScalar({ ...common, mutation: { field: 'name', value: '' } })).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(await updateProjectScalar({ ...common, project: project('Notes/note.md', revision), mutation: { field: 'name', value: 'x' } })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await updateProjectScalar({ ...common, project: project('Proxima/projects/deep/folder/index.md', revision), mutation: { field: 'name', value: 'x' } })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(calls).toBe(0); expect(reads).toBe(0);
    const reader2 = readerFor(vault); const writer = createVaultMutationCoordinator({ reader: reader2, writer: vault, recovery: createMemoryRecoveryStore({ now: () => 0 }) }); const old = await reader2.read('Proxima/projects/project-1.md'); vault.set('Proxima/projects/project-1.md', '---\nid: project-1\nname: peer\nstatus: active\nprojectType: task\n---\npeer');
    expect(await updateProjectScalar({ project: project('Proxima/projects/project-1.md', old.revision), path: 'Proxima/projects/project-1.md', reader: reader2, coordinator: writer, mutation: { field: 'name', value: 'mine' } })).toMatchObject({ ok: false, reason: 'stale' });
    expect((await vault.read('Proxima/projects/project-1.md')).text).toContain('name: peer');
  });

  it('derives coordinator CAS from observed source revision', async () => {
    const vault = createMemoryVault({ 'Proxima/projects/project-1.md': flatSource });
    const baseReader = readerFor(vault); const observed = await baseReader.read('Proxima/projects/project-1.md'); let reads = 0;
    const reader = { ...baseReader, readBinary: async (path: string, maxBytes: number) => { reads += 1; return baseReader.readBinary(path, maxBytes); } };
    const requests: unknown[] = []; const coordinator = { execute: async (request: unknown) => { requests.push(request); return { ok: true }; } } as VaultMutationCoordinator;
    const result = await updateProjectScalar({ project: project('Proxima/projects/project-1.md', observed.revision), path: 'Proxima/projects/project-1.md', reader, coordinator, mutation: { field: 'name', value: 'bound' } });
    expect(result).toMatchObject({ ok: true }); expect(reads).toBe(1); expect(requests).toHaveLength(1);
    expect((requests[0] as { expectedRevision: string }).expectedRevision).toBe(observed.revision);
  });
});
