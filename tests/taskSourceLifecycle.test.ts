import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { deleteTaskSource, renameTaskSource } from '../src/app/taskSourceLifecycle.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

const task = (revision: string, idOrigin: 'frontmatter' | 'filename' = 'frontmatter') => ({ id: 'task-1', source: { path: 'Proxima/tasks/task-1.md', revision, kind: 'task' as const, idOrigin } });
const source = '---\nid: task-1\nname: Keep me\nstatus: running\nproject: p\n---\n# body\n';

describe('13.2E semantic task rename/delete', () => {
  it('renames explicit-ID tasks in place, preserving bytes, identity and provenance', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/task-1.md': source, 'Proxima/tasks/unrelated.md': 'untouched' });
    const coordinator = createVaultMutationCoordinator({ reader: vault, writer: vault, recovery: createMemoryRecoveryStore({ now: () => 0 }) });
    const observed = await vault.read('Proxima/tasks/task-1.md');
    const result = await renameTaskSource({ task: task(observed.revision), newFileStem: 'renamed', coordinator });
    expect(result).toMatchObject({ ok: true, kind: 'move', path: 'Proxima/tasks/task-1.md' });
    expect(await vault.exists('Proxima/tasks/task-1.md')).toBe(false);
    expect((await vault.read('Proxima/tasks/renamed.md')).text).toBe(source);
    expect((await vault.read('Proxima/tasks/unrelated.md')).text).toBe('untouched');
    const loaded = await loadVaultState(vault);
    expect(loaded.state.tasks).toHaveLength(2);
    expect(loaded.state.tasks.find((item) => item.id === 'task-1')?.source.path).toBe('Proxima/tasks/renamed.md');
  });

  it('refuses legacy filename-derived rename and unsafe provenance/name before coordinator calls', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/task-1.md': source });
    const base = createVaultMutationCoordinator({ reader: vault, writer: vault }); let calls = 0;
    const coordinator = { execute: async (...args: Parameters<typeof base.execute>) => { calls += 1; return base.execute(...args); }, events: base.events };
    const revision = (await vault.read('Proxima/tasks/task-1.md')).revision;
    expect(await renameTaskSource({ task: task(revision, 'filename'), newFileStem: 'renamed', coordinator })).toMatchObject({ ok: false, reason: 'rename-requires-explicit-id' });
    expect(await renameTaskSource({ task: task(revision), newFileStem: '../escape', coordinator })).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(await renameTaskSource({ task: { ...task(revision), source: { ...task(revision).source, kind: 'project' } as never }, newFileStem: 'renamed', coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await renameTaskSource({ task: { ...task(revision), source: { ...task(revision).source, path: 'Notes/creator.md' } }, newFileStem: 'renamed', coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await renameTaskSource({ task: { ...task(revision), source: { ...task(revision).source, path: 'Proxima/tasks/sub/task.md' } }, newFileStem: 'renamed', coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await renameTaskSource({ task: { ...task(revision), source: { ...task(revision).source, idOrigin: 'folder' } as never }, newFileStem: 'renamed', coordinator })).toMatchObject({ ok: false, reason: 'invalid-provenance' });
    expect(await renameTaskSource({ task: task(revision), newFileStem: 'CON', coordinator })).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(await renameTaskSource({ task: task(revision), newFileStem: 'CON.txt', coordinator })).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(await renameTaskSource({ task: task(revision), newFileStem: 'NUL.backup', coordinator })).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(await renameTaskSource({ task: task(revision), newFileStem: 'COM1.old', coordinator })).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(await renameTaskSource({ task: task(revision), newFileStem: 'LPT9.foo', coordinator })).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(calls).toBe(0);
  });

  it('accepts an ordinary dotted portable filename stem', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/task-1.md': source });
    const coordinator = createVaultMutationCoordinator({ reader: vault, writer: vault });
    const revision = (await vault.read('Proxima/tasks/task-1.md')).revision;
    expect(await renameTaskSource({ task: task(revision), newFileStem: 'meeting.notes', coordinator })).toMatchObject({ ok: true });
    expect(await vault.exists('Proxima/tasks/meeting.notes.md')).toBe(true);
  });

  it('refuses destination collisions and stale source edits without overwriting either side', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/task-1.md': source, 'Proxima/tasks/existing.md': 'creator destination' });
    const recovery = createMemoryRecoveryStore({ now: () => 0 });
    const coordinator = createVaultMutationCoordinator({ reader: vault, writer: vault, recovery });
    const observed = await vault.read('Proxima/tasks/task-1.md');
    expect(await renameTaskSource({ task: task(observed.revision), newFileStem: 'existing', coordinator })).toMatchObject({ ok: false, reason: 'destination-exists' });
    expect((await vault.read('Proxima/tasks/existing.md')).text).toBe('creator destination');
    vault.set('Proxima/tasks/task-1.md', 'peer edit');
    expect(await renameTaskSource({ task: task(observed.revision), newFileStem: 'renamed', coordinator })).toMatchObject({ ok: false, reason: 'stale' });
    expect(await vault.exists('Proxima/tasks/renamed.md')).toBe(false);
    expect((await vault.read('Proxima/tasks/task-1.md')).text).toBe('peer edit');
    expect(recovery.list().every((record) => record.status === 'recovered')).toBe(true);
  });

  it('deletes only the selected task and races safely across independent coordinators', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/task-1.md': source, 'Proxima/tasks/other.md': 'other' });
    const observed = await vault.read('Proxima/tasks/task-1.md');
    const a = createVaultMutationCoordinator({ reader: vault, writer: vault, recovery: createMemoryRecoveryStore({ now: () => 0 }) });
    const b = createVaultMutationCoordinator({ reader: vault, writer: vault, recovery: createMemoryRecoveryStore({ now: () => 0 }) });
    const [first, second] = await Promise.all([deleteTaskSource({ task: task(observed.revision), coordinator: a }), deleteTaskSource({ task: task(observed.revision), coordinator: b })]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok && result.reason === 'missing' || !result.ok && result.reason === 'stale')).toHaveLength(1);
    expect(await vault.exists('Proxima/tasks/task-1.md')).toBe(false);
    expect(await vault.exists('Proxima/tasks/other.md')).toBe(true);
    expect((await loadVaultState(vault)).state.tasks.map((item) => item.id)).toEqual(['other']);
  });

  it('races independent renames without recreating the old source and isolates recovery attribution', async () => {
    const vault = createMemoryVault({ 'Proxima/tasks/task-1.md': source });
    const observed = await vault.read('Proxima/tasks/task-1.md');
    const recoveryA = createMemoryRecoveryStore({ now: () => 0 }); const recoveryB = createMemoryRecoveryStore({ now: () => 0 });
    const coordinatorA = createVaultMutationCoordinator({ reader: vault, writer: vault, recovery: recoveryA });
    const coordinatorB = createVaultMutationCoordinator({ reader: vault, writer: vault, recovery: recoveryB });
    const [a, b] = await Promise.all([
      renameTaskSource({ task: task(observed.revision), newFileStem: 'one', coordinator: coordinatorA }),
      renameTaskSource({ task: task(observed.revision), newFileStem: 'two', coordinator: coordinatorB }),
    ]);
    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    expect([a, b].filter((result) => !result.ok && (result.reason === 'missing' || result.reason === 'stale'))).toHaveLength(1);
    expect(await vault.exists('Proxima/tasks/task-1.md')).toBe(false);
    const destinations = ['Proxima/tasks/one.md', 'Proxima/tasks/two.md'];
    const existence = await Promise.all(destinations.map((path) => vault.exists(path)));
    const winners = destinations.filter((_path, index) => existence[index]);
    expect((await Promise.all(winners.map(async (path) => (await vault.read(path)).text)))).toEqual([source]);
    expect([...recoveryA.list(), ...recoveryB.list()].filter((record) => record.status === 'committed')).toHaveLength(1);
    expect([...recoveryA.list(), ...recoveryB.list()].every((record) => record.status === 'committed' || record.status === 'recovered')).toBe(true);
  });
});
