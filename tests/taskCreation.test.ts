import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createTask } from '../src/app/taskCreation.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

function coordinator(vault: ReturnType<typeof createMemoryVault>) { return createVaultMutationCoordinator({ reader: vault, writer: vault }); }

describe('13.2D canonical task creation', () => {
  it('creates one canonical preferred task and reloads every supplied field', async () => {
    const vault = createMemoryVault({});
    const result = await createTask({ coordinator: coordinator(vault), input: {
      id: 'new-task', name: 'A New Task', createdAt: '2026-09-08', project: 'project-x', status: 'custom-status',
      weight: 2.5, orderIndex: -1, isFixedDuration: true, fixedDuration: 30, maxDuration: 90,
      isCompleted: false, startDate: '2026-09-09', deadline: '2026-09-12', body: '# Notes\n\nKeep this body.\n',
    } });
    expect(result).toMatchObject({ ok: true, kind: 'create', path: 'Proxima/tasks/new-task.md' });
    const file = await vault.read('Proxima/tasks/new-task.md');
    expect(file.text).toContain('id: new-task\nname: A New Task\ncreatedAt: 2026-09-08\nproject: project-x');
    expect(file.text).toContain('---\n# Notes\n\nKeep this body.\n');
    const loaded = await loadVaultState(vault);
    expect(loaded.state.tasks).toHaveLength(1);
    expect(loaded.state.tasks[0]).toMatchObject({ id: 'new-task', name: 'A New Task', projectId: 'project-x', status: 'custom-status', weight: 2.5, orderIndex: -1, isFixedDuration: true, fixedDuration: 30, maxDuration: 90, isCompleted: false, startDate: '2026-09-09', deadline: '2026-09-12', description: '# Notes\n\nKeep this body.' });
  });

  it('quotes unsafe strings so reader semantics stay exact and emits only supplied optional fields', async () => {
    const vault = createMemoryVault({});
    const result = await createTask({ coordinator: coordinator(vault), input: { id: 'quoted', name: '01', createdAt: '2026-09-08', project: 'null', body: 'body' } });
    expect(result).toMatchObject({ ok: true });
    const file = await vault.read('Proxima/tasks/quoted.md');
    expect(file.text).toContain('name: "01"');
    expect(file.text).toContain('project: "null"');
    expect(file.text).not.toContain('status:');
    const loaded = await loadVaultState(vault);
    expect(loaded.state.tasks[0]).toMatchObject({ name: '01', projectId: 'null', status: 'running', weight: 1, deadline: null });
  });

  it('validates before writer calls and bounds the generated source', async () => {
    const vault = createMemoryVault({});
    let calls = 0;
    const base = coordinator(vault);
    const spy = { execute: async (...args: Parameters<typeof base.execute>) => { calls += 1; return base.execute(...args); }, events: base.events };
    const common = { coordinator: spy };
    expect(await createTask({ ...common, input: { id: '../escape', name: 'x', createdAt: '2026-09-08' } })).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(await createTask({ ...common, input: { id: 'bad/name', name: 'x', createdAt: '2026-09-08' } })).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(await createTask({ ...common, input: { id: 'bad-date', name: 'x', createdAt: 'not-a-date' } })).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(await createTask({ ...common, input: { id: 'bad-number', name: 'x', createdAt: '2026-09-08', weight: 0 } })).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(await createTask({ ...common, maxBytes: 80, input: { id: 'large', name: 'x', createdAt: '2026-09-08', body: 'a'.repeat(100) } })).toMatchObject({ ok: false, reason: 'input-too-large' });
    expect(calls).toBe(0);
  });

  it('uses createIfAbsent exclusively: existing bytes and concurrent winner are preserved', async () => {
    const existing = 'creator bytes';
    const vault = createMemoryVault({ 'Proxima/tasks/existing.md': existing });
    const first = createTask({ coordinator: coordinator(vault), input: { id: 'existing', name: 'one', createdAt: '2026-09-08' } });
    const second = createTask({ coordinator: coordinator(vault), input: { id: 'existing', name: 'two', createdAt: '2026-09-08' } });
    const results = await Promise.all([first, second]);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.map((result) => !result.ok && result.reason)).toContain('already-exists');
    expect((await vault.read('Proxima/tasks/existing.md')).text).toBe(existing);

    const raceVault = createMemoryVault({});
    const [a, b] = await Promise.all([
      createTask({ coordinator: coordinator(raceVault), input: { id: 'race', name: 'A', createdAt: '2026-09-08' } }),
      createTask({ coordinator: coordinator(raceVault), input: { id: 'race', name: 'B', createdAt: '2026-09-08' } }),
    ]);
    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    expect([a, b].filter((result) => !result.ok && result.reason === 'already-exists')).toHaveLength(1);
  });
});
