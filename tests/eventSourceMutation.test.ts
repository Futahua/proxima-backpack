import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { updateEventScalar } from '../src/app/eventSourceMutation.js';

const source = '\uFEFF---\r\nid: e1\r\nname: Event\r\nproject: old\r\nstartDate: 2026-09-01\r\ndeadline: 2026-09-02\r\nisCompleted: false\r\nforeign: &x value\r\n---\r\nbody\r\n';
function readerFor(vault: ReturnType<typeof createMemoryVault>) { return { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = new TextEncoder().encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('large'); return { ...file, bytes }; } }; }
function event(revision: string, path = 'Proxima/events/e1.md') { return { id: 'e1', source: { path, revision, kind: 'event' as const, idOrigin: 'frontmatter' as const } }; }

describe('13.2K existing event scalar mutation', () => {
  it('updates all supported fields and reloads only intended event values', async () => {
    const vault = createMemoryVault({ 'Proxima/events/e1.md': source }); const reader = readerFor(vault); const recovery = createMemoryRecoveryStore({ now: () => 0 }); const coordinator = createVaultMutationCoordinator({ reader, writer: vault, recovery });
    const values = [['name', 'Renamed'], ['project', 'next'], ['startDate', '2026-10-01'], ['deadline', '2026-10-03'], ['isCompleted', true]] as const;
    for (const [field, value] of values) { const observed = await reader.read('Proxima/events/e1.md'); expect(await updateEventScalar({ event: event(observed.revision), path: observed.path, reader, coordinator, mutation: { field, value } })).toMatchObject({ ok: true }); }
    const loaded = (await loadVaultState(reader)).state.events.find((e) => e.id === 'e1'); expect(loaded).toMatchObject({ name: 'Renamed', projectId: 'next', startDate: '2026-10-01', deadline: '2026-10-03', isCompleted: true, source: { path: 'Proxima/events/e1.md' } }); expect((await reader.read('Proxima/events/e1.md')).text).toContain('foreign: &x value\r\n'); expect(recovery.list().every((e) => e.status === 'committed')).toBe(true);
  });

  it('refuses aliases, invalid values and non-event provenance before reads', async () => {
    const vault = createMemoryVault({ 'Proxima/events/e1.md': source, 'Proxima/events/amb.md': '---\nid: amb\nproject: a\nprojectId: b\n---\nbody' }); let reads = 0; const base = readerFor(vault); const reader = { ...base, readBinary: async (path: string, maxBytes: number) => { reads += 1; return base.readBinary(path, maxBytes); } }; const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); const rev = (await reader.read('Proxima/events/e1.md')).revision; const common = { event: event(rev), path: 'Proxima/events/e1.md', reader, coordinator };
    expect(await updateEventScalar({ ...common, mutation: { field: 'unknown' as never, value: 'x' } })).toMatchObject({ ok: false, reason: 'field-not-allowed' }); expect(await updateEventScalar({ ...common, mutation: { field: 'name', value: '' } })).toMatchObject({ ok: false, reason: 'invalid-value' }); expect(await updateEventScalar({ ...common, mutation: { field: 'startDate', value: 'not-date' } })).toMatchObject({ ok: false, reason: 'invalid-value' }); expect(await updateEventScalar({ ...common, event: event(rev, 'Proxima/tasks/e1.md'), mutation: { field: 'name', value: 'x' } })).toMatchObject({ ok: false, reason: 'invalid-provenance' }); expect(reads).toBe(0);
    const ambRev = (await reader.read('Proxima/events/amb.md')).revision; expect(await updateEventScalar({ event: event(ambRev, 'Proxima/events/amb.md'), path: 'Proxima/events/amb.md', reader, coordinator, mutation: { field: 'project', value: 'x' } })).toMatchObject({ ok: false, reason: 'target-ambiguous' });
  });

  it('stale peer edit refuses without overwriting peer bytes', async () => { const vault = createMemoryVault({ 'Proxima/events/e1.md': source }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); const old = await reader.read('Proxima/events/e1.md'); vault.set(old.path, '---\nid: e1\nname: peer\nproject: old\nstartDate: 2026-09-01\n---\npeer'); expect(await updateEventScalar({ event: event(old.revision), path: old.path, reader, coordinator, mutation: { field: 'name', value: 'mine' } })).toMatchObject({ ok: false, reason: 'stale' }); expect((await vault.read(old.path)).text).toContain('name: peer'); });
});
